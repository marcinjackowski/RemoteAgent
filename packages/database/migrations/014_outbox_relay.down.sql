-- RA-004 migration 014 (down): revert outbox_dispatch relay evolution.
DROP TRIGGER IF EXISTS outbox_dispatch_fencing_guard ON outbox_dispatch;
DROP FUNCTION IF EXISTS ra_outbox_dispatch_fencing_guard();
DROP INDEX IF EXISTS outbox_dispatch_lease_idx;
DROP INDEX IF EXISTS outbox_dispatch_claimable_idx;

ALTER TABLE outbox_dispatch
  DROP COLUMN IF EXISTS dead_lettered_at,
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS backoff_cap_ms,
  DROP COLUMN IF EXISTS backoff_base_ms,
  DROP COLUMN IF EXISTS max_attempts,
  DROP COLUMN IF EXISTS dispatch_token,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS lease_owner,
  DROP COLUMN IF EXISTS available_at;

ALTER TABLE outbox_dispatch DROP CONSTRAINT outbox_dispatch_status_check;
ALTER TABLE outbox_dispatch
  ADD CONSTRAINT outbox_dispatch_status_check CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED'));
