/**
 * External-action lifecycle state machine.
 *
 * Kept in its own module to avoid a circular re-export inside
 * `external-action.ts`. Following Master Plan §6.2 run safety, a write that
 * cannot be reconciled enters `AMBIGUOUS`, which stops *automatic* replay. Unlike
 * the run-safety machine — where `AMBIGUOUS` is fully terminal — an external
 * action may still be resolved by *manual* reconciliation to `SUCCEEDED` or
 * `FAILED`; there is no automatic transition out of it.
 */
import { defineStateMachine } from "./state-machine.js";
import { ExternalActionStatus } from "./external-action-status.js";
import { PolicyDecision, policyDecisionSchema } from "./policy-decision.js";

export const externalActionStatusMachine = defineStateMachine<ExternalActionStatus>(
  "ExternalAction",
  {
    [ExternalActionStatus.PROPOSED]: [
      ExternalActionStatus.APPROVED,
      ExternalActionStatus.REJECTED,
      // R0/R1 auto-allow can go straight to executing.
      ExternalActionStatus.EXECUTING,
    ],
    [ExternalActionStatus.APPROVED]: [ExternalActionStatus.EXECUTING],
    [ExternalActionStatus.REJECTED]: [],
    [ExternalActionStatus.EXECUTING]: [
      ExternalActionStatus.SUCCEEDED,
      ExternalActionStatus.FAILED,
      ExternalActionStatus.AMBIGUOUS,
    ],
    [ExternalActionStatus.SUCCEEDED]: [],
    [ExternalActionStatus.FAILED]: [],
    // AMBIGUOUS stops automatic replay; only manual reconciliation resolves it.
    [ExternalActionStatus.AMBIGUOUS]: [ExternalActionStatus.SUCCEEDED, ExternalActionStatus.FAILED],
  },
);

/**
 * Policy decision accepted by the transition guard. This is the single source
 * of truth `PolicyDecision` (from `policy-decision.ts`), not a hand-rewritten
 * copy, so the guard's accepted decisions can never drift from the runtime
 * schema used by the `ExternalAction` contract.
 */
export type ExternalActionPolicyDecision = PolicyDecision;

/**
 * Typed error raised when a structurally-valid transition is forbidden by the
 * action's policy decision. This is distinct from a structural
 * {@link InvalidTransitionError}: the shape of the transition is legal, but the
 * policy (the authoritative authorization layer, not the model) does not permit
 * it. It is also raised fail-closed for an unknown/unvalidated policy value.
 */
export class PolicyTransitionError extends Error {
  public readonly from: ExternalActionStatus;
  public readonly to: ExternalActionStatus;
  public readonly policyDecision: string;

  public constructor(
    from: ExternalActionStatus,
    to: ExternalActionStatus,
    policyDecision: string,
    reason: string,
  ) {
    super(
      `Policy-forbidden ExternalAction transition under ${policyDecision}: ` +
        `${from} -> ${to}. ${reason}`,
    );
    this.name = "PolicyTransitionError";
    this.from = from;
    this.to = to;
    this.policyDecision = policyDecision;
  }
}

/**
 * Policy-aware transition guard. First enforces the structural machine (throws
 * {@link InvalidTransitionError} for an illegal shape), then validates the
 * policy decision exhaustively at runtime and applies fail-closed policy
 * constraints so the transition set actually available depends on the
 * authoritative `policyDecision`:
 *
 * - unknown/unvalidated decision: rejected fail-closed with a typed
 *   {@link PolicyTransitionError}. A TypeScript type is not a runtime
 *   authorization layer.
 * - `DENY`: the only permitted transition is `PROPOSED -> REJECTED`. A denied
 *   action can never be approved or executed.
 * - `REQUIRES_APPROVAL`: the auto-allow shortcut `PROPOSED -> EXECUTING` is
 *   forbidden; execution must be reached via `APPROVED`.
 * - `AUTO_ALLOW`: executes via `PROPOSED -> EXECUTING` and never enters the
 *   APPROVED state (reserved for the approval path) nor REJECTED (reserved for a
 *   denied action or a rejected approval path).
 *
 * Returns `to` on success, mirroring `assertTransition`, and never mutates input.
 */
export function assertExternalActionTransition(
  from: ExternalActionStatus,
  to: ExternalActionStatus,
  policyDecision: ExternalActionPolicyDecision,
): ExternalActionStatus {
  externalActionStatusMachine.assertTransition(from, to);

  // Fail-closed: validate the policy decision at runtime. A value outside the
  // known union (e.g. an unvalidated caller or a future extension) must not slip
  // through to a permissive branch.
  const decision = policyDecisionSchema.safeParse(policyDecision);
  if (!decision.success) {
    throw new PolicyTransitionError(
      from,
      to,
      String(policyDecision),
      "Unknown policy_decision; a policy-aware transition must fail closed.",
    );
  }

  const decisionValue = decision.data;
  switch (decisionValue) {
    case PolicyDecision.DENY: {
      if (!(from === ExternalActionStatus.PROPOSED && to === ExternalActionStatus.REJECTED)) {
        throw new PolicyTransitionError(
          from,
          to,
          decisionValue,
          "A denied action may only transition PROPOSED -> REJECTED.",
        );
      }
      return to;
    }
    case PolicyDecision.REQUIRES_APPROVAL: {
      if (from === ExternalActionStatus.PROPOSED && to === ExternalActionStatus.EXECUTING) {
        throw new PolicyTransitionError(
          from,
          to,
          decisionValue,
          "Execution requires a granted approval; reach EXECUTING via APPROVED.",
        );
      }
      return to;
    }
    case PolicyDecision.AUTO_ALLOW: {
      if (to === ExternalActionStatus.APPROVED || to === ExternalActionStatus.REJECTED) {
        throw new PolicyTransitionError(
          from,
          to,
          decisionValue,
          "AUTO_ALLOW never enters APPROVED or REJECTED; it executes via the PROPOSED -> EXECUTING shortcut.",
        );
      }
      return to;
    }
    default: {
      // Exhaustiveness guard: all PolicyDecision variants are handled above, so
      // this branch is unreachable per the type system. If a new variant is
      // added without a case, `decisionValue` is no longer `never` and this
      // assignment fails at compile time; at runtime it still fails closed.
      const _exhaustive: never = decisionValue;
      throw new PolicyTransitionError(
        from,
        to,
        String(_exhaustive),
        "Unhandled policy_decision; a policy-aware transition must fail closed.",
      );
    }
  }
}
