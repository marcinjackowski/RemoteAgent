/**
 * Durable approval persistence: single-use grants fenced to a case checkpoint
 * revision (RA-022-WU-02, `CTF-005`).
 *
 * An approval is the only thing that authorizes a `REQUIRES_APPROVAL` external
 * write, so every property that makes it safe has to be enforced by the STORE, not
 * by the caller's control flow. Four fences, all evaluated inside one statement:
 *
 *   1. **single use** — `consumed = false` is part of the UPDATE's WHERE clause, so
 *      two concurrent consumers of the same grant cannot both win. This is
 *      deliberately not "SELECT, check, UPDATE": that shape has a window between
 *      the check and the write in which a second caller passes the same check.
 *   2. **owner scope** — fenced on `owner_id`, the case's owner, never on
 *      `granted_by` (the actor who clicked). An actor id is not a scope.
 *   3. **exact payload** — fenced on `action_digest`. Migration 008 binds a grant
 *      to one canonical digest with no wildcard, which is what makes "change one
 *      parameter after approval and the approval is void" true (AC1).
 *   4. **exact context** — fenced on `checkpoint_revision` against the case's
 *      CURRENT revision. The digest pins the payload; the revision pins the facts
 *      the owner agreed under (AC2, and the TOCTOU in this task's audit focus).
 *
 * Atomicity is required by the type system: {@link ApprovalRepository.consume} and
 * {@link ApprovalRepository.grant} take a branded {@link Transaction}, not a plain
 * {@link Queryable}. The auto-commit pool does not satisfy that type, so "consume
 * the grant outside a transaction and read the kill switch separately" is a
 * compile-time error rather than a TOCTOU discovered in production (the AUDIT-01
 * HIGH-02 shape from RA-003). AC6 depends on this: the executor reads the kill
 * switch in the SAME transaction that consumes the grant, and both `Queryable`
 * consumers (`KillSwitchRepository.listEffective`) accept a `Transaction`.
 */
import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import { PersistenceError } from "../errors.js";

export interface ApprovalRow {
  approval_id: string;
  case_id: string;
  /** Authoritative owner scope, derived from the case (never from the caller). */
  owner_id: string;
  /** The actor who granted it. An audit fact, not a scope. */
  granted_by: string;
  action_digest: string;
  checkpoint_revision: number;
  granted_at: Date;
  expires_at: Date;
  consumed: boolean;
  consumed_at: Date | null;
}

const COLUMNS = `approval_id, case_id, owner_id, granted_by, action_digest,
  checkpoint_revision, granted_at, expires_at, consumed, consumed_at`;

export interface GrantApproval {
  approvalId: string;
  caseId: string;
  /** The actor who clicked. Recorded, never used as the scope. */
  grantedBy: string;
  actionDigest: string;
  /**
   * The checkpoint revision the grant is being made against — for a Discord
   * approval this comes from the button's `custom_id`, which already carries it
   * (`packages/discord/src/custom-id.ts`). It is verified against the case's
   * current revision rather than trusted.
   */
  checkpointRevision: number;
  /** Absolute expiry of the grant. */
  expiresAt: Date;
}

/**
 * Why a grant was refused, or the row it produced.
 *
 * A discriminated outcome rather than a boolean because a test that asserts on a
 * result CLASS ("it failed") also passes when a different, weaker layer produced
 * the refusal — the `CTF-010` finding that cost RA-014 a real defect. Callers and
 * tests assert on the reason.
 */
export type ApprovalGrantOutcome =
  | { outcome: "GRANTED"; row: ApprovalRow }
  /** Replay of the same click: the identical grant already exists, unchanged. */
  | { outcome: "ALREADY_GRANTED"; row: ApprovalRow }
  | { outcome: "CASE_NOT_FOUND" }
  /**
   * The case has moved on since the proposal the owner was looking at. The click
   * is refused rather than recorded, so a grant can never be born stale: the owner
   * is asked again against the current facts.
   */
  | { outcome: "STALE_REVISION"; requested: number; current: number }
  /**
   * A different, still-live grant already authorizes this exact canonical action for
   * this owner. Refused rather than recorded: a second simultaneous grant for one
   * payload adds no authority and would make consent for that action spendable twice
   * (migration 030, found by the WU-02 adversarial probe). The existing grant is
   * returned so the caller can point the owner at it.
   */
  | { outcome: "LIVE_GRANT_EXISTS"; row: ApprovalRow };

