-- RA-004 migration 014 (up): evolve the RA-003 `outbox_dispatch` table into a
-- durable, lease-protected relay with bounded retry and a DLQ, mirroring the job
-- retry semantics. Additive over migration 006 (ADR-0002).
--
-- Design (Master Plan §3.2):
--   * Outbox rows are inserted in the SAME transaction as the business change
--     (transactional outbox). outbox_dispatch tracks publication state.
--   * A relay CLAIMS a batch of PENDING dispatch rows with a lease
--     (SELECT ... FOR UPDATE SKIP LOCKED), publishes them, then marks them
--     PUBLISHED. Because the ledger row (outbox) is immutable and the dispatch row
--     is claimed under a row lock, a message is published at-least-once; the
--     consumer dedupes on outbox_id for exactly-once effect.
--   * On publish failure, bounded exponential backoff reschedules the dispatch;
--     after max_attempts it is dead-lettered (observable) — never lost.

-- Extend the dispatch status domain with DEAD_LETTER.
ALTER TABLE outbox_dispatch DROP CONSTRAINT outbox_dispatch_status_check;
ALTER TABLE outbox_dispatch
  ADD CONSTRAINT outbox_dispatch_status_check CHECK (status IN (
    'PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'));

ALTER TABLE outbox_dispatch
  ADD COLUMN available_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_owner       text,
  ADD COLUMN lease_expires_at  timestamptz,
  -- Monotonic dispatch fencing token. A relay CLAIM bumps it; every finalize
  -- (publish / retry / dead-letter) is conditioned on the claiming relay still
  -- holding this exact token AND a live lease, so a stale relay that lost its
  -- lease can NEVER overwrite the current owner's result or roll a PUBLISHED row
  -- back to PENDING (audit HIGH-03). Mirrors the jobs.fencing_token invariant.
  ADD COLUMN dispatch_token    bigint      NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts      integer     NOT NULL DEFAULT 10 CHECK (max_attempts >= 1),
  ADD COLUMN backoff_base_ms   bigint      NOT NULL DEFAULT 1000 CHECK (backoff_base_ms >= 0),
  ADD COLUMN backoff_cap_ms    bigint      NOT NULL DEFAULT 3600000 CHECK (backoff_cap_ms >= 0),
  ADD COLUMN last_error        text,
  ADD COLUMN dead_lettered_at  timestamptz;

-- Hot path: claim the next runnable dispatch row.
CREATE INDEX outbox_dispatch_claimable_idx
  ON outbox_dispatch (available_at) WHERE status = 'PENDING';
CREATE INDEX outbox_dispatch_lease_idx
  ON outbox_dispatch (lease_expires_at) WHERE status = 'PENDING' AND lease_owner IS NOT NULL;

-- Guard: the dispatch fencing token is monotonic (never decreases), so a stale
-- relay cannot reassert an old lease by a direct write (mirrors the jobs guard).
CREATE OR REPLACE FUNCTION ra_outbox_dispatch_fencing_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.dispatch_token < OLD.dispatch_token THEN
    RAISE EXCEPTION
      'outbox dispatch % token cannot decrease (% -> %)',
      OLD.outbox_id, OLD.dispatch_token, NEW.dispatch_token
      USING ERRCODE = 'P0111';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_dispatch_fencing_guard
  BEFORE UPDATE ON outbox_dispatch
  FOR EACH ROW EXECUTE FUNCTION ra_outbox_dispatch_fencing_guard();
