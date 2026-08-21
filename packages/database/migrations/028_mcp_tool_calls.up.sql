-- RA-021 migration 028 (up): durable ledger of every brokered MCP tool call.
--
-- AC6 requires that every call carry intent, validated arguments, a result digest,
-- latency and a trace. A log satisfies none of that reliably: a log line is lost
-- when the process dies, is not queryable as state, and cannot express the one
-- distinction AC5 turns on — whether a call that produced no response might still
-- have taken effect. So this is a table, and the shape of the table is the proof.
--
-- Four properties are enforced by the schema itself rather than by application
-- convention.
--
--   1. THE INTENT IS DURABLE BEFORE DISPATCH. A row is inserted as `DISPATCHED`
--      and committed BEFORE the request leaves the process; only then is the call
--      made. A row still in `DISPATCHED` on a later pass therefore means "a request
--      was sent and never reported a result" — which is a visible, resolvable state
--      rather than a silent absence. This mirrors migration 027's `INTENT_RECORDED`
--      for local tool effects; the reasoning is identical and was proven there.
--
--   2. NO RECEIPT MEANS AMBIGUOUS, NEVER SUCCEEDED. `SUCCEEDED` is the only
--      outcome permitted to carry a `result_digest`, and the CHECK below makes
--      `SUCCEEDED` without one UNREPRESENTABLE. Symmetrically `AMBIGUOUS` REQUIRES
--      an `ambiguity_reason`. A read whose response was lost is thus recordable and
--      is *not expressible* as a success — which is AC5 stated in SQL rather than
--      in a comment (AGENTS.md rule 9: a comment is not evidence of behaviour).
--
--   3. A REFUSAL IS A DISTINCT, NAMED OUTCOME. `REFUSED` carries a
--      `refusal_code` and never a `result_digest`: nothing was dispatched, so there
--      is nothing to have a receipt for. Keeping refusals in the same ledger is
--      deliberate — "the model proposed a cross-scope call and was refused" is
--      exactly the audit question this table must answer, and a refusal that only
--      appeared in a log would be invisible to it.
--
--   4. MODEL OUTPUT IS STORED AS A DIGEST, NOT AS TEXT. `validated_arguments_digest`
--      covers the canonical encoding of the arguments the broker actually forwarded.
--      Storing the raw arguments would make this table a stored-injection channel
--      into every operator tool that reads it, and would persist UNTRUSTED_DATA
--      indefinitely for no gain: the question the ledger answers is "were these the
--      arguments this call ran with", which a digest settles.
--
-- Scope. Every row is bound to (`case_id`, `owner_id`) and the composite foreign
-- key to `cases (case_id, owner_id)` (migration 003) makes a row whose case belongs
-- to a different owner impossible to insert. `call_id` is globally unique because
-- the ledger must be able to answer "was this id ever used?" without being told a
-- scope — otherwise a caller could replay another case's id under its own scope and
-- get a fresh execution. Reads and terminal transitions are additionally fenced on
-- the full scope tuple.

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  -- Server-minted identity of ONE brokered call. Globally unique: the insert is
  -- the single-winner gate, exactly as in migration 027.
  call_id           text        PRIMARY KEY,
  -- The model-proposed intent this call came from. NOT unique: one intent that is
  -- refused and later re-proposed with corrected arguments is two calls, and
  -- collapsing them would hide the refusal.
  intent_id         text        NOT NULL,
  -- Authoritative scope. The composite FK pins the case to this exact owner.
  case_id           text        NOT NULL,
  owner_id          text        NOT NULL,
  -- Which agent role proposed it, mirroring `AgentRole` in @remoteagent/contracts.
  role              text        NOT NULL CHECK (role IN (
                        'SUPERVISOR', 'PLANNER', 'IMPLEMENTER',
                        'REVIEWER', 'VERIFICATION', 'SPECIALIST')),
  tool_name         text        NOT NULL CHECK (length(btrim(tool_name)) > 0),
  -- Server-owned descriptor version in force when the call ran. A schema change
  -- that alters arguments bumps it, so an old row stays interpretable.
  tool_version      integer     NOT NULL CHECK (tool_version > 0),
  provider          text        NOT NULL CHECK (provider IN (
                        'jira', 'gmail', 'calendar', 'gitlab', 'discord')),
  -- Risk tier from Master Plan §10. RA-021 executes R0 only; the column accepts
  -- the full range so RA-022 needs no migration to record an approved write.
  risk_tier         text        NOT NULL CHECK (risk_tier IN ('R0', 'R1', 'R2', 'R3', 'R4')),
  -- Lifecycle. DISPATCHED is committed BEFORE the request is sent; the rest are
  -- terminal. REFUSED never reached the network at all.
  status            text        NOT NULL CHECK (status IN (
                        'DISPATCHED', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS', 'REFUSED')),
  refusal_code      text        CHECK (refusal_code IS NULL OR refusal_code IN (
                        'UNKNOWN_TOOL', 'TOOL_NOT_IN_MANIFEST', 'ARGUMENTS_INVALID',
                        'ARGUMENTS_TOO_LARGE', 'SCOPE_IN_ARGUMENTS', 'OUT_OF_SCOPE',
                        'RISK_TIER_NOT_EXECUTABLE', 'CAPABILITY_MISSING',
                        'CIRCUIT_OPEN', 'RATE_LIMITED', 'SCHEMA_DRIFT',
                        'PROTOCOL_VIOLATION', 'VERSION_UNSUPPORTED')),
  ambiguity_reason  text        CHECK (ambiguity_reason IS NULL OR ambiguity_reason IN (
                        'TIMEOUT_AFTER_DISPATCH', 'TRANSPORT_LOST_AFTER_DISPATCH',
                        'NO_RECEIPT')),
  -- sha256 over the canonical encoding of the arguments the broker FORWARDED
  -- (post-validation), never over the model's raw proposal.
  validated_arguments_digest text NOT NULL
                              CHECK (validated_arguments_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- sha256 over the normalized output. Observed, never asserted.
  result_digest     text        CHECK (result_digest IS NULL OR result_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Artifact holding the full output when it was truncated or malformed (AC4).
  -- Kept as a plain reference rather than an FK: `artifacts` is keyed by the
  -- evidence scope (case, workspace) from migration 007, and a brokered read has
  -- no workspace — a tool call is not a test run.
  artifact_id       text,
  latency_ms        integer     NOT NULL CHECK (latency_ms >= 0),
  correlation_id    text        NOT NULL CHECK (length(btrim(correlation_id)) > 0),
  trace_id          text        NOT NULL CHECK (length(btrim(trace_id)) > 0),
  dispatched_at     timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- The case must belong to this exact owner, so a cross-owner row cannot exist.
  CONSTRAINT mcp_tool_calls_case_owner_fk
    FOREIGN KEY (case_id, owner_id)
    REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT,

  -- A verified result is what MAKES a success. "We could not read the response"
  -- is therefore unrepresentable as SUCCEEDED — it is AMBIGUOUS (AC5).
  CONSTRAINT mcp_tool_calls_succeeded_digest_chk
    CHECK (status <> 'SUCCEEDED' OR result_digest IS NOT NULL),
  -- AMBIGUOUS always carries a reason, so a reconciliation pass never guesses why
  -- an outcome is unresolved, and only AMBIGUOUS may carry one.
  CONSTRAINT mcp_tool_calls_ambiguous_chk
    CHECK ((status = 'AMBIGUOUS') = (ambiguity_reason IS NOT NULL)),
  -- A refusal is pre-dispatch: it has a code, and it cannot have a result.
  CONSTRAINT mcp_tool_calls_refused_chk
    CHECK ((status = 'REFUSED') = (refusal_code IS NOT NULL)),
  CONSTRAINT mcp_tool_calls_refused_no_result_chk
    CHECK (status <> 'REFUSED' OR result_digest IS NULL),
  -- Terminal states have a receipt timestamp; a pending dispatch does not.
  CONSTRAINT mcp_tool_calls_settled_chk
    CHECK ((status = 'DISPATCHED') = (settled_at IS NULL))
);

-- Scope-fenced lookup: the ledger is always read as "this case's calls".
CREATE INDEX IF NOT EXISTS mcp_tool_calls_scope_idx
  ON mcp_tool_calls (case_id, owner_id, dispatched_at DESC);

-- Drives reconciliation: every call whose effect is still unresolved. A row stuck
-- in DISPATCHED is the crash-between-dispatch-and-receipt case that must resolve
-- to AMBIGUOUS rather than disappear.
CREATE INDEX IF NOT EXISTS mcp_tool_calls_unresolved_idx
  ON mcp_tool_calls (case_id, owner_id)
  WHERE status IN ('DISPATCHED', 'AMBIGUOUS');

-- Feeds the per-provider circuit breaker and rate limiter, which ask "how did the
-- last N calls to this provider go, in this window".
CREATE INDEX IF NOT EXISTS mcp_tool_calls_provider_window_idx
  ON mcp_tool_calls (provider, dispatched_at DESC);

-- Operational run-state, not an append-only ledger row: a call legitimately
-- transitions DISPATCHED -> SUCCEEDED | FAILED | AMBIGUOUS exactly once, so it gets
-- the updated_at touch rather than the deny-mutation guard. The one-way-ness is
-- fenced in SQL by the repository (`WHERE status = 'DISPATCHED'`), so a terminal
-- receipt can never be overwritten.
CREATE TRIGGER mcp_tool_calls_touch_updated_at
  BEFORE UPDATE ON mcp_tool_calls
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
