-- RA-003 migration 002 (up): append-only raw event log + normalized events.
--
-- Master Plan §3.2: each integration has a logically separated append-only raw
-- event log. The raw payload is stored separately from the normalized envelope
-- and referenced by payload_ref (§5.1). Deduplication is enforced natively by a
-- UNIQUE constraint on (provider, connection_id, dedupe_key).

-- Raw, append-only event log. Bytes are stored as bytea; encryption of secret
-- payloads is out of scope for RA-003 (belongs to RA-005), but retention is
-- modeled here via retain_until so a retention job can prune expired rows.
CREATE TABLE raw_events (
  raw_event_id      text        PRIMARY KEY,
  provider          text        NOT NULL CHECK (provider IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  connection_id     text        NOT NULL,
  owner_id          text        NOT NULL,
  -- Opaque storage locator + integrity digest for the raw payload.
  payload_ref       text        NOT NULL,
  payload_digest    text        NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  payload_size_bytes bigint     CHECK (payload_size_bytes IS NULL OR payload_size_bytes >= 0),
  -- Inline bytes are optional; large payloads live in external storage.
  payload_bytes     bytea,
  sensitivity       text        NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Retention deadline for the raw payload (Master Plan §11 separate retention).
  retain_until      timestamptz,
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT
);

CREATE INDEX raw_events_connection_idx ON raw_events (connection_id, received_at);
-- Hot path for the retention job: find expired payloads efficiently.
CREATE INDEX raw_events_retain_until_idx ON raw_events (retain_until) WHERE retain_until IS NOT NULL;

-- Append-only: raw events are an immutable ledger.
CREATE TRIGGER raw_events_append_only
  BEFORE UPDATE OR DELETE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- Normalized events (EventEnvelope projection, Master Plan §5.1). This is the
-- routable, deduplicated form. dedupe_key uniqueness per (provider, connection)
-- makes a redelivered provider event a no-op on re-insert (ON CONFLICT).
CREATE TABLE events (
  event_id          text        PRIMARY KEY,
  provider          text        NOT NULL CHECK (provider IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  connection_id     text        NOT NULL,
  owner_id          text        NOT NULL,
  external_event_id text        NOT NULL,
  event_type        text        NOT NULL,
  dedupe_key        text        NOT NULL,
  raw_event_id      text        REFERENCES raw_events (raw_event_id) ON DELETE RESTRICT,
  -- Entity this event references; provider must match (guarded by CHECK below).
  entity_provider   text        NOT NULL CHECK (entity_provider IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  entity_kind       text        NOT NULL,
  entity_external_id text       NOT NULL,
  correlation_keys  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  actor             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  trace_id          text        NOT NULL,
  sensitivity       text        NOT NULL CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  occurred_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- The referenced entity must belong to the same provider as the envelope
  -- (mirrors the contract's cross-field invariant, enforced natively).
  CONSTRAINT events_entity_provider_matches CHECK (entity_provider = provider),
  -- Native deduplication key.
  CONSTRAINT events_dedupe_unique UNIQUE (provider, connection_id, dedupe_key),
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT
);

CREATE INDEX events_connection_idx ON events (connection_id, occurred_at);
CREATE INDEX events_owner_idx ON events (owner_id);
CREATE INDEX events_entity_idx ON events (entity_provider, entity_external_id);

-- Normalized events are also an append-only ledger.
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
