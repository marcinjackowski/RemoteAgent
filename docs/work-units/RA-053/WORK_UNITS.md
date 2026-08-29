# RA-053 — work units

Baseline: `3af95886ff23a0fac344508486212e8a2d051a82`.

Live Codex, Claude, Bedrock and OpenCode model calls remain disabled unless the
owner separately enables the opt-in live test. The default qualification uses
deterministic local transports, real PostgreSQL and throwaway Git repositories.
It never reads subscription credential storage and never accepts API keys.

## WU-00 — deterministic provider qualification and report

- Status: `DONE`
- Result: all four IMPLEMENTER/REVIEWER Codex/Claude combinations run the same
  bounded scenario through the production Engineering composition and emit a
  strict content-free comparison report with exact route identity, attempts,
  usage, changed paths, diff digest and commit SHA.
- Allowed paths:
  - `apps/agent-worker/src/engineering-qualification.ts`
  - `apps/agent-worker/src/index.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-provider-qualification.integration.test.ts`
  - `apps/agent-worker/test/engineering-role-routing.integration.test.ts`
  - `docs/work-units/RA-053/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/engineering-provider-qualification.integration.test.ts apps/agent-worker/test/engineering-role-routing.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-worker`
- Evidence: exact command plus `git diff --check` exited `0`; build passed,
  real-PostgreSQL Vitest passed `8/8` tests in `2/2` files and forced
  typecheck ran `18/18` tasks with `0` cached. The four runs shared one
  content-free scenario digest, objective, gate and exact diff while covering
  Codex/Codex, Codex/Claude, Claude/Codex and Claude/Claude for
  IMPLEMENTER/REVIEWER. Every run produced three fresh review decisions after
  one correction and one local commit. Removing exact usage-to-invocation
  comparison made the identity rejection test exit `1`; disconnecting the
  REVIEWER route collapsed the mixed combinations and made the full matrix
  exit `1`. Both mutations were restored before the final GREEN run.

## WU-01 — isolated subscription live opt-in

- Status: `DONE`
- Depends on: `WU-00`
- Result: the disabled-by-default iOS live runner requires an explicit
  subscription route, fresh worktree and fresh journal; it uses the exact
  production role registry and cannot call Bedrock/OpenCode, push or external
  integrations.
- Allowed paths:
  - `apps/agent-worker/src/engineering-live-qualification.ts`
  - `apps/agent-worker/src/index.ts`
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `apps/agent-worker/test/engineering-live-qualification.test.ts`
  - `docs/work-units/RA-053/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-worker build && pnpm exec vitest run apps/agent-worker/test/engineering-live-qualification.test.ts apps/agent-worker/test/engineering-live-ios.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-worker`
- Evidence: exact command plus `git diff --check` exited `0`; build passed,
  `3/3` non-live tests passed, the single live iOS test remained explicitly
  skipped and forced typecheck ran `18/18` tasks with `0` cached. The live
  boundary now requires a unique invocation ID and explicit IMPLEMENTER and
  REVIEWER profile names matching the authenticated production registry. Its
  journal uses exclusive creation and a second run with the same identity is
  refused; the result records only route digests and declares external writes
  forbidden. Disabling the reviewer-profile comparison made the focused test
  exit `1`; it was restored before the final GREEN run. No provider CLI was
  invoked.

## WU-02 — Bedrock retirement from Engineering

- Status: `DONE`
- Depends on: `WU-01`
- Result: Engineering production and tests contain no Bedrock construction,
  imports, aliases, defaults or env influence; the remaining Bedrock dependency
  is owned by an explicitly named legacy conversation composition outside the
  Engineering boundary, while OpenCode remains schema-invalid.
