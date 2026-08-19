-- RA-004 migration 013 (up): append-only job attempt history and idempotent,
-- auditable reconciliation records for AMBIGUOUS side effects.
--
-- Design (Master Plan §6.2, task RA-004 acceptance criteria 2 & 6):
--   * job_attempts is an append-only ledger: one row per lease attempt of a job,
--     recording who held the lease, the fencing token, the outcome, and the error
--     (redacted by the caller). It gives durable attempt history for retry/DLQ
--     analysis without mutating the job row's own bookkeeping.
--   * intent-before-operation: a job that performs a side effect records a
--     job_intents row (kind + canonical descriptor + idempotency key) BEFORE the
--     operation. On restart, an intent with no confirmed completion signals a
--     possibly-executed write that must NOT be blindly replayed (criterion 2).
--   * job_reconciliations is the idempotent, auditable record of resolving an
--     AMBIGUOUS side effect: it is keyed by the intent's idempotency key so a
--     repeated reconciliation of the same intent is a no-op that returns the
--     existing resolution (criterion 6).

-- ---------------------------------------------------------------------------
-- 1. Append-only attempt history.
-- ---------------------------------------------------------------------------
CREATE TABLE job_attempts (
  attempt_id     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         text        NOT NULL REFERENCES jobs (job_id) ON DELETE RESTRICT,
  attempt_number integer     NOT NULL CHECK (attempt_number >= 1),
  lease_owner    text        NOT NULL,
  fencing_token  bigint      NOT NULL,
  outcome        text        NOT NULL CHECK (outcome IN (
                   'SUCCEEDED', 'FAILED', 'AMBIGUOUS', 'LEASE_LOST', 'DEAD_LETTER')),
  error          text,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL DEFAULT now(),
  -- One row per (job, attempt_number): a given attempt is recorded exactly once.
  UNIQUE (job_id, attempt_number)
);

CREATE INDEX job_attempts_job_idx ON job_attempts (job_id, attempt_number);

CREATE TRIGGER job_attempts_append_only
  BEFORE UPDATE OR DELETE ON job_attempts
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- ---------------------------------------------------------------------------
-- 2. Intent-before-operation ledger for jobs.
--    idempotency_key is globally unique: recording the same intent twice is a
--    caller-detectable conflict (ON CONFLICT DO NOTHING at the repo), so a retry
--    reuses the same intent rather than creating a second one.
-- ---------------------------------------------------------------------------
CREATE TABLE job_intents (
  intent_id       text        PRIMARY KEY,
  job_id          text        NOT NULL REFERENCES jobs (job_id) ON DELETE RESTRICT,
  case_id         text,
  fencing_token   bigint      NOT NULL,
  kind            text        NOT NULL,
  -- Canonical, hashable descriptor of the intended operation (no secrets).
  descriptor      jsonb       NOT NULL,
  -- Idempotency key for the external side effect (Master Plan §5.6). Unique so a
  -- confirmed completion can be matched back to exactly one intent.
  idempotency_key text        NOT NULL UNIQUE,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  -- Bind (job_id, case_id) to the job by composite FK so an intent can never
  -- claim a case that differs from its job's case (RA-003 integrity pattern).
  FOREIGN KEY (job_id, case_id) REFERENCES jobs (job_id, case_id) ON DELETE RESTRICT
);

CREATE INDEX job_intents_job_idx ON job_intents (job_id, recorded_at);

-- Composite UNIQUE so child ledgers bind (intent_id, job_id) and cannot attribute
-- a completion/reconciliation to a job different from the intent's job.
ALTER TABLE job_intents ADD CONSTRAINT job_intents_id_job_key UNIQUE (intent_id, job_id);

