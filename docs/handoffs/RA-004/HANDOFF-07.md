# RA-004 — Handoff 07

## Metadata

- Task: `RA-004`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po `HANDOFF-06` i `AUDIT-06`; RA-004 miał status `CHANGES_REQUESTED`; repo zawierało niezwiązane, niecommitowane zmiany
- Końcowy commit lub stan working tree: bez commita; zmiany tego przebiegu ograniczone do reconciliation RA-004, testów, tego handoffu i statusu taska
- Audyt źródłowy: `docs/audits/RA-004/AUDIT-06.md`
- Budżet: owner podał około USD 114.57 / USD 150 przed tym przebiegiem; brak dokładnego pomiaru kosztu tego przebiegu w repo

## Wynik

Usunięto pojedynczy finding HIGH z AUDIT-06. Reaper i reconciliation używają
teraz jednego job-wide klasyfikatora efektywnego stanu wszystkich intentów.
Terminalne reconciliation jest autorytatywne per intent, ale status całego joba
zmienia się dopiero po agregacji całego ledgeru.

## Zrealizowany zakres

- Dodano wspólny `classifyIntentLedger` używany przez `reapExpired` i po każdym nowym terminalnym reconciliation.
- `CONFIRMED` daje effective success dla danego intentu; `ABSENT` daje effective definite absence.
- Job przechodzi do `SUCCEEDED` wyłącznie dla all-effective-success.
- Job przechodzi do `PENDING` wyłącznie bez success, gdy wszystkie intenty są effective absent/failed.
- Missing, `UNRESOLVED`, `AMBIGUOUS` i mieszanka success+absence pozostają `RECONCILING`.
- Usunięto tworzenie syntetycznego `job_completions(SUCCEEDED)` przez `reconcile(CONFIRMED)`.
- Sprzeczne definitywne completion/resolution daje `ReconciliationConflictError` i rollback reconciliation.
- Zachowano single-intent CONFIRMED/ABSENT, same-key exact replay i terminal new-key idempotent close.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/src/queue/job-store.ts` | Dodano `classifyIntentLedger`, który nadaje każdemu intentowi effective `SUCCESS`, `ABSENT` albo `UNRESOLVED`, a następnie klasyfikuje job | Reaper i operator reconciliation nie mogą stosować różnych reguł bezpieczeństwa |
| `packages/database/src/queue/job-store.ts` | Terminal reconciliation jest zapisywane, następnie classifier ustawia `SUCCEEDED`, `PENDING` albo pozostawia `RECONCILING` | Jeden intent nie może samodzielnie zamknąć lub ponownie otworzyć multi-intent jobu |
| `packages/database/src/queue/job-store.ts` | Przed terminal insert sprawdzany jest istniejący completion: `FAILED` kontra `CONFIRMED` i `SUCCEEDED` kontra `ABSENT` konfliktują | Append-only completion nie jest cicho ignorowane ani udawanie mutowane |
| `packages/database/src/queue/job-store.ts` | `reapExpired` korzysta z tego samego effective classifier zamiast osobnej agregacji raw completion | Spójna semantyka także po wcześniejszych reconciliation i ponownym lease |
| `packages/database/test/queue.integration.test.ts` | Audytowalność CONFIRMED oczekuje terminal reconciliation bez syntetycznego completion | Reconciliation ledger jest źródłem resolution |
| `packages/database/test/queue-adversarial.integration.test.ts` | Dodano success+ABSENT partial, sequential all-success oraz dwa sprzeczne completion/resolution regressions | Dokładne testy wymagane przez AUDIT-06 |
| `docs/tasks/TASK_INDEX.md` | `CHANGES_REQUESTED` → `IN_PROGRESS` → `AWAITING_AUDIT` | Wymagany cykl implementera |

## Decyzje i uzasadnienie

Efektywny stan intentu jest wyznaczany w kolejności:

1. Terminal `CONFIRMED` → `SUCCESS`.
2. Terminal `ABSENT` → `ABSENT`.
3. Bez terminala, dowolny `UNRESOLVED` attempt → `UNRESOLVED`.
4. Raw completion `SUCCEEDED` → `SUCCESS`.
5. Raw completion `FAILED` → `ABSENT`.
6. Raw `AMBIGUOUS` albo brak completion → `UNRESOLVED`.

Terminal reconciliation ma pierwszeństwo nad `AMBIGUOUS`/missing, ponieważ jest
wynikiem późniejszej, autorytatywnej obserwacji. Definitywnie sprzeczne raw
completion nie jest jednak przepisywane: `SUCCEEDED` nie może zostać zamknięte
`ABSENT`, a `FAILED` nie może zostać zamknięte `CONFIRMED`; metoda failuje przed
appendem reconciliation.

Macierz job-wide:

| Effective ledger | Status joba |
|---|---|
| Wszystkie intenty `SUCCESS` | `SUCCEEDED` |
| Zero `SUCCESS`, zero `UNRESOLVED`, wszystkie `ABSENT` | `PENDING` |
| Każdy inny stan, w tym success+absence | `RECONCILING` |

Nie tworzono migracji ani nie mutowano append-only tabel. `CONFIRMED` bez raw
completion pozostaje w pełni audytowalne przez `job_reconciliations`; classifier
nie potrzebuje fikcyjnego completion row.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny PostgreSQL gate 380/380; istniejące rollback/outbox testy przechodzą |
| 2. Crash po intent nie replayuje write | PASS | Success+missing potem ABSENT pozostaje RECONCILING; claim W2 zwraca null i token pozostaje 1 |
| 3. Wygasły worker nie zapisze po takeover | PASS | Dotychczasowe fencing regressions pozostają zielone; unsafe PENDING transition została usunięta |
| 4. Per-case serialization | PASS | Queue concurrency suite przeszła trzy finalne focused runs |
| 5. Bounded backoff i DLQ | PASS | Istniejące retry/DLQ tests przechodzą bez regresji |
| 6. Reconciliation idempotentne i audytowalne | PASS | Pierwsze CONFIRMED z dwóch missing pozostaje RECONCILING, drugie daje all-success; konflikty rollbackują; single-intent i replay tests przechodzą |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm --filter @remoteagent/database run typecheck` | 0 | Source i test TypeScript PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/database exec vitest run test/queue-adversarial.integration.test.ts test/queue.integration.test.ts test/queue-concurrency.integration.test.ts test/queue-runtime.test.ts` | 0 | Final run 1: 4 pliki, 67/67 PASS |
| Ta sama focused komenda, dwa dodatkowe równoległe przebiegi | 0 / 0 | Final run 2: 67/67 PASS; final run 3: 67/67 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | lint, format, typecheck, test, build i workflow validate PASS; 19 plików, 380/380 testów; build 20/20 |
| `git diff --check -- packages/database/src/queue/job-store.ts packages/database/test/queue.integration.test.ts packages/database/test/queue-adversarial.integration.test.ts docs/tasks/TASK_INDEX.md` | 0 | Brak błędów whitespace przed handoffem |

Pierwszy focused przebieg podczas implementacji miał 47/48 PASS: jedyną porażką
była stara asercja oczekująca syntetycznego completion po single-intent
CONFIRMED. Po dostosowaniu testu do append-only reconciliation trzy finalne
przebiegi 67/67 przeszły.

## Snapshoty i artefakty

- Artefakt/ścieżka: brak nowych snapshotów; test evidence opisano powyżej.
- Czy snapshot się zmienił i dlaczego: nie.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; fixtures zawierają wyłącznie syntetyczne evidence/receipts.
- Izolacja kont/scope: bez zmian; classifier jest ograniczony przez `job_id` i provenance intentu.
- Side effecty i idempotencja: mieszany ledger z potwierdzonym write nigdy nie wraca do automatycznego replay; exact reconciliation replay pozostaje idempotentny.
- Dane zewnętrzne traktowane jako niezaufane: evidence nadal jest parametryzowanym JSONB; classifier używa tylko outcome/resolution.

## Znane ograniczenia i ryzyka

- Node uruchamiający gate to `v25.2.1`, repo deklaruje `24.19.0`; istniejące ostrzeżenie engine nie zablokowało kontroli.
- ESLint nadal raportuje istniejące ostrzeżenia migracyjne `boundaries` v5→v6; brak błędów.
- Repo pozostaje w szerokim, wcześniej istniejącym niecommitowanym stanie; niezwiązanych zmian nie cofano ani nie modyfikowano.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: pojedynczy HIGH AUDIT-06 poprawiony; wspólna macierz działa w reaper i reconcile; focused i full gate są zielone.
- Czego nie robić przed audytem: nie rozpoczynać RA-005, nie ustawiać RA-004 na `AUDIT_PASSED` ani `DONE`, nie zmieniać implementacji bez nowego findingu.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: najnowszy audyt RA-004, `classifyIntentLedger`/`reconcile` w `packages/database/src/queue/job-store.ts` oraz AUDIT-06 tests w `packages/database/test/queue-adversarial.integration.test.ts`.
