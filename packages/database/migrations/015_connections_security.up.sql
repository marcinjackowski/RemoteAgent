-- RA-005: credential references, provider resource scopes and durable kill
-- switches. Secret values never enter PostgreSQL; connections store only an
-- opaque vault reference and lifecycle metadata.

ALTER TABLE connections
  ADD COLUMN alias text NOT NULL DEFAULT 'private'
    CHECK (alias IN ('private', 'sondermind')),
  ADD COLUMN capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN credential_secret_ref text,
  ADD COLUMN credential_revision bigint NOT NULL DEFAULT 0
    CHECK (credential_revision >= 0),
  ADD COLUMN health_status text NOT NULL DEFAULT 'ERROR'
    CHECK (health_status IN ('HEALTHY', 'EXPIRING', 'EXPIRED', 'REVOKED', 'ERROR')),
  ADD COLUMN oauth_expires_at timestamptz,
  ADD COLUMN oauth_refresh_after timestamptz,
  ADD COLUMN oauth_revoked_at timestamptz,
  ADD COLUMN last_health_check_at timestamptz;

-- Existing development rows predate a vault. Give each a non-secret,
-- deliberately unusable reference and ERROR health so access fails closed.
UPDATE connections
SET credential_secret_ref = 'unconfigured://' || connection_id;
ALTER TABLE connections ALTER COLUMN credential_secret_ref SET NOT NULL;

ALTER TABLE connections
  ADD CONSTRAINT connections_capabilities_bound_check
    CHECK (cardinality(capabilities) <= 64 AND array_position(capabilities, NULL) IS NULL),
  ADD CONSTRAINT connections_secret_ref_nonempty_check
    CHECK (length(btrim(credential_secret_ref)) > 0),
  ADD CONSTRAINT connections_oauth_revocation_check
    CHECK (
      (health_status = 'REVOKED' AND oauth_revoked_at IS NOT NULL)
      OR (health_status <> 'REVOKED' AND oauth_revoked_at IS NULL)
    ),
  ADD CONSTRAINT connections_refresh_window_check
    CHECK (
      oauth_refresh_after IS NULL OR oauth_expires_at IS NULL
      OR oauth_refresh_after < oauth_expires_at
    );

CREATE TABLE connection_scopes (
  connection_id text        NOT NULL,
  owner_id      text        NOT NULL,
  provider      text        NOT NULL,
  scope_kind    text        NOT NULL CHECK (scope_kind IN (
    'account', 'repository', 'calendar', 'project',
    'discord_owner', 'discord_guild', 'discord_channel'
  )),
  scope_value   text        NOT NULL CHECK (length(btrim(scope_value)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, scope_kind, scope_value),
  FOREIGN KEY (connection_id, owner_id, provider)
    REFERENCES connections (connection_id, owner_id, provider) ON DELETE RESTRICT,
  -- Provider-specific scope kinds are closed fail-closed. `account` is the
  -- common identity anchor for every provider.
  CHECK (
    scope_kind = 'account'
    OR (provider = 'gitlab' AND scope_kind IN ('repository', 'project'))
    OR (provider = 'jira' AND scope_kind = 'project')
    OR (provider = 'calendar' AND scope_kind = 'calendar')
    OR (provider = 'discord' AND scope_kind IN (
      'discord_owner', 'discord_guild', 'discord_channel'
    ))
  )
);

CREATE INDEX connection_scopes_owner_provider_idx
  ON connection_scopes (owner_id, provider, scope_kind);

-- Append-only operator evidence. Current state is the newest event per scope;
-- disabling a switch appends a new row instead of deleting audit history.
CREATE TABLE kill_switch_events (
  event_sequence bigserial   PRIMARY KEY,
  event_id       text        NOT NULL UNIQUE,
  scope_level    text        NOT NULL CHECK (scope_level IN ('GLOBAL', 'PROVIDER', 'CONNECTION')),
  owner_id       text,
  provider       text        CHECK (provider IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  connection_id  text,
  enabled        boolean     NOT NULL,
  reason         text        NOT NULL CHECK (length(btrim(reason)) > 0),
  changed_by     text        NOT NULL CHECK (length(btrim(changed_by)) > 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope_level = 'GLOBAL' AND owner_id IS NULL AND provider IS NULL AND connection_id IS NULL)
    OR (scope_level = 'PROVIDER' AND owner_id IS NULL AND provider IS NOT NULL AND connection_id IS NULL)
    OR (scope_level = 'CONNECTION' AND owner_id IS NOT NULL AND provider IS NOT NULL AND connection_id IS NOT NULL)
  ),
  FOREIGN KEY (connection_id, owner_id, provider)
    REFERENCES connections (connection_id, owner_id, provider) ON DELETE RESTRICT
);

CREATE INDEX kill_switch_events_lookup_idx
  ON kill_switch_events (scope_level, provider, connection_id, event_sequence DESC);

CREATE TRIGGER kill_switch_events_append_only
  BEFORE UPDATE OR DELETE ON kill_switch_events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

