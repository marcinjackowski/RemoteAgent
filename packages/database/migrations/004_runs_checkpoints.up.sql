-- RA-003 migration 004 (up): agent runs, run intents, completions, checkpoints.
--
-- Runs are one-shot (Master Plan §6.2). Intents and completions are append-only
-- ledgers used for recovery. Checkpoints are immutable per revision; the
-- UNIQUE(case_id, revision) constraint is the compare-and-set primitive so two
-- writers cannot both win at the same revision (RA-003 acceptance criterion 3).

CREATE TABLE agent_runs (
  run_id              text        PRIMARY KEY,
  case_id             text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  work_unit_id        text        NOT NULL,
  role                text        NOT NULL CHECK (role IN (
                        'SUPERVISOR', 'PLANNER', 'IMPLEMENTER', 'REVIEWER',
                        'VERIFICATION', 'SPECIALIST')),
  safety_state        text        NOT NULL CHECK (safety_state IN (
                        'PLANNED', 'INTENT_RECORDED', 'STARTED', 'SUCCEEDED',
                        'FAILED', 'AMBIGUOUS')),
  checkpoint_revision integer     NOT NULL CHECK (checkpoint_revision >= 0),
  trigger_event_id    text        REFERENCES events (event_id) ON DELETE RESTRICT,
  model               jsonb,
  started_at          timestamptz,
  finished_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agent_runs_case_idx ON agent_runs (case_id, created_at);
CREATE INDEX agent_runs_state_idx ON agent_runs (safety_state);

CREATE TRIGGER agent_runs_touch_updated_at
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Pending intents recorded before a model/tool/side-effect call (Master Plan
-- §6.2 PLANNED -> INTENT_RECORDED). Append-only ledger.
CREATE TABLE run_intents (
  intent_id   text        PRIMARY KEY,
  run_id      text        NOT NULL REFERENCES agent_runs (run_id) ON DELETE RESTRICT,
  case_id     text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  kind        text        NOT NULL,
  payload     jsonb       NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX run_intents_run_idx ON run_intents (run_id, recorded_at);

CREATE TRIGGER run_intents_append_only
  BEFORE UPDATE OR DELETE ON run_intents
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- Confirmed completions (AgentCompletion). Append-only; a confirmed completion
-- is reconstructed on restart rather than recomputed. One completion per run.
CREATE TABLE run_completions (
  completion_id text        PRIMARY KEY,
  run_id        text        NOT NULL REFERENCES agent_runs (run_id) ON DELETE RESTRICT,
  case_id       text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  status        text        NOT NULL CHECK (status IN (
                  'CONTINUE', 'WAITING_FOR_USER', 'BLOCKED', 'COMPLETED',
                  'FAILED', 'CANCELLED')),
  completion    jsonb       NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  -- At most one confirmed completion per run.
  UNIQUE (run_id)
);

CREATE INDEX run_completions_case_idx ON run_completions (case_id, recorded_at);

CREATE TRIGGER run_completions_append_only
  BEFORE UPDATE OR DELETE ON run_completions
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- Case checkpoints: immutable per revision. The JSON checkpoint is the source of
-- truth (Master Plan §5.3). UNIQUE(case_id, revision) enforces optimistic
-- concurrency: a new revision must be exactly prev + 1 and cannot collide.
CREATE TABLE case_checkpoints (
  case_id      text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  revision     integer     NOT NULL CHECK (revision >= 0),
  checkpoint   jsonb       NOT NULL,
  last_event_id text       REFERENCES events (event_id) ON DELETE RESTRICT,
  last_run_id  text        REFERENCES agent_runs (run_id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, revision)
);

CREATE INDEX case_checkpoints_case_idx ON case_checkpoints (case_id, revision DESC);

-- Checkpoints are append-only: a revision, once written, is never mutated.
CREATE TRIGGER case_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON case_checkpoints
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
