DROP TABLE IF EXISTS engineering_run_projections;

DROP TRIGGER IF EXISTS engineering_stage_events_append_only ON engineering_stage_events;
DROP TRIGGER IF EXISTS engineering_stage_events_assign_sequence ON engineering_stage_events;
DROP TABLE IF EXISTS engineering_stage_events;
DROP FUNCTION IF EXISTS ra_engineering_assign_event_sequence();

DROP TABLE IF EXISTS engineering_artifact_revisions;
DROP TABLE IF EXISTS engineering_operations;

ALTER TABLE job_reconciliations
  DROP CONSTRAINT IF EXISTS job_reconciliations_engineering_observation_key;
ALTER TABLE job_completions
  DROP CONSTRAINT IF EXISTS job_completions_engineering_observation_key;
ALTER TABLE job_intents
  DROP CONSTRAINT IF EXISTS job_intents_engineering_binding_key;
ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_engineering_scope_key;
