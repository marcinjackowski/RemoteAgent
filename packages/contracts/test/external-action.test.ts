import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/canonical.js";
import { CURRENT_SCHEMA_VERSION } from "../src/common.js";
import {
  externalAction,
  approval,
  ExternalActionStatus,
  RiskTier,
  PolicyDecision,
} from "../src/external-action.js";

describe("ExternalAction", () => {
  const payload = { field_b: 2, field_a: 1, nested: { y: 2, x: 1 } };
  const digest = canonicalDigest(payload);

  const action = {
    schema_version: CURRENT_SCHEMA_VERSION,
    action_id: "act-1",
    case_id: "c-1",
    tool_name: "gitlab.create_mr",
    target_scope: { connection_id: "conn-1", repo: "group/proj" },
    canonical_payload: payload,
    action_digest: digest,
    risk_tier: RiskTier.R2,
    policy_decision: PolicyDecision.REQUIRES_APPROVAL,
    idempotency_key: "idem-1",
    status: ExternalActionStatus.PROPOSED,
  };

  it("parses a proposed action and defaults nullable fields", () => {
    const parsed = externalAction.parse(action);
    expect(parsed.approval_id).toBeNull();
    expect(parsed.external_receipt).toBeNull();
  });

  it("action_digest matches the canonical digest regardless of key order", () => {
    const reordered = { nested: { x: 1, y: 2 }, field_a: 1, field_b: 2 };
    expect(canonicalDigest(reordered)).toBe(action.action_digest);
  });

  it("rejects a malformed digest", () => {
    expect(externalAction.safeParse({ ...action, action_digest: "notadigest" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown top-level field (fail-closed)", () => {
    expect(externalAction.safeParse({ ...action, backdoor: true }).success).toBe(false);
  });

  it("rejects an action_digest that does not match canonical_payload", () => {
    // A well-formed but wrong digest (of a different payload) must be rejected so
    // an approval bound to one digest cannot authorize a different payload.
    const wrongDigest = canonicalDigest({ ...payload, tampered: true });
    const res = externalAction.safeParse({
      ...action,
      action_digest: wrongDigest,
    });
    expect(res.success).toBe(false);
  });

  it("accepts the action only when the digest matches after key reordering", () => {
    const reordered = { nested: { x: 1, y: 2 }, field_a: 1, field_b: 2 };
    const res = externalAction.safeParse({
      ...action,
      canonical_payload: reordered,
      action_digest: canonicalDigest(reordered),
    });
    expect(res.success).toBe(true);
  });

  it("rejects a non-canonicalizable payload value (no exotic bypass)", () => {
    // A non-finite number cannot be canonicalized; it must fail closed rather
    // than slip past the digest check.
    const res = externalAction.safeParse({
      ...action,
      canonical_payload: { field_a: Number.POSITIVE_INFINITY },
      action_digest: `sha256:${"a".repeat(64)}`,
    });
    expect(res.success).toBe(false);
  });
});

describe("ExternalAction fail-closed authorization/receipt invariants", () => {
  const payload = { a: 1 };
  const digest = canonicalDigest(payload);
  const receipt = {
    schema_version: CURRENT_SCHEMA_VERSION,
    external_id: "mr-1",
    received_at: "2026-01-01T00:00:00Z",
  };

  const base = {
    schema_version: CURRENT_SCHEMA_VERSION,
    action_id: "act-1",
    case_id: "c-1",
    tool_name: "gitlab.create_mr",
    target_scope: { connection_id: "conn-1" },
    canonical_payload: payload,
    action_digest: digest,
    risk_tier: RiskTier.R3,
    idempotency_key: "idem-1",
  };

  it("DENY is not executable: EXECUTING is rejected", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.DENY,
      status: ExternalActionStatus.EXECUTING,
    });
    expect(res.success).toBe(false);
  });

  it("DENY is not executable: APPROVED and SUCCEEDED are rejected", () => {
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.APPROVED,
      }).success,
    ).toBe(false);
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.SUCCEEDED,
        external_receipt: receipt,
      }).success,
    ).toBe(false);
  });

  it("DENY may stay PROPOSED or become REJECTED", () => {
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.PROPOSED,
      }).success,
    ).toBe(true);
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.REJECTED,
      }).success,
    ).toBe(true);
  });

  it("REQUIRES_APPROVAL cannot execute without an approval_id", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.REQUIRES_APPROVAL,
      status: ExternalActionStatus.EXECUTING,
      approval_id: null,
    });
    expect(res.success).toBe(false);
  });

  it("REQUIRES_APPROVAL executes only with a bound approval_id", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.REQUIRES_APPROVAL,
      status: ExternalActionStatus.EXECUTING,
      approval_id: "ap-1",
    });
    expect(res.success).toBe(true);
  });

  it("approval_id is forbidden for AUTO_ALLOW and DENY", () => {
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.AUTO_ALLOW,
        status: ExternalActionStatus.PROPOSED,
        approval_id: "ap-1",
      }).success,
    ).toBe(false);
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.PROPOSED,
        approval_id: "ap-1",
      }).success,
    ).toBe(false);
  });

  it("AUTO_ALLOW never persists in APPROVED (reserved for the approval path)", () => {
    // AUTO_ALLOW executes via PROPOSED -> EXECUTING; a persisted APPROVED state
    // is impossible and must fail closed, matching the transition guard.
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.AUTO_ALLOW,
      status: ExternalActionStatus.APPROVED,
    });
    expect(res.success).toBe(false);
  });

  it("SUCCEEDED requires an external_receipt (write without receipt is not SUCCESS)", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.AUTO_ALLOW,
      status: ExternalActionStatus.SUCCEEDED,
      external_receipt: null,
    });
    expect(res.success).toBe(false);
  });

  it("SUCCEEDED with a receipt is accepted", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.AUTO_ALLOW,
      status: ExternalActionStatus.SUCCEEDED,
      external_receipt: receipt,
    });
    expect(res.success).toBe(true);
  });

  it("AMBIGUOUS (unconfirmed after start) must not carry a receipt", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.AUTO_ALLOW,
      status: ExternalActionStatus.AMBIGUOUS,
      external_receipt: receipt,
    });
    expect(res.success).toBe(false);
  });

  it("a non-SUCCEEDED state (EXECUTING) must not carry a receipt", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.AUTO_ALLOW,
      status: ExternalActionStatus.EXECUTING,
      external_receipt: receipt,
    });
    expect(res.success).toBe(false);
  });
});

