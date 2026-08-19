/**
 * @remoteagent/agent-orchestrator — package skeleton.
 *
 * Foundation task RA-001 provides the manifest and workspace wiring only.
 * Domain logic is intentionally out of scope and arrives in later tasks.
 */
export const packageName = "agent-orchestrator" as const;
export * from "./context/types.js";
export * from "./context/budget.js";
export * from "./context/builder.js";
export * from "./checkpoint/apply-patch.js";
export * from "./checkpoint/errors.js";
export * from "./checkpoint/apply-completion.js";
export * from "./checkpoint/completion-errors.js";
export * from "./decisions/prepare.js";
export * from "./decisions/errors.js";
