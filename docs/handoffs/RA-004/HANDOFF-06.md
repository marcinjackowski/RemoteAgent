# RA-004 — Handoff 06

## Metadata

- Task: `RA-004`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po `HANDOFF-05` i `AUDIT-05`; RA-004 miał status `CHANGES_REQUESTED`; repo zawierało niezwiązane, niecommitowane zmiany
- Końcowy commit lub stan working tree: bez commita; zmiany tego przebiegu ograniczone do recovery RA-004, testów, tego handoffu i statusu taska
- Audyt źródłowy: `docs/audits/RA-004/AUDIT-05.md`
- Budżet: owner podał USD 108.69 / USD 150 przed tym przebiegiem; brak dokładnego pomiaru kosztu tego przebiegu w repo

## Wynik

Usunięto pojedynczy finding HIGH z AUDIT-05. `reapExpired` nie traktuje już
`SUCCEEDED` tak samo jak `FAILED`. Potwierdzony side effect jest rekonstruowany
jako terminalny sukces bez claimu/replay, a częściowe lub niepewne ledgery
failują zamknięcie do `RECONCILING`.

## Zrealizowany zakres

- Dodano semantyczną klasyfikację wszystkich intentów/completions jobu pod istniejącym row lockiem reaper transakcji.
- Wszystkie intenty `SUCCEEDED` rekonstruują job `SUCCEEDED`, czyszczą lease i ustawiają `finished_at`.
- Brak intentu albo wszystkie intenty `FAILED` bezpiecznie wracają do `PENDING`.
- Missing/`AMBIGUOUS` oraz każdy multi-intent partial zawierający `SUCCEEDED` przechodzi do `RECONCILING`.
- Wynik recovery rozszerzono o obserwowalne `succeeded: string[]`.
- Attempt ledger zapisuje `SUCCEEDED` z informacją o rekonstrukcji albo `LEASE_LOST` z dokładnym powodem requeue/reconciliation.
- Dodano sześć przypadków testowych AUDIT-05, w tym trzy warianty częściowego ledgeru.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/src/queue/job-store.ts` | Dodano eksportowany `ReapResult` z `reconciling`, `requeued`, `succeeded` | Rekonstrukcja terminalnego sukcesu jest obserwowalna dla schedulera/operatora |
| `packages/database/src/queue/job-store.ts` | `reapExpired` agreguje liczby intentów oraz `SUCCEEDED`/`FAILED`/`AMBIGUOUS`/missing completions i wybiera trzy klasy recovery | Potwierdzony external write nie może prowadzić do automatycznego replay |
| `packages/database/src/queue/job-store.ts` | Status update i attempt evidence pozostają w jednej transakcji; każdy update sprawdza `rowCount` | Job state i append-only historia nie mogą się rozjechać |
| `packages/database/src/queue/scheduler.ts` | `TickResult.reaped` używa `ReapResult` | Scheduler zachowuje rozszerzone evidence o odtworzonym sukcesie |
| `packages/database/test/queue-adversarial.integration.test.ts` | Dodano crash-after-receipt, all-success, trzy partial variants oraz no-intent/FAILED-only tests; wcześniejszy completion-lock test oczekuje teraz reconstructed success | Dokładne odtworzenie findingu i pełnej macierzy klasyfikacji |
| `docs/tasks/TASK_INDEX.md` | `CHANGES_REQUESTED` → `IN_PROGRESS` → `AWAITING_AUDIT` | Wymagany cykl implementera |

## Decyzje i uzasadnienie

Klasyfikacja jest wykonywana dla całego ledgeru jobu, nie pojedynczego ostatniego
wpisu. Macierz recovery:

| Ledger | Recovery |
|---|---|
| Jeden lub wiele intentów, wszystkie completion `SUCCEEDED` | `SUCCEEDED` bez replay |
| Brak intentów | `PENDING` |
| Jeden lub wiele intentów, wszystkie completion `FAILED` | `PENDING` |
| Dowolny missing albo `AMBIGUOUS` | `RECONCILING` |
| Co najmniej jeden `SUCCEEDED` i dowolny inny stan | `RECONCILING` |

All-success jest jedynym stanem z potwierdzonym wykonaniem całej zapisanej
operacji. FAILED-only oznacza definitywny brak udanego side effectu i może być
ponowiony. Każdy stan niepełny albo mieszany jest niebezpieczny dla replay całego
handlera, dlatego failuje zamknięcie.

Reaper już blokuje wygasłe wiersze `jobs` przez `FOR UPDATE SKIP LOCKED` i działa
pod advisory lockiem claimu. `recordIntent` oraz `recordCompletion` również
blokują ten sam job, więc agregat ledgeru, attempt insert i status update tworzą
jeden atomowy snapshot recovery.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny PostgreSQL gate 376/376; istniejące rollback/outbox testy przechodzą |
| 2. Crash po intent nie replayuje write | PASS | Crash po trwałym `SUCCEEDED` receipt rekonstruuje job `SUCCEEDED`; token 2 nie powstaje; liczba intentów pozostaje 1 |
| 3. Wygasły worker nie zapisze po takeover | PASS | Dotychczasowe fencing regressions pozostają zielone; recovery nie udostępnia potwierdzonego jobu do takeover |
| 4. Per-case serialization | PASS | Queue concurrency suite przeszła trzy finalne focused runs |
| 5. Bounded backoff i DLQ | PASS | Safe FAILED-only/no-intent requeue i istniejące retry/DLQ tests przechodzą |
| 6. Reconciliation idempotentne i audytowalne | PASS | Partial/missing/AMBIGUOUS stany przechodzą do `RECONCILING` z attempt evidence; wcześniejsze reconciliation tests pozostają zielone |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `pnpm --filter @remoteagent/database run typecheck` | 0 | Source i test TypeScript PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/database exec vitest run test/queue-adversarial.integration.test.ts test/queue.integration.test.ts test/queue-concurrency.integration.test.ts test/queue-runtime.test.ts` | 0 | Final run 1: 4 pliki, 63/63 PASS |
| Ta sama focused komenda, dwa dodatkowe równoległe przebiegi | 0 / 0 | Final run 2: 63/63 PASS; final run 3: 63/63 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | lint, format, typecheck, test, build i workflow validate PASS; 19 plików, 376/376 testów; build 20/20 |
| `git diff --check -- packages/database/src/queue/job-store.ts packages/database/src/queue/scheduler.ts packages/database/test/queue-adversarial.integration.test.ts docs/tasks/TASK_INDEX.md` | 0 | Brak błędów whitespace przed handoffem |

