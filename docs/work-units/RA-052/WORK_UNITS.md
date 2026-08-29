# RA-052 — work units

Baseline: `2dac08ed7de7add60dee27d518e771fddda62139`.

Live Codex, Claude, Bedrock and OpenCode model calls remain disabled for the
whole task. Provider behavior is verified with injected subscription
preflights, deterministic fake clients and real PostgreSQL. RemoteAgent never
reads credential storage or accepts API keys. Official OpenAI documentation
confirms that `codex login` with ChatGPT is the subscription path; the separate
API-key login path remains forbidden by ADR-0016 and the existing adapters.

## WU-00 — strict role-routing deployment config

- Status: `DONE`
- Result: a versioned immutable deployment document maps every DESIGNER,
  IMPLEMENTER, REVIEWER and VERIFIER route to one existing named Codex/Claude
  profile; route resolution and invocation descriptors bind the complete config
  without a default or caller/model override.
- Allowed paths:
  - `packages/model-runtime/src/subscription.ts`
  - `packages/model-runtime/src/index.ts`
  - `packages/model-runtime/test/subscription.test.ts`
  - `docs/work-units/RA-052/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm exec vitest run packages/model-runtime/test/subscription.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-runtime`
- Evidence: exact command exit `0`; `12/12` tests passed, build passed,
  forced typecheck ran `2/2` tasks with `0` cached, and `git diff --check`
  passed. RED mutations proved that the suite detects an omitted required role,
  a route to a missing profile, a hidden first-profile fallback and bypassed
  invocation-route comparison; every mutation was restored before the final
  GREEN run. The initial RED run before implementation failed `7/12` tests on
  the v1/no-routes boundary.

## WU-01 — authenticated production role registry

- Status: `DONE`
- Depends on: `WU-00`
- Result: one code-owned registry resolves the four routes, proves the exact
  subscription client identity, constructs only the qualified Codex/Claude
  adapters and exposes role-specific transport/config/descriptors; missing auth,
  client or profile fails before Engineering composition with no fallback.
- Allowed paths:
  - `apps/agent-worker/package.json`
  - `apps/agent-worker/src/engineering-model-routing.ts`
  - `apps/agent-worker/src/index.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-model-routing.test.ts`
  - `apps/agent-worker/test/worker.test.ts`
  - `package.json`
  - `pnpm-lock.yaml`
  - `docs/work-units/RA-052/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && pnpm --filter @remoteagent/model-provider-claude-code build && pnpm --filter @remoteagent/agent-worker build && pnpm exec vitest run apps/agent-worker/test/engineering-model-routing.test.ts apps/agent-worker/test/worker.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-runtime --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-provider-claude-code --filter=@remoteagent/agent-worker`
- Evidence: exact command exit `0`; four builds passed, `10/10` tests
  passed, forced typecheck ran `21/21` tasks with `0` cached and diff-check
  passed. RED mutations proved refusal before partial transport construction,
  exact preflight provider/profile/model identity, immutable role recheck and no
  missing-config fallback. All were restored before the final GREEN run.

## WU-02 — role-aware stage execution and exact recovery

- Status: `DONE`
- Depends on: `WU-01`
- Result: production stage, implementation and review boundaries use only their
  server-selected role binding; the durable intent is checked on same-lease and
  cross-fence recovery, while config drift, client loss, role swap and quota/auth
  refusal block without replay or provider fallback.
