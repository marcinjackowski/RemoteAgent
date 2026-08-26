# RA-041 — WORK_UNITS

- Task: `RA-041` Workflow stages w istniejącym SupervisorRuntime
- Bazowy commit: `0328bcbbe598c4d12ac7dad283560bb9bf1f98a9`
- Status: `DONE`
- ADR: `ADR-0011`, `ADR-0013`

## Ustalenia projektowe

- `SupervisorRuntime` pozostaje jedynym driverem claim/start/stage/finalize. Nowe moduły mogą
  dostarczać czystą policy, structural fingerprint i port wykonania pojedynczego etapu, ale nie
  mogą mieć własnej kolejki ani publicznej metody uruchamiającej cały workflow.
- Engineering workflow dotyczy exact wcześniej claimed `IMPLEMENTER` unit/run. Creator claimuje
  unit w tej samej transakcji co enqueue writer job; payload niesie server-owned
  `{caseId, workUnitId, runId}`. Handler i runtime odrzucają brak/obcy binding przed writer
  authority lub modelem.
- Risk facts są strict i server-owned. Deterministyczne minimum pochodzi z RA-037; owner override
  może wyłącznie podnieść klasę i musi wskazywać exact checkpoint revision oraz trwałą decyzję.
- Runtime interpretuje `engineeringProcessGraphs`; model/adapter wykonuje najwyżej pojedynczy stage.
  Registry decyduje o roli, schema i wymaganych artefaktach. Fresh reviewer/design call nie dzieli
  sesji autora.
- RA-038 operation/event/artifact ledger jest jedynym stage journalem. Potwierdzony artifact po
  crashu jest odzyskiwany bez model call; STARTED bez potwierdzonego artifactu/completion kończy
  automatyczny przebieg jako `AMBIGUOUS`.
- Pytanie materializuje terminalny `WAITING_FOR_USER`. Odpowiedź kopiuje server-owned unit scope do
  nowego one-shot unit/run i enqueue job w jednej transakcji; payload/event wiąże `decisionId`,
  `parentRunId`, exact checkpoint revision i nowe identity. Stary model call nie jest wznawiany.
- Approval to deterministic disposition: required artifacts, exact revisions/digests, brak findings,
  owner/policy grant i evidence preconditions są sprawdzane poza modelem. Pole modelowe nie jest
  autoryzacją.
- No-progress/oscillation fingerprint obejmuje wyłącznie tree digest, design/slice revisions,
  failed gate IDs i unresolved finding IDs. Tekst summary/rationale nie bierze udziału.
- Job lease i workflow deadline są rozłączne: heartbeat odnawia lease przez cały model call, a
  deadline jest liczony raz od trwałego `agent_runs.created_at`, więc restart go nie przesuwa.
- Stage calls i rzeczywiste model completions są liczone osobno. Po restarcie stage count pochodzi
  z immutable artifacts, a structured artifacts obciążają model budget konserwatywnym maksimum
  initial+repair; nie powstaje drugi usage journal.
- Rozszerzony decision resume dotyczy wyłącznie `IMPLEMENTER`. Pozostałe role zachowują strict
  czteropolowy `case.resume`; owner authorization z causal writer lease jest ponownie weryfikowana
  wobec exact durable answer w PostgreSQL.

## WU-00 — Exact claimed-run target i causality odpowiedzi

**Status:** DONE

**Rezultat:** transaction-scoped claim pozwala creatorom atomowo utworzyć unit, PLANNED run i job.
Writer job niesie exact binding, a odpowiedź na decyzję tworzy nowy claimed run z parent/decision/
revision causality. `SupervisorRuntime` może zostać ograniczony do jednego server-owned targetu.

**Allowed paths:**

- `packages/database/src/repositories/work-unit.ts`
- `packages/database/src/repositories/implementer-work.ts`
- `packages/database/src/repositories/decision-resume.ts`
- `packages/database/test/work-unit.integration.test.ts`
- `packages/database/test/implementer-work.integration.test.ts`
- `packages/database/test/decision-resume.integration.test.ts`
- `packages/database/test/checkpoint-recovery.integration.test.ts`
- `packages/agent-orchestrator/src/supervisor/runtime.ts`
- `packages/agent-orchestrator/src/supervisor/writer-lease.ts`
- `packages/agent-orchestrator/test/orchestrator.integration.test.ts`
- `packages/agent-orchestrator/test/orchestrator-recovery.integration.test.ts`
- `apps/agent-worker/src/handlers.ts`
- `apps/agent-worker/test/handlers.integration.test.ts`
- ten plik

**Weryfikacja:**

```bash
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/work-unit.integration.test.ts packages/database/test/implementer-work.integration.test.ts packages/database/test/decision-resume.integration.test.ts packages/database/test/checkpoint-recovery.integration.test.ts packages/agent-orchestrator/test/orchestrator.integration.test.ts packages/agent-orchestrator/test/orchestrator-recovery.integration.test.ts apps/agent-worker/test/handlers.integration.test.ts
```

