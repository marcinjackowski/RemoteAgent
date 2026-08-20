-- RA-012 migration 027 (up): durable, cross-process operation intent ledger for
-- the model-facing implementation toolset.
--
-- `packages/workspace-runner/src/operation-log.ts` already appends an
-- `operations.jsonl` file and serializes writers through an in-process `Map`.
-- That is NOT a cross-process authority: two worker processes (or two pods) each
-- hold their own `Map`, so both can read "no such operation", both can perform the
-- side effect, and the file ends up with two records for one `operation_id`. It
-- also records the operation only AFTER the effect, so a crash between the write
-- and the append leaves no evidence at all and a replay re-performs the write.
--
-- This table is the authoritative ledger instead. Three properties are enforced by
-- the schema itself rather than by application convention:
--
--   1. exactly-once, cross-process. `operation_id` is the PRIMARY KEY, so the
--      CLAIM is a single-winner `INSERT ... ON CONFLICT DO NOTHING`: PostgreSQL
--      itself decides which of N concurrent callers (in any number of processes)
--      inserts the row. Every loser observes the existing row and must NOT repeat
--      the side effect. This needs no advisory lock and no extra pooled
--      connection, so it cannot exhaust the `pg` pool under concurrency.
--
--   2. the intent is durable BEFORE the side effect. A claim is written as
--      `INTENT_RECORDED` and committed; only then may the caller act. A row found
--      in `INTENT_RECORDED` on a later pass therefore means "an attempt was
--      started and never reported a receipt" — the crash is visible, not silent.
--
--   3. no receipt => AMBIGUOUS, never SUCCEEDED. `SUCCEEDED` is the only outcome
--      permitted to carry a verified `after_digest`, and the CHECK constraints
--      below make it UNREPRESENTABLE without one; symmetrically `AMBIGUOUS`
--      REQUIRES an `ambiguity_reason`. A filesystem gives no transaction, so a
--      half-applied patch must be recordable and must not be expressible as a
--      success (mirrors the `toolResult` discriminated union in
--      `@remoteagent/implementation-tools`).
--
-- Scope. Every row is bound to (`case_id`, `workspace_id`) and the composite
-- foreign key to `workspaces (workspace_id, case_id)` makes a row whose workspace
-- belongs to a DIFFERENT case impossible to insert. `operation_id` is globally
-- unique on purpose: an operation id is minted by deterministic server-side code,
-- and the ledger must be able to answer "was this id ever used?" without being
-- told a scope — otherwise a caller could replay another case's id under its own
-- scope and get a fresh execution. Reads and terminal transitions are additionally
-- fenced on the full scope tuple, so a foreign scope can neither observe nor
-- transition a row it does not own; it is rejected, never silently shared.

-- Migration 007 gave `workspaces` a PRIMARY KEY on `workspace_id` and a separate
-- UNIQUE on `case_id`, but no unique tuple over BOTH — so the pair cannot be bound
-- by a composite foreign key yet. Two independent FKs would not do: they could each
-- resolve to a different workspace row, which is exactly the cross-scope forgery
-- this ledger must make impossible. Add the composite key additively (the pattern
-- migration 024 uses) rather than editing an applied migration (ADR-0002).
ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_case_key UNIQUE (workspace_id, case_id);

