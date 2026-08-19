-- RA-005 remediation (AUDIT-05 HIGH-11): a durable ACQUIRING stage recorded
-- BEFORE the non-idempotent OAuth acquire so a crash/pause/takeover can never
-- repeat that external side effect. Additive over 017/018 (ADR-0002); 017 and
-- 018 are already applied history and must not be edited in place.
--
-- Before this stage the intent went PENDING -> VAULT_WRITTEN directly, so a
-- worker that crashed AFTER sending the OAuth refresh but BEFORE persisting the
-- vault write left the intent in PENDING. A takeover then re-ran input.acquire(),
-- repeating a non-idempotent provider side effect that may have rotated the
-- token (AUDIT-05 HIGH-11). The coordinator now persists ACQUIRING under its
-- fenced lease immediately before input.acquire():
--
--   PENDING       intent recorded; the acquire has not been started
--   ACQUIRING     the OAuth acquire has been (or may have been) started; on a
--                 takeover of an expired ACQUIRING lease the acquire is NEVER
--                 repeated. It is resolved value-free against the vault: the
--                 EXACT intent version present -> resume at publish; anything
--                 else -> AMBIGUOUS with no re-acquire and no revoke.
--   VAULT_WRITTEN vault object confirmed present; a takeover resumes at publish
--   PUBLISHED     metadata CAS won; the connection now points at this ref
--   ABORTED       lost the CAS race; the unpublished ref was revoked
--   AMBIGUOUS     outcome could not be determined; NO automatic replay
--
-- Only the enumerated CHECK set changes; the inline constraint from 017 is
-- replaced by an identically named, widened constraint.

ALTER TABLE credential_refresh_intents
  DROP CONSTRAINT credential_refresh_intents_status_check,
  ADD CONSTRAINT credential_refresh_intents_status_check
    CHECK (status IN (
      'PENDING', 'ACQUIRING', 'VAULT_WRITTEN', 'PUBLISHED', 'ABORTED', 'AMBIGUOUS'
    ));
