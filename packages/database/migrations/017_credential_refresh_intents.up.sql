-- RA-005 remediation (AUDIT-01 HIGH-02): a durable credential-refresh intent so
-- a vault write has a stable idempotency identity and a well-defined outcome
-- after timeout/crash. Additive over 015 (ADR-0002).
--
-- Before this migration the refresh coordinator generated a fresh random vault
-- ref on every attempt and only cleaned up after a CONFIRMED write. A create
-- that succeeded and then timed out (or a crash before the CAS publish) left an
-- orphaned secret with no durable intent, no DB reference and no reconciliation
-- path; the next run minted yet another version instead of resolving the prior
-- side effect (AGENTS.md §8, Master Plan §6.2 run safety).
--
-- The intent is keyed by a caller-supplied operation_id (the idempotency key).
-- version_id / credential_secret_ref are written ONCE and reused verbatim on
-- every retry, so a retry re-addresses the SAME vault object rather than
-- creating a new one. oauth_* lifecycle is persisted before the write so a
-- recovered run publishes metadata consistent with the stored secret without
-- re-acquiring it. status records the durable lifecycle:
--
--   PENDING       intent recorded; vault write not yet confirmed
--   VAULT_WRITTEN vault object confirmed present (directly or via reconciliation)
--   PUBLISHED     metadata CAS won; the connection now points at this ref
--   ABORTED       lost the CAS race; the unpublished ref was revoked
--   AMBIGUOUS     write outcome could not be determined; NO automatic replay
--
-- The coordinator reconciles PENDING/AMBIGUOUS via a value-free vault probe
-- (head/DescribeSecret) before retrying or cleaning up.

CREATE TABLE credential_refresh_intents (
  operation_id          text        PRIMARY KEY,
  connection_id         text        NOT NULL,
  owner_id              text        NOT NULL,
  provider              text        NOT NULL,
  expected_revision     bigint      NOT NULL CHECK (expected_revision >= 0),
  version_id            text        NOT NULL CHECK (length(btrim(version_id)) > 0),
  credential_secret_ref text        NOT NULL CHECK (length(btrim(credential_secret_ref)) > 0),
  status                text        NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VAULT_WRITTEN', 'PUBLISHED', 'ABORTED', 'AMBIGUOUS')),
  oauth_expires_at      timestamptz,
  oauth_refresh_after   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- The intent belongs to a real connection of a specific owner/provider; a
  -- later owner/provider change or delete that would orphan it is rejected.
  FOREIGN KEY (connection_id, owner_id, provider)
    REFERENCES connections (connection_id, owner_id, provider) ON DELETE RESTRICT,
  CONSTRAINT credential_refresh_intents_refresh_window_check CHECK (
    oauth_refresh_after IS NULL OR oauth_expires_at IS NULL
    OR oauth_refresh_after < oauth_expires_at
  )
);

CREATE INDEX credential_refresh_intents_connection_idx
  ON credential_refresh_intents (connection_id, status);
