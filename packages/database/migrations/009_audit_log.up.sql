-- RA-003 migration 009 (up): audit log.
--
-- The audit log is an immutable, append-only record of every material action:
-- who/what/when, correlation ids, and an outcome. It exists to make each step
-- auditable (Master Plan §2, §11) and must never be updated or deleted through
-- application code.

CREATE TABLE audit_log (
  audit_id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  owner_id       text,
  case_id        text,
  actor          text        NOT NULL,
  action         text        NOT NULL,
  target_kind    text,
  target_id      text,
  outcome        text        NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILURE', 'AMBIGUOUS')),
  trace_id       text,
  -- Structured, size-bounded detail (secrets/raw payloads must be redacted by
  -- the caller before writing here).
  detail         jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at);
CREATE INDEX audit_log_case_idx ON audit_log (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX audit_log_owner_idx ON audit_log (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX audit_log_trace_idx ON audit_log (trace_id) WHERE trace_id IS NOT NULL;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
