# RA-008 — Work units

## Metadata

- Task: `RA-008`
- Plan revision: `01`
- Plan owner: `Sol / COORDINATOR_AUDITOR`
- Implementer: `Qwen3.8-27B-oQ6e-mtp / LOCAL_IMPLEMENTER`
- Plan status: `DRAFT`; aktywacja dopiero po `RA-007 DONE`
- Base commit/tree: ustala Sol przy aktywacji
- Full-task verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test packages/database/test`

## Global boundaries

- In scope: checkpoint/context/decision services w `agent-orchestrator`, konieczne
  repozytoria database i projekcja statusu Discord.
- Out of scope: role scheduler z RA-009 i coding workspace.
- Sol przed aktywacją aktualizuje ścieżki po rzeczywistym API RA-007.

## Unit index

| Unit | Status | Result | Depends on |
|---|---|---|---|
| `RA-008-WU-01` | `DRAFT` | trwałe repozytorium decyzji i odpowiedzi | — |
| `RA-008-WU-02` | `BLOCKED` | deterministyczny context builder i provenance | WU-01 |
| `RA-008-WU-03` | `BLOCKED` | czysta aplikacja checkpoint patch | WU-02 |
| `RA-008-WU-04` | `BLOCKED` | atomic completion apply | WU-03 |
| `RA-008-WU-05` | `BLOCKED` | waiting/answer binding i stale rejection | WU-01, WU-04 |
| `RA-008-WU-06` | `BLOCKED` | Markdown/pinned-status projection | WU-03 |
| `RA-008-WU-07` | `BLOCKED` | bounded compaction bez utraty decyzji | WU-02, WU-03 |
| `RA-008-WU-08` | `BLOCKED` | crash recovery i end-to-end resume | WU-04, WU-05, WU-06, WU-07 |

## `RA-008-WU-01` — Decision repository

- Result: typed repository zapisuje request i jedną związaną odpowiedź.
- Allowed paths: `packages/database/src/repositories/decision.ts`,
  `repositories/index.ts`, `test/decision.integration.test.ts`,
  `packages/database/src/errors.ts`.
- Context pack: `decision.ts` contract, migracje `005`/`010`, repository patterns.
- Acceptance: request jest append-only; replay identycznej odpowiedzi jest
  idempotentny; obcy case/revision/option jest odrzucony.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/decision.integration.test.ts`.
- Out of scope: checkpoint apply i Discord.
- Sol gate: realny PostgreSQL oraz cross-case negative test.

## `RA-008-WU-02` — Context builder

- Result: czysty builder wybiera materiały według budżetu, priorytetu i scope.
- Allowed paths: `packages/agent-orchestrator/src/context/types.ts`,
  `context/builder.ts`, `context/budget.ts`, `test/context-builder.test.ts`,
  `src/index.ts`.
- Context pack: RA-008 scope, checkpoint/event/entity/tool contracts, scope guards.
- Acceptance: deterministyczny wybór; każdy fragment ma provenance i trust;
  brak entities/connections spoza authoritative scope.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/context-builder.test.ts`.
- Out of scope: persistence i model invocation.
- Sol gate: golden order przy granicznych budżetach i cross-account fixtures.

## `RA-008-WU-03` — Checkpoint patch application

- Result: czysta funkcja tworzy następną pełną rewizję z validated patch.
- Allowed paths: `packages/agent-orchestrator/src/checkpoint/apply-patch.ts`,
  `checkpoint/errors.ts`, `test/checkpoint-patch.test.ts`, `src/index.ts`.
- Context pack: `checkpoint.ts`, `agent-completion.ts`, WU-02 provenance rules.
- Acceptance: niezmienne pola nie są nadpisywane; append nie gubi historii;
  revision pochodzi od systemu, nie od modelu.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/checkpoint-patch.test.ts`.
- Out of scope: transakcja DB i compaction.
- Sol gate: property tests dla zachowania decisions/evidence.

## `RA-008-WU-04` — Atomic completion apply

- Result: jedna transakcja zapisuje completion, checkpoint revision, run state i outbox.
- Allowed paths: `packages/database/src/repositories/run-completion.ts`,
  `repositories/index.ts`, `test/completion-apply.integration.test.ts`,
  `packages/agent-orchestrator/src/checkpoint/apply-completion.ts`,
  `packages/agent-orchestrator/src/index.ts`.
