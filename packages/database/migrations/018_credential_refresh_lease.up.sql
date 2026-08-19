-- RA-005 remediation (AUDIT-03 HIGH-05): a durable, crash-safe single-executor
-- lease with a fencing token for each credential-refresh operation. Additive
-- over 017 (ADR-0002).
--
-- Before this migration two refreshers sharing the SAME operation_id could both
-- acquire the credential, write the SAME vault ref and reach the metadata CAS.
-- The CAS elects one winner, but the loser then revoked the SHARED ref (their
-- operation_id -> identical ref) and marked the intent ABORTED, leaving the
-- winner's published connection pointing at a deleted secret (auth outage) and
-- clobbering the winner's terminal status. An in-process mutex is insufficient:
-- the guarantee must hold across processes and survive a crash.
--
-- This lease makes "exactly one active executor per operation_id" durable:
--
--   lease_holder        opaque id of the executor that currently owns the op,
--                       or NULL when the op is free to be claimed.
--   lease_fencing_token monotonically increasing token, bumped on every claim.
--                       Every mutation is guarded by (lease_holder,
--                       lease_fencing_token); a stale/taken-over executor whose
--                       token no longer matches affects zero rows and must not
--                       touch the shared vault ref.
--   lease_expires_at    wall-clock lease deadline. A crashed holder's lease
--                       expires so another executor may take over and reconcile
--                       via a value-free vault probe; a live, non-expired lease
--                       makes a second caller a read-only observer.
--
-- Terminal statuses (PUBLISHED, ABORTED, AMBIGUOUS) are never re-claimed: a
-- second caller observes the recorded outcome instead of re-running the side
-- effect (AGENTS.md §8, Master Plan §6.2 run safety).

ALTER TABLE credential_refresh_intents
  ADD COLUMN lease_holder        text,
  ADD COLUMN lease_fencing_token bigint      NOT NULL DEFAULT 0
    CHECK (lease_fencing_token >= 0),
  ADD COLUMN lease_expires_at    timestamptz,
  -- A held lease is well-formed only with a deadline; a free lease has neither.
  ADD CONSTRAINT credential_refresh_intents_lease_shape_check CHECK (
    (lease_holder IS NULL AND lease_expires_at IS NULL)
    OR (lease_holder IS NOT NULL AND lease_expires_at IS NOT NULL)
  );
