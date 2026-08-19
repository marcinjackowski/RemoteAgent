-- RA-006 migration 021 (up): durable Discord send intents + monotonic status gate.
--
-- Migration 020 gave the interface an idempotency ledger keyed by the outbox id
-- (discord_dispatch_receipts), which dedupes a *whole* redelivered outbox event.
-- It does NOT, however, make an individual Discord side effect recoverable across
-- a crash or a lost response: the original dispatcher wrote the receipt only
-- AFTER the send, so a crash between a successful send and the local commit left
-- no evidence and a redelivery re-sent the message (AUDIT-01 HIGH-01). It also
-- had no way to keep a late status projection from rolling the pinned message
-- back to an older revision (AUDIT-01 MEDIUM-05).
--
-- This migration adds the two durable structures that close those gaps and are,
-- like everything in RA-006, established outside the model:
--
--   1. discord_send_intents — a per-side-effect intent ledger. Before EACH
--      Discord write (root anchor, thread start, every continuation chunk, each
--      thread-message chunk, the status upsert) the dispatcher CLAIMS a STARTED
--      intent keyed by a deterministic idempotency key (`<outbox_id>:<step>`).
--      The claim is a single-winner INSERT ... ON CONFLICT DO NOTHING: exactly
--      one concurrent caller inserts the row and may perform the write; every
--      other caller observes the existing row and must NOT repeat it
--      (AUDIT-02 HIGH-08). After the write it marks the intent SUCCEEDED (with the
--      resulting Discord ids). This realises the run-safety state machine of
--      Master Plan §6.2 (PLANNED -> INTENT_RECORDED -> STARTED ->
--      SUCCEEDED | AMBIGUOUS | RETRYABLE):
--        - a STARTED intent found on a later attempt means the previous attempt
--          crashed with an UNKNOWN outcome. Reconcilable side effects (thread
--          creation/anchor/status, matched by the deterministic marker) are
--          reconciled to SUCCEEDED (or re-performed under the per-case lock when
--          the object provably does not exist); a non-reconcilable one becomes
--          AMBIGUOUS and its automatic replay is halted (RA-006 criterion 1);
--        - a SUCCEEDED intent short-circuits the side effect (idempotent no-op);
--        - a RETRYABLE intent (a provably-not-delivered failure) is re-owned and
--          re-issued, preserving the attempt count / last error for diagnosis.
--
--   2. discord_case_bindings.last_status_revision — the highest checkpoint
--      revision whose status projection has been applied to the pinned message.
--      The dispatcher applies a status upsert only when its revision is strictly
--      greater; an older-or-equal projection is a deterministic no-op, so a late
--      or reordered status can never roll the pinned message backwards
--      (AUDIT-01 MEDIUM-05, RA-006 acceptance criterion 4).
--
-- Additive over migration 020; never edits an applied migration (ADR-0002).

CREATE TABLE discord_send_intents (
  -- Deterministic idempotency key: `<outbox_id>:<step>`. The step distinguishes
  -- the multiple side effects a single outbox event fans out to (e.g. the root
  -- anchor and its continuation chunks), so each is recovered independently.
  idempotency_key    text        PRIMARY KEY,
  case_id            text        NOT NULL REFERENCES cases (case_id) ON DELETE CASCADE,
  outbox_id          text        NOT NULL,
  -- Logical step within the outbox event (root_anchor, root_thread, root_chunk:N,
  -- chunk:N, status). Free-form but produced only by the dispatcher.
  step               text        NOT NULL,
  -- Run-safety state (Master Plan §6.2). STARTED is written BEFORE the side
  -- effect; SUCCEEDED after it; AMBIGUOUS when the outcome is unknown and cannot
  -- be reconciled (automatic replay halted); RETRYABLE when the attempt PROVABLY
  -- did NOT take effect (e.g. a 429 the server rejected) so a later pass may
  -- re-own and re-issue it. RETRYABLE is kept (not deleted) so the ledger retains
  -- the attempt count and last error for operator diagnosis (AUDIT-02 MEDIUM-12).
  status             text        NOT NULL CHECK (status IN (
                        'STARTED', 'SUCCEEDED', 'AMBIGUOUS', 'RETRYABLE')),
  -- Filled in once the side effect succeeds (SUCCEEDED) or is reconciled.
  discord_message_id text,
  discord_thread_id  text,
  -- Attempt evidence retained across retries (AUDIT-02 MEDIUM-12): how many times
  -- the guarded write has been attempted and the most recent (redacted) error.
  attempts           integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discord_send_intents_case_idx ON discord_send_intents (case_id, created_at);
CREATE INDEX discord_send_intents_outbox_idx ON discord_send_intents (outbox_id);

-- Unlike the receipt ledger, intents are operational run-state and DO transition
-- (STARTED -> SUCCEEDED | AMBIGUOUS), so they only get the updated_at touch, not
-- the append-only deny-mutation trigger.
CREATE TRIGGER discord_send_intents_touch_updated_at
  BEFORE UPDATE ON discord_send_intents
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- The highest checkpoint revision whose status projection is currently shown in
-- the pinned message. NULL means no status has been projected yet. A projection
-- is applied only when its revision is strictly greater than this value.
ALTER TABLE discord_case_bindings
  ADD COLUMN last_status_revision bigint;