CREATE TABLE IF NOT EXISTS implementation_tool_operations (
  -- Deterministic, caller-minted identity of ONE side effect. Globally unique:
  -- the claim below is the exactly-once gate for every process.
  operation_id      text        PRIMARY KEY,
  -- Authoritative writer scope (`ToolIdentity`). The composite FK pins the
  -- workspace to this exact case, so the pair cannot be forged.
  case_id           text        NOT NULL,
  workspace_id      text        NOT NULL,
  -- Closed tool set, mirroring `ToolKind` in @remoteagent/implementation-tools.
  kind              text        NOT NULL CHECK (kind IN (
                        'READ_FILE', 'LIST_FILES', 'SEARCH_TEXT',
                        'WRITE_FILE', 'APPLY_PATCH', 'RUN_COMMAND')),
  -- Run-safety state (Master Plan §6.2). INTENT_RECORDED is committed BEFORE the
  -- side effect; the three others are terminal receipts.
  status            text        NOT NULL CHECK (status IN (
                        'INTENT_RECORDED', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS')),
  -- Pre-state the caller believed it was acting on; NULL for a read-only or
  -- first-touch operation that has nothing to pin.
  before_digest     text        CHECK (before_digest IS NULL OR before_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Observed post-state. Mandatory for SUCCEEDED (see the CHECK below), otherwise
  -- NULL-able: a post-state can only be observed, never asserted.
  after_digest      text        CHECK (after_digest IS NULL OR after_digest ~ '^sha256:[0-9a-f]{64}$'),
  -- Declared write surface at claim time; the observed one at receipt time.
  changed_files     jsonb       NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(changed_files) = 'array'
                                       AND jsonb_array_length(changed_files) <= 256),
  failure_code      text,
  ambiguity_reason  text        CHECK (ambiguity_reason IS NULL OR ambiguity_reason IN (
                        'PARTIAL_WRITE', 'INTERRUPTED', 'UNVERIFIED_POST_STATE')),
  claimed_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- The workspace must belong to this exact case (uses the UNIQUE (case_id) on
  -- workspaces from migration 007 via the composite key below).
  CONSTRAINT implementation_tool_operations_workspace_case_fk
    FOREIGN KEY (workspace_id, case_id)
    REFERENCES workspaces (workspace_id, case_id) ON DELETE RESTRICT,

  -- A verified post-state is what MAKES a success: SUCCEEDED without an
  -- after_digest is unrepresentable, so "we could not verify" can never be
  -- recorded as a success — it is AMBIGUOUS.
  CONSTRAINT implementation_tool_operations_succeeded_digest_chk
    CHECK (status <> 'SUCCEEDED' OR after_digest IS NOT NULL),
  -- A clean failure left no observable mutation; a failure that DID change files
  -- is by definition not clean and must be reported as AMBIGUOUS.
  CONSTRAINT implementation_tool_operations_failed_chk
    CHECK (status <> 'FAILED'
           OR (failure_code IS NOT NULL AND jsonb_array_length(changed_files) = 0)),
  -- AMBIGUOUS always carries a reason, so a reconciliation queue never has to
  -- guess why an operation is unresolved.
  CONSTRAINT implementation_tool_operations_ambiguous_chk
    CHECK ((status = 'AMBIGUOUS') = (ambiguity_reason IS NOT NULL)),
  -- Terminal states have a receipt timestamp; a pending claim does not.
  CONSTRAINT implementation_tool_operations_settled_chk
    CHECK ((status = 'INTENT_RECORDED') = (settled_at IS NULL))
);

-- Scope-fenced lookup: the ledger is always read as "this operation, in MY scope".
CREATE INDEX IF NOT EXISTS implementation_tool_operations_scope_idx
  ON implementation_tool_operations (case_id, workspace_id, claimed_at);

-- Drives reconciliation: every operation whose effect is still unresolved.
CREATE INDEX IF NOT EXISTS implementation_tool_operations_unresolved_idx
  ON implementation_tool_operations (case_id, workspace_id)
  WHERE status IN ('INTENT_RECORDED', 'AMBIGUOUS');

-- Operational run-state, not an append-only ledger row: an operation legitimately
-- transitions INTENT_RECORDED -> SUCCEEDED | FAILED | AMBIGUOUS exactly once, so it
-- gets the updated_at touch rather than the deny-mutation guard. The one-way-ness of
-- that transition is fenced in SQL by the repository (`WHERE status =
-- 'INTENT_RECORDED'`), so a terminal receipt can never be overwritten.
CREATE TRIGGER implementation_tool_operations_touch_updated_at
  BEFORE UPDATE ON implementation_tool_operations
  FOR EACH ROW EXECUTE FUNCTION ra_touch_updated_at();
