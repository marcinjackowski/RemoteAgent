# RA-009 — Work units

## Metadata

- Task: `RA-009`
- Plan revision: `18`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `ACTIVE`
- Base commit/tree: `55b1041a78d08d7f73867ffcb0875c90aab8efbc`
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test`

## Global boundaries

- In scope: trwały Case Supervisor, scheduling ról, writer fencing i recovery.
- Out of scope: prawdziwe coding tools, Jira, GitLab i workspace implementation.
- Role names produktu pozostają model-neutralne; nie hardcoduj modeli workflow w runtime.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-009-WU-01` | `ACCEPTED` | role registry i wersjonowane prompt manifests | — |
| `RA-009-WU-02` | `ACCEPTED` | czysta state machine Supervisora | WU-01 |
| `RA-009-WU-03` | `ACCEPTED` | trwały work-unit/run repository | WU-02 |
| `RA-009-WU-04` | `ACCEPTED` | mailbox, semaphores i fairness | WU-03 |
| `RA-009-WU-05` | `ACCEPTED` | single-writer lease i fencing | WU-03 |
| `RA-009-WU-06` | `ACCEPTED` | read-only parallel merge | WU-04, WU-05 |
| `RA-009-WU-07` | `ACCEPTED` | budgets, pause, cancel i waiting resume | WU-04 |
| `RA-009-WU-08` | `ACCEPTED` | restart/concurrency integration | WU-06, WU-07 |

## `RA-009-WU-01` — Role registry

- Result: registry wiąże semantic role z wersją promptu, modelem i tool manifestem.
- Allowed paths: `packages/agent-orchestrator/src/roles/registry.ts`,
  `roles/types.ts`, `roles/prompts.ts`, `test/role-registry.test.ts`, `src/index.ts`.
- Context pack: `docs/tasks/RA-009.md`,
  `packages/contracts/src/{work-unit,agent-run,agent-completion,tool}.ts`, ADR-0004
  wyłącznie jako rozdzielenie procesu budowy od model-neutralnego runtime.
- Acceptance: role i model identity są rozdzielone; unknown version failuje;
  implementer jest jedyną rolą write-enabled.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/role-registry.test.ts`.
- Out of scope: dispatch i wywołanie modelu.
- Sol gate: snapshot manifestów nie zawiera runtime secrets ani scope z promptu.

## `RA-009-WU-02` — Supervisor state machine

- Result: czysta state machine wybiera legalny następny work unit/status.
- Allowed paths: `src/supervisor/state.ts`, `supervisor/machine.ts`,
  `supervisor/errors.ts`, `test/supervisor-machine.test.ts`, `src/index.ts`.
- Context pack: RA-008 checkpoint/completion, WorkUnit state machine, WU-01.
- Acceptance: nielegalne przejścia odrzucone; completed unit nie wraca do kolejki;
  WAITING kończy run.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/supervisor-machine.test.ts`.
- Out of scope: DB i concurrency primitives.
- Sol gate: exhaustive transition matrix.

## `RA-009-WU-03` — Durable work-unit repository

- Result: repository claimuje i finalizuje work units z trwałym run identity.
- Allowed paths: `packages/database/migrations/023_work_units.{up,down}.sql`,
  `packages/database/src/repositories/work-unit.ts`, `repositories/index.ts`,
  `packages/database/src/index.ts`, `test/work-unit.integration.test.ts`,
  `packages/database/src/errors.ts`.
- Context pack: migrations agent_runs/jobs, WU-02, RA-004 lease APIs.
- Acceptance: `work_units` jest trwałym źródłem prawdy zgodnym z kontraktem;
  claim atomowo wiąże dokładnie jeden nowy `agent_run` w stanie `PLANNED`;
  dispatch/completion są idempotentne; stale completion nie mutuje nowszego runu;
  completed unit nie jest claimowany po restarcie.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/work-unit.integration.test.ts`.
- Out of scope: scheduler fairness.
- Sol gate: concurrent claim test na realnym PostgreSQL.

## `RA-009-WU-04` — Mailbox and fairness

- Result: per-case mailbox i global/provider semaphores wybierają pracę fair.
- Allowed paths: `src/scheduler/mailbox.ts`, `scheduler/semaphore.ts`,
  `scheduler/fairness.ts`, `test/scheduler.test.ts`, `src/index.ts`.
- Context pack: WU-02/03, RA-004 durable queue semantics.
- Acceptance: dwa cases robią postęp; limity global/provider nie są przekraczane;
  jeden gorący case nie głodzi drugiego.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/scheduler.test.ts`.
- Out of scope: workspace writer lock.
- Sol gate: deterministic fake clock i co najmniej dwa cases.

## `RA-009-WU-05` — Single-writer fencing

- Result: implementer run wymaga aktualnego per-case writer lease/fencing tokenu.
- Allowed paths: `src/supervisor/writer-lease.ts`,
  `test/writer-lease.integration.test.ts`, `packages/database/src/queue/job-store.ts`,
  `packages/database/test/queue-concurrency.integration.test.ts`, `src/index.ts`.