**Wymagane mutacje:** wyłączenie exact run target albo atomowego rollbacku claim+enqueue daje RED;
usunięcie parent/decision/revision binding z resumed job daje RED.

**Evidence (2026-08-26):** finalna bramka WU po restore: exit `0`, `7` plików i `60/60`
testów; build oraz typecheck `database`, `agent-orchestrator`, `agent-worker` i `git diff --check`
exit `0`. Mutacja exact `runId`: exit `1`, `1` failed/`14` skipped (unclaimed target dotarł do
modelu). Mutacja usunięcia transaction-scoped preclaimu: exit `1`, `1` failed/`4` skipped
(`PENDING`/brak `run_id`). Mutacja usunięcia `parentRunId`: exit `1`, `1` failed/`21` skipped.
Każda mutacja została przywrócona przed finalnym GREEN.

## WU-01 — Czysta policy etapów, approval i structural progress

**Status:** DONE

**Rezultat:** runtime-owned plan dla trzech process classes, strict owner escalation, deterministic
disposition i structural no-progress/oscillation/deadline/cancellation limits bez porównywania prozy.

**Allowed paths:**

- `packages/agent-orchestrator/src/engineering/workflow.ts`
- `packages/agent-orchestrator/src/engineering/registry.ts`
- `packages/agent-orchestrator/src/supervisor/runtime.ts`
- `packages/agent-orchestrator/src/index.ts`
- `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
- `packages/agent-orchestrator/test/engineering-registry.test.ts`
- ten plik

**Weryfikacja:**

```bash
pnpm exec vitest run packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts packages/agent-orchestrator/test/engineering-registry.test.ts && pnpm --filter @remoteagent/agent-orchestrator typecheck
```

**Wymagane mutacje:** downgrade klasy, model-only approval albo dołączenie prozy do fingerprintu daje
RED; restore kończy GREEN.

**Evidence (2026-08-26):** finalna bramka WU: exit `0`, `2` pliki i `10/10` testów;
`agent-orchestrator` typecheck, scoped ESLint, Prettier i `git diff --check` exit `0` (wyłącznie
istniejące warnings konfiguracji boundaries). Mutacja usuwająca minimum risk-class: exit `1`, `1`
failed/`4` skipped. Mutacja uznająca modelowe `APPROVE` bez authorization: exit `1`, `1` failed/`4`
skipped. Mutacja włączająca narrative do fingerprintu: exit `1`, `1` failed/`4` skipped. Każda
przywrócona; finalnie `10/10` GREEN.

## WU-02 — Runtime-owned staged driver i recovery na durable port

**Status:** DONE

**Rezultat:** `SupervisorRuntime` sam przechodzi stage graph, pyta port wyłącznie o fresh context,
pojedynczy stage call i trwały receipt/artifact. Happy paths SMALL/MEDIUM/LARGE, crash recovery,
question, terminal reasons i call/deadline limits działają na fake durable port bez workspace write.

**Allowed paths:**

- `packages/agent-orchestrator/src/engineering/workflow.ts`
- `packages/agent-orchestrator/src/supervisor/runtime.ts`
- `packages/agent-orchestrator/src/index.ts`
- `packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts`
- `packages/agent-orchestrator/test/orchestrator-recovery.integration.test.ts`
- ten plik

**Weryfikacja:**

```bash
pnpm exec vitest run packages/agent-orchestrator/test/engineering-workflow-runtime.test.ts packages/agent-orchestrator/test/orchestrator-recovery.integration.test.ts && pnpm --filter @remoteagent/agent-orchestrator typecheck
```

**Wymagane mutacje:** replay modelu mimo potwierdzonego artifactu oraz przejście STARTED/no artifact
do retry/completed daje RED.

**Evidence (2026-08-26):** finalna bramka WU: exit `0`, `2` pliki i `19/19` testów;
`agent-orchestrator` typecheck, scoped ESLint i `git diff --check` exit `0` (tylko istniejące warnings
boundaries). Happy paths wszystkich klas, deterministic approval, question, pięć terminal reasons i
recovery działają przez jeden `SupervisorRuntime`. Mutacja replayu stage z potwierdzonym artefaktem:
exit `1`, `1` failed/`11` skipped. Mutacja kontynuacji po `STARTED` bez receipt/artifact: exit `1`,
`1` failed/`11` skipped. Obie przywrócone; finalnie `19/19` GREEN.

## WU-03 — PostgreSQL/Bedrock/context adapter i worker composition

**Status:** DONE

**Rezultat:** app adapter wiąże pojedynczy stage z RA-038 ledgerem, RA-039 schema-owned Bedrock i
RA-040 context compilerem; worker przekazuje exact leased target do jedynego `SupervisorRuntime`.
Architecture test dowodzi braku alternatywnego drivera i legacy reply-loop pozostaje zgodny.

**Allowed paths:**

- `packages/database/src/repositories/engineering-control-plane.ts`
- `packages/database/src/repositories/engineering-context.ts`
- `packages/database/src/repositories/index.ts`
- `packages/database/test/engineering-control-plane.integration.test.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/src/context.ts`
- `apps/agent-worker/src/handlers.ts`
- `apps/agent-worker/src/worker.ts`
- `apps/agent-worker/src/roles.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `apps/agent-worker/test/handlers.integration.test.ts`
- `apps/agent-worker/test/role-context.test.ts`
- `test/guardrails/guardrails.test.ts`
- ten plik

