-- RA-012 migration 027 (down): drop the implementation-tool operation ledger.
--
-- Reverses 027 up exactly and in reverse order: the table (which takes its trigger
-- and both indexes with it), then the composite UNIQUE added to `workspaces`.
-- Dropping the constraint last matters — the table's foreign key depends on it.
--
-- Nothing else in 027 up mutates existing data, so this is a complete, lossless
-- revert of the schema change: after `down` the schema is byte-identical to the
-- post-026 state, and `up` can be re-applied.

DROP TABLE IF EXISTS implementation_tool_operations;
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_id_case_key;
