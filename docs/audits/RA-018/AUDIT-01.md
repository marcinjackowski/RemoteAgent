# RA-018 — Audit 01

## Metadata

- Task: `RA-018`
- Audytor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Oceniany handoff: `docs/handoffs/RA-018/HANDOFF-01.md`
- Data: `2026-08-21`
- Zakres diffu: `b0d1ac8..8edd109`
- **Werdykt: `PASS`**

## Podstawa werdyktu

`Audit focus` tego taska mówi wprost: „audyt musi sprawdzić system end-to-end, a nie
wyłącznie zielony test". Zastosowałem cztery niezależne metody, bo dla bramki
milestone'owej sama zielona suite jest najsłabszym dostępnym dowodem:

1. odczyt pełnego diffu i uruchomienie wszystkich bramek;
2. mutation testing — w tym mutacja **struktury testu**, nie tylko kodu;
3. sondy adwersarialne na izolację między case'ami;
4. sprawdzenie, czy bramka **może przejść fałszywie** (stale build).

Metoda 4 znalazła defekt, którego trzy pozostałe nie znalazły.

## Kryteria akceptacji — każde sprawdzone osobno

| # | Werdykt | Jak sprawdzone |
|---|---|---|
| 1 | PASS | bariera zwalniana **wyłącznie przez drugi case** + licznik `peakInside === 2`. Mutacja na wykonanie sekwencyjne **zakleszcza test**, nie tylko go wywala — overlap jest więc wymuszony konstrukcyjnie, nie zaobserwowany przypadkiem. To najmocniejsza forma tego dowodu |
| 2 | PASS | scope fence ledgera = głośna odmowa (nie ciche `null`); przy wspólnym roocie dokładnie jeden `SUCCEEDED`, ocalałe bajty należą do zwycięzcy, przegrany `AMBIGUOUS` |
| 3 | PASS | świeże repozytorium nad tą samą bazą czyta `SUCCEEDED` i `changedFiles`; HEAD z Gita równy zapisanemu commitowi; artefakt zweryfikowany digestem; MR odnaleziony **po parze branchy z remote'a**, nie z pamięci; werdykt re-derywowany identycznie |
| 4 | PASS | zaklaimowana, niedomknięta operacja → replay `AMBIGUOUS` z `requires_reconciliation`, **bajty na dysku nietknięte**, operacja na liście reconciliation; osobno timeout → `INCONCLUSIVE`, nie regresja |
| 5 | PASS | receipty w commit receipt i w opisie MR; `head_sha` równy faktycznemu commitowi; `VERIFIED` niosące dokładnie te receipty, które zwrócił runner |
| 6 | PASS | dwa oczekujące pytania jednocześnie; odpowiedź na jedno nie rusza drugiego; `discord_thread_id` różne w bazie |
| 7 | PASS | trzy dostawy tego samego webhooka → jeden accept; trzy publikacje tego samego intentu → jeden MR przy trzech pushach (push jest idempotentny na poziomie Gita) |

## Findingi

### Finding 1 — bramka mogła przejść na starym buildzie (HIGH, **naprawiony**)

Najpoważniejszy finding tego taska, i taki, którego nie znalazłaby żadna liczba
zielonych przebiegów.

Importy w `test/golden-path/` rozwiązują się przez `node_modules` do `dist/`. Jest to
**właściwe** dla testu integracyjnego — ćwiczy artefakty, które załadowałby
deployment — ale oznacza, że stary build sprawia, że suite certyfikuje kod, którego
już nie ma.

**Dowód.** Zepsucie `patch.ts` w `src`: **8/8 zielonych**. Ta sama mutacja po
`pnpm run build --force`: test wywalony natychmiast. Czyli: mutation testing
przeprowadzony bez przebudowy dałby fałszywy wniosek „testy nie są load-bearing",
a normalny przebieg CI po zmianie w `src` bez builda dałby fałszywe `PASS`.

**Naprawa.** `assertPackagesAreCurrent` porównuje najnowszy mtime `src/` z
najstarszym `dist/` dla ośmiu ćwiczonych pakietów i odmawia uruchomienia, podając
pakiet i komendę. Zweryfikowane w obie strony: `touch` na pliku `src` blokuje suite z
jawnym komunikatem.

