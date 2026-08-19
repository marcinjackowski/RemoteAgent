DROP TRIGGER IF EXISTS kill_switch_events_append_only ON kill_switch_events;
DROP TABLE IF EXISTS kill_switch_events;
DROP TABLE IF EXISTS connection_scopes;

ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_refresh_window_check,
  DROP CONSTRAINT IF EXISTS connections_oauth_revocation_check,
  DROP CONSTRAINT IF EXISTS connections_secret_ref_nonempty_check,
  DROP CONSTRAINT IF EXISTS connections_capabilities_bound_check,
  DROP COLUMN IF EXISTS last_health_check_at,
  DROP COLUMN IF EXISTS oauth_revoked_at,
  DROP COLUMN IF EXISTS oauth_refresh_after,
  DROP COLUMN IF EXISTS oauth_expires_at,
  DROP COLUMN IF EXISTS health_status,
  DROP COLUMN IF EXISTS credential_revision,
  DROP COLUMN IF EXISTS credential_secret_ref,
  DROP COLUMN IF EXISTS capabilities,
  DROP COLUMN IF EXISTS alias;
