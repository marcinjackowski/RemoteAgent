/**
 * Owner, connection, credential-metadata and kill-switch persistence.
 *
 * No method accepts or returns credential values. PostgreSQL stores only an
 * opaque vault reference; secret material remains behind CredentialVault.
 */
import {
  ConnectionAlias,
  ConnectionHealth,
  connectionAliasSchema,
  connectionHealthSchema,
  connectionScopeEntry,
} from "@remoteagent/contracts";
import type { ConnectionScopeEntry, ConnectionScopeKind, Provider } from "@remoteagent/contracts";

import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import { ContractViolationError } from "../errors.js";

export interface OwnerRow {
  owner_id: string;
  display_name: string;
  created_at: Date;
  updated_at: Date;
}

/** Persistence DTO: contains a vault pointer, never a token/secret value. */
export interface ConnectionRow {
  connection_id: string;
  owner_id: string;
  provider: Provider;
  alias: ConnectionAlias;
  display_name: string;
  capabilities: string[];
  credential_secret_ref: string;
  credential_revision: string;
  health_status: ConnectionHealth;
  oauth_expires_at: Date | null;
  oauth_refresh_after: Date | null;
  oauth_revoked_at: Date | null;
  last_health_check_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectionScopeRow {
  connection_id: string;
  owner_id: string;
  provider: Provider;
  scope_kind: ConnectionScopeKind;
  scope_value: string;
  created_at: Date;
}

export interface CaseConnectionScopeRow {
  case_id: string;
  connection_id: string;
  scope_kind: ConnectionScopeKind;
  scope_value: string;
  created_at: Date;
}

/**
 * The authoritative, server-side resolved scope of a single case: the connection
 * membership allowlist plus the per-case resource grants. It is shaped to feed
 * `resolveConnectionScope` in `@remoteagent/policy` without this package
 * depending on the policy layer (structural compatibility only).
 */
export interface CaseScopeSnapshot {
  caseId: string;
  ownerId: string;
  connectionIds: string[];
  resourceScopes: { connectionId: string; kind: ConnectionScopeKind; value: string }[];
}

export interface NewOwner {
  ownerId: string;
  displayName: string;
}

export interface NewConnection {
  connectionId: string;
  ownerId: string;
  provider: Provider;
  displayName: string;
  alias?: ConnectionAlias;
  capabilities?: readonly string[];
  /** Opaque locator only. Secret material must be written through a vault. */
  credentialSecretRef?: string;
  health?: ConnectionHealth;
  oauthExpiresAt?: Date;
  oauthRefreshAfter?: Date;
  oauthRevokedAt?: Date;
}

export interface RotateCredentialMetadata {
  connectionId: string;
  expectedRevision: bigint;
  credentialSecretRef: string;
  health: ConnectionHealth;
  oauthExpiresAt: Date | null;
  oauthRefreshAfter: Date | null;
  checkedAt: Date;
}

export const KillSwitchLevel = {
  GLOBAL: "GLOBAL",
  PROVIDER: "PROVIDER",
  CONNECTION: "CONNECTION",
} as const;

export type KillSwitchLevel = (typeof KillSwitchLevel)[keyof typeof KillSwitchLevel];

export interface KillSwitchEventRow {
  event_sequence: string;
  event_id: string;
  scope_level: KillSwitchLevel;
  owner_id: string | null;
  provider: Provider | null;
  connection_id: string | null;
  enabled: boolean;
  reason: string;
  changed_by: string;
  created_at: Date;
}

export type NewKillSwitchEvent =
  | {
      eventId: string;
      level: "GLOBAL";
      enabled: boolean;
      reason: string;
      changedBy: string;
    }
  | {
      eventId: string;
      level: "PROVIDER";
      provider: Provider;
      enabled: boolean;
      reason: string;
      changedBy: string;
    }
  | {
      eventId: string;
      level: "CONNECTION";
      ownerId: string;
      provider: Provider;
      connectionId: string;
      enabled: boolean;
      reason: string;
      changedBy: string;
    };

const CONNECTION_COLUMNS = `connection_id, owner_id, provider, alias, display_name,
  capabilities, credential_secret_ref, credential_revision, health_status,
  oauth_expires_at, oauth_refresh_after, oauth_revoked_at, last_health_check_at,
  created_at, updated_at`;

export class OwnerRepository {
  public async insert(q: Queryable, owner: NewOwner): Promise<OwnerRow> {
    try {
      const result = await q.query<OwnerRow>(
        `INSERT INTO owners (owner_id, display_name)
         VALUES ($1, $2)
         RETURNING owner_id, display_name, created_at, updated_at`,
        [owner.ownerId, owner.displayName],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findById(q: Queryable, ownerId: string): Promise<OwnerRow | null> {
    const result = await q.query<OwnerRow>(
      `SELECT owner_id, display_name, created_at, updated_at
       FROM owners WHERE owner_id = $1`,
      [ownerId],
    );
    return result.rows[0] ?? null;
  }
}

export class ConnectionRepository {
  public async insert(q: Queryable, connection: NewConnection): Promise<ConnectionRow> {
    const alias = connectionAliasSchema.parse(connection.alias ?? ConnectionAlias.PRIVATE);
    const health = connectionHealthSchema.parse(connection.health ?? ConnectionHealth.ERROR);
    const secretRef = connection.credentialSecretRef ?? `unconfigured://${connection.connectionId}`;
    try {
      const result = await q.query<ConnectionRow>(
        `INSERT INTO connections (
           connection_id, owner_id, provider, alias, display_name, capabilities,
           credential_secret_ref, health_status, oauth_expires_at,
           oauth_refresh_after, oauth_revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11)
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          connection.connectionId,
          connection.ownerId,
          connection.provider,
          alias,
          connection.displayName,
          [...(connection.capabilities ?? [])],
          secretRef,
          health,
          connection.oauthExpiresAt ?? null,
          connection.oauthRefreshAfter ?? null,
          connection.oauthRevokedAt ?? null,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findById(q: Queryable, connectionId: string): Promise<ConnectionRow | null> {
    const result = await q.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE connection_id = $1`,
      [connectionId],
    );
    return result.rows[0] ?? null;
  }

  public async listByOwner(q: Queryable, ownerId: string): Promise<ConnectionRow[]> {
    const result = await q.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS}
       FROM connections WHERE owner_id = $1 ORDER BY created_at ASC, connection_id ASC`,
      [ownerId],
    );
    return result.rows;
  }

  /** Resolve only connections already present in the authoritative case scope. */
  public async listForCase(
    q: Queryable,
    input: { caseId: string; ownerId: string; provider: Provider; alias?: ConnectionAlias },
  ): Promise<ConnectionRow[]> {
    const result = await q.query<ConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS.split(",")
        .map((c) => `c.${c.trim()}`)
        .join(", ")}
       FROM connections c
       INNER JOIN case_connections cc
         ON cc.connection_id = c.connection_id
        AND cc.owner_id = c.owner_id
        AND cc.provider = c.provider
       WHERE cc.case_id = $1 AND c.owner_id = $2 AND c.provider = $3
         AND ($4::text IS NULL OR c.alias = $4)
       ORDER BY c.connection_id ASC`,
      [input.caseId, input.ownerId, input.provider, input.alias ?? null],
    );
    return result.rows;
  }

  /**
   * Replace configured resource scopes atomically. Owner/provider are selected
   * from the connection row server-side and cannot be injected by the caller.
   */
  public async replaceScopes(
    tx: Transaction,
    connectionId: string,
    scopes: readonly ConnectionScopeEntry[],
  ): Promise<ConnectionScopeRow[]> {
    const parsed = scopes.map((scope) => connectionScopeEntry.safeParse(scope));
    const invalid = parsed.find((result) => !result.success);
    if (invalid !== undefined && !invalid.success) {
      throw new ContractViolationError(`invalid connection scope: ${invalid.error.message}`);
    }
    try {
      await tx.query("DELETE FROM connection_scopes WHERE connection_id = $1", [connectionId]);
      for (const result of parsed) {
        if (!result.success) continue;
        const inserted = await tx.query(
          `INSERT INTO connection_scopes (
             connection_id, owner_id, provider, scope_kind, scope_value)
           SELECT connection_id, owner_id, provider, $2, $3
           FROM connections WHERE connection_id = $1`,
          [connectionId, result.data.kind, result.data.value],
        );
        if (inserted.rowCount !== 1) {
          throw new ContractViolationError(`unknown connection: ${connectionId}`);
        }
      }
      return this.listScopes(tx, connectionId);
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async listScopes(q: Queryable, connectionId: string): Promise<ConnectionScopeRow[]> {
    const result = await q.query<ConnectionScopeRow>(
      `SELECT connection_id, owner_id, provider, scope_kind, scope_value, created_at
       FROM connection_scopes WHERE connection_id = $1
       ORDER BY scope_kind ASC, scope_value ASC`,
      [connectionId],
    );
    return result.rows;
  }

  /**
   * Replace the per-case resource grants for one (case, connection) atomically.
   * Each grant is validated by the composite foreign keys on
   * `case_connection_scopes`, so it can only ever be the intersection of the
   * case's connection membership and the connection's configured scopes. This is
   * an owner/server-side action; the model never reaches it.
   */
  public async replaceCaseScopes(
    tx: Transaction,
    input: { caseId: string; connectionId: string; scopes: readonly ConnectionScopeEntry[] },
  ): Promise<CaseConnectionScopeRow[]> {
    const parsed = input.scopes.map((scope) => connectionScopeEntry.safeParse(scope));
    const invalid = parsed.find((result) => !result.success);
    if (invalid !== undefined && !invalid.success) {
      throw new ContractViolationError(`invalid case connection scope: ${invalid.error.message}`);
    }
    try {
      await tx.query(
        "DELETE FROM case_connection_scopes WHERE case_id = $1 AND connection_id = $2",
        [input.caseId, input.connectionId],
      );
      for (const result of parsed) {
        if (!result.success) continue;
        await tx.query(
          `INSERT INTO case_connection_scopes (case_id, connection_id, scope_kind, scope_value)
           VALUES ($1, $2, $3, $4)`,
          [input.caseId, input.connectionId, result.data.kind, result.data.value],
        );
      }
      return this.listCaseScopes(tx, input.caseId);
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async listCaseScopes(q: Queryable, caseId: string): Promise<CaseConnectionScopeRow[]> {
    const result = await q.query<CaseConnectionScopeRow>(
      `SELECT case_id, connection_id, scope_kind, scope_value, created_at
       FROM case_connection_scopes WHERE case_id = $1
       ORDER BY connection_id ASC, scope_kind ASC, scope_value ASC`,
      [caseId],
    );
    return result.rows;
  }

  /**
   * Build the authoritative case scope for the resolver: connection membership
   * from `case_connections` and per-case resource grants from
   * `case_connection_scopes`. Both are maintained server-side; the returned
   * snapshot is the only scope the resolver is allowed to widen from.
   */
  public async loadCaseScope(q: Queryable, caseId: string): Promise<CaseScopeSnapshot | null> {
    const caseRow = await q.query<{ owner_id: string }>(
      "SELECT owner_id FROM cases WHERE case_id = $1",
      [caseId],
    );
    const ownerId = caseRow.rows[0]?.owner_id;
    if (ownerId === undefined) {
      return null;
    }
    const members = await q.query<{ connection_id: string }>(
      "SELECT connection_id FROM case_connections WHERE case_id = $1 ORDER BY connection_id ASC",
      [caseId],
    );
    const grants = await this.listCaseScopes(q, caseId);
    return {
      caseId,
      ownerId,
      connectionIds: members.rows.map((row) => row.connection_id),
      resourceScopes: grants.map((row) => ({
        connectionId: row.connection_id,
        kind: row.scope_kind,
        value: row.scope_value,
      })),
    };
  }

  /**
   * Optimistic credential-reference rotation. Concurrent refreshers cannot both
   * publish their immutable vault reference; callers clean up a losing ref.
   */
  public async rotateCredentialMetadata(
    q: Queryable,
    input: RotateCredentialMetadata,
  ): Promise<ConnectionRow | null> {
    const health = connectionHealthSchema.parse(input.health);
    if (health === ConnectionHealth.REVOKED) {
      throw new ContractViolationError("credential rotation cannot set REVOKED health");
    }
    try {
      const result = await q.query<ConnectionRow>(
        `UPDATE connections
         SET credential_secret_ref = $3,
             credential_revision = credential_revision + 1,
             health_status = $4,
             oauth_expires_at = $5,
             oauth_refresh_after = $6,
             oauth_revoked_at = NULL,
             last_health_check_at = $7
         WHERE connection_id = $1
           AND credential_revision = $2
           AND health_status <> 'REVOKED'
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          input.connectionId,
          input.expectedRevision.toString(),
          input.credentialSecretRef,
          health,
          input.oauthExpiresAt,
          input.oauthRefreshAfter,
          input.checkedAt,
        ],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async revoke(q: Queryable, connectionId: string, revokedAt: Date): Promise<boolean> {
    const result = await q.query(
      `UPDATE connections
       SET health_status = 'REVOKED', oauth_revoked_at = $2,
           last_health_check_at = $2
       WHERE connection_id = $1 AND health_status <> 'REVOKED'`,
      [connectionId, revokedAt],
    );
    return result.rowCount === 1;
  }
}

export class KillSwitchRepository {
  public async append(q: Queryable, input: NewKillSwitchEvent): Promise<KillSwitchEventRow> {
    const ownerId = input.level === KillSwitchLevel.CONNECTION ? input.ownerId : null;
    const provider = input.level === KillSwitchLevel.GLOBAL ? null : input.provider;
    const connectionId = input.level === KillSwitchLevel.CONNECTION ? input.connectionId : null;
    try {
      const result = await q.query<KillSwitchEventRow>(
        `INSERT INTO kill_switch_events (
           event_id, scope_level, owner_id, provider, connection_id,
           enabled, reason, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING event_sequence, event_id, scope_level, owner_id, provider,
                   connection_id, enabled, reason, changed_by, created_at`,
        [
          input.eventId,
          input.level,
          ownerId,
          provider,
          connectionId,
          input.enabled,
          input.reason,
          input.changedBy,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /** Latest event for each applicable global/provider/connection level. */
  public async listEffective(
    q: Queryable,
    input: { ownerId: string; provider: Provider; connectionId: string },
  ): Promise<KillSwitchEventRow[]> {
    const result = await q.query<KillSwitchEventRow>(
      `WITH applicable AS (
         SELECT *,
           row_number() OVER (PARTITION BY scope_level ORDER BY event_sequence DESC) AS rn
         FROM kill_switch_events
         WHERE scope_level = 'GLOBAL'
            OR (scope_level = 'PROVIDER' AND provider = $2)
            OR (scope_level = 'CONNECTION' AND owner_id = $1
                AND provider = $2 AND connection_id = $3)
       )
       SELECT event_sequence, event_id, scope_level, owner_id, provider,
              connection_id, enabled, reason, changed_by, created_at
       FROM applicable WHERE rn = 1 ORDER BY event_sequence ASC`,
      [input.ownerId, input.provider, input.connectionId],
    );
    return result.rows;
  }
}
