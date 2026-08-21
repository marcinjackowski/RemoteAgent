/**
 * Post-restore reconciliation (RA-025-WU-09, AC4 and AC5).
 *
 * AC5: "after a restore, no ambiguous write is automatically repeated." This is the most
 * dangerous moment in the system's life, and the reason is specific rather than general.
 *
 * A restored database is a snapshot of the past. Every row in it describes what the system
 * BELIEVED at snapshot time — and the outside world kept moving. So a job that was
 * `LEASED` at snapshot time has a lease held by a worker that no longer exists, and an
 * action that was `EXECUTING` describes a provider call whose outcome nobody recorded.
 *
 * THE TEMPTING AND WRONG MOVE is to requeue everything: the leases are obviously stale,
 * the workers are obviously gone, and the system obviously needs to make progress. That
 * reasoning is correct for jobs and catastrophic for actions. An `EXECUTING` external
 * action may have already commented on a Jira issue, merged a merge request or created a
 * calendar event — and the receipt proving it was in the part of the timeline the restore
 * discarded. Requeueing it sends the write again.
 *
 * So this module classifies rather than resumes, and the classification is deliberately
 * ASYMMETRIC:
 *
 *   - a stale JOB lease is released and the job requeued. Safe, because a job's side
 *     effects are themselves guarded by the ledger and the outbox, which are in the
 *     snapshot.
 *   - an `EXECUTING` or `AMBIGUOUS` ACTION is moved to AMBIGUOUS and left there. It
 *     requires `reconcileAmbiguousAction` (RA-022), which asks the PROVIDER what exists
 *     and matches on the idempotency key. That is the only operation that can settle it,
 *     and it is a read.
 *
 * WHAT THIS MODULE MAY NOT DO, so it is stated as an absence: it performs no provider
 * call, and it never advances an action to `SUCCEEDED` or `FAILED`. Both are outside a
 * restore's knowledge. A restore establishes what we hold; only the provider can say what
 * happened.
 */
import type { Database, Transaction } from "./client.js";

/** What a restore decided about one row. */
export const RestoreDisposition = {
  /** A stale lease was released and the job is runnable again. Safe. */
  REQUEUED: "REQUEUED",
  /**
   * An external write whose outcome is unknown. Left for provider reconciliation.
   *
   * NOT retried. This is AC5.
   */
  HELD_AMBIGUOUS: "HELD_AMBIGUOUS",
  /** Already terminal in the snapshot; nothing to do. */
  UNCHANGED: "UNCHANGED",
} as const;

export type RestoreDisposition = (typeof RestoreDisposition)[keyof typeof RestoreDisposition];

/** What the reconciliation did, per class of row. */
export interface RestoreReconciliation {
  /** Job ids whose stale leases were released. */
  readonly requeuedJobs: readonly string[];
  /**
   * Action ids left AMBIGUOUS for provider reconciliation.
   *
   * The number an operator must look at. Non-empty is normal after a restore and is NOT
   * an error — it is the honest state.
   */
  readonly heldActions: readonly string[];
  /** Actions already AMBIGUOUS in the snapshot; also held, counted separately. */
  readonly alreadyAmbiguous: readonly string[];
  /** Credential refresh intents interrupted mid-flight. */
  readonly heldCredentialRefreshes: readonly string[];
  /** Watch/webhook registrations that must be re-registered before events resume. */
  readonly staleWatches: readonly string[];
}

/**
 * Classify and repair a restored database, in ONE transaction.
 *
 * One transaction on purpose: a partially reconciled database is worse than an
 * unreconciled one, because an operator cannot tell which half they are looking at. Either
 * every stale lease is released and every uncertain action held, or nothing changed.
 *
 * `now` comes from the DATABASE clock, not the process. A restored environment's host
 * clock is one of the things most likely to be wrong — a drill account spun up from a
 * stale AMI, a container with no NTP — and `PolicyInput.now` already records what a
 * backdated clock does to an expiry comparison (RA-022-WU-03). The same trap applies to
 * "is this lease expired?".
 */
export async function reconcileAfterRestore(db: Database): Promise<RestoreReconciliation> {
  return db.withTransaction(async (tx) => reconcileAfterRestoreInTransaction(tx));
}

