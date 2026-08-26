-- RA-047: code-owned cross-fence recovery authority for engineering jobs.
--
-- `jobs` remains the sole lease clock/owner/fencing authority.  The recovery
-- row binds immutable provenance and remembers only the greatest recovery fence
-- that was issued. Generic queue claim/reconciliation cannot execute this path.

ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'RECONCILING',
    'RECOVERY_PENDING'));

DROP INDEX jobs_active_serialization_uidx;
CREATE UNIQUE INDEX jobs_active_serialization_uidx
  ON jobs (serialization_key)
  WHERE serialization_key IS NOT NULL
    AND status IN ('LEASED', 'RECONCILING', 'RECOVERY_PENDING');

CREATE INDEX jobs_engineering_recovery_pending_idx
  ON jobs (available_at, job_id)
  WHERE status = 'RECOVERY_PENDING';

-- Exact composite authority edges used by the recovery row. These prevent a
-- proposal, intent and operation from three unrelated runs being assembled into
-- one apparently valid recovery.
ALTER TABLE engineering_write_proposals
  ADD CONSTRAINT engineering_write_proposals_recovery_authority_key UNIQUE (
    proposal_id, approval_id, job_id, case_id, owner_id, work_unit_id, run_id,
    checkpoint_revision, repository_id);

ALTER TABLE job_intents
  ADD CONSTRAINT job_intents_recovery_fence_key
  UNIQUE (intent_id, job_id, fencing_token);

ALTER TABLE engineering_operations
  ADD CONSTRAINT engineering_operations_recovery_authority_key UNIQUE (
    operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
    stage_attempt, checkpoint_revision, effect_class, integration_scope_digest,
    input_digest, config_digest, schema_digest, deadline_at);

