-- RA-022 migration 029 (up): bind an approval to the checkpoint revision it was
-- granted against, and add the case/owner scope needed to fence it.
--
-- WHY THIS EXISTS. Migration 008's `approvals` binds a grant to an exact
-- `action_digest`, which is what makes "one parameter changed after approval
-- invalidates it" true (RA-022 AC1). But a digest pins the PAYLOAD, not the
-- CONTEXT. An approval granted while the case was at checkpoint revision N stayed
-- formally valid after the case moved to N+1 — so the owner could approve "comment
-- on MOBL-7 with this text" while the case believed one thing, and the executor
-- could perform it after the case had learned something that changed the answer.
-- That is the TOCTOU named in this task's audit focus and recorded as `CTF-005`.
--
-- OWNER DECISION (`2026-08-20`). Extend `approvals` rather than introduce a
-- separate grant/use ledger: one source of truth about a grant, and a smaller
-- blast radius than keeping two tables consistent. The condition attached to that
-- decision is implemented below: **the backfill is fail-closed**.
--
-- WHY THE BACKFILL IS THE HARD PART. A `NOT NULL` column cannot simply be added to
-- a table that may hold rows. The three obvious options and why two are wrong:
--
--   * DEFAULT 0 — every pre-existing unconsumed approval would silently become
--     "valid at revision 0". Since a case at revision 0 has just been created,
--     this reads as "approved before anything happened" and would be accepted by
--     any comparison that only checks equality against a fresh case. This is the
--     "absent declaration treated as consent" failure the project has hit before
--     (`CTF-010` finding 4).
--   * nullable column — "no revision recorded" then has to mean something at
--     runtime, and the tempting reading is "matches any revision". That is
--     strictly worse than DEFAULT 0 because it is invisible in the schema.
--   * INVALIDATE the rows — an approval whose context cannot be established is
--     not usable, and the owner can always grant a new one. Costs nothing but a
--     re-click; the alternative costs an unauthorized external write.
--
-- The third is implemented. Every pre-existing UNCONSUMED approval is marked
-- consumed at its grant instant, which makes it permanently unusable: `consume`
-- fences on `consumed = false`, so a row that arrives already consumed can never
-- authorize an execution. Consumed rows are historical records and are left
-- untouched.
--
-- Note the ordering below: the invalidation runs BEFORE the column is added, so it
-- operates on the pre-migration shape and cannot be confused by a default value.

-- 1. Invalidate every unconsumed approval, fail-closed, while the old shape holds.
--
-- `consumed_at = granted_at` satisfies migration 008's
-- `approvals_consumed_consistent` CHECK and the contract's
-- `granted_at <= consumed_at < expires_at` rule (008 already guarantees
-- `expires_at > granted_at`, so `granted_at` is strictly inside the window).
-- Using `now()` would break for a grant whose window has already closed.
UPDATE approvals
   SET consumed = true,
       consumed_at = granted_at
 WHERE consumed = false;

-- 2. The checkpoint revision this grant was made against.
--
-- No DEFAULT: a future INSERT must state the revision explicitly. Making the
-- column NOT NULL with no default means code that forgets it fails loudly at
-- insert time rather than silently recording a grant with no context.
ALTER TABLE approvals
  ADD COLUMN checkpoint_revision integer;

-- Every surviving row is consumed (step 1), so it is already unusable; -1 records
-- "no revision was ever established" without pretending to be a real revision.
-- `cases.checkpoint_revision` is `>= 0`, so -1 can never equal a live revision and
-- a comparison against any real case fails closed even if the consumed fence were
-- somehow bypassed. This is belt-and-braces on purpose: the guarantee should not
-- rest on a single mechanism.
UPDATE approvals SET checkpoint_revision = -1 WHERE checkpoint_revision IS NULL;

ALTER TABLE approvals
  ALTER COLUMN checkpoint_revision SET NOT NULL;

-- A real grant is at a real revision; only the invalidated backfill may be -1, and
-- those rows are all consumed. Enforced in SQL so an application bug cannot mint a
-- fresh grant carrying the sentinel.
ALTER TABLE approvals
  ADD CONSTRAINT approvals_revision_valid
  CHECK (checkpoint_revision >= 0 OR consumed = true);

-- 3. Owner scope, so an approval can be fenced without a join.
--
-- Approvals are owner-scoped (the contract says so: `granted_by`), but `granted_by`
-- is the ACTOR, not the scope — an owner id is what a grant must be fenced on, and
-- reading it through a join to `cases` on every consumption makes the fence a
-- separate statement from the update. The composite FK to `cases (case_id,
-- owner_id)` (migration 003) then makes a row pairing a case with a different
-- owner impossible to insert, exactly as migration 028 does for tool calls.
ALTER TABLE approvals
  ADD COLUMN owner_id text;

UPDATE approvals a
   SET owner_id = c.owner_id
  FROM cases c
 WHERE c.case_id = a.case_id
   AND a.owner_id IS NULL;

-- A grant whose case no longer exists cannot be scoped, and migration 008's
-- `ON DELETE RESTRICT` means this should be unreachable. Deleting the row rather
-- than leaving it unscoped keeps the NOT NULL below honest; it is already consumed
-- and therefore unusable either way.
DELETE FROM approvals WHERE owner_id IS NULL;

ALTER TABLE approvals
  ALTER COLUMN owner_id SET NOT NULL;

ALTER TABLE approvals
  ADD CONSTRAINT approvals_case_owner_fk
  FOREIGN KEY (case_id, owner_id) REFERENCES cases (case_id, owner_id) ON DELETE RESTRICT;

-- Consumption is always "this grant, in MY scope, at THIS revision, not yet used".
CREATE INDEX IF NOT EXISTS approvals_scope_revision_idx
  ON approvals (case_id, owner_id, checkpoint_revision)
  WHERE consumed = false;
