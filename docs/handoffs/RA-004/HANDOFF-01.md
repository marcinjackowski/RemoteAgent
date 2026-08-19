# RA-004 — Handoff 01

## Metadata

- Task: `RA-004`
- Status proponowany: `AWAITING_AUDIT`
- Autor/rola: IMPLEMENTER
- Data: 2026-08-19
- Bazowy commit lub stan początkowy: niezacommitowany working tree na `main` po
  RA-003 `AUDIT-05` `PASS` (RA-002/RA-003 completed, niezacommitowane); RA-004
  bez artefaktów.
- Końcowy commit lub stan working tree: niezacommitowany working tree na `main`;
  dodano `packages/database/src/queue/*`, migracje 012-014, testy queue oraz
  addytywny eksport w `packages/database/src/index.ts`. Zachowane wszystkie
  wcześniejsze zmiany RA-002/RA-003 i migracje 001-011.

## Wynik

Zaimplementowano pełny zakres RA-004 w `@remoteagent/database` jako deterministyczny,
produkcyjny durable-queue core: transactional outbox z relayem exactly-once-effect,
trwałe joby z leases (expiry + heartbeat + fencing), bounded exponential backoff +
DLQ, per-case serialization i konfigurowalne global/provider concurrency limits,
intent-before-operation + completion, idempotentna i audytowalna rekonsyliacja
AMBIGUOUS, interfejs scheduler/polling oraz deterministyczne porty clock/id do
testów. RA-003 tabele `jobs`/`outbox`/`outbox_dispatch` rozwinięte wyłącznie
addytywnie (migracje 012-014); żaden zaakceptowany constraint RA-003 nie został
osłabiony.

Clean-room `pnpm run check` na przypiętym Node 24.19.0 / pnpm 10.26.1 z realnym
PostgreSQL 17.2: **337/337 testów** (w tym 24 nowe RA-004), build 20/20,
workflow:validate OK. Migracje **14/14 up/down/up** deterministyczne na czystej
bazie.

## Architektura i decyzje

- **Umiejscowienie w `@remoteagent/database`.** RA-003 utworzyło tabele
  `jobs`/`outbox`/`outbox_dispatch` z jawnym komentarzem "populated by RA-004's
  worker". Durable-queue core to warstwa transakcyjnej persystencji, więc żyje w
  tym samym pakiecie i reużywa `Database`/`Transaction`/`translatePgError`. Zakres
  wyklucza konkretny Discord/provider worker i AWS deployment (task Out of scope),
  więc dostarczam prymitywy + interfejs scheduler, nie aplikację.
- **Deterministyczne porty clock/id** (`queue/runtime.ts`). Cały czas i tożsamość
  przechodzą przez `Clock`/`IdGenerator`. Produkcja: `SystemClock`/`UuidGenerator`.
  Testy: `ManualClock` (nigdy nie rusza się sam) + `SequentialIdGenerator`. Czas
  jest przekazywany jako ms epoch i konwertowany w SQL przez
  `to_timestamp($n / 1000.0)`, więc żadna ścieżka kontrolowana przez test nie
  czyta `now()` bazy (audit focus: clock assumptions).
- **Atomowy commit (kryt. 1).** `OutboxRepository.enqueue` i `JobStore.enqueue`
  przyjmują `Queryable`/branded `Transaction`, więc message i zmiana stanu commitują
  się w jednej transakcji wywołującego. `enqueue` outboxa wymaga `Transaction`
  (nie auto-commit pool) — "publish bez zmiany stanu" jest błędem kompilacji.
- **Leasing + fencing (kryt. 3).** `claim` bumpuje monotoniczny `fencing_token` i
  ustawia lease w JEDNEJ krótkiej brandowanej transakcji. Każdy write po claimie
  (`heartbeat`/`complete`/`fail`/`recordIntent`) jest warunkowany na
  `job_id + lease_owner + fencing_token + status='LEASED' + lease_expires_at > now`
  (injected clock); 0 zaktualizowanych wierszy → fail-closed `StaleFencingTokenError`.
  Trigger DB `ra_jobs_fencing_guard` (SQLSTATE `P0110`) dodatkowo zabrania
  obniżenia tokenu bezpośrednim zapisem.

- **Per-case serialization + concurrency (kryt. 4).** `claim` bierze najpierw
  `pg_advisory_xact_lock(RA004)`, więc liczenie global/provider concurrency ORAZ
  sam claim są serializowane między workerami — dwaj workerzy nie mogą oba
  odczytać "jest miejsce" i oba przekroczyć limitu. Transakcja jest krótka (tylko
  claim, nigdy praca użytkownika). Sam claim pomija klucze z aktywnym jobem
  (`NOT EXISTS`), a twardym backstopem jest **partial UNIQUE index**
  `jobs_active_serialization_uidx` (co najwyżej jeden aktywny `LEASED`/`RECONCILING`
  job na `serialization_key`) — niezależny od logiki claim, wymuszony w DB.
