/**
 * Durable job store (RA-004).
 *
 * Provides at-least-once execution with safe recovery after a worker crash
 * (task RA-004). A worker CLAIMS a runnable job by taking a durable lease
 * (owner + expiry + monotonic fencing token); it HEARTBEATS to extend the lease
 * while working; it COMPLETES (success) or FAILS (retry with bounded exponential
 * backoff, then DLQ). Every post-claim write is conditioned on the caller still
 * holding the current lease, so an expired/stale worker fails closed and can
 * never overwrite the winner (acceptance criterion 3).
 *
 * Concurrency guarantees:
 *   - Per-case serialization (criterion 4): a job's `serialization_key` (default
 *     = case_id) has AT MOST ONE active (LEASED/RECONCILING/RECOVERY_PENDING)
 *     job at a time. This
 *     is enforced by a partial UNIQUE index (`jobs_active_serialization_uidx`) as
 *     the hard backstop, plus a claim-time guard that skips a key with an active
 *     job.
 *   - Global and per-provider concurrency limits: {@link claim} counts currently
 *     active jobs and refuses to exceed the configured caps.
 *   - The counting + claim run inside ONE branded transaction that first takes a
 *     fixed `pg_advisory_xact_lock`, so two workers cannot both read "capacity
 *     available" and both claim past the limit. The transaction is kept short
 *     (only the claim), never wrapping user work.
 *
 * Recovery (criterion 2): {@link reapExpired} inspects durable intents and
 * completions. A job whose lease expired while it had recorded an intent WITHOUT
 * a confirmed completion is moved to RECONCILING and is NEVER replayed
 * automatically; a job with no unfinished intent is safely returned to PENDING.
 */
import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import { NotFoundError } from "../errors.js";
import { backoffDelayMs } from "./backoff.js";
import {
  StaleFencingTokenError,
  IdempotencyConflictError,
  CompletionConflictError,
  ReconciliationConflictError,
} from "./errors.js";
import { leaseTimeSql, type LeaseTimeSql } from "./lease-time.js";
import type { Clock, IdGenerator, LeaseTimeMode } from "./runtime.js";

/** Provider set mirrors the DB CHECK and @remoteagent/contracts Provider. */
export type JobProvider = "jira" | "gmail" | "calendar" | "gitlab" | "discord";

export type JobStatus =
  | "PENDING"
  | "LEASED"
  | "SUCCEEDED"
  | "FAILED"
  | "DEAD_LETTER"
  | "RECONCILING"
  | "RECOVERY_PENDING";

export interface EnqueueJob {
  jobType: string;
  payload: Record<string, unknown>;
  caseId?: string | null;
  provider?: JobProvider | null;
  /**
   * Serialization group for jobs WITHOUT a case. Ignored when `caseId` is set:
   * a cased job is always serialized on its case_id (per-case serialization,
   * criterion 4), enforced both here and by a DB CHECK. Only jobs with no case
   * may set a custom key or leave it null (unserialized).
   */
  serializationKey?: string | null;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** When the job first becomes runnable (ms epoch); defaults to now. */
  availableAtMs?: number;
}

export interface JobRow {
  job_id: string;
  case_id: string | null;
  job_type: string;
  status: JobStatus;
  payload: Record<string, unknown>;
  provider: JobProvider | null;
  serialization_key: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  fencing_token: string;
  attempts: number;
  max_attempts: number;
  backoff_base_ms: string;
  backoff_cap_ms: string;
  available_at: Date;
  leased_at: Date | null;
  last_heartbeat_at: Date | null;
  last_error: string | null;
  dead_lettered_at: Date | null;
  dlq_reason: string | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A successfully claimed lease handed to the worker. */
export interface JobLease {
  jobId: string;
  caseId: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  provider: JobProvider | null;
  serializationKey: string | null;
  attempts: number;
  maxAttempts: number;
  /** Monotonic fencing token; every subsequent write must present it. */
  fencingToken: number;
  leaseExpiresAtMs: number;
  leaseOwner: string;
}

export type LeaseIdentity = Pick<
  JobLease,
  "jobId" | "caseId" | "leaseOwner" | "fencingToken" | "jobType" | "payload"
>;

export interface ClaimOptions {
  /** Worker identity recorded as the lease owner. */
  owner?: string;
  /** Lease duration in ms (default 30s). */
  leaseMs?: number;
  /** Restrict the claim to a single provider (else any). */
  provider?: JobProvider | null;
  /** Max total active jobs across the whole queue. */
  globalLimit?: number;
  /** Max active jobs per provider. */
  providerLimit?: number;
}

/** Observable result of one expired-lease recovery pass. */
export interface ReapResult {
  reconciling: string[];
  requeued: string[];
  /** Jobs reconstructed as terminal success from durable SUCCEEDED completions. */
  succeeded: string[];
}

/** A database that can open a branded transaction. */
export interface TxDb {
  withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** Advisory-lock key that serializes concurrency counting + claim across workers. */
const CLAIM_ADVISORY_LOCK_KEY = 0x52_41_30_30_34n; // "RA004" bytes.

const JOB_COLUMNS = `
  job_id, case_id, job_type, status, payload, provider, serialization_key,
  lease_owner, lease_expires_at, fencing_token, attempts, max_attempts,
  backoff_base_ms, backoff_cap_ms, available_at, leased_at, last_heartbeat_at,
  last_error, dead_lettered_at, dlq_reason, finished_at, created_at, updated_at`;

/** JOB_COLUMNS qualified with the `j` alias for UPDATE ... FROM RETURNING. */
const JOB_COLUMNS_J = JOB_COLUMNS.replace(/(\w+)/g, "j.$1");

export class JobStore {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly lt: LeaseTimeSql;

