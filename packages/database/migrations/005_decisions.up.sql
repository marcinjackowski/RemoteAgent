-- RA-003 migration 005 (up): decision requests and owner answers.
--
-- A DecisionRequest is bound to a case and a checkpoint_revision (Master Plan
-- §5.5). The owner's answer references the exact decision and revision so a
-- stale answer cannot apply to a mutated question. Decisions and answers are
-- append-only records of what was asked/answered.

CREATE TABLE decisions (
  decision_id         text        PRIMARY KEY,
  case_id             text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  question            text        NOT NULL,
  why_now             text        NOT NULL,
  options             jsonb       NOT NULL,
  recommendation      text        NOT NULL,
  blocked_scope       text        NOT NULL,
  checkpoint_revision integer     NOT NULL CHECK (checkpoint_revision >= 0),
  expires_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decisions_case_idx ON decisions (case_id, created_at);

CREATE TRIGGER decisions_append_only
  BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

CREATE TABLE decision_answers (
  answer_id           text        PRIMARY KEY,
  decision_id         text        NOT NULL REFERENCES decisions (decision_id) ON DELETE RESTRICT,
  case_id             text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  checkpoint_revision integer     NOT NULL CHECK (checkpoint_revision >= 0),
  selected_option_id  text        NOT NULL,
  note                text,
  answered_by         text        NOT NULL,
  answered_at         timestamptz NOT NULL DEFAULT now(),
  -- Exactly one answer per decision.
  UNIQUE (decision_id)
);

CREATE INDEX decision_answers_case_idx ON decision_answers (case_id, answered_at);

CREATE TRIGGER decision_answers_append_only
  BEFORE UPDATE OR DELETE ON decision_answers
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
