-- RA-004 migration 012 (down): revert jobs lease/retry/DLQ evolution.
DROP TRIGGER IF EXISTS jobs_fencing_guard ON jobs;
DROP FUNCTION IF EXISTS ra_jobs_fencing_guard();

DROP INDEX IF EXISTS jobs_reconciling_idx;
DROP INDEX IF EXISTS jobs_serialization_idx;
DROP INDEX IF EXISTS jobs_status_provider_idx;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_id_case_key;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_serialization_key_check;
DROP INDEX IF EXISTS jobs_active_serialization_uidx;

ALTER TABLE jobs
  DROP COLUMN IF EXISTS finished_at,
  DROP COLUMN IF EXISTS dlq_reason,
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS last_heartbeat_at,
  DROP COLUMN IF EXISTS leased_at,
  DROP COLUMN IF EXISTS serialization_key,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS backoff_cap_ms,
  DROP COLUMN IF EXISTS backoff_base_ms,
  DROP COLUMN IF EXISTS max_attempts;

-- Restore the original migration-006 status CHECK (no RECONCILING).
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER'));