**Wniosek przekrojowy.** To wariant `CTF-010` (komentarz ≠ zachowanie) przeniesiony
na poziom bramki: *nazwa* testu obiecywała weryfikację obecnego kodu, a mechanizm jej
nie dawał. Zapisane jako `CTF-011`.

### Finding 2 — wspólny root nie jest pilnowany przez ledger (MEDIUM, **udokumentowany i przypięty**)

Sonda: dwa **różne** case wskazane na ten sam katalog. Ledger skopuje po
`(case_id, workspace_id)`, więc poprawnie blokuje replay operacji **innego** case, ale
nie wie, że katalog jest wspólny.

Nie klasyfikuję tego jako defektu RA-018: rozłączność rootów pochodzi z RA-010, który
mintuje jeden workspace per case, i to jest właściwa warstwa. Klasyfikuję jako
**brakujący dowód konsekwencji**, i to zostało dodane — pod wspólnym rootem dokładnie
jeden writer raportuje `SUCCEEDED`, ocalałe bajty są jego, przegrany jest `AMBIGUOUS`.
Drugi `SUCCEEDED` byłby fałszywym receiptem: poświadczałby treść, której nie ma na
dysku. Mutacja usuwająca `contentsMatch` wywala ten test.

### Finding 3 — review testowany tylko na pustej liście findingów (MEDIUM, **naprawiony**)

Golden path przechodził z zerem findingów, więc „review passed" było testowane
wyłącznie w przypadku, w którym nie było czego reviewować. Dodany test z realnym
`BLOCKER`: readiness wstrzymana, czyszczona wyłącznie resolution z commitem,
receiptami i **zmienionym** digestem diffu.

### Probe'y bez findingu

- ten sam slug w dwóch case daje **różne** nazwy branchy (digest case'a rozróżnia);
- ten sam `operation_id` z obcego case → `OperationScopeError`, bajty nietknięte;
- oba `ensureBranch` raportują `CREATED` niezależnie.

Brak otwartych findingów BLOCKER/HIGH/MEDIUM na moment werdyktu.

## Kontrole wykonane samodzielnie

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/golden-path` | 0 | 11/11 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1388/1388, 124 pliki, zero `Errors`** |
| trzy pełne przebiegi po domknięciu `CTF-003`/`CTF-007` | 0 | 1377/1377 × 3, zero `Errors` |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint` / `prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| 6 mutacji (w tym mutacja struktury testu) | — | każda wykryta |
| sondy adwersarialne | — | **findingi 1–3** |

## Ocena wiarygodności evidence — wprost

To bramka milestone, więc oceniam osobno, czemu ten zielony przebieg **można** wierzyć
i czego nie dowodzi.

**Można wierzyć**, bo: baza, filesystem, Git i procesy są realne; overlap jest
wymuszony bariery, nie zaobserwowany; restart czyta stan z trwałego źródła, nie z
pamięci; asercje idą na bajty na dysku i wiersze w bazie, nie na wartości zwracane;
a bramka odmawia uruchomienia na starym buildzie.

**Nie dowodzi**, że: live GitLab zachowuje się jak fake; że Discord send działa
(manual acceptance nie wykonany — wymaga zgody właściciela); że orkiestracja
supervisora spina te elementy w produkcyjnym runtime (RA-018 dowodzi kontraktów i
przepływu, apps/ nie są tu ćwiczone end-to-end).

Te trzy luki są w handoffie i uznaję je za **właściwe dla zakresu** tego taska, nie za
braki: dwie wymagają credentiali/zgody, których nie ma, a trzecia należy do RA-021+.

## Werdykt

- Werdykt: `PASS`

Siedem kryteriów spełnione i sprawdzone osobno. Jeden finding HIGH i dwa MEDIUM
znalezione w tym audycie, wszystkie naprawione albo przypięte testem przed werdyktem.
`CTF-003` i `CTF-007` domknięte jako warunek wstępny.

Status: `AUDIT_PASSED` → `DONE`. **M3 domknięty.** Odblokowuje RA-019 i RA-020.
