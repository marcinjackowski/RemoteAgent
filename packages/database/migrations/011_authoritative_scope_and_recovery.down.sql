-- RA-003 migration 011 (down): revert to the migration-010 schema shape. Exactly
-- undoes the up so up/down/up is deterministic.

-- 5. integration_scope shape validation folded into the sync function: restore the
--    migration-010 version of ra_sync_case_connections (shape check inlined, no
--    separate validator) and drop the validator.
CREATE OR REPLACE FUNCTION ra_sync_case_connections() RETURNS trigger AS $$
DECLARE
  scope_provs jsonb := NEW.integration_scope -> 'providers';
  scope_conns jsonb := NEW.integration_scope -> 'connection_ids';
  conn_id     text;
  conn_prov   text;
BEGIN
  IF scope_conns IS NULL OR jsonb_typeof(scope_conns) <> 'array'
     OR scope_provs IS NULL OR jsonb_typeof(scope_provs) <> 'array' THEN
    RAISE EXCEPTION 'integration_scope must contain providers[] and connection_ids[] arrays'
      USING ERRCODE = 'P0101';
  END IF;

  DELETE FROM case_connections WHERE case_id = NEW.case_id;

  FOR conn_id IN SELECT DISTINCT jsonb_array_elements_text(scope_conns) LOOP
    SELECT provider INTO conn_prov FROM connections WHERE connection_id = conn_id;
    IF conn_prov IS NULL THEN
      RAISE EXCEPTION 'integration_scope references unknown connection % for case %',
        conn_id, NEW.case_id USING ERRCODE = 'P0101';
    END IF;
    IF NOT (scope_provs @> to_jsonb(conn_prov)) THEN
      RAISE EXCEPTION
        'integration_scope connection % has provider % not declared in scope providers',
        conn_id, conn_prov USING ERRCODE = 'P0101';
    END IF;
    INSERT INTO case_connections (case_id, owner_id, connection_id, provider)
      VALUES (NEW.case_id, NEW.owner_id, conn_id, conn_prov);
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS ra_validate_integration_scope(jsonb, text);

-- 4. approval FK: restore (approval_id, case_id).
ALTER TABLE external_actions DROP CONSTRAINT IF EXISTS external_actions_approval_case_digest_fk;
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_approval_case_fk
  FOREIGN KEY (approval_id, case_id) REFERENCES approvals (approval_id, case_id) ON DELETE RESTRICT;

-- 3c. case_checkpoints: restore last_event single-column FK, drop owner binding.
ALTER TABLE case_checkpoints DROP CONSTRAINT IF EXISTS case_checkpoints_last_event_owner_fk;
ALTER TABLE case_checkpoints
  ADD CONSTRAINT case_checkpoints_last_event_id_fkey
  FOREIGN KEY (last_event_id) REFERENCES events (event_id) ON DELETE RESTRICT;
ALTER TABLE case_checkpoints DROP CONSTRAINT IF EXISTS case_checkpoints_case_owner_fk;
ALTER TABLE case_checkpoints DROP COLUMN IF EXISTS owner_id;

-- 3b. agent_runs: restore trigger_event single-column FK, drop owner binding.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_trigger_event_owner_fk;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_trigger_event_id_fkey
  FOREIGN KEY (trigger_event_id) REFERENCES events (event_id) ON DELETE RESTRICT;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_case_owner_fk;
ALTER TABLE agent_runs DROP COLUMN IF EXISTS owner_id;

-- 3a. cases.active_run_id FK.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_active_run_case_fk;

-- 2. membership FKs on entities/actions.
ALTER TABLE external_actions DROP CONSTRAINT IF EXISTS external_actions_case_connection_member_fk;
ALTER TABLE external_entities DROP CONSTRAINT IF EXISTS external_entities_case_connection_member_fk;

-- 1. case_connections tamper guard.
DROP TRIGGER IF EXISTS case_connections_guard ON case_connections;
DROP FUNCTION IF EXISTS ra_guard_case_connections();

-- 0. supporting unique keys.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_id_case_digest_key;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_id_owner_key;
