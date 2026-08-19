-- RA-003 migration 010 (down): revert to the pre-010 schema shape. Exactly
-- undoes the up so up/down/up is deterministic.

-- 5. Normalized case ↔ connection scope.
DROP TRIGGER IF EXISTS cases_sync_connections ON cases;
DROP FUNCTION IF EXISTS ra_sync_case_connections();
DROP TABLE IF EXISTS case_connections;

-- 4. external_actions: restore single-column case + approval FKs, drop owner_id.
ALTER TABLE external_actions DROP CONSTRAINT IF EXISTS external_actions_approval_case_fk;
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_approval_fk
  FOREIGN KEY (approval_id) REFERENCES approvals (approval_id) ON DELETE RESTRICT;

ALTER TABLE external_actions DROP CONSTRAINT IF EXISTS external_actions_connection_owner_fk;
ALTER TABLE external_actions DROP CONSTRAINT IF EXISTS external_actions_case_owner_fk;
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_case_id_fkey
  FOREIGN KEY (case_id) REFERENCES cases (case_id) ON DELETE RESTRICT;
ALTER TABLE external_actions DROP COLUMN IF EXISTS owner_id;

-- 3. checkpoint.last_run_id and decision_answer.decision_id single-column FKs.
ALTER TABLE decision_answers DROP CONSTRAINT IF EXISTS decision_answers_decision_case_fk;
ALTER TABLE decision_answers
  ADD CONSTRAINT decision_answers_decision_id_fkey
  FOREIGN KEY (decision_id) REFERENCES decisions (decision_id) ON DELETE RESTRICT;

ALTER TABLE case_checkpoints DROP CONSTRAINT IF EXISTS case_checkpoints_last_run_case_fk;
ALTER TABLE case_checkpoints
  ADD CONSTRAINT case_checkpoints_last_run_id_fkey
  FOREIGN KEY (last_run_id) REFERENCES agent_runs (run_id) ON DELETE RESTRICT;

-- 2. run children single-column run FKs.
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_run_case_fk;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES agent_runs (run_id) ON DELETE RESTRICT;

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_run_case_fk;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES agent_runs (run_id) ON DELETE RESTRICT;

ALTER TABLE run_completions DROP CONSTRAINT IF EXISTS run_completions_run_case_fk;
ALTER TABLE run_completions
  ADD CONSTRAINT run_completions_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES agent_runs (run_id) ON DELETE RESTRICT;

ALTER TABLE run_intents DROP CONSTRAINT IF EXISTS run_intents_run_case_fk;
ALTER TABLE run_intents
  ADD CONSTRAINT run_intents_run_id_fkey
  FOREIGN KEY (run_id) REFERENCES agent_runs (run_id) ON DELETE RESTRICT;

-- 1. provider ↔ connection and raw provenance FKs → restore originals.
ALTER TABLE external_entities DROP CONSTRAINT IF EXISTS external_entities_connection_provider_fk;
ALTER TABLE external_entities
  ADD CONSTRAINT external_entities_connection_id_owner_id_fkey
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_raw_event_provenance_fk;
ALTER TABLE events
  ADD CONSTRAINT events_raw_event_id_fkey
  FOREIGN KEY (raw_event_id) REFERENCES raw_events (raw_event_id) ON DELETE RESTRICT;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_connection_provider_fk;
ALTER TABLE events
  ADD CONSTRAINT events_connection_id_owner_id_fkey
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT;

ALTER TABLE raw_events DROP CONSTRAINT IF EXISTS raw_events_connection_provider_fk;
ALTER TABLE raw_events
  ADD CONSTRAINT raw_events_connection_id_owner_id_fkey
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT;

-- 0. supporting UNIQUE keys.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_approval_case_key;
ALTER TABLE decisions DROP CONSTRAINT IF EXISTS decisions_id_case_key;
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_case_key;
ALTER TABLE raw_events DROP CONSTRAINT IF EXISTS raw_events_provenance_key;
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_id_owner_provider_key;
