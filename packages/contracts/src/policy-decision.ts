/**
 * Policy decision enum, factored out so the `ExternalAction` schema and the
 * policy-aware transition guard both import a single source of truth without a
 * circular dependency (mirrors `external-action-status.ts`). Duplicating this
 * union would let the guard's accepted decisions drift from the runtime schema.
 */
import * as z from "zod";

export const PolicyDecision = {
  AUTO_ALLOW: "AUTO_ALLOW",
  REQUIRES_APPROVAL: "REQUIRES_APPROVAL",
  DENY: "DENY",
} as const;

export type PolicyDecision = (typeof PolicyDecision)[keyof typeof PolicyDecision];

export const policyDecisionSchema = z.enum([
  PolicyDecision.AUTO_ALLOW,
  PolicyDecision.REQUIRES_APPROVAL,
  PolicyDecision.DENY,
]);
