# RA-051 — work units

Baseline: `12c20a7b9717d8a4b3f02170b865b4a0cb62907e`.

Live Claude, Codex, Bedrock and OpenCode model calls remain disabled for the
whole task. Claude behavior is qualified with deterministic fake binaries.
Tests may invoke only fake `--version` and `auth status` control surfaces; they
never read Claude credential storage, keychain entries, OAuth tokens or model
output from a live provider.

The compatibility source is the official Claude Code documentation and
changelog. The adapter uses official `claude -p` in restricted, safe,
non-interactive stream-JSON mode. It accepts only a first-party Claude
subscription login and rejects API keys, OAuth-token injection, Bedrock,
Vertex, Foundry and third-party authentication. The CLI receives no Engineering
worktree and no built-in tool authority. A model-requested operation is returned
as strict data for the existing code-owned bounded tool loop.

## WU-00 — pinned client, subscription auth and invocation isolation

- Status: `DONE`
- Result: one strict Claude profile pins a canonical executable, an explicit
  supported client-version allowlist, model and exact argv; preflight proves
  first-party Claude subscription login and the invocation ignores user/project
  instructions, settings, hooks, MCP, slash commands, browser and built-in
  tools before any model process is started.
- Allowed paths:
  - `packages/model-provider-claude-code/package.json`
  - `packages/model-provider-claude-code/tsconfig.json`
  - `packages/model-provider-claude-code/tsconfig.test.json`
  - `packages/model-provider-claude-code/src/**`
  - `packages/model-provider-claude-code/test/**`
  - `packages/model-provider-codex-cli/src/preflight.ts`
  - `packages/model-provider-codex-cli/test/preflight.test.ts`
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `package.json`
  - `pnpm-lock.yaml`
  - `docs/tasks/RA-051.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/work-units/RA-051/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-codex-cli build && pnpm --filter @remoteagent/model-provider-claude-code build && pnpm exec vitest run packages/model-runtime/test packages/model-provider-codex-cli/test/preflight.test.ts packages/model-provider-claude-code/test && pnpm run typecheck --force --filter=@remoteagent/model-runtime --filter=@remoteagent/model-provider-codex-cli --filter=@remoteagent/model-provider-claude-code`

Evidence:

- the supported client allowlist contains only Claude Code `2.1.248` and
  `2.1.250`; `--restricted` is mandatory, `--bare` is forbidden, and version
  `2.1.247` is refused before auth because it lacks the harness isolation
  contract;
- auth preflight invokes only exact `--version` and `auth status --json`
  control commands through the shared bounded subscription process boundary.
  It accepts only `authMethod=claude.ai` plus `apiProvider=firstParty`; account
  metadata is discarded, while API key/token, console, third-party, Bedrock,
  Vertex and Foundry authority is refused before spawn;
- exact invocation combines restricted and safe modes, empty setting sources,
  code-owned settings with hooks disabled, an empty strict MCP config, empty
  tools plus a deny-all tool rule, plan permissions, no browser, no session
  persistence, no slash commands and no fallback model in an empty root;
- the final restored gate returned exit `0`: three builds, `5/5` files and
  `42/42` tests, forced typecheck `5/5` tasks with `0` cached, and diff-check;
- mutations returned exit `1` and were restored for: accepting client `2.1.247`;
  treating third-party Bedrock auth as subscription; omitting
  `ANTHROPIC_AUTH_TOKEN` from the forbidden environment; removing
  `--restricted`; and omitting the explicit empty `--tools` boundary.

## WU-01 — strict bounded stream-JSON transport

- Status: `DONE`
- Depends on: `WU-00`
- Result: split stdout chunks, stderr, event ordering, exact session/model,
  structured result and token usage are parsed once through a bounded strict
  state machine; quota, auth, cancellation, partial/malformed output and
  provider refusal remain content-free typed outcomes with no fallback.
- Allowed paths:
  - `packages/model-provider-claude-code/src/**`
  - `packages/model-provider-claude-code/test/**`
  - `packages/model-runtime/src/**`
  - `packages/model-runtime/test/**`
  - `docs/work-units/RA-051/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-claude-code build && pnpm exec vitest run packages/model-provider-claude-code/test packages/model-runtime/test && pnpm run typecheck --force --filter=@remoteagent/model-provider-claude-code --filter=@remoteagent/model-runtime`

Evidence:

- the bounded parser requires `system/init` first and one terminal `result`
  last. It exact-binds code-owned session, client version, model and empty
  invocation root; `apiKeySource=none`, plan permissions and empty built-in
  tools, MCP servers, plugins, skills and slash commands are mandatory;
- `assistant` prose and stderr are discarded. A built-in `tool_use`, hook/plugin
  startup event, foreign session/model/cwd, post-terminal/partial stream,
  permission denial, deferred tool, malformed/deep JSON or foreign structured
  response digest fails closed;
- typed `system/api_retry` auth, quota/rate-limit and provider failures map to
  content-free outcomes and are never followed to a successful fallback. The
  final usage is derived from an exact one-model, `provider=firstParty`
  `modelUsage` record; raw result/error prose is not inspected or persisted;
- a split-chunk fake CLI proves the exact argv/settings/MCP/stdin boundary and
  ephemeral-root cleanup. A hanging fake with a descendant proves cancellation
  kills the complete process group and then removes the root;
- the final restored gate returned exit `0`: two builds, `6/6` files and
  `66/66` tests, forced typecheck `4/4` tasks with `0` cached, and diff-check;
