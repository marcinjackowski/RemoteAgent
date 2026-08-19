-- RA-006 migration 020 (up): Discord case interface persistence.
--
-- The Discord interface maps events and conversations onto durable cases
-- (Master Plan §3.4, §4). Two tables provide the two invariants RA-006 needs and
-- that the model can never influence:
--
--   1. discord_case_bindings — the AUTHORITATIVE, one-row-per-case mapping to a
--      Discord channel, thread, anchor (root) message and pinned status message,
--      plus a per-case monotonic delivery sequence (`next_seq`). Locking this one
--      row serializes a single case's outbound deliveries (ordering — RA-006
--      acceptance criterion 4) while different cases lock different rows and thus
--      proceed in parallel (criterion 3).
--
--   2. discord_dispatch_receipts — an append-only idempotency ledger keyed by a
--      caller-supplied dedupe key (the originating outbox_id, optionally suffixed
--      for chunked sends). The receipt is the consumer-side dedupe the RA-004
--      outbox relies on: because the outbox delivers at-least-once, the SAME
--      outbox event may be handed to the dispatcher twice; the first delivery
--      writes a receipt and every later duplicate is a no-op, so one outbox event
--      never creates two messages or two threads (criterion 1).
--
-- Additive over migrations 003 (cases) and 009 (audit_log); never edits an
-- applied migration (ADR-0002).

CREATE TABLE discord_case_bindings (
  case_id           text        PRIMARY KEY,
  owner_id          text        NOT NULL,
  -- The parent channel the case's thread lives under (from the owner's channel
  -- configuration; assigned outside the model).
  channel_id        text        NOT NULL,
  -- Thread / anchor message / pinned status message ids are filled in as the
  -- corresponding Discord objects are created; NULL means "not yet created".
  thread_id         text,
  root_message_id   text,
  status_message_id text,
  -- Per-case delivery ordering. `next_seq` is the next sequence a PRODUCER
  -- reserves when it enqueues an ordered send (reserved under this row's lock so
  -- two producers never collide). `delivered_seq` is the highest contiguous
  -- sequence the DISPATCHER has actually delivered to Discord. The dispatcher
  -- delivers a message only when its reserved seq is exactly delivered_seq + 1,
  -- so a case's messages reach the thread in producer order — and a redelivery or
  -- an out-of-order claim after a retry/reconnect waits instead of reordering.
  next_seq          bigint      NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  delivered_seq     bigint      NOT NULL DEFAULT 0 CHECK (delivered_seq >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Bind to the case's owner so a case's Discord mapping can never be attributed
  -- to another owner by a plain write (mirrors external_entities in migration 003).
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE CASCADE
);

-- A Discord thread belongs to at most one case (fail-closed against a thread being
-- mapped to two cases). Partial: NULL thread_id (not yet created) is exempt.
CREATE UNIQUE INDEX discord_case_bindings_thread_idx
  ON discord_case_bindings (thread_id) WHERE thread_id IS NOT NULL;

CREATE INDEX discord_case_bindings_owner_idx ON discord_case_bindings (owner_id);

CREATE TRIGGER discord_case_bindings_touch_updated_at
  BEFORE UPDATE ON discord_case_bindings
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

CREATE TABLE discord_dispatch_receipts (
  dedupe_key         text        PRIMARY KEY,
  case_id            text        NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE,
  kind               text        NOT NULL CHECK (kind IN (
                        'ROOT_THREAD', 'THREAD_MESSAGE', 'STATUS_UPSERT')),
  -- The ordered slot this delivery occupies within the case. Ordered sends
  -- (ROOT_THREAD, THREAD_MESSAGE) always carry a seq; STATUS_UPSERT is an
  -- idempotent edit of the single pinned message and does not consume a slot.
  seq                bigint,
  discord_message_id text,
  discord_thread_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'STATUS_UPSERT') = (seq IS NULL)),
  CHECK (seq IS NULL OR seq >= 1)
);

-- Exactly one delivery per ordered (case, seq) slot: a reserved sequence can
-- never be occupied by two different dedupe keys, so ordering has no duplicates.
CREATE UNIQUE INDEX discord_dispatch_receipts_case_seq_idx
  ON discord_dispatch_receipts (case_id, seq) WHERE seq IS NOT NULL;

CREATE INDEX discord_dispatch_receipts_case_idx
  ON discord_dispatch_receipts (case_id, created_at);

-- Receipts are an immutable ledger: once written, a delivery record is never
-- mutated or removed through application code.
CREATE TRIGGER discord_dispatch_receipts_append_only
  BEFORE UPDATE OR DELETE ON discord_dispatch_receipts
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
