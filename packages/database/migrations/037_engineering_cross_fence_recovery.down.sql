-- The previous schema cannot represent recovery authority, replay identity or a
-- parked continuation. Rollback is legal only before the protocol has durable data.
-- Lock every carrier/referenced authority table up front; NOWAIT closes both the
-- check/drop race and an FK-drop wait behind a concurrent writer.
LOCK TABLE engineering_recovery_events, engineering_recoveries, jobs,
  engineering_write_proposals, approvals, work_units, agent_runs,
  engineering_operations, job_intents
  IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM engineering_recoveries) OR
     EXISTS (SELECT 1 FROM engineering_recovery_events) OR
     EXISTS (SELECT 1 FROM jobs WHERE job_type = 'agent.engineering_recovery') OR
     EXISTS (SELECT 1 FROM jobs WHERE status = 'RECOVERY_PENDING') THEN
    RAISE EXCEPTION 'cannot revert migration 037 while engineering recovery rows exist';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS engineering_recoveries_touch_updated_at ON engineering_recoveries;
DROP TRIGGER IF EXISTS engineering_recoveries_no_delete ON engineering_recoveries;
DROP TRIGGER IF EXISTS engineering_recoveries_guard_update ON engineering_recoveries;
DROP TRIGGER IF EXISTS engineering_recoveries_guard_insert ON engineering_recoveries;
DROP FUNCTION IF EXISTS ra_validate_engineering_recovery_insert();
DROP FUNCTION IF EXISTS ra_guard_engineering_recovery();
DROP TRIGGER IF EXISTS engineering_recovery_events_guard_insert ON engineering_recovery_events;
DROP FUNCTION IF EXISTS ra_guard_engineering_recovery_event();
DROP TRIGGER IF EXISTS engineering_recovery_events_append_only ON engineering_recovery_events;
DROP TABLE engineering_recovery_events;
DROP TABLE engineering_recoveries;

DROP TRIGGER IF EXISTS engineering_recovery_job_guard ON jobs;
DROP FUNCTION IF EXISTS ra_guard_engineering_recovery_job();
ALTER TABLE jobs DROP CONSTRAINT jobs_engineering_recovery_shape_check;
DROP FUNCTION IF EXISTS ra_jsonb_object_key_count(jsonb);

ALTER TABLE engineering_operations
  DROP CONSTRAINT engineering_operations_recovery_authority_key;
ALTER TABLE job_intents DROP CONSTRAINT job_intents_recovery_fence_key;
ALTER TABLE engineering_write_proposals
  DROP CONSTRAINT engineering_write_proposals_recovery_authority_key;

DROP INDEX jobs_engineering_recovery_pending_idx;
DROP INDEX jobs_active_serialization_uidx;
CREATE UNIQUE INDEX jobs_active_serialization_uidx
  ON jobs (serialization_key)
  WHERE serialization_key IS NOT NULL AND status IN ('LEASED', 'RECONCILING');

ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check CHECK (status IN (
    'PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'RECONCILING'));
