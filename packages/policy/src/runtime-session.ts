/**
 * Managed runtime sessions are transport, never authority (RA-023-WU-04, AC6).
 *
 * WHAT THE VENDOR DOCS ACTUALLY SAY, verified `2026-08-21` and recorded in
 * `docs/research/RA-023-CAPABILITY-MATRIX.md`:
 *
 *   * "By default, the compute (microVM) associated with a session is ephemeral. Any data
 *     stored in memory or written to disk persists only for the compute lifecycle."
 *   * Stopped by "inactivity (default 15 minutes)", capped at 8 hours per microVM
 *     lifecycle.
 *   * "After session completion, the entire microVM is terminated and memory is
 *     sanitized."
 *   * "AgentCore does not enforce session-to-user mappings - your client backend should
 *     maintain the relationship between users and their session IDs."
 *
 * That last quote is the load-bearing one. The service explicitly declines to own the
 * identity mapping, so treating a session id as evidence of WHOSE case it is would be
 * relying on a guarantee the vendor states it does not provide.
 *
 * ADR-0008 defers adopting AgentCore, so nothing here calls AWS. The module exists anyway
 * because the rule generalizes: any managed runtime, worker pool or sandbox that can be
 * recycled between invocations creates the same hazard, and the containment is the same.
 *
 * THE INVARIANT: a session may CARRY a case's state and may CACHE it. It may never be the
 * reason we believe something about the case. Every field a session hands back is either
 * (a) verified against Postgres, or (b) discarded. There is deliberately no third option
 * and no "trusted session" mode.
 */

/** A managed runtime session as the service describes it. Every field is untrusted. */
export interface RuntimeSessionClaim {
  /** The session id the runtime reports. */
  sessionId: string;
  /**
   * The case this session claims to be working on.
   *
   * `unknown`, not `string`, because the vendor states it does not enforce
   * session-to-user mappings. A session id is an opaque routing token; treating its
   * claimed case as authoritative is the exact gap the docs warn about.
   */
  claimedCaseId?: unknown;
  /** A checkpoint revision the session believes it is at. */
  claimedCheckpointRevision?: unknown;
  /** A fencing token the session believes it holds. */
  claimedFencingToken?: unknown;
}

/** The durable truth, read from Postgres inside the caller's transaction. */
export interface DurableCaseState {
  caseId: string;
  ownerId: string;
  checkpointRevision: number;
  /** The lease owner Postgres currently records, or null when the case is unheld. */
  leaseOwner: string | null;
  fencingToken: number | null;
}

export const SessionRefusalCode = {
  /** The session claimed a case other than the one we resolved from durable state. */
  CASE_MISMATCH: "CASE_MISMATCH",
  /** The session's revision is behind durable state: it resumed onto a moved case. */
  STALE_REVISION: "STALE_REVISION",
  /**
   * The session's revision is AHEAD of durable state. This is worse than stale: it means
   * the session did work that was never committed, so its in-memory state describes
   * something that did not durably happen.
   */
  UNCOMMITTED_AHEAD: "UNCOMMITTED_AHEAD",
  /** The session's fencing token is not the one Postgres records: it was taken over. */
  FENCE_LOST: "FENCE_LOST",
  /** Durable state has no lease at all, so no session may claim to hold one. */
  NO_DURABLE_LEASE: "NO_DURABLE_LEASE",
} as const;

export type SessionRefusalCode = (typeof SessionRefusalCode)[keyof typeof SessionRefusalCode];

/**
 * The outcome of reconciling a session claim against durable state.
 *
 * `RESUMABLE` carries the DURABLE state, not the claimed state — so a caller that uses
 * the result cannot accidentally propagate a session's belief. `REBUILD_REQUIRED` is not
 * an error: it is the normal outcome of the runtime recycling a microVM, which the docs
 * say happens after 15 minutes of inactivity.
 */
export type SessionReconciliation =
  | { outcome: "RESUMABLE"; state: DurableCaseState }
  | {
      outcome: "REBUILD_REQUIRED";
      state: DurableCaseState;
      code: SessionRefusalCode;
      reason: string;
    };

/**
 * Reconcile what a session claims against what Postgres knows.
 *
 * Deliberately returns `REBUILD_REQUIRED` rather than throwing for every mismatch: a
 * recycled session is expected operation, not an exception, and making the normal path
 * throw would push callers toward catching broadly and continuing — which is how a
 * mismatch becomes a silent resume.
 *
 * The caller must have read `durable` inside a transaction. This function cannot enforce
 * that (it takes data, not a handle), so the requirement is stated here and exercised in
 * the integration test, which reads through a real transaction.
 */
