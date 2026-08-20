CREATE TABLE jira_webhook_registrations (
  registration_id text PRIMARY KEY,
  owner_id text NOT NULL,
  connection_id text NOT NULL,
  provider text NOT NULL DEFAULT 'jira' CHECK (provider = 'jira'),
  external_registration_id text,
  callback_url text NOT NULL CHECK (length(btrim(callback_url)) BETWEEN 1 AND 2048),
  config_digest text NOT NULL CHECK (config_digest ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ABSENT','REGISTERING','ACTIVE','RENEWAL_DUE','RENEWING','RECONCILING','EXPIRED','FAILED')),
  generation integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  expires_at timestamptz,
  renew_after timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 128),
  terminal_alert_generation integer CHECK (terminal_alert_generation IS NULL OR terminal_alert_generation >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, connection_id, provider),
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections(connection_id, owner_id) ON DELETE RESTRICT,
  CHECK (renew_after IS NULL OR expires_at IS NULL OR renew_after < expires_at),
  CHECK (external_registration_id IS NOT NULL OR status IN ('ABSENT','REGISTERING','RECONCILING','EXPIRED','FAILED'))
);
CREATE INDEX jira_webhook_registrations_due_idx ON jira_webhook_registrations (renew_after) WHERE status IN ('ACTIVE','RENEWAL_DUE');
CREATE TRIGGER jira_webhook_registrations_touch_updated_at BEFORE UPDATE ON jira_webhook_registrations FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
