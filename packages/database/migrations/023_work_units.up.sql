-- RA-009 migration 023: durable Supervisor work units.
-- `agent_runs.work_unit_id` intentionally remains an unqualified text value:
-- older runs predate this table and must continue to be readable. The binding
-- edge is owned by work_units.run_id instead.

CREATE TABLE work_units (
  schema_version      integer     NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  work_unit_id        text        PRIMARY KEY,
  case_id             text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  role                text        NOT NULL CHECK (role IN (
                        'SUPERVISOR', 'PLANNER', 'IMPLEMENTER', 'REVIEWER',
                        'VERIFICATION', 'SPECIALIST')),
  status              text        NOT NULL CHECK (status IN (
                        'PENDING', 'DISPATCHED', 'RUNNING', 'COMPLETED',
                        'FAILED', 'CANCELLED')),
  objective           text        NOT NULL,
  authoritative_scope jsonb       NOT NULL CHECK (
                        jsonb_typeof(authoritative_scope) = 'object'
                        AND jsonb_typeof(authoritative_scope->'can_write_workspace') = 'boolean'
                        AND ((role = 'IMPLEMENTER') =
                             (authoritative_scope->>'can_write_workspace' = 'true'))
                      ),
  run_id              text        UNIQUE REFERENCES agent_runs (run_id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work_units ADD CONSTRAINT work_units_status_binding_check CHECK (
  (status = 'PENDING' AND run_id IS NULL)
  OR (status = 'CANCELLED')
  OR (status IN ('DISPATCHED', 'RUNNING', 'COMPLETED', 'FAILED') AND run_id IS NOT NULL)
);

CREATE INDEX work_units_pending_idx ON work_units (created_at, work_unit_id)
  WHERE status = 'PENDING';
CREATE INDEX work_units_case_idx ON work_units (case_id, created_at);
CREATE UNIQUE INDEX work_units_active_writer_case_uidx ON work_units (case_id)
  WHERE status IN ('DISPATCHED', 'RUNNING')
    AND authoritative_scope->>'can_write_workspace' = 'true';

CREATE TRIGGER work_units_touch_updated_at
  BEFORE UPDATE ON work_units
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
