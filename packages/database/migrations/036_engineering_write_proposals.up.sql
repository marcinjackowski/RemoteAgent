-- RA-046: server-owned engineering write proposals.
--
-- This table is proposal state, not a second approval journal.  The existing
-- `approvals` table remains the only durable grant authority.  A proposal binds
-- the exact identities and deployment write ceiling before Discord renders any
-- button; materialized work/run/job references remain NULL until one atomic
-- GRANT transaction creates them.

ALTER TABLE approvals
  ADD CONSTRAINT approvals_engineering_scope_key
  UNIQUE (approval_id, case_id, owner_id, action_digest, checkpoint_revision);

-- One global idempotency namespace for every Discord interaction. Keeping trigger
-- and terminal ids in two independently-unique proposal columns would still allow
-- the same provider id to be a trigger in one case and a GRANT in another.
CREATE TABLE engineering_ingress_interactions (
  interaction_id       text        PRIMARY KEY,
  case_id               text        NOT NULL,
  owner_id              text        NOT NULL,
  proposal_id           text,
  checkpoint_revision   integer     NOT NULL CHECK (checkpoint_revision >= 0),
  interaction_kind      text        NOT NULL CHECK (interaction_kind IN (
                           'PROPOSE', 'GRANT', 'DENY', 'STOP', 'EXPIRE')),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, owner_id)
    REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT,
  CHECK (interaction_kind = 'STOP' OR proposal_id IS NOT NULL),
  UNIQUE (
    interaction_id, case_id, owner_id, proposal_id, checkpoint_revision, interaction_kind)
);

CREATE TRIGGER engineering_ingress_interactions_append_only
  BEFORE UPDATE OR DELETE ON engineering_ingress_interactions
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TABLE engineering_write_proposals (
  schema_version            integer     NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  proposal_id               text        PRIMARY KEY,
  trigger_interaction_id    text        NOT NULL UNIQUE,
  case_id                   text        NOT NULL,
  owner_id                  text        NOT NULL,
  checkpoint_revision       integer     NOT NULL CHECK (checkpoint_revision >= 0),
  work_unit_id              text        NOT NULL UNIQUE,
  run_id                    text        NOT NULL UNIQUE,
  process_class             text        NOT NULL CHECK (process_class IN (
                               'SMALL', 'MEDIUM', 'LARGE_OR_HIGH_RISK')),
  objective                 text        NOT NULL CHECK (length(btrim(objective)) > 0),
  repository_id             text        NOT NULL CHECK (length(btrim(repository_id)) > 0),
  write_path_allowlist      jsonb       NOT NULL CHECK (
                               jsonb_typeof(write_path_allowlist) = 'array'
                               AND jsonb_array_length(write_path_allowlist) BETWEEN 1 AND 256),
  authoritative_scope       jsonb       NOT NULL CHECK (
                               jsonb_typeof(authoritative_scope) = 'object'
                               AND authoritative_scope->>'can_write_workspace' = 'true'
                               AND jsonb_typeof(authoritative_scope->'connection_ids') = 'array'
                               AND jsonb_typeof(authoritative_scope->'repo_allowlist') = 'array'),
  deployment_policy_digest  text        NOT NULL CHECK (
                               deployment_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  action_digest             text        NOT NULL CHECK (
                               action_digest ~ '^sha256:[0-9a-f]{64}$'),
  expires_at                timestamptz NOT NULL,
  status                    text        NOT NULL DEFAULT 'PENDING' CHECK (status IN (
                               'PENDING', 'GRANTED', 'DENIED', 'STOPPED', 'EXPIRED')),
  terminal_interaction_id   text        UNIQUE,
  terminal_choice           text        CHECK (terminal_choice IN (
                               'GRANT', 'DENY', 'STOP', 'EXPIRE')),
  terminal_actor_id         text,
  approval_id               text        UNIQUE,
  job_id                    text        UNIQUE,
  discord_outbox_id         text        NOT NULL UNIQUE
                               REFERENCES outbox (outbox_id) ON DELETE RESTRICT,
  discord_seq               bigint      NOT NULL CHECK (discord_seq >= 1),
  created_at                timestamptz NOT NULL DEFAULT now(),
  terminal_at               timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  trigger_interaction_kind  text        GENERATED ALWAYS AS ('PROPOSE') STORED,
  terminal_interaction_kind text        GENERATED ALWAYS AS (terminal_choice) STORED,
  FOREIGN KEY (case_id, owner_id)
    REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    trigger_interaction_id, case_id, owner_id, proposal_id, checkpoint_revision,
    trigger_interaction_kind)
    REFERENCES engineering_ingress_interactions (
      interaction_id, case_id, owner_id, proposal_id, checkpoint_revision, interaction_kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (
    terminal_interaction_id, case_id, owner_id, proposal_id, checkpoint_revision,
    terminal_interaction_kind)
    REFERENCES engineering_ingress_interactions (
      interaction_id, case_id, owner_id, proposal_id, checkpoint_revision, interaction_kind)
    ON DELETE RESTRICT,
  FOREIGN KEY (approval_id, case_id, owner_id, action_digest, checkpoint_revision)
    REFERENCES approvals (
      approval_id, case_id, owner_id, action_digest, checkpoint_revision)
    ON DELETE RESTRICT,
  FOREIGN KEY (job_id, case_id)
    REFERENCES jobs (job_id, case_id) ON DELETE RESTRICT,
  UNIQUE (case_id, discord_seq),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'PENDING'
      AND terminal_interaction_id IS NULL AND terminal_choice IS NULL
      AND terminal_actor_id IS NULL AND terminal_at IS NULL
      AND approval_id IS NULL AND job_id IS NULL)
    OR
    (status = 'GRANTED'
      AND terminal_interaction_id IS NOT NULL AND terminal_choice = 'GRANT'
      AND terminal_actor_id IS NOT NULL AND terminal_at IS NOT NULL
      AND approval_id IS NOT NULL AND job_id IS NOT NULL)
    OR
    (status = 'DENIED'
      AND terminal_interaction_id IS NOT NULL AND terminal_choice = 'DENY'
      AND terminal_actor_id IS NOT NULL AND terminal_at IS NOT NULL
      AND approval_id IS NULL AND job_id IS NULL)
    OR
    (status = 'STOPPED'
      AND terminal_interaction_id IS NOT NULL AND terminal_choice = 'STOP'
      AND terminal_actor_id IS NOT NULL AND terminal_at IS NOT NULL
      AND approval_id IS NULL AND job_id IS NULL)
    OR
    (status = 'EXPIRED'
      AND terminal_interaction_id IS NOT NULL AND terminal_choice = 'EXPIRE'
      AND terminal_actor_id IS NOT NULL AND terminal_at IS NOT NULL
      AND approval_id IS NULL AND job_id IS NULL)
  )
);

