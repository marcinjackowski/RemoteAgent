-- RA-003 migration 008 (up): external actions, approvals, receipts.
--
-- The model proposes, policy decides, a deterministic executor performs
-- (Master Plan §5.6, §10). action_digest is the canonical digest an approval is
-- bound to; idempotency_key guarantees at-most-once external execution.
-- Receipts are append-only proof returned by the external system.

CREATE TABLE external_actions (
  action_id        text        PRIMARY KEY,
  case_id          text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  tool_name        text        NOT NULL,
  connection_id    text        NOT NULL,
  repo             text,
  canonical_payload jsonb      NOT NULL,
  action_digest    text        NOT NULL CHECK (action_digest ~ '^sha256:[0-9a-f]{64}$'),
  risk_tier        text        NOT NULL CHECK (risk_tier IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  policy_decision  text        NOT NULL CHECK (policy_decision IN ('AUTO_ALLOW', 'REQUIRES_APPROVAL', 'DENY')),
  approval_id      text,
  idempotency_key  text        NOT NULL,
  status           text        NOT NULL CHECK (status IN (
                     'PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTING',
                     'SUCCEEDED', 'FAILED', 'AMBIGUOUS')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- R4 always requires an exact approval; AUTO_ALLOW is impossible for R4
  -- (Master Plan §10), enforced natively in addition to the contract check.
  CONSTRAINT external_actions_r4_requires_approval
    CHECK (NOT (risk_tier = 'R4' AND policy_decision = 'AUTO_ALLOW')),
  -- At-most-once external execution per idempotency key.
  UNIQUE (idempotency_key)
);

CREATE INDEX external_actions_case_idx ON external_actions (case_id, created_at);
CREATE INDEX external_actions_status_idx ON external_actions (status);
CREATE UNIQUE INDEX external_actions_digest_idx ON external_actions (action_digest);

CREATE TRIGGER external_actions_touch_updated_at
  BEFORE UPDATE ON external_actions
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Owner-scoped, one-shot approvals bound to an exact action digest.
CREATE TABLE approvals (
  approval_id   text        PRIMARY KEY,
  case_id       text        NOT NULL REFERENCES cases (case_id) ON DELETE RESTRICT,
  granted_by    text        NOT NULL,
  action_digest text        NOT NULL CHECK (action_digest ~ '^sha256:[0-9a-f]{64}$'),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed      boolean     NOT NULL DEFAULT false,
  consumed_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Expiry strictly after grant; consumed_at present iff consumed.
  CONSTRAINT approvals_expiry_after_grant CHECK (expires_at > granted_at),
  CONSTRAINT approvals_consumed_consistent CHECK (
    (consumed = true AND consumed_at IS NOT NULL) OR
    (consumed = false AND consumed_at IS NULL)
  )
);

CREATE INDEX approvals_case_idx ON approvals (case_id);
CREATE INDEX approvals_digest_idx ON approvals (action_digest);

CREATE TRIGGER approvals_touch_updated_at
  BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();

-- Now that approvals exists, add the deferred FK from actions to approvals.
ALTER TABLE external_actions
  ADD CONSTRAINT external_actions_approval_fk
  FOREIGN KEY (approval_id) REFERENCES approvals (approval_id) ON DELETE RESTRICT;

-- Receipts: append-only proof of a successful external side effect. A write
-- without a confirmed receipt stays AMBIGUOUS, never SUCCESS.
CREATE TABLE receipts (
  receipt_id    text        PRIMARY KEY,
  action_id     text        NOT NULL REFERENCES external_actions (action_id) ON DELETE RESTRICT,
  external_id   text        NOT NULL,
  status        text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- One receipt per action.
  UNIQUE (action_id)
);

CREATE INDEX receipts_action_idx ON receipts (action_id);

CREATE TRIGGER receipts_append_only
  BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION ra_deny_mutation();
