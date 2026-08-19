/**
 * `WorkUnit` and agent roles (Master Plan §3.5).
 *
 * Roles are one-shot. The `role` discriminates a work unit; the Implementer is
 * the only writer of a workspace. The authoritative scope a work unit may act in
 * is carried on the unit itself (assigned by the Supervisor / system), never
 * derived from model output.
 */
import * as z from "zod";

import { idString, isoTimestamp, schemaVersion, text, valueObject } from "./common.js";
import { defineStateMachine } from "./state-machine.js";

export const AgentRole = {
  SUPERVISOR: "SUPERVISOR",
  PLANNER: "PLANNER",
  IMPLEMENTER: "IMPLEMENTER",
  REVIEWER: "REVIEWER",
  VERIFICATION: "VERIFICATION",
  SPECIALIST: "SPECIALIST",
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const agentRoleSchema = z.enum([
  AgentRole.SUPERVISOR,
  AgentRole.PLANNER,
  AgentRole.IMPLEMENTER,
  AgentRole.REVIEWER,
  AgentRole.VERIFICATION,
  AgentRole.SPECIALIST,
]);

/**
 * Whether a role is permitted to write to the workspace.
 *
 * This is the single, deterministic source of truth mirrored by the
 * discriminated {@link workUnit} contract below. Only the Implementer may write;
 * every other role is read-only in the workspace (Master Plan §3.5, §5.4).
 */
export const ROLE_CAN_WRITE_WORKSPACE: Readonly<Record<AgentRole, boolean>> = {
  [AgentRole.SUPERVISOR]: false,
  [AgentRole.PLANNER]: false,
  [AgentRole.IMPLEMENTER]: true,
  [AgentRole.REVIEWER]: false,
  [AgentRole.VERIFICATION]: false,
  [AgentRole.SPECIALIST]: false,
};

export const WorkUnitStatus = {
  PENDING: "PENDING",
  DISPATCHED: "DISPATCHED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type WorkUnitStatus = (typeof WorkUnitStatus)[keyof typeof WorkUnitStatus];

export const workUnitStatusSchema = z.enum([
  WorkUnitStatus.PENDING,
  WorkUnitStatus.DISPATCHED,
  WorkUnitStatus.RUNNING,
  WorkUnitStatus.COMPLETED,
  WorkUnitStatus.FAILED,
  WorkUnitStatus.CANCELLED,
]);

export const workUnitStatusMachine = defineStateMachine<WorkUnitStatus>("WorkUnit", {
  [WorkUnitStatus.PENDING]: [WorkUnitStatus.DISPATCHED, WorkUnitStatus.CANCELLED],
  [WorkUnitStatus.DISPATCHED]: [WorkUnitStatus.RUNNING, WorkUnitStatus.CANCELLED],
  [WorkUnitStatus.RUNNING]: [
    WorkUnitStatus.COMPLETED,
    WorkUnitStatus.FAILED,
    WorkUnitStatus.CANCELLED,
  ],
  [WorkUnitStatus.COMPLETED]: [],
  [WorkUnitStatus.FAILED]: [],
  [WorkUnitStatus.CANCELLED]: [],
});

/**
 * Authoritative scope a work unit may act in: connections and repos the role is
 * allowed to touch. Assigned by the system, not by any model. `can_write_workspace`
 * is fixed per role by the discriminated {@link workUnit} contract below.
 */
const scopeCommon = {
  connection_ids: z.array(idString).max(64).default([]),
  repo_allowlist: z.array(idString).max(64).default([]),
} as const;

/** Scope for the Implementer: the only role allowed to write the workspace. */
const implementerScope = valueObject({
  ...scopeCommon,
  can_write_workspace: z.literal(true),
});
/** Scope for every read-only role: writing the workspace is forbidden. */
const readOnlyScope = valueObject({
  ...scopeCommon,
  can_write_workspace: z.literal(false),
});

/** Fields shared by every work-unit variant. */
const workUnitCommon = {
  schema_version: schemaVersion,
  work_unit_id: idString,
  case_id: idString,
  status: workUnitStatusSchema,
  /** Supervisor-authored, deterministic objective for this one-shot role. */
  objective: text,
  /** Run that executes this unit, once dispatched. */
  run_id: idString.nullable().default(null),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
} as const;

/** The Implementer variant — the sole writer of a workspace. */
const implementerWorkUnit = z.strictObject({
  ...workUnitCommon,
  role: z.literal(AgentRole.IMPLEMENTER),
  authoritative_scope: implementerScope,
});

/** Build a read-only role variant whose scope forbids workspace writes. */
function readOnlyWorkUnit<TRole extends AgentRole>(role: TRole) {
  return z.strictObject({
    ...workUnitCommon,
    role: z.literal(role),
    authoritative_scope: readOnlyScope,
  });
}

/**
 * `WorkUnit` as a discriminated union over `role`. The type of
 * `authoritative_scope.can_write_workspace` is pinned per variant so both the
 * runtime schema and the compiler reject any non-Implementer role that claims
 * `can_write_workspace: true` (and any Implementer that claims `false`). This
 * enforces the single-writer invariant structurally rather than relying only on
 * the {@link ROLE_CAN_WRITE_WORKSPACE} helper map.
 */
export const workUnit = z.discriminatedUnion("role", [
  implementerWorkUnit,
  readOnlyWorkUnit(AgentRole.SUPERVISOR),
  readOnlyWorkUnit(AgentRole.PLANNER),
  readOnlyWorkUnit(AgentRole.REVIEWER),
  readOnlyWorkUnit(AgentRole.VERIFICATION),
  readOnlyWorkUnit(AgentRole.SPECIALIST),
]);

export type WorkUnit = z.infer<typeof workUnit>;
export type ImplementerWorkUnit = z.infer<typeof implementerWorkUnit>;
