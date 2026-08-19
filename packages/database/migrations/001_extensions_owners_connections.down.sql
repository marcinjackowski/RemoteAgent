-- RA-003 migration 001 (down).
DROP TABLE IF EXISTS connections;
DROP TABLE IF EXISTS owners;
DROP FUNCTION IF EXISTS ra_touch_updated_at();
DROP FUNCTION IF EXISTS ra_deny_mutation();
-- pgcrypto is left installed; dropping a shared extension on rollback could
-- break other objects. It is idempotent to re-create.
