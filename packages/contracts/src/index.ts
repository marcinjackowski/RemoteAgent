/**
 * `@remoteagent/contracts` — the single source of truth for RemoteAgent's
 * versioned TypeScript types and runtime JSON Schema (task RA-002).
 *
 * Modules are exported individually so later tasks import exactly the contracts
 * they need without duplicating types. Every boundary contract is a strict Zod
 * schema (unknown fields rejected fail-closed), carries a `schema_version`, and
 * keeps external content behind an explicit trust marker. Authoritative scope is
 * always assigned outside model output.
 */

// Infrastructure primitives.
export * from "./canonical.js";
export * from "./state-machine.js";
export * from "./common.js";
export * from "./trust.js";

// Domain contracts.
export * from "./external-entity.js";
export * from "./connection.js";
export * from "./event-envelope.js";
export * from "./case.js";
export * from "./checkpoint.js";
export * from "./decision.js";
export * from "./work-unit.js";
export * from "./agent-run.js";
export * from "./agent-completion.js";
export * from "./tool.js";
export * from "./external-action.js";
export * from "./repository-profile.js";
export * from "./implementation-plan.js";
export * from "./planner-port.js";

// Runtime JSON Schema.
export * from "./schema.js";