CREATE UNIQUE INDEX engineering_write_proposals_pending_case_uidx
  ON engineering_write_proposals (case_id)
  WHERE status = 'PENDING';

CREATE INDEX engineering_write_proposals_case_created_idx
  ON engineering_write_proposals (case_id, created_at, proposal_id);

CREATE OR REPLACE FUNCTION ra_guard_engineering_write_proposal() RETURNS trigger AS $$
BEGIN
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
     OR NEW.trigger_interaction_id IS DISTINCT FROM OLD.trigger_interaction_id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.checkpoint_revision IS DISTINCT FROM OLD.checkpoint_revision
     OR NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id
     OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.process_class IS DISTINCT FROM OLD.process_class
     OR NEW.objective IS DISTINCT FROM OLD.objective
     OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
     OR NEW.write_path_allowlist IS DISTINCT FROM OLD.write_path_allowlist
     OR NEW.authoritative_scope IS DISTINCT FROM OLD.authoritative_scope
     OR NEW.deployment_policy_digest IS DISTINCT FROM OLD.deployment_policy_digest
     OR NEW.action_digest IS DISTINCT FROM OLD.action_digest
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.discord_outbox_id IS DISTINCT FROM OLD.discord_outbox_id
     OR NEW.discord_seq IS DISTINCT FROM OLD.discord_seq
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'engineering proposal % authority is immutable', OLD.proposal_id
      USING ERRCODE = 'P0103';
  END IF;

  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'engineering proposal % is already terminal', OLD.proposal_id
      USING ERRCODE = 'P0103';
  END IF;

  IF NEW.status = 'GRANTED' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM work_units w
        JOIN agent_runs r
          ON r.run_id = w.run_id
         AND r.work_unit_id = w.work_unit_id
         AND r.case_id = w.case_id
        JOIN jobs j
          ON j.job_id = NEW.job_id
         AND j.case_id = w.case_id
        JOIN approvals a
          ON a.approval_id = NEW.approval_id
         AND a.case_id = NEW.case_id
         AND a.owner_id = NEW.owner_id
         AND a.action_digest = NEW.action_digest
         AND a.checkpoint_revision = NEW.checkpoint_revision
        JOIN cases c
          ON c.case_id = NEW.case_id
         AND c.owner_id = NEW.owner_id
       WHERE w.work_unit_id = NEW.work_unit_id
         AND w.case_id = NEW.case_id
         AND w.run_id = NEW.run_id
         AND w.role = 'IMPLEMENTER'
         AND w.status = 'DISPATCHED'
         AND w.authoritative_scope = NEW.authoritative_scope
         AND r.owner_id = NEW.owner_id
         AND r.checkpoint_revision = NEW.checkpoint_revision
         AND r.role = 'IMPLEMENTER'
         AND r.safety_state = 'PLANNED'
         AND j.job_type = 'agent.implementer'
         AND j.status = 'PENDING'
         AND j.serialization_key = NEW.case_id
         AND j.provider IS NULL
         AND (SELECT count(*) FROM jsonb_object_keys(j.payload)) = 8
         AND j.payload->>'reason' = 'engineering_approval'
         AND j.payload->>'caseId' = NEW.case_id
         AND j.payload->>'workUnitId' = NEW.work_unit_id
         AND j.payload->>'runId' = NEW.run_id
         AND j.payload->>'repoId' = NEW.repository_id
         AND j.payload->>'approvalId' = NEW.approval_id
         AND j.payload->>'proposalId' = NEW.proposal_id
         AND j.payload->>'checkpointRevision' = NEW.checkpoint_revision::text
         AND a.granted_by = NEW.terminal_actor_id
         AND a.expires_at = NEW.expires_at
         AND a.consumed = false
         AND a.consumed_at IS NULL
         AND c.checkpoint_revision = NEW.checkpoint_revision
         AND c.active_run_id IS NULL
         AND c.status NOT IN ('DONE', 'CANCELLED')
    ) THEN
      RAISE EXCEPTION 'engineering proposal % materialization is incomplete', OLD.proposal_id
        USING ERRCODE = 'P0103';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engineering_write_proposals_guard_update
  BEFORE UPDATE ON engineering_write_proposals
  FOR EACH ROW EXECUTE FUNCTION ra_guard_engineering_write_proposal();

CREATE TRIGGER engineering_write_proposals_no_delete
  BEFORE DELETE ON engineering_write_proposals
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TRIGGER engineering_write_proposals_touch_updated_at
  BEFORE UPDATE ON engineering_write_proposals
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
