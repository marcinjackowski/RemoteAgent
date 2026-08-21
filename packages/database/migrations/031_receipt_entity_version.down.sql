-- RA-022 migration 031 (down): drop the receipt entity-version binding.
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_entity_version_complete;
ALTER TABLE receipts DROP COLUMN IF EXISTS entity_version_field;
ALTER TABLE receipts DROP COLUMN IF EXISTS entity_version;
