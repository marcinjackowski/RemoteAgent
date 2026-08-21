/**
 * Durable credential-refresh intent persistence (RA-005 remediation, HIGH-02).
 *
 * The intent gives a credential-vault write a stable idempotency identity and a
 * well-defined status across timeout/crash. No secret value ever enters this
 * table; it holds only the opaque vault reference and lifecycle metadata.
 */
import type { Provider } from "@remoteagent/contracts";

import type { Queryable } from "../client.js";
import { translatePgError } from "../client.js";
import { CredentialRefreshIdentityError } from "@remoteagent/contracts";
import type { RefreshIntentStatus } from "@remoteagent/contracts";

/**
 * Re-exported from `@remoteagent/contracts`, which is the single definition
 * (RA-023-WU-00). This package and `packages/policy` each declared an identical copy;
 * the duplication was type-only, so it was invisible to `typecheck`, `build` and any
 * runtime export scan, and was found only by a `ts.Program` probe.
 */
export type { RefreshIntentStatus };

export interface RefreshIntentRow {
  operation_id: string;
  connection_id: string;
  owner_id: string;
  provider: Provider;
  /** bigint serialized as text by the driver. */
  expected_revision: string;
  version_id: string;
  credential_secret_ref: string;
  status: RefreshIntentStatus;
  oauth_expires_at: Date | null;
  oauth_refresh_after: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Statuses whose recorded outcome is final; the lease is never re-claimed. */
const TERMINAL_STATUSES = ["PUBLISHED", "ABORTED", "AMBIGUOUS"] as const;

export interface BeginRefreshIntent {
  operationId: string;
  connectionId: string;
  ownerId: string;
  provider: Provider;
  expectedRevision: bigint;
  versionId: string;
  credentialSecretRef: string;
}

/** Outcome of a durable single-executor lease claim (AUDIT-03 HIGH-05). */
export interface RefreshLeaseClaim {
  /** True when THIS caller now holds the lease and may run the side effect. */
  acquired: boolean;
  row: RefreshIntentRow;
  /** The fresh fencing token, present only when `acquired`. */
  fencingToken: bigint | null;
}

const COLUMNS = `operation_id, connection_id, owner_id, provider, expected_revision,
  version_id, credential_secret_ref, status, oauth_expires_at, oauth_refresh_after,
  created_at, updated_at`;

export class CredentialRefreshIntentRepository {
  /**
   * Idempotently create the intent. If `operation_id` already exists the stored
   * row (with its already-chosen version_id/ref) is returned unchanged, so a
   * retry re-addresses the SAME vault object rather than minting a new one.
   *
   * The stored row's IMMUTABLE identity (connection, owner, provider, expected
   * revision) is verified against the request fail-closed: a reused/replayed
   * operation_id that names a different identity is rejected BEFORE any caller
   * probes the vault or publishes metadata (AUDIT-02 HIGH-04), so a credential
   * reference can never be crossed between connections/owners/aliases.
   */
  public async begin(q: Queryable, input: BeginRefreshIntent): Promise<RefreshIntentRow> {
    try {
      await q.query(
        `INSERT INTO credential_refresh_intents (
           operation_id, connection_id, owner_id, provider, expected_revision,
           version_id, credential_secret_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (operation_id) DO NOTHING`,
        [
          input.operationId,
          input.connectionId,
          input.ownerId,
          input.provider,
          input.expectedRevision.toString(),
          input.versionId,
          input.credentialSecretRef,
        ],
      );
      const row = await this.findById(q, input.operationId);
      if (row === null) {
        throw new Error(`refresh intent disappeared after insert: ${input.operationId}`);
      }
      assertRowIdentity(row, input);
      return row;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async recordLifecycle(
    q: Queryable,
    operationId: string,
    lifecycle: { expiresAt: Date; refreshAfter: Date },
    lease: { holder: string; fencingToken: bigint },
  ): Promise<boolean> {
    const result = await q.query(
      `UPDATE credential_refresh_intents
       SET oauth_expires_at = $2, oauth_refresh_after = $3, updated_at = now()
       WHERE operation_id = $1 AND lease_holder = $4 AND lease_fencing_token = $5`,
      [
        operationId,
        lifecycle.expiresAt,
        lifecycle.refreshAfter,
        lease.holder,
        lease.fencingToken.toString(),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomically claim the single-executor lease. A single UPDATE elects at most one
   * winner under concurrency (the row lock serializes contenders): the lease is
   * taken only when the operation is non-terminal AND free or expired against the
   * DATABASE's own clock (`now()`), bumping the fencing token. The deadline is
   * stamped as `now() + leaseDurationMs`, so a worker with a skewed clock can
   * neither hold past the store deadline nor prematurely take over a live peer
   * (AUDIT-04 HIGH-08). When no row is updated the caller is an observer; we then
   * read the row so the caller can tell a terminal outcome from a live foreign
   * lease (AUDIT-03 HIGH-05).
   */
  public async acquireLease(
    q: Queryable,
    input: { operationId: string; holder: string; leaseDurationMs: number },
  ): Promise<RefreshLeaseClaim> {
    try {
      const claimed = await q.query<RefreshIntentRow & { lease_fencing_token: string }>(
        `UPDATE credential_refresh_intents
         SET lease_holder = $2,
             lease_expires_at = now() + make_interval(secs => $3::double precision / 1000.0),
             lease_fencing_token = lease_fencing_token + 1, updated_at = now()
         WHERE operation_id = $1
           AND status <> ALL($4::text[])
           AND (lease_holder IS NULL OR lease_expires_at <= now())
         RETURNING ${COLUMNS}, lease_fencing_token`,
        [input.operationId, input.holder, input.leaseDurationMs, TERMINAL_STATUSES],
      );
      const won = claimed.rows[0];
      if (won !== undefined) {
        return { acquired: true, row: won, fencingToken: BigInt(won.lease_fencing_token) };
      }
      const row = await this.findById(q, input.operationId);
      if (row === null) {
        throw new Error(`refresh intent disappeared during lease claim: ${input.operationId}`);
      }
      return { acquired: false, row, fencingToken: null };
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Extend a still-held lease against the database clock, fenced by (lease_holder,
   * lease_fencing_token). Returns true while THIS executor still holds the lease,
   * the operation is non-terminal AND the lease has not yet expired against the
   * database clock; false once taken over, terminal or expired. An EXPIRED lease
   * is never resurrected: a heartbeat that fires past the deadline loses, so a
   * peer's authoritative takeover can never be silently undone (AUDIT-05 HIGH-11).
   */
  public async renewLease(
    q: Queryable,
    operationId: string,
    lease: { holder: string; fencingToken: bigint },
    leaseDurationMs: number,
  ): Promise<boolean> {
    try {
      const result = await q.query(
        `UPDATE credential_refresh_intents
         SET lease_expires_at = now() + make_interval(secs => $4::double precision / 1000.0),
             updated_at = now()
         WHERE operation_id = $1 AND lease_holder = $2 AND lease_fencing_token = $3
           AND lease_expires_at > now()
           AND status <> ALL($5::text[])`,
        [
          operationId,
          lease.holder,
          lease.fencingToken.toString(),
          leaseDurationMs,
          TERMINAL_STATUSES,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /** Free a still-held lease. Fenced: a no-op once taken over or terminal. */
  public async releaseLease(
    q: Queryable,
    operationId: string,
    lease: { holder: string; fencingToken: bigint },
  ): Promise<void> {
    await q.query(
      `UPDATE credential_refresh_intents
       SET lease_holder = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE operation_id = $1 AND lease_holder = $2 AND lease_fencing_token = $3
         AND status <> ALL($4::text[])`,
      [operationId, lease.holder, lease.fencingToken.toString(), TERMINAL_STATUSES],
    );
  }

  /**
   * Advance the durable status while holding the lease. Every write is fenced by
   * (lease_holder, lease_fencing_token): a stale/taken-over executor affects zero
   * rows (returns false) and MUST NOT proceed. A terminal transition also frees
   * the lease so an observer can read the recorded outcome.
   */
  public async setStatus(
    q: Queryable,
    operationId: string,
    status: RefreshIntentStatus,
    lease: { holder: string; fencingToken: bigint },
  ): Promise<boolean> {
    const clearLease = (TERMINAL_STATUSES as readonly string[]).includes(status);
    try {
      const result = await q.query(
        `UPDATE credential_refresh_intents
         SET status = $2,
             lease_holder = CASE WHEN $5 THEN NULL ELSE lease_holder END,
             lease_expires_at = CASE WHEN $5 THEN NULL ELSE lease_expires_at END,
             updated_at = now()
         WHERE operation_id = $1 AND lease_holder = $3 AND lease_fencing_token = $4`,
        [operationId, status, lease.holder, lease.fencingToken.toString(), clearLease],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findById(q: Queryable, operationId: string): Promise<RefreshIntentRow | null> {
    const result = await q.query<RefreshIntentRow>(
      `SELECT ${COLUMNS} FROM credential_refresh_intents WHERE operation_id = $1`,
      [operationId],
    );
    return result.rows[0] ?? null;
  }
}

/**
 * Fail closed when a stored intent's immutable identity does not match a request
 * that reused its `operation_id`. version_id / credential_secret_ref are the
 * values a retry deliberately re-addresses, so they are NOT compared here.
 */
function assertRowIdentity(row: RefreshIntentRow, input: BeginRefreshIntent): void {
  if (row.connection_id !== input.connectionId) {
    throw new CredentialRefreshIdentityError("connection", input.operationId);
  }
  if (row.owner_id !== input.ownerId) {
    throw new CredentialRefreshIdentityError("owner", input.operationId);
  }
  if (row.provider !== input.provider) {
    throw new CredentialRefreshIdentityError("provider", input.operationId);
  }
  if (BigInt(row.expected_revision) !== input.expectedRevision) {
    throw new CredentialRefreshIdentityError("expected revision", input.operationId);
  }
}
