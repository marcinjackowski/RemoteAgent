# RA-014 — Audit 01

## Metadata

- Task: `RA-014`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-014/HANDOFF-01.md`
- Data: `2026-08-20`
- Zakres diffu: `1af194f..a8f3729`
- **Werdykt: `PASS`**

## Podstawa werdyktu

Odczyt diffu, samodzielne uruchomienie bramek, mutation testing i **sondy
adwersarialne**. Sondy znalazły dwa findingi klasy HIGH, których nie znalazły testy
unitu — trzeci task z rzędu, w którym to się zdarza. To najsilniejszy dostępny
argument, że bramka verification-first z ADR-0007 działa.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Werdykt | Jak sprawdzone |
|---|---|---|
| 1 | PASS | `CREATED`/`RESUMED` + **licznik branchy `agent/*` = 1** (samo disposition nie wykluczyłoby duplikatu pod inną nazwą); determinizm nazwy; base pinowany przy resume, nie re-derywowany z tipa |
| 2 | PASS | absolutna ścieżka, `../escape`, `src/../../escape`, ścieżka niedeklarowana, oraz **magic pathspec** (`:/`, `:(glob)**/*.md`, `:!src`); po każdej odmowie index sprawdzany jako pusty; `--literal-pathspecs` w realnym wywołaniu |
| 3 | PASS | unia dyskryminowana bez trzeciego kształtu; cztery nieprzedstawialne warianty dowiedzione testem |
| 4 | PASS | realna rozbieżna historia dająca prawdziwy konflikt; **`REBASE_HEAD` nie istnieje po operacji** (to jedyna obserwowalna forma „aborted, not resolved"); `new_base_sha == previous_base_sha`; `rebase.length === 1` dowodzi braku parametru strategii |
| 5 | PASS | `DIRTY_FOREIGN` blokuje commit i rebase; **bajty użytkownika czytane z dysku po odmowie** |
| 6 | PASS | allowlista; 14 przypadków negatywnych; 15 realnych operacji potwierdzonych jako nadal dozwolone |

## Findingi

### Finding 1 — argv guard defeatowalny sześcioma sposobami (HIGH, **naprawiony**)

Sonda audytora:

```text
!! ALLOWED  -C /tmp push origin HEAD
!! ALLOWED  -c alias.p=push p
!! ALLOWED  -c core.hooksPath=/tmp/evil commit -m x
!! ALLOWED  stash drop
!! ALLOWED  update-ref -d refs/heads/main
!! ALLOWED  branch -D main
```

**Przyczyna dwuczęściowa.** (a) Skaner subkomendy robił
`args.filter(arg => !arg.startsWith("-"))`, co usuwało `-C`, ale **zostawiało jego
wartość** `/tmp` — brana za subkomendę, więc `push` nie był sprawdzany. To klasyczny
błąd „flaga z wartością". (b) Denylista nie zawierała `stash`, `update-ref` ani
`branch -D`.

**Wpływ.** `push` to remote write poza zakresem taska; `core.hooksPath` to wykonanie
dowolnego kodu; `branch -D main` i `update-ref -d` to utrata danych na protected
branchu. Klasyfikuję HIGH: osiągalne przez dowolnego wołającego tej warstwy.

**Naprawa.** Allowlista dziewięciu subkomend, jednej opcji globalnej i twardej listy
zakazanych flag. Opcje wiodące są **przechodzone jawnie**, nie filtrowane — to
zamyka całą klasę (a). `--git-dir` przestał być dozwolony; `#branchExists` adresuje
mirror przez `cwd`, więc guard nie potrzebuje wyjątku.

**Dlaczego allowlista, nie łatanie denylisty.** Denylista musi przewidzieć każdy
destrukcyjny czasownik, jaki Git kiedykolwiek dostanie. Allowlista musi wymienić
dziewięć, których ten moduł faktycznie używa. Re-probe potwierdza: 6/6 bypassów
odrzuconych, 15/15 realnych operacji nadal działa.

### Finding 2 — `stage` fail-OPEN przy pustym `declaredPaths` (HIGH, **naprawiony**)

```text
!! EMPTY declaredPaths staged: [ 'secret.env' ]
```

Warunek `declared.size > 0 && !declared.has(path)` traktował **brak deklaracji jako
zgodę na wszystko**. Sonda zestage'owała `secret.env`. Naprawa: `!declared.has(path)`
bez warunku wstępnego. Odwrócenie fail-open na fail-closed.

### Finding 3 — kolizja eksportu `gitSha` (MEDIUM, **naprawiony**)

`@remoteagent/contracts` eksportuje `gitSha` akceptujący **także 64-hex** (SHA-256).
Pod wspólnym barrelem ESM cicho usunąłby nazwę, ale gorsze jest to, że dwie definicje
**różnią się semantyką**: ta warstwa musi odrzucać 64-hex, bo `verifyCommit` wymaga
dokładnie 40. Kolizja podmieniałaby regułę na luźniejszą. Zmienione na
`gitCommitSha`. To dokładnie scenariusz `CTF-002` — wykryty testem przecięcia
eksportów, który istnieje właśnie po to.

Brak otwartych findingów BLOCKER/HIGH/MEDIUM na moment werdyktu.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1304/1304, 120 plików** |
| `pnpm vitest run packages/git-lifecycle/test` | 0 | 29/29 |
| `pnpm run typecheck --force` | 0 | 35/35 |
| `pnpm run build --force` | 0 | 25/25 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| 8 mutacji | — | każda wykryta |
| sondy adwersarialne | — | **findingi 1 i 2** |

## Bezpieczeństwo i ryzyko utraty danych

- **Brak shella.** Jedno `execFile` z tablicą argumentów; żadna ścieżka nie buduje
  stringa komendy. Nazwa brancha i ścieżki pochodzą od modelu, więc to jest granica.
- **Deterministyczne środowisko procesu**: wymuszony `PATH`, `GIT_CONFIG_NOSYSTEM`,
  `GIT_TERMINAL_PROMPT=0`, jawny author/committer. Brak konfiguracji użytkownika.
- **Utrata danych**: `--force`, `--hard`, `--keep`, `--merge`, `-D`, `-f` odrzucone
  wszędzie; `branch -d/-m/-M` odrzucone osobno; `checkout` bez pathspec odrzucony.
- **Protected branches** sprawdzane w kontrakcie i przy commicie, z prefiksami
  (`release/*`, `production/*`).
- **Komunikaty Git nie podróżują** — tylko stabilny `code`, bo Git osadza host paths.
- Brak push, MR i external writes — zgodnie z `Out of scope`.

## Świadome decyzje, które potwierdzam

1. `branch` na allowliście, ale wyłącznie do listowania i tworzenia; usuwanie i zmiana
   nazwy odrzucone osobno.
2. `checkout -b` jako jedyny wyjątek od wymogu pathspec — tworzy branch, nie dotyka
   istniejących plików.
3. Brak persystencji w bazie; branch record i commit receipt są kontraktami dla
   RA-017. Migracja `028` pozostaje wolna.
4. Fixture używa `git init` zamiast pełnego mirror+worktree z RA-010. Kontrakt
   identyczny; pełna integracja należy do RA-018.

## Werdykt

- Werdykt: `PASS`

Sześć kryteriów spełnione i sprawdzone osobno. Trzy findingi (2× HIGH, 1× MEDIUM)
znalezione w tym audycie i naprawione z testami regresyjnymi przed werdyktem.

Status: `AUDIT_PASSED` → `DONE`. Odblokowuje RA-015.