- Allowed paths:
  - `apps/agent-worker/src/legacy-conversation-model.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/src/roles.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/index.ts`
  - `apps/agent-worker/test/worker.test.ts`
  - `apps/agent-worker/test/role-context.test.ts`
  - `apps/agent-worker/test/engineering-model-routing.test.ts`
  - `apps/agent-worker/test/engineering-debug-journal.test.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `apps/agent-worker/test/engineering-role-routing.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-adversarial.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-boundaries.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-recovery.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-risk.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-recovery.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/vertical-slice-e2e.integration.test.ts`
  - `apps/agent-worker/test/engineering-live-ios.integration.test.ts`
  - `docs/work-units/RA-053/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/worker.test.ts apps/agent-worker/test/role-context.test.ts apps/agent-worker/test/engineering-model-routing.test.ts apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts apps/agent-worker/test/engineering-cross-fence-recovery.integration.test.ts apps/agent-worker/test/engineering-cross-fence-coordinator.integration.test.ts apps/agent-worker/test/vertical-slice-e2e.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-worker`
- Evidence: exact command plus `git diff --check` exited `0`; build passed,
  real-PostgreSQL Vitest passed `34/34` tests in `7/7` files and forced
  typecheck ran `18/18` tasks with `0` cached. Bedrock construction and all
  legacy env/default resolution now live only in
  `legacy-conversation-model.ts`, whose owner is
  `CONVERSATION_REPLY_LOOP`; `worker.ts`, roles and every production
  Engineering module contain no Bedrock/OpenCode import or identifier.
  Engineering tests use provider-neutral runtime exports and the historical
  `createBedrock*` aliases were removed. RED mutations proved that stale
  `BEDROCK_MODEL_ID` cannot override the subscription config, the legacy
  conversation binding cannot become an Engineering fallback, and a Bedrock
  reference in the production Engineering boundary is detected. An OpenCode
  enum mutation was rebuilt before testing (to avoid stale `dist`) and made the
  strict deployment-schema test exit `1`; the source and package build were
  restored before final GREEN.

## WU-03 — mutation audit and M10 gate

- Status: `DONE`
- Depends on: `WU-02`
- Result: route disconnect, hidden fallback, stale Bedrock env influence,
  OpenCode acceptance, unsafe live-root reuse and report identity loss all have
  recorded RED-to-GREEN mutations; the full noncached gate and M10 audit pass.
- Allowed paths:
  - all paths owned by `WU-00` through `WU-02`
  - `docs/tasks/RA-053.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-053/AUDIT-01.md`
  - `docs/handoffs/RA-053/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/work-units/RA-053/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Evidence: po przywróceniu wszystkich mutacji pełna komenda zakończyła się
  exit `0`: lint i format `0`, wymuszony build `29/29` z `0 cached`, real-PG
  Vitest `3064/3064` w `244/244` plikach oraz jeden live iOS test jawnie
  pominięty, wymuszony typecheck `46/46` z `0 cached`,
  `workflow:validate OK — 53 tasks` i `git diff --check` `0`. Pierwsze dwa
  podejścia ujawniły wyłącznie task-owned lint/format, a pierwszy pełny przebieg
  testów przekroczył poprzedni 120-sekundowy limit pojedynczego czterokrotnego
  real-PG scenariusza przy obciążeniu całej suite (`124.7s`; solo `53.3s`).
  Jawny limit testu podniesiono do `240s`; powtórzona pełna suite wykonała ten
  scenariusz w `117.7s` i zakończyła się GREEN. Nie był to produktowy timeout
  ani live provider call.
- Mutation evidence: route REVIEWER odłączona od exact registry — RED; hidden
  conversation fallback — RED; `BEDROCK_MODEL_ID` włączony do rozwiązywania
  Engineering route — RED; OpenCode dodany do zamkniętego enumu (po wymaganym
  rebuildzie pakietu) — RED; ponowne użycie tego samego live journal root — RED;
  brak reviewer-profile match — RED; usage oderwane od invocation descriptor —
  RED; usunięta weryfikacja `report_digest` — RED; Bedrock identifier
  przywrócony do produkcyjnej granicy Engineering — RED. Wszystkie mutacje
  przywrócono przed końcową bramką. Pierwszy OpenCode run na starym `dist` był
  GREEN i został jawnie odrzucony jako niedowód.

## Durable decisions

- The deterministic matrix qualifies routing and workflow behavior, not vendor
  quality. Provider quality comparisons require a separately enabled live run.
- Qualification identity is the exact subscription invocation descriptor and
  its digest. Provider/model labels alone are insufficient.
- Every live run receives a new invocation ID, worktree and journal root. A
  previous run directory is never resumed implicitly.
- Bedrock may temporarily remain for legacy conversational replies only. That
  ownership must be explicit and cannot be reachable from any Engineering
  route, test helper or fallback.
- OpenCode and API-token profiles are not compatibility options; they remain
  rejected by the strict subscription deployment schema.
