-- RA-038 migration 034: durable Engineering Control Plane bindings, artifacts,
-- events and a disposable run projection.
--
-- `job_intents`, `job_completions` and `job_reconciliations` remain the only
-- effect intent/receipt/reconciliation ledgers.  The tables below bind those
-- ledgers to an engineering stage and retain validated control-plane evidence.

-- Supporting keys let every new edge bind the exact existing authority tuple.
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_engineering_scope_key
  UNIQUE (run_id, case_id, owner_id, checkpoint_revision);

ALTER TABLE job_intents
  ADD CONSTRAINT job_intents_engineering_binding_key
  UNIQUE (intent_id, idempotency_key, job_id, case_id, kind);

ALTER TABLE job_completions
  ADD CONSTRAINT job_completions_engineering_observation_key
  UNIQUE (completion_id, intent_id, job_id);

ALTER TABLE job_reconciliations
  ADD CONSTRAINT job_reconciliations_engineering_observation_key
  UNIQUE (reconciliation_id, intent_id, job_id);

CREATE TABLE engineering_operations (
  operation_id             text        PRIMARY KEY,
  intent_id                text        NOT NULL UNIQUE,
  idempotency_key          text        NOT NULL UNIQUE,
  job_id                   text        NOT NULL,
  case_id                  text        NOT NULL,
  owner_id                 text        NOT NULL,
  run_id                   text        NOT NULL,
  stage                    text        NOT NULL CHECK (stage IN (
                             'DISCOVERY', 'OUTCOME_DEFINITION', 'SYSTEM_DESIGN',
                             'PROGRAM_DESIGN', 'DESIGN_APPROVAL', 'SLICE_PLANNING',
                             'SLICE_IMPLEMENTATION', 'GATE_EXECUTION', 'SLICE_REVIEW',
                             'MEMORY_PROJECTION', 'FINAL_VERIFICATION')),
  stage_attempt            integer     NOT NULL CHECK (stage_attempt >= 1),
  checkpoint_revision      integer     NOT NULL CHECK (checkpoint_revision >= 0),
  operation_kind           text        NOT NULL CHECK (length(btrim(operation_kind)) > 0),
  effect_class             text        NOT NULL CHECK (effect_class IN (
                             'READ_ONLY', 'MODEL_CALL', 'COMMAND', 'MUTATING_SIDE_EFFECT')),
  integration_scope_digest text        NOT NULL CHECK (
                             integration_scope_digest ~ '^sha256:[0-9a-f]{64}$'),
  input_digest             text        NOT NULL CHECK (
                             input_digest ~ '^sha256:[0-9a-f]{64}$'),
  config_digest            text        NOT NULL CHECK (
                             config_digest ~ '^sha256:[0-9a-f]{64}$'),
  schema_digest            text        NOT NULL CHECK (
                             schema_digest ~ '^sha256:[0-9a-f]{64}$'),
  deadline_at              timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (operation_id = idempotency_key),
  FOREIGN KEY (case_id, owner_id)
    REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (run_id, case_id, owner_id, checkpoint_revision)
    REFERENCES agent_runs (run_id, case_id, owner_id, checkpoint_revision) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, case_id)
    REFERENCES jobs (job_id, case_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id, idempotency_key, job_id, case_id, operation_kind)
    REFERENCES job_intents (intent_id, idempotency_key, job_id, case_id, kind)
    ON DELETE RESTRICT,
  UNIQUE (
    operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
    stage_attempt, checkpoint_revision),
  UNIQUE (
    operation_id, run_id, case_id, owner_id, stage, stage_attempt,
    checkpoint_revision)
);

CREATE INDEX engineering_operations_run_idx
  ON engineering_operations (run_id, stage, stage_attempt, recorded_at);

