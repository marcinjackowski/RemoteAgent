/**
 * `AgentRun` and the run-safety state machine (Master Plan §6.2).
 *
 * Every model call / tool call / side effect moves through:
 *   PLANNED -> INTENT_RECORDED -> STARTED -> SUCCEEDED | FAILED | AMBIGUOUS
 * A non-reconcilable write ends in `AMBIGUOUS`, which halts automatic replay.
 * Runs are one-shot; continuity across restarts comes from checkpoints, not from
 * model memory.
 */
import * as z from "zod";

import { idString, isoTimestamp, valueObject, versionedContract } from "./common.js";
import { agentRoleSchema } from "./work-unit.js";
import { defineStateMachine } from "./state-machine.js";

export const RunSafetyState = {
  PLANNED: "PLANNED",
  INTENT_RECORDED: "INTENT_RECORDED",
  STARTED: "STARTED",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  AMBIGUOUS: "AMBIGUOUS",
} as const;

export type RunSafetyState = (typeof RunSafetyState)[keyof typeof RunSafetyState];

export const runSafetyStateSchema = z.enum([
  RunSafetyState.PLANNED,
  RunSafetyState.INTENT_RECORDED,
  RunSafetyState.STARTED,
  RunSafetyState.SUCCEEDED,
  RunSafetyState.FAILED,
  RunSafetyState.AMBIGUOUS,
]);

export const runSafetyMachine = defineStateMachine<RunSafetyState>("RunSafety", {
  [RunSafetyState.PLANNED]: [RunSafetyState.INTENT_RECORDED],
  [RunSafetyState.INTENT_RECORDED]: [RunSafetyState.STARTED],
  [RunSafetyState.STARTED]: [
    RunSafetyState.SUCCEEDED,
    RunSafetyState.FAILED,
    RunSafetyState.AMBIGUOUS,
  ],
  [RunSafetyState.SUCCEEDED]: [],
  [RunSafetyState.FAILED]: [],
  // AMBIGUOUS is terminal for automatic processing; reconciliation is manual
  // and produces a fresh run rather than mutating this one.
  [RunSafetyState.AMBIGUOUS]: [],
});

export const agentRun = versionedContract({
  run_id: idString,
  case_id: idString,
  work_unit_id: idString,
  role: agentRoleSchema,
  safety_state: runSafetyStateSchema,
  /** Checkpoint revision this one-shot run was launched from. */
  checkpoint_revision: z.int().nonnegative(),
  /** Event that triggered the run, if any. */
  trigger_event_id: idString.nullable().default(null),
  /** Model/runtime attribution for observability. */
  model: valueObject({
    provider: idString,
    model_id: idString,
  }).optional(),
  started_at: isoTimestamp.nullable().default(null),
  finished_at: isoTimestamp.nullable().default(null),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export type AgentRun = z.infer<typeof agentRun>;
