# RA-015 — Audit 01

## Metadata

- Task: `RA-015`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-015/HANDOFF-01.md`
- Data: `2026-08-20`
- Zakres diffu: `d073527..d5eda64`
- **Werdykt: `PASS`**

## Podstawa werdyktu

Odczyt diffu, samodzielne bramki, mutation testing i sondy adwersarialne
skierowane na `Audit focus` taska — czyli wprost na możliwość rubber-stampingu.
Znalazły dwa findingi HIGH. **Czwarty task z rzędu**, w którym sonda znajduje to,
czego nie znalazły testy unitu.

Ten task ma szczególną własność: sam definiuje mechanizm anty-rubber-stampingowy,
więc dziura w nim byłaby dziurą w bramce dla wszystkich przyszłych zmian.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Werdykt | Jak sprawdzone |
|---|---|---|
| 1 | PASS | context nie ma żadnej funkcji (asercja mechaniczna, nie deklaracja); frozen; próba wszczepienia `write` rzuca; **manifest nie zawiera** write-capable pakietów; powierzchnia modułu przeskanowana pod nazwy mutujące |
| 2 | PASS | BLOCKER/HIGH/MEDIUM blokują osobno; LOW/NIT nie; zero raportów rzuca; dyspozycja bez rationale nieprzedstawialna (4 warianty) |
| 3 | PASS | brak lokalizacji, evidence poniżej progu i brak `required_fix` odrzucone; **sfabrykowany cytat downgrade'owany do LOW**, nie przyjęty; whitespace odrzucony przy schemacie |
| 4 | PASS | limit iteracji, budżet tokenów i runda bez postępu — trzy niezależne ścieżki eskalacji; `iterationLimit` nie-całkowity i ≤ 0 odrzucone; sprawdzenie budżetu **przed** rundą, więc nie da się przekroczyć o jeden |
| 5 | PASS | commit + receipty + `fixed_diff_digest` wymagane; skrócony SHA odrzucony |
| 6 | PASS | `diff_digest` liczony z treści diffu, nie przyjmowany parametrem; raport o innym diffie i o innym drzewie odrzucony; kłamliwy `claimed_summary` nie zmienia digestu |

## Findingi

### Finding 1 — `ReviewResolution` był self-certifying (HIGH, **naprawiony**)

```text
resolution with unrelated commit/receipt -> READY
```

Dowolny 40-hex commit i dowolny digest receiptu czyściły `BLOCKER`. Nic nie wiązało
tych wartości ani z findingiem, ani z realną zmianą — a AC5 istnieje dokładnie po to,
by „naprawione" wskazywało na diff i na przechodzącą weryfikację tego diffu.

**Naprawa.** `fixed_diff_digest` jako pole wymagane, plus odmowa w `deriveReadiness`,
gdy równa się diffowi wciąż będącemu w review. Resolution o tym samym digescie
twierdzi, że naprawił kod bez jego zmiany.

### Finding 2 — pusty raport dawał `READY` (HIGH, **naprawiony**)

```text
empty report -> READY (reviewer that did nothing)
```

Reviewer, który nie przeczytał diffu, przepuszczał zmianę. Pusta lista findingów jest
dwuznaczna: „przeczytałem, nic nie znalazłem" albo „nie czytałem". To
**rubber-stamping przez zaniechanie** — najtrudniejszy do wyłapania, bo czysty raport
wygląda jak dobra wiadomość.

**Naprawa.** `lines_examined` wymagane; raport, w którym wszyscy reviewerzy zbadali 0
linii, jest odrzucany; `guardReviewer` **przycina** zawyżoną deklarację do realnego
rozmiaru diffu, więc reviewer nie może przecenić swojej pracy.

### Finding 3 — `derived_from` przyjmuje duplikaty (LOW, zaakceptowany)

Ten sam raport dwa razy daje `derived_from: ["r1","r1"]`. Nie wpływa na werdykt (unia
findingów jest deduplikowana po lokalizacji) i nie tworzy fałszywego sukcesu.
Kosmetyczne; odnotowane.

### Probe'y bez findingu

- resolution dla **innego** findingu nie czyści blockera → `CHANGES_REQUIRED`;
- evidence złożone z samych białych znaków → odrzucone przy schemacie;
- unlocated findingi nie są sklejane po lokalizacji (są rozróżniane po id) —
  poprawne, bo dwa różne nieumiejscowione spostrzeżenia nie są jednym.

Brak otwartych findingów BLOCKER/HIGH/MEDIUM na moment werdyktu.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1338/1338, 121 plików** |
| `pnpm vitest run packages/review-loop/test` | 0 | 34/34 |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| 9 mutacji | — | każda wykryta |
| sondy adwersarialne | — | **findingi 1 i 2** |

## Niezależność review — ocena wprost

`Audit focus` pyta o niezależność i możliwość rubber-stampingu. Ocena:

1. **Niezależność jest strukturalna**, nie proceduralna: reviewer nie ma uchwytu do
   zapisu, a pakiet nie ma zależności, przez którą mógłby go zdobyć. To mocniejsze niż
   „reviewer nie powinien pisać".
2. **Ścieżki rubber-stampingu są zamknięte na czterech poziomach**: nieuzasadniona
   dyspozycja (nieprzedstawialna), niepotwierdzone evidence (downgrade), samopotwier-
   dzający resolution (odmowa), reviewer, który nic nie przeczytał (odmowa).
3. **Poprawki wracają przez single writera**: `applyFix` jest jedyną ścieżką zapisu w
   pętli, a supervisor niczego nie naprawia. Reviewer nie pisze, supervisor nie pisze.
4. **Severity policy** karze inflację: LOW/NIT nie blokują, więc podnoszenie severity
   „żeby było widać" nie jest darmowe, a to lustrzane odbicie rubber-stampingu.

## Werdykt

- Werdykt: `PASS`

Sześć kryteriów spełnione i sprawdzone osobno. Dwa findingi HIGH znalezione w tym
audycie i naprawione z testami regresyjnymi przed werdyktem; jeden LOW zaakceptowany.

Status: `AUDIT_PASSED` → `DONE`. **Odblokowuje RA-017** (wszystkie zależności `DONE`),
czyli domyka warunek wejścia do M3.
