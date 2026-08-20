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
export * from "./context/compaction.js";
export * from "./checkpoint/apply-patch.js";
export * from "./checkpoint/errors.js";
export * from "./checkpoint/apply-completion.js";
export * from "./checkpoint/completion-errors.js";
export * from "./checkpoint/render.js";
export * from "./decisions/prepare.js";
export * from "./decisions/errors.js";
export * from "./recovery.js";
export * from "./roles/types.js";
export * from "./roles/prompts.js";
export * from "./roles/registry.js";
export * from "./supervisor/state.js";
export * from "./supervisor/errors.js";
export * from "./supervisor/machine.js";
export * from "./scheduler/mailbox.js";
export * from "./scheduler/semaphore.js";
export * from "./scheduler/fairness.js";
