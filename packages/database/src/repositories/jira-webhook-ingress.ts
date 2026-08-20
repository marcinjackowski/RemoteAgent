import type { Queryable, Transaction } from "../client.js";
import * as z from "zod";

const lookupSchema = z.strictObject({
  ownerId: z.string().trim().min(1).max(512),
  connectionId: z.string().trim().min(1).max(512),
  rawEventId: z.string().trim().min(1).max(512),
});
export interface JiraRawPayloadMetadata {
  ownerId: string;
  connectionId: string;
  rawEventId: string;
  payloadRef: string;
  payloadDigest: string;
  payloadSizeBytes: number;
  receivedAt: string;
}

export interface JiraIngressWrite {
  rawEventId: string;
  outboxId: string;
  connectionId: string;
  ownerId: string;
  payloadRef: string;
  payloadDigest: string;
  payloadSizeBytes: number;
}

export class JiraWebhookIngressConflictError extends Error {
  public constructor(public readonly kind: "identity" | "outbox") {
    super(`jira webhook ${kind} conflict`);
    this.name = "JiraWebhookIngressConflictError";
  }
}

export interface JiraIngressResult {
  accepted: boolean;
  rawEventId: string;
  outboxId: string;
}

/** Atomic Jira raw-ledger + received notification write. */
export class JiraWebhookIngressRepository {
  public async findRawPayload(
    query: Queryable,
    input: { ownerId: string; connectionId: string; rawEventId: string },
  ): Promise<JiraRawPayloadMetadata | null> {
    const valid = lookupSchema.safeParse(input);
    if (!valid.success) throw new JiraWebhookIngressConflictError("identity");
    const result = await query.query<{
      owner_id: string;
      connection_id: string;
      raw_event_id: string;
      payload_ref: string;
      payload_digest: string;
      payload_size_bytes: string | null;
      received_at: Date | string;
    }>(
      "SELECT owner_id, connection_id, raw_event_id, payload_ref, payload_digest, payload_size_bytes, received_at FROM raw_events WHERE raw_event_id=$1 AND provider='jira' AND owner_id=$2 AND connection_id=$3",
      [valid.data.rawEventId, valid.data.ownerId, valid.data.connectionId],
    );
    const row = result.rows[0];
    if (!row || row.payload_size_bytes === null) return null;
    const receivedAt =
      row.received_at instanceof Date ? row.received_at : new Date(row.received_at);
    if (!Number.isFinite(receivedAt.getTime()))
      throw new JiraWebhookIngressConflictError("identity");
    const size = Number(row.payload_size_bytes);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new JiraWebhookIngressConflictError("identity");
    return {
      ownerId: row.owner_id,
      connectionId: row.connection_id,
      rawEventId: row.raw_event_id,
      payloadRef: row.payload_ref,
      payloadDigest: row.payload_digest,
      payloadSizeBytes: size,
      receivedAt: receivedAt.toISOString(),
    };
  }
  public async persist(tx: Transaction, input: JiraIngressWrite): Promise<JiraIngressResult> {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.rawEventId]);
    const raw = await tx.query<{ payload_digest: string }>(
      `INSERT INTO raw_events (raw_event_id, provider, connection_id, owner_id, payload_ref,
         payload_digest, payload_size_bytes, payload_bytes, sensitivity)
       VALUES ($1, 'jira', $2, $3, $4, $5, $6, NULL, 'restricted')
       ON CONFLICT (raw_event_id) DO NOTHING
       RETURNING payload_digest`,
      [
        input.rawEventId,
        input.connectionId,
        input.ownerId,
        input.payloadRef,
        input.payloadDigest,
        input.payloadSizeBytes,
      ],
    );
    if (raw.rows.length === 0) {
      const existing = await tx.query<{
        payload_digest: string;
        connection_id: string;
        owner_id: string;
        payload_ref: string;
        payload_size_bytes: string | null;
      }>(
        "SELECT payload_digest, connection_id, owner_id, payload_ref, payload_size_bytes FROM raw_events WHERE raw_event_id=$1",
        [input.rawEventId],
      );
      const row = existing.rows[0];
      if (
        !row ||
        row.payload_digest !== input.payloadDigest ||
        row.connection_id !== input.connectionId ||
        row.owner_id !== input.ownerId ||
        row.payload_ref !== input.payloadRef ||
        row.payload_size_bytes !== String(input.payloadSizeBytes)
      ) {
        throw new JiraWebhookIngressConflictError("identity");
      }
    }
    const outbox = await tx.query(
      `INSERT INTO outbox (outbox_id, aggregate, aggregate_id, event_type, payload)
       VALUES ($1, 'jira_webhook', $2, 'jira.webhook.received', $3::jsonb)
       ON CONFLICT (outbox_id) DO NOTHING`,
      [
        input.outboxId,
        input.rawEventId,
        JSON.stringify({
          rawEventId: input.rawEventId,
          connectionId: input.connectionId,
          ownerId: input.ownerId,
          payloadRef: input.payloadRef,
          payloadDigest: input.payloadDigest,
        }),
      ],
    );
    const expectedPayload = {
      rawEventId: input.rawEventId,
      connectionId: input.connectionId,
      ownerId: input.ownerId,
      payloadRef: input.payloadRef,
      payloadDigest: input.payloadDigest,
    };
    const outboxRow = await tx.query<{ matches: boolean }>(
      "SELECT payload = $2::jsonb AS matches FROM outbox WHERE outbox_id=$1",
      [input.outboxId, JSON.stringify(expectedPayload)],
    );
    if (!outboxRow.rows[0]?.matches) throw new JiraWebhookIngressConflictError("outbox");
    if ((outbox.rowCount ?? 0) > 0)
      await tx.query(
        "INSERT INTO outbox_dispatch (outbox_id) VALUES ($1) ON CONFLICT (outbox_id) DO NOTHING",
        [input.outboxId],
      );
    return { accepted: true, rawEventId: input.rawEventId, outboxId: input.outboxId };
  }
}
