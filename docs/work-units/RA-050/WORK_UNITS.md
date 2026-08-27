# RA-050 — work units

Baseline: `3c8d2eaa01eddf3e7e56c6925e1ec1aa02fe6d24`.

Live Codex, Claude, Bedrock and OpenCode model calls remain disabled for the
whole task. Codex behavior is verified with deterministic fake binaries. Tests
may run only the non-model `codex --version` and `codex login status` preflight
surfaces against a locally installed client; they never read auth storage,
credentials or tokens.

Official Codex documentation is the external compatibility source. The adapter
uses `codex exec` in non-interactive JSONL mode, requires ChatGPT subscription
login, and rejects API-key authentication. The Codex subprocess receives no
repository authority: shell, web search, MCP, multi-agent and write access are
disabled, and model-requested tools are returned as strict structured output to
the existing code-owned bounded RemoteAgent tool loop.

## WU-00 — pinned client, subscription auth and invocation contract

- Status: `DONE`
- Result: one strict Codex profile pins a canonical executable, supported client
  version, model, safety settings and exact argv; preflight proves ChatGPT
  subscription login and rejects API-key/unknown auth before model execution.
- Allowed paths:
  - `packages/model-provider-codex-cli/package.json`
  - `packages/model-provider-codex-cli/tsconfig.json`
  - `packages/model-provider-codex-cli/tsconfig.test.json`
  - `packages/model-provider-codex-cli/src/**`
  - `packages/model-provider-codex-cli/test/**`
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `package.json`
  - `pnpm-lock.yaml`
  - `docs/work-units/RA-050/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && pnpm exec vitest run packages/model-provider-codex-cli/test packages/model-runtime/test && pnpm run typecheck --force --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-runtime`

Evidence:

- the code-owned invocation vector pins official `codex exec`, client version
  `0.147.0`, configured model, non-interactive JSONL, strict ignored user
  config/rules, ephemeral history, empty invocation root, read-only sandbox and
  explicit disabling of shell, web, apps, hooks, MCP dependency installation,
  subagents, memories, plugins, updates and telemetry;
- auth preflight invokes only exact `--version` and `login status` commands
  under the subscription process environment and accepts only the exact
  `Logged in using ChatGPT` result. API-key status/environment, logged-out,
  unknown auth and version drift remain typed refusal outcomes;
- focused restored gate returned exit `0`: build, `4/4` files and `27/27`
  tests, forced typecheck `4/4` tasks with `0` cached, and diff-check;
- mutations returned exit `1` and were restored for: client version comparison;
  accepting `Logged in using an API key`; skipping API credential environment
  classification; changing sandbox to `workspace-write`; and removing the
  shell-tool disable flag.

## WU-01 — strict bounded JSONL transport

- Status: `DONE`
- Depends on: `WU-00`
- Result: split stdout chunks, stderr, event ordering, session identity, final
  structured response and token usage are parsed once through a bounded strict
  state machine; auth/quota/version/malformed/cancel outcomes remain explicit
  and no reasoning or raw prose is journaled.
- Allowed paths:
  - `packages/model-provider-codex-cli/src/**`
  - `packages/model-provider-codex-cli/test/**`
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `docs/work-units/RA-050/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && pnpm exec vitest run packages/model-provider-codex-cli/test packages/model-runtime/test && pnpm run typecheck --force --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-runtime`

Evidence:

- the parser accepts one exact `thread.started -> turn.started -> item.* ->
  turn.completed` JSONL sequence, one opaque bounded session ID, one final
  schema-digest-bound message and strict nonnegative safe token usage. Duplicate,
  reordered, post-terminal, unknown and oversized shapes fail closed;
- reasoning/todo text and stderr exist only in bounded process memory and are
  discarded. Normalized events contain only provider/session/outcome/usage;
  command, file-change, MCP or web-search events are terminal tool-boundary
  violations;
- Codex `0.147.0` exposes only message prose for `turn.failed`, not a stable
  typed quota code. The adapter deliberately does not parse that prose: every
  top-level, turn or item error becomes the single non-retryable
  `QUOTA_OR_PROVIDER_FAILED` outcome, so quota/auth/runtime refusal can never
  trigger a fallback or false success. Auth remains separately typed by the
  preflight before invocation;
- the fake executable writes JSONL across process chunks, emits private stderr,
  reads the exact code-owned output schema and records argv/env. Its successful
  response is parsed, its isolated invocation root is deleted, and neither
  reasoning nor stderr survives in response/events;
- focused restored gate returned exit `0`: build, `6/6` files and `47/47`
  tests, forced typecheck `4/4` tasks with `0` cached, and diff-check;
- mutations returned exit `1` and were restored for: response schema digest;
  accepting an event after the terminal event; permissive usage fields; and
  disconnecting provider/turn failure classification.

## WU-02 — zero-authority tool protocol and production binding

- Status: `DONE`
- Depends on: `WU-01`
- Result: Codex runs in an isolated empty invocation root with read-only sandbox,
  no built-in shell/web/MCP/subagents and no workspace path; its only tool
  capability is strict structured output consumed by the existing bounded tool
  loop. Agent-worker can receive an explicit Codex subscription binding without
  selecting any Engineering role or introducing fallback.
