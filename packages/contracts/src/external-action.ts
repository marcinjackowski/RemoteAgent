/**
 * `ExternalAction`, approval and receipt (Master Plan §5.6, §10).
 *
 * The model proposes an action; deterministic policy decides; a deterministic
 * executor performs it. The authoritative `target_scope`, `risk_tier` and
 * `policy_decision` are set outside the model. `action_digest` is the canonical
 * digest of `canonical_payload` and is what an approval is bound to.
 */
import * as z from "zod";

import { canonicalDigest, CanonicalJsonError } from "./canonical.js";
import { idString, isoTimestamp, text, valueObject, versionedContract } from "./common.js";
import { ExternalActionStatus, externalActionStatusSchema } from "./external-action-status.js";
import { PolicyDecision, policyDecisionSchema } from "./policy-decision.js";

export { ExternalActionStatus, externalActionStatusSchema } from "./external-action-status.js";
export { PolicyDecision, policyDecisionSchema } from "./policy-decision.js";

/** Risk tiers R0–R4 (Master Plan §10). */
export const RiskTier = {
  R0: "R0",
  R1: "R1",
  R2: "R2",
  R3: "R3",
  R4: "R4",
} as const;

export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier];

export const riskTierSchema = z.enum([
  RiskTier.R0,
  RiskTier.R1,
  RiskTier.R2,
  RiskTier.R3,
  RiskTier.R4,
]);

const actionDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * Strict JSON value: only strings, finite numbers, booleans, null, arrays and
 * plain objects are allowed. This keeps `canonical_payload` fully
 * canonicalizable — no `undefined`, no exotic/unknown values that could bypass
 * the digest check below.
 */
const jsonValue: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number().refine(Number.isFinite, "must be a finite number"),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/**
 * Owner-scoped, one-shot approval bound to an exact action digest
 * (Master Plan §10). Consumed once; checked at proposal and again just before
 * execution.
 */
export const approval = versionedContract({
  approval_id: idString,
  case_id: idString,
  /** The owner who granted it; approvals are owner-scoped. */
  granted_by: idString,
  /** Exact action digest this approval authorizes — no wildcard. */
  action_digest: actionDigest,
  granted_at: isoTimestamp,
  expires_at: isoTimestamp,
  /** True once the single-use grant has been consumed. */
  consumed: z.boolean().default(false),
  consumed_at: isoTimestamp.optional(),
}).superRefine((value, ctx) => {
  // A single-use grant must model only coherent consumed/unconsumed variants so
  // recovery can safely decide whether the grant may still be used:
  //   consumed === true   ⟺  consumed_at is present
  //   consumed === false  ⟺  consumed_at is absent
  // Either half being out of sync leaves an ambiguous one-shot state.
  //
  // NOTE (JSON Schema projection limitation): this iff relationship is a
  // cross-field invariant. `z.toJSONSchema` cannot express "consumed_at present
  // exactly when consumed is true", so the projected schema only advertises the
  // per-field types; the runtime Zod schema here is the authoritative validator.
  if (value.consumed && value.consumed_at === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["consumed_at"],
      message: "consumed_at is required when consumed is true",
    });
  }
  if (!value.consumed && value.consumed_at !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["consumed_at"],
      message: "consumed_at must be absent when consumed is false",
    });
  }

  // Expiry must be strictly later than the grant instant, otherwise the grant is
  // already expired (or inverted) at creation. Compared as real instants; both
  // fields are validated as ISO-8601 timestamps above.
  const grantedMs = Date.parse(value.granted_at);
  const expiresMs = Date.parse(value.expires_at);
  if (!Number.isNaN(grantedMs) && !Number.isNaN(expiresMs) && expiresMs <= grantedMs) {
    ctx.addIssue({
      code: "custom",
      path: ["expires_at"],
      message: "expires_at must be strictly later than granted_at",
    });
  }

  // A consumed one-shot grant must have been used inside its validity window:
  //   granted_at <= consumed_at < expires_at
  // Consumption before the grant, or at/after expiry, is a temporally
  // impossible state that recovery could otherwise mistake for an authorized
  // execution. Equality at expiry is rejected (the grant is expired at that
  // instant), matching the strict `expires_at > granted_at` rule above.
  if (value.consumed && value.consumed_at !== undefined) {
    const consumedMs = Date.parse(value.consumed_at);
    if (!Number.isNaN(consumedMs) && !Number.isNaN(grantedMs) && consumedMs < grantedMs) {
      ctx.addIssue({
        code: "custom",
        path: ["consumed_at"],
        message: "consumed_at must not be earlier than granted_at",
      });
    }
    if (!Number.isNaN(consumedMs) && !Number.isNaN(expiresMs) && consumedMs >= expiresMs) {
      ctx.addIssue({
        code: "custom",
        path: ["consumed_at"],
        message: "consumed_at must be strictly earlier than expires_at",
      });
    }
  }
});

