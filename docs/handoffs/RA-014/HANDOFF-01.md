# RA-014 — Handoff 01

## Metadata

- Task: `RA-014`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-20`
- Bazowy commit: `1af194f`
- Końcowy commit: `a8f3729`

## Wynik

Nowy pakiet `@remoteagent/git-lifecycle`: deterministyczne nazewnictwo brancha z
resume, klasyfikacja working tree, bounded diff, scoped staging, commity powiązane
z evidence i kontrolowany rebase. Remote writes i MR pozostają w RA-017.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Resume nie tworzy drugiego brancha | PASS | `CREATED` → `RESUMED`; **licznik branchy = 1**; nazwa deterministyczna; base pinowany, nie re-derywowany |
| 2. Brak stage/commit poza workspace/scope | PASS | absolutna ścieżka, traversal, ścieżka niedeklarowana, magic pathspec (`:/`, `:(glob)`, `:!`); index sprawdzany po każdej odmowie |
| 3. Commit powiązany z evidence albo jawnie `unverified` | PASS | unia dyskryminowana; `VERIFIED` bez receiptów, z werdyktem != `PASSED`, `UNVERIFIED` bez powodu i trzeci kształt — wszystkie nieprzedstawialne |
| 4. Rebase conflict nie jest auto-rozwiązywany | PASS | realna rozbieżna historia; brak parametru strategii; **`REBASE_HEAD` nie istnieje po operacji** |
| 5. Dirty user changes wykryte, nigdy nadpisane | PASS | `DIRTY_FOREIGN` blokuje commit i rebase; bajty użytkownika sprawdzane po odmowie |
| 6. Zakazane komendy destrukcyjne mają testy negatywne | PASS | allowlista subkomend; 14 negatywnych przypadków, w tym 6 bypassów znalezionych sondą |

## Kluczowe decyzje

- **Guard na argv, w jednym choke pointcie `execFile`.** Sprawdzanie publicznych
  metod zostawiałoby każdy prywatny helper jako obejście.
- **Allowlista, nie denylista** — wymuszone dowodem (patrz niżej).
- **Resume przez lookup**, nie bookkeeping: `addWorktree -b` failuje na
  istniejącym branchu, więc „zawołaj ponownie" nigdy nie mogło być ścieżką resume.
- **Własny `maxBuffer`**: `runGit` z `workspace-runner` ma 1 MB i rzuca `ENOBUFS`
  zamiast obciąć, więc duży `git diff` crashował. Tutaj overflow to jawna flaga.

## Findingi znalezione we własnym audycie (naprawione przed handoffem)

1. **Denylista defeatowalna sześcioma sposobami** (HIGH). `git -C /elsewhere push`
   przechodził, bo skaner subkomendy filtrował flagi, ale **zostawiał ich wartości** —
   `/elsewhere` brane za subkomendę, `push` niesprawdzony. Dalej: `-c alias.p=push p`,
   `-c core.hooksPath=... commit` (wykonanie dowolnego kodu), oraz `stash drop`,
   `update-ref -d`, `branch -D` — nieujęte w liście. Naprawa: allowlista.
2. **`stage` fail-OPEN przy braku `declaredPaths`** (HIGH). Warunek
   `declared.size > 0 && !declared.has(path)` pozwalał stage'ować cokolwiek, gdy nic
   nie zadeklarowano; sonda zestage'owała `secret.env`. Naprawa: fail closed.
3. **Kolizja eksportu `gitSha`** z `@remoteagent/contracts`, gdzie istniejąca
   definicja przyjmuje **także 64-hex**. Nie tylko `undefined` pod wspólnym barrelem —
   podmiana reguły walidacji na luźniejszą. Zmienione na `gitCommitSha`.

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/git-lifecycle/test` | 0 | 29/29 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1304/1304, 120 plików** |
| `pnpm run typecheck --force` | 0 | 35/35 |
| `pnpm run build --force` | 0 | 25/25 |
| `pnpm exec eslint packages/git-lifecycle` | 0 | PASS |
| `pnpm exec prettier --check .` | 0 | PASS |
| re-probe 6 bypassów + 15 realnych operacji | — | wszystkie odrzucone / żadna nie zepsuta |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| usunięcie ścieżki resume | 2 FAIL |
| usunięcie kontroli declared surface | 2 FAIL |
| `DIRTY_FOREIGN` nie blokuje commita | 1 FAIL |
| brak `rebase --abort` po konflikcie | 1 FAIL |
| usunięcie listy zakazanych flag | 1 FAIL |
| usunięcie kontroli protected branch | 1 FAIL |
| allowlista subkomend wyłączona | 3 FAIL |
| powrót do fail-open `declaredPaths` | 1 FAIL |

## Znane ograniczenia

- Fixture używa `git init` w worktree (`.git` jako mirror), nie pełnego modelu
  mirror+worktree z RA-010. Kontrakt jest ten sam; pełna integracja mirror/worktree
  należy do RA-018 golden path.
- `CTF-008` (LOW) — repo lint nadal 3 preexistujące błędy; RA-014 nie dodał żadnego.
- Brak trwałego stanu w bazie: branch record i commit receipt są kontraktami
  zwracanymi wołającemu. Persystencja należy do RA-017. Migracja `028` wolna.

## Stan dla audytu

Working tree czysty, `a8f3729`. Audyt powinien niezależnie odtworzyć przebieg,
przeczytać diff od `1af194f`, sprawdzić sześć kryteriów i potwierdzić, że allowlista
nie odcięła żadnej realnie potrzebnej operacji.