- Allowed paths:
  - `packages/model-provider-codex-cli/src/**`
  - `packages/model-provider-codex-cli/test/**`
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `apps/agent-worker/package.json`
  - `apps/agent-worker/src/engineering-execution.ts`
  - `apps/agent-worker/src/engineering-workflow.ts`
  - `apps/agent-worker/src/worker.ts`
  - `apps/agent-worker/test/engineering-workflow.integration.test.ts`
  - `apps/agent-worker/test/worker.test.ts`
  - `package.json`
  - `pnpm-lock.yaml`
  - `docs/work-units/RA-050/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/model-provider-codex-cli/test packages/model-runtime/test apps/agent-worker/test/worker.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-runtime --filter=@remoteagent/agent-worker`

Evidence:

- every CLI call receives a strict schema-digest-bound envelope that permits
  either one final result or one proposed tool call. The digest includes the
  exact output schema and code-owned tool definitions; duplicate, malformed or
  excessive definitions are refused before spawn;
- Codex still receives no built-in tool authority. The tool name and input are
  returned as data, the strict transcript parser checks the bound name, and the
  existing provider-neutral `runToolLoop` enforces IDs, call/iteration limits
  and invokes the code-owned executor exactly once. A two-process fake CLI test
  proves tool request -> bounded execution -> tool result -> final response;
- aborting a hanging fake Codex process kills its descendant process and removes
  the per-call invocation root. A worker composition constructor exposes the
  real Codex transport without assigning DESIGNER/IMPLEMENTER/REVIEWER/VERIFIER
  routing or adding a fallback; that routing remains RA-052;
- pre-audit found that process-local preflight alone occurred after durable
  `STARTED`. The corrected workflow now requires a second, exact provider/
  profile/client/model/config proof before reading context or binding the model
  operation intent; a refusal leaves zero operations. The process preflight is
  retained immediately before spawn to catch later logout or auth drift;
- corrected focused gate returned exit `0`: three builds, `9/9` files and
  `98/98` tests with required PostgreSQL, forced typecheck `19/19` tasks with
  `0` cached, and diff-check;
- mutations returned exit `1` and were restored for: removing tools from the
  response digest; accepting a foreign tool name; no longer classifying a
  built-in `command_execution` event as a tool-boundary violation; converting a
  proposed tool into an ordinary final value and thereby bypassing the neutral
  tool loop; killing only the Codex parent rather than its process group; and
  replacing the worker's real Codex constructor with a disconnected transport.
  Additional mutations for removing the pre-intent hook and accepting a
  descriptor whose model differs from the authenticated profile also returned
  exit `1` and were restored;
- pre-audit found two additional fail-open edges. Provider output recursion is
  now bounded by exact depth/node limits, and subscription control commands
  retain their escalation timer until the whole detached process group exits.
  A fake child that ignores `SIGTERM` proves the later `SIGKILL`; a 70-level
  provider object proves the structural bound. Removing either mechanism
  returned exit `1`, then the restored focused gate remained green;
- the production subscription binding now requires a model invocation
  descriptor for every model-backed stage and reparses it at the composition
  boundary. A mutation returning `null` without that parse returned exit `1`;
  after restore the model-stage descriptor can no longer silently skip the
  pre-intent authentication proof.

## WU-03 — mutation audit and task gate

- Status: `DONE`
- Depends on: `WU-02`
- Result: auth source, exact argv/config, parser binding, cancellation/process
  tree and tool-authority boundaries all have recorded RED→GREEN mutations; the
  full noncached repository gate and audit close the task without a live model
  call.
- Allowed paths:
  - all paths owned by `WU-00` through `WU-02`
  - `docs/tasks/RA-050.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-050/AUDIT-01.md`
  - `docs/handoffs/RA-050/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/work-units/RA-050/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`

Evidence:

- all mutations listed in WU-00 through WU-02 were restored; the final audit
  read the complete diff from baseline plus every untracked source/test file;
- exact task gate returned exit `0`: lint and format; forced build `28/28` with
  `0` cached; required-PG Vitest `2987/2987` in `236/236` files with one explicit
  live-model skip; forced typecheck `44/44` with `0` cached;
  `workflow:validate OK — 53 tasks`; and `git diff --check` exit `0`;
- `docs/audits/RA-050/AUDIT-01.md` records `PASS`; no BLOCKER, HIGH or MEDIUM
  finding remains. No live provider call or external write occurred.

## Durable decisions

- Codex is qualified as one provider adapter only. RA-052 remains the sole owner
  of immutable per-role routing; RA-050 does not decide which model implements
  or reviews.
- Official subscription auth is observed only through `codex login status`.
  Auth files, keychain entries and OAuth tokens are never read, copied or
  logged. Any API-key or unknown login status fails before `codex exec`.
- The CLI never receives the Engineering worktree. RemoteAgent serializes the
  bounded context into stdin, starts Codex in an empty ephemeral directory and
  accepts only a strict final JSON response. A requested tool is executed later
  by the provider-neutral bounded tool loop under its existing writer/path/gate
  authority.
- CLI reasoning, commands, raw model messages and stderr text are not persisted.
  Only code-owned outcome codes, digests, bounded usage and opaque session
  identity may reach normalized events.

## Durable decisions for the next session

- RA-051 must reuse `runSubscriptionProcess`; duplicating spawn, env filtering,
  deadline or process-tree control is forbidden.
- Claude's exact OAuth proof and settings/tool isolation must be derived from
  the official client contract. Codex-specific strings, flags and JSONL schemas
  stay inside `@remoteagent/model-provider-codex-cli`.
- Production role selection remains deliberately absent. RA-052 is the only
  task allowed to bind named Codex/Claude profiles to DESIGNER, IMPLEMENTER,
  REVIEWER and VERIFIER or to extend cross-fence recovery routing.
- Live model execution remains opt-in and belongs to RA-053; default tests use
  fake binaries only.
