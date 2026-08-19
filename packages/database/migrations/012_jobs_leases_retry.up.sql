-- RA-004 migration 012 (up): evolve the RA-003 `jobs` table into a durable job
-- queue with leases (expiry + heartbeat + fencing), bounded retry policy, and a
-- Dead Letter Queue (DLQ). Additive over migration 006 (ADR-0002): every new
-- column is nullable or has a default, and no accepted RA-003 constraint is
-- weakened.
--
-- Design (Master Plan §3.2, §6.2):
--   * A worker CLAIMS a runnable job by taking a durable lease: it sets
--     lease_owner, lease_expires_at, bumps the monotonic fencing_token, and moves
--     the job to LEASED — all in one atomic UPDATE guarded by row locking
--     (SELECT ... FOR UPDATE SKIP LOCKED) so two workers never claim the same job.
--   * The fencing token is strictly monotonic per job. A worker that lost its
--     lease (expired, re-claimed by another worker) carries a STALE token; any
--     write it attempts is rejected because the job's current token is higher.
--     This is the fencing invariant behind acceptance criterion 3.
--   * Heartbeat extends lease_expires_at while the job is being worked, so a slow
--     but live worker is not reaped.
--   * On failure, retry uses bounded exponential backoff up to max_attempts, then
--     the job is moved to DEAD_LETTER (observable DLQ) — acceptance criterion 5.
--
-- The existing status CHECK already includes 'DEAD_LETTER'; we add 'RECONCILING'
-- for jobs whose side effect ended AMBIGUOUS and awaits reconciliation.

-- ---------------------------------------------------------------------------
-- 1. Extend the status domain with RECONCILING (AMBIGUOUS side-effect holding
--    state). Additive: the old set stays valid.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'RECONCILING'));

-- ---------------------------------------------------------------------------
-- 2. Retry policy + DLQ + serialization/concurrency bookkeeping columns.
-- ---------------------------------------------------------------------------
ALTER TABLE jobs
  -- Bounded retry: a job is dead-lettered once attempts would exceed max_attempts.
  ADD COLUMN max_attempts        integer     NOT NULL DEFAULT 10 CHECK (max_attempts >= 1),
  -- Backoff shape (deterministic, injectable in tests): delay = min(
  --   backoff_cap_ms, backoff_base_ms * 2^(attempts-1)).
  ADD COLUMN backoff_base_ms     bigint      NOT NULL DEFAULT 1000 CHECK (backoff_base_ms >= 0),
  ADD COLUMN backoff_cap_ms      bigint      NOT NULL DEFAULT 3600000 CHECK (backoff_cap_ms >= 0),
  -- Provider this job belongs to, for provider-level concurrency limiting.
  -- NULL = not provider-scoped (still counts toward the global limit only).
  ADD COLUMN provider            text        CHECK (provider IN (
                                    'jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  -- Serialization key: jobs sharing this key run one-at-a-time. For any job with
  -- a case_id this is FORCED to equal case_id (per-case serialization, acceptance
  -- criterion 4) — see the ra_jobs_serialization_key CHECK below, which makes a
  -- null/other key for a cased job impossible at the DB level, independent of the
  -- caller. A job WITHOUT a case may still opt into a custom serialization group
  -- or run unserialized (null).
  ADD COLUMN serialization_key   text,
  -- Heartbeat + DLQ observability.
  ADD COLUMN leased_at           timestamptz,
  ADD COLUMN last_heartbeat_at   timestamptz,
  ADD COLUMN last_error          text,
  ADD COLUMN dead_lettered_at    timestamptz,
  ADD COLUMN dlq_reason          text,
  ADD COLUMN finished_at         timestamptz;

-- Backfill serialization_key from case_id for existing rows so per-case
-- serialization holds for pre-existing jobs, then keep it in sync on write via
-- the repository (not a trigger: callers pass it explicitly).
UPDATE jobs SET serialization_key = case_id WHERE serialization_key IS NULL AND case_id IS NOT NULL;

-- Per-case serialization is not optional for the caller: whenever a job has a
-- case_id its serialization_key MUST equal that case_id. This closes the
-- audit-01 HIGH-05 gap where an explicit serializationKey=null (or a different
-- key) for a cased job let two jobs of one case run in parallel. Jobs without a
-- case may use any custom key or null.
ALTER TABLE jobs ADD CONSTRAINT jobs_serialization_key_check
  CHECK (case_id IS NULL OR serialization_key = case_id);

-- ---------------------------------------------------------------------------
-- 3. Fencing token must be strictly monotonic per job. A dedicated function keeps
--    the semantics explicit and testable. The token only ever increases; a claim
--    bumps it, and a stale worker's token is therefore always < current.
-- ---------------------------------------------------------------------------
-- fencing_token already exists (bigint NOT NULL DEFAULT 0) from migration 006.
-- Add a hot-path index for reaping expired leases and for concurrency counting.
CREATE INDEX jobs_status_provider_idx ON jobs (status, provider);
CREATE INDEX jobs_serialization_idx ON jobs (serialization_key) WHERE serialization_key IS NOT NULL;
CREATE INDEX jobs_reconciling_idx ON jobs (status) WHERE status = 'RECONCILING';

-- Per-case serialization is enforced at the DB level, not merely by the claim
-- query: at most ONE active (LEASED or RECONCILING) job may exist per non-null
-- serialization_key. This partial UNIQUE index makes "two active jobs for one
-- case" impossible even under a race between two claiming transactions (RA-004
-- acceptance criterion 4). PENDING/SUCCEEDED/FAILED/DEAD_LETTER rows are exempt,
-- so a case may still have many queued or finished jobs.
CREATE UNIQUE INDEX jobs_active_serialization_uidx
  ON jobs (serialization_key)
  WHERE serialization_key IS NOT NULL AND status IN ('LEASED', 'RECONCILING');

-- Composite UNIQUE (job_id, case_id) so the attempt/intent/completion/
-- reconciliation ledgers can bind (job_id, case_id) by a composite FK and can
-- never disagree with the job's own case (RA-003 owner/scope integrity pattern).
ALTER TABLE jobs ADD CONSTRAINT jobs_id_case_key UNIQUE (job_id, case_id);

-- ---------------------------------------------------------------------------
-- 4. Guard: SUCCEEDED / FAILED / DEAD_LETTER are terminal-ish; a claim must go
--    through PENDING. We enforce the monotonic fencing token at the DB level so a
--    stale worker can NEVER lower or reuse a token. A BEFORE UPDATE trigger
--    rejects any attempt to set fencing_token to a value <= the stored one on a
--    row that is being claimed (fencing_token change), and forbids decreasing it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ra_jobs_fencing_guard() RETURNS trigger AS $$
BEGIN
  -- Fencing token is monotonic: it may stay equal (ordinary heartbeat / status
  -- transition by the current lease holder) or increase (a new claim), but never
  -- decrease. A decrease would mean a stale worker tried to reassert an old lease.
  IF NEW.fencing_token < OLD.fencing_token THEN
    RAISE EXCEPTION
      'job % fencing token cannot decrease (% -> %)',
      OLD.job_id, OLD.fencing_token, NEW.fencing_token
      USING ERRCODE = 'P0110';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_fencing_guard
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION ra_jobs_fencing_guard();
