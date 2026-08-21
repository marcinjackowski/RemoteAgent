# RA-018 — Handoff 01

## Metadata

- Task: `RA-018`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: `COORDINATOR_AUDITOR` (Claude Opus 5)
- Proces: [ADR-0007](../../decisions/ADR-0007-verification-first-delivery.md)
- Data: `2026-08-21`
- Bazowy commit: `b0d1ac8`
- Końcowy commit: `8edd109`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/golden-path`

## Wynik

`test/golden-path/` — 11 testów spinających Jira → case → implementacja →
weryfikacja → review → commit → draft MR, uruchamianych **dwa razy równolegle**, z
restartem i fault injection na każdej istotnej granicy.

Wszystko pod connectorami jest realne: zmigrowany PostgreSQL, filesystem,
repozytoria Git, spawnowane procesy, prawdziwe kontrakty. Jira i GitLab to
**nagrywające** fake'i — live sandbox wymaga credentiali, których nikt nie udzielił.

## Warunek wstępny domknięty przed gate'em

Plan RA-018 ostrzegał, że `CTF-003` podkopuje bramkę „całe repo zielone", na której
ten task opiera evidence. Domknięte razem z `CTF-007` w commicie `cfc3a15` **przed**
napisaniem golden path:

- `CTF-003` był race'em w **teście**, nie w `runProcess`: asercja czytała
  `child.pid` pod 100 ms timeoutem. Rozdzielone na dwa niezależne fakty.
- `CTF-007` miał za sobą **realny defekt produkcyjny**: `Database` nigdy nie
  rejestrował `pool.on("error")`, więc błąd na bezczynnym połączeniu (restart
  serwera, `pg_terminate_backend`) był nieobsłużonym wyjątkiem i zabijał proces.
  Na produkcji rutynowy restart bazy ubiłby workera.

Trzy kolejne pełne przebiegi: 1377/1377, zero `Errors`.

## Kryteria akceptacji

| # | Status | Dowód |
|---|---|---|
| 1. Dwa taski realnie równolegle, bez współdzielenia zmian | PASS | bariera, którą zwalnia **tylko drugi case**; licznik `peakInside === 2`; osobne rooty, branche, commity i MR-y |
| 2. Ten sam case nigdy nie ma dwóch writerów | PASS | scope fence ledgera (głośna odmowa); przy wspólnym roocie dokładnie jeden `SUCCEEDED`, przegrany `AMBIGUOUS` |
| 3. Restart nie traci decyzji, planu, diffu, testów ani MR mappingu | PASS | świeże repozytorium nad tą samą bazą; commit odczytany z Gita; artefakt zweryfikowany digestem; MR odnaleziony po parze branchy |
| 4. Crash przy niepotwierdzonym write → reconciliation/`AMBIGUOUS` | PASS | zaklaimowana, niedomknięta operacja; replay `AMBIGUOUS`, **bajty na dysku nietknięte**; timeout → `INCONCLUSIVE` |
| 5. Każdy MR wskazuje task, decyzje, testy, review i aktualny SHA | PASS | receipty w opisie i w commit receipt; `head_sha` = faktyczny commit |
| 6. `continue` po pytaniu wznawia właściwy case | PASS | dwa oczekujące pytania; odpowiedź na jedno nie rusza drugiego; wiersze cases niezależne |
| 7. Ponowne dostarczenie eventów nie tworzy duplikatów | PASS | trzy dostawy tego samego webhooka → jeden accept; trzy publikacje → jeden MR |

## Defekt integralności evidence znaleziony w samym teście

Najważniejsza pozycja tego handoffu.

Te importy rozwiązują się przez `node_modules` do `dist/` każdego pakietu — co jest
**właściwe** dla testu integracyjnego, bo ćwiczy artefakty, które załadowałby
deployment. Ale oznacza, że **stary build sprawia, że suite certyfikuje kod, który
już nie istnieje**.

Wykryte mutation testingiem tego pliku: zepsucie `patch.ts` w `src` zostawiło
wszystkie osiem testów zielonych, a ta sama mutacja wywaliła test natychmiast po
przebudowaniu pakietu. Bramka milestone'owa, która przechodzi na buildzie z
poprzedniego tygodnia, nie jest bramką.

Naprawa: `assertPackagesAreCurrent` odmawia uruchomienia, gdy którykolwiek
ćwiczony pakiet ma `dist/` starszy niż `src/`, podając pakiet i komendę naprawczą.
Zweryfikowane w obie strony — `touch` na pliku `src` blokuje suite.

## Findingi z własnego audytu (naprawione przed handoffem)

1. **Wspólny root nie jest pilnowany przez ledger** (finding, nie defekt kodu).
   Ledger skopuje po `(case_id, workspace_id)`, więc nie wie, że dwa **różne** case
   wskazały ten sam katalog. Rozłączność rootów pochodzi z deploymentu (RA-010).
   Zapisane jako test pinujący **konsekwencję**: dokładnie jeden `SUCCEEDED`,
   przegrany `AMBIGUOUS`, a ocalałe bajty należą do zwycięzcy.
2. **Review testowany tylko na pustej liście findingów.** Dodany test z realnym
   `BLOCKER`: readiness wstrzymana, czyszczona wyłącznie resolution z commitem,
   receiptami i **zmienionym** digestem diffu.

## Testy i kontrole

| Kontrola | Exit | Wynik |
|---|---:|---|
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run test/golden-path` | 0 | 11/11 |
| `RA_REQUIRE_POSTGRES=1 pnpm vitest run` (całe repo) | 0 | **1388/1388, 124 pliki, zero `Errors`** |
| `pnpm run typecheck --force` | 0 | 36/36 |
| `pnpm run build --force` | 0 | 26/26 |
| `pnpm exec eslint test/golden-path` | 0 | PASS |
| `pnpm exec prettier --check .` | 0 | PASS |
| `pnpm workflow:validate` | 0 | OK — 26 tasks |
| repo lint error count | — | 3 (baseline `CTF-008`, bez zmian) |

