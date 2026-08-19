-- RA-006 migration 021 (down): reverse the send-intent ledger and status gate.
--
-- Reverses 021 up exactly and in reverse order: drop the added column, then the
-- intents table (its index/trigger drop implicitly with it). Fail-closed: a plain
-- DROP/ALTER (no IF EXISTS) errors on a partially-applied state, but migrateDown
-- only runs this for a fully-applied version, so a plain statement is correct.

ALTER TABLE discord_case_bindings
  DROP COLUMN last_status_revision;

DROP TABLE discord_send_intents;
