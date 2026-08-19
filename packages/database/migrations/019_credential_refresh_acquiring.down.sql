-- Revert the ACQUIRING stage: narrow the status CHECK back to the 017 set. Any
-- surviving ACQUIRING row would violate the reverted constraint, so a downgrade
-- is only valid once no intent is mid-acquire (correct fail-closed reversal).
ALTER TABLE credential_refresh_intents
  DROP CONSTRAINT credential_refresh_intents_status_check,
  ADD CONSTRAINT credential_refresh_intents_status_check
    CHECK (status IN (
      'PENDING', 'VAULT_WRITTEN', 'PUBLISHED', 'ABORTED', 'AMBIGUOUS'
    ));
