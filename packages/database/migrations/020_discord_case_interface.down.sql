-- RA-006 migration 020 (down): drop the Discord case interface tables.
--
-- Reverses 020 up exactly. Triggers and indexes are dropped implicitly with
-- their tables; drop in reverse dependency order (receipts reference cases only,
-- bindings reference cases). Fail-closed: DROP without IF EXISTS would error on a
-- partially-applied state, but migrateDown only runs this for a fully-applied
-- version, so a plain DROP is correct here.

DROP TABLE discord_dispatch_receipts;
DROP TABLE discord_case_bindings;
