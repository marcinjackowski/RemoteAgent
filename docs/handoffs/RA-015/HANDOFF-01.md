# RA-015 — Handoff 01

## Metadata

- Task: `RA-015`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-20`
- Bazowy commit: `d073527`
- Końcowy commit: `d5eda64`

## Wynik

Nowy pakiet `@remoteagent/review-loop`: strukturalne findingi, deterministyczny
merge wielu reviewerów, dyspozycje supervisora i bounded fix loop, który eskaluje
zamiast się kręcić.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Reviewer nie modyfikuje kodu ani authority fields | PASS | context nie ma **żadnej funkcji** (asercja mechaniczna), jest frozen, a pakiet **nie zależy** od `implementation-tools`, `git-lifecycle`, `database` ani `workspace-runner` |
| 2. PASS wymaga braku unresolved BLOCKER/HIGH/MEDIUM | PASS | każda severity blokująca sprawdzona osobno; LOW/NIT nie blokują; zero raportów rzuca |
| 3. Finding bez lokalizacji/evidence nie blokuje | PASS | refinement kontraktu + `guardReviewer` **downgrade'uje** blocker, którego cytat nie występuje w diffie |
| 4. Fix loop ma jawny limit i nie trwa bez końca | PASS | wyczerpanie iteracji, wyczerpanie tokenów i runda bez postępu — każde eskaluje |
| 5. Resolved finding wskazuje evidence poprawki | PASS | commit + receipty + `fixed_diff_digest` wymagane; brak któregokolwiek nieprzedstawialny |
| 6. Reviewer nie ufa opisowi implementera | PASS | `diff_digest` liczony z diffu, nie przyjmowany; raport o innym diffie/drzewie odrzucony; `claimed_summary` przypięty do `UNTRUSTED_DATA` |

## Kluczowe decyzje

- **Read-only przez graf zależności, nie przez komentarz.** Manifest wymieniał dwa
  write-capable pakiety, do których odnosił się wyłącznie komentarz. Usunięte —
  teraz nie ma czego zaimportować przez pomyłkę.
- **Evidence musi występować w diffie dosłownie.** Wymóg „niepustego" cytatu
  spełnia wymyślona, wiarygodnie wyglądająca linia. Blocker bez potwierdzenia jest
  **downgrade'owany do LOW**, nie usuwany: obserwacja zostaje czytelna, ale nie
  zatrzymuje pracy, której nie potrafi uzasadnić.
- **Konflikt reviewerów wygrywa wyższa severity.** Obniżanie przy rozbieżności
  pozwoliłoby jednemu łagodnemu reviewerowi uciszyć surowszego. Merge jest
  order-independent, więc równoległe reviewy nie zmieniają wyniku kolejnością.

## Defekt znaleziony własnymi testami AC4

Wczesne wyjście — wyczerpany budżet tokenów albo runda bez postępu — raportowało
`CHANGES_REQUIRED`, co mówi wołającemu, że będzie kolejna runda, gdy pętla już
stanęła. To „cicho kontynuuje" w postaci mylącego werdyktu, nie nieskończonej pętli.
Naprawione: wczesne wyjścia eskalują.

## Findingi z własnego audytu (naprawione przed handoffem)

1. **Resolution był self-certifying** (HIGH). Dowolny 40-hex commit + dowolny digest
   receiptu czyścił BLOCKER; nic nie wiązało tych wartości z findingiem ani z realną
   zmianą. Naprawa: `fixed_diff_digest` i odmowa, gdy równy diffowi w review.
2. **Pusty raport dawał `READY`** (HIGH). Reviewer, który nigdy nie przeczytał diffu,
   przepuszczał zmianę. Pusta lista findingów jest dwuznaczna. Naprawa:
   `lines_examined`, odmowa gdy wszyscy zbadali 0 linii, cap na zawyżanie.

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `pnpm vitest run packages/review-loop/test` | 0 | 34/34 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1338/1338, 121 plików** |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| repo lint error count | — | 3 (baseline `CTF-008`, bez zmian) |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| `ESCALATED` zwinięte w `CHANGES_REQUIRED` | 3 FAIL |
| refinement evidence dla blockera usunięty | 3 FAIL |
| merge trzyma **niższą** severity | 1 FAIL |
| guard przestaje sprawdzać `diff_digest` | 1 FAIL |
| sfabrykowane evidence nie jest downgrade'owane | 1 FAIL |
| kontrola budżetu tokenów usunięta | 2 FAIL |
| guard `lines_examined` usunięty | 1 FAIL |
| self-certifying resolution znów akceptowany | 1 FAIL |
| cap na zawyżanie examination usunięty | 1 FAIL |

## Znane ograniczenia

- Reviewer jest interfejsem; podłączenie realnego modelu należy do RA-018 golden
  path. Testy używają stubów, ale **kontrakt i guard są prawdziwe** — to one
  stanowią zakres tego taska.
- Brak persystencji: raporty i readiness są kontraktami dla RA-017. Migracja `028`
  wolna.
- `CTF-009` — RA-015 czyta diff, nie repozytorium, więc nie konsumuje
  `isForbiddenPath`; wpis nadal dotyczy RA-021.

## Stan dla audytu

Working tree czysty, `d5eda64`. Audyt powinien niezależnie sprawdzić sześć
kryteriów, a w szczególności poszukać dalszych ścieżek rubber-stampingu — dwie
znalezione dotąd nie były widoczne w testach unitu.
