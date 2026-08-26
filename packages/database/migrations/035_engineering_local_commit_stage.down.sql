-- Fail closed: the previous schema cannot represent durable LOCAL_COMMIT provenance.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM engineering_operations WHERE stage = 'LOCAL_COMMIT') OR
     EXISTS (SELECT 1 FROM engineering_run_projections WHERE current_stage = 'LOCAL_COMMIT') THEN
    RAISE EXCEPTION 'cannot revert migration 035 while LOCAL_COMMIT rows exist';
  END IF;
END;
$$;

ALTER TABLE engineering_run_projections
  DROP CONSTRAINT engineering_run_projections_current_stage_check,
  ADD CONSTRAINT engineering_run_projections_current_stage_check CHECK (current_stage IN (
    'DISCOVERY', 'OUTCOME_DEFINITION', 'SYSTEM_DESIGN', 'PROGRAM_DESIGN',
    'DESIGN_APPROVAL', 'SLICE_PLANNING', 'SLICE_IMPLEMENTATION',
    'GATE_EXECUTION', 'SLICE_REVIEW', 'MEMORY_PROJECTION', 'FINAL_VERIFICATION'));

ALTER TABLE engineering_operations
  DROP CONSTRAINT engineering_operations_stage_check,
  ADD CONSTRAINT engineering_operations_stage_check CHECK (stage IN (
    'DISCOVERY', 'OUTCOME_DEFINITION', 'SYSTEM_DESIGN', 'PROGRAM_DESIGN',
    'DESIGN_APPROVAL', 'SLICE_PLANNING', 'SLICE_IMPLEMENTATION',
    'GATE_EXECUTION', 'SLICE_REVIEW', 'MEMORY_PROJECTION', 'FINAL_VERIFICATION'));
