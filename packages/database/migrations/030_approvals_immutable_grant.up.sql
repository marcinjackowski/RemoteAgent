-- RA-022 migration 030 (up): a granted approval's authorizing terms are
-- immutable, and consumption is one-way.
--
-- WHY THIS EXISTS. Found by the RA-022-WU-02 adversarial probe, not by the unit's
-- own tests, which were all green. Migration 029 bound a grant to a digest, an
-- owner and a checkpoint revision — but nothing stopped a later UPDATE from
-- CHANGING any of them. Two probes defeated the whole approval mechanism with one
-- statement each:
--
--   PROBE 5 (un-consume):  UPDATE approvals SET consumed = false, consumed_at = NULL
--                          -> the single-use grant was consumable a SECOND time.
--   PROBE 6 (retarget):    UPDATE approvals SET action_digest = <other digest>
--                          -> consent given for payload A now authorized payload B,
--                             which is precisely the AC1 guarantee inverted.
--
-- `consume` fences on `consumed = false` and on `action_digest`, so it is correct in
-- itself. That is the point: the fences read durable state, and nothing was
-- protecting that state. `receipts` and `kill_switch_events` are already trigger-
-- guarded for the same reason (`ra_deny_mutation`, migration 008/015); `approvals`
-- was not, and it is the row that authorizes external writes.
--
-- WHY A TRIGGER AND NOT A CHECK. A CHECK constraint sees only the new row, so it
-- cannot express "this column may not change" or "false may not follow true". Both
-- rules are transitions, so they need OLD vs NEW — a BEFORE UPDATE trigger.
--
-- WHY NOT FULLY APPEND-ONLY. `approvals` legitimately takes exactly one UPDATE: the
-- consumption. So this is not `ra_deny_mutation`; it is narrower — the authorizing
-- terms are frozen, and the one mutable pair may only move in one direction.

CREATE OR REPLACE FUNCTION ra_guard_approval_immutability() RETURNS trigger AS $$
BEGIN
  -- 1. The authorizing terms are frozen at grant time. Each of these is something
  --    `consume` fences on, so a change here silently retargets or rescopes consent
  --    the owner already gave. `granted_by` and `granted_at` are audit facts and are
  --    frozen for the same reason: an audit trail that can be rewritten is not one.
  IF NEW.approval_id        IS DISTINCT FROM OLD.approval_id
     OR NEW.case_id         IS DISTINCT FROM OLD.case_id
     OR NEW.owner_id        IS DISTINCT FROM OLD.owner_id
     OR NEW.granted_by      IS DISTINCT FROM OLD.granted_by
     OR NEW.action_digest   IS DISTINCT FROM OLD.action_digest
     OR NEW.checkpoint_revision IS DISTINCT FROM OLD.checkpoint_revision
     OR NEW.granted_at      IS DISTINCT FROM OLD.granted_at
     OR NEW.expires_at      IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION
      'approval % is immutable once granted: its authorizing terms '
      '(case, owner, granting actor, action digest, checkpoint revision, grant '
      'instant, expiry) cannot be changed', OLD.approval_id
      USING ERRCODE = 'P0103';
  END IF;

  -- 2. Consumption is one-way. Un-consuming would make a single-use grant reusable,
  --    which defeats AC2's "approval is one-shot" outright.
  IF OLD.consumed = true AND NEW.consumed = false THEN
    RAISE EXCEPTION
      'approval % is single-use: a consumed grant cannot be un-consumed', OLD.approval_id
      USING ERRCODE = 'P0103';
  END IF;

  -- 3. A consumption instant, once recorded, is also frozen — otherwise the
  --    `granted_at <= consumed_at < expires_at` window the contract enforces could be
  --    rewritten after the fact to make an out-of-window use look legitimate.
  IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
    RAISE EXCEPTION
      'approval %: consumed_at is immutable once recorded', OLD.approval_id
      USING ERRCODE = 'P0103';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approvals_immutable_grant
  BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION ra_guard_approval_immutability();

-- A grant may not be deleted either: deleting a consumed grant and re-granting the
-- same id would launder a replay past the single-use fence, and deleting an
-- unconsumed one destroys the audit record of what the owner was asked. Migration
-- 008 already protects the row by FK from `external_actions` (ON DELETE RESTRICT),
-- but only once an action references it.
CREATE OR REPLACE FUNCTION ra_deny_approval_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'approval % cannot be deleted: approvals are an audit record',
    OLD.approval_id USING ERRCODE = 'P0103';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER approvals_no_delete
  BEFORE DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION ra_deny_approval_delete();

-- At most ONE live grant per canonical action per owner.
--
-- Also from the WU-02 probe (PROBE 4): single use is enforced per `approval_id`, so
-- two DIFFERENT approval_ids for the SAME digest were each consumable once — two
-- authorizations for one canonical action. `external_actions` bounds the external
-- side effect itself (UNIQUE `idempotency_key`, UNIQUE `action_digest`), so this was
-- not yet a double external write; but "how many times consent for this exact action
-- can be spent" is this table's own invariant and should not be borrowed from
-- another table's constraints.
--
-- Partial on `consumed = false`, which is what makes it correct rather than merely
-- strict: a fresh grant AFTER the previous one was consumed is legitimate (the owner
-- may approve the same action again later) and stays allowed, because consumed rows
-- leave the index. What is refused is a SECOND simultaneously-live grant, which is
-- redundant by construction — the live one already authorizes exactly that payload.
CREATE UNIQUE INDEX approvals_one_live_grant_per_action_idx
  ON approvals (case_id, owner_id, action_digest)
  WHERE consumed = false;
