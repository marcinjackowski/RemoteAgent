# RA-054 — work units

Baseline: `a4caec6c8fa066b12bb37b28f52c7d5549065b79`.

Owner enabled one live Codex subscription smoke on `2026-08-29`. Claude,
Bedrock and OpenCode remain disabled. The model remains an explicit profile
input; this task does not choose permanent IMPLEMENTER/REVIEWER routing.

## WU-00 — auth-channel and structured-schema compatibility

- Status: `DONE`
- Result: exact ChatGPT subscription status is accepted from one control
  channel, and every code-owned `const`/`enum` in the Codex response envelope
  has the explicit type required by the live client.
- Allowed paths:
  - `packages/model-provider-codex-cli/src/preflight.ts`
  - `packages/model-provider-codex-cli/src/schema.ts`
  - `packages/model-provider-codex-cli/test/preflight.test.ts`
  - `packages/model-provider-codex-cli/test/schema.test.ts`
  - `packages/model-provider-codex-cli/test/transport.test.ts`
  - `docs/work-units/RA-054/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && pnpm exec vitest run packages/model-provider-codex-cli/test/preflight.test.ts packages/model-provider-codex-cli/test/schema.test.ts packages/model-provider-codex-cli/test/transport.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-runtime`
- Evidence:
  - RED before implementation: focused auth/schema command exit `1`, `5` failed
    and `11` passed; failures were stderr status (`3` classifications), mixed
    channels and the missing `schema_version.type`.
  - GREEN after implementation: exact command exit `0`, `3/3` files and
    `21/21` tests; both builds exit `0`; forced typecheck `4/4`, cached `0`.
  - Mutations: stdout-only auth selection exit `1` (`1` failed); accepting two
    populated channels exit `1` (`1` failed); removing code-owned
    `schema_version.type` exit `1` (`1` failed). Each mutation was restored.

## WU-00A — threefold Engineering diagnostic token budget

- Status: `DONE`
- Depends on: `WU-00`
- Result: the whole-invocation Engineering journal uses an explicit threefold
  diagnostic multiplier while retaining exact usage, warning, hard-stop and
  conservative next-call reserve behavior.
- Allowed paths:
  - `apps/agent-worker/src/engineering-debug-journal.ts`
  - `apps/agent-worker/test/engineering-debug-journal.test.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `docs/tasks/RA-054.md`
  - `docs/work-units/RA-054/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm exec vitest run apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/agent-worker`
- Evidence:
  - RED before implementation: exact budget test exit `1`; existing target was
    `250000` instead of selected `750000`.
  - GREEN after restore: exact command exit `0`, `2/2` files and `23/23` tests;
    forced typecheck `18/18`, cached `0`.
  - Mutation: changing only the multiplier from `3` to `1` made the exact
    budget test exit `1`; restored before the final GREEN command.

## WU-01 — explicit opt-in live subscription smoke

- Status: `DONE`
- Depends on: `WU-00A`
- Result: a disabled-by-default test uses the exact canonical CLI/model selected
  by the owner and the production preflight/transport to return one strict
  content-free result with zero tools in an empty read-only invocation root.
- Allowed paths:
  - `packages/model-provider-codex-cli/src/transport.ts` (mutation only; no final diff)
  - `packages/model-provider-codex-cli/test/live-subscription.integration.test.ts`
  - `packages/model-provider-codex-cli/package.json`
  - `docs/work-units/RA-054/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && RA_RUN_LIVE_CODEX_SUBSCRIPTION=1 RA_CODEX_EXECUTABLE=/canonical/path/to/codex RA_CODEX_MODEL=gpt-5.6-sol pnpm exec vitest run packages/model-provider-codex-cli/test/live-subscription.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-runtime`
- Evidence:
  - Default command without opt-in exit `0` with `1` intentionally skipped test;
    forced provider typecheck `3/3`, cached `0`.
  - First live execution reached an exact successful response and usage, then
    exit `1` only because the assertion omitted the legitimate content-free
    `MODEL_SESSION_STARTED` event. The assertion was corrected, not the
    transport.
  - Final exact live command after the mutation restore exit `0`: both builds
    exit `0`, live `1/1` GREEN in `4.960s`, forced typecheck `4/4`, cached `0`.
    Provider-reported usage was `8749` input, `84` output and `8833` total
    tokens for `gpt-5.6-sol`.
  - Mutation: a synthetic early return from `CodexCliTransport.converse`
    produced the expected JSON without preflight/process events; live test exit
    `1` because the exact event list was empty. The mutation was restored
    before the final live command.

## WU-02 — mutation audit and task gate

- Status: `DONE`
- Depends on: `WU-01`
- Result: compatibility mechanisms have RED-to-GREEN mutations, the full task
  gate passes, and one audit closes the live finding without changing role
  routing or adding provider fallback.
- Allowed paths:
  - all paths owned by `WU-00`, `WU-00A` and `WU-01`
  - `docs/tasks/RA-054.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-054/AUDIT-01.md`
  - `docs/handoffs/RA-054/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/work-units/RA-054/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`
- Evidence:
  - First full start: lint exit `0`; format exit `1` on three task-owned tests.
    Prettier was applied only to those files.
  - Next full run: build `29/29`, cached `0`; `3066` tests passed and `3`
    failed deterministically because one fixture retained the old budget number
    and `CTF-024` was still marked open. The fixture now consumes production
    constants; focused recovery `1/1` and acceptance `19/19` were GREEN.
  - Final exact task gate exit `0`: lint/format exit `0`; build `29/29`, cached
    `0`; real-PG Vitest `3069/3069` in `244/244` files with `2` explicit opt-in
    skips; forced typecheck `46/46`, cached `0`; `workflow:validate OK — 54
    tasks`; `git diff --check` exit `0`.
  - Audit read the full baseline diff and all new files. `AUDIT-01` verdict is
    `PASS`; `CTF-024` is closed by the owner-enabled live evidence.
