/**
 * `@remoteagent/git-lifecycle` — safe, idempotent Git operations inside one case
 * workspace.
 *
 * Branch, status, diff, stage, commit and a controlled rebase, built on
 * `@remoteagent/workspace-runner`'s mirror/worktree model. Remote writes, merge
 * requests and automatic merges are deliberately absent: they belong to RA-017.
 *
 * Two things are structural rather than conventional. A commit's evidential status
 * is a discriminated union, so "verified" and "unverified" are both positive claims
 * and neither can be the silent default. And every Git invocation passes through one
 * `execFile` choke point that inspects its own argument vector, so a forbidden
 * operation cannot be spawned even by a future method that forgets to check.
 *
 * This barrel shares NO exported name with `@remoteagent/contracts`,
 * `implementation-tools` or `test-evidence` — asserted by a test, because ESM
 * silently drops an ambiguous name from `export *` and a consumer would then
 * receive `undefined` where a schema was expected.
 */
export * from "./contracts.js";
export * from "./lifecycle.js";