export interface ConsumeApproval {
  approvalId: string;
  caseId: string;
  /** The owner scope the consumption must fall in; supplied by deterministic code. */
  ownerId: string;
  /** The exact digest of the action about to be executed. */
  actionDigest: string;
}

/**
 * Why a consumption was refused, or the row it consumed.
 *
 * `WRONG_OWNER` carries no row: an attempt that crosses an ownership edge must not
 * learn the grant's contents, and "the id exists but is not yours" is already the
 * most it should learn.
 */
export type ApprovalConsumption =
  | { outcome: "CONSUMED"; row: ApprovalRow }
  | { outcome: "NOT_FOUND" }
  | { outcome: "WRONG_OWNER" }
  | { outcome: "DIGEST_MISMATCH"; row: ApprovalRow }
  | { outcome: "ALREADY_CONSUMED"; row: ApprovalRow }
  | { outcome: "EXPIRED"; row: ApprovalRow }
  | { outcome: "STALE_REVISION"; row: ApprovalRow; currentRevision: number };

export class ApprovalRepository {
  /**
   * Record a single-use grant, fenced to the case's current checkpoint revision.
   *
   * `owner_id` is read from the case inside the same statement, so a caller cannot
   * assert a scope the case does not have. That is belt-and-braces with migration
   * 029's composite FK to `cases (case_id, owner_id)`, which makes the mismatched
   * pair unrepresentable — the guarantee should not rest on one mechanism.
   *
   * Requires a {@link Transaction} because the revision check and the insert must
   * share one boundary: the case row is locked `FOR SHARE` first, so a checkpoint
   * append cannot land between "the revision is N" and "this grant is at N".
   */
  public async grant(tx: Transaction, input: GrantApproval): Promise<ApprovalGrantOutcome> {
    try {
      const current = await lockCaseRevision(tx, input.caseId);
      if (current === null) {
        return { outcome: "CASE_NOT_FOUND" };
      }
      if (current !== input.checkpointRevision) {
        return {
          outcome: "STALE_REVISION",
          requested: input.checkpointRevision,
          current,
        };
      }

      // At most one live grant per canonical action (migration 030). Checked here,
      // BEFORE the insert, rather than by catching the unique violation: a failed
      // statement aborts the whole transaction, so the catch block could no longer
      // query for the existing grant to report it ("current transaction is aborted").
      // A pre-check inside the transaction is safe against a concurrent second grant
      // precisely because the index still exists — if two callers pass this check at
      // once, one of them loses at the index and its transaction correctly fails
      // rather than double-granting. The check reports the common case cleanly; the
      // index remains the guarantee.
      const live = await tx.query<ApprovalRow>(
        `SELECT ${COLUMNS} FROM approvals
          WHERE case_id = $1 AND action_digest = $2 AND consumed = false
            AND approval_id <> $3
          LIMIT 1`,
        [input.caseId, input.actionDigest, input.approvalId],
      );
      const liveRow = live.rows[0];
      if (liveRow !== undefined) {
        return { outcome: "LIVE_GRANT_EXISTS", row: liveRow };
      }

      const inserted = await tx.query<ApprovalRow>(
        `INSERT INTO approvals (
           approval_id, case_id, owner_id, granted_by, action_digest,
           checkpoint_revision, expires_at)
         VALUES ($1, $2, (SELECT owner_id FROM cases WHERE case_id = $2), $3, $4, $5, $6)
         ON CONFLICT (approval_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          input.approvalId,
          input.caseId,
          input.grantedBy,
          input.actionDigest,
          input.checkpointRevision,
          input.expiresAt,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) {
        return { outcome: "GRANTED", row };
      }

      // The id already existed. A repeated click on the same button is a legitimate
      // replay and must return the SAME grant rather than mint a second one. A
      // colliding id naming a DIFFERENT grant is a caller bug or a replay across
      // contexts and is rejected fail-closed before it can authorize anything —
      // the identity check that RA-005 AUDIT-02 HIGH-04 added for refresh intents.
      const existing = await this.findById(tx, input.approvalId);
      if (existing === null) {
        throw new PersistenceError(`approval disappeared after insert: ${input.approvalId}`);
      }
      assertGrantIdentity(existing, input);
      return { outcome: "ALREADY_GRANTED", row: existing };
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Atomically consume the grant, or explain why it may not be used.
   *
   * One UPDATE carries every fence, so there is no window in which a second caller
   * observes the same "not yet consumed" state. When it matches zero rows the row
   * is read back only to DIAGNOSE the refusal — that read never authorizes
   * anything, and removing it would change the message but not the outcome.
   *
   * `expires_at > now()` and `consumed_at = now()` both use the DATABASE clock. A
   * worker with a skewed clock therefore cannot consume an expired grant nor stamp
   * a consumption outside the validity window the contract requires
   * (`granted_at <= consumed_at < expires_at`) — the AUDIT-04 HIGH-08 lesson.
   */
  public async consume(tx: Transaction, input: ConsumeApproval): Promise<ApprovalConsumption> {
    try {
      // Lock the case row FOR SHARE before reading its revision. Without the lock a
      // concurrent checkpoint append could commit between this read and the UPDATE,
      // and the grant would be consumed against a revision that is no longer
      // current — the exact TOCTOU this column exists to close. FOR SHARE makes the
      // append wait for this transaction instead of racing it, and still lets other
      // readers through.
      const currentRevision = await lockCaseRevision(tx, input.caseId);
      if (currentRevision === null) {
        return { outcome: "NOT_FOUND" };
      }

      // A rolled-back case revision must not revive a grant that was already stale.
      //
      // `cases.checkpoint_revision` is a mutable counter, so "current revision" alone
      // is not a monotonic fact: set it back to N and a grant made at N — which the
      // case had already moved past — matches the fence again. The adversarial probe
      // did exactly that and got `CONSUMED` for a grant that had previously been
      // correctly refused as `STALE_REVISION`.
      //
      // `case_checkpoints` is append-only (migration 004), so it is the monotonic
      // record: if a revision ABOVE the grant's has ever been written, the case has
      // moved past the context the owner approved under, whatever the counter now
      // says. Recovery legitimately rewinds a case; it must not silently re-authorize
      // consent that was given against superseded facts. The owner can grant again.
      const superseded = await tx.query<{ max_revision: number }>(
        `SELECT max(revision) AS max_revision FROM case_checkpoints WHERE case_id = $1`,
        [input.caseId],
      );
      const highestEverSeen = superseded.rows[0]?.max_revision ?? null;

      const consumed = await tx.query<ApprovalRow>(
        `UPDATE approvals
            SET consumed = true, consumed_at = now()
          WHERE approval_id = $1
            AND case_id = $2
            AND owner_id = $3
            AND action_digest = $4
            AND checkpoint_revision = $5
            AND ($6::integer IS NULL OR checkpoint_revision >= $6::integer)
            AND consumed = false
            AND expires_at > now()
          RETURNING ${COLUMNS}`,
        [
          input.approvalId,
          input.caseId,
          input.ownerId,
          input.actionDigest,
          currentRevision,
          highestEverSeen,
        ],
      );
      const row = consumed.rows[0];
      if (row !== undefined) {
        return { outcome: "CONSUMED", row };
      }
      return await this.diagnose(tx, input, currentRevision, highestEverSeen);
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findById(q: Queryable, approvalId: string): Promise<ApprovalRow | null> {
    const result = await q.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM approvals WHERE approval_id = $1`,
      [approvalId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Observability only: the live grants an owner currently holds for a digest.
   *
   * Deliberately NOT part of any authorization path — a consumer that "checks
   * whether a usable approval exists" and then executes has reintroduced the
   * check-then-act window that {@link ApprovalRepository.consume} exists to remove.
   */
  public async listUnconsumedForDigest(
    q: Queryable,
    input: { caseId: string; ownerId: string; actionDigest: string },
  ): Promise<ApprovalRow[]> {
    const result = await q.query<ApprovalRow>(
      `SELECT ${COLUMNS} FROM approvals
        WHERE case_id = $1 AND owner_id = $2 AND action_digest = $3 AND consumed = false
        ORDER BY granted_at ASC`,
      [input.caseId, input.ownerId, input.actionDigest],
    );
    return result.rows;
  }

  /**
   * Explain a refusal that the fenced UPDATE already made. Ordering is chosen so
   * the reported reason is the most specific one, and so nothing about a grant is
   * reported across an ownership edge.
   */
  private async diagnose(
    q: Queryable,
    input: ConsumeApproval,
    currentRevision: number,
    highestEverSeen: number | null,
  ): Promise<ApprovalConsumption> {
    const row = await this.findById(q, input.approvalId);
    if (row === null || row.case_id !== input.caseId) {
      return { outcome: "NOT_FOUND" };
    }
    if (row.owner_id !== input.ownerId) {
      return { outcome: "WRONG_OWNER" };
    }
    if (row.action_digest !== input.actionDigest) {
      return { outcome: "DIGEST_MISMATCH", row };
    }
    if (row.consumed) {
      return { outcome: "ALREADY_CONSUMED", row };
    }
    if (row.checkpoint_revision !== currentRevision) {
      return { outcome: "STALE_REVISION", row, currentRevision };
    }
    // The counter matches but the append-only checkpoint history has gone further:
    // the case was rewound. Reported as stale against the highest revision ever
    // written, because that — not the rewound counter — is the context the grant was
    // superseded by.
    if (highestEverSeen !== null && row.checkpoint_revision < highestEverSeen) {
      return { outcome: "STALE_REVISION", row, currentRevision: highestEverSeen };
    }
    // Expiry last: the store's clock decided it, and reporting it only after the
    // structural reasons keeps "expired" from masking a mismatch.
    return { outcome: "EXPIRED", row };
  }
}

/**
 * Read a case's checkpoint revision and hold it against concurrent advancement
 * until the caller's transaction ends.
 *
 * `FOR SHARE` rather than `FOR UPDATE`: this transaction does not modify the case,
 * it only requires that the revision it read is still the revision at commit.
 * `CheckpointRepository.append` bumps `cases.checkpoint_revision` with an UPDATE,
 * which must wait for this share lock — so a grant or a consumption can never be
 * decided against a revision that has already been superseded.
 */
async function lockCaseRevision(tx: Transaction, caseId: string): Promise<number | null> {
  const result = await tx.query<{ checkpoint_revision: number }>(
    `SELECT checkpoint_revision FROM cases WHERE case_id = $1 FOR SHARE`,
    [caseId],
  );
  return result.rows[0]?.checkpoint_revision ?? null;
}

/**
 * Fail closed when a stored grant's immutable identity does not match a request
 * that reused its `approval_id`. Every field here is part of what the grant
 * authorizes, so a mismatch means the id is being replayed against a different
 * action, case, actor or window — never something to accept as "already granted".
 */
function assertGrantIdentity(row: ApprovalRow, input: GrantApproval): void {
  const mismatch = ((): string | null => {
    if (row.case_id !== input.caseId) return "case";
    if (row.granted_by !== input.grantedBy) return "granting actor";
    if (row.action_digest !== input.actionDigest) return "action digest";
    if (row.checkpoint_revision !== input.checkpointRevision) return "checkpoint revision";
    if (row.expires_at.getTime() !== input.expiresAt.getTime()) return "expiry";
    return null;
  })();
  if (mismatch !== null) {
    throw new ApprovalIdentityError(input.approvalId, mismatch);
  }
}

/**
 * An `approval_id` was reused for a DIFFERENT grant. Distinct from every
 * consumption outcome: those are refusals of a well-formed request, this is a
 * request that contradicts durable state and must not be treated as a replay.
 */
export class ApprovalIdentityError extends PersistenceError {
  public readonly approvalId: string;
  public readonly field: string;

  public constructor(approvalId: string, field: string) {
    super(`approval ${approvalId} is already bound to a different ${field}`);
    this.approvalId = approvalId;
    this.field = field;
  }
}
