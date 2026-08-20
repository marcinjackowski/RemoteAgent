import type { Transaction, Queryable } from "../client.js";
import { translatePgError } from "../client.js";
import * as z from "zod";
const idSchema = z.string().min(1).max(512);
const receiptSchema = z.strictObject({
  eventId: idSchema,
  ownerId: idSchema,
  connectionId: idSchema,
  issueKey: z.string().min(1).max(128),
  caseId: idSchema,
  entityId: idSchema,
  outboxId: idSchema,
  canonicalDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export interface JiraScopedEntityRow {
  entity_id: string;
  case_id: string;
  owner_id: string;
  connection_id: string;
  provider: "jira";
  kind: "jira_issue";
  external_id: string;
}
export interface JiraProjectionReceipt {
  eventId: string;
  ownerId: string;
  connectionId: string;
  issueKey: string;
  caseId: string;
  entityId: string;
  outboxId: string;
  canonicalDigest: string;
}
export class JiraCorrelationConflictError extends Error {
  constructor() {
    super("jira projection receipt conflict");
    this.name = "JiraCorrelationConflictError";
  }
}
export class JiraCorrelationRepository {
  public async findScoped(
    q: Queryable,
    ownerId: string,
    connectionId: string,
    issueKey: string,
  ): Promise<JiraScopedEntityRow | null> {
    const valid = z
      .strictObject({
        ownerId: idSchema,
        connectionId: idSchema,
        issueKey: z.string().min(1).max(128),
      })
      .safeParse({ ownerId, connectionId, issueKey });
    if (!valid.success) throw new JiraCorrelationConflictError();
    return (
      (
        await q.query<JiraScopedEntityRow>(
          "SELECT entity_id, case_id, owner_id, connection_id, provider, kind, external_id FROM external_entities WHERE owner_id=$1 AND connection_id=$2 AND provider='jira' AND kind='jira_issue' AND external_id=$3",
          [ownerId, connectionId, issueKey],
        )
      ).rows[0] ?? null
    );
  }
  public async record(
    tx: Transaction,
    input: JiraProjectionReceipt,
  ): Promise<{ inserted: boolean; receipt: JiraProjectionReceipt }> {
    const valid = receiptSchema.safeParse(input);
    if (!valid.success) throw new JiraCorrelationConflictError();
    try {
      const inserted = await tx.query(
        "INSERT INTO jira_projection_receipts(event_id,owner_id,connection_id,issue_key,case_id,entity_id,outbox_id,canonical_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
        [
          valid.data.eventId,
          valid.data.ownerId,
          valid.data.connectionId,
          valid.data.issueKey,
          valid.data.caseId,
          valid.data.entityId,
          valid.data.outboxId,
          valid.data.canonicalDigest,
        ],
      );
      const row = await tx.query<JiraProjectionReceipt>(
        'SELECT event_id AS "eventId", owner_id AS "ownerId", connection_id AS "connectionId", issue_key AS "issueKey", case_id AS "caseId", entity_id AS "entityId", outbox_id AS "outboxId", canonical_digest AS "canonicalDigest" FROM jira_projection_receipts WHERE event_id=$1',
        [input.eventId],
      );
      const existing = row.rows[0];
      if (
        !existing ||
        [
          existing.eventId,
          existing.ownerId,
          existing.connectionId,
          existing.issueKey,
          existing.caseId,
          existing.entityId,
          existing.outboxId,
          existing.canonicalDigest,
        ].join("\0") !==
          [
            valid.data.eventId,
            valid.data.ownerId,
            valid.data.connectionId,
            valid.data.issueKey,
            valid.data.caseId,
            valid.data.entityId,
            valid.data.outboxId,
            valid.data.canonicalDigest,
          ].join("\0")
      )
        throw new JiraCorrelationConflictError();
      return { inserted: (inserted.rowCount ?? 0) > 0, receipt: existing };
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }
}
