-- RA-003 migration 010 (up): close ALL scoped referential edges deterministically
-- and durably, in the database (AGENTS.md §6 / Master Plan §3.2: the model/app is
-- NOT the authorization layer). This supersedes the JSON-only scope trigger of the
-- previous 010 draft (AUDIT-02 HIGH-01/HIGH-02).
--
-- What this migration guarantees, all enforced by composite UNIQUE keys +
-- foreign keys (deterministic, and durable across later parent mutations):
--
--   1. case integration scope is normalized into case_connections, whose FK binds
--      (connection_id, owner_id, provider) to the real connection. A case can only
--      reference connections of its OWN owner whose provider is declared in the
--      scope, and — because the rows persist with ON DELETE/UPDATE RESTRICT — a
--      later `UPDATE connections SET owner_id/provider` or `DELETE connection`
--      that would orphan a case scope is REJECTED. The upgrade itself backfills
--      case_connections from existing JSON scopes, so a pre-existing invalid scope
--      makes the whole (transactional) migration abort.
--   2. raw_events, events and external_entities bind (connection_id, provider) to
--      the connection, so a row's provider must match its connection's provider
--      (no cross-provider provenance/routing).
--   3. a normalized event's raw_event_id shares owner+connection+provider with the
--      raw event it points to.
--   4. external_actions.connection belongs to the case's owner; its approval, when
--      set, belongs to the SAME case.
--   5. run_intents / run_completions / artifacts / reviews reference the SAME case
--      as their run.
--   6. a checkpoint's last_run_id (when set) belongs to the checkpoint's own case;
--      a decision_answer's decision belongs to the answer's own case.

-- ---------------------------------------------------------------------------
-- 0. Supporting UNIQUE keys on parent tables.
-- ---------------------------------------------------------------------------
-- Lets children bind the full (connection, owner, provider) tuple by FK.
ALTER TABLE connections
  ADD CONSTRAINT connections_id_owner_provider_key
  UNIQUE (connection_id, owner_id, provider);

-- Lets events bind the full raw provenance tuple by FK.
ALTER TABLE raw_events
  ADD CONSTRAINT raw_events_provenance_key
  UNIQUE (raw_event_id, provider, connection_id, owner_id);

-- Lets run children bind (run_id, case_id) by FK.
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_run_case_key
  UNIQUE (run_id, case_id);

-- Lets a checkpoint bind (last_run_id, case_id) to a run of its own case.
-- (agent_runs_run_case_key above already provides the referenced unique tuple.)

-- Lets a decision_answer bind (decision_id, case_id) to a decision of its case.
ALTER TABLE decisions
  ADD CONSTRAINT decisions_id_case_key
  UNIQUE (decision_id, case_id);

-- Lets approvals be referenced together with their case.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_approval_case_key
  UNIQUE (approval_id, case_id);

-- ---------------------------------------------------------------------------
-- 1. Provider ↔ connection binding for raw_events / events / external_entities.
--    Each already stores provider + connection_id + owner_id; replace the plain
--    (connection_id, owner_id) FK with one that also pins provider.
-- ---------------------------------------------------------------------------
ALTER TABLE raw_events DROP CONSTRAINT raw_events_connection_id_owner_id_fkey;
ALTER TABLE raw_events
  ADD CONSTRAINT raw_events_connection_provider_fk
  FOREIGN KEY (connection_id, owner_id, provider)
  REFERENCES connections (connection_id, owner_id, provider)
  ON DELETE RESTRICT;

ALTER TABLE events DROP CONSTRAINT events_connection_id_owner_id_fkey;
ALTER TABLE events
  ADD CONSTRAINT events_connection_provider_fk
  FOREIGN KEY (connection_id, owner_id, provider)
  REFERENCES connections (connection_id, owner_id, provider)
  ON DELETE RESTRICT;

-- 1b. raw -> normalized event provenance: same owner + connection + provider.
--     events.raw_event_id is optional (MATCH SIMPLE: unchecked when NULL).
ALTER TABLE events DROP CONSTRAINT events_raw_event_id_fkey;
ALTER TABLE events
  ADD CONSTRAINT events_raw_event_provenance_fk
  FOREIGN KEY (raw_event_id, provider, connection_id, owner_id)
  REFERENCES raw_events (raw_event_id, provider, connection_id, owner_id)
  ON DELETE RESTRICT;

-- external_entities already binds (case_id, owner_id) and (connection_id, owner_id);
-- tighten the connection FK so provider must match too.
ALTER TABLE external_entities DROP CONSTRAINT external_entities_connection_id_owner_id_fkey;
ALTER TABLE external_entities
  ADD CONSTRAINT external_entities_connection_provider_fk
  FOREIGN KEY (connection_id, owner_id, provider)
  REFERENCES connections (connection_id, owner_id, provider)
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. run children must share their run's case.
-- ---------------------------------------------------------------------------
ALTER TABLE run_intents DROP CONSTRAINT run_intents_run_id_fkey;
ALTER TABLE run_intents
  ADD CONSTRAINT run_intents_run_case_fk
  FOREIGN KEY (run_id, case_id) REFERENCES agent_runs (run_id, case_id) ON DELETE RESTRICT;

ALTER TABLE run_completions DROP CONSTRAINT run_completions_run_id_fkey;
ALTER TABLE run_completions
  ADD CONSTRAINT run_completions_run_case_fk
  FOREIGN KEY (run_id, case_id) REFERENCES agent_runs (run_id, case_id) ON DELETE RESTRICT;

ALTER TABLE artifacts DROP CONSTRAINT artifacts_run_id_fkey;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_run_case_fk
  FOREIGN KEY (run_id, case_id) REFERENCES agent_runs (run_id, case_id) ON DELETE RESTRICT;

