/**
 * Transactional outbox (RA-004).
 *
 * The outbox links a committed DB change to later publication (Master Plan §3.2).
 * A caller enqueues an outbox message *inside the same {@link Transaction}* as
 * its business write via {@link OutboxRepository.enqueue}, so the message and the
 * state change commit atomically (RA-004 acceptance criterion 1) — there is no
 * window where the state changed but the message was lost, or vice versa. The
 * `enqueue` signature demands a branded {@link Transaction} (never the auto-commit
 * pool), which makes "publish without the state change" a compile-time error.
 *
 * A relay later CLAIMS pending dispatch rows with a durable lease
 * (`SELECT ... FOR UPDATE SKIP LOCKED`), publishes them through a caller-supplied
 * sink, and marks them PUBLISHED. Because the ledger row is immutable and each
 * dispatch row is claimed under a row lock, a message is delivered at-least-once;
 * consumers dedupe on `outbox_id` for exactly-once effect. Publish failures are
 * retried with bounded exponential backoff and dead-lettered after `maxAttempts`.
 */
import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import { backoffDelayMs } from "./backoff.js";
import { leaseTimeSql, type LeaseTimeSql } from "./lease-time.js";
import type { Clock, IdGenerator, LeaseTimeMode } from "./runtime.js";

export interface EnqueueOutbox {
  aggregate: string;
  aggregateId: string;
  eventType: string;
  /** Canonical payload; the caller must have redacted secrets/raw payloads. */
  payload: Record<string, unknown>;
  /** Per-message retry policy override (defaults applied in SQL otherwise). */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

export interface OutboxRow {
  outbox_id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface ClaimableDispatch {
  outbox_id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  backoff_base_ms: string;
  backoff_cap_ms: string;
  /** Monotonic fencing token this relay claimed the row with. */
  dispatch_token: string;
  /** The relay owner id that holds the lease on this row. */
  lease_owner: string;
}

/** Outcome of a relay pass. */
export interface RelayResult {
  published: string[];
  retried: string[];
  deadLettered: string[];
}

/** A sink publishes a single claimed outbox message. Throwing = publish failed. */
export type OutboxSink = (message: ClaimableDispatch) => Promise<void>;

export class OutboxRepository {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly lt: LeaseTimeSql;

  public constructor(runtime: { clock: Clock; ids: IdGenerator; leaseTime?: LeaseTimeMode }) {
    this.clock = runtime.clock;
    this.ids = runtime.ids;
    // DB server clock is the authoritative relay-lease source by default
    // (audit MEDIUM-07); tests opt into 'injected' explicitly.
    this.lt = leaseTimeSql(runtime.leaseTime ?? "db");
  }

