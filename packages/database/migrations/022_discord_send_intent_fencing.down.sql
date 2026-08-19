-- RA-006 migration 022 (down): drop the send-intent ownership fence + lease.
--
-- Reverses 022 up's SCHEMA change exactly: drop the two added columns. Fail-closed:
-- a plain ALTER (no IF EXISTS) errors on a partially-applied state, but migrateDown
-- only runs this for a fully-applied version, so a plain statement is correct.
--
-- The up-migration's STARTED -> AMBIGUOUS backfill is a one-way, fail-closed safety
-- transition (a provably-abandoned in-flight write whose outcome is unknown); it is
-- deliberately NOT reversed here, since resurrecting a STARTED intent without an
-- owner/lease would recreate exactly the unrecoverable state 022 removed.

ALTER TABLE discord_send_intents
  DROP COLUMN lease_expires_at,
  DROP COLUMN owner_token;
