-- RA-003 migration 001 (up): extensions, append-only guard, owners, connections.
--
-- The append-only guard is a reusable trigger function raising a custom SQLSTATE
-- (P0100) so the application maps it to AppendOnlyViolationError. Ledger/audit
-- tables attach this trigger for UPDATE and DELETE, denying mutation at the
-- database level (not merely in application code).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Deny any UPDATE/DELETE on an append-only table. Raises SQLSTATE P0100.
CREATE OR REPLACE FUNCTION ra_deny_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0100';
END;
$$ LANGUAGE plpgsql;

-- Keep updated_at fresh on mutable rows.
CREATE OR REPLACE FUNCTION ra_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Owners: the top-level identity that scopes connections, cases and entities.
CREATE TABLE owners (
  owner_id     text        PRIMARY KEY,
  display_name text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER owners_touch_updated_at
  BEFORE UPDATE ON owners
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Connections: one authenticated link to an external provider, owned by exactly
-- one owner. Provider is a closed set mirroring @remoteagent/contracts Provider.
CREATE TABLE connections (
  connection_id text        PRIMARY KEY,
  owner_id      text        NOT NULL REFERENCES owners (owner_id) ON DELETE RESTRICT,
  provider      text        NOT NULL CHECK (provider IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  display_name  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Composite key lets downstream tables enforce that a row referencing this
  -- connection also matches its owner, so scope cannot be crossed by a plain
  -- write (RA-003 acceptance criterion 4).
  UNIQUE (connection_id, owner_id)
);

CREATE INDEX connections_owner_idx ON connections (owner_id);
CREATE INDEX connections_owner_provider_idx ON connections (owner_id, provider);

CREATE TRIGGER connections_touch_updated_at
  BEFORE UPDATE ON connections
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
