# RA-009 — Work units

## Metadata

- Task: `RA-009`
- Plan revision: `01`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `GPT-5.6 Luna / medium / IMPLEMENTER`
- Plan status: `DRAFT`; aktywacja po `RA-004`, `RA-006`, `RA-007`, `RA-008 DONE`
- Base commit/tree: ustala Sol przy aktywacji
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test`

## Global boundaries

- In scope: trwały Case Supervisor, scheduling ról, writer fencing i recovery.
- Out of scope: prawdziwe coding tools, Jira, GitLab i workspace implementation.
- Role names produktu pozostają model-neutralne; nie hardcoduj modeli workflow w runtime.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-009-WU-01` | `DRAFT` | role registry i wersjonowane prompt manifests | — |
| `RA-009-WU-02` | `BLOCKED` | czysta state machine Supervisora | WU-01 |
| `RA-009-WU-03` | `BLOCKED` | trwały work-unit/run repository | WU-02 |
| `RA-009-WU-04` | `BLOCKED` | mailbox, semaphores i fairness | WU-03 |
| `RA-009-WU-05` | `BLOCKED` | single-writer lease i fencing | WU-03 |
| `RA-009-WU-06` | `BLOCKED` | read-only parallel merge | WU-04, WU-05 |
| `RA-009-WU-07` | `BLOCKED` | budgets, pause, cancel i waiting resume | WU-04 |
| `RA-009-WU-08` | `BLOCKED` | restart/concurrency integration | WU-06, WU-07 |

## `RA-009-WU-01` — Role registry

- Result: registry wiąże semantic role z wersją promptu, modelem i tool manifestem.
- Allowed paths: `packages/agent-orchestrator/src/roles/registry.ts`,
  `roles/types.ts`, `roles/prompts.ts`, `test/role-registry.test.ts`, `src/index.ts`.
- Context pack: WorkUnit/AgentRole contracts, RA-009 scope, model-selection feedback.
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
- Allowed paths: `packages/database/src/repositories/work-unit.ts`,
  `repositories/index.ts`, `test/work-unit.integration.test.ts`,
  `packages/database/src/errors.ts`.
- Context pack: migrations agent_runs/jobs, WU-02, RA-004 lease APIs.
- Acceptance: dispatch/completion są idempotentne; stale completion nie mutuje
  nowszego runu; completed unit nie jest claimowany po restarcie.
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
  merged result; konflikt jest jawny, nie last-write-wins.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/parallel-merge.test.ts`.
- Out of scope: prawdziwe role/models.
- Sol gate: permutation test kolejności completion.

## `RA-009-WU-07` — Control and budgets

- Result: bounded iteration/fix budgets, pause, cancel i WAITING resume.
- Allowed paths: `src/supervisor/control.ts`, `supervisor/budget.ts`,
  `test/supervisor-control.test.ts`, `src/index.ts`.
- Context pack: WU-02/04, RA-008 decision resume, cancellation contracts.
- Acceptance: limit zapisuje trwały checkpoint; cancel nie dispatchuje nowej pracy;
  answer event tworzy nowy run, nie wznawia procesu.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/supervisor-control.test.ts`.
- Out of scope: external approval policy.
- Sol gate: bounded-loop test nie opiera się na wall-clock sleep.

## `RA-009-WU-08` — Recovery and concurrency proof

- Result: Supervisor odtwarza dwa cases po faultach bez replay completed units.
- Allowed paths: `src/supervisor/runtime.ts`, `test/orchestrator.integration.test.ts`,
  `test/orchestrator-recovery.integration.test.ts`, `test/fake-roles.ts`, `src/index.ts`.
- Context pack: wszystkie zaakceptowane RA-009 units i RA-007/008 public APIs.
- Acceptance: dwa cases równolegle w limitach; jeden writer per case; restart w
  każdym boundary nie duplikuje completion.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test/orchestrator.integration.test.ts packages/agent-orchestrator/test/orchestrator-recovery.integration.test.ts`.
- Out of scope: real coding tools.
- Sol gate: fault-injection matrix i reviewed prompt snapshots.

## Final task gate

Sol uruchamia full suite na realnym PostgreSQL, sprawdza fairness, fencing,
deterministyczny merge, bounded loops i recovery. Następnie tworzy handoff oraz
niezależny audyt RA-009.