CREATE TABLE engineering_recoveries (
  schema_version                 integer     NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  recovery_id                   text        PRIMARY KEY,
  root_recovery_id              text        NOT NULL,
  parent_recovery_id            text,
  source_job_id                 text        NOT NULL REFERENCES jobs (job_id) ON DELETE RESTRICT,
  source_fencing_token          bigint      NOT NULL CHECK (source_fencing_token >= 1),
  recovery_job_id               text        NOT NULL UNIQUE REFERENCES jobs (job_id) ON DELETE RESTRICT,
  proposal_id                   text        NOT NULL,
  approval_id                   text        NOT NULL,
  case_id                       text        NOT NULL,
  owner_id                      text        NOT NULL,
  work_unit_id                  text        NOT NULL,
  run_id                        text        NOT NULL,
  checkpoint_revision           integer     NOT NULL CHECK (checkpoint_revision >= 0),
  repository_id                text        NOT NULL CHECK (length(btrim(repository_id)) > 0),
  source_payload_digest         text        NOT NULL CHECK (
                                  source_payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  workflow_deadline_at          timestamptz NOT NULL,
  source_operation_id           text,
  source_intent_id              text,
  source_stage                  text,
  source_stage_attempt          integer     CHECK (source_stage_attempt >= 1),
  source_effect_class           text        CHECK (source_effect_class IN (
                                  'READ_ONLY', 'MODEL_CALL', 'COMMAND', 'MUTATING_SIDE_EFFECT')),
  source_input_digest           text        CHECK (
                                  source_input_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_config_digest          text        CHECK (
                                  source_config_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_schema_digest          text        CHECK (
                                  source_schema_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_scope_digest           text        CHECK (
                                  source_scope_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_deadline_at            timestamptz,
  status                        text        NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                                  'PENDING', 'LEASED', 'RECOVERY_PENDING', 'CONTINUED',
                                  'AMBIGUOUS', 'BLOCKED', 'CANCELLED')),
  last_recovery_fencing_token   bigint      NOT NULL DEFAULT 0 CHECK (
                                  last_recovery_fencing_token >= 0),
  continuation_fencing_token    bigint      CHECK (continuation_fencing_token >= 1),
  plan                          jsonb,
  plan_digest                   text        CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (
    proposal_id, approval_id, source_job_id, case_id, owner_id, work_unit_id,
    run_id, checkpoint_revision, repository_id)
    REFERENCES engineering_write_proposals (
      proposal_id, approval_id, job_id, case_id, owner_id, work_unit_id, run_id,
      checkpoint_revision, repository_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (source_intent_id, source_job_id, source_fencing_token)
    REFERENCES job_intents (intent_id, job_id, fencing_token) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_operation_id, source_intent_id, source_job_id, case_id, owner_id, run_id,
    source_stage, source_stage_attempt, checkpoint_revision, source_effect_class,
    source_scope_digest, source_input_digest, source_config_digest,
    source_schema_digest, source_deadline_at)
    REFERENCES engineering_operations (
      operation_id, intent_id, job_id, case_id, owner_id, run_id, stage,
      stage_attempt, checkpoint_revision, effect_class, integration_scope_digest,
      input_digest, config_digest, schema_digest, deadline_at)
    ON DELETE RESTRICT,
  UNIQUE (source_job_id, source_fencing_token),
  UNIQUE (recovery_id, source_job_id, workflow_deadline_at),
  FOREIGN KEY (root_recovery_id, source_job_id, workflow_deadline_at)
    REFERENCES engineering_recoveries (recovery_id, source_job_id, workflow_deadline_at)
    ON DELETE RESTRICT,
  FOREIGN KEY (parent_recovery_id, source_job_id, workflow_deadline_at)
    REFERENCES engineering_recoveries (recovery_id, source_job_id, workflow_deadline_at)
    ON DELETE RESTRICT,
  CHECK (
    (parent_recovery_id IS NULL AND root_recovery_id = recovery_id)
    OR (parent_recovery_id IS NOT NULL AND parent_recovery_id <> recovery_id)
  ),
  CHECK (
    (source_operation_id IS NULL AND source_intent_id IS NULL AND source_stage IS NULL
      AND source_stage_attempt IS NULL AND source_effect_class IS NULL
      AND source_input_digest IS NULL AND source_config_digest IS NULL
      AND source_schema_digest IS NULL AND source_scope_digest IS NULL
      AND source_deadline_at IS NULL)
    OR
    (source_operation_id IS NOT NULL AND source_intent_id IS NOT NULL AND source_stage IS NOT NULL
      AND source_stage_attempt IS NOT NULL AND source_effect_class IS NOT NULL
      AND source_input_digest IS NOT NULL AND source_config_digest IS NOT NULL
      AND source_schema_digest IS NOT NULL AND source_scope_digest IS NOT NULL
      AND source_deadline_at = workflow_deadline_at)
  ),
  CHECK (
    (status = 'PENDING'
      AND continuation_fencing_token IS NULL AND plan IS NULL AND plan_digest IS NULL)
    OR
    (status = 'LEASED' AND last_recovery_fencing_token >= 1
      AND continuation_fencing_token IS NULL
      AND ((plan IS NULL AND plan_digest IS NULL)
        OR (plan IS NOT NULL AND plan_digest IS NOT NULL)))
    OR
    (status = 'RECOVERY_PENDING'
      AND last_recovery_fencing_token >= 1
      AND continuation_fencing_token IS NULL AND plan IS NOT NULL AND plan_digest IS NOT NULL)
    OR
    (status = 'CONTINUED'
      AND last_recovery_fencing_token >= 1 AND continuation_fencing_token IS NOT NULL
      AND plan IS NOT NULL AND plan_digest IS NOT NULL)
    OR
    (status IN ('AMBIGUOUS', 'BLOCKED', 'CANCELLED')
      AND last_recovery_fencing_token >= 1 AND continuation_fencing_token IS NULL
      AND plan IS NOT NULL AND plan_digest IS NOT NULL)
  )
);

CREATE INDEX engineering_recoveries_status_idx
  ON engineering_recoveries (status, created_at, recovery_id);
CREATE INDEX engineering_recoveries_run_idx
  ON engineering_recoveries (run_id, created_at, recovery_id);

CREATE TABLE engineering_recovery_events (
  event_sequence          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id                text        NOT NULL UNIQUE,
  recovery_id             text        NOT NULL
                                REFERENCES engineering_recoveries (recovery_id) ON DELETE RESTRICT,
  event_type              text        NOT NULL CHECK (event_type IN (
                            'ENQUEUED', 'CLAIMED', 'CLASSIFIED', 'EXECUTION_RESERVED',
                            'ARTIFACT_REPAIRED', 'COMPLETION_REPAIRED',
                            'OBSERVATION_REPAIRED', 'CONTINUATION_ENQUEUED',
                            'CONTINUATION_CLAIMED', 'TERMINATED')),
  authority_job_id        text        REFERENCES jobs (job_id) ON DELETE RESTRICT,
  authority_fencing_token bigint      CHECK (authority_fencing_token >= 1),
  payload                 jsonb       NOT NULL,
  payload_digest          text        NOT NULL CHECK (payload_digest ~ '^sha256:[0-9a-f]{64}$'),
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (event_type = 'ENQUEUED' AND authority_job_id IS NULL AND authority_fencing_token IS NULL)
    OR
    (event_type <> 'ENQUEUED' AND authority_job_id IS NOT NULL
      AND authority_fencing_token IS NOT NULL)
  ),
  UNIQUE (recovery_id, event_sequence)
);

CREATE INDEX engineering_recovery_events_recovery_idx
  ON engineering_recovery_events (recovery_id, event_sequence);

CREATE UNIQUE INDEX engineering_recovery_events_repair_uidx
  ON engineering_recovery_events (recovery_id, event_type, payload_digest)
  WHERE event_type IN ('ARTIFACT_REPAIRED', 'COMPLETION_REPAIRED', 'OBSERVATION_REPAIRED');

CREATE TRIGGER engineering_recovery_events_append_only
  BEFORE UPDATE OR DELETE ON engineering_recovery_events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE OR REPLACE FUNCTION ra_guard_engineering_recovery_event() RETURNS trigger AS $$
DECLARE
  authority engineering_recoveries%ROWTYPE;
BEGIN
  SELECT * INTO authority FROM engineering_recoveries
    WHERE recovery_id = NEW.recovery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'engineering recovery event has no recovery authority'
      USING ERRCODE = 'P0103';
  END IF;
  IF NEW.event_type = 'ENQUEUED' THEN
    IF NEW.authority_job_id IS NOT NULL OR NEW.authority_fencing_token IS NOT NULL THEN
      RAISE EXCEPTION 'engineering recovery ENQUEUED event must be unfenced'
        USING ERRCODE = 'P0103';
    END IF;
  ELSIF NEW.event_type = 'CONTINUATION_CLAIMED' THEN
    IF NEW.authority_job_id IS DISTINCT FROM authority.source_job_id
       OR NEW.authority_fencing_token IS DISTINCT FROM authority.continuation_fencing_token THEN
      RAISE EXCEPTION 'engineering continuation event authority mismatch'
        USING ERRCODE = 'P0103';
    END IF;
  ELSIF NEW.authority_job_id IS DISTINCT FROM authority.recovery_job_id
     OR NEW.authority_fencing_token IS DISTINCT FROM authority.last_recovery_fencing_token THEN
    RAISE EXCEPTION 'engineering recovery event authority mismatch'
      USING ERRCODE = 'P0103';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engineering_recovery_events_guard_insert
  BEFORE INSERT ON engineering_recovery_events
  FOR EACH ROW EXECUTE FUNCTION ra_guard_engineering_recovery_event();

-- Recovery jobs are case-less, code-owned and structurally unable to carry
-- writer scope. The trigger also freezes that shape after insertion.
CREATE FUNCTION ra_jsonb_object_key_count(value jsonb) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS 'SELECT count(*)::integer FROM jsonb_object_keys(value)';

ALTER TABLE jobs ADD CONSTRAINT jobs_engineering_recovery_shape_check CHECK (
  job_type <> 'agent.engineering_recovery'
  OR (
    case_id IS NULL AND provider IS NULL
    AND serialization_key = 'engineering-recovery:' || (payload->>'recoveryId')
    AND jsonb_typeof(payload) = 'object'
    AND ra_jsonb_object_key_count(payload) = 8
    AND payload->>'reason' = 'engineering_recovery'
    AND length(btrim(payload->>'recoveryId')) BETWEEN 1 AND 512
    AND length(btrim(payload->>'sourceJobId')) BETWEEN 1 AND 512
    AND (payload->>'sourceFencingToken') ~ '^[1-9][0-9]*$'
    AND length(btrim(payload->>'caseId')) BETWEEN 1 AND 512
    AND length(btrim(payload->>'workUnitId')) BETWEEN 1 AND 512
    AND length(btrim(payload->>'runId')) BETWEEN 1 AND 512
    AND (payload->>'checkpointRevision') ~ '^(0|[1-9][0-9]*)$'
  )
);

CREATE OR REPLACE FUNCTION ra_guard_engineering_recovery_job() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.job_type = 'agent.engineering_recovery'
    OR NEW.job_type = 'agent.engineering_recovery'
  ) AND (
    NEW.job_type IS DISTINCT FROM OLD.job_type
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.serialization_key IS DISTINCT FROM OLD.serialization_key
  ) THEN
    RAISE EXCEPTION 'engineering recovery job % authority is immutable', OLD.job_id
      USING ERRCODE = 'P0103';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engineering_recovery_job_guard
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION ra_guard_engineering_recovery_job();

CREATE OR REPLACE FUNCTION ra_guard_engineering_recovery() RETURNS trigger AS $$
BEGIN
  IF NEW.recovery_id IS DISTINCT FROM OLD.recovery_id
     OR NEW.root_recovery_id IS DISTINCT FROM OLD.root_recovery_id
     OR NEW.parent_recovery_id IS DISTINCT FROM OLD.parent_recovery_id
     OR NEW.source_job_id IS DISTINCT FROM OLD.source_job_id
     OR NEW.source_fencing_token IS DISTINCT FROM OLD.source_fencing_token
     OR NEW.recovery_job_id IS DISTINCT FROM OLD.recovery_job_id
     OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.approval_id IS DISTINCT FROM OLD.approval_id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.checkpoint_revision IS DISTINCT FROM OLD.checkpoint_revision
     OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.source_payload_digest IS DISTINCT FROM OLD.source_payload_digest
     OR NEW.workflow_deadline_at IS DISTINCT FROM OLD.workflow_deadline_at
     OR NEW.source_operation_id IS DISTINCT FROM OLD.source_operation_id
     OR NEW.source_intent_id IS DISTINCT FROM OLD.source_intent_id
     OR NEW.source_stage IS DISTINCT FROM OLD.source_stage
     OR NEW.source_stage_attempt IS DISTINCT FROM OLD.source_stage_attempt
     OR NEW.source_effect_class IS DISTINCT FROM OLD.source_effect_class
     OR NEW.source_input_digest IS DISTINCT FROM OLD.source_input_digest
     OR NEW.source_config_digest IS DISTINCT FROM OLD.source_config_digest
     OR NEW.source_schema_digest IS DISTINCT FROM OLD.source_schema_digest
     OR NEW.source_scope_digest IS DISTINCT FROM OLD.source_scope_digest
     OR NEW.source_deadline_at IS DISTINCT FROM OLD.source_deadline_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'engineering recovery % authority is immutable', OLD.recovery_id
      USING ERRCODE = 'P0103';
  END IF;

  IF NEW.last_recovery_fencing_token < OLD.last_recovery_fencing_token THEN
    RAISE EXCEPTION 'engineering recovery % fencing token cannot decrease', OLD.recovery_id
      USING ERRCODE = 'P0110';
  END IF;

  IF OLD.status = 'LEASED'
     AND NEW.status IN ('RECOVERY_PENDING', 'AMBIGUOUS', 'BLOCKED', 'CANCELLED')
     AND (OLD.plan IS NULL OR OLD.plan_digest IS NULL
       OR NEW.plan IS DISTINCT FROM OLD.plan
       OR NEW.plan_digest IS DISTINCT FROM OLD.plan_digest) THEN
    RAISE EXCEPTION 'engineering recovery % terminal transition lacks its bound plan',
      OLD.recovery_id USING ERRCODE = 'P0103';
  END IF;

  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status = 'LEASED')
    OR (OLD.status = 'LEASED' AND NEW.status = 'LEASED'
      AND OLD.plan IS NULL AND OLD.plan_digest IS NULL
      AND NEW.plan IS NOT NULL AND NEW.plan_digest IS NOT NULL
      AND NEW.last_recovery_fencing_token = OLD.last_recovery_fencing_token)
    OR (OLD.status = 'LEASED' AND NEW.status = 'PENDING'
      AND NEW.plan IS NULL AND NEW.plan_digest IS NULL)
    OR (OLD.status = 'LEASED' AND NEW.status IN (
      'RECOVERY_PENDING', 'AMBIGUOUS', 'BLOCKED', 'CANCELLED'))
    OR (OLD.status = 'RECOVERY_PENDING' AND NEW.status = 'CONTINUED')
  ) THEN
    RAISE EXCEPTION 'engineering recovery % illegal transition % -> %',
      OLD.recovery_id, OLD.status, NEW.status USING ERRCODE = 'P0103';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ra_validate_engineering_recovery_insert() RETURNS trigger AS $$
