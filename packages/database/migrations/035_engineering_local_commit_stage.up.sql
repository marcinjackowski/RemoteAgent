-- RA-043: LOCAL_COMMIT is an explicit mutating stage after final verification.
ALTER TABLE engineering_operations
  DROP CONSTRAINT engineering_operations_stage_check,
  ADD CONSTRAINT engineering_operations_stage_check CHECK (stage IN (
    'DISCOVERY', 'OUTCOME_DEFINITION', 'SYSTEM_DESIGN', 'PROGRAM_DESIGN',
    'DESIGN_APPROVAL', 'SLICE_PLANNING', 'SLICE_IMPLEMENTATION',
    'GATE_EXECUTION', 'SLICE_REVIEW', 'MEMORY_PROJECTION',
    'FINAL_VERIFICATION', 'LOCAL_COMMIT'));

ALTER TABLE engineering_run_projections
  DROP CONSTRAINT engineering_run_projections_current_stage_check,
  ADD CONSTRAINT engineering_run_projections_current_stage_check CHECK (current_stage IN (
    'DISCOVERY', 'OUTCOME_DEFINITION', 'SYSTEM_DESIGN', 'PROGRAM_DESIGN',
    'DESIGN_APPROVAL', 'SLICE_PLANNING', 'SLICE_IMPLEMENTATION',
    'GATE_EXECUTION', 'SLICE_REVIEW', 'MEMORY_PROJECTION',
    'FINAL_VERIFICATION', 'LOCAL_COMMIT'));
