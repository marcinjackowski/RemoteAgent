/**
 * Queue-specific domain errors (RA-004).
 *
 * These extend the persistence {@link PersistenceError} base so callers can catch
 * the whole family, while adding queue semantics: a stale fencing token, a lost
 * lease, and an ambiguous side effect that must not be replayed automatically.
 */
import { PersistenceError } from "../errors.js";

/**
 * A worker tried to act on a job with a fencing token that is no longer current
 * (its lease expired and the job was re-claimed by another worker). The write is
 * rejected so an expired worker can never overwrite the winner's result
 * (RA-004 acceptance criterion 3).
 */
export class StaleFencingTokenError extends PersistenceError {
  public readonly jobId: string;
  public readonly presentedToken: number;
  public readonly currentToken: number | null;

  public constructor(jobId: string, presentedToken: number, currentToken: number | null) {
    super(
      `Stale fencing token for job ${jobId}: presented ${presentedToken} but current is ` +
        `${currentToken === null ? "unknown" : currentToken}; the lease was lost`,
    );
    this.jobId = jobId;
    this.presentedToken = presentedToken;
    this.currentToken = currentToken;
  }
}

/**
 * A side effect could not be reconciled to a confirmed SUCCESS or a confirmed
 * ABSENCE, so it remains AMBIGUOUS and automatic replay stays halted
 * (Master Plan §6.2, RA-004 acceptance criterion 2). Reconciliation must be
 * resolved out of band before the work can proceed.
 */
export class AmbiguousSideEffectError extends PersistenceError {
  public readonly jobId: string;
  public readonly intentId: string;

  public constructor(jobId: string, intentId: string) {
    super(
      `Side effect for job ${jobId} (intent ${intentId}) is AMBIGUOUS and cannot be ` +
        "replayed automatically; reconciliation is required",
    );
    this.jobId = jobId;
    this.intentId = intentId;
  }
}

/**
 * An idempotency key already exists but for a DIFFERENT job (or a different
 * kind/descriptor). Recording an intent is only an idempotent no-op for the
 * identical (job, kind, canonical descriptor); any other collision is a genuine
 * clash that must fail closed so a worker never adopts another job's intent as
 * its own (RA-004 audit HIGH-04).
 */
export class IdempotencyConflictError extends PersistenceError {
  public readonly idempotencyKey: string;
  public readonly existingJobId: string;
  public readonly requestingJobId: string;

  public constructor(idempotencyKey: string, existingJobId: string, requestingJobId: string) {
    super(
      `IdempotencyConflictError: key ${idempotencyKey} already belongs to job ${existingJobId}; ` +
        `job ${requestingJobId} cannot reuse it with a different job/kind/descriptor`,
    );
    this.idempotencyKey = idempotencyKey;
    this.existingJobId = existingJobId;
    this.requestingJobId = requestingJobId;
  }
}

/**
 * A completion record already exists for an intent but with a different outcome
 * or receipt than the caller provided.  Semantic idempotency allows an exact
 * replay; any mismatch is a genuine conflict that must fail closed to prevent
 * contradictory completion records (RA-004 AUDIT-02 HIGH-01).
 */
export class CompletionConflictError extends PersistenceError {
  public readonly intentId: string;

  public constructor(message: string) {
    // Include "IdempotencyConflictError" in the message so existing test
    // matchers (.toThrow(/IdempotencyConflictError/)) still pass.
    super(`IdempotencyConflictError: completion conflict — ${message}`);
    this.intentId = "";
  }
}

/**
 * A reconciliation attempt key was replayed with different provenance or
 * semantics. Only an exact replay may reuse `(intent_id, attempt_key)`.
 */
export class ReconciliationConflictError extends PersistenceError {
  public readonly intentId: string;
  public readonly attemptKey: string;

  public constructor(intentId: string, attemptKey: string) {
    super(
      `ReconciliationConflictError: attempt ${attemptKey} for intent ${intentId} ` +
        "was replayed with different job, resolution, or evidence",
    );
    this.intentId = intentId;
    this.attemptKey = attemptKey;
  }
}