**Weryfikacja:**

```bash
RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/database/test/engineering-control-plane.integration.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts apps/agent-worker/test/handlers.integration.test.ts apps/agent-worker/test/role-context.test.ts test/guardrails/guardrails.test.ts
```

**Wymagane mutacje:** ominięcie RA-038 intent/STARTED/artifact boundary albo produkcyjnego
`SupervisorRuntime` daje RED; restore kończy GREEN.

**Evidence (2026-08-26):** finalna bramka WU: exit `0`, `5` plików i `59/59` testów z
`RA_REQUIRE_POSTGRES=1`; build/typecheck `database`, `agent-orchestrator`, `agent-worker`, scoped
ESLint/Prettier i `git diff --check` exit `0` (tylko istniejące warnings boundaries). Real-PG worker
zapisał dla `7` etapów exact `INTENT_BOUND → STARTED → ARTIFACT_RECORDED →
COMPLETION_OBSERVED`; drugi port odzyskał potwierdzony artifact bez context/executor call. Bedrock
stage użył schema-owned structured contract. Mutacja usuwająca `commitOperationStarted`: exit `1`,
`1` failed/`2` skipped (`0` zamiast `7` STARTED). Mutacja odpinająca engineering port od
produkcyjnego `SupervisorRuntime`: exit `1`, `1` failed/`2` skipped (unresolved ambiguous writer).
Obie przywrócone; finalnie `59/59` GREEN.

## WU-04 — Adversarial integration, telemetry i pełna bramka

**Status:** DONE

**Rezultat:** realny worker/PG dowodzi exact writer identity, owner escalation/approval, question
causality, recovery i wszystkich terminal reasons. Telemetry zawiera tylko bounded correlation IDs;
pełna bramka taska jest niecache'owana i zielona.

**Allowed paths:**

- ścieżki testowe WU-00..03
- `packages/observability/src/metrics.ts`
- `packages/observability/test/context-metrics.test.ts`
- `apps/agent-worker/src/engineering-workflow.ts`
- `apps/agent-worker/test/engineering-workflow.integration.test.ts`
- `test/security/canary.test.ts`
- `docs/tasks/RA-041.md`
- ten plik

**Weryfikacja:**

```bash
. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm build --force && RA_REQUIRE_POSTGRES=1 pnpm test && pnpm typecheck --force && pnpm workflow:validate && git diff --check
```

Po pełnej bramce: odczyt pełnego diffu, audyt według `AUDIT_CHECKLIST`, handoff, statusy,
`workflow:validate`, logiczne commity i czyste drzewo; następnie automatyczne przejście dalej.

**Evidence (2026-08-26):** finalna skorygowana pełna bramka po restore: exit `0`; lint/format exit
`0`; forced build `26/26`, `0` cached; real-PG/full test `203` pliki, `2608/2608`; forced
typecheck `38/38`, `0` cached; `workflow:validate` `OK — 45 tasks`; `git diff --check` exit `0`.
Real-PG adversarial
coverage obejmuje exact writer binding, 7-stage SMALL ledger, artifact recovery bez replayu i
owner escalation/approval związane z exact answered decision/revision. Telemetry ma wyłącznie
bounded `kind/outcome`, bez case/owner/run/unit/content. Mutacja pomijająca durable owner decision:
exit `1`, `1` failed/`3` skipped. Mutacja `caseId` w metric label: exit `1`, `1` failed/`3`
skipped. Audyt dodał mutation RED dla: wyłączenia heartbeat podczas in-flight modelu, zastąpienia
actual `modelCalls` stałą, resetu deadline od `Date.now()`, pominięcia gates/evidence re-check,
poszerzenia causal payloadu na non-writer role oraz odpięcia owner authorization od production
composition. Każda mutacja została przywrócona przed finalnym GREEN. Pierwsza ponowiona pełna
bramka ujawniła wadliwy test stub (brak nowego `modelCalls`), nie flake; po zawężonej korekcie pełna
bramka została uruchomiona od początku i zakończyła `2608/2608`.