- Context pack: RA-004 leases, WorkUnit scopes, WU-03.
- Acceptance: drugi writer nie startuje; stale token nie finalizuje pracy;
  read-only roles nie biorą writer lease.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test/writer-lease.integration.test.ts`.
- Out of scope: filesystem enforcement z RA-010.
- Sol gate: niezależna reprodukcja stale-writer race.

## `RA-009-WU-06` — Read-only parallel merge

- Result: read-only role results mogą powstać równolegle i są scalane deterministycznie.
- Allowed paths: `src/supervisor/parallel.ts`, `supervisor/merge.ts`,
  `test/parallel-merge.test.ts`, `src/index.ts`.
- Context pack: WU-01/04/05, AgentCompletion evidence/provenance.
- Acceptance: tylko read-only roles równolegle; order completion nie zmienia
  merged result; implementer i write-enabled scope są odrzucane przed startem;
  każde completion musi odpowiadać exact work-unit/run/case bindingowi; duplicate
  exact completion jest idempotentny, natomiast konflikt tego samego unit/run
  jest jawny, nie last-write-wins. Merge ma stabilny canonical order niezależny
  od kolejności zakończenia i zachowuje provenance/evidence bez kopiowania
  prywatnego chain-of-thought.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/parallel-merge.test.ts`.
- Out of scope: prawdziwe role/models.
- Sol gate: permutation test wszystkich kolejności completion oraz negative
  tests dla implementera, obcego run/case, conflicting duplicate i write scope.

## `RA-009-WU-07` — Control and budgets

- Result: bounded iteration/fix budgets, pause, cancel i WAITING resume.
- Allowed paths: `src/supervisor/control.ts`, `supervisor/budget.ts`,
  `test/supervisor-control.test.ts`, `src/index.ts`.
- Context pack: WU-02/04, RA-008 decision resume, cancellation contracts.
- Acceptance: limit zapisuje trwały checkpoint; cancel nie dispatchuje nowej pracy;
  answer event tworzy nowy run, nie wznawia procesu. Limity iteracji i fixów są
  dodatnimi integerami z server config i nie mogą być zwiększone przez completion
  ani prompt. Wyczerpanie zwraca dokładnie jedną idempotentną dyspozycję
  `CHECKPOINT_AND_STOP` z jawnym reason, case/run/revision bindingiem; controller
  nie deklaruje trwałości przed potwierdzeniem wstrzykniętego persistence portu.
  Pause i cancel są monotoniczne/sticky, blokują dispatch po wyścigu z completion,
  a cancel ma pierwszeństwo. `WAITING_FOR_USER` kończy źródłowy run i deleguje do
  zaakceptowanego RA-008 decision materialization; exact answer/revision tworzy
  dyspozycję nowego runu, duplicate jest idempotentny, stale/foreign answer jest
  odrzucony. Żaden model-controlled field nie jest authority dla tych decyzji.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/supervisor-control.test.ts`.
- Out of scope: external approval policy.
- Sol gate: boundary table dla iteration/fix off-by-one, race
  pause/cancel/completion, duplicate/stale answer i persistence failure; bounded
  loop nie opiera się na wall-clock sleep.

## `RA-009-WU-08` — Recovery and concurrency proof

- Result: Supervisor odtwarza dwa cases po faultach bez replay completed units.
- Allowed paths: `src/supervisor/runtime.ts`, `test/orchestrator.integration.test.ts`,
  `test/orchestrator-recovery.integration.test.ts`, `test/fake-roles.ts`, `src/index.ts`
  oraz, wyłącznie gdy brakuje publicznego zapytania potrzebnego do recovery,
  `packages/database/src/repositories/work-unit.ts` i `case-recovery.ts` wraz z
  ich istniejącymi testami.
- Context pack: wszystkie zaakceptowane RA-009 units i RA-007/008 public APIs.
- Acceptance: runtime jest bounded i model-neutralny, a trwałe repozytoria są
  źródłem prawdy; in-memory scheduler może być tylko odbudowywalnym cache. Dwa
  cases robią postęp równolegle bez przekroczenia limitu globalnego i limitów
  providera. Implementer zachowuje dokładnie jeden aktywny writer per case oraz
  zaakceptowany fencing token, podczas gdy Reviewer i Verification mogą działać
  równolegle jako read-only i są scalane deterministycznie. Restart odtwarza
  PENDING/DISPATCHED/RUNNING/terminal state z DB: potwierdzone completion nie
  wywołuje roli ponownie, a RUNNING bez potwierdzonego wyniku nie jest ślepo
  replayowane i kończy się jawnym stanem ambiguous/blocked. WAITING zamyka run,
  a odpowiedź użytkownika tworzy nowy run przez zaakceptowany mechanizm RA-008.
  Fake roles rejestrują dokładną liczbę wywołań i nie używają prawdziwych modeli.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test/orchestrator.integration.test.ts packages/agent-orchestrator/test/orchestrator-recovery.integration.test.ts`.
- Out of scope: real coding tools.
- Sol gate: real-PG fault-injection przed claimem, po claim/start oraz po trwałym
  completion przed lokalnym ack; restart nie duplikuje wywołania ani completion.
  Test obejmuje co najmniej dwa cases, global limit `2`, provider limits, writer
  fencing, read-only merge i liczniki fake roles. `pumpOnce`/odpowiednik jest
  deterministycznie bounded bez endless loop, sleep ani zależności od wall clock;
  reviewed prompt snapshots nie zawierają sekretów ani prywatnego chain-of-thought.

## Final task gate

Sol uruchamia full suite na realnym PostgreSQL, sprawdza fairness, fencing,
deterministyczny merge, bounded loops i recovery. Następnie tworzy handoff oraz
niezależny audyt RA-009.
