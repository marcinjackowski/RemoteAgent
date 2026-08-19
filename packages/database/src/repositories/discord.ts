/**
 * Discord case-interface persistence (RA-006).
 *
 * Two responsibilities, mirroring migration 020:
 *
 *   - {@link DiscordBindingRepository} owns the authoritative one-row-per-case
 *     mapping to a Discord channel/thread/anchor/status message and the per-case
 *     monotonic delivery sequence. Callers take a row lock ({@link lockForUpdate})
 *     to serialize a single case's outbound deliveries (ordering) while different
 *     cases lock different rows and run in parallel.
 *   - {@link DiscordReceiptRepository} is the append-only idempotency ledger the
 *     outbox consumer dedupes on: a receipt keyed by the originating outbox id
 *     means "this side effect already happened", so a redelivered outbox event
 *     never creates a second message or thread.
 *
 * Neither repository trusts model output: channel/owner ids are supplied by the
 * caller from configuration assigned outside the model (Master Plan §3.4, §9).
 */
import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";

export interface DiscordBindingRow {
  case_id: string;
  owner_id: string;
  channel_id: string;
  thread_id: string | null;
  root_message_id: string | null;
  status_message_id: string | null;
  next_seq: string;
  delivered_seq: string;
  /** Highest checkpoint revision projected into the pinned status message. */
  last_status_revision: string | null;
  created_at: Date;
  updated_at: Date;
}

export type DiscordDispatchKind = "ROOT_THREAD" | "THREAD_MESSAGE" | "STATUS_UPSERT";

/** Run-safety state of a single Discord side effect (Master Plan §6.2). */
export type DiscordSendIntentStatus = "STARTED" | "SUCCEEDED" | "AMBIGUOUS" | "RETRYABLE";

