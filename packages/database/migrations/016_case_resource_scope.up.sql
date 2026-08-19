-- RA-005 remediation (AUDIT-01 HIGH-01): make the provider RESOURCE allowlist
-- case-scoped, not merely connection-scoped. Additive over migrations 010/011
-- and 015 (ADR-0002: evolve via a new migration, never edit an applied one).
--
-- Before this migration a case could reach ANY resource configured on a
-- connection it was a member of (connection_scopes is global to the connection).
-- A case named for repo A could therefore select repo B on the same connection.
--
-- case_connection_scopes is the authoritative, per-case resource grant. A row is
-- valid only when it is BOTH:
--   1. a member of the case's connection allowlist (case_connections), and
--   2. an actually-configured scope of that connection (connection_scopes).
-- Both edges are enforced by composite foreign keys, so the case resource scope
-- is always the INTERSECTION of case membership and connection configuration and
-- can never widen either. The resolver intersects a requested target with this
-- table (see packages/policy/src/scope.ts), so neither the model nor injected
-- UNTRUSTED_DATA can select a resource the owner did not grant to THIS case.
--
-- ON DELETE CASCADE keeps the grant fail-closed: dropping a case's membership
-- (a re-sync of integration_scope deletes+rebuilds case_connections) or removing
-- a configured connection scope (replaceScopes) removes the dependent grant, so
-- access is lost until the owner re-grants it. It never blocks the accepted
-- re-sync / replaceScopes paths and never leaves a stale, widened grant behind.

CREATE TABLE case_connection_scopes (
  case_id       text        NOT NULL,
  connection_id text        NOT NULL,
  scope_kind    text        NOT NULL CHECK (scope_kind IN (
    'account', 'repository', 'calendar', 'project',
    'discord_owner', 'discord_guild', 'discord_channel'
  )),
  scope_value   text        NOT NULL CHECK (length(btrim(scope_value)) > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, connection_id, scope_kind, scope_value),
  -- 1. The grant must belong to the case's connection allowlist.
  FOREIGN KEY (case_id, connection_id)
    REFERENCES case_connections (case_id, connection_id) ON DELETE CASCADE,
  -- 2. The grant must be a resource actually configured on that connection, so a
  --    case can only ever hold a SUBSET of the connection's provider scopes.
  FOREIGN KEY (connection_id, scope_kind, scope_value)
    REFERENCES connection_scopes (connection_id, scope_kind, scope_value)
    ON DELETE CASCADE
);

CREATE INDEX case_connection_scopes_case_idx
  ON case_connection_scopes (case_id, connection_id);