- mutations returned exit `1` and were restored for: accepting a foreign
  response schema digest; accepting a fallback model in `system/init`;
  accepting advertised built-in tools; continuing after typed rate-limit retry;
  and killing only the Claude parent instead of its process group.

## WU-02 — zero-authority tool protocol and production binding

- Status: `DONE`
- Depends on: `WU-01`
- Result: Claude runs in an empty invocation root with no workspace path or
  built-in tool authority; strict structured tool requests are executed only by
  the provider-neutral bounded loop. Agent-worker exposes an explicit Claude
  subscription constructor and exact pre-intent identity proof without choosing
  an Engineering role or adding provider fallback.
- Allowed paths:
  - `packages/model-provider-claude-code/src/**`
  - `packages/model-provider-claude-code/test/**`
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
  - `docs/work-units/RA-051/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm --filter @remoteagent/model-runtime build && pnpm --filter @remoteagent/model-provider-claude-code build && pnpm --filter @remoteagent/agent-worker build && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run packages/model-provider-claude-code/test packages/model-runtime/test apps/agent-worker/test/worker.test.ts apps/agent-worker/test/engineering-workflow.integration.test.ts && pnpm run typecheck --force --filter=@remoteagent/model-provider-claude-code --filter=@remoteagent/model-runtime --filter=@remoteagent/agent-worker`

Evidence:

- Claude receives the role's declared tools only inside the code-owned response
  protocol. Tool name and input are parsed as an untrusted proposal; the
  existing provider-neutral bounded tool loop validates and executes it. A
  two-turn fake CLI proves exactly one declared tool call, one code-owned
  execution and a fresh isolated Claude session for each turn;
- output schema and complete declared tool definitions enter one canonical
  response digest. Foreign tool names are refused before the bounded executor,
  while the Claude process itself advertises zero built-in tools and never sees
  an Engineering workspace path;
- the worker exports an explicit Claude subscription transport constructor and
  pre-intent identity proof, but deliberately assigns no implementation or
  review role. Foreign provider/profile/model/client identity is refused and no
  conversation-model fallback is introduced; RA-052 remains the routing owner;
- a nonzero Claude process carrying a terminal typed provider result is parsed
  only for its content-free failure class. Error/result prose is discarded and
  cannot become an artifact, event or fallback input;
- the final restored gate returned exit `0`: three builds, `8/8` files and
  `111/111` tests, forced typecheck `20/20` tasks with `0` cached, and
  diff-check;
- mutations returned exit `1` and were restored for: accepting an undeclared
  tool name; omitting tools from the response digest; turning a tool proposal
  into final JSON and bypassing the code-owned executor; disconnecting the
  worker Claude constructor; accepting a foreign preflight invocation identity;
  and refusing to parse a nonzero typed provider result into its content-free
  provider outcome.

## WU-03 — mutation audit and task gate

- Status: `DONE`
- Depends on: `WU-02`
- Result: auth source, exact argv/settings, parser binding, cancellation/process
  tree and tool-authority boundaries have recorded RED→GREEN mutations; the
  full noncached repository gate and audit close the task without a live model
  call.
- Allowed paths:
  - all paths owned by `WU-00` through `WU-02`
  - `docs/tasks/RA-051.md`
  - `docs/tasks/TASK_INDEX.md`
  - `docs/audits/RA-051/AUDIT-01.md`
  - `docs/handoffs/RA-051/HANDOFF-01.md`
  - `docs/audits/CROSS_TASK_FINDINGS.md`
  - `docs/work-units/RA-051/WORK_UNITS.md`
- Verification: `. scripts/dev/env.sh && pnpm lint && pnpm format && pnpm run build --force && RA_REQUIRE_POSTGRES=1 pnpm exec vitest run && pnpm run typecheck --force && pnpm workflow:validate && git diff --check`

Evidence:

- all mutations listed in WU-00 through WU-02 were restored; the final audit
  read the complete diff from baseline plus every untracked source/test file;
- the first full gate stopped before build/tests on one deterministic ESLint
  `prefer-const` error in the shared control runner. The process construction
  was corrected and the exact chain was restarted from lint; this was not a
  flake or a passing partial run;
- the final task gate returned exit `0`: lint and format; forced build `29/29`
  with `0` cached; required-PG Vitest `3039/3039` in `240/240` files with one
  explicit live-model skip; forced typecheck `46/46` with `0` cached;
  `workflow:validate OK — 53 tasks`; and `git diff --check` exit `0`;
- `docs/audits/RA-051/AUDIT-01.md` records `PASS`; no BLOCKER, HIGH or MEDIUM
  finding remains. No live provider call or external write occurred.

## Durable decisions

- Claude is qualified as one provider adapter only. RA-052 remains the sole
  owner of immutable per-role routing and decides later which profile implements
  or reviews.
- `--bare` is forbidden because the official client documents that it bypasses
  subscription OAuth/keychain credentials. The adapter instead combines
  `--restricted`, `--safe-mode`, empty settings/MCP config, no built-in tools and
  an empty invocation root.
- Supported versions start at Claude Code `2.1.248`, where `--restricted` was
  introduced. Version drift fails closed until its stream/settings contract is
  qualified explicitly.
- Subscription auth is observed only through `claude auth status`. Credential
  files, keychain entries, OAuth tokens and account identifiers are never read,
  copied or logged.
- CLI prose, reasoning, raw messages and stderr are not durable evidence. Only
  code-owned outcome codes, digests, bounded usage and opaque session identity
  may reach normalized events.
