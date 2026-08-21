-- RA-022 migration 031 (up): a receipt names the external entity VERSION it produced.
--
-- WHY THIS EXISTS. RA-022 AC7 requires a receipt to bind "action, provider result and
-- external entity version". Migration 008's `receipts` binds the first two —
-- `action_id` and `external_id` plus a provider `status` — but records nothing about
-- WHICH VERSION of the external object the write produced.
--
-- That gap is what makes reconciliation guesswork. After an ambiguous write (AC4) the
-- executor must answer "did my write land?", and `external_id` alone cannot: a Jira
-- issue has the same key before and after a comment, a Calendar event keeps its id
-- across edits, an MR keeps its iid. Providers expose a version discriminator for
-- exactly this reason -- Jira issue `updated`, Google Calendar `etag`, GitLab
-- `updated_at` -- and without storing it, a reconciler comparing "is the remote state
-- the one my action produced?" has only the id, which always matches.
--
-- `entity_version` is therefore NOT NULL for new receipts: a receipt is written only
-- when the provider confirmed the effect, and a provider that confirmed can say what
-- it produced. Making it nullable would reintroduce "no version recorded" as a state
-- reconciliation has to interpret, and the tempting interpretation is "assume it
-- matches" -- the `CTF-010` finding-4 shape (absent declaration read as consent).
--
-- BACKFILL. `receipts` is append-only (migration 008 installs `ra_deny_mutation` for
-- UPDATE and DELETE), so pre-existing rows cannot be modified even by this migration.
-- The column is added nullable, existing rows keep NULL, and the NOT NULL is enforced
-- by a CHECK that only constrains rows written from now on. In practice the table is
-- empty on every environment this runs against (no executor existed before RA-022),
-- but the migration must not depend on that.

ALTER TABLE receipts
  ADD COLUMN entity_version text;

-- A provider-native version/etag/timestamp discriminator, and the field name it came
-- from, so a reconciler knows how to compare it rather than guessing the format.
ALTER TABLE receipts
  ADD COLUMN entity_version_field text;

-- Both present or both absent. A version with no field name is uninterpretable, and a
-- field name with no version records nothing; either half alone is a receipt that
-- looks more informative than it is.
ALTER TABLE receipts
  ADD CONSTRAINT receipts_entity_version_complete CHECK (
    (entity_version IS NULL AND entity_version_field IS NULL)
    OR (entity_version IS NOT NULL AND entity_version_field IS NOT NULL
        AND length(btrim(entity_version)) > 0
        AND length(btrim(entity_version_field)) > 0)
  );

-- Reconciliation looks up by action; the existing `receipts_action_idx` covers that.
-- No new index: a receipt is read by action id, never scanned by version.
