/**
 * Case and external-entity repositories (RA-003).
 *
 * A case belongs to one owner. External entities are bound to (case, owner),
 * (connection, owner, provider) and — crucially — to the case's connection
 * allowlist (`case_connections`) by composite foreign keys, so an entity can only
 * use a connection that is actually part of the case's integration scope. Cross
 * scope fails closed at the database level and surfaces as
 * {@link IntegrityViolationError}.
 *
 * `integration_scope` is UNTRUSTED_DATA at the write boundary: the repository
 * parses it with the runtime contract schema (`integrationScope`) before issuing
 * the INSERT, so a malformed scope is rejected deterministically in the write
 * path (not only by the DB trigger) and never relies on the TypeScript type.
 */
import { caseStatusSchema, integrationScope } from "@remoteagent/contracts";
import type { CaseStatus, IntegrationScope, Provider } from "@remoteagent/contracts";

import type { Queryable } from "../client.js";
import { translatePgError } from "../client.js";
import { ContractViolationError } from "../errors.js";

export interface NewCase {
  caseId: string;
  ownerId: string;
  status: CaseStatus;
  integrationScope: IntegrationScope;
  discordThreadId: string;
}

export interface CaseRow {
  case_id: string;
  owner_id: string;
  status: CaseStatus;
  integration_scope: IntegrationScope;
  discord_thread_id: string;
  active_run_id: string | null;
  checkpoint_revision: number;
  created_at: Date;
  updated_at: Date;
}

export interface NewExternalEntity {
  entityId: string;
  caseId: string;
  ownerId: string;
  connectionId: string;
  provider: Provider;
  kind: string;
  externalId: string;
  url?: string;
}

export interface ExternalEntityRow {
  entity_id: string;
  case_id: string;
  owner_id: string;
  connection_id: string;
  provider: Provider;
  kind: string;
  external_id: string;
  url: string | null;
  created_at: Date;
  updated_at: Date;
}

export class CaseRepository {
  public async insert(q: Queryable, input: NewCase): Promise<CaseRow> {
    // Enforce the runtime contract in the write path: integration_scope and
    // status are validated against the versioned schema, not merely the TS type.
    // External/model-derived data cannot rely on compile-time types (AGENTS.md §7).
    const parsedScope = integrationScope.safeParse(input.integrationScope);
    if (!parsedScope.success) {
      throw new ContractViolationError(
        `invalid integration_scope for case ${input.caseId}: ${parsedScope.error.message}`,
      );
    }
    const parsedStatus = caseStatusSchema.safeParse(input.status);
    if (!parsedStatus.success) {
      throw new ContractViolationError(
        `invalid case status for case ${input.caseId}: ${parsedStatus.error.message}`,
      );
    }
    try {
      const result = await q.query<CaseRow>(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         RETURNING case_id, owner_id, status, integration_scope, discord_thread_id,
                   active_run_id, checkpoint_revision, created_at, updated_at`,
        [
          input.caseId,
          input.ownerId,
          parsedStatus.data,
          JSON.stringify(parsedScope.data),
          input.discordThreadId,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findById(q: Queryable, caseId: string): Promise<CaseRow | null> {
    const result = await q.query<CaseRow>(
      `SELECT case_id, owner_id, status, integration_scope, discord_thread_id,
              active_run_id, checkpoint_revision, created_at, updated_at
       FROM cases WHERE case_id = $1`,
      [caseId],
    );
    return result.rows[0] ?? null;
  }

  public async updateStatus(q: Queryable, caseId: string, status: CaseStatus): Promise<void> {
    await q.query(`UPDATE cases SET status = $2 WHERE case_id = $1`, [caseId, status]);
  }
}

export class ExternalEntityRepository {
  public async insert(q: Queryable, input: NewExternalEntity): Promise<ExternalEntityRow> {
    try {
      const result = await q.query<ExternalEntityRow>(
        `INSERT INTO external_entities (
           entity_id, case_id, owner_id, connection_id, provider, kind, external_id, url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING entity_id, case_id, owner_id, connection_id, provider, kind,
                   external_id, url, created_at, updated_at`,
        [
          input.entityId,
          input.caseId,
          input.ownerId,
          input.connectionId,
          input.provider,
          input.kind,
          input.externalId,
          input.url ?? null,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async listByCase(q: Queryable, caseId: string): Promise<ExternalEntityRow[]> {
    const result = await q.query<ExternalEntityRow>(
      `SELECT entity_id, case_id, owner_id, connection_id, provider, kind,
              external_id, url, created_at, updated_at
       FROM external_entities WHERE case_id = $1 ORDER BY created_at ASC`,
      [caseId],
    );
    return result.rows;
  }
}