describe("ExternalAction policy/status/risk matrix", () => {
  const payload = { a: 1 };
  const digest = canonicalDigest(payload);
  const receipt = {
    schema_version: CURRENT_SCHEMA_VERSION,
    external_id: "mr-1",
    received_at: "2026-01-01T00:00:00Z",
  };

  // Base R2 action (R2 permits AUTO_ALLOW); risk_tier is overridden per test.
  const base = {
    schema_version: CURRENT_SCHEMA_VERSION,
    action_id: "act-1",
    case_id: "c-1",
    tool_name: "gitlab.create_mr",
    target_scope: { connection_id: "conn-1" },
    canonical_payload: payload,
    action_digest: digest,
    risk_tier: RiskTier.R2,
    idempotency_key: "idem-1",
  };

  // --- Issue 1: R4 always requires an exact approval (Master Plan §10) --------

  it("R4 + AUTO_ALLOW is rejected regardless of status", () => {
    for (const status of [
      ExternalActionStatus.PROPOSED,
      ExternalActionStatus.EXECUTING,
      ExternalActionStatus.SUCCEEDED,
    ]) {
      const res = externalAction.safeParse({
        ...base,
        risk_tier: RiskTier.R4,
        policy_decision: PolicyDecision.AUTO_ALLOW,
        status,
        ...(status === ExternalActionStatus.SUCCEEDED ? { external_receipt: receipt } : {}),
      });
      expect(res.success, `R4+AUTO_ALLOW in ${status} must be rejected`).toBe(false);
    }
  });

  it("R4 + DENY remains legal (PROPOSED/REJECTED)", () => {
    expect(
      externalAction.safeParse({
        ...base,
        risk_tier: RiskTier.R4,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.PROPOSED,
      }).success,
    ).toBe(true);
    expect(
      externalAction.safeParse({
        ...base,
        risk_tier: RiskTier.R4,
        policy_decision: PolicyDecision.DENY,
        status: ExternalActionStatus.REJECTED,
      }).success,
    ).toBe(true);
  });

  it("R4 + REQUIRES_APPROVAL remains legal (via APPROVED with approval_id)", () => {
    expect(
      externalAction.safeParse({
        ...base,
        risk_tier: RiskTier.R4,
        policy_decision: PolicyDecision.REQUIRES_APPROVAL,
        status: ExternalActionStatus.PROPOSED,
      }).success,
    ).toBe(true);
    expect(
      externalAction.safeParse({
        ...base,
        risk_tier: RiskTier.R4,
        policy_decision: PolicyDecision.REQUIRES_APPROVAL,
        status: ExternalActionStatus.APPROVED,
        approval_id: "ap-1",
      }).success,
    ).toBe(true);
  });

  it("R4 with a lower-tier policy (R3 AUTO_ALLOW) stays allowed — only R4 blocks AUTO_ALLOW", () => {
    expect(
      externalAction.safeParse({
        ...base,
        risk_tier: RiskTier.R3,
        policy_decision: PolicyDecision.AUTO_ALLOW,
        status: ExternalActionStatus.EXECUTING,
      }).success,
    ).toBe(true);
  });

  // --- Issue 2: AUTO_ALLOW never enters REJECTED (nor APPROVED) ---------------

  it("AUTO_ALLOW + REJECTED is rejected", () => {
    const res = externalAction.safeParse({
      ...base,
      policy_decision: PolicyDecision.AUTO_ALLOW,
      status: ExternalActionStatus.REJECTED,
    });
    expect(res.success).toBe(false);
  });

  it("AUTO_ALLOW executes via the shortcut (PROPOSED/EXECUTING accepted)", () => {
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.AUTO_ALLOW,
        status: ExternalActionStatus.PROPOSED,
      }).success,
    ).toBe(true);
    expect(
      externalAction.safeParse({
        ...base,
        policy_decision: PolicyDecision.AUTO_ALLOW,
        status: ExternalActionStatus.EXECUTING,
      }).success,
    ).toBe(true);
  });

  // --- Issue 3: REQUIRES_APPROVAL binds approval_id to status exactly ---------

  it("REQUIRES_APPROVAL requires a null approval_id in PROPOSED and REJECTED", () => {
    // Positive: null approval_id is accepted in PROPOSED/REJECTED.
    for (const status of [ExternalActionStatus.PROPOSED, ExternalActionStatus.REJECTED]) {
      expect(
        externalAction.safeParse({
          ...base,
          policy_decision: PolicyDecision.REQUIRES_APPROVAL,
          status,
          approval_id: null,
        }).success,
        `REQUIRES_APPROVAL null approval_id in ${status} must be accepted`,
      ).toBe(true);
    }
    // Negative: a bound approval_id in PROPOSED/REJECTED is rejected.
    for (const status of [ExternalActionStatus.PROPOSED, ExternalActionStatus.REJECTED]) {
      expect(
        externalAction.safeParse({
          ...base,
          policy_decision: PolicyDecision.REQUIRES_APPROVAL,
          status,
          approval_id: "ap-1",
        }).success,
        `REQUIRES_APPROVAL with approval_id in ${status} must be rejected`,
      ).toBe(false);
    }
  });

  it("REQUIRES_APPROVAL requires a bound approval_id in every post-approval state", () => {
    const postApproval = [
      ExternalActionStatus.APPROVED,
      ExternalActionStatus.EXECUTING,
      ExternalActionStatus.SUCCEEDED,
      ExternalActionStatus.FAILED,
      ExternalActionStatus.AMBIGUOUS,
    ];
    for (const status of postApproval) {
      const extra = status === ExternalActionStatus.SUCCEEDED ? { external_receipt: receipt } : {};
      // Positive: with approval_id.
      expect(
        externalAction.safeParse({
          ...base,
          policy_decision: PolicyDecision.REQUIRES_APPROVAL,
          status,
          approval_id: "ap-1",
          ...extra,
        }).success,
        `REQUIRES_APPROVAL with approval_id in ${status} must be accepted`,
      ).toBe(true);
      // Negative: without approval_id.
      expect(
        externalAction.safeParse({
          ...base,
          policy_decision: PolicyDecision.REQUIRES_APPROVAL,
          status,
          approval_id: null,
          ...extra,
        }).success,
        `REQUIRES_APPROVAL without approval_id in ${status} must be rejected`,
      ).toBe(false);
    }
  });
});