export interface DiscordSendIntentRow {
  idempotency_key: string;
  case_id: string;
  outbox_id: string;
  step: string;
  status: DiscordSendIntentStatus;
  discord_message_id: string | null;
  discord_thread_id: string | null;
  attempts: number;
  last_error: string | null;
  /**
   * Per-attempt ownership fence (AUDIT-03 MEDIUM-16). Minted by the claimer /
   * re-owner; a terminal transition requires this token so a loser that never
   * owned the attempt can never mutate an active winner's intent.
   */
  owner_token: string | null;
  /** Bounded lease: while in the future the STARTED attempt is ACTIVE. */
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Result of an atomic {@link DiscordSendIntentRepository.claim}. `inserted` is
 * `true` for the single caller whose transaction actually inserted the STARTED
 * row (the fresh winner allowed to perform the side effect) and `false` for every
 * other caller, which must reconcile/halt instead of repeating the write
 * (AUDIT-02 HIGH-08).
 */
export interface DiscordSendIntentClaim {
  row: DiscordSendIntentRow;
  inserted: boolean;
}

export interface DiscordReceiptRow {
  dedupe_key: string;
  case_id: string;
  kind: DiscordDispatchKind;
  seq: string | null;
  discord_message_id: string | null;
  discord_thread_id: string | null;
  created_at: Date;
}

export class DiscordBindingRepository {
  /**
   * Create the case↔channel binding if it does not exist yet, returning the
   * current row either way. Idempotent: a duplicate call (e.g. a redelivered
   * "case created" event) never inserts a second row and never changes the
   * channel of an existing binding.
   */
  public async ensure(
    q: Queryable,
    input: { caseId: string; ownerId: string; channelId: string },
  ): Promise<DiscordBindingRow> {
    try {
      const result = await q.query<DiscordBindingRow>(
        `INSERT INTO discord_case_bindings (case_id, owner_id, channel_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (case_id) DO UPDATE SET case_id = discord_case_bindings.case_id
         RETURNING case_id, owner_id, channel_id, thread_id, root_message_id,
                   status_message_id, next_seq, delivered_seq, last_status_revision,
              created_at, updated_at`,
        [input.caseId, input.ownerId, input.channelId],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /** Read a binding without locking (observability / intake resolution). */
  public async find(q: Queryable, caseId: string): Promise<DiscordBindingRow | null> {
    const result = await q.query<DiscordBindingRow>(
      `SELECT case_id, owner_id, channel_id, thread_id, root_message_id,
              status_message_id, next_seq, delivered_seq, last_status_revision,
              created_at, updated_at
       FROM discord_case_bindings WHERE case_id = $1`,
      [caseId],
    );
    return result.rows[0] ?? null;
  }

  /** Resolve the case that owns a given Discord thread (inbound routing). */
  public async findByThread(q: Queryable, threadId: string): Promise<DiscordBindingRow | null> {
    const result = await q.query<DiscordBindingRow>(
      `SELECT case_id, owner_id, channel_id, thread_id, root_message_id,
              status_message_id, next_seq, delivered_seq, last_status_revision,
              created_at, updated_at
       FROM discord_case_bindings WHERE thread_id = $1`,
      [threadId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Take the per-case row lock and return the current binding. Held for the rest
   * of the transaction, this serializes one case's outbound deliveries (ordering)
   * without blocking other cases (they lock other rows).
   */
  public async lockForUpdate(tx: Transaction, caseId: string): Promise<DiscordBindingRow | null> {
    const result = await tx.query<DiscordBindingRow>(
      `SELECT case_id, owner_id, channel_id, thread_id, root_message_id,
              status_message_id, next_seq, delivered_seq, last_status_revision,
              created_at, updated_at
       FROM discord_case_bindings WHERE case_id = $1 FOR UPDATE`,
      [caseId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Reserve and return the next PRODUCER sequence for a case, advancing the
   * counter atomically. A producer calls this when it enqueues an ordered send so
   * every ordered message carries a gap-free, monotonic seq. MUST be called while
   * holding {@link lockForUpdate} so two producers never reserve the same slot.
   */
  public async reserveSeq(tx: Transaction, caseId: string): Promise<number> {
    const result = await tx.query<{ seq: string }>(
      `UPDATE discord_case_bindings
       SET next_seq = next_seq + 1
       WHERE case_id = $1
       RETURNING (next_seq - 1)::bigint AS seq`,
      [caseId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`cannot reserve sequence: no Discord binding for case ${caseId}`);
    }
    return Number(row.seq);
  }

  /**
   * Advance the DELIVERED sequence to `seq` after a message with that reserved
   * sequence has been posted to Discord. Fail-closed: only advances when `seq` is
   * exactly `delivered_seq + 1`, so ordering can never skip a slot; returns
   * whether the advance applied. MUST be called while holding
   * {@link lockForUpdate}.
   */
  public async advanceDelivered(tx: Transaction, caseId: string, seq: number): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_case_bindings
       SET delivered_seq = $2
       WHERE case_id = $1 AND delivered_seq = $2 - 1`,
      [caseId, seq],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Persist the thread + anchor message once the thread has been created. */
  public async setThread(
    tx: Transaction,
    caseId: string,
    input: { threadId: string; rootMessageId: string },
  ): Promise<void> {
    try {
      await tx.query(
        `UPDATE discord_case_bindings
         SET thread_id = $2, root_message_id = $3
         WHERE case_id = $1`,
        [caseId, input.threadId, input.rootMessageId],
      );
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /** Persist the pinned/projected status message id once created. */
  public async setStatusMessage(
    tx: Transaction,
    caseId: string,
    statusMessageId: string,
  ): Promise<void> {
    await tx.query(`UPDATE discord_case_bindings SET status_message_id = $2 WHERE case_id = $1`, [
      caseId,
      statusMessageId,
    ]);
  }

  /**
   * Monotonic status-revision gate (AUDIT-01 MEDIUM-05). Advance
   * `last_status_revision` to `revision` only when it is strictly greater than
   * the current value (NULL counts as "none yet"), so a late or reordered status
   * projection can never roll the pinned message backwards. Returns whether the
   * advance applied — `false` means this revision is stale and the caller MUST
   * skip the Discord edit. MUST be called while holding {@link lockForUpdate}.
   */
  public async advanceStatusRevision(
    tx: Transaction,
    caseId: string,
    revision: number,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_case_bindings
       SET last_status_revision = $2
       WHERE case_id = $1
         AND (last_status_revision IS NULL OR last_status_revision < $2)`,
      [caseId, revision],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

/**
 * Durable per-side-effect intent ledger (RA-006, AUDIT-01 HIGH-01).
 *
 * Every Discord write is preceded by a COMMITTED {@link DiscordSendIntentRow} in
 * `STARTED`, keyed by a deterministic idempotency key (`<outbox_id>:<step>`).
 * After the write the intent is marked `SUCCEEDED`; an unrecoverable outcome is
 * marked `AMBIGUOUS`. Because the STARTED row is durable BEFORE the side effect,
 * a crash or lost response is detectable on the next attempt: a pre-existing
 * `STARTED` means "outcome unknown, do not blindly replay" (Master Plan §6.2).
 */
export class DiscordSendIntentRepository {
  private static readonly COLUMNS = `idempotency_key, case_id, outbox_id, step, status,
              discord_message_id, discord_thread_id, attempts, last_error,
              owner_token, lease_expires_at, created_at, updated_at`;

  /** Look up an intent by its deterministic idempotency key. */
  public async find(q: Queryable, idempotencyKey: string): Promise<DiscordSendIntentRow | null> {
    const result = await q.query<DiscordSendIntentRow>(
      `SELECT ${DiscordSendIntentRepository.COLUMNS}
       FROM discord_send_intents WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Atomically CLAIM a fresh STARTED intent (AUDIT-02 HIGH-08, AUDIT-03 MEDIUM-16).
   * Uses `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so the RETURNING row is
   * present ONLY for the transaction that actually inserted it. Two racing
   * claimants that both see no prior row therefore get a DETERMINISTIC single
   * winner: the second INSERT blocks on the first and, once it commits, matches
   * the conflict and returns no row. The winner (`inserted: true`) records its
   * `ownerToken` + a bounded lease and may perform the side effect; every loser
   * (`inserted: false`) receives the existing row and must reconcile or halt
   * rather than repeat the write. MUST be committed before the side effect.
   */
  public async claim(
    tx: Transaction,
    input: {
      idempotencyKey: string;
      caseId: string;
      outboxId: string;
      step: string;
      ownerToken: string;
      leaseMs: number;
    },
  ): Promise<DiscordSendIntentClaim> {
    try {
      const inserted = await tx.query<DiscordSendIntentRow>(
        `INSERT INTO discord_send_intents (
           idempotency_key, case_id, outbox_id, step, status,
           owner_token, lease_expires_at)
         VALUES ($1, $2, $3, $4, 'STARTED', $5, now() + ($6::bigint * interval '1 millisecond'))
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING ${DiscordSendIntentRepository.COLUMNS}`,
        [
          input.idempotencyKey,
          input.caseId,
          input.outboxId,
          input.step,
          input.ownerToken,
          input.leaseMs,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        return { row: inserted.rows[0], inserted: true };
      }
      const existing = await tx.query<DiscordSendIntentRow>(
        `SELECT ${DiscordSendIntentRepository.COLUMNS}
         FROM discord_send_intents WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      return { row: existing.rows[0]!, inserted: false };
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Re-own a RETRYABLE (provably-not-delivered) intent for a fresh attempt,
   * flipping it back to STARTED, minting a new `ownerToken` + lease and counting
   * the attempt. Fenced on the current status so only one caller can take it;
   * returns whether this call won.
   */
  public async takeForRetry(
    tx: Transaction,
    idempotencyKey: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_send_intents
       SET status = 'STARTED', attempts = attempts + 1,
           owner_token = $2, lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
       WHERE idempotency_key = $1 AND status = 'RETRYABLE'`,
      [idempotencyKey, ownerToken, leaseMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Re-own a non-terminal intent (STARTED/AMBIGUOUS/RETRYABLE) for a fresh attempt
   * of a RECONCILABLE side effect whose object was proven NOT to exist. Only valid
   * under the per-case row lock (single writer). Never matches SUCCEEDED, so a
   * completed side effect can never be re-performed. Mints a new `ownerToken` +
   * lease. Returns whether it applied.
   */
  public async reopen(
    tx: Transaction,
    idempotencyKey: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_send_intents
       SET status = 'STARTED', attempts = attempts + 1,
           owner_token = $2, lease_expires_at = now() + ($3::bigint * interval '1 millisecond')
       WHERE idempotency_key = $1 AND status IN ('STARTED', 'AMBIGUOUS', 'RETRYABLE')`,
      [idempotencyKey, ownerToken, leaseMs],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Mark an intent SUCCEEDED with the resulting Discord ids. Fenced on the
   * `ownerToken` (AUDIT-03 MEDIUM-16) and on not-already-SUCCEEDED, so ONLY the
   * caller that currently owns the attempt can complete it — even if a racing
   * lease-expiry takeover flipped the status to AMBIGUOUS in the meantime, the
   * true performer (which holds the unique token) still wins — and a completed
   * result can never be overwritten. Returns whether the transition applied.
   */
  public async succeed(
    tx: Transaction,
    idempotencyKey: string,
    ids: { discordMessageId: string | null; discordThreadId: string | null },
    ownerToken: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_send_intents
       SET status = 'SUCCEEDED', discord_message_id = $2, discord_thread_id = $3
       WHERE idempotency_key = $1 AND owner_token = $4 AND status <> 'SUCCEEDED'`,
      [idempotencyKey, ids.discordMessageId, ids.discordThreadId, ownerToken],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Mark the OWNER's intent AMBIGUOUS: the side effect may or may not have taken
   * effect and cannot be reconciled, so automatic replay is halted (Master Plan
   * §6.2). Fenced on the `ownerToken` and on not-already-SUCCEEDED (AUDIT-03
   * MEDIUM-16, AUDIT-04 MEDIUM-21). Crucially it is NOT restricted to `STARTED`:
   * if a racing lease-expiry observer already flipped this attempt to `AMBIGUOUS`,
   * the TRUE owner (holder of the unique token) may still overwrite it with its own
   * evidence — a loser, lacking the token, never can. Records the last error.
   */
  public async markAmbiguous(
    tx: Transaction,
    idempotencyKey: string,
    ownerToken: string,
    lastError?: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_send_intents
       SET status = 'AMBIGUOUS', attempts = attempts + 1,
           last_error = COALESCE($3, last_error)
       WHERE idempotency_key = $1 AND owner_token = $2 AND status <> 'SUCCEEDED'`,
      [idempotencyKey, ownerToken, lastError ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Transition a PROVABLY-ABANDONED STARTED intent to AMBIGUOUS during recovery:
   * a previous owner's attempt whose bounded lease has lapsed with an unknown
   * outcome (AUDIT-03 MEDIUM-16). Fenced on the EXPIRY (`lease_expires_at < now()`),
   * NOT on ownership, so it can never touch an in-flight winner whose lease is
   * still valid — that winner is left to complete. Returns whether it applied.
   */
  public async expireToAmbiguous(
    tx: Transaction,
    idempotencyKey: string,
    lastError?: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_send_intents
       SET status = 'AMBIGUOUS', attempts = attempts + 1,
           last_error = COALESCE($2, last_error)
       WHERE idempotency_key = $1 AND status = 'STARTED'
         AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
      [idempotencyKey, lastError ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Mark the OWNER's intent RETRYABLE: the side effect PROVABLY did NOT take effect
   * (the request was rejected before any side effect — e.g. a 429), so a later pass
   * may re-own ({@link takeForRetry}) and re-issue it. Unlike a delete, the row is
   * KEPT so the ledger preserves the attempt count and last error for operator
   * diagnosis (AUDIT-02 MEDIUM-12). Fenced on the `ownerToken` and not-already-
   * SUCCEEDED (AUDIT-03 MEDIUM-16, AUDIT-04 MEDIUM-21): it is deliberately NOT
   * restricted to `STARTED`, so when a racing lease-expiry observer already flipped
   * this attempt to `AMBIGUOUS`, the TRUE owner — which alone knows the write was
   * rejected — can still record the accurate RETRYABLE terminal instead of leaving
   * a provably-not-delivered write falsely stuck as an unknown outcome.
   */
  public async markRetryable(
    tx: Transaction,
    idempotencyKey: string,
    ownerToken: string,
    lastError?: string,
  ): Promise<boolean> {
    const result = await tx.query(
      `UPDATE discord_send_intents
       SET status = 'RETRYABLE', attempts = attempts + 1,
           last_error = COALESCE($3, last_error)
       WHERE idempotency_key = $1 AND owner_token = $2 AND status <> 'SUCCEEDED'`,
      [idempotencyKey, ownerToken, lastError ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** All intents for a case, for observability/tests. */
  public async listByCase(q: Queryable, caseId: string): Promise<DiscordSendIntentRow[]> {
    const result = await q.query<DiscordSendIntentRow>(
      `SELECT ${DiscordSendIntentRepository.COLUMNS}
       FROM discord_send_intents WHERE case_id = $1 ORDER BY created_at ASC`,
      [caseId],
    );
    return result.rows;
  }
}

export class DiscordReceiptRepository {
  /** Look up a prior delivery by its idempotency key. */
  public async find(q: Queryable, dedupeKey: string): Promise<DiscordReceiptRow | null> {
    const result = await q.query<DiscordReceiptRow>(
      `SELECT dedupe_key, case_id, kind, seq, discord_message_id, discord_thread_id, created_at
       FROM discord_dispatch_receipts WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Record a completed delivery. The primary key on `dedupe_key` and the unique
   * `(case_id, seq)` index make a duplicate insert fail closed
   * ({@link UniqueViolationError}) rather than silently create a second message.
   */
  public async record(
    tx: Transaction,
    input: {
      dedupeKey: string;
      caseId: string;
      kind: DiscordDispatchKind;
      seq: number | null;
      discordMessageId: string | null;
      discordThreadId: string | null;
    },
  ): Promise<DiscordReceiptRow> {
    try {
      const result = await tx.query<DiscordReceiptRow>(
        `INSERT INTO discord_dispatch_receipts (
           dedupe_key, case_id, kind, seq, discord_message_id, discord_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING dedupe_key, case_id, kind, seq, discord_message_id, discord_thread_id, created_at`,
        [
          input.dedupeKey,
          input.caseId,
          input.kind,
          input.seq,
          input.discordMessageId,
          input.discordThreadId,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }
}
