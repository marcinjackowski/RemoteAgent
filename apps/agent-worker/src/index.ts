/**
 * @remoteagent/agent-worker — app skeleton.
 *
 * Foundation task RA-001 provides the manifest and workspace wiring only.
 * Domain logic is intentionally out of scope and arrives in later tasks.
 */
export const appName = "agent-worker" as const;

export * from "./workspace-config.js";
export * from "./vertical-slice-executor.js";
export * from "./engineering-execution.js";
export * from "./engineering-debug-journal.js";
export * from "./xcode-gate-adapter.js";