- **Recovery bez auto-replay (kryt. 2).** `reapExpired` (pod tym samym advisory
  lockiem) inspekcjonuje trwałe intenty/completiony: job z intentem bez
  potwierdzonego completiona → `RECONCILING` (nigdy automatyczny replay,
  niecliamowalny); job bez niedokończonego intentu → bezpieczny powrót do
  `PENDING`.
- **Idempotentna rekonsyliacja (kryt. 6).** `reconcile` jest kluczowana 1:1 po
  intencie (`UNIQUE(intent_id)` w `job_reconciliations`): powtórna rekonsyliacja
  zwraca istniejące rozstrzygnięcie bez zmian. `CONFIRMED` → job `SUCCEEDED` +
  potwierdzający completion; `ABSENT` → bezpieczny powrót do `PENDING`;
  `UNRESOLVED` → pozostaje `RECONCILING`.
- **Retry/DLQ (kryt. 5).** `fail` stosuje `backoffDelayMs(n) = min(cap, base*2^(n-1))`
  (czysta, deterministyczna, bez jittera) do `max_attempts`, potem `DEAD_LETTER`
  z `dlq_reason`. Historia prób w append-only `job_attempts`. Ta sama semantyka w
  relayu outboxa.
- **Integralność redundantnych relacji.** `job_intents(job_id, case_id)` wiąże się
  composite-FK do `jobs(job_id, case_id)`; `job_completions`/`job_reconciliations`
  wiążą `(intent_id, job_id)` composite-FK do `job_intents` — wzorzec integralności
  RA-003, więc ledger nie może przypisać się do innego case/joba.

## Zmiany

| Ścieżka/moduł | Co zmieniono | Dlaczego |
|---|---|---|
| `packages/database/migrations/012_jobs_leases_retry.{up,down}.sql` | addytywna ewolucja `jobs`: `RECONCILING`, retry policy, provider, `serialization_key`, lease/heartbeat/DLQ kolumny, partial unique index aktywnej serializacji, composite `UNIQUE(job_id, case_id)`, trigger fencing `P0110` | leases, retry/DLQ, serializacja, fencing |
| `packages/database/migrations/013_job_attempts_reconciliation.{up,down}.sql` | append-only `job_attempts`, `job_intents`, `job_completions`, `job_reconciliations` z composite FK | attempt history, intent/completion, idempotentna rekonsyliacja |
| `packages/database/migrations/014_outbox_relay.{up,down}.sql` | addytywna ewolucja `outbox_dispatch`: `DEAD_LETTER`, lease + backoff + DLQ | durable relay outboxa |
| `packages/database/src/queue/runtime.ts` | `Clock`/`IdGenerator` porty (system/uuid + manual/sequential) | determinizm testów |
| `packages/database/src/queue/backoff.ts` | czysta funkcja bounded exponential backoff | kryt. 5 |
| `packages/database/src/queue/errors.ts` | `StaleFencingTokenError`, `AmbiguousSideEffectError` | typed queue errors |
| `packages/database/src/queue/outbox.ts` | `OutboxRepository`: enqueue-in-tx, relayOnce (claim+publish+retry/DLQ), DLQ views | outbox + relay |
| `packages/database/src/queue/job-store.ts` | `JobStore`: enqueue/claim/heartbeat/complete/fail/recordIntent/recordCompletion/reconcile/reapExpired + views | durable jobs core |
| `packages/database/src/queue/scheduler.ts` | `Scheduler.tick` (deterministyczny) + start/stop loop | interfejs scheduler/polling |
| `packages/database/src/queue/index.ts`, `packages/database/src/index.ts` | eksport queue (addytywny) | udostępnienie API |
| `packages/database/test/queue*.test.ts` | 24 testy (unit + integracja + concurrency/fault-injection) | required verification |

## Kryteria akceptacji

| Kryterium z taska | Status | Dowód (test) |
|---|---|---|
| 1. Commit stanu i outbox message atomowy | PASS | `queue`: "commits state and outbox message atomically"; `queue-concurrency`: "fault injection at COMMIT" |
| 2. Crash po intent przed completion bez auto-replay | PASS | `queue`: "holds a job with an unfinished intent…"; `queue-concurrency`: "fault injection at START" |
| 3. Wygasły worker nie zapisze po przejęciu lease | PASS | `queue`: "expired worker cannot complete after re-claim: stale fencing"; `queue-concurrency`: "fault injection at COMPLETE" + guard `P0110` |
| 4. Sekwencyjnie w case, równolegle między cases | PASS | `queue`: "serializes two jobs of one case…"; `queue-concurrency`: "two workers never double-claim", "two workers contending for one case", partial-unique backstop |
| 5. Bounded exponential backoff + obserwowalny DLQ | PASS | `queue`: "retries with bounded exponential backoff and ends in the DLQ"; `queue-runtime`: backoff unit |
| 6. Rekonsyliacja idempotentna i audytowalna | PASS | `queue`: "reconciliation is idempotent and auditable" |

