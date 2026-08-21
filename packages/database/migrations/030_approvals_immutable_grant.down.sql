-- RA-022 migration 030 (down): drop the approval immutability guards.
DROP INDEX IF EXISTS approvals_one_live_grant_per_action_idx;
DROP TRIGGER IF EXISTS approvals_no_delete ON approvals;
DROP TRIGGER IF EXISTS approvals_immutable_grant ON approvals;
DROP FUNCTION IF EXISTS ra_deny_approval_delete();
DROP FUNCTION IF EXISTS ra_guard_approval_immutability();
