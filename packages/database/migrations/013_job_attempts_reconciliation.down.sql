-- RA-004 migration 013 (down): drop attempt history and reconciliation tables.
DROP TABLE IF EXISTS job_reconciliations;
DROP TABLE IF EXISTS job_completions;
DROP TABLE IF EXISTS job_intents;
DROP TABLE IF EXISTS job_attempts;