CREATE TRIGGER engineering_operations_append_only
  BEFORE UPDATE OR DELETE ON engineering_operations
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TABLE engineering_artifact_revisions (
  artifact_revision_id text        PRIMARY KEY,
  artifact_key         text        NOT NULL CHECK (length(btrim(artifact_key)) > 0),
  revision             integer     NOT NULL CHECK (revision >= 0),
  artifact_kind        text        NOT NULL CHECK (length(btrim(artifact_kind)) > 0),
  payload              jsonb       NOT NULL,
  payload_digest       text        NOT NULL CHECK (
                         payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  operation_id         text        NOT NULL,
  intent_id            text        NOT NULL,
  job_id               text        NOT NULL,
  case_id              text        NOT NULL,
  owner_id             text        NOT NULL,
  run_id               text        NOT NULL,
  stage                text        NOT NULL,
  stage_attempt        integer     NOT NULL,
  checkpoint_revision  integer     NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (
    operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
    stage_attempt, checkpoint_revision)
    REFERENCES engineering_operations (
      operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
      stage_attempt, checkpoint_revision)
    ON DELETE RESTRICT,
  UNIQUE (run_id, artifact_key, revision),
  UNIQUE (
    artifact_revision_id, operation_id, intent_id, job_id, case_id, owner_id,
    run_id, stage, stage_attempt, checkpoint_revision),
  UNIQUE (
    artifact_revision_id, operation_id, run_id, case_id, owner_id, stage,
    stage_attempt, checkpoint_revision)
);

CREATE INDEX engineering_artifact_revisions_operation_idx
  ON engineering_artifact_revisions (operation_id, recorded_at);

CREATE TRIGGER engineering_artifact_revisions_append_only
  BEFORE UPDATE OR DELETE ON engineering_artifact_revisions
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TABLE engineering_stage_events (
  event_id               text        PRIMARY KEY,
  event_sequence         bigint      NOT NULL CHECK (event_sequence >= 1),
  event_type             text        NOT NULL CHECK (event_type IN (
                           'INTENT_BOUND', 'STARTED', 'COMPLETION_OBSERVED',
                           'ARTIFACT_RECORDED', 'PROJECTION_APPLIED',
                           'RECOVERY_CLASSIFIED', 'OPERATOR_ACKNOWLEDGED',
                           'OPERATOR_CANCEL_REQUESTED', 'OPERATOR_RECONCILED',
                           'OPERATOR_RECONCILE_REQUESTED',
                           'OPERATOR_RETRY_REQUESTED', 'TERMINATED')),
  operation_id           text        NOT NULL,
  intent_id              text        NOT NULL,
  job_id                 text        NOT NULL,
  case_id                text        NOT NULL,
  owner_id               text        NOT NULL,
  run_id                 text        NOT NULL,
  stage                  text        NOT NULL,
  stage_attempt          integer     NOT NULL,
  checkpoint_revision    integer     NOT NULL,
  artifact_revision_id   text,
  completion_id          text,
  reconciliation_id      text,
  payload                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  payload_digest         text        NOT NULL CHECK (
                           payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (
    operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
    stage_attempt, checkpoint_revision)
    REFERENCES engineering_operations (
      operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
      stage_attempt, checkpoint_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    artifact_revision_id, operation_id, intent_id, job_id, case_id, owner_id,
    run_id, stage, stage_attempt, checkpoint_revision)
    REFERENCES engineering_artifact_revisions (
      artifact_revision_id, operation_id, intent_id, job_id, case_id, owner_id,
      run_id, stage, stage_attempt, checkpoint_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (completion_id, intent_id, job_id)
    REFERENCES job_completions (completion_id, intent_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (reconciliation_id, intent_id, job_id)
    REFERENCES job_reconciliations (reconciliation_id, intent_id, job_id) ON DELETE RESTRICT,
  UNIQUE (run_id, event_sequence),
  UNIQUE (event_id, run_id, event_sequence),
  CHECK (
    (event_type = 'ARTIFACT_RECORDED' AND artifact_revision_id IS NOT NULL
      AND completion_id IS NULL AND reconciliation_id IS NULL)
    OR (event_type = 'COMPLETION_OBSERVED' AND artifact_revision_id IS NULL
      AND completion_id IS NOT NULL AND reconciliation_id IS NULL)
    OR (event_type = 'OPERATOR_RECONCILED' AND artifact_revision_id IS NULL
      AND completion_id IS NULL AND reconciliation_id IS NOT NULL)
    OR (event_type NOT IN ('ARTIFACT_RECORDED', 'COMPLETION_OBSERVED', 'OPERATOR_RECONCILED')
      AND artifact_revision_id IS NULL AND completion_id IS NULL AND reconciliation_id IS NULL)
  )
);

CREATE UNIQUE INDEX engineering_stage_events_started_uidx
  ON engineering_stage_events (operation_id)
  WHERE event_type = 'STARTED';

CREATE UNIQUE INDEX engineering_stage_events_intent_bound_uidx
  ON engineering_stage_events (operation_id)
  WHERE event_type = 'INTENT_BOUND';

CREATE UNIQUE INDEX engineering_stage_events_artifact_uidx
  ON engineering_stage_events (artifact_revision_id)
  WHERE event_type = 'ARTIFACT_RECORDED';

CREATE UNIQUE INDEX engineering_stage_events_completion_uidx
  ON engineering_stage_events (completion_id)
  WHERE event_type = 'COMPLETION_OBSERVED';

CREATE UNIQUE INDEX engineering_stage_events_reconciliation_uidx
  ON engineering_stage_events (reconciliation_id)
  WHERE event_type = 'OPERATOR_RECONCILED';

-- The run row is the existing serialization authority.  Locking it avoids a
-- second mutable counter while allocating a gapless per-run event sequence.
CREATE FUNCTION ra_engineering_assign_event_sequence() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM agent_runs WHERE run_id = NEW.run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engineering event references unknown run %', NEW.run_id;
  END IF;

  SELECT COALESCE(MAX(event_sequence), 0) + 1
    INTO NEW.event_sequence
    FROM engineering_stage_events
    WHERE run_id = NEW.run_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engineering_stage_events_assign_sequence
  BEFORE INSERT ON engineering_stage_events
  FOR EACH ROW EXECUTE FUNCTION ra_engineering_assign_event_sequence();

CREATE TRIGGER engineering_stage_events_append_only
  BEFORE UPDATE OR DELETE ON engineering_stage_events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TABLE engineering_run_projections (
  run_id                       text        PRIMARY KEY,
  case_id                      text        NOT NULL,
  owner_id                     text        NOT NULL,
  checkpoint_revision          integer     NOT NULL CHECK (checkpoint_revision >= 0),
  current_stage                text        NOT NULL CHECK (current_stage IN (
                                 'DISCOVERY', 'OUTCOME_DEFINITION', 'SYSTEM_DESIGN',
                                 'PROGRAM_DESIGN', 'DESIGN_APPROVAL', 'SLICE_PLANNING',
                                 'SLICE_IMPLEMENTATION', 'GATE_EXECUTION', 'SLICE_REVIEW',
                                 'MEMORY_PROJECTION', 'FINAL_VERIFICATION')),
  stage_attempt                integer     NOT NULL CHECK (stage_attempt >= 1),
  recovery_status              text        NOT NULL CHECK (recovery_status IN (
                                 'READY', 'RECOVERED', 'DIRTY', 'AMBIGUOUS',
                                 'BLOCKED', 'CANCELLED')),
  cancellation_requested       boolean     NOT NULL DEFAULT false,
  current_operation_id         text,
  current_artifact_revision_id text,
  last_event_id                text        NOT NULL,
  last_event_sequence          bigint      NOT NULL CHECK (last_event_sequence >= 1),
  projection                   jsonb       NOT NULL,
  projection_digest            text        NOT NULL CHECK (
                                 projection_digest ~ '^sha256:[0-9a-f]{64}$'),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, case_id, owner_id, checkpoint_revision)
    REFERENCES agent_runs (run_id, case_id, owner_id, checkpoint_revision) ON DELETE RESTRICT,
  FOREIGN KEY (
    current_operation_id, run_id, case_id, owner_id, current_stage,
    stage_attempt, checkpoint_revision)
    REFERENCES engineering_operations (
      operation_id, run_id, case_id, owner_id, stage, stage_attempt,
      checkpoint_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    current_artifact_revision_id, current_operation_id, run_id, case_id,
    owner_id, current_stage, stage_attempt, checkpoint_revision)
    REFERENCES engineering_artifact_revisions (
      artifact_revision_id, operation_id, run_id, case_id, owner_id, stage,
      stage_attempt, checkpoint_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (last_event_id, run_id, last_event_sequence)
    REFERENCES engineering_stage_events (event_id, run_id, event_sequence) ON DELETE RESTRICT,
  CHECK (current_artifact_revision_id IS NULL OR current_operation_id IS NOT NULL)
);

CREATE TRIGGER engineering_run_projections_touch_updated_at
  BEFORE UPDATE ON engineering_run_projections
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
