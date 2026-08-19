/**
 * `AgentCompletion` — the single, discriminated result every model run ends with
 * (Master Plan §4.4).
 *
 * The union is discriminated by `status`. Each variant carries the common
 * completion payload (summary, steps, evidence, proposed checkpoint patch, next
 * actions); `WAITING_FOR_USER` additionally *requires* a `DecisionRequest`, and
 * `BLOCKED`/`FAILED`/`CANCELLED` carry a reason. This makes an illegal shape
 * (e.g. WAITING_FOR_USER without a decision) unrepresentable and rejected
 * fail-closed at the boundary.
 */
import * as z from "zod";

import { idString, text, valueObject } from "./common.js";
import { checkpointPatch } from "./checkpoint.js";
import { decisionRequest } from "./decision.js";
import { schemaVersion } from "./common.js";

export const AgentCompletionStatus = {
  CONTINUE: "CONTINUE",
  WAITING_FOR_USER: "WAITING_FOR_USER",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type AgentCompletionStatus =
  (typeof AgentCompletionStatus)[keyof typeof AgentCompletionStatus];

export const agentCompletionStatusSchema = z.enum([
  AgentCompletionStatus.CONTINUE,
  AgentCompletionStatus.WAITING_FOR_USER,
  AgentCompletionStatus.BLOCKED,
  AgentCompletionStatus.COMPLETED,
  AgentCompletionStatus.FAILED,
  AgentCompletionStatus.CANCELLED,
]);

const completedStep = valueObject({
  description: text,
  reference: idString.optional(),
});

const evidenceRef = valueObject({
  kind: text,
  reference: idString,
});

/** Fields present on every completion variant. */
const commonShape = {
  schema_version: schemaVersion,
  run_id: idString,
  case_id: idString,
  summary: text,
  completed_steps: z.array(completedStep).max(256).default([]),
  evidence: z.array(evidenceRef).max(256).default([]),
  checkpoint_patch: checkpointPatch,
  next_actions: z.array(text).max(256).default([]),
} as const;

const continueVariant = z.strictObject({
  ...commonShape,
  status: z.literal(AgentCompletionStatus.CONTINUE),
});

const waitingForUserVariant = z.strictObject({
  ...commonShape,
  status: z.literal(AgentCompletionStatus.WAITING_FOR_USER),
  /** A pending decision is mandatory in this state. */
  decision_request: decisionRequest,
});

const blockedVariant = z.strictObject({
  ...commonShape,
  status: z.literal(AgentCompletionStatus.BLOCKED),
  blocker_reason: text,
});

const completedVariant = z.strictObject({
  ...commonShape,
  status: z.literal(AgentCompletionStatus.COMPLETED),
});

const failedVariant = z.strictObject({
  ...commonShape,
  status: z.literal(AgentCompletionStatus.FAILED),
  failure_reason: text,
});

const cancelledVariant = z.strictObject({
  ...commonShape,
  status: z.literal(AgentCompletionStatus.CANCELLED),
  cancellation_reason: text,
});

export const agentCompletion = z
  .discriminatedUnion("status", [
    continueVariant,
    waitingForUserVariant,
    blockedVariant,
    completedVariant,
    failedVariant,
    cancelledVariant,
  ])
  .superRefine((value, ctx) => {
    // A WAITING_FOR_USER completion carries a persistent DecisionRequest. Its
    // case_id MUST match the completion's case_id so a model run cannot create a
    // durable question attributed to a different case — which would misroute the
    // owner's answer and could mutate a foreign case's checkpoint. The
    // deterministic orchestrator still binds run_id to the authoritative run
    // outside the model.
    //
    // NOTE (JSON Schema projection limitation): equality between the completion
    // case_id and the nested decision_request.case_id is a cross-field invariant
    // that `z.toJSONSchema` cannot express; the projected schema advertises only
    // the per-field shapes, so this runtime Zod schema is the authoritative
    // validator.
    if (
      value.status === AgentCompletionStatus.WAITING_FOR_USER &&
      value.decision_request.case_id !== value.case_id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["decision_request", "case_id"],
        message: "decision_request.case_id must equal the completion case_id",
      });
    }
  });

export type AgentCompletion = z.infer<typeof agentCompletion>;
export type ContinueCompletion = z.infer<typeof continueVariant>;
export type WaitingForUserCompletion = z.infer<typeof waitingForUserVariant>;
export type BlockedCompletion = z.infer<typeof blockedVariant>;
export type CompletedCompletion = z.infer<typeof completedVariant>;
export type FailedCompletion = z.infer<typeof failedVariant>;
export type CancelledCompletion = z.infer<typeof cancelledVariant>;

/** Terminal completion statuses (no further run is expected). */
export const TERMINAL_COMPLETION_STATUSES: readonly AgentCompletionStatus[] = [
  AgentCompletionStatus.COMPLETED,
  AgentCompletionStatus.FAILED,
  AgentCompletionStatus.CANCELLED,
];

export function isTerminalCompletion(status: AgentCompletionStatus): boolean {
  return TERMINAL_COMPLETION_STATUSES.includes(status);
}
