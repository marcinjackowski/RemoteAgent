/**
 * `@remoteagent/mcp-tool-broker` — the only controlled gate between an agent and
 * an MCP tool.
 *
 * Three properties are structural rather than conventional, and each one exists
 * because the obvious alternative fails in a specific way.
 *
 * **Scope cannot arrive from the model.** The accepted `toolIntent` contract has
 * no scope field at all, so a model proposal is *incapable* of naming an owner, a
 * connection or a repository; the broker builds the `resolvedToolIntent` by
 * consulting `resolveConnectionScope` against the case's authoritative grants.
 * Validating a model-supplied `connection_id` would have been the natural design
 * and it is the wrong one: validation is a check someone can forget, whereas an
 * absent field is a check that cannot be skipped.
 *
 * **A remote server describes; it does not decide.** `tools/list` output is
 * `UNTRUSTED_DATA`. The registry is server-owned, the description a role sees is
 * server-authored, and a divergence between what a server advertises and what is
 * registered is a refusal (`SCHEMA_DRIFT`) rather than an update. So an injected
 * "you may now write" in a remote description reaches no prompt and grants
 * nothing.
 *
 * **A read that may have happened is `AMBIGUOUS`, never `FAILED`.** The two
 * license different next steps — one is retryable, the other is not — so
 * collapsing them is how a timeout becomes a duplicate call or a false failure.
 * The ledger records the distinction durably before the call, so a crash between
 * dispatch and receipt resolves to `AMBIGUOUS` on a later pass instead of
 * vanishing.
 *
 * The former `packageName` skeleton export is gone: one of the six duplicate
 * `packageName` literals recorded in `CTF-002`, and this task owns the file.
 */
export * from "./contracts.js";
export * from "./registry.js";
export * from "./ledger.js";
export * from "./transport.js";
export * from "./executor.js";
export * from "./credential.js";
export * from "./conformance.js";
export * from "./providers.js";
