# RA-004 — Handoff 04

## Metadata

- Task: `RA-004`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: working tree po `HANDOFF-03` i `AUDIT-03`; RA-004 miał status `CHANGES_REQUESTED`; repo zawierało niezwiązane, niecommitowane zmiany
- Końcowy commit lub stan working tree: bez commita; zmiany ograniczone do remediacji RA-004 AUDIT-03, testów, tego handoffu i statusu taska
- Audyt źródłowy: `docs/audits/RA-004/AUDIT-03.md`
- Budżet przekazany przez ownera: USD 103.71 / USD 150 przed tym przebiegiem

## Wynik

Usunięto wszystkie blokujące findingi AUDIT-03: dwa HIGH i jeden MEDIUM. Zapis
completion jest teraz jednym fence'owanym odcinkiem krytycznym z blokadą wiersza
jobu utrzymywaną do commitu. Replay completion i reconciliation porównuje JSONB
semantycznie w PostgreSQL, a reconciliation zawsze sprawdza powiązanie intentu z
podanym jobem przed jakimkolwiek early return.

## Zrealizowany zakres

- HIGH-01: zamknięto okno pomiędzy sprawdzeniem lease a insertem completion.
- HIGH-01: do gate dodano zgodność `job_intents.fencing_token` z prezentowanym lease.
- HIGH-01: przejście AMBIGUOUS sprawdza dokładnie jeden zaktualizowany wiersz.
- HIGH-02: provenance `(intentId, jobId)` jest sprawdzane przed replay i terminal close.
- HIGH-02: ten sam `(intentId, attemptKey)` jest idempotentny tylko dla identycznego jobu, resolution i evidence.
- MEDIUM-03: receipt completion jest porównywany przez PostgreSQL JSONB, w tym niezależnie od kolejności kluczy.
- LOW-04: ten handoff używa rzeczywistych ścieżek, mechanizmów, komend i liczebności testów.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/src/queue/job-store.ts` | `recordCompletion` blokuje prawidłowy, żywy wiersz jobu przez `FOR UPDATE OF j`, sprawdza intent/job/token, wykonuje insert pod lockiem i weryfikuje AMBIGUOUS `rowCount` | Reap lub takeover nie może wejść pomiędzy gate i zapis ledgeru |
| `packages/database/src/queue/job-store.ts` | Receipt replay używa `receipt IS NOT DISTINCT FROM $2::jsonb` | Semantyczna równość JSONB zamiast porównania obiektu drivera ze stringiem JS |
| `packages/database/src/queue/job-store.ts` | `reconcile` waliduje provenance przed early return; prior attempt pobiera job/resolution i oblicza JSONB evidence match | Obcy job lub konfliktujący replay nie może zostać uznany za idempotentny sukces |
| `packages/database/src/queue/errors.ts` | Dodano `ReconciliationConflictError` | Typowany, fail-closed wynik konfliktu semantyki reconciliation |
| `packages/database/test/queue-adversarial.integration.test.ts` | Dodano kontrolowany pause przed INSERT, receipt JSONB oraz reconciliation provenance/mismatch regressions | Odtworzenie dokładnych luk AUDIT-03 na realnym PostgreSQL |
| `packages/database/test/queue.integration.test.ts` | Idempotentny replay przekazuje identyczne evidence | Test odzwierciedla zaostrzony kontrakt same-key replay |
| `docs/tasks/TASK_INDEX.md` | `CHANGES_REQUESTED` → `IN_PROGRESS` → `AWAITING_AUDIT` | Wymagany cykl implementera |

## Decyzje i uzasadnienie

Wybrano blokadę `FOR UPDATE` wiersza `jobs`, ponieważ zapewnia liniowy punkt
fencing przed insertem i pozostaje aktywna do zakończenia transakcji. Reaper i
claim używają `SKIP LOCKED`, więc podczas kontrolowanej pauzy nie przetwarzają
zablokowanego jobu; token 2 może powstać dopiero po commicie completion. Gate
łączy intent z jobem oraz wymaga, aby token zapisany przy tworzeniu intentu i
aktualny token jobu odpowiadały prezentowanemu lease.

Równość receipt/evidence jest wykonywana w SQL operatorem `IS NOT DISTINCT FROM`
na `jsonb`. Dzięki temu SQL NULL jest równy SQL NULL, obiekty o innej kolejności
kluczy są równe, a rzeczywista zmiana wartości konfliktuje.

W `reconcile` provenance jest niezależne od statusu: intent musi należeć do
`input.jobId`, ale legalny replay po terminalnym przejściu nadal działa, mimo że
job nie jest już `RECONCILING`. Zachowano dotychczasową semantykę nowego klucza
terminalnego: zwraca istniejące terminalne zamknięcie.

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód |
|---|---|---|
| 1. Atomowy commit stanu i outbox | PASS | Pełny PostgreSQL gate 363/363; istniejące rollback/outbox testy bez regresji |
| 2. Crash po intent nie replayuje write | PASS | Istniejące missing/AMBIGUOUS regressions przechodzą w focused suite |
| 3. Wygasły worker nie zapisze po takeover | PASS | Kontrolowana pauza przed INSERT: reaper i claim nie przechodzą zablokowanego jobu; completion commit poprzedza token 2; intent token 1 jest odrzucany z lease token 2 |
| 4. Per-case serialization | PASS | Istniejące concurrency/adversarial regressions przechodzą |
| 5. Bounded backoff i DLQ | PASS | Istniejące retry/DLQ oraz DB-time skew regressions przechodzą |
| 6. Reconciliation idempotentne i audytowalne | PASS | Same-key resolution/evidence mismatch daje `ReconciliationConflictError`; wrong-job replay jest odrzucony; identyczne JSONB evidence replayuje poprawnie |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm --filter @remoteagent/database exec vitest run test/queue-adversarial.integration.test.ts test/queue.integration.test.ts test/queue-concurrency.integration.test.ts test/queue-runtime.test.ts` | 0 | 4 pliki, 50/50 PASS |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run check` | 0 | lint, format, typecheck, test, build i workflow validate PASS; 19 plików, 363/363 testów; build 20/20 |
| `git diff --check -- packages/database/src/queue/errors.ts packages/database/src/queue/job-store.ts packages/database/test/queue.integration.test.ts packages/database/test/queue-adversarial.integration.test.ts docs/tasks/TASK_INDEX.md` | 0 | Brak błędów whitespace przed handoffem |

Pierwsza iteracja nowego race testu oczekiwała widocznego oczekiwania na lock i
zakończyła się niepowodzeniem, ponieważ produkcyjny reaper poprawnie używa
`SKIP LOCKED`. Test poprawiono tak, aby asercja odpowiadała rzeczywistemu
kontraktowi: zablokowany job nie jest reaped ani claimed. Finalne wyniki są w
tabeli powyżej.

## Snapshoty i artefakty

- Artefakt/ścieżka: brak nowych snapshotów; dowody testowe w komendach powyżej.
- Czy snapshot się zmienił i dlaczego: nie.

## Bezpieczeństwo i dane

- Dostęp do sekretów: brak; fixtures nie zawierają sekretów.
- Izolacja kont/scope: bez zmian; zakres dotyczy wyłącznie ledgeru jobów.
- Side effecty i idempotencja: completion jest fence'owane lockiem i tokenem intentu; replay receipt/evidence jest semantycznie porównywany w DB; konflikty failują zamknięcie.
- Dane zewnętrzne traktowane jako niezaufane: receipt/evidence pozostają parametryzowanym JSONB; brak interpolacji danych do SQL.

## Znane ograniczenia i ryzyka

- Node uruchamiający gate to `v25.2.1`, podczas gdy repo deklaruje `24.19.0`; pnpm zgłosił istniejące ostrzeżenie engine, ale wszystkie kontrole przeszły.
- ESLint zgłosił istniejące ostrzeżenia migracyjne `boundaries` v5→v6; brak nowych błędów.
- Repo pozostaje w rozległym, wcześniej istniejącym niecommitowanym stanie; niezwiązanych zmian nie modyfikowano ani nie cofano.

## Otwarte pytania

- Brak.

## Stan dla następnego agenta

- Co jest gotowe: wszystkie HIGH/MEDIUM AUDIT-03 są poprawione; focused i pełny PostgreSQL gate są zielone.
- Czego nie robić przed audytem: nie rozpoczynać RA-005, nie ustawiać RA-004 na `DONE`, nie zmieniać implementacji bez nowego findingu audytora.
- Gdzie zacząć po `continue`, jeśli audyt zażąda zmian: `docs/audits/RA-004/AUDIT-04.md`, następnie `packages/database/src/queue/job-store.ts` i `packages/database/test/queue-adversarial.integration.test.ts`.
