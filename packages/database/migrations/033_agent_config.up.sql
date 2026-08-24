-- RA-032 migration 033 (up): server-owned agent configuration.
--
-- The model a role runs on is a SERVER-OWNED setting (AGENTS.md §4: the model is not an
-- authorization/decision layer and never chooses its own model). It belongs in configuration
-- resolved at run dispatch, not baked into a process env var. This key/value table holds it;
-- `resolveModelId` reads `model_id` here, falling back to env only as a bootstrap default.
--
-- Key/value (not a wide row) so future server-owned knobs (effort, timeout) can be added without
-- a migration. Bounded lengths; `updated_at` maintained by the shared touch trigger.
CREATE TABLE agent_config (
  key        text        PRIMARY KEY CHECK (length(btrim(key)) BETWEEN 1 AND 128),
  value      text        NOT NULL CHECK (length(value) BETWEEN 1 AND 512),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER agent_config_touch_updated_at
  BEFORE UPDATE ON agent_config
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