Pierwszy focused przebieg po zmianie kodu miał 62/63 PASS: istniejący AUDIT-03
test nadal oczekiwał starego, obecnie zabronionego `requeued` i tokenu 2 po
`SUCCEEDED` completion. Test zachował swoje asercje row-lock race, ale został
zaktualizowany do wymaganego `succeeded` i braku takeover. Trzy finalne przebiegi
63/63 są wykazane powyżej.

## Snapshoty i artefakty

- Artefakt/ścieżka: brak nowych snapshotów; test evidence opisano powyżej.
- Czy snapshot się zmienił i dlaczego: nie.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; fixtures używają syntetycznych receipts i identyfikatorów.
- Izolacja kont/scope: bez zmian; recovery działa wyłącznie po `job_id` zablokowanego jobu.
- Side effecty i idempotencja: trwały `SUCCEEDED` receipt nigdy nie prowadzi do automatycznego replay; partial state failuje zamknięcie.
- Dane zewnętrzne traktowane jako niezaufane: receipts nie są logowane w attempt error; agregacja używa wyłącznie outcome i obecności wiersza.

## Znane ograniczenia i ryzyka

- Node uruchamiający gate to `v25.2.1`, repo deklaruje `24.19.0`; istniejące ostrzeżenie engine nie zablokowało kontroli.
- ESLint nadal raportuje istniejące ostrzeżenia migracyjne `boundaries` v5→v6; brak błędów.
- Repo pozostaje w szerokim, wcześniej istniejącym niecommitowanym stanie; niezwiązanych zmian nie cofano ani nie modyfikowano.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: pojedynczy HIGH AUDIT-05 poprawiony; macierz recovery ma dokładne regressions; focused i full gate są zielone.
- Czego nie robić przed audytem: nie rozpoczynać RA-005, nie ustawiać RA-004 na `AUDIT_PASSED` ani `DONE`, nie zmieniać implementacji bez nowego findingu.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: najnowszy audyt RA-004, następnie `packages/database/src/queue/job-store.ts` i recovery tests w `packages/database/test/queue-adversarial.integration.test.ts`.
