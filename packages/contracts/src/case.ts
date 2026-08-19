/**
 * `Case` — the unit of conversation, concurrency and checkpointing
 * (Master Plan §5.2, §6.1).
 *
 * `integration_scope` is the authoritative set of connections/providers the case
 * may touch; it is assigned deterministically outside the model and can never be
 * widened by model output. The Case status machine encodes the allowed lifecycle
 * transitions (§6.1).
 */
import * as z from "zod";

import { idString, isoTimestamp, valueObject, versionedContract } from "./common.js";
import { providerSchema } from "./external-entity.js";
import { defineStateMachine } from "./state-machine.js";

export const CaseStatus = {
  NEW: "NEW",
  TRIAGED: "TRIAGED",
  PLANNING: "PLANNING",
  WAITING_FOR_USER: "WAITING_FOR_USER",
  IMPLEMENTING: "IMPLEMENTING",
  VERIFYING: "VERIFYING",
  REVIEWING: "REVIEWING",
  FIXING: "FIXING",
  READY_FOR_MR: "READY_FOR_MR",
  MR_OPEN: "MR_OPEN",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  CANCELLED: "CANCELLED",
} as const;

export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

export const caseStatusSchema = z.enum([
  CaseStatus.NEW,
  CaseStatus.TRIAGED,
  CaseStatus.PLANNING,
  CaseStatus.WAITING_FOR_USER,
  CaseStatus.IMPLEMENTING,
  CaseStatus.VERIFYING,
  CaseStatus.REVIEWING,
  CaseStatus.FIXING,
  CaseStatus.READY_FOR_MR,
  CaseStatus.MR_OPEN,
  CaseStatus.DONE,
  CaseStatus.BLOCKED,
  CaseStatus.CANCELLED,
]);

/**
 * Case lifecycle machine (Master Plan §6.1).
 *
 * Any non-terminal state may enter `BLOCKED` or `CANCELLED` after a documented
 * reason. `DONE` and `CANCELLED` are terminal; `BLOCKED` is a recoverable hold,
 * not terminal — it transitions back into active work (`PLANNING`,
 * `IMPLEMENTING`) once the blocker clears, or on to `CANCELLED`. The core
 * engineering loop is IMPLEMENTING ↔ VERIFYING ↔ REVIEWING ↔ FIXING before
 * READY_FOR_MR.
 */
const nonTerminalExits = [CaseStatus.BLOCKED, CaseStatus.CANCELLED] as const;

export const caseStatusMachine = defineStateMachine<CaseStatus>("Case", {
  [CaseStatus.NEW]: [CaseStatus.TRIAGED, ...nonTerminalExits],
  [CaseStatus.TRIAGED]: [CaseStatus.PLANNING, ...nonTerminalExits],
  [CaseStatus.PLANNING]: [
    CaseStatus.WAITING_FOR_USER,
    CaseStatus.IMPLEMENTING,
    ...nonTerminalExits,
  ],
  [CaseStatus.WAITING_FOR_USER]: [CaseStatus.PLANNING, ...nonTerminalExits],
  [CaseStatus.IMPLEMENTING]: [
    CaseStatus.VERIFYING,
    CaseStatus.WAITING_FOR_USER,
    ...nonTerminalExits,
  ],
  [CaseStatus.VERIFYING]: [CaseStatus.REVIEWING, CaseStatus.IMPLEMENTING, ...nonTerminalExits],
  [CaseStatus.REVIEWING]: [CaseStatus.FIXING, CaseStatus.READY_FOR_MR, ...nonTerminalExits],
  [CaseStatus.FIXING]: [CaseStatus.IMPLEMENTING, CaseStatus.VERIFYING, ...nonTerminalExits],
  [CaseStatus.READY_FOR_MR]: [CaseStatus.MR_OPEN, ...nonTerminalExits],
  [CaseStatus.MR_OPEN]: [CaseStatus.DONE, CaseStatus.FIXING, ...nonTerminalExits],
  [CaseStatus.DONE]: [],
  [CaseStatus.BLOCKED]: [
    // A blocker can be cleared back into active work or cancelled outright.
    CaseStatus.PLANNING,
    CaseStatus.IMPLEMENTING,
    CaseStatus.CANCELLED,
  ],
  [CaseStatus.CANCELLED]: [],
});

/** Authoritative integration scope (assigned outside the model). */
export const integrationScope = valueObject({
  providers: z.array(providerSchema).min(1).max(16),
  connection_ids: z.array(idString).min(1).max(64),
});

export type IntegrationScope = z.infer<typeof integrationScope>;

export const caseContract = versionedContract({
  case_id: idString,
  owner_id: idString,
  status: caseStatusSchema,
  integration_scope: integrationScope,
  discord_thread_id: idString,
  /** Currently active run, if any. */
  active_run_id: idString.nullable().default(null),
  /** Monotonic checkpoint revision this case is at. */
  checkpoint_revision: z.int().nonnegative(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export type Case = z.infer<typeof caseContract>;