DECLARE
  source jobs%ROWTYPE;
  recovery_job jobs%ROWTYPE;
  prior engineering_recoveries%ROWTYPE;
BEGIN
  SELECT * INTO source FROM jobs WHERE job_id = NEW.source_job_id FOR SHARE;
  IF NOT FOUND OR source.status <> 'RECONCILING'
     OR source.job_type <> 'agent.implementer'
     OR source.fencing_token <> NEW.source_fencing_token
     OR source.case_id IS DISTINCT FROM NEW.case_id
     OR source.payload->>'reason' <> 'engineering_approval' THEN
    RAISE EXCEPTION 'engineering recovery source fence is not exact'
      USING ERRCODE = 'P0103';
  END IF;

  SELECT * INTO recovery_job FROM jobs WHERE job_id = NEW.recovery_job_id FOR SHARE;
  IF NOT FOUND OR recovery_job.status <> 'PENDING'
     OR recovery_job.job_type <> 'agent.engineering_recovery'
     OR recovery_job.fencing_token <> 0
     OR recovery_job.case_id IS NOT NULL
     OR recovery_job.payload->>'recoveryId' IS DISTINCT FROM NEW.recovery_id
     OR recovery_job.payload->>'sourceJobId' IS DISTINCT FROM NEW.source_job_id
     OR (recovery_job.payload->>'sourceFencingToken')::bigint <> NEW.source_fencing_token
     OR recovery_job.payload->>'caseId' IS DISTINCT FROM NEW.case_id
     OR recovery_job.payload->>'workUnitId' IS DISTINCT FROM NEW.work_unit_id
     OR recovery_job.payload->>'runId' IS DISTINCT FROM NEW.run_id
     OR (recovery_job.payload->>'checkpointRevision')::integer <> NEW.checkpoint_revision THEN
    RAISE EXCEPTION 'engineering recovery job binding is not exact'
      USING ERRCODE = 'P0103';
  END IF;

  SELECT * INTO prior FROM engineering_recoveries
    WHERE source_job_id = NEW.source_job_id
    ORDER BY created_at DESC, recovery_id DESC LIMIT 1;
  IF FOUND AND (
    NEW.parent_recovery_id IS DISTINCT FROM prior.recovery_id
    OR NEW.root_recovery_id IS DISTINCT FROM prior.root_recovery_id
    OR NEW.workflow_deadline_at IS DISTINCT FROM prior.workflow_deadline_at
  ) THEN
    RAISE EXCEPTION 'engineering recovery predecessor binding is not exact'
      USING ERRCODE = 'P0103';
  ELSIF NOT FOUND AND (
    NEW.parent_recovery_id IS NOT NULL OR NEW.root_recovery_id <> NEW.recovery_id
  ) THEN
    RAISE EXCEPTION 'engineering recovery root binding is not exact'
      USING ERRCODE = 'P0103';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engineering_recoveries_guard_insert
  BEFORE INSERT ON engineering_recoveries
  FOR EACH ROW EXECUTE FUNCTION ra_validate_engineering_recovery_insert();

CREATE TRIGGER engineering_recoveries_guard_update
  BEFORE UPDATE ON engineering_recoveries
  FOR EACH ROW EXECUTE FUNCTION ra_guard_engineering_recovery();

CREATE TRIGGER engineering_recoveries_no_delete
  BEFORE DELETE ON engineering_recoveries
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TRIGGER engineering_recoveries_touch_updated_at
  BEFORE UPDATE ON engineering_recoveries
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