  public constructor(runtime: { clock: Clock; ids: IdGenerator; leaseTime?: LeaseTimeMode }) {
    this.clock = runtime.clock;
    this.ids = runtime.ids;
    // DB server clock is the authoritative lease-lifetime source by default
    // (audit MEDIUM-07); tests opt into 'injected' explicitly.
    this.lt = leaseTimeSql(runtime.leaseTime ?? "db");
  }

  /**
   * Enqueue a new job. Accepts any {@link Queryable} so it composes into a larger
   * business transaction (e.g. enqueue a job in the same tx as a state change).
   * The serialization key defaults to the case id.
   */
  public async enqueue(q: Queryable, input: EnqueueJob): Promise<JobRow> {
    const jobId = this.ids.next("job");
    const nowMs = this.clock.now();
    // Per-case serialization is forced: a job with a case is ALWAYS serialized on
    // its case_id, ignoring any caller-supplied key (criterion 4 / audit HIGH-05).
    // A DB CHECK (jobs_serialization_key_check) is the hard backstop.
    const serializationKey =
      input.caseId != null
        ? input.caseId
        : input.serializationKey === undefined
          ? null
          : input.serializationKey;
    try {
      const result = await q.query<JobRow>(
        `INSERT INTO jobs (
           job_id, case_id, job_type, status, payload, provider, serialization_key,
           attempts, max_attempts, backoff_base_ms, backoff_cap_ms, available_at,
           created_at, updated_at)
         VALUES ($1, $2, $3, 'PENDING', $4::jsonb, $5, $6, 0,
                  COALESCE($7, 10), COALESCE($8, 1000), COALESCE($9, 3600000),
                  CASE WHEN $10::bigint IS NULL THEN ${this.lt.scheduleBase(11)}
                       ELSE to_timestamp($10::bigint / 1000.0) END,
                  to_timestamp($11 / 1000.0), to_timestamp($11 / 1000.0))
         RETURNING ${JOB_COLUMNS}`,
        [
          jobId,
          input.caseId ?? null,
          input.jobType,
          JSON.stringify(input.payload),
          input.provider ?? null,
          serializationKey,
          input.maxAttempts ?? null,
          input.backoffBaseMs ?? null,
          input.backoffCapMs ?? null,
          input.availableAtMs ?? null,
          nowMs,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Claim the next runnable job under a durable lease.
   *
   * Runs in ONE short branded transaction that first takes a fixed
   * `pg_advisory_xact_lock`, so global/provider capacity counting and the row
   * claim are serialized across all workers — two workers can never both observe
   * "capacity available" and both claim past the limit. Inside the lock:
   *   1. count currently active (LEASED/RECONCILING) jobs globally and, if a
   *      provider filter is set, for that provider; bail out if a cap is hit;
   *   2. select one PENDING, due job whose serialization_key has no active job,
   *      using `FOR UPDATE SKIP LOCKED`;
   *   3. bump its fencing_token, set the lease and move it to LEASED.
   * The partial UNIQUE index `jobs_active_serialization_uidx` is the hard backstop
   * for per-case serialization even if the guard query raced.
   *
   * Returns `null` when nothing is runnable (empty queue, all keys busy, or a cap
   * reached).
   */
  public async claim(db: TxDb, options: ClaimOptions = {}): Promise<JobLease | null> {
    const owner = options.owner ?? this.ids.next("worker");
    const leaseMs = options.leaseMs ?? 30_000;
    const provider = options.provider ?? null;
    const nowMs = this.clock.now();

    return db.withTransaction(async (tx) => {
      // Serialize counting + claim across workers. Xact lock auto-releases on
      // commit/rollback, keeping the critical section exactly this transaction.
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);

      // 1. Capacity counts executing/reconciling jobs. A parked continuation
      // still owns its serialization key below, but consumes no worker slot.
      if (options.globalLimit !== undefined) {
        const g = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM jobs WHERE status IN ('LEASED', 'RECONCILING')`,
        );
        if (Number(g.rows[0]!.n) >= options.globalLimit) {
          return null;
        }
      }
      if (options.providerLimit !== undefined && provider !== null) {
        const p = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM jobs
           WHERE status IN ('LEASED', 'RECONCILING') AND provider = $1`,
          [provider],
        );
        if (Number(p.rows[0]!.n) >= options.providerLimit) {
          return null;
        }
      }

      // 2 + 3. Claim one runnable job whose serialization key is free, and lease it.
      const claimed = await tx.query<JobRow>(
        `WITH candidate AS (
           SELECT j.job_id
           FROM jobs j
           WHERE j.status = 'PENDING'
             AND j.job_type <> 'agent.engineering_recovery'
             AND j.available_at <= ${this.lt.now(1)}
             AND ($2::text IS NULL OR j.provider = $2)
             AND (
               j.serialization_key IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM jobs a
                 WHERE a.serialization_key = j.serialization_key
                   AND a.status IN ('LEASED', 'RECONCILING', 'RECOVERY_PENDING')
               )
             )
           ORDER BY j.available_at ASC, j.created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE jobs j
         SET status = 'LEASED',
             lease_owner = $3,
             lease_expires_at = ${this.lt.deadline(1, 4)},
             leased_at = to_timestamp($1 / 1000.0),
             last_heartbeat_at = to_timestamp($1 / 1000.0),
             fencing_token = j.fencing_token + 1,
             attempts = j.attempts + 1
         FROM candidate c
         WHERE j.job_id = c.job_id
         RETURNING ${JOB_COLUMNS_J}`,
        [nowMs, provider, owner, leaseMs],
      );

      const row = claimed.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        jobId: row.job_id,
        caseId: row.case_id,
        jobType: row.job_type,
        payload: row.payload,
        provider: row.provider,
        serializationKey: row.serialization_key,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        fencingToken: Number(row.fencing_token),
        // Use the DB's own persisted expiry (authoritative in 'db' mode; equal to
        // nowMs+leaseMs in 'injected' mode) rather than recomputing from a client
        // clock, so the reported deadline matches what gates future writes.
        leaseExpiresAtMs: row.lease_expires_at
          ? new Date(row.lease_expires_at).getTime()
          : nowMs + leaseMs,
        leaseOwner: owner,
      };
    });
  }

  /**
   * Extend the lease of a job the caller still holds. Conditioned on the exact
   * lease (job_id + owner + fencing_token + LEASED + non-expired), so a stale or
   * expired holder cannot heartbeat and fails closed with
   * {@link StaleFencingTokenError} (acceptance criterion 3).
   */
  public async heartbeat(q: Queryable, lease: JobLease, extendMs = 30_000): Promise<number> {
    const nowMs = this.clock.now();
    const r = await q.query(
      `UPDATE jobs
       SET lease_expires_at = ${this.lt.deadline(2, 3)},
           last_heartbeat_at = to_timestamp($2 / 1000.0)
       WHERE job_id = $1 AND lease_owner = $4 AND fencing_token = $5
         AND status = 'LEASED' AND lease_expires_at > ${this.lt.now(2)}`,
      [lease.jobId, nowMs, extendMs, lease.leaseOwner, lease.fencingToken],
    );
    if (r.rowCount === 0) {
      await this.throwStale(q, lease);
    }
    return nowMs + extendMs;
  }

  /**
   * Assert the exact, still-live lease without extending it or opening a transaction.
   * When the caller supplies a transaction, FOR SHARE holds the lease row against a
   * concurrent terminal/reclaim update until that transaction commits.
   */
  public async assertCurrentLease(q: Queryable, lease: LeaseIdentity): Promise<void> {
    const nowMs = this.clock.now();
    const held = await q.query<{ one: number }>(
      `SELECT 1 AS one FROM jobs
       WHERE job_id = $1 AND case_id IS NOT DISTINCT FROM $2
         AND lease_owner = $3 AND fencing_token = $4
         AND job_type = $5 AND payload IS NOT DISTINCT FROM $6::jsonb
         AND status = 'LEASED' AND lease_expires_at > ${this.lt.now(7)}
       FOR SHARE`,
      [
        lease.jobId,
        lease.caseId,
        lease.leaseOwner,
        lease.fencingToken,
        lease.jobType,
        lease.payload,
        nowMs,
      ],
    );
    if (held.rowCount !== 1) await this.throwStale(q, lease);
  }

  /**
   * Mark a held job SUCCEEDED. Conditioned on the current lease; a stale/expired
   * holder fails closed. The status transition AND the append of the attempt
   * row commit atomically in one transaction (audit MEDIUM-07), so attempt
   * history can never disagree with the job's final status.
   */
  public async complete(db: TxDb, lease: JobLease): Promise<void> {
    const nowMs = this.clock.now();
    await db.withTransaction(async (tx) => {
      const r = await tx.query(
        `UPDATE jobs
         SET status = 'SUCCEEDED', finished_at = to_timestamp($2 / 1000.0),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE job_id = $1 AND lease_owner = $3 AND fencing_token = $4
           AND status = 'LEASED' AND lease_expires_at > ${this.lt.now(2)}`,
        [lease.jobId, nowMs, lease.leaseOwner, lease.fencingToken],
      );
      if (r.rowCount === 0) {
        await this.throwStale(tx, lease);
      }
      await this.recordAttempt(tx, lease, "SUCCEEDED", null, nowMs);
    });
  }

  /**
   * Report a failed attempt for a held job. Retries with bounded exponential
   * backoff up to `max_attempts`, then moves the job to the observable DLQ
   * (acceptance criterion 5). Conditioned on the current lease. The transition
   * and the attempt append commit atomically (audit MEDIUM-07).
   */
  public async fail(db: TxDb, lease: JobLease, errorMessage: string): Promise<JobStatus> {
    const nowMs = this.clock.now();
    const truncated = errorMessage.slice(0, 4000);
    return db.withTransaction(async (tx) => {
      const job = await this.findById(tx, lease.jobId);
      if (job === null) {
        throw new NotFoundError("job", lease.jobId);
      }
      const attempts = lease.attempts; // the attempt number that just failed

      if (attempts >= job.max_attempts) {
        const r = await tx.query(
          `UPDATE jobs
           SET status = 'DEAD_LETTER', last_error = $2,
               dead_lettered_at = to_timestamp($3 / 1000.0),
               dlq_reason = $4, finished_at = to_timestamp($3 / 1000.0),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE job_id = $1 AND lease_owner = $5 AND fencing_token = $6
             AND status = 'LEASED' AND lease_expires_at > ${this.lt.now(3)}`,
          [
            lease.jobId,
            truncated,
            nowMs,
            "max attempts exceeded",
            lease.leaseOwner,
            lease.fencingToken,
          ],
        );
        if (r.rowCount === 0) {
          await this.throwStale(tx, lease);
        }
        await this.recordAttempt(tx, lease, "DEAD_LETTER", truncated, nowMs);
        return "DEAD_LETTER";
      }

      const delay = backoffDelayMs(attempts, {
        baseMs: Number(job.backoff_base_ms),
        capMs: Number(job.backoff_cap_ms),
      });
      const r = await tx.query(
        `UPDATE jobs
         SET status = 'PENDING', last_error = $2,
             available_at = ${this.lt.scheduleBase(3)} + make_interval(secs => $4::bigint / 1000.0),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE job_id = $1 AND lease_owner = $5 AND fencing_token = $6
           AND status = 'LEASED' AND lease_expires_at > ${this.lt.now(3)}`,
        [lease.jobId, truncated, nowMs, delay, lease.leaseOwner, lease.fencingToken],
      );
      if (r.rowCount === 0) {
        await this.throwStale(tx, lease);
      }
      await this.recordAttempt(tx, lease, "FAILED", truncated, nowMs);
      return "PENDING";
    });
  }

  /**
   * Recover from a FINALIZATION failure: the handler's work SUCCEEDED but
   * persisting the completion (i.e. {@link complete}) threw, so the commit may or
   * may not have landed (commit ambiguity). This must NEVER become a bounded
   * retry — that would replay a possibly-executed side effect (audit HIGH-02).
   *
   * The recovery is atomic and lease-conditioned, and resolves the ambiguity by
   * OBSERVING the durable job state under a row lock:
   *   - If the job is already `SUCCEEDED`, the completion transaction actually
   *     committed before the error surfaced: nothing to do (result `SUCCEEDED`).
   *   - If the job is still `LEASED` by THIS lease (owner + fencing_token), the
   *     completion did not commit; move it to `RECONCILING` (never `PENDING`), so
   *     it is held out of band and never auto-replayed (result `RECONCILING`).
   *   - Any other state (re-claimed by a newer worker, already RECONCILING,
   *     terminal) means this lease is stale: fail closed with
   *     {@link StaleFencingTokenError} so we never disturb the current owner.
   * A `LEASE_LOST`-style attempt row is appended so history reflects the hold.
   */
  public async holdFinalizationAmbiguous(
    db: TxDb,
    lease: JobLease,
    errorMessage: string,
  ): Promise<"SUCCEEDED" | "RECONCILING"> {
    const nowMs = this.clock.now();
    const truncated = errorMessage.slice(0, 4000);
    return db.withTransaction(async (tx) => {
      // Lock the row so the observation and any transition are consistent.
      const current = await tx.query<{
        status: JobStatus;
        lease_owner: string | null;
        fencing_token: string;
      }>(`SELECT status, lease_owner, fencing_token FROM jobs WHERE job_id = $1 FOR UPDATE`, [
        lease.jobId,
      ]);
      const row = current.rows[0];
      if (row === undefined) {
        throw new NotFoundError("job", lease.jobId);
      }
      // The completion transaction committed after all: the work is done.
      if (row.status === "SUCCEEDED") {
        return "SUCCEEDED";
      }
      // Only THIS lease's still-live LEASED row may be moved to RECONCILING.
      if (
        row.status === "LEASED" &&
        row.lease_owner === lease.leaseOwner &&
        Number(row.fencing_token) === lease.fencingToken
      ) {
        await tx.query(
          `UPDATE jobs
           SET status = 'RECONCILING', lease_owner = NULL, lease_expires_at = NULL,
               last_error = $2
           WHERE job_id = $1 AND status = 'LEASED'
             AND lease_owner = $3 AND fencing_token = $4`,
          [
            lease.jobId,
            `finalization ambiguous; held for reconciliation: ${truncated}`.slice(0, 4000),
            lease.leaseOwner,
            lease.fencingToken,
          ],
        );
        await this.recordAttempt(tx, lease, "AMBIGUOUS", truncated, nowMs);
        return "RECONCILING";
      }
      // Stale: re-claimed, already reconciling, or terminal by someone else.
      await this.throwStale(tx, lease);
      throw new StaleFencingTokenError(lease.jobId, lease.fencingToken, null);
    });
  }

  /**
   * Append an immutable attempt-history row. Uniqueness on
   * (job_id, attempt_number) makes a duplicate a no-op.
   */
  private async recordAttempt(
    q: Queryable,
    lease: JobLease,
    outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | "LEASE_LOST" | "DEAD_LETTER",
    error: string | null,
    nowMs: number,
  ): Promise<void> {
    try {
      await q.query(
        `INSERT INTO job_attempts (
           job_id, attempt_number, lease_owner, fencing_token, outcome, error,
           started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($7 / 1000.0))
         ON CONFLICT (job_id, attempt_number) DO NOTHING`,
        [lease.jobId, lease.attempts, lease.leaseOwner, lease.fencingToken, outcome, error, nowMs],
      );
    } catch (error_) {
      throw translatePgError(error_) ?? error_;
    }
  }

  /**
   * Determine why a lease-conditioned write updated zero rows and raise a
   * {@link StaleFencingTokenError} with the job's current token.
   */
  private async throwStale(q: Queryable, lease: LeaseIdentity): Promise<never> {
    const current = await q.query<{ fencing_token: string }>(
      `SELECT fencing_token FROM jobs WHERE job_id = $1`,
      [lease.jobId],
    );
    const token = current.rows[0] ? Number(current.rows[0].fencing_token) : null;
    throw new StaleFencingTokenError(lease.jobId, lease.fencingToken, token);
  }

  /**
   * Record an intent-before-operation for a held job. Written BEFORE the side
   * effect (Master Plan §6.2) and conditioned on the current lease so only the
   * live holder can record intent.
   *
   * The exact live job row is locked before insert/conflict resolution and held
   * through commit. Reap/takeover therefore cannot interleave after the lease
   * gate, including while an INSERT trigger is running (AUDIT-04 HIGH-01).
   *
   * Idempotency is fail-closed on collision: recording an intent whose
   * idempotency_key already exists is a no-op ONLY when the existing intent
   * belongs to the SAME job, kind and canonical descriptor; any other collision
   * (different job / kind / descriptor) throws instead of silently returning
   * another job's intent.
   */
  public async recordIntent(
    db: TxDb,
    lease: JobLease,
    input: {
      kind: string;
      descriptor: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<string> {
    return db.withTransaction((tx) => this.recordIntentInTransaction(tx, lease, input));
  }

  public async recordIntentInTransaction(
    tx: Transaction,
    lease: JobLease,
    input: {
      kind: string;
      descriptor: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<string> {
    const nowMs = this.clock.now();
    const intentId = this.ids.next("jobintent");
    const descriptorJson = JSON.stringify(input.descriptor);
    const held = await tx.query<{ one: number }>(
      `SELECT 1 AS one FROM jobs
         WHERE job_id = $1 AND lease_owner = $2 AND fencing_token = $3
           AND status = 'LEASED' AND lease_expires_at > ${this.lt.now(4)}
         FOR UPDATE`,
      [lease.jobId, lease.leaseOwner, lease.fencingToken, nowMs],
    );
    if (held.rowCount === 0) {
      await this.throwStale(tx, lease);
    }

    let inserted: string | undefined;
    try {
      const r = await tx.query<{ intent_id: string }>(
        `INSERT INTO job_intents (
             intent_id, job_id, case_id, fencing_token, kind, descriptor, idempotency_key, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, to_timestamp($8 / 1000.0))
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING intent_id`,
        [
          intentId,
          lease.jobId,
          lease.caseId,
          lease.fencingToken,
          input.kind,
          descriptorJson,
          input.idempotencyKey,
          nowMs,
        ],
      );
      inserted = r.rows[0]?.intent_id;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
    if (inserted !== undefined) {
      return inserted;
    }
    // The live lease remains locked here; a conflict can only replay an intent
    // created by this same job and fencing token with identical semantics.
    const existing = await tx.query<{
      intent_id: string;
      job_id: string;
      fencing_token: string;
      kind: string;
      descriptor_matches: boolean;
    }>(
      `SELECT intent_id, job_id, fencing_token, kind,
                descriptor IS NOT DISTINCT FROM $2::jsonb AS descriptor_matches
         FROM job_intents WHERE idempotency_key = $1`,
      [input.idempotencyKey, descriptorJson],
    );
    const prior = existing.rows[0];
    if (prior === undefined) {
      throw new Error(`recordIntent: conflict row disappeared for ${input.idempotencyKey}`);
    }
    if (
      prior!.job_id !== lease.jobId ||
      Number(prior!.fencing_token) !== lease.fencingToken ||
      prior!.kind !== input.kind ||
      !prior!.descriptor_matches
    ) {
      throw new IdempotencyConflictError(input.idempotencyKey, prior!.job_id, lease.jobId);
    }
    return prior!.intent_id;
  }

  /**
   * Record the confirmed completion of an intent's operation.
   *
   * Append-only (`ON CONFLICT DO NOTHING`): if a row already exists for this
   * intent we SELECT it and compare semantically.  A replay with identical
   * `outcome` and `receipt` (JSONB equality) is a safe idempotent no-op.  A
   * replay with a *different* outcome or receipt is a typed
   * `IdempotencyConflictError` (fail closed — audit AUDIT-02 HIGH-01).
   *
   * Always gated on the current lease holder (criterion 3 / AUDIT-02 HIGH-01):
   * the `lease` parameter is **required**; a stale or expired worker is rejected
   * by `throwStale` before any write.  Intent provenance is also validated:
   * the stored `job_id` on the intent must match `input.jobId`.
   *
   * When `outcome` is `AMBIGUOUS` the job is atomically moved to `RECONCILING`
   * under the same owner/token/live-lease condition; `rowCount` is asserted so a
   * race against a concurrent reap is detectable.
   */
  public async recordCompletion(
    db: TxDb,
    input: {
      intentId: string;
      jobId: string;
      outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
      receipt?: Record<string, unknown> | null;
      lease: JobLease; // REQUIRED: gate on current owner (criterion 3)
    },
  ): Promise<string> {
    if (input.jobId !== input.lease.jobId) {
      throw new StaleFencingTokenError(input.jobId, input.lease.fencingToken, null);
    }
    const nowMs = this.clock.now();
    const completionId = this.ids.next("jobcompletion");
    return db.withTransaction(async (tx) => {
      // Lock the live lease row through commit. This makes provenance validation
      // and the ledger insert one fenced critical section: reap/takeover cannot
      // pass between this gate and the INSERT (AUDIT-03 HIGH-01).
      const held = await tx.query<{ one: number }>(
        `SELECT 1 AS one
         FROM job_intents i
         JOIN jobs j ON j.job_id = i.job_id
         WHERE i.intent_id = $1 AND i.job_id = $2 AND i.fencing_token = $3
           AND j.lease_owner = $4 AND j.fencing_token = $3
           AND j.status = 'LEASED' AND j.lease_expires_at > ${this.lt.now(5)}
         FOR UPDATE OF j`,
        [input.intentId, input.jobId, input.lease.fencingToken, input.lease.leaseOwner, nowMs],
      );
      if (held.rowCount === 0) {
        const intent = await tx.query<{ job_id: string }>(
          `SELECT job_id FROM job_intents WHERE intent_id = $1`,
          [input.intentId],
        );
        if (intent.rows[0] === undefined || intent.rows[0].job_id !== input.jobId) {
          throw new NotFoundError("job_intent", `${input.intentId}/${input.jobId}`);
        }
        await this.throwStale(tx, input.lease);
      }

      // Append-only insert (DO NOTHING on conflict). If the row already exists
      //    we fetch it and compare semantically.
      const receiptJson =
        input.receipt === undefined || input.receipt === null
          ? null
          : JSON.stringify(input.receipt);

      let completionResultId: string;
      try {
        const ins = await tx.query<{ completion_id: string }>(
          `INSERT INTO job_completions (completion_id, intent_id, job_id, outcome, receipt, recorded_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0))
           ON CONFLICT (intent_id) DO NOTHING
           RETURNING completion_id`,
          [completionId, input.intentId, input.jobId, input.outcome, receiptJson, nowMs],
        );
        if ((ins.rowCount ?? 0) > 0) {
          // Fresh insert succeeded.
          completionResultId = completionId;
        } else {
          // PostgreSQL compares JSONB semantically, including key-order
          // insensitivity and SQL NULL equality (AUDIT-03 MEDIUM-03).
          const existing = await tx.query<{
            completion_id: string;
            outcome: string;
            receipt_matches: boolean;
          }>(
            `SELECT completion_id, outcome,
                    receipt IS NOT DISTINCT FROM $2::jsonb AS receipt_matches
             FROM job_completions WHERE intent_id = $1`,
            [input.intentId, receiptJson],
          );
          const ex = existing.rows[0]!;
          if (ex.outcome === input.outcome && ex.receipt_matches) {
            completionResultId = ex.completion_id;
          } else {
            throw new CompletionConflictError(
              `intent ${input.intentId} already recorded as outcome='${ex.outcome}'; ` +
                `caller supplied outcome='${input.outcome}' or a different receipt`,
            );
          }
        }
      } catch (error) {
        throw translatePgError(error) ?? error;
      }

      // 4. AMBIGUOUS: atomically halt replay by moving LEASED→RECONCILING under
      //    the same owner/token/live-lease guard.  rowCount must be 1 or the
      //    transition was already done by a concurrent reap (still safe).
      if (input.outcome === "AMBIGUOUS") {
        const updated = await tx.query(
          `UPDATE jobs
           SET status = 'RECONCILING', lease_owner = NULL, lease_expires_at = NULL,
               last_error = 'side effect completed AMBIGUOUS; awaiting reconciliation'
           WHERE job_id = $1 AND status = 'LEASED'
             AND lease_owner = $2 AND fencing_token = $3
             AND lease_expires_at > ${this.lt.now(4)}`,
          [input.jobId, input.lease.leaseOwner, input.lease.fencingToken, nowMs],
        );
        if ((updated.rowCount ?? 0) !== 1) {
          await this.throwStale(tx, input.lease);
        }
      }
      return completionResultId;
    });
  }

  /** Classify the effective state of every intent belonging to one job. */
  private async classifyIntentLedger(
    q: Queryable,
    jobId: string,
  ): Promise<{
    state: "SUCCEEDED" | "PENDING" | "RECONCILING";
    intents: number;
    succeeded: number;
    absent: number;
    unresolved: number;
  }> {
    const result = await q.query<{
      intents: string;
      succeeded: string;
      absent: string;
      unresolved: string;
    }>(
      `WITH effective AS (
         SELECT CASE
           WHEN terminal.resolution = 'CONFIRMED' THEN 'SUCCESS'
           WHEN terminal.resolution = 'ABSENT' THEN 'ABSENT'
           WHEN EXISTS (
             SELECT 1 FROM job_reconciliations unresolved
             WHERE unresolved.intent_id = i.intent_id
               AND unresolved.resolution = 'UNRESOLVED'
           ) THEN 'UNRESOLVED'
           WHEN c.outcome = 'SUCCEEDED' THEN 'SUCCESS'
           WHEN c.outcome = 'FAILED' THEN 'ABSENT'
           ELSE 'UNRESOLVED'
         END AS state
         FROM job_intents i
         LEFT JOIN job_completions c ON c.intent_id = i.intent_id
         LEFT JOIN job_reconciliations terminal
           ON terminal.intent_id = i.intent_id
          AND terminal.resolution IN ('CONFIRMED', 'ABSENT')
         WHERE i.job_id = $1
       )
       SELECT count(*)::text AS intents,
              count(*) FILTER (WHERE state = 'SUCCESS')::text AS succeeded,
              count(*) FILTER (WHERE state = 'ABSENT')::text AS absent,
              count(*) FILTER (WHERE state = 'UNRESOLVED')::text AS unresolved
       FROM effective`,
      [jobId],
    );
    const row = result.rows[0]!;
    const intents = Number(row.intents);
    const succeeded = Number(row.succeeded);
    const absent = Number(row.absent);
    const unresolved = Number(row.unresolved);
    const state =
      intents > 0 && succeeded === intents
        ? "SUCCEEDED"
        : succeeded === 0 && unresolved === 0 && absent === intents
          ? "PENDING"
          : "RECONCILING";
    return { state, intents, succeeded, absent, unresolved };
  }

  /**
   * Reconcile an AMBIGUOUS intent (criterion 6).
   *
   * Reconciliation is an APPEND-ONLY ledger of attempts, each scoped by
   * `(intent_id, attempt_key)` — the key is NOT global so two different intents
   * may share the same human-chosen key without cross-contamination
   * (AUDIT-02 HIGH-02).
   *
   * Lifecycle enforcement (AUDIT-02 HIGH-02):
   *   - Job MUST already be in `RECONCILING` state.  Calling reconcile on a live
   *     LEASED or PENDING job is fail-closed (throws NotFoundError).  Reconcile
   *     must never clear a live owner or silently move a non-RECONCILING job.
   *   - Idempotent replay: if `(intent_id, attempt_key)` already exists, return
   *     its stored result.  The replay check happens before the state guard so
   *     replaying a terminal attempt after the job has already transitioned is
   *     still valid.
   *   - Terminal idempotency: if a terminal (CONFIRMED/ABSENT) row already exists
   *     for this intent and the caller also supplies a terminal resolution, the
   *     existing terminal outcome is returned without a second job transition.
   *
   * A terminal resolution is authoritative for its intent, then the effective
   * state of every intent determines the job state. Mixed or unresolved ledgers
   * stay RECONCILING; only all-success becomes SUCCEEDED and only all-absent/
   * failed with no success becomes PENDING (AUDIT-06 HIGH-01).
   */
  public async reconcile(
    db: TxDb,
    input: {
      intentId: string;
      jobId: string;
      resolution: "CONFIRMED" | "ABSENT" | "UNRESOLVED";
      attemptKey: string;
      evidence?: Record<string, unknown> | null;
    },
  ): Promise<{ reconciliationId: string; resolution: string; jobStatus: JobStatus }> {
    const nowMs = this.clock.now();
    return db.withTransaction(async (tx) => {
      // Serialize with claim/reap and any concurrent reconcile of the same job.
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);

      // Provenance is validated before every replay/terminal early return. The
      // status is checked later so a legal replay remains possible after a
      // terminal transition moved the job out of RECONCILING (AUDIT-03 HIGH-02).
      const intent = await tx.query<{ job_id: string; status: JobStatus }>(
        `SELECT i.job_id, j.status FROM job_intents i
         JOIN jobs j ON i.job_id = j.job_id
         WHERE i.intent_id = $1`,
        [input.intentId],
      );
      if (intent.rows[0] === undefined || intent.rows[0].job_id !== input.jobId) {
        throw new NotFoundError("job_intent", `${input.intentId}/${input.jobId}`);
      }

      const evidenceJson =
        input.evidence === undefined || input.evidence === null
          ? null
          : JSON.stringify(input.evidence);

      // Same-key replay succeeds only for identical provenance and semantics.
      const priorAttempt = await tx.query<{
        reconciliation_id: string;
        job_id: string;
        resolution: string;
        evidence_matches: boolean;
      }>(
        `SELECT reconciliation_id, job_id, resolution,
                evidence IS NOT DISTINCT FROM $3::jsonb AS evidence_matches
         FROM job_reconciliations
         WHERE intent_id = $1 AND attempt_key = $2`,
        [input.intentId, input.attemptKey, evidenceJson],
      );
      if (priorAttempt.rows[0]) {
        if (
          priorAttempt.rows[0].job_id !== input.jobId ||
          priorAttempt.rows[0].resolution !== input.resolution ||
          !priorAttempt.rows[0].evidence_matches
        ) {
          throw new ReconciliationConflictError(input.intentId, input.attemptKey);
        }
        const job = await this.findById(tx, input.jobId);
        return {
          reconciliationId: priorAttempt.rows[0].reconciliation_id,
          resolution: priorAttempt.rows[0].resolution,
          jobStatus: job?.status ?? "RECONCILING",
        };
      }

      // Terminal idempotency: if a prior terminal row exists for this intent,
      // return it without a second job transition (idempotent close). Check this
      // BEFORE the state guard — once a terminal is written, the job may have
      // already moved to SUCCEEDED/PENDING, and a new terminal attempt for the
      // same intent should return the existing terminal without throwing.
      const terminal = await tx.query<{ reconciliation_id: string; resolution: string }>(
        `SELECT reconciliation_id, resolution FROM job_reconciliations
         WHERE intent_id = $1 AND resolution IN ('CONFIRMED', 'ABSENT')`,
        [input.intentId],
      );
      if (terminal.rows[0] && input.resolution !== "UNRESOLVED") {
        const job = await this.findById(tx, input.jobId);
        return {
          reconciliationId: terminal.rows[0].reconciliation_id,
          resolution: terminal.rows[0].resolution,
          jobStatus: job?.status ?? "SUCCEEDED",
        };
      }

      const recovery = await tx.query<{ one: number }>(
        `SELECT 1 AS one FROM engineering_recoveries
          WHERE source_job_id=$1 LIMIT 1`,
        [input.jobId],
      );
      if ((recovery.rowCount ?? 0) > 0) {
        throw new ReconciliationConflictError(input.intentId, input.attemptKey);
      }

      // A new attempt may only be recorded while the job is RECONCILING.
      if (intent.rows[0].status !== "RECONCILING") {
        throw new NotFoundError(
          "job_intent_reconciling",
          `${input.intentId}/${input.jobId} (job.status=${intent.rows[0].status})`,
        );
      }

      if (input.resolution !== "UNRESOLVED") {
        const completion = await tx.query<{ outcome: string }>(
          `SELECT outcome FROM job_completions WHERE intent_id = $1`,
          [input.intentId],
        );
        const outcome = completion.rows[0]?.outcome;
        const conflicts =
          (input.resolution === "CONFIRMED" && outcome === "FAILED") ||
          (input.resolution === "ABSENT" && outcome === "SUCCEEDED");
        if (conflicts) {
          throw new ReconciliationConflictError(input.intentId, input.attemptKey);
        }
      }

      const reconciliationId = this.ids.next("jobrecon");
      try {
        await tx.query(
          `INSERT INTO job_reconciliations (
             reconciliation_id, intent_id, job_id, resolution, evidence, attempt_key, reconciled_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, to_timestamp($7 / 1000.0))`,
          [
            reconciliationId,
            input.intentId,
            input.jobId,
            input.resolution,
            evidenceJson,
            input.attemptKey,
            nowMs,
          ],
        );
      } catch (error) {
        throw translatePgError(error) ?? error;
      }

      let jobStatus: JobStatus = "RECONCILING";
      if (input.resolution !== "UNRESOLVED") {
        const effective = await this.classifyIntentLedger(tx, input.jobId);
        const updated =
          effective.state === "SUCCEEDED"
            ? await tx.query(
                `UPDATE jobs
                 SET status = 'SUCCEEDED', finished_at = to_timestamp($2 / 1000.0),
                     lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
                 WHERE job_id = $1 AND status = 'RECONCILING'`,
                [input.jobId, nowMs],
              )
            : effective.state === "PENDING"
              ? await tx.query(
                  `UPDATE jobs
                   SET status = 'PENDING', available_at = ${this.lt.scheduleBase(2)},
                       finished_at = NULL, last_error = 'all intents resolved absent or failed'
                   WHERE job_id = $1 AND status = 'RECONCILING'`,
                  [input.jobId, nowMs],
                )
              : await tx.query(
                  `UPDATE jobs
                   SET last_error = $2
                   WHERE job_id = $1 AND status = 'RECONCILING'`,
                  [
                    input.jobId,
                    `reconciliation incomplete: succeeded=${effective.succeeded}, ` +
                      `absent=${effective.absent}, unresolved=${effective.unresolved}`,
                  ],
                );
        if ((updated.rowCount ?? 0) !== 1) {
          throw new Error(
            `reconcile(${input.resolution}): job ${input.jobId} left RECONCILING concurrently`,
          );
        }
        jobStatus = effective.state;
      }
      // UNRESOLVED: leave the job RECONCILING.
      return { reconciliationId, resolution: input.resolution, jobStatus };
    });
  }

  /**
   * Recover jobs whose lease expired. For each expired LEASED job, inspect the
   * durable intent/completion ledger:
   *   - all intents SUCCEEDED: reconstruct terminal SUCCEEDED without replay;
   *   - no intents or FAILED-only: safely return to PENDING;
   *   - any missing/AMBIGUOUS completion, or any partial multi-intent state that
   *     includes SUCCEEDED: fail closed to RECONCILING.
   * Runs under the same advisory lock as claim so it cannot race a claim.
   * Returns the job ids moved to each state.
   */
  public async reapExpired(db: TxDb, options: { limit?: number } = {}): Promise<ReapResult> {
    const nowMs = this.clock.now();
    const limit = options.limit ?? 100;
    return db.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [CLAIM_ADVISORY_LOCK_KEY.toString()]);
      const expired = await tx.query<{
        job_id: string;
        case_id: string | null;
        job_type: string;
        payload: Record<string, unknown>;
        lease_owner: string | null;
        fencing_token: string;
        attempts: number;
      }>(
        `SELECT job_id, case_id, job_type, payload, lease_owner, fencing_token, attempts FROM jobs
         WHERE status = 'LEASED' AND lease_expires_at <= ${this.lt.now(1)}
           AND job_type <> 'agent.engineering_recovery'
           AND (
             job_type <> 'agent.implementer'
             OR payload->>'reason' IS DISTINCT FROM 'engineering_approval'
           )
         ORDER BY lease_expires_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [nowMs, limit],
      );

      const reconciling: string[] = [];
      const requeued: string[] = [];
      const succeeded: string[] = [];
      for (const row of expired.rows) {
        const job_id = row.job_id;
        const effective = await this.classifyIntentLedger(tx, job_id);
        const recovery = effective.state === "PENDING" ? "REQUEUE" : effective.state;
        const attemptOutcome = recovery === "SUCCEEDED" ? "SUCCEEDED" : "LEASE_LOST";
        const attemptError =
          recovery === "SUCCEEDED"
            ? "lease expired after confirmed SUCCEEDED completion; reconstructed success"
            : recovery === "REQUEUE"
              ? effective.intents === 0
                ? "lease expired without intent; requeued"
                : "lease expired with all intents effectively absent or failed; requeued"
              : `lease expired with partial/uncertain side-effect ledger ` +
                `(succeeded=${effective.succeeded}, absent=${effective.absent}, ` +
                `unresolved=${effective.unresolved}); reconciliation required`;

        // Attempt evidence and the status transition share this transaction.
        await tx.query(
          `INSERT INTO job_attempts (
             job_id, attempt_number, lease_owner, fencing_token, outcome, error,
             started_at, finished_at)
           VALUES ($1, $2, $3, $4, $5, $6,
                   to_timestamp($7 / 1000.0), to_timestamp($7 / 1000.0))
           ON CONFLICT (job_id, attempt_number) DO NOTHING`,
          [
            job_id,
            row.attempts,
            row.lease_owner ?? "unknown",
            row.fencing_token,
            attemptOutcome,
            attemptError,
            nowMs,
          ],
        );
        if (recovery === "SUCCEEDED") {
          const updated = await tx.query(
            `UPDATE jobs
             SET status = 'SUCCEEDED', lease_owner = NULL, lease_expires_at = NULL,
                 finished_at = to_timestamp($2 / 1000.0), last_error = NULL
             WHERE job_id = $1 AND status = 'LEASED'`,
            [job_id, nowMs],
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error(`reapExpired(SUCCEEDED): job ${job_id} left LEASED concurrently`);
          }
          succeeded.push(job_id);
        } else if (recovery === "RECONCILING") {
          const updated = await tx.query(
            `UPDATE jobs
             SET status = 'RECONCILING', lease_owner = NULL, lease_expires_at = NULL,
                  last_error = $2
              WHERE job_id = $1 AND status = 'LEASED'`,
            [job_id, attemptError],
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error(`reapExpired(RECONCILING): job ${job_id} left LEASED concurrently`);
          }
          reconciling.push(job_id);
        } else {
          const updated = await tx.query(
            `UPDATE jobs
             SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
                  available_at = ${this.lt.scheduleBase(2)}, last_error = $3
              WHERE job_id = $1 AND status = 'LEASED'`,
            [job_id, nowMs, attemptError],
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error(`reapExpired(REQUEUE): job ${job_id} left LEASED concurrently`);
          }
          requeued.push(job_id);
        }
      }
      return { reconciling, requeued, succeeded };
    });
  }

  /** List dead-lettered jobs (DLQ view, observability). */
  public async listDeadLettered(q: Queryable): Promise<JobRow[]> {
    const r = await q.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE status = 'DEAD_LETTER' ORDER BY dead_lettered_at ASC`,
    );
    return r.rows;
  }

  /** List the append-only attempt history for a job (observability/tests). */
  public async attemptHistory(
    q: Queryable,
    jobId: string,
  ): Promise<
    { attempt_number: number; outcome: string; fencing_token: string; error: string | null }[]
  > {
    const r = await q.query<{
      attempt_number: number;
      outcome: string;
      fencing_token: string;
      error: string | null;
    }>(
      `SELECT attempt_number, outcome, fencing_token, error
       FROM job_attempts WHERE job_id = $1 ORDER BY attempt_number ASC`,
      [jobId],
    );
    return r.rows;
  }

  /** Read a job row by id (observability/tests). */
  public async findById(q: Queryable, jobId: string): Promise<JobRow | null> {
    const r = await q.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE job_id = $1`, [jobId]);
    return r.rows[0] ?? null;
  }
}
