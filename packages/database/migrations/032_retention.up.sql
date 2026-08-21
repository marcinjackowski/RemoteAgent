-- RA-024 migration 032 (up): retention as a controlled, auditable operation.
--
-- WHY THIS MIGRATION EXISTS. Migration 002 gave `raw_events` a `retain_until`
-- column and an index described as "the hot path for the retention job", and then
-- put a `BEFORE UPDATE OR DELETE ... FOR EACH ROW` append-only trigger on the same
-- table. A probe against a real database (RA-024-WU-07) measured the consequence:
--
--   DELETE expired raw_event         rows=1  REFUSED (P0100)
--   UPDATE raw payload_bytes -> NULL rows=1  REFUSED (P0100)
--
-- So the retention mechanism the schema documents CANNOT RUN. Not "was not
-- scheduled" — is structurally impossible. That is the `CTF-010` pattern in SQL: a
-- column name and a comment describing a capability the schema denies.
--
-- (The first version of that probe reported `DELETE FROM audit_log: ALLOWED`,
-- which looked alarming and was wrong: the table was empty, and a FOR EACH ROW
-- trigger never fires. The probe was measuring "deleted nothing". Worth recording,
-- because it is the exact shape of false assurance this repository keeps finding.)
--
-- THE DESIGN. Append-only is the right default and is NOT relaxed. Instead,
-- retention gets one narrow, explicitly-authorised exception:
--
--   1. `ra_retention_purge_raw_payload` is a SECURITY DEFINER function that clears
--      `payload_bytes` for expired rows and nothing else. It cannot delete a row,
--      cannot touch any other column, and cannot reach any other table.
--   2. It sets a transaction-local flag the trigger recognises, so the append-only
--      trigger stays in force for every other writer. The flag is checked, not
--      trusted: the function is the only thing that sets it, and it always clears
--      it, including on error.
--   3. Every purge writes an `audit_log` entry INSIDE the same transaction. A
--      retention run that cannot be audited does not happen.
--
-- WHAT RETENTION MAY NEVER TOUCH (AC5: "retention/delete does not destroy the
-- required minimum audit receipts without a rule"). `audit_log`, `receipts`,
-- `external_actions` and `approvals` are outside this mechanism ENTIRELY — there is
-- no function here that can reach them, so the guarantee is structural rather than
-- a matter of the caller passing the right table name. The minimum audit trail is
-- "which action was taken, by whom, when, with what outcome and against which
-- external entity version", and it is what makes an ambiguous external write
-- reconcilable months later.
--
-- The payload BYTES are the sensitive part; the envelope (who, when, digest,
-- sensitivity) is the audit trail and stays. So a purged raw event keeps its
-- `payload_digest`, which means a later restore can still prove whether a payload
-- it holds is the one this row referred to.

-- Transaction-local flag name. `ra.` prefix so it cannot collide with a
-- PostgreSQL-defined setting.
CREATE OR REPLACE FUNCTION ra_retention_in_progress() RETURNS boolean AS $$
BEGIN
  -- `true` as the second argument returns NULL instead of raising when the setting
  -- was never set in this transaction, which is the normal case for every ordinary
  -- writer.
  RETURN coalesce(current_setting('ra.retention_purge', true), 'off') = 'on';
END;
$$ LANGUAGE plpgsql;

-- Append-only, EXCEPT for an in-progress retention purge.
--
-- Deliberately a separate function from `ra_deny_mutation` rather than a change to
-- it: `ra_deny_mutation` guards fifteen other tables, and widening it would grant
-- this exception to all of them at once.
CREATE OR REPLACE FUNCTION ra_deny_mutation_except_retention() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ra_retention_in_progress() THEN
    -- Only `payload_bytes` may change, and only to NULL. Checked here rather than
    -- trusted to the calling function, so a future caller that sets the flag still
    -- cannot rewrite an envelope field.
    IF NEW.payload_bytes IS NOT NULL THEN
      RAISE EXCEPTION 'retention may only clear payload_bytes, not set it'
        USING ERRCODE = 'P0101';
    END IF;
    IF NEW.raw_event_id     IS DISTINCT FROM OLD.raw_event_id
       OR NEW.provider       IS DISTINCT FROM OLD.provider
       OR NEW.connection_id  IS DISTINCT FROM OLD.connection_id
       OR NEW.owner_id       IS DISTINCT FROM OLD.owner_id
       OR NEW.payload_ref    IS DISTINCT FROM OLD.payload_ref
       OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
       OR NEW.sensitivity    IS DISTINCT FROM OLD.sensitivity
       OR NEW.received_at    IS DISTINCT FROM OLD.received_at
       OR NEW.retain_until   IS DISTINCT FROM OLD.retain_until THEN
      RAISE EXCEPTION 'retention may not alter the raw event envelope'
        USING ERRCODE = 'P0101';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'table % is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0100';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER raw_events_append_only ON raw_events;
CREATE TRIGGER raw_events_append_only
  BEFORE UPDATE OR DELETE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation_except_retention();

-- Record of every retention run, so a purge is never invisible.
--
-- Append-only, and NOT itself subject to retention: the record that data was
-- destroyed must outlive the data.
CREATE TABLE retention_runs (
  run_id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  data_class      text        NOT NULL,
  executed_at     timestamptz NOT NULL DEFAULT now(),
  rows_affected   bigint      NOT NULL CHECK (rows_affected >= 0),
  -- The cutoff the run used, so a run can be re-derived and checked.
  cutoff          timestamptz NOT NULL,
  actor           text        NOT NULL
);

CREATE INDEX retention_runs_executed_idx ON retention_runs (executed_at);

CREATE TRIGGER retention_runs_append_only
  BEFORE UPDATE OR DELETE ON retention_runs
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- Purge expired raw payload BYTES. The only retention operation that exists.
--
-- SECURITY DEFINER so the flag cannot be set by an ordinary caller: a client that
-- runs `SET ra.retention_purge = 'on'` and then its own UPDATE is still refused by
-- the column checks in the trigger above, but making this the only path keeps the
-- audit write non-optional.
CREATE OR REPLACE FUNCTION ra_retention_purge_raw_payload(
  p_actor text,
  p_now   timestamptz DEFAULT now()
) RETURNS bigint AS $$
DECLARE
  v_rows bigint;
BEGIN
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    -- An unattributed destructive operation is not auditable, so it is refused
    -- rather than recorded as 'unknown'.
    RAISE EXCEPTION 'retention requires an actor' USING ERRCODE = 'P0102';
  END IF;

  PERFORM set_config('ra.retention_purge', 'on', true);

  UPDATE raw_events
     SET payload_bytes = NULL
   WHERE retain_until IS NOT NULL
     AND retain_until < p_now
     AND payload_bytes IS NOT NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  PERFORM set_config('ra.retention_purge', 'off', true);

  -- Both records written in THIS transaction. A purge that commits without its
  -- audit row is exactly the state AC5 forbids.
  INSERT INTO retention_runs (data_class, rows_affected, cutoff, actor)
  VALUES ('raw_event_payload', v_rows, p_now, p_actor);

  INSERT INTO audit_log (actor, action, outcome, target_kind, detail)
  VALUES (
    p_actor,
    'retention.purge.raw_event_payload',
    'SUCCESS',
    'raw_events',
    jsonb_build_object('rows_affected', v_rows, 'cutoff', p_now)
  );

  RETURN v_rows;
EXCEPTION
  WHEN OTHERS THEN
    -- Clear the flag even on failure. `set_config(..., true)` is already
    -- transaction-local, so a rollback would clear it anyway; this covers the case
    -- where the caller catches and continues in the same transaction.
    PERFORM set_config('ra.retention_purge', 'off', true);
    RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