export function reconcileSession(
  claim: RuntimeSessionClaim,
  durable: DurableCaseState,
): SessionReconciliation {
  const rebuild = (code: SessionRefusalCode, reason: string): SessionReconciliation => ({
    outcome: "REBUILD_REQUIRED",
    // Always the DURABLE state, so a caller cannot propagate the session's belief even by
    // accident.
    state: durable,
    code,
    reason,
  });

  // 1. Identity first. A session claiming a different case is not stale, it is pointed at
  //    the wrong thing — and continuing would apply one case's work to another. Checked
  //    before anything else because every subsequent comparison would otherwise be
  //    comparing across cases.
  //
  //    A session that claims NO case is fine: it carries no belief to contradict, which is
  //    exactly the shape a freshly-provisioned microVM has.
  if (claim.claimedCaseId !== undefined && claim.claimedCaseId !== durable.caseId) {
    return rebuild(
      SessionRefusalCode.CASE_MISMATCH,
      `session ${claim.sessionId} claims case ${String(claim.claimedCaseId)} but durable state is case ${durable.caseId}`,
    );
  }

  // 2. A claimed fencing token must match the one Postgres records. This is the
  //    single-writer guarantee (`AGENTS.md` §7): if another worker took the lease, this
  //    session's token is stale and it must not write, whatever its memory says.
  if (claim.claimedFencingToken !== undefined) {
    if (durable.fencingToken === null || durable.leaseOwner === null) {
      return rebuild(
        SessionRefusalCode.NO_DURABLE_LEASE,
        `session ${claim.sessionId} claims a fencing token but durable state records no lease for case ${durable.caseId}`,
      );
    }
    if (claim.claimedFencingToken !== durable.fencingToken) {
      return rebuild(
        SessionRefusalCode.FENCE_LOST,
        `session ${claim.sessionId} holds fencing token ${String(claim.claimedFencingToken)} but durable state is at ${durable.fencingToken}`,
      );
    }
  }

  // 3. Revision. Behind and ahead are DIFFERENT failures and are reported separately,
  //    because they need different operator responses: behind means "reload and continue",
  //    ahead means "work was lost, investigate". Collapsing them into "mismatch" would
  //    hide the second, which is the one that indicates data loss.
  if (claim.claimedCheckpointRevision !== undefined) {
    const claimed = claim.claimedCheckpointRevision;
    if (typeof claimed !== "number" || !Number.isInteger(claimed)) {
      // A non-integer revision is uninterpretable, so it cannot be compared. Fail closed
      // rather than coercing: `Number("3")` succeeding would let a string claim resume.
      return rebuild(
        SessionRefusalCode.STALE_REVISION,
        `session ${claim.sessionId} reported a non-integer checkpoint revision ${String(claimed)}`,
      );
    }
    if (claimed < durable.checkpointRevision) {
      return rebuild(
        SessionRefusalCode.STALE_REVISION,
        `session ${claim.sessionId} is at revision ${claimed} but durable state is at ${durable.checkpointRevision}`,
      );
    }
    if (claimed > durable.checkpointRevision) {
      return rebuild(
        SessionRefusalCode.UNCOMMITTED_AHEAD,
        `session ${claim.sessionId} claims revision ${claimed}, ahead of durable ${durable.checkpointRevision}: its work was never committed`,
      );
    }
  }

  return { outcome: "RESUMABLE", state: durable };
}

/**
 * Assert that a reconciliation result carries only durable values.
 *
 * The second, independent statement of the invariant, matching the pattern used for
 * `assertR4NeverAutoAllowed` (RA-022) and `assertNoWidening` (WU-05). The failure mode
 * here — a session's belief silently becoming the system's belief — leaves no trace to
 * diagnose afterwards, so it gets two mechanisms.
 *
 * @throws {Error} if the result's state diverges from durable state in any field.
 */
export function assertSessionCarriesNoAuthority(
  result: SessionReconciliation,
  durable: DurableCaseState,
): void {
  const state = result.state;
  if (state.caseId !== durable.caseId) {
    throw new Error(
      `AC6 violation: reconciliation returned case ${state.caseId}, not durable ${durable.caseId}`,
    );
  }
  if (state.ownerId !== durable.ownerId) {
    throw new Error(
      `AC6 violation: reconciliation returned owner ${state.ownerId}, not durable ${durable.ownerId}`,
    );
  }
  if (state.checkpointRevision !== durable.checkpointRevision) {
    throw new Error(
      `AC6 violation: reconciliation returned revision ${state.checkpointRevision}, not durable ${durable.checkpointRevision}`,
    );
  }
  if (state.fencingToken !== durable.fencingToken) {
    throw new Error(
      `AC6 violation: reconciliation returned fencing token ${String(state.fencingToken)}, not durable ${String(durable.fencingToken)}`,
    );
  }
}
