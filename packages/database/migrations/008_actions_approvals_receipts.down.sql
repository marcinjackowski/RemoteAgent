-- RA-003 migration 008 (down).
DROP TABLE IF EXISTS receipts;
ALTER TABLE external_actions DROP CONSTRAINT IF EXISTS external_actions_approval_fk;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS external_actions;
