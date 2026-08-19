/**
 * Event repository (RA-003).
 *
 * Handles the append-only raw event log plus the normalized event table.
 * Deduplication is native: re-inserting the same provider event
 * (provider, connection_id, dedupe_key) is a no-op that returns the existing
 * row rather than raising, so a redelivered webhook never creates a duplicate
 * (RA-003 acceptance criterion 2).
 */
import type { Provider, Sensitivity } from "@remoteagent/contracts";

import type { Queryable } from "../client.js";
import { translatePgError } from "../client.js";

export interface NewRawEvent {
  rawEventId: string;
  provider: Provider;
  connectionId: string;
  ownerId: string;
  payloadRef: string;
  payloadDigest: string;
  payloadSizeBytes?: number;
  payloadBytes?: Buffer;
  sensitivity: Sensitivity;
  retainUntil?: Date;
}

export interface RawEventRow {
  raw_event_id: string;
  provider: Provider;
  connection_id: string;
  owner_id: string;
  payload_ref: string;
  payload_digest: string;
  payload_size_bytes: string | null;
  sensitivity: Sensitivity;
  received_at: Date;
  retain_until: Date | null;
}

export interface NewEvent {
  eventId: string;
  provider: Provider;
  connectionId: string;
  ownerId: string;
  externalEventId: string;
  eventType: string;
  dedupeKey: string;
  rawEventId?: string;
  entityProvider: Provider;
  entityKind: string;
  entityExternalId: string;
  correlationKeys?: readonly string[];
  actor?: Record<string, unknown>;
  traceId: string;
  sensitivity: Sensitivity;
  occurredAt: Date;
}

export interface EventRow {
  event_id: string;
  provider: Provider;
  connection_id: string;
  owner_id: string;
  external_event_id: string;
  event_type: string;
  dedupe_key: string;
  raw_event_id: string | null;
  entity_provider: Provider;
  entity_kind: string;
  entity_external_id: string;
  trace_id: string;
  sensitivity: Sensitivity;
  occurred_at: Date;
  received_at: Date;
}

export interface EventInsertResult {
  event: EventRow;
  /** False when a matching dedupe key already existed (no new row created). */
  inserted: boolean;
}

export class EventRepository {
  public async insertRaw(q: Queryable, event: NewRawEvent): Promise<RawEventRow> {
    try {
      const result = await q.query<RawEventRow>(
        `INSERT INTO raw_events (
           raw_event_id, provider, connection_id, owner_id, payload_ref,
           payload_digest, payload_size_bytes, payload_bytes, sensitivity, retain_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING raw_event_id, provider, connection_id, owner_id, payload_ref,
                   payload_digest, payload_size_bytes, sensitivity, received_at, retain_until`,
        [
          event.rawEventId,
          event.provider,
          event.connectionId,
          event.ownerId,
          event.payloadRef,
          event.payloadDigest,
          event.payloadSizeBytes ?? null,
          event.payloadBytes ?? null,
          event.sensitivity,
          event.retainUntil ?? null,
        ],
      );
      return result.rows[0]!;
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  /**
   * Insert a normalized event, deduplicating on
   * (provider, connection_id, dedupe_key). If a matching event already exists,
   * the existing row is returned and `inserted` is false — the redelivery is a
   * safe no-op.
   */
  public async insertEvent(q: Queryable, event: NewEvent): Promise<EventInsertResult> {
    try {
      const inserted = await q.query<EventRow>(
        `INSERT INTO events (
           event_id, provider, connection_id, owner_id, external_event_id,
           event_type, dedupe_key, raw_event_id, entity_provider, entity_kind,
           entity_external_id, correlation_keys, actor, trace_id, sensitivity, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16)
         ON CONFLICT ON CONSTRAINT events_dedupe_unique DO NOTHING
         RETURNING event_id, provider, connection_id, owner_id, external_event_id,
                   event_type, dedupe_key, raw_event_id, entity_provider, entity_kind,
                   entity_external_id, trace_id, sensitivity, occurred_at, received_at`,
        [
          event.eventId,
          event.provider,
          event.connectionId,
          event.ownerId,
          event.externalEventId,
          event.eventType,
          event.dedupeKey,
          event.rawEventId ?? null,
          event.entityProvider,
          event.entityKind,
          event.entityExternalId,
          JSON.stringify(event.correlationKeys ?? []),
          JSON.stringify(event.actor ?? {}),
          event.traceId,
          event.sensitivity,
          event.occurredAt,
        ],
      );
      if (inserted.rows.length > 0) {
        return { event: inserted.rows[0]!, inserted: true };
      }
      // Conflict: return the pre-existing row for the same dedupe key.
      const existing = await q.query<EventRow>(
        `SELECT event_id, provider, connection_id, owner_id, external_event_id,
                event_type, dedupe_key, raw_event_id, entity_provider, entity_kind,
                entity_external_id, trace_id, sensitivity, occurred_at, received_at
         FROM events
         WHERE provider = $1 AND connection_id = $2 AND dedupe_key = $3`,
        [event.provider, event.connectionId, event.dedupeKey],
      );
      return { event: existing.rows[0]!, inserted: false };
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findById(q: Queryable, eventId: string): Promise<EventRow | null> {
    const result = await q.query<EventRow>(
      `SELECT event_id, provider, connection_id, owner_id, external_event_id,
              event_type, dedupe_key, raw_event_id, entity_provider, entity_kind,
              entity_external_id, trace_id, sensitivity, occurred_at, received_at
       FROM events WHERE event_id = $1`,
      [eventId],
    );
    return result.rows[0] ?? null;
  }
}
