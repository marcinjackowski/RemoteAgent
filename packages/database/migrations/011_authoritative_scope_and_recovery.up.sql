-- RA-003 migration 011 (up): make case_connections the authoritative, tamper-proof
-- per-case connection allowlist and close the recovery / approval-digest scope
-- edges that AUDIT-03 reproduced. Additive over migration 010 (ADR-0002).
--
-- Enforced deterministically in the database (AGENTS.md §6):
--   1. external_entities and external_actions may only use a connection that is a
--      MEMBER of the case's connection allowlist (case_connections), not merely a
--      same-owner connection.
--   2. case_connections cannot be desynchronized from the JSON scope by ordinary
--      DML: a guard trigger rejects any INSERT/UPDATE/DELETE that does not originate
--      from the case sync trigger (detected via pg_trigger_depth(), which an
--      ordinary client cannot spoof — a top-level statement runs the guard at
--      depth 1, while the sync trigger's nested DML runs it deeper).
--   3. recovery pointers are owner/case bound: cases.active_run_id → same case;
--      agent_runs.trigger_event_id and case_checkpoints.last_event_id → an event of
--      the case's OWNER, and the denormalized owner_id used for that binding is
--      itself pinned to the case (so a caller cannot lie about owner_id).
--   4. an approved external_action is bound to the EXACT approval + case +
--      action_digest, so an approval for one digest cannot authorize another.
--   5. cases.integration_scope must satisfy the runtime contract shape (closed key
--      set, nonempty & bounded arrays, allowed providers, string elements).
--
-- The migration validates all existing rows and aborts atomically (each migration
-- runs in one transaction) if any legacy row violates a new invariant.

-- ---------------------------------------------------------------------------
-- 0. Supporting UNIQUE keys for the new composite foreign keys.
-- ---------------------------------------------------------------------------
-- Bind events to their owner by FK.
ALTER TABLE events
  ADD CONSTRAINT events_id_owner_key UNIQUE (event_id, owner_id);

-- Bind an approval to case + exact digest.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_id_case_digest_key UNIQUE (approval_id, case_id, action_digest);

-- case_connections primary key (case_id, connection_id) is already the unique
-- target used by the membership FKs below.

-- ---------------------------------------------------------------------------
-- 1. case_connections is tamper-proof: only the sync trigger may mutate it.
--    pg_trigger_depth() = 0 for a direct client statement's BEFORE-row guard is
--    actually 1 (the guard trigger itself); the sync trigger's nested DML makes
--    the guard fire at depth >= 2. So "guard depth <= 1" == "not from sync".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ra_guard_case_connections() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION
      'case_connections is maintained only via the case integration_scope sync; '
      'direct % is not permitted', TG_OP
      USING ERRCODE = 'P0102';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER case_connections_guard
  BEFORE INSERT OR UPDATE OR DELETE ON case_connections
  FOR EACH ROW EXECUTE FUNCTION ra_guard_case_connections();

-- ---------------------------------------------------------------------------
-- 2. external_entities / external_actions must reference a connection that is a
--    MEMBER of the case allowlist. case_connections already binds membership to
--    (case, owner, connection, provider), so this closes the same-owner-but-out-
--    of-scope hole and reuses the durable reverse guards from migration 010.
-- ---------------------------------------------------------------------------
ALTER TABLE external_entities
  ADD CONSTRAINT external_entities_case_connection_member_fk
  FOREIGN KEY (case_id, connection_id)
  REFERENCES case_connections (case_id, connection_id) ON DELETE RESTRICT;

ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_case_connection_member_fk
  FOREIGN KEY (case_id, connection_id)
  REFERENCES case_connections (case_id, connection_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Recovery pointers.
-- ---------------------------------------------------------------------------
-- 3a. active_run_id must be a run of the SAME case (nullable: MATCH SIMPLE).
ALTER TABLE cases
  ADD CONSTRAINT cases_active_run_case_fk
  FOREIGN KEY (active_run_id, case_id) REFERENCES agent_runs (run_id, case_id) ON DELETE RESTRICT;

-- 3b. agent_runs.trigger_event_id must be an event of the case's OWNER. Denormalize
--     owner_id and PIN it to the case via (case_id, owner_id) → cases, so a caller
--     cannot forge owner_id to smuggle a cross-owner event.
ALTER TABLE agent_runs ADD COLUMN owner_id text;
UPDATE agent_runs r SET owner_id = c.owner_id FROM cases c WHERE r.case_id = c.case_id;
ALTER TABLE agent_runs ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_case_owner_fk
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT;
-- Replace the plain event FK with an owner-scoped one.
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_trigger_event_id_fkey;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_trigger_event_owner_fk
  FOREIGN KEY (trigger_event_id, owner_id) REFERENCES events (event_id, owner_id) ON DELETE RESTRICT;

-- 3c. case_checkpoints.last_event_id must be an event of the case's OWNER. Same
--     denormalize-and-pin pattern. case_checkpoints is append-only (a BEFORE
--     UPDATE/DELETE trigger raises P0100), so the one-time backfill UPDATE must
--     temporarily drop that guard and recreate it before the migration ends. This
--     happens inside the migration's single transaction, so an abort rolls the
--     drop back automatically and the ledger is never left unguarded on failure.
ALTER TABLE case_checkpoints ADD COLUMN owner_id text;
DROP TRIGGER case_checkpoints_append_only ON case_checkpoints;
UPDATE case_checkpoints k SET owner_id = c.owner_id FROM cases c WHERE k.case_id = c.case_id;
CREATE TRIGGER case_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON case_checkpoints
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
ALTER TABLE case_checkpoints ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE case_checkpoints
  ADD CONSTRAINT case_checkpoints_case_owner_fk
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT;
ALTER TABLE case_checkpoints DROP CONSTRAINT case_checkpoints_last_event_id_fkey;
ALTER TABLE case_checkpoints
  ADD CONSTRAINT case_checkpoints_last_event_owner_fk
  FOREIGN KEY (last_event_id, owner_id) REFERENCES events (event_id, owner_id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. Approval bound to exact (approval_id, case_id, action_digest).
--    Replaces migration 010's (approval_id, case_id) FK.
-- ---------------------------------------------------------------------------
ALTER TABLE external_actions DROP CONSTRAINT external_actions_approval_case_fk;
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_approval_case_digest_fk
  FOREIGN KEY (approval_id, case_id, action_digest)
  REFERENCES approvals (approval_id, case_id, action_digest) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 5. integration_scope runtime contract shape, enforced in the DB (closed key
--    set, nonempty & bounded arrays, allowed providers, string elements). Mirrors
--    packages/contracts/src/case.ts (providers 1..16, connection_ids 1..64).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ra_validate_integration_scope(scope jsonb, case_id text)
  RETURNS void AS $$
DECLARE
  provs jsonb := scope -> 'providers';
  conns jsonb := scope -> 'connection_ids';
  k     text;
BEGIN
  IF scope IS NULL OR jsonb_typeof(scope) <> 'object' THEN
    RAISE EXCEPTION 'integration_scope for case % must be a JSON object', case_id
      USING ERRCODE = 'P0101';
  END IF;
  -- Closed key set: exactly {providers, connection_ids}.
  FOR k IN SELECT jsonb_object_keys(scope) LOOP
    IF k NOT IN ('providers', 'connection_ids') THEN
      RAISE EXCEPTION 'integration_scope for case % has unexpected key %', case_id, k
        USING ERRCODE = 'P0101';
    END IF;
  END LOOP;
  IF provs IS NULL OR jsonb_typeof(provs) <> 'array'
     OR conns IS NULL OR jsonb_typeof(conns) <> 'array' THEN
    RAISE EXCEPTION 'integration_scope for case % must have providers[] and connection_ids[]', case_id
      USING ERRCODE = 'P0101';
  END IF;
  -- Nonempty & bounded per the contract (providers 1..16, connection_ids 1..64).
  IF jsonb_array_length(provs) < 1 OR jsonb_array_length(provs) > 16 THEN
    RAISE EXCEPTION 'integration_scope providers for case % must have 1..16 items', case_id
      USING ERRCODE = 'P0101';
  END IF;
  IF jsonb_array_length(conns) < 1 OR jsonb_array_length(conns) > 64 THEN
    RAISE EXCEPTION 'integration_scope connection_ids for case % must have 1..64 items', case_id
      USING ERRCODE = 'P0101';
  END IF;
  -- providers[] elements must be strings from the closed provider set.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(provs) e
    WHERE jsonb_typeof(e) <> 'string'
       OR (e #>> '{}') NOT IN ('jira', 'gmail', 'calendar', 'gitlab', 'discord')
  ) THEN
    RAISE EXCEPTION 'integration_scope providers for case % contains an invalid provider', case_id
      USING ERRCODE = 'P0101';
  END IF;
  -- connection_ids[] elements must be non-empty strings.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(conns) e
    WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') = 0
  ) THEN
    RAISE EXCEPTION 'integration_scope connection_ids for case % contains a non-string/empty id', case_id
      USING ERRCODE = 'P0101';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Fold the shape validation into the existing sync function so a single trigger
-- both validates the contract shape AND rebuilds the authoritative membership.
CREATE OR REPLACE FUNCTION ra_sync_case_connections() RETURNS trigger AS $$
DECLARE
  scope_provs jsonb;
  scope_conns jsonb;
  conn_id     text;
  conn_prov   text;
BEGIN
  -- Contract shape first (closed keys, bounds, allowed providers, element types).
  PERFORM ra_validate_integration_scope(NEW.integration_scope, NEW.case_id);
  scope_provs := NEW.integration_scope -> 'providers';
  scope_conns := NEW.integration_scope -> 'connection_ids';

  -- Rebuild this case's membership rows (nested DML: passes the depth guard).
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

-- Validate all existing case scopes against the contract shape; abort on the
-- first violation (whole migration is transactional).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT case_id, integration_scope FROM cases LOOP
    PERFORM ra_validate_integration_scope(r.integration_scope, r.case_id);
  END LOOP;
END;
$$;