- Allowed paths:
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-recovery.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts`
  - `apps/agent-worker/test/worker.test.ts`
  - `docs/work-units/RA-052/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-orchestrator build && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/engineering-execution.integration.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts apps/agent-worker/test/worker.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-orchestrator --filter=@remoteagent/agent-worker`
- Evidence: exact command exit `0`; both builds passed, `59/59` tests ran
  with required PostgreSQL, forced typecheck ran `19/19` tasks with `0`
  cached and diff-check passed. RED mutations proved the DESIGN_APPROVAL role,
  stage-specific durable config digest, cross-fence invocation equality and a
  fresh exact preflight before publishing a retry. All were restored before the
  final GREEN run.

## WU-03 — comparable usage journal and production matrix

- Status: `DONE`
- Depends on: `WU-02`
- Result: content-free usage events carry exact role/slice/attempt/invocation
  attribution, and a real-PG/fake-client production matrix proves provider
  combinations, two slices with correction/review, recovery, auth/quota loss,
  cancellation, stale lease and concurrent-case isolation.
- Allowed paths:
  - `apps/agent-worker/src/engineering-debug-journal.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-model-routing.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-debug-journal.test.ts`
  - `apps/agent-worker/test/engineering-qualification-fixture.ts`
  - `apps/agent-worker/test/engineering-role-routing.integration.test.ts`
  - `docs/work-units/RA-052/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/engineering-role-routing.integration.test.ts apps/agent-worker/test/engineering-qualification-control.integration.test.ts apps/agent-worker/test/engineering-cross-fence-stage.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-worker`
- Evidence: exact command plus `git diff --check` exit `0`; build passed,
  `26/26` tests passed with required PostgreSQL and forced typecheck ran
  `18/18` tasks with `0` cached. The matrix ran both Codex-to-Claude and
  Claude-to-Codex role combinations through two slices, one rejected review,
  correction, three fresh reviews and exactly one local commit; all-Codex and
  all-Claude route construction was also exact. Separate cases proved auth and
  quota refusal without fallback, stale-lease refusal, two concurrent isolated
  cases, immutable cancellation and cross-fence model/gate/commit recovery.
  Every provider response produced content-free usage attributed to exact
  role/slice/attempt/invocation. RED mutations removed journal role attribution,
  removed review slice/attempt scoping, added cross-provider runtime fallback
  and swapped `SLICE_REVIEW` to `DESIGNER`; each focused test exited `1`, and
  every mutation was restored before the final GREEN run.

## WU-04 — mutation audit and task gate

- Status: `DONE`
- Depends on: `WU-03`
- Result: every routing/recovery/journal authority mechanism has a recorded
  RED-to-GREEN mutation, the full noncached repository gate is green and the
  audit checks every acceptance criterion before closure.
- Allowed paths:
  - all paths owned by `WU-00` through `WU-03`
  - `docs/tasks/RA-052.md`
  - `docs/tasks/RA-053.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-052/AUDIT-01.md`
  - `docs/handoffs/RA-052/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/work-units/RA-052/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Evidence: after restoring every mutation, the exact full task command exited
  `0`: lint and format passed; forced build ran `29/29` tasks with `0` cached;
  required-PostgreSQL Vitest passed `3055/3055` tests in `242/242` files with
  one explicit opt-in live-iOS test skipped; forced typecheck ran `46/46` tasks
  with `0` cached; `workflow:validate` reported `OK — 53 tasks`; diff-check
  passed. The first full attempt exited `1` at format on five task-owned files;
  Prettier was applied only to those files and the complete chain was rerun from
  the beginning. This was deterministic formatting debt, not a flake. Full
  diff audit from baseline plus all untracked files found no remaining
  BLOCKER/HIGH/MEDIUM.

## Durable decisions

- The deployment config is separate from the repository/workspace execution
  config. Discord needs only the latter's write-policy projection and must not
  gain access to local model executables or profile identities.
- The complete role mapping is code-owned configuration. Stage-to-role mapping
  is code-owned; prompts, Jira text, artifacts and tool inputs are data only.
- Existing operation descriptors remain the durable authority. No second
  workflow, model-run table or migration is introduced solely for routing.
- A route may reuse one profile for multiple roles, but every durable invocation
  still carries its exact role and is checked against that role's configured
  profile.
- Cross-fence recovery may repair known receipts or retry only retry-safe model
  work through the existing recovery state machine. It never selects another
  provider when the original client/config is unavailable.
- Live subscription qualification and the final Bedrock dependency removal
  remain RA-053. RA-052 uses only fake clients and local non-model tests.
