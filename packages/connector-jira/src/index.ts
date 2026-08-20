/**
 * @remoteagent/connector-jira — package skeleton.
 *
 * Foundation task RA-001 provides the manifest and workspace wiring only.
 * Domain logic is intentionally out of scope and arrives in later tasks.
 */
export const packageName = "connector-jira" as const;
export * from "./contracts.js";
export * from "./errors.js";
export * from "./webhook/verify.js";
export * from "./webhook/ingress.js";
export type { JiraIngressContext, ParsedJiraEvent } from "./types.js";
export * from "./parser.js";
export * from "./normalize.js";
export * from "./scope.js";
