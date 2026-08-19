-- RA-006 migration 022 (up): owner/fencing token + bounded lease for send intents.
--
-- AUDIT-03 MEDIUM-16: migration 021 gave each Discord side effect a single-winner
-- claim (INSERT ... ON CONFLICT DO NOTHING), but its terminal transitions were
-- fenced only on the STATUS (`WHERE status = 'STARTED'`), not on WHO owns the
-- attempt. A concurrent LOSER that observed a winner's in-flight `STARTED` intent
-- could therefore flip it to `AMBIGUOUS`, after which the winner's own
-- `succeed(...)` (also fenced only on `STARTED`) no longer matched — so a message
-- that WAS delivered was left recorded as `AMBIGUOUS`, producing false evidence
-- and a spurious DLQ/alarm.
--
-- This migration adds a real ownership fence plus a bounded lease so only the
-- current owner (or, for a provably-abandoned attempt, a lease-expiry takeover)
-- may transition an intent:
--
--   * owner_token       — a per-attempt opaque token minted by the claimer /
--                         re-owner. Terminal transitions (succeed / mark
--                         ambiguous / mark retryable) require this token, so a
--                         loser that never owned the attempt CANNOT mutate it.
--   * lease_expires_at   — a bounded lease. While it is in the future the STARTED
--                         attempt is considered ACTIVE and a different caller must
--                         NOT touch it (it halts its own duplicate instead). Once
--                         it lapses the attempt is provably abandoned (a crash),
--                         so a recovering caller may transition it to AMBIGUOUS
--                         (fenced on the expiry, never on an active winner).
--
-- Legacy rows written by migration 021 predate the ownership fence: they have no
-- owner_token and no lease. A pre-existing SUCCEEDED / AMBIGUOUS / RETRYABLE row is
-- already terminal (or re-ownable by takeForRetry, which mints a fresh token), so a
-- NULL owner_token is harmless for those. A pre-existing STARTED row, however, is an
-- in-flight attempt whose owning process is being replaced by this deploy: under the
-- new model it would have neither an owner (so no owner-fenced terminal can complete
-- it) NOR a lease (so the expiry-fenced recovery, which requires
-- `lease_expires_at IS NOT NULL`, could never resolve it) — it would sit ownerless in
-- STARTED forever. Its side-effect outcome is UNKNOWN, so fail closed to the
-- conservative terminal AMBIGUOUS: automatic replay is halted rather than risking a
-- duplicate write. This backfill is deterministic (idempotent: it matches nothing on
-- a fresh install and re-runs to the same fixed point).

ALTER TABLE discord_send_intents
  ADD COLUMN owner_token      text,
  ADD COLUMN lease_expires_at timestamptz;

UPDATE discord_send_intents
   SET status = 'AMBIGUOUS',
       attempts = attempts + 1,
       last_error = COALESCE(last_error, 'migration 022: in-flight intent adopted; outcome unknown')
 WHERE status = 'STARTED';