## Mutation testing

| Mutacja | Wynik |
|---|---|
| **dwa case sekwencyjnie zamiast równolegle** | **DEADLOCK** (timeout) — dowód, że overlap jest wymuszony, nie założony |
| unsettled claim replay → `SUCCEEDED` (po przebudowie) | 1 FAIL |
| scope fence ledgera usunięty (po przebudowie) | 1 FAIL |
| `contentsMatch` usunięty (niezweryfikowany zapis → `SUCCEEDED`) | 1 FAIL |
| `pool.on("error")` usunięty | odtwarza sygnaturę `CTF-007`: testy zielone, `Errors 2` |
| **te same mutacje BEZ przebudowy** | 0 FAIL — dowód defektu stale-dist opisanego wyżej |

## Znane ograniczenia

- **Jira i GitLab to fake'i.** Zielony przebieg **nie** dowodzi, że live GitLab
  zachowuje się jak fake. To jedyna realna luka tego taska; sandbox wymaga jawnie
  udzielonych credentiali (zakres taska to przewiduje). Fake'i są nagrywające, więc
  asercje dotyczą tego, co faktycznie poszłoby na wire.
- **Manual Discord acceptance script** nie został wykonany — wymaga zgody
  właściciela na send. Domyślnie fake transport.
- `CTF-004` (src-vs-dist) zmaterializował się dwukrotnie (`Database`,
  `Transaction`); obejście przez inferencję typów harnessu, z uzasadnieniem w kodzie.
- `CTF-008` — repo lint nadal 3 preexistujące błędy; RA-018 nie dodał żadnego.

## Stan dla audytu

Working tree czysty, `8edd109`. Audyt powinien sprawdzić **system**, nie zielony
test: czy overlap jest wymuszony, czy restart czyta stan z trwałego źródła, czy
fake'i nie ukrywają założeń, i czy bramka nie może przejść na starym buildzie.
