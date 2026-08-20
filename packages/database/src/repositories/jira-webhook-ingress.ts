import type { Transaction } from "../client.js";

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