## Required verification (task)

| Wymóg | Status | Dowód |
|---|---|---|
| Integration tests z dwoma workerami | PASS | `queue-concurrency`: "two workers never double-claim" (20 cases, realna równoległość), "two workers contending for one case" |
| Fault injection commit/publish/start/complete | PASS | `queue-concurrency`: 4 testy "fault injection at COMMIT/PUBLISH/START/COMPLETE" |
| Test lease expiry i stale fencing token | PASS | `queue`: "expired worker…stale fencing"; guard DB `P0110` |
| Test retry oraz DLQ | PASS | `queue`: "retries with bounded exponential backoff and ends in the DLQ"; outbox relay DLQ |

## Testy i kontrole

| Komenda/kontrola | Exit code | Wynik |
|---|---:|---|
| clean-room `pnpm run check` (Node 24.19.0, pnpm 10.26.1, realny PG `host.docker.internal:5433`) | 0 | 337/337; build 20/20; workflow OK |
| clean-room `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm run test` (Node 24.19.0) | 0 | 337/337 (18 plików) |
| `RA_PGPORT=5433 RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database` | 0 | 80/80 DB (queue 9+9, runtime 6, +RA-003 56) |
| `pnpm run lint` / `format` / `typecheck` / `build` / `workflow:validate` | 0 | PASS; workflow 26 tasks |
| migracje up/down/up na czystej bazie (runner) | 0 | applied 14 / reverted 14 / applied 14 |
| fail-closed brak PG (`RA_PGPORT=65432 RA_REQUIRE_POSTGRES=1`) | ≠0 | twardy fail (nie skip) |

Clean-room: świeża kopia working tree bez `.git`, `node_modules`, `dist`, `.turbo`,
`.pnpm-store`, `.remote-agent`, `.claude/settings.local.json`; Docker
`node:24.19.0-bookworm-slim`; pnpm 10.26.1 przez `corepack prepare`;
`PNPM_STORE_DIR=/tmp/pnpm-store`.

## Bezpieczeństwo i dane

- Sekrety: brak w kodzie, testach i handoffie. Payloady outboxa, deskryptory
  intentów i receipty completionów są jawnie oznaczone jako wymagające redakcji
  sekretów przez wywołującego (komentarze kontraktowe).
- Idempotencja/side effecty: każdy write po claimie warunkowany na aktualny lease
  (fencing); rekonsyliacja i completion idempotentne (`ON CONFLICT`/`UNIQUE`);
  relay outboxa at-least-once z dedupe po `outbox_id` u konsumenta.
- Recovery: niedokończony intent → `RECONCILING`, nigdy automatyczny replay
  (Master Plan §6.2). AMBIGUOUS zatrzymuje automatyczne przetwarzanie.
- Izolacja scope: composite FK wiążą ledger do `(job_id, case_id)`/`(intent_id,
  job_id)` — wzorzec RA-003; żaden zaakceptowany constraint RA-003 nie osłabiony
  (migracje wyłącznie addytywne).
- Determinizm: `pg_advisory_xact_lock` serializuje counting+claim i reaping;
  clock/id wstrzykiwane.

## Znane ograniczenia i ryzyka

- Testy integracyjne wymagają PostgreSQL na 5433 (fail-closed z
  `RA_REQUIRE_POSTGRES=1`).
- Konkretny worker (Discord/provider) i AWS deployment są poza zakresem RA-004
  (dostarczone prymitywy + interfejs `Scheduler`). Produkcyjny loop `start/stop`
  jest cienką warstwą nad `setTimeout`; testowany jest deterministyczny `tick`.
- Backoff bez jittera (celowo, dla determinizmu); ewentualny jitter to warstwa
  schedulera w późniejszym tasku.
- Zmiany nie są zacommitowane (zgodnie z regułami — bez commita/pusha).

## Otwarte pytania

- Brak. Brak `Decision Request`.

## Stan dla następnego agenta

- Co jest gotowe: pełny zakres RA-004 + wszystkie kryteria akceptacji i required
  verification; 337/337 clean-room na Node 24.19.0 z realnym PG; migracje 14/14
  up/down/up; status `AWAITING_AUDIT`.
- Czego audyt powinien niezależnie zweryfikować: dwa workery bez double-claim,
  per-case serialization (w tym partial-unique backstop), stale fencing po expiry
  (`StaleFencingTokenError` + `P0110`), recovery intent→RECONCILING bez replay,
  idempotentna rekonsyliacja, retry/backoff/DLQ, atomowość outbox+state, oraz
  że migracje 012-014 są wyłącznie addytywne.
- Gdzie zacząć: `packages/database/src/queue/job-store.ts` (claim/fencing/recovery),
  `queue/outbox.ts` (relay), migracje `012-014`, testy `packages/database/test/queue*`.