- Context pack: checkpoint repository, transaction API, outbox, WU-03.
- Acceptance: crash przed commit nic nie publikuje; commit zapisuje komplet;
  konkurencyjna revision failuje bez partial state.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/completion-apply.integration.test.ts`.
- Out of scope: answer handling i rendering.
- Sol gate: fault injection po każdym zapisie w transakcji.

## `RA-008-WU-05` — Waiting and answer resume

- Result: `WAITING_FOR_USER` zwalnia run/lease, a ważna odpowiedź tworzy nowy resume intent.
- Allowed paths: `packages/agent-orchestrator/src/decisions/service.ts`,
  `decisions/errors.ts`, `test/decisions.test.ts`,
  `packages/database/test/decision-resume.integration.test.ts`, `src/index.ts`.
- Context pack: WU-01/WU-04, DecisionRequest contracts, queue/outbox APIs.
- Acceptance: stale/foreign answer odrzucony; replay nie tworzy drugiego resume;
  waiting nie utrzymuje aktywnego lease.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/database/test/decision-resume.integration.test.ts`.
- Out of scope: Discord interaction parsing z RA-006.
- Sol gate: receipt/idempotency test dla podwójnej odpowiedzi.

## `RA-008-WU-06` — Checkpoint projections

- Result: deterministyczny Markdown i pinned status są read-only projections JSON.
- Allowed paths: `packages/agent-orchestrator/src/checkpoint/render.ts`,
  `test/checkpoint-render.test.ts`, `packages/discord/src/status.ts`,
  `packages/discord/test/status.test.ts`, `src/index.ts`.
- Context pack: CaseCheckpoint, RA-006 status gateway, WU-03 output.
- Acceptance: renderer nie mutuje checkpointu; output jest bounded/redacted;
  starsza projekcja nie nadpisuje nowszej.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/checkpoint-render.test.ts packages/discord/test/status.test.ts`.
- Out of scope: Discord gateway lifecycle.
- Sol gate: snapshot diff reviewed manualnie.

## `RA-008-WU-07` — Safe compaction

- Result: derived summary redukuje kontekst bez usuwania decyzji i provenance.
- Allowed paths: `packages/agent-orchestrator/src/context/compaction.ts`,
  `context/builder.ts`, `test/compaction.test.ts`, `src/index.ts`.
- Context pack: WU-02/WU-03, checkpoint required fields, trust contracts.
- Acceptance: decisions/open questions/receipts pozostają verbatim refs;
  compaction jest odtwarzalna; utrata derived data nie uszkadza source of truth.
- Verification: `pnpm vitest run packages/agent-orchestrator/test/compaction.test.ts`.
- Out of scope: wywołanie modelu do semantycznego summary bez osobnej decyzji Sol.
- Sol gate: adversarial test, który nie pozwala zgubić DecisionRequest.

## `RA-008-WU-08` — Recovery and resume integration

- Result: nowy proces odtwarza context/checkpoint/decision po crashu model call.
- Allowed paths: `packages/agent-orchestrator/src/recovery.ts`,
  `test/recovery.integration.test.ts`, `packages/database/test/checkpoint-recovery.integration.test.ts`,
  `src/index.ts`.
- Context pack: zaakceptowane RA-008 units, RA-004 reconciliation, RA-007 call result.
- Acceptance: intent bez completion jest reconciled, nie replayed w ciemno;
  materialne decyzje wracają bez starej sesji; status jest jednoznaczny.
- Verification: `RA_REQUIRE_POSTGRES=1 pnpm vitest run packages/agent-orchestrator/test/recovery.integration.test.ts packages/database/test/checkpoint-recovery.integration.test.ts`.
- Out of scope: multi-role scheduling.
- Sol gate: pełne crash-before/after matrix.

## Final task gate

Sol uruchamia pełną macierz real-PG, sprawdza optimistic concurrency, provenance,
cross-scope isolation i wznowienie bez poprzedniej sesji. Następnie tworzy handoff
i niezależny audyt RA-008.
