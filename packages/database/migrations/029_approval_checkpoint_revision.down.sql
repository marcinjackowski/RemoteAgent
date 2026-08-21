-- RA-022 migration 029 (down): remove the checkpoint-revision and owner-scope
-- binding from `approvals`.
--
-- Reverses 029 up in reverse order: index, then the two constraints and columns.
--
-- HONEST LIMITATION, stated rather than glossed over. This revert restores the
-- SCHEMA exactly, but it cannot restore the DATA that 029 up deliberately
-- destroyed: approvals that were unconsumed before the migration were invalidated
-- (marked consumed) as the fail-closed condition of the owner's decision, and a
-- `down` that un-consumed them would resurrect grants whose checkpoint context is
-- unknown — precisely the state 029 exists to eliminate. Rolling forward again
-- would have to re-invalidate them anyway.
--
-- So `down` is schema-complete and data-lossy by design. The loss is bounded and
-- recoverable by the owner: a grant that was invalidated can be granted again with
-- one interaction. `up` can be re-applied after this `down` and is idempotent with
-- respect to that invalidation, since every affected row is already consumed.

DROP INDEX IF EXISTS approvals_scope_revision_idx;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_case_owner_fk;
ALTER TABLE approvals DROP COLUMN IF EXISTS owner_id;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_revision_valid;
ALTER TABLE approvals DROP COLUMN IF EXISTS checkpoint_revision;
