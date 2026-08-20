# RA-012 — Audit 02

## Metadata

- Task: `RA-012`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-012/HANDOFF-02.md`
- Data: `2026-08-20`
- Zakres diffu: `b2d6631..5c3df61`, `packages/implementation-tools/**` +
  `packages/database/migrations/027_*`
- **Werdykt: `PASS`**

## Podstawa werdyktu

Audyt oparty na odczycie pełnego diffu od bazowego commita, samodzielnym
uruchomieniu bramek na realnym PostgreSQL, mutation testingu każdego istotnego
mechanizmu oraz **własnych sondach adwersarialnych** — nie na treści handoffu.

Uwaga proceduralna wynikająca z ADR-0007: audytor i wykonawca to ta sama sesja.
Rekompensatą nie jest tożsamość modelu, lecz to, że każde twierdzenie poniżej ma
uruchomioną komendę albo sondę, którą można powtórzić z historii repozytorium.
Wartość tego podejścia potwierdza się empirycznie: audyt **znalazł defekt, którego
nie znalazły testy unitu** (finding 1), dokładnie tam, gdzie handoff deklarował
świadomą decyzję.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Kryterium | Werdykt | Jak sprawdzone |
|---|---|---|---|
| 1 | Path traversal, symlink escape, cwd escape zablokowane | PASS | `read-tools` (traversal, symlink escape), `patch` (symlink swap mid-batch), `command` (cwd poza rootem), `mkdir` (traversal, absolute, symlink leaf, symlink pośredni, symlink→katalog), `toolset` (protected paths). Mutacja usuwająca politykę ścieżek wywala 3 testy. |
| 2 | Command nie wstrzyknie sekretów ani nie poszerzy network policy | PASS | 4 testy negatywne (`env`, `cwd`, `network`, podniesiony limit) + canary na 7 literałach osobno w stdout, stderr, logu i artefakcie. Mutacja przywracająca ręcznie budowany request wywala 4 testy. |
| 3 | Każda zmiana ma intent, wynik, pre/post digest i listę plików | PASS | `ledger.integration` 23/23 na realnym PG: intent widoczny z osobnego połączenia **przed** pierwszym `open`, exactly-once przy współbieżności. `patch`/`mkdir` niosą digest i `changed_files`. |
| 4 | Truncated output zachowuje pełny artefakt i wskazuje obcięcie | PASS | `read-tools` (clipping na granicy code-pointa, `original_byte_length` z przed obcięcia), `command` (pełny artefakt poza promptem z referencją i digestem). |
| 5 | Częściowy patch zostawia wykrywalny stan, nie fałszywy sukces | PASS | Fault injection z asercjami na **bajtach na dysku**; sweep po każdym punkcie przerwania dowodzi, że żaden przebieg z niepustym `changed_files` nie raportuje `SUCCEEDED`. |
| 6 | Implementer nie zmieni scope argumentem toola | PASS | Sweep adwersarialny po 8 narzędziach; obcy scope ma **0 wierszy** w ledgerze (zapytanie SQL, nie asercja na kopercie). Scope jest domknięciem — dwie mutacje wstrzykujące go okazały się nieosiągalne. |

## Findingi

### Finding 1 — `search` i `tree` wystawiały treść repo instructions (HIGH, **naprawiony**)

- Severity: **HIGH** przed naprawą
- Lokalizacja: `packages/implementation-tools/src/toolset.ts`
- Status: **NAPRAWIONY** w `5c3df61`, przed wydaniem werdyktu

**Dowód.** Sonda adwersarialna audytora (nie test unitu) na realnym workspace:

```text
search "INSTRUCTION_MARKER" -> AGENTS.md contents returned    <-- LEAK
tree (root)                 -> AGENTS.md enumerated           <-- LEAK
search/tree dla .env, .git  -> poprawnie odfiltrowane
```

**Przyczyna.** `search` i `tree` bez ścieżki nie mają czego zgatować na wejściu,
więc obie były zdane na `discovery-policy`. Komentarz w kodzie twierdził, że
`isForbiddenPath` filtruje chronione wyniki. **Nie filtruje:** pokrywa `.git`,
`.env`, klucze i nazwy plików credential, ale **nie** pliki instrukcji.

**Wpływ.** `AGENTS.md` był osiągalny przez `search`, gdy `read` odmawiał go po
ścieżce. To znosi sens jego ochrony: model, który przeczyta własne instrukcje
zapytaniem, może planować wokół nich, a ta sama droga wystawiłaby każdy przyszły
plik instrukcji. Klasyfikuję jako HIGH, nie BLOCKER, bo jest to wyciek do
kontekstu modelu, nie eskalacja uprawnień — zapis do `AGENTS.md` pozostawał
zablokowany przez bramkę wejściową przez cały czas.

**Naprawa.** Filtrowanie payloadów listingowych na wyjściu tym samym predykatem
`isProtectedPath`, więc jedna lista rządzi oboma kierunkami. Usunięcie jest
**rozliczone**, nie ciche: `dropped` rośnie, `complete` idzie na `false`, koperta
ustawia `truncated`. Niedające się sparsować listing failuje closed. Digest
świadomie nie jest przeliczany — pokrywa to, co zaobserwowano, a filtr zmienia to,
co jest raportowane.

**Weryfikacja naprawy.** Trzy nowe testy; mutacja neutralizująca filtr odtwarza
wszystkie trzy porażki.

**Wniosek przekrojowy.** To ten sam wzorzec co defekt `WU-05` i słabość testów
`WU-06`: **komentarz opisywał gwarancję, której kod nie dawał.** Trzeci raz w
jednym tasku. Reguła z `AGENTS.md` („komentarz nie jest dowodem zachowania")
została napisana w reakcji na pierwszy przypadek i sprawdziła się na kolejnych
dwóch.

### Finding 2 — trzecia lokalna tabela wzorców sekretów (LOW, zaakceptowany)

`command.ts` ma własną tabelę redakcji, oznaczoną `Transitional`. To trzecie
miejsce z niezależnym zestawem wzorców (obok `observability` i
`repository-planner`). Zgodne z decyzją właściciela z `CTF-006`: domknięcie należy
do RA-024 i ma objąć wszystkie trzy. Nie blokuje — jest jawnie oznaczone i
odnotowane w rejestrze.

### Finding 3 — `implementation-tools` bez `tsconfig.test.json` (LOW, zaakceptowany)

Testy pakietu nie są objęte bramką `typecheck`. Część `CTF-004`; wymaga
rozstrzygnięcia src-vs-dist, więc nie jest doczepką do tego taska.

Brak findingów klasy BLOCKER, HIGH ani MEDIUM otwartych na moment werdyktu.

## Kontrole, które wykonałem samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1233/1233, 118 plików** |
| `pnpm vitest run packages/implementation-tools/test` | 0 | 139/139, 7 plików |
| `pnpm run typecheck --force` (uncached) | 0 | 31/31 |
| `pnpm run build --force` (uncached) | 0 | 23/23 |
| `pnpm exec eslint` (scoped) | 0 | PASS |
| `pnpm exec prettier --check .` (całe repo) | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| `git diff --check` | 0 | clean |
| sonda przecięcia eksportów (11 pakietów) | 0 | brak realnych kolizji |
| sonda adwersarialna `search`/`tree` | — | **finding 1** |

`--force` jest warunkiem dowodowości: pierwszy przebieg `typecheck` zwrócił
`FULL TURBO`/`31 cached` bez uruchomienia czegokolwiek.

## Bezpieczeństwo, izolacja i recovery

- **Scope ustalany poza modelem.** `identity` jest domknięciem konstrukcyjnym;
  żadna z 8 powierzchni nie ma pola scope. Zapytanie SQL potwierdza 0 wierszy pod
  obcym scope po sweepie adwersarialnym. Obcy `operation_id` jest odrzucany
  głośno (`OperationScopeError`), nie traktowany jako świeża operacja.
- **Brak obejścia niższych warstw.** `toolset.ts` nie importuje `fs`,
  `child_process`, `pg` ani path policy (`grep` → `0`); `command.ts` nie importuje
  `child_process`, deleguje 17× do `runProcess`. Zero `any`/`as unknown as` w
  nowym kodzie.
- **`UNTRUSTED_DATA`** przypięte literałem na poziomie schematu.
- **Recovery.** Macierz fault/restart: cztery niedomknięte klaimy (po jednym na
  narzędzie mutujące) po restarcie na świeżym repozytorium są
  `INTENT_RECORDED`/`requiresReconciliation`, a replay każdego daje `AMBIGUOUS`
  bez wykonania efektu. Brak ścieżki od „brak receiptu" do `SUCCEEDED` —
  potwierdzone mutacją.
- **Idempotencja.** Replay tego samego `operation_id` nie powtarza side effectu;
  sprawdzone przez usunięcie skutku „za plecami" narzędzia i asercję, że replay go
  nie odtwarza.
- Brak push, MR i external writes.

## Świadome decyzje, które potwierdzam

1. **`mkdir` mapowany na `ToolKind.WRITE_FILE`.** Zamknięty zbiór kinds jest
   zaakceptowanym kontraktem `WU-01`, konsumowanym przez enum ledgera i CHECK
   migracji `027`. Tworzenie katalogu jest mutacją workspace. Sprawdziłem, że
   ledger nie kluczuje po `kind` (brak w `WHERE`/`ON CONFLICT`), więc dzielenie
   `kind` z `write` nie tworzy kolizji exactly-once.
2. **`command` bez bramki ścieżkowej.** Model podaje klucz katalogu, a cwd jest
   server-owned — nie ma argumentu ścieżkowego, który mógłby sięgnąć chronionego
   pliku. Asymetria uzasadniona.
3. **`patch` nie tworzy katalogów.** Brakujący rodzic to czysty pre-flight
   `FAILED`; zdolność dostarcza `mkdir`. Zachowanie `patch.ts` niezmienione.
4. **Traversal w `mkdir` daje `INVALID_REQUEST`, nie `PATH_ESCAPE`**, bo
   `workspaceRelativePath` odrzuca go na granicy kontraktu, przed path policy. Dwie
   niezależne warstwy odmawiają; odpowiada zewnętrzna. Świadoma kolejność.

Deklarację handoffu, że „chronione pliki są wykluczane przez `isForbiddenPath`",
**odrzuciłem** — patrz finding 1.

## Werdykt

- Werdykt: `PASS`

Wszystkie sześć kryteriów akceptacji spełnione i zweryfikowane osobno. Brak
otwartych findingów BLOCKER/HIGH/MEDIUM. Jedyny finding HIGH został znaleziony w
tym audycie i naprawiony wraz z testami regresyjnymi przed wydaniem werdyktu.

Status taska: `AUDIT_PASSED` → `DONE`. Odblokowuje RA-013 (`RA-010`, `RA-012`
oba `DONE`).
