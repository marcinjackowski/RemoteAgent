-- Fail closed: the previous schema cannot represent proposal provenance or the
-- global provider-interaction replay identity. Dropping either populated table
-- would strand a materialized writer job and make a provider replay look new.
-- NOWAIT also closes the check/drop race: a live ingress writer makes rollback
-- fail instead of allowing a row to commit between the emptiness check and DROP.
LOCK TABLE engineering_ingress_interactions, engineering_write_proposals
  IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM engineering_write_proposals) OR
     EXISTS (SELECT 1 FROM engineering_ingress_interactions) THEN
    RAISE EXCEPTION 'cannot revert migration 036 while engineering ingress rows exist';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS engineering_write_proposals_touch_updated_at
  ON engineering_write_proposals;
DROP TRIGGER IF EXISTS engineering_write_proposals_no_delete
  ON engineering_write_proposals;
DROP TRIGGER IF EXISTS engineering_write_proposals_guard_update
  ON engineering_write_proposals;
DROP FUNCTION IF EXISTS ra_guard_engineering_write_proposal();
DROP INDEX IF EXISTS engineering_write_proposals_case_created_idx;
DROP INDEX IF EXISTS engineering_write_proposals_pending_case_uidx;
DROP TABLE IF EXISTS engineering_write_proposals;
DROP TRIGGER IF EXISTS engineering_ingress_interactions_append_only
  ON engineering_ingress_interactions;
DROP TABLE IF EXISTS engineering_ingress_interactions;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_engineering_scope_key;