CREATE TRIGGER job_intents_append_only
  BEFORE UPDATE OR DELETE ON job_intents
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- ---------------------------------------------------------------------------
-- 3. Confirmed completion of an intent's operation. Append-only; at most one
--    completion per intent (UNIQUE intent_id). A confirmed completion is
--    reconstructed on restart rather than the operation being replayed
--    (Master Plan §6.2, criterion 2).
-- ---------------------------------------------------------------------------
CREATE TABLE job_completions (
  completion_id text        PRIMARY KEY,
  intent_id     text        NOT NULL REFERENCES job_intents (intent_id) ON DELETE RESTRICT,
  job_id        text        NOT NULL REFERENCES jobs (job_id) ON DELETE RESTRICT,
  outcome       text        NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'AMBIGUOUS')),
  -- External receipt / evidence of the side effect (no secrets).
  receipt       jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (intent_id),
  -- (intent_id, job_id) must match the intent's own (intent_id, job_id).
  FOREIGN KEY (intent_id, job_id) REFERENCES job_intents (intent_id, job_id) ON DELETE RESTRICT
);

CREATE INDEX job_completions_job_idx ON job_completions (job_id, recorded_at);

CREATE TRIGGER job_completions_append_only
  BEFORE UPDATE OR DELETE ON job_completions
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();

-- ---------------------------------------------------------------------------
-- 4. Idempotent, auditable reconciliation of an AMBIGUOUS intent. This is an
--    APPEND-ONLY ledger of reconciliation ATTEMPTS, not a single 1:1 row: an
--    operator (or automated probe) may reconcile the same intent multiple times
--    as new evidence arrives. An early `UNRESOLVED` attempt must NOT lock the
--    intent into a dead end — a later `CONFIRMED`/`ABSENT` attempt can close it
--    (audit MEDIUM-06). Each attempt carries its own idempotency key so a
--    retried attempt is a deterministic no-op and two concurrent first attempts
--    cannot both win. resolution records what was determined about the external
--    system: the write DID happen (CONFIRMED), did NOT happen (ABSENT), or
--    remains UNRESOLVED (still AMBIGUOUS: automatic replay stays halted).
-- ---------------------------------------------------------------------------
CREATE TABLE job_reconciliations (
  reconciliation_id text        PRIMARY KEY,
  intent_id         text        NOT NULL REFERENCES job_intents (intent_id) ON DELETE RESTRICT,
  job_id            text        NOT NULL REFERENCES jobs (job_id) ON DELETE RESTRICT,
  resolution        text        NOT NULL CHECK (resolution IN ('CONFIRMED', 'ABSENT', 'UNRESOLVED')),
  evidence          jsonb,
  -- Per-attempt idempotency key scoped to this intent: a retried attempt with the
  -- same key is a no-op; two concurrent attempts for the same intent with
  -- different keys both record, but only one can be terminal (CONFIRMED/ABSENT).
  -- Globally unique would mix unrelated intents (audit HIGH-02).
  attempt_key       text        NOT NULL,
  reconciled_at     timestamptz NOT NULL DEFAULT now(),
  -- (intent_id, job_id) must match the intent's own (intent_id, job_id).
  FOREIGN KEY (intent_id, job_id) REFERENCES job_intents (intent_id, job_id) ON DELETE RESTRICT,
  UNIQUE (intent_id, attempt_key)
);

CREATE INDEX job_reconciliations_job_idx ON job_reconciliations (job_id);
CREATE INDEX job_reconciliations_intent_idx ON job_reconciliations (intent_id, reconciled_at);

-- At most ONE terminal (CONFIRMED/ABSENT) resolution per intent: once an intent
-- is closed it cannot be re-closed with a conflicting outcome, while any number
-- of UNRESOLVED attempts may precede the terminal one (audit MEDIUM-06).
CREATE UNIQUE INDEX job_reconciliations_terminal_uidx
  ON job_reconciliations (intent_id)
  WHERE resolution IN ('CONFIRMED', 'ABSENT');

CREATE TRIGGER job_reconciliations_append_only
  BEFORE UPDATE OR DELETE ON job_reconciliations
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