export type Approval = z.infer<typeof approval>;

/**
 * Receipt returned by the external system on a successful side effect.
 *
 * This is a standalone, persisted boundary (it is stored and later replayed
 * during reconciliation), so it carries its own `schema_version` like every
 * other boundary contract rather than being an unversioned nested value.
 */
export const externalReceipt = versionedContract({
  /** Provider-native identifier of the produced/affected object. */
  external_id: idString,
  /** Provider status string, if any. */
  status: text.optional(),
  received_at: isoTimestamp,
});

export type ExternalReceipt = z.infer<typeof externalReceipt>;

export const externalAction = versionedContract({
  action_id: idString,
  case_id: idString,
  tool_name: idString,
  /** Authoritative target scope, assigned outside the model. */
  target_scope: valueObject({
    connection_id: idString,
    repo: idString.optional(),
  }),
  /** The exact, canonical payload that will be sent to the provider. */
  canonical_payload: z.record(z.string(), jsonValue),
  /** Canonical digest of `canonical_payload` (see canonical.ts). */
  action_digest: actionDigest,
  risk_tier: riskTierSchema,
  policy_decision: policyDecisionSchema,
  /** Present only when policy required (and an approval was granted). */
  approval_id: idString.nullable().default(null),
  /** Ensures at-most-once execution against the external system. */
  idempotency_key: idString,
  status: externalActionStatusSchema,
  external_receipt: externalReceipt.nullable().default(null),
}).superRefine((value, ctx) => {
  // The digest must be the canonical digest of the exact payload. This closes
  // the gap where a mismatched (or attacker-substituted) digest could authorize
  // an approval bound to a different payload. Any value that cannot be
  // canonicalized fails closed rather than silently bypassing the check.
  let expected: string;
  try {
    expected = canonicalDigest(value.canonical_payload);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      path: ["canonical_payload"],
      message:
        error instanceof CanonicalJsonError
          ? `canonical_payload is not canonicalizable: ${error.message}`
          : "canonical_payload is not canonicalizable",
    });
    return;
  }
  if (value.action_digest !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["action_digest"],
      message: "action_digest must equal the canonical digest of canonical_payload",
    });
  }

  // Fail-closed authorization/receipt invariants binding policy_decision,
  // approval_id, status and external_receipt. The model is not the authorization
  // layer (AGENTS.md §6) and a write without a confirmed receipt stays AMBIGUOUS,
  // never SUCCESS (EXECUTION_AND_AUDIT §evidence).
  //
  // NOTE (JSON Schema projection limitation): these are cross-field invariants
  // over policy_decision/status/approval_id/external_receipt. `z.toJSONSchema`
  // cannot express them, so the projected schema advertises only the per-field
  // shapes; this runtime Zod schema is the authoritative validator.
  const status = value.status;
  const policy = value.policy_decision;

  // R4 (merge, force-push, delete, prod deploy, permissions) always requires an
  // exact approval (Master Plan §10). AUTO_ALLOW is therefore impossible for an
  // R4 action regardless of status; it fails closed. R4 + DENY and
  // R4 + REQUIRES_APPROVAL remain legal and are governed by the other invariants.
  if (value.risk_tier === RiskTier.R4 && policy === PolicyDecision.AUTO_ALLOW) {
    ctx.addIssue({
      code: "custom",
      path: ["policy_decision"],
      message:
        "risk_tier=R4 always requires an exact approval: policy_decision=AUTO_ALLOW is not allowed for R4",
    });
  }

  // A denied action is not executable: it may only stay PROPOSED or become
  // REJECTED. It can never enter APPROVED/EXECUTING/SUCCEEDED/FAILED/AMBIGUOUS.
  if (
    policy === PolicyDecision.DENY &&
    status !== ExternalActionStatus.PROPOSED &&
    status !== ExternalActionStatus.REJECTED
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message:
        "policy_decision=DENY is not executable: status must be PROPOSED or REJECTED, never APPROVED/EXECUTING/SUCCEEDED/FAILED/AMBIGUOUS",
    });
  }

  // approval_id is meaningful only when policy required an approval. AUTO_ALLOW
  // and DENY must not carry one.
  if (policy !== PolicyDecision.REQUIRES_APPROVAL && value.approval_id !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["approval_id"],
      message: "approval_id is only allowed when policy_decision=REQUIRES_APPROVAL",
    });
  }

  // AUTO_ALLOW executes via the PROPOSED -> EXECUTING shortcut. It never enters
  // APPROVED (reserved for the REQUIRES_APPROVAL path) and never enters REJECTED
  // (which represents a denied action or a rejected approval path). A persisted
  // AUTO_ALLOW action in either state is impossible and fails closed, matching
  // the policy-aware transition guard.
  if (
    policy === PolicyDecision.AUTO_ALLOW &&
    (status === ExternalActionStatus.APPROVED || status === ExternalActionStatus.REJECTED)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message:
        "policy_decision=AUTO_ALLOW never enters APPROVED or REJECTED: it executes via the PROPOSED -> EXECUTING shortcut",
    });
  }

  // REQUIRES_APPROVAL binds approval_id to the status exactly: it must be null in
  // PROPOSED/REJECTED (no approval granted yet, or the approval path was
  // rejected) and present in every post-approval state
  // (APPROVED/EXECUTING/SUCCEEDED/FAILED/AMBIGUOUS).
  const postApprovalStates = new Set<ExternalActionStatus>([
    ExternalActionStatus.APPROVED,
    ExternalActionStatus.EXECUTING,
    ExternalActionStatus.SUCCEEDED,
    ExternalActionStatus.FAILED,
    ExternalActionStatus.AMBIGUOUS,
  ]);
  if (policy === PolicyDecision.REQUIRES_APPROVAL) {
    if (postApprovalStates.has(status) && value.approval_id === null) {
      ctx.addIssue({
        code: "custom",
        path: ["approval_id"],
        message:
          "policy_decision=REQUIRES_APPROVAL cannot enter APPROVED/EXECUTING/SUCCEEDED/FAILED/AMBIGUOUS without an approval_id",
      });
    }
    if (
      (status === ExternalActionStatus.PROPOSED || status === ExternalActionStatus.REJECTED) &&
      value.approval_id !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["approval_id"],
        message:
          "policy_decision=REQUIRES_APPROVAL must have a null approval_id in PROPOSED/REJECTED (before an approval is granted or after the approval path is rejected)",
      });
    }
  }

  // A confirmed success requires a receipt; conversely a receipt exists only on
  // SUCCEEDED. In particular an unconfirmed write after start stays AMBIGUOUS
  // and must not carry a receipt or be reported as SUCCEEDED.
  if (status === ExternalActionStatus.SUCCEEDED && value.external_receipt === null) {
    ctx.addIssue({
      code: "custom",
      path: ["external_receipt"],
      message:
        "status=SUCCEEDED requires an external_receipt; a write without a confirmed receipt stays AMBIGUOUS",
    });
  }
  if (status !== ExternalActionStatus.SUCCEEDED && value.external_receipt !== null) {
    ctx.addIssue({
      code: "custom",
      path: ["external_receipt"],
      message:
        "external_receipt is only present on SUCCEEDED; unconfirmed or non-success states must not carry a receipt",
    });
  }
});

export type ExternalAction = z.infer<typeof externalAction>;

/** External-action lifecycle machine (embeds the run-safety AMBIGUOUS state). */
export {
  externalActionStatusMachine,
  assertExternalActionTransition,
  PolicyTransitionError,
} from "./external-action-machine.js";
export type { ExternalActionPolicyDecision } from "./external-action-machine.js";
