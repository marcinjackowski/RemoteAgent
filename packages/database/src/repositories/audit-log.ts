/**
 * Audit log repository (RA-003).
 *
 * The audit log is strictly append-only: this repository exposes only `record`
 * (insert) and read methods. There is deliberately NO public update or delete
 * API (RA-003 acceptance criterion 5), and the underlying table additionally
 * denies UPDATE/DELETE via a database trigger, so the invariant holds even if a
 * future caller tries to bypass this class.
 */
import type { Queryable } from "../client.js";
import { translatePgError } from "../client.js";

export type AuditOutcome = "SUCCESS" | "FAILURE" | "AMBIGUOUS";

export interface NewAuditEntry {
  actor: string;
  action: string;
  outcome: AuditOutcome;
  ownerId?: string;
  caseId?: string;
  targetKind?: string;
  targetId?: string;
  traceId?: string;
  /** Structured detail; callers must redact secrets/raw payloads first. */
  detail?: Record<string, unknown>;
}

export interface AuditRow {
  audit_id: string;
  occurred_at: Date;
  owner_id: string | null;
  case_id: string | null;
  actor: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  trace_id: string | null;
  detail: Record<string, unknown>;
}

export class AuditLogRepository {
  public async record(q: Queryable, entry: NewAuditEntry): Promise<AuditRow> {
    try {
      const result = await q.query<AuditRow>(
        `INSERT INTO audit_log (
           owner_id, case_id, actor, action, target_kind, target_id, outcome, trace_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING audit_id, occurred_at, owner_id, case_id, actor, action,
                   target_kind, target_id, outcome, trace_id, detail`,
        [
          entry.ownerId ?? null,
          entry.caseId ?? null,
          entry.actor,
          entry.action,
          entry.targetKind ?? null,
          entry.targetId ?? null,
          entry.outcome,
          entry.traceId ?? null,
          JSON.stringify(entry.detail ?? {}),
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async listByCase(q: Queryable, caseId: string): Promise<AuditRow[]> {
    const result = await q.query<AuditRow>(
      `SELECT audit_id, occurred_at, owner_id, case_id, actor, action,
              target_kind, target_id, outcome, trace_id, detail
       FROM audit_log WHERE case_id = $1 ORDER BY occurred_at ASC, audit_id ASC`,
      [caseId],
    );
    return result.rows;
  }
}
