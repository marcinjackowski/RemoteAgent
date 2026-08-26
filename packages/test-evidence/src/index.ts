/**
 * `@remoteagent/test-evidence` — deterministic verification and evidence that does
 * not depend on what a model claims.
 *
 * The organising idea is that a verdict is **derived**, never recorded. A model
 * names a command from a server-owned manifest; the runner executes it through
 * `@remoteagent/workspace-runner`, observes the process, and mints a `TestRun`
 * receipt bound to a workspace and a tree digest. `deriveVerdict` then computes the
 * verdict from those receipts. There is no field, flag or code path through which a
 * `PASS` can be asserted, which is the point of the package.
 *
 * This barrel deliberately shares NO exported name with `@remoteagent/contracts`
 * or `@remoteagent/implementation-tools` — see `test/contracts.test.ts`, which
 * fails if the intersection stops being empty. A name exported by two barrels is
 * not a compile error: ESM drops the ambiguous name from a `export *` re-export,
 * so a consumer of a combined surface would silently receive `undefined` where a
 * schema was expected.
 */
export * from "./contracts.js";
export * from "./artifact-store.js";
export * from "./runner.js";
export * from "./snapshot.js";
export * from "./verification.js";
export * from "./engineering-gates.js";
export * from "./disposable-workspace.js";
