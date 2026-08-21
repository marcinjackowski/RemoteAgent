-- RA-021 migration 028 (down): drop the brokered MCP tool-call ledger.
--
-- Reverses 028 up exactly: dropping the table takes its trigger and all three
-- indexes with it. 028 up adds no constraint to any pre-existing table and mutates
-- no existing data, so this is a complete, lossless revert — after `down` the
-- schema is identical to the post-027 state and `up` can be re-applied.

DROP TABLE IF EXISTS mcp_tool_calls;