  /**
   * Enqueue an outbox message inside the caller's transaction. The message and
   * the business change share one atomic boundary (acceptance criterion 1).
   * Inserts both the immutable ledger row and its mutable dispatch bookkeeping
   * row (status PENDING, available immediately).
   */
  public async enqueue(tx: Transaction, input: EnqueueOutbox): Promise<OutboxRow> {
    const outboxId = this.ids.next("outbox");
    const nowMs = this.clock.now();
    try {
      const inserted = await tx.query<OutboxRow>(
        `INSERT INTO outbox (outbox_id, aggregate, aggregate_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0))
         RETURNING outbox_id, aggregate, aggregate_id, event_type, payload, created_at`,
        [
          outboxId,
          input.aggregate,
          input.aggregateId,
          input.eventType,
          JSON.stringify(input.payload),
          nowMs,
        ],
      );
      await tx.query(
        `INSERT INTO outbox_dispatch (
            outbox_id, status, attempts, available_at, max_attempts, backoff_base_ms, backoff_cap_ms)
          VALUES ($1, 'PENDING', 0, ${this.lt.scheduleBase(2)}, COALESCE($3, 10),
                  COALESCE($4, 1000), COALESCE($5, 3600000))`,
        [
          outboxId,
          nowMs,
          input.maxAttempts ?? null,
          input.backoffBaseMs ?? null,
          input.backoffCapMs ?? null,
        ],
      );
      return inserted.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Run one relay pass: claim up to `batchSize` runnable dispatch rows under a
   * row lock, publish each through `sink`, and record the outcome. Returns the
   * ids that were published, retried (with backoff), and dead-lettered.
   *
   * Concurrency-safe: `FOR UPDATE SKIP LOCKED` means two relays never claim the
   * same row. Each message is processed inside its own transaction so a crash
   * mid-pass leaves already-published rows PUBLISHED and unprocessed rows PENDING.
   */
  public async relayOnce(
    db: { withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> },
    sink: OutboxSink,
    options: { batchSize?: number; leaseMs?: number; aggregates?: readonly string[] } = {},
  ): Promise<RelayResult> {
    const batchSize = options.batchSize ?? 32;
    const leaseMs = options.leaseMs ?? 30_000;
    const result: RelayResult = { published: [], retried: [], deadLettered: [] };

    // Claim a batch atomically (one short transaction), then publish outside the
    // claim transaction so a slow sink does not hold row locks. The lease
    // (lease_expires_at) protects the claimed rows until they are resolved.
    const nowMs = this.clock.now();
    const owner = this.ids.next("relay");

    // Aggregate-scoped claim (ADR-0009). A relay only claims rows for aggregates it can
    // deliver, so process-scoped relays never contend over the same rows. Absent filter =
    // claim everything (backward compatible with pre-ADR-0009 callers). An EMPTY list is a
    // real value meaning "claim nothing" (`= ANY('{}')` is always false) — that is how a
    // job-only process (the worker) opts out of delivery without disabling the relay pass.
    // When filtering we join `outbox` in the claimable CTE and lock ONLY `outbox_dispatch`
    // (`FOR UPDATE OF d`): the `outbox` ledger is immutable and must never be lock-contended.
    const scoped = options.aggregates !== undefined;
    const claimParams: unknown[] = [nowMs, batchSize, owner, leaseMs];
    if (scoped) claimParams.push(options.aggregates);
    const claimable = scoped
      ? `SELECT d.outbox_id
           FROM outbox_dispatch d
           JOIN outbox o ON o.outbox_id = d.outbox_id
           WHERE d.status = 'PENDING'
             AND d.available_at <= ${this.lt.now(1)}
             AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= ${this.lt.now(1)})
             AND o.aggregate = ANY($5::text[])
           ORDER BY d.available_at ASC
           FOR UPDATE OF d SKIP LOCKED
           LIMIT $2`
      : `SELECT d.outbox_id
           FROM outbox_dispatch d
           WHERE d.status = 'PENDING'
             AND d.available_at <= ${this.lt.now(1)}
             AND (d.lease_expires_at IS NULL OR d.lease_expires_at <= ${this.lt.now(1)})
           ORDER BY d.available_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $2`;
    const claimed = await db.withTransaction(async (tx) => {
      const rows = await tx.query<ClaimableDispatch>(
        `WITH claimable AS (
           ${claimable}
         )
         UPDATE outbox_dispatch d
         SET lease_owner = $3,
             lease_expires_at = ${this.lt.deadline(1, 4)},
             dispatch_token = d.dispatch_token + 1
         FROM claimable c
         JOIN outbox o ON o.outbox_id = c.outbox_id
         WHERE d.outbox_id = c.outbox_id
         RETURNING d.outbox_id, o.aggregate, o.aggregate_id, o.event_type, o.payload,
                   d.attempts, d.max_attempts, d.backoff_base_ms, d.backoff_cap_ms,
                   d.dispatch_token, d.lease_owner`,
        claimParams,
      );
      return rows.rows;
    });

    for (const message of claimed) {
      // Before doing any work for this message, lease-conditionally VALIDATE and
      // RENEW the lease for the exact (owner, dispatch_token). Because the claim
      // grabs the whole batch at once, later rows in a large batch could have
      // aged past their lease before we reach them; renewing here (a) refreshes
      // the deadline against the current clock and (b) proves we still own the
      // row. If zero rows match, another relay has taken over: SKIP the sink
      // entirely so a stale relay never re-publishes or disturbs the winner
      // (audit HIGH-03).
      const renewAt = this.clock.now();
      const stillOwned = await db.withTransaction(async (tx) => {
        const r = await tx.query(
          `UPDATE outbox_dispatch
           SET lease_expires_at = ${this.lt.deadline(2, 3)}
           WHERE outbox_id = $1 AND lease_owner = $4 AND dispatch_token = $5
             AND status = 'PENDING'
             AND lease_expires_at > ${this.lt.now(2)}`,
          [message.outbox_id, renewAt, leaseMs, message.lease_owner, message.dispatch_token],
        );
        return (r.rowCount ?? 0) > 0;
      });
      if (!stillOwned) {
        // Lost/expired lease before we even started: do not publish or finalize.
        continue;
      }

      try {
        await sink(message);
        // Read the authoritative comparison time AFTER the sink resolves, so the
        // live-lease check reflects how long publishing actually took.
        const finalizeNow = this.clock.now();
        // Publish finalize is fencing-gated: only the relay that still holds the
        // live lease with the exact dispatch_token may mark PUBLISHED. A stale
        // relay (lease expired + row re-claimed) matches zero rows and MUST NOT
        // touch the row — this prevents rolling a PUBLISHED row back to PENDING
        // (audit HIGH-03).
        const ok = await db.withTransaction(async (tx) => {
          const r = await tx.query(
            `UPDATE outbox_dispatch
             SET status = 'PUBLISHED', attempts = attempts + 1,
                 published_at = to_timestamp($2 / 1000.0),
                 lease_owner = NULL, lease_expires_at = NULL
             WHERE outbox_id = $1 AND lease_owner = $3 AND dispatch_token = $4
               AND status = 'PENDING'
               AND lease_expires_at > ${this.lt.now(2)}`,
            [message.outbox_id, finalizeNow, message.lease_owner, message.dispatch_token],
          );
          return (r.rowCount ?? 0) > 0;
        });
        if (ok) {
          result.published.push(message.outbox_id);
        }
      } catch (error) {
        // Authoritative time read AFTER the sink failed (same reasoning).
        const finalizeNow = this.clock.now();
        const attempts = message.attempts + 1;
        const message_text = error instanceof Error ? error.message : String(error);
        if (attempts >= message.max_attempts) {
          const ok = await db.withTransaction(async (tx) => {
            const r = await tx.query(
              `UPDATE outbox_dispatch
               SET status = 'DEAD_LETTER', attempts = $2,
                   last_error = $3, dead_lettered_at = to_timestamp($4 / 1000.0),
                   lease_owner = NULL, lease_expires_at = NULL
               WHERE outbox_id = $1 AND lease_owner = $5 AND dispatch_token = $6
                 AND status = 'PENDING'
                 AND lease_expires_at > ${this.lt.now(4)}`,
              [
                message.outbox_id,
                attempts,
                message_text.slice(0, 4000),
                finalizeNow,
                message.lease_owner,
                message.dispatch_token,
              ],
            );
            return (r.rowCount ?? 0) > 0;
          });
          if (ok) {
            result.deadLettered.push(message.outbox_id);
          }
        } else {
          const delay = backoffDelayMs(attempts, {
            baseMs: Number(message.backoff_base_ms),
            capMs: Number(message.backoff_cap_ms),
          });
          const ok = await db.withTransaction(async (tx) => {
            const r = await tx.query(
              `UPDATE outbox_dispatch
               SET status = 'PENDING', attempts = $2, last_error = $3,
                   available_at = ${this.lt.scheduleBase(4)} + make_interval(secs => $5::bigint / 1000.0),
                   lease_owner = NULL, lease_expires_at = NULL
               WHERE outbox_id = $1 AND lease_owner = $6 AND dispatch_token = $7
                 AND status = 'PENDING'
                 AND lease_expires_at > ${this.lt.now(4)}`,
              [
                message.outbox_id,
                attempts,
                message_text.slice(0, 4000),
                finalizeNow,
                delay,
                message.lease_owner,
                message.dispatch_token,
              ],
            );
            return (r.rowCount ?? 0) > 0;
          });
          if (ok) {
            result.retried.push(message.outbox_id);
          }
        }
      }
    }

    return result;
  }

  /** Read a dispatch row's current publication state (observability/tests). */
  public async dispatchStatus(
    q: Queryable,
    outboxId: string,
  ): Promise<{ status: string; attempts: number } | null> {
    const r = await q.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM outbox_dispatch WHERE outbox_id = $1`,
      [outboxId],
    );
    return r.rows[0] ?? null;
  }

  /** List dead-lettered dispatch rows for the DLQ view (observability). */
  public async listDeadLettered(
    q: Queryable,
  ): Promise<{ outbox_id: string; last_error: string | null; dead_lettered_at: Date | null }[]> {
    const r = await q.query<{
      outbox_id: string;
      last_error: string | null;
      dead_lettered_at: Date | null;
    }>(
      `SELECT outbox_id, last_error, dead_lettered_at
       FROM outbox_dispatch WHERE status = 'DEAD_LETTER'
       ORDER BY dead_lettered_at ASC`,
    );
    return r.rows;
  }
}