describe("Approval", () => {
  it("is single-use and bound to an exact digest", () => {
    const parsed = approval.parse({
      schema_version: CURRENT_SCHEMA_VERSION,
      approval_id: "ap-1",
      case_id: "c-1",
      granted_by: "owner",
      action_digest: `sha256:${"a".repeat(64)}`,
      granted_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-01T01:00:00Z",
    });
    expect(parsed.consumed).toBe(false);
  });

  it("rejects a wildcard-ish digest", () => {
    expect(
      approval.safeParse({
        schema_version: CURRENT_SCHEMA_VERSION,
        approval_id: "ap-1",
        case_id: "c-1",
        granted_by: "owner",
        action_digest: "*",
        granted_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-01T01:00:00Z",
      }).success,
    ).toBe(false);
  });

  const validGrant = {
    schema_version: CURRENT_SCHEMA_VERSION,
    approval_id: "ap-1",
    case_id: "c-1",
    granted_by: "owner",
    action_digest: `sha256:${"a".repeat(64)}`,
    granted_at: "2026-01-01T00:00:00Z",
    expires_at: "2026-01-01T01:00:00Z",
  };

  it("consumed=true requires consumed_at (coherent consumed variant)", () => {
    expect(approval.safeParse({ ...validGrant, consumed: true }).success).toBe(false);
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: true,
        consumed_at: "2026-01-01T00:30:00Z",
      }).success,
    ).toBe(true);
  });

  it("consumed=false forbids consumed_at (coherent unconsumed variant)", () => {
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: false,
        consumed_at: "2026-01-01T00:30:00Z",
      }).success,
    ).toBe(false);
    expect(approval.safeParse({ ...validGrant, consumed: false }).success).toBe(true);
  });

  it("requires expires_at strictly later than granted_at", () => {
    // Equal instants are rejected.
    expect(
      approval.safeParse({
        ...validGrant,
        granted_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    // Expiry before grant is rejected.
    expect(
      approval.safeParse({
        ...validGrant,
        granted_at: "2026-01-01T01:00:00Z",
        expires_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    // Strictly later is accepted.
    expect(
      approval.safeParse({
        ...validGrant,
        granted_at: "2026-01-01T00:00:00Z",
        expires_at: "2026-01-01T00:00:01Z",
      }).success,
    ).toBe(true);
  });

  it("rejects a consumed grant used before it was granted", () => {
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: true,
        consumed_at: "2025-12-31T23:59:59Z",
      }).success,
    ).toBe(false);
  });

  it("accepts consumption exactly at granted_at (lower boundary, inclusive)", () => {
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: true,
        consumed_at: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("rejects consumption at or after expiry (upper boundary, exclusive)", () => {
    // Exactly at expiry is rejected: the grant is expired at that instant.
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: true,
        consumed_at: "2026-01-01T01:00:00Z",
      }).success,
    ).toBe(false);
    // After expiry is rejected.
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: true,
        consumed_at: "2026-01-01T01:00:01Z",
      }).success,
    ).toBe(false);
  });

  it("accepts consumption strictly inside the validity window", () => {
    expect(
      approval.safeParse({
        ...validGrant,
        consumed: true,
        consumed_at: "2026-01-01T00:30:00Z",
      }).success,
    ).toBe(true);
  });
});
