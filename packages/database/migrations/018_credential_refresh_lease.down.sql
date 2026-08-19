ALTER TABLE credential_refresh_intents
  DROP CONSTRAINT IF EXISTS credential_refresh_intents_lease_shape_check,
  DROP COLUMN IF EXISTS lease_expires_at,
  DROP COLUMN IF EXISTS lease_fencing_token,
  DROP COLUMN IF EXISTS lease_holder;