/** The transactional body, exposed so a caller can compose it with its own work. */
export async function reconcileAfterRestoreInTransaction(
  tx: Transaction,
): Promise<RestoreReconciliation> {
  const now = await tx
    .query<{ now: Date }>("SELECT now() AS now")
    .then((result) => result.rows[0]!.now);

  // 1. External actions FIRST, before anything is requeued.
  //
  //    Ordering is load-bearing: if jobs were requeued first, a worker could pick one up
  //    and reach an action still sitting in EXECUTING, and the executor's `NOT_EXECUTABLE`
  //    guard would be the only thing standing between a restore and a duplicate write.
  //    Holding the actions first means that guard is never the last line of defence.
  // `FOR UPDATE` is belt-and-braces, not the mechanism.
  //
  // Probed, because a mutation removing it stayed green and I needed to know whether the
  // test was weak or the mutation unreachable: a plain `UPDATE` in this transaction ALREADY
  // takes the row lock, so a concurrent `FOR UPDATE NOWAIT` is refused with `55P03` either
  // way. The explicit clause is kept because it makes the intent legible and holds the lock
  // from the moment of the read rather than the moment of the write — which matters if a
  // future change adds a decision between the two.
  const executing = await tx.query<{ action_id: string }>(
    `SELECT action_id FROM external_actions WHERE status = 'EXECUTING' FOR UPDATE`,
  );
  const heldActions: string[] = [];
  for (const row of executing.rows) {
    // EXECUTING -> AMBIGUOUS, never -> PROPOSED and never -> FAILED.
    //
    // FAILED would assert "no effect", which is exactly the claim that cannot be made: the
    // provider call may have landed and its receipt may be in the discarded part of the
    // timeline. PROPOSED would make it eligible for execution again, which is the blind
    // replay AC5 forbids.
    await tx.query(
      `UPDATE external_actions SET status = 'AMBIGUOUS', updated_at = $2 WHERE action_id = $1`,
      [row.action_id, now],
    );
    heldActions.push(row.action_id);
  }

  const alreadyAmbiguous = await tx.query<{ action_id: string }>(
    `SELECT action_id FROM external_actions WHERE status = 'AMBIGUOUS' AND action_id <> ALL($1::text[])`,
    [heldActions],
  );

  // 2. Credential refreshes interrupted mid-flight.
  //
  //    Reported, NOT retried. A refresh that was in flight may already have caused the
  //    provider to issue a new token and invalidate the old one; retrying destroys the new
  //    token, and the system then holds neither. `CredentialWriteAmbiguousError` exists
  //    for exactly this, and a restore is its most likely trigger.
  const refreshes = await tx.query<{ operation_id: string }>(
    `SELECT operation_id FROM credential_refresh_intents
      WHERE status IN ('PENDING', 'ACQUIRING', 'VAULT_WRITTEN', 'AMBIGUOUS')`,
  );

  // 3. Stale leases. Released only AFTER the actions above are held.
  const leased = await tx.query<{ job_id: string }>(
    `SELECT job_id FROM jobs
      WHERE lease_owner IS NOT NULL
        AND status = 'LEASED'
      FOR UPDATE`,
  );
  const requeuedJobs: string[] = [];
  for (const row of leased.rows) {
    // Every lease in a restored snapshot is stale by definition: it was held by a process
    // that does not exist in this environment. So this does NOT compare `lease_expires_at`
    // against `now` — the lease may look valid, and it is not. Comparing would leave
    // recently-leased jobs stuck until their lease expired, which after a restore is a
    // delay for no benefit.
    //
    // The fencing token is NOT reset: a late write from a pre-restore worker (impossible
    // in a fresh account, possible when restoring in place) must still lose. That is the
    // `CTF-005` lesson — a monotonic fact must not be rewound.
    await tx.query(
      `UPDATE jobs
          SET status = 'PENDING',
              lease_owner = NULL,
              lease_expires_at = NULL,
              available_at = $2,
              updated_at = $2
        WHERE job_id = $1`,
      [row.job_id, now],
    );
    requeuedJobs.push(row.job_id);
  }

  // 4. Watches and webhook registrations.
  //
  //    Reported rather than renewed: renewal is a provider call, and this function makes
  //    none. Until they are re-registered no provider event arrives, which is the quiet
  //    failure AC7's recovery order exists to prevent — and it is why `renewals.failed`
  //    is one of the four alarm classes.
  const watches = await tx.query<{ registration_id: string }>(
    `SELECT registration_id FROM jira_webhook_registrations
      WHERE status IN ('ACTIVE', 'RENEWAL_DUE', 'RENEWING', 'RECONCILING')`,
  );

  return {
    requeuedJobs,
    heldActions,
    alreadyAmbiguous: alreadyAmbiguous.rows.map((row) => row.action_id),
    heldCredentialRefreshes: refreshes.rows.map((row) => row.operation_id),
    staleWatches: watches.rows.map((row) => row.registration_id),
  };
}

/**
 * Whether a restored database preserved the evidence AC4 requires.
 *
 * AC4: "the restore reproduces cases, checkpoints and audit, and safely reconciles jobs."
 * Checked as COUNTS against the expected pre-restore values, which is the only form that
 * distinguishes "restored" from "reachable" — an empty database is reachable.
 */
export async function verifyRestoredEvidence(
  db: Database,
  expected: {
    readonly cases: number;
    readonly checkpoints: number;
    readonly auditEntries: number;
    readonly receipts: number;
  },
): Promise<readonly string[]> {
  const gaps: string[] = [];
  const count = async (table: string): Promise<number> => {
    const result = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
    return Number(result.rows[0]!.n);
  };
  const checks: readonly [string, string, number][] = [
    ["cases", "cases", expected.cases],
    ["checkpoints", "case_checkpoints", expected.checkpoints],
    ["audit entries", "audit_log", expected.auditEntries],
    ["receipts", "receipts", expected.receipts],
  ];
  for (const [label, table, want] of checks) {
    const got = await count(table);
    // `<` rather than `!==`: a restore to a point AFTER the snapshot legitimately holds
    // more. Fewer means evidence was lost, which is the failure this checks for.
    if (got < want) {
      gaps.push(`${label}: expected at least ${String(want)}, found ${String(got)}`);
    }
  }
  return gaps;
}