ALTER TABLE reviews DROP CONSTRAINT reviews_run_id_fkey;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_run_case_fk
  FOREIGN KEY (run_id, case_id) REFERENCES agent_runs (run_id, case_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. checkpoint.last_run_id (when set) must belong to the checkpoint's own case;
--    decision_answer.decision_id must belong to the answer's own case.
--    Both run_id/last_run_id columns are nullable (MATCH SIMPLE handles NULL).
-- ---------------------------------------------------------------------------
ALTER TABLE case_checkpoints DROP CONSTRAINT case_checkpoints_last_run_id_fkey;
ALTER TABLE case_checkpoints
  ADD CONSTRAINT case_checkpoints_last_run_case_fk
  FOREIGN KEY (last_run_id, case_id) REFERENCES agent_runs (run_id, case_id) ON DELETE RESTRICT;

ALTER TABLE decision_answers DROP CONSTRAINT decision_answers_decision_id_fkey;
ALTER TABLE decision_answers
  ADD CONSTRAINT decision_answers_decision_case_fk
  FOREIGN KEY (decision_id, case_id) REFERENCES decisions (decision_id, case_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. external_actions: connection belongs to the case's owner; approval (when
--    set) belongs to the SAME case. Denormalize owner_id so both the case FK and
--    the connection FK share it (same trick migration 003 uses for entities).
-- ---------------------------------------------------------------------------
ALTER TABLE external_actions ADD COLUMN owner_id text;
UPDATE external_actions a SET owner_id = c.owner_id FROM cases c WHERE a.case_id = c.case_id;
ALTER TABLE external_actions ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE external_actions DROP CONSTRAINT external_actions_case_id_fkey;
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_case_owner_fk
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT;

ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_connection_owner_fk
  FOREIGN KEY (connection_id, owner_id) REFERENCES connections (connection_id, owner_id) ON DELETE RESTRICT;

ALTER TABLE external_actions DROP CONSTRAINT external_actions_approval_fk;
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_approval_case_fk
  FOREIGN KEY (approval_id, case_id) REFERENCES approvals (approval_id, case_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 5. Normalized case ↔ connection scope (the durable heart of HIGH-01).
--    integration_scope stays as the JSON contract projection, but the authoritative
--    edge lives in case_connections, whose composite FK to
--    connections(connection_id, owner_id, provider) enforces owner + provider and,
--    via ON DELETE/UPDATE RESTRICT, blocks any later parent mutation that would
--    orphan a case scope. A constraint trigger keeps the table in lock-step with
--    the JSON and rejects providers not declared in scope.providers.
-- ---------------------------------------------------------------------------
CREATE TABLE case_connections (
  case_id       text NOT NULL,
  owner_id      text NOT NULL,
  connection_id text NOT NULL,
  provider      text NOT NULL,
  PRIMARY KEY (case_id, connection_id),
  -- The case must own this membership...
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT,
  -- ...and the connection must belong to that same owner AND have this provider.
  -- ON DELETE/UPDATE RESTRICT makes the reverse edge durable: a referenced
  -- connection cannot change owner/provider or be deleted while a case uses it.
  FOREIGN KEY (connection_id, owner_id, provider)
    REFERENCES connections (connection_id, owner_id, provider)
);

CREATE INDEX case_connections_connection_idx ON case_connections (connection_id);

-- Rebuild the case_connections rows for a case from its JSON integration_scope,
-- validating provider membership. The composite FK above does the owner/provider/
-- existence enforcement; this function adds provider-in-scope and syncs the rows.
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

  -- Replace this case's membership rows.
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
    -- The composite FK enforces owner match + provider match + existence.
    INSERT INTO case_connections (case_id, owner_id, connection_id, provider)
      VALUES (NEW.case_id, NEW.owner_id, conn_id, conn_prov);
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER trigger so the case row already exists for the (case_id, owner_id) FK.
CREATE CONSTRAINT TRIGGER cases_sync_connections
  AFTER INSERT OR UPDATE OF integration_scope, owner_id ON cases
  FOR EACH ROW EXECUTE FUNCTION ra_sync_case_connections();

-- Backfill existing cases. Any pre-existing invalid scope (foreign/unknown
-- connection or provider mismatch) makes an INSERT fail, aborting the whole
-- transactional migration (AUDIT-02 HIGH-01: validate existing data on upgrade).
DO $$
DECLARE
  r record;
  conn_id   text;
  conn_prov text;
  scope_provs jsonb;
BEGIN
  FOR r IN SELECT case_id, owner_id, integration_scope FROM cases LOOP
    scope_provs := r.integration_scope -> 'providers';
    FOR conn_id IN
      SELECT DISTINCT jsonb_array_elements_text(r.integration_scope -> 'connection_ids')
    LOOP
      SELECT provider INTO conn_prov FROM connections WHERE connection_id = conn_id;
      IF conn_prov IS NULL THEN
        RAISE EXCEPTION 'upgrade: case % scope references unknown connection %',
          r.case_id, conn_id USING ERRCODE = 'P0101';
      END IF;
      IF NOT (scope_provs @> to_jsonb(conn_prov)) THEN
        RAISE EXCEPTION 'upgrade: case % scope connection % provider % not in providers',
          r.case_id, conn_id, conn_prov USING ERRCODE = 'P0101';
      END IF;
      INSERT INTO case_connections (case_id, owner_id, connection_id, provider)
        VALUES (r.case_id, r.owner_id, conn_id, conn_prov);
    END LOOP;
  END LOOP;
END;
$$;
