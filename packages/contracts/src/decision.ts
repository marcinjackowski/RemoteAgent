/**
 * `DecisionRequest` and `Answer` (Master Plan §5.5).
 *
 * A decision is bound to a `checkpoint_revision`; the owner's answer references
 * the exact `decision_id` and the revision it was asked at, so a stale answer can
 * never be applied to a mutated question.
 */
import * as z from "zod";

import { idString, isoTimestamp, label, text, valueObject, versionedContract } from "./common.js";

export const decisionOption = valueObject({
  id: idString,
  label,
  consequences: text,
});

export type DecisionOption = z.infer<typeof decisionOption>;

export const decisionRequest = versionedContract({
  decision_id: idString,
  case_id: idString,
  question: text,
  why_now: text,
  // The governing workflow (docs/workflow/EXECUTION_AND_AUDIT.md) requires a
  // decision to present exactly 2–3 real options; a fourth option is rejected.
  options: z.array(decisionOption).min(2).max(3),
  /** Option id the agent recommends; must match one of `options`. */
  recommendation: idString,
  /** Human description of the work blocked until this is answered. */
  blocked_scope: text,
  /** Revision the decision was raised at; the answer must match it. */
  checkpoint_revision: z.int().nonnegative(),
  expires_at: isoTimestamp.optional(),
})
  .refine(
    (value) => {
      const ids = value.options.map((o) => o.id);
      return new Set(ids).size === ids.length;
    },
    { message: "option ids must be unique", path: ["options"] },
  )
  .refine((value) => value.options.some((o) => o.id === value.recommendation), {
    message: "recommendation must reference one of the provided options",
    path: ["recommendation"],
  });

export type DecisionRequest = z.infer<typeof decisionRequest>;

/**
 * Owner's answer. `answered_by` and `answered_at` are recorded by the system;
 * the `selected_option_id` is validated against the referenced request outside
 * this schema (it cannot know the option set on its own).
 */
export const decisionAnswer = versionedContract({
  decision_id: idString,
  case_id: idString,
  /** Revision the answer is intended for; must equal the request's revision. */
  checkpoint_revision: z.int().nonnegative(),
  selected_option_id: idString,
  /** Optional free-form owner note. */
  note: text.optional(),
  answered_by: idString,
  answered_at: isoTimestamp,
});

export type DecisionAnswer = z.infer<typeof decisionAnswer>;

/** Raised when an answer does not match the decision it claims to answer. */
export class StaleDecisionAnswerError extends Error {
  public readonly decisionId: string;
  public readonly expectedRevision: number;
  public readonly actualRevision: number;

  public constructor(decisionId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Answer for decision ${decisionId} targets revision ${actualRevision} ` +
        `but the current request is at revision ${expectedRevision}`,
    );
    this.name = "StaleDecisionAnswerError";
    this.decisionId = decisionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * Raised when an answer references a different decision or case than the request
 * it is being applied to. This is a mismatch of identity, distinct from a stale
 * (older-revision) answer.
 */
export class DecisionMismatchError extends Error {
  public readonly field: "decision_id" | "case_id";
  public readonly expected: string;
  public readonly actual: string;

  public constructor(field: "decision_id" | "case_id", expected: string, actual: string) {
    super(`Answer ${field} "${actual}" does not match the request's "${expected}"`);
    this.name = "DecisionMismatchError";
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Raised when an answer selects an option that the request does not offer. */
export class UnknownDecisionOptionError extends Error {
  public readonly decisionId: string;
  public readonly selectedOptionId: string;
  public readonly availableOptionIds: readonly string[];

  public constructor(
    decisionId: string,
    selectedOptionId: string,
    availableOptionIds: readonly string[],
  ) {
    super(
      `Answer for decision ${decisionId} selected unknown option ` +
        `"${selectedOptionId}"; available: ${availableOptionIds.join(", ")}`,
    );
    this.name = "UnknownDecisionOptionError";
    this.decisionId = decisionId;
    this.selectedOptionId = selectedOptionId;
    this.availableOptionIds = availableOptionIds;
  }
}

/**
 * Validate that an answer applies to a given request. Each failure mode raises a
 * specific, typed error:
 *
 * - a different `decision_id` or `case_id` → {@link DecisionMismatchError};
 * - a mismatched `checkpoint_revision` → {@link StaleDecisionAnswerError};
 * - a `selected_option_id` the request does not offer →
 *   {@link UnknownDecisionOptionError}.
 */
export function assertAnswerMatchesRequest(request: DecisionRequest, answer: DecisionAnswer): void {
  if (answer.decision_id !== request.decision_id) {
    throw new DecisionMismatchError("decision_id", request.decision_id, answer.decision_id);
  }
  if (answer.case_id !== request.case_id) {
    throw new DecisionMismatchError("case_id", request.case_id, answer.case_id);
  }
  if (answer.checkpoint_revision !== request.checkpoint_revision) {
    throw new StaleDecisionAnswerError(
      request.decision_id,
      request.checkpoint_revision,
      answer.checkpoint_revision,
    );
  }
  const optionExists = request.options.some((o) => o.id === answer.selected_option_id);
  if (!optionExists) {
    throw new UnknownDecisionOptionError(
      request.decision_id,
      answer.selected_option_id,
      request.options.map((o) => o.id),
    );
  }
}
