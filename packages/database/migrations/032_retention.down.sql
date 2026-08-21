-- RA-024 migration 032 (down): remove the retention mechanism.
--
-- Restores the unconditional append-only trigger on `raw_events` FIRST, so there is
-- no window in which the relaxed trigger exists without the column checks that make
-- it safe.
DROP TRIGGER IF EXISTS raw_events_append_only ON raw_events;
CREATE TRIGGER raw_events_append_only
  BEFORE UPDATE OR DELETE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

DROP FUNCTION IF EXISTS ra_retention_purge_raw_payload(text, timestamptz);
DROP FUNCTION IF EXISTS ra_deny_mutation_except_retention();
DROP FUNCTION IF EXISTS ra_retention_in_progress();

-- `retention_runs` is dropped last. It records that data was destroyed, so if this
-- rollback fails midway the evidence is still present.
DROP TABLE IF EXISTS retention_runs;
