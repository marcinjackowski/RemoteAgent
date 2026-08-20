import type { Queryable, Transaction } from "../client.js";
import * as z from "zod";

const scopeSchema = z.strictObject({
  ownerId: z.string().trim().min(1).max(512),
  connectionId: z.string().trim().min(1).max(512),
  projectKey: z.string().trim().min(1).max(128),
});
const advanceSchema = scopeSchema.extend({
  watermarkMs: z.number().int().nonnegative(),
  lastIssueKey: z.string().max(128),
  expectedRevision: z.number().int().nonnegative(),
});
export interface JiraReconciliationWatermarkRow {
  owner_id: string;
  connection_id: string;
  project_key: string;
  watermark_ms: string;
  last_issue_key: string;
  revision: string;
  updated_at: Date;
}
export class JiraReconciliationConflictError extends Error {
  public constructor() {
    super("jira reconciliation watermark conflict");
    this.name = "JiraReconciliationConflictError";
  }
}
const issueVersionSchema = scopeSchema.extend({
  issueKey: z.string().trim().min(1).max(128),
  issueVersionMs: z.number().int().nonnegative(),
  snapshot: z.unknown(),
});
const columns =
  "owner_id, connection_id, project_key, watermark_ms, last_issue_key, revision, updated_at";
export class JiraReconciliationRepository {
  public async putSnapshotIfNewer(
    tx: Queryable,
    input: {
      ownerId: string;
      connectionId: string;
      projectKey: string;
      issueKey: string;
      issueVersionMs: number;
      snapshot: unknown;
    },
  ): Promise<{ disposition: "accepted" | "stale"; snapshot: unknown }> {
    const valid = issueVersionSchema.safeParse(input);
    if (!valid.success) throw new JiraReconciliationConflictError();
    const accepted = await tx.query<{ snapshot: unknown }>(
      "INSERT INTO jira_issue_snapshots(owner_id,connection_id,project_key,issue_key,issue_version_ms,snapshot) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(owner_id,connection_id,project_key,issue_key) DO UPDATE SET issue_version_ms=EXCLUDED.issue_version_ms, snapshot=EXCLUDED.snapshot WHERE jira_issue_snapshots.issue_version_ms < EXCLUDED.issue_version_ms RETURNING snapshot",
      [
        valid.data.ownerId,
        valid.data.connectionId,
        valid.data.projectKey,
        valid.data.issueKey,
        valid.data.issueVersionMs,
        JSON.stringify(input.snapshot),
      ],
    );
    if (accepted.rows[0]) return { disposition: "accepted", snapshot: accepted.rows[0].snapshot };
    const current = await tx.query<{ snapshot: unknown }>(
      "SELECT snapshot FROM jira_issue_snapshots WHERE owner_id=$1 AND connection_id=$2 AND project_key=$3 AND issue_key=$4",
      [valid.data.ownerId, valid.data.connectionId, valid.data.projectKey, valid.data.issueKey],
    );
    return { disposition: "stale", snapshot: current.rows[0]?.snapshot };
  }
  public async find(
    q: Queryable,
    ownerId: string,
    connectionId: string,
    projectKey: string,
    lock = false,
  ): Promise<JiraReconciliationWatermarkRow | null> {
    const valid = scopeSchema.safeParse({ ownerId, connectionId, projectKey });
    if (!valid.success) throw new JiraReconciliationConflictError();
    const result = await q.query<JiraReconciliationWatermarkRow>(
      `SELECT ${columns} FROM jira_reconciliation_watermarks WHERE owner_id=$1 AND connection_id=$2 AND project_key=$3${lock ? " FOR UPDATE" : ""}`,
      [valid.data.ownerId, valid.data.connectionId, valid.data.projectKey],
    );
    return result.rows[0] ?? null;
  }
  public async advance(
    tx: Transaction,
    input: {
      ownerId: string;
      connectionId: string;
      projectKey: string;
      watermarkMs: number;
      lastIssueKey: string;
      expectedRevision: number;
    },
  ): Promise<JiraReconciliationWatermarkRow> {
    const valid = advanceSchema.safeParse(input);
    if (!valid.success) throw new JiraReconciliationConflictError();
    const result = await tx.query<JiraReconciliationWatermarkRow>(
      `INSERT INTO jira_reconciliation_watermarks(owner_id,connection_id,project_key,watermark_ms,last_issue_key,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,connection_id,project_key) DO UPDATE SET watermark_ms=EXCLUDED.watermark_ms, last_issue_key=EXCLUDED.last_issue_key, revision=jira_reconciliation_watermarks.revision+1, updated_at=now() WHERE jira_reconciliation_watermarks.revision=$6 RETURNING ${columns}`,
      [
        valid.data.ownerId,
        valid.data.connectionId,
        valid.data.projectKey,
        valid.data.watermarkMs,
        valid.data.lastIssueKey,
        valid.data.expectedRevision,
      ],
    );
    if (!result.rows[0]) throw new JiraReconciliationConflictError();
    return result.rows[0];
  }
}
