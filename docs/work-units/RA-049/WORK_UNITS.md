# RA-049 — work units

Baseline: `2189f4b1911f2605a16cb1d97a34d90b099ccc59`.

Live calls do Bedrock, Codex and Claude remain disabled for the whole task. All
provider behavior is verified with deterministic fake binaries and injected
transports; no API key, OAuth token or credential file is read by a test.

## WU-00 — provider-neutral model runtime

- Status: `DONE`
- Result: structured completion, tool-loop policy, normalized model identity,
  usage and terminal outcomes have one provider-neutral owner; Bedrock is only
  an adapter and compatibility re-export, not the domain runtime.
- Allowed paths:
  - `packages/model-runtime/package.json`
  - `packages/model-runtime/tsconfig.json`
  - `packages/model-runtime/tsconfig.test.json`
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `packages/bedrock-runtime/package.json`
  - `packages/bedrock-runtime/src/**`
  - `packages/bedrock-runtime/test/**`
  - `package.json`
  - `pnpm-lock.yaml`
  - `docs/work-units/RA-049/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/bedrock-runtime build && pnpm exec vitest run packages/model-runtime/test packages/bedrock-runtime/test && pnpm run typecheck --force --filter=@remoteagent/model-runtime --filter=@remoteagent/bedrock-runtime`

Evidence:

- the neutral package owns runtime config, transport types, structured
  completion, retry, streaming and the bounded tool loop; the Bedrock package
  retains only AWS adapters and compatibility re-exports;
- the scoped superset gate after implementation returned exit `0`: model,
  Bedrock and worker builds; `17/17` files and `184/184` tests with required
  PostgreSQL; `20/20` forced typecheck tasks with `0` cached; `git diff --check`
  exit `0`;
- mutation: replacing the compatibility re-export with a second
  `createRuntimeConfig` implementation returned exit `1` in the identity test;
  the re-export was restored.

## WU-01 — subscription profile and safe CLI process boundary

- Status: `DONE`
- Result: a strict, digest-bound config accepts only named `codex_cli` and
  `claude_code` profiles; a canonical executable runs without a shell under an
  allowlisted environment, only after a code-owned subscription-auth preflight,
  with bounded I/O, timeout/cancel and process-tree termination.
- Allowed paths:
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `docs/work-units/RA-049/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm exec vitest run packages/model-runtime/test && pnpm run typecheck --force --filter=@remoteagent/model-runtime`

Evidence:

- strict, digest-bound profiles accept only canonical `codex_cli` and
  `claude_code` entries; provider output and events have bounded, content-free
  schemas;
- the process boundary uses an exact canonical executable, argv with
  `shell:false`, an allowlisted environment, bounded stdin/stdout/stderr, one
  overall preflight+process deadline, cancellation and process-group TERM/KILL;
- focused restored gate returned exit `0`: build, `2/2` files and `18/18`
  tests, forced typecheck `2/2` with `0` cached;
- mutations returned exit `1` and were restored for: provider allowlist;
  strict unknown-field rejection; API/cloud credential rejection; arbitrary
  environment forwarding; shell invocation; executable symlink acceptance;
  process-tree kill replaced with child-only kill; stdout overrun; bounded
  preflight delayed fourfold; nonfatal UTF-8 decoding; canonical deployment
  config symlink acceptance; mutable post-digest profile lookup; and
  changed-model preflight identity acceptance.
  The process-tree mutation left one exact child PID, which was inspected,
  terminated and verified absent before continuing.

## WU-02 — Engineering provider provenance and Bedrock disconnect

- Status: `DONE`
- Result: model stages bind exact provider/profile/client/model/config before
  STARTED and re-check it on recovery; production Engineering has no automatic
  Bedrock default or fallback while conversational legacy remains unchanged.
- Allowed paths:
  - `apps/agent-worker/package.json`
  - `apps/agent-worker/src/engineering-debug-journal.ts`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-recovery.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/roles.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-debug-journal.test.ts`
  - `apps/agent-worker/test/engineering-execution.integration.test.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `apps/agent-worker/test/worker.test.ts`
  - `packages/contracts/src/engineering-workflow.ts`
  - `packages/contracts/test/engineering-workflow.test.ts`
  - `packages/database/src/repositories/agent-config.ts`
  - `packages/database/test/agent-config.integration.test.ts`
  - `package.json`
  - `pnpm-lock.yaml`
  - `docs/work-units/RA-049/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/contracts/test/engineering-workflow.test.ts packages/database/test/agent-config.integration.test.ts apps/agent-worker/test/engineering-debug-journal.test.ts apps/agent-worker/test/engineering-execution.integration.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts apps/agent-worker/test/worker.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-runtime --filter=@remoteagent/contracts --filter=@remoteagent/database --filter=@remoteagent/agent-worker`

Evidence:

- every model-backed stage can bind a strict content-free descriptor containing
  role, provider, profile, client version, model, executable digest, deployment
  config digest and profile digest before `STARTED`; same-lease recovery reads
  the immutable intent and rejects any mismatch before invoke;
- production composition has separate conversation and Engineering slots.
  Engineering is `null` until an explicit `OFFICIAL_SUBSCRIPTION_CLI` binding
  exists and fails closed; it never reuses the legacy Bedrock conversation
  transport;
- the scoped superset gate returned exit `0`: `17/17` files, `184/184` tests
  with real PostgreSQL, and `20/20` forced typecheck tasks with `0` cached;
- mutations returned exit `1` and were restored for: conversation transport as
  Engineering fallback; removal of the persisted invocation descriptor; and
  bypass of exact provider/profile/model/config recovery comparison.

## WU-03 — mutation audit and task gate

- Status: `DONE`
- Result: every RA-049 security mechanism has a recorded RED→GREEN mutation,
  the noncached repository gate is green and the audit verifies all acceptance
  criteria before task closure.
- Allowed paths:
  - all paths owned by WU-00 through WU-02
  - `docs/tasks/RA-049.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-049/AUDIT-01.md`
  - `docs/handoffs/RA-049/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/work-units/RA-049/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`

Evidence:

- all recorded mutations were restored and the final source scan found no
  sentinel mutation, second neutral runtime or Engineering Bedrock fallback;
- exact task gate was run twice; the final run after the immutable-profile fix
  returned exit `0`: lint and format; build `27/27`, `0 cached`; required-PG
  Vitest `2947/2947` in `231/231` files with one explicit live-iOS skip;
  typecheck `42/42`, `0 cached`; `workflow:validate OK — 53 tasks`; and
  `git diff --check` exit `0`;
- `docs/audits/RA-049/AUDIT-01.md` records `PASS`; no BLOCKER, HIGH or MEDIUM
  finding remains. No live provider call or external write occurred.

## Durable decisions for the next session

- RA-049 is only the neutral runtime and composition disconnect. It does not
  claim that either official CLI adapter exists or that Engineering can run
  with a subscription profile yet.
- RA-050 owns Codex CLI auth/argv/JSONL/permissions qualification; RA-051 owns
  Claude Code; RA-052 owns role selection and cross-fence routing.
- Legacy Bedrock conversation roles remain isolated until RA-053. Engineering
  has no Bedrock fallback now.
- Provider choice per role is intentionally unresolved; absence remains a
  fail-closed deployment state rather than an implicit default.
