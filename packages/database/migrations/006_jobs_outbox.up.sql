-- RA-003 migration 006 (up): durable jobs and transactional outbox tables.
--
-- The queue worker itself is out of scope for RA-003 (belongs to RA-004), but
-- the persistent tables are part of the durable model. The transactional outbox
-- links a committed DB change to later publication (Master Plan §3.2); workers
-- use durable leases with a timeout and fencing token.

CREATE TABLE jobs (
  job_id        text        PRIMARY KEY,
  case_id       text        REFERENCES cases (case_id) ON DELETE RESTRICT,
  job_type      text        NOT NULL,
  status        text        NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                  'PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER')),
  payload       jsonb       NOT NULL,
  -- Durable lease fields (populated by RA-004's worker).
  lease_owner   text,
  lease_expires_at timestamptz,
  fencing_token bigint      NOT NULL DEFAULT 0,
  attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Hot path: claim the next runnable job.
CREATE INDEX jobs_claimable_idx ON jobs (available_at) WHERE status = 'PENDING';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'LEASED';
CREATE INDEX jobs_case_idx ON jobs (case_id) WHERE case_id IS NOT NULL;

CREATE TRIGGER jobs_touch_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Transactional outbox: rows inserted in the same transaction as the business
-- change, then published exactly once by a relay. Append-only for the payload;
-- publication state is tracked in a separate mutable table so the ledger row is
-- immutable while allowing publish bookkeeping.
CREATE TABLE outbox (
  outbox_id     text        PRIMARY KEY,
  aggregate     text        NOT NULL,
  aggregate_id  text        NOT NULL,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_created_idx ON outbox (created_at);

CREATE TRIGGER outbox_append_only
  BEFORE UPDATE OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- Publication bookkeeping for outbox rows (mutable, one row per outbox row).
CREATE TABLE outbox_dispatch (
  outbox_id     text        PRIMARY KEY REFERENCES outbox (outbox_id) ON DELETE RESTRICT,
  status        text        NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
  attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  published_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_dispatch_pending_idx ON outbox_dispatch (outbox_id) WHERE status = 'PENDING';

CREATE TRIGGER outbox_dispatch_touch_updated_at
  BEFORE UPDATE ON outbox_dispatch
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
