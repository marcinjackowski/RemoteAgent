/**
 * Turning an owner's Discord button click into a durable grant or rejection
 * (RA-022-WU-04).
 *
 * The click arrives as an `ApprovalInteraction` carrying an `approval_id`, a
 * checkpoint revision and `grant`/`deny` — decoded by
 * `packages/discord/src/custom-id.ts`, which RA-006 already built and which already
 * encodes the revision. This module is the layer above: it decides whether the click
 * may become a grant, and it is deliberately small because most of the safety lives
 * in code that already existed.
 *
 * WHAT THE CLICK IS NOT TRUSTED FOR. Everything except "which proposal, at which
 * revision, and which way".
 *
 *  * **No digest.** The `custom_id` carries no `action_digest`, and this module does
 *    not accept one. A digest that made a round trip through a user-controlled
 *    surface is a digest that can be substituted; the digest is looked up
 *    server-side from the pending `external_actions` row instead. This is the RA-021
 *    lesson applied to the approval path: do not validate a value the caller
 *    supplies when you can derive the authoritative one.
 *  * **No owner.** The grant's scope comes from the CASE (via
 *    `ApprovalRepository.grant`, which reads `owner_id` from `cases`), not from who
 *    clicked. Discord authorization (`authorizeInbound`) has already established
 *    that the actor is the registry owner; the actor id is recorded as
 *    `granted_by` — an audit fact — and never used as the scope. WU-01's mutation
 *    check is why that distinction is stated twice.
 *  * **No tier and no policy decision.** Those were computed by the policy engine at
 *    proposal time and are already on the row. A click cannot change what was
 *    proposed; if it could, "approve" would be an edit.
 *
 * WHY A STALE REVISION IS REFUSED RATHER THAN RE-ASKED HERE. The revision in the
 * `custom_id` is the one the owner was LOOKING at. If the case has moved, the
 * message they read is out of date, so their consent does not apply to the current
 * facts. Recording it anyway would produce a grant that is stale at birth;
 * `ApprovalRepository.grant` refuses that, and this module surfaces it as its own
 * outcome so the caller can re-render the proposal instead of silently dropping it.
 */
import type {
  PolicyApprovalConsumption,
  PolicyApprovalGrantOutcome,
  PolicyApprovalRow,
  PolicyExternalActionRow,
  PolicyTransaction,
} from "./ingestion-ports.js";
import type { ApprovalIngestionPorts } from "./ingestion-ports.js";

/**
 * Bounds on how long a grant may live.
 *
 * Master Plan §10 requires an approval to be "short-lived", and the WU-04 adversarial
 * probe showed why that has to be enforced rather than trusted to a caller: a TTL of
 * `1e15` ms minted a grant valid for THIRTY-ONE THOUSAND YEARS. Nothing rejected it —
 * migration 008 only requires `expires_at > granted_at`, which an absurd expiry
 * satisfies comfortably. A grant that never expires defeats the point of an expiry:
 * it turns a momentary consent into a standing authorization that survives every
 * later change of circumstance.
 *
 * The upper bound is a day rather than something tighter because a legitimate owner
 * may approve something overnight; the lower bound exists so a grant cannot be born
 * already unusable, which would present as a mysterious `EXPIRED` at execution time.
 * Both are refused loudly rather than clamped: silently shortening a caller's TTL
 * would hide a configuration bug, and the `CTF-010` lesson is that quiet
 * accommodation is how wrong values survive.
 */
export const MIN_GRANT_TTL_MS = 30 * 1000;
export const MAX_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A grant TTL outside {@link MIN_GRANT_TTL_MS}..{@link MAX_GRANT_TTL_MS} was supplied.
 *
 * Thrown rather than returned as an outcome: an out-of-range TTL is a programming or
 * configuration error in OUR code, not something the owner did, so it must not be
 * rendered to them as a refusal reason.
 */
export class GrantTtlOutOfRangeError extends Error {
  public readonly ttlMs: number;

  public constructor(ttlMs: number) {
    super(
      `grant TTL ${ttlMs}ms is outside the permitted range ` +
        `${MIN_GRANT_TTL_MS}..${MAX_GRANT_TTL_MS}ms; an approval must be short-lived (Master Plan §10)`,
    );
    this.name = new.target.name;
    this.ttlMs = ttlMs;
  }
}

/** The decoded click, exactly as `decodeInteraction` produces it. */
export interface ApprovalClick {
  approvalId: string;
  checkpointRevision: number;
  choice: "grant" | "deny";
}

export interface IngestApprovalInput {
  /** The case the button's thread resolved to — established by Discord authorization. */
  caseId: string;
  /** Who clicked. Recorded as `granted_by`; NEVER used as the grant's scope. */
  actorId: string;
  /** The action the proposal message was rendered for. */
  actionId: string;
  click: ApprovalClick;
  /** How long the grant is valid once recorded. */
  grantTtlMs: number;
  /** Instant the TTL is measured from; supplied by the caller (see `PolicyInput.now`). */
  now: Date;
}

/**
 * Why an ingestion did not produce a grant, or the grant it produced.
 *
 * Every refusal has its own variant rather than a shared boolean, because the caller
 * has to render a DIFFERENT message for each: a stale click needs the proposal
 * re-rendered, an unknown action needs an error, a rejection needs an
 * acknowledgement. A single `false` would collapse all three into "something went
 * wrong".
 */
export type ApprovalIngestionOutcome =
  | { outcome: "GRANTED"; approval: PolicyApprovalRow; action: PolicyExternalActionRow }
  /** The owner pressed deny; the action is REJECTED and no grant exists. */
  | { outcome: "REJECTED"; action: PolicyExternalActionRow }
  /** No proposal with this id, or it is not in this case. */
  | { outcome: "ACTION_NOT_FOUND" }
  /**
   * The proposal is no longer awaiting an approval — already approved, rejected,
   * executing or finished. A double-click lands here, which is why it is distinct
   * from an error.
   */
  | { outcome: "ACTION_NOT_PENDING"; action: PolicyExternalActionRow }
  /** The action does not require an approval (AUTO_ALLOW or DENY); a click is meaningless. */
  | { outcome: "ACTION_NOT_APPROVABLE"; action: PolicyExternalActionRow }
  /** The case moved on since the message the owner was looking at was rendered. */
  | { outcome: "STALE_REVISION"; action: PolicyExternalActionRow; clicked: number; current: number }
  /** A live grant for this exact action already exists; the owner is being asked twice. */
  | { outcome: "ALREADY_GRANTED"; approval: PolicyApprovalRow; action: PolicyExternalActionRow };

/**
 * Ingest one approval click inside a caller-owned transaction.
 *
 * Takes a {@link PolicyTransaction}, not a pool: the proposal lookup, the grant and the
 * status change must be one atomic step. Otherwise a crash between them leaves either
 * an approval with no approved action, or an approved action with no grant — and the
 * second of those is an action an executor would try to perform.
 */
export async function ingestApprovalClick(
  tx: PolicyTransaction,
  ports: ApprovalIngestionPorts,
  input: IngestApprovalInput,
): Promise<ApprovalIngestionOutcome> {
  // Checked before anything is read or written: an out-of-range TTL is our bug, and
  // failing on it after a state change would leave the action modified by a call that
  // then threw. `Number.isFinite` first, because `Infinity` and `NaN` both slip past a
  // naive range comparison — `NaN` fails every `<` and `>` test, so a bare range check
  // would ACCEPT it and mint a grant with an `Invalid Date` expiry.
  if (
    !Number.isFinite(input.grantTtlMs) ||
    input.grantTtlMs < MIN_GRANT_TTL_MS ||
    input.grantTtlMs > MAX_GRANT_TTL_MS
  ) {
    throw new GrantTtlOutOfRangeError(input.grantTtlMs);
  }

  const action = await ports.actions.findById(tx, input.actionId);
  if (action === null || action.case_id !== input.caseId) {
    // Scoped by case as well as id: a proposal id observed in one case must not be
    // addressable from another case's thread.
    return { outcome: "ACTION_NOT_FOUND" };
  }
  if (action.policy_decision !== "REQUIRES_APPROVAL") {
    return { outcome: "ACTION_NOT_APPROVABLE", action };
  }
  if (action.status !== "PROPOSED") {
    return { outcome: "ACTION_NOT_PENDING", action };
  }

  if (input.click.choice === "deny") {
    // A rejection records the owner's refusal and mints NOTHING. There is deliberately
    // no "negative approval" row: the absence of a grant is what stops execution, so
    // representing a denial as a consumed grant would make the two paths differ only
    // by a flag.
    const rejected = await ports.actions.reject(tx, action.action_id);
    if (!rejected) {
      // Lost a race with another writer; report the action's real state rather than
      // claiming a rejection that did not happen.
      const current = await ports.actions.findById(tx, input.actionId);
      return { outcome: "ACTION_NOT_PENDING", action: current ?? action };
    }
    return { outcome: "REJECTED", action: { ...action, status: "REJECTED" } };
  }

  // The digest comes from the STORE, not from the click.
  const granted = await ports.approvals.grant(tx, {
    approvalId: input.click.approvalId,
    caseId: input.caseId,
    grantedBy: input.actorId,
    actionDigest: action.action_digest,
    checkpointRevision: input.click.checkpointRevision,
    expiresAt: new Date(input.now.getTime() + input.grantTtlMs),
  });

  switch (granted.outcome) {
    case "GRANTED": {
      // Bind the grant to the action in the SAME transaction. `attachApproval` is
      // fenced on `status = 'PROPOSED' AND approval_id IS NULL`, so if a concurrent
      // click already bound one, this fails and the whole transaction is rolled back
      // by the caller — leaving no orphan grant.
      const attached = await ports.actions.attachApproval(tx, {
        actionId: action.action_id,
        approvalId: granted.row.approval_id,
      });
      if (!attached) {
        throw new ApprovalIngestionConflictError(action.action_id);
      }
      return {
        outcome: "GRANTED",
        approval: granted.row,
        action: { ...action, status: "APPROVED", approval_id: granted.row.approval_id },
      };
    }
    case "ALREADY_GRANTED": {
      // The same button clicked twice. Idempotent: the existing grant is returned and
      // nothing new is minted.
      return { outcome: "ALREADY_GRANTED", approval: granted.row, action };
    }
    case "LIVE_GRANT_EXISTS": {
      // A DIFFERENT approval id already holds a live grant for this exact canonical
      // action (migration 030). Reported as already-granted from the owner's point of
      // view, because their intent is satisfied — pointing them at the existing grant
      // is more useful than an error.
      return { outcome: "ALREADY_GRANTED", approval: granted.row, action };
    }
    case "STALE_REVISION": {
      return {
        outcome: "STALE_REVISION",
        action,
        clicked: granted.requested,
        current: granted.current,
      };
    }
    case "CASE_NOT_FOUND": {
      return { outcome: "ACTION_NOT_FOUND" };
    }
    default: {
      // Exhaustiveness guard: a new grant outcome must be handled explicitly rather
      // than falling into a permissive branch.
      const exhaustive: never = granted;
      throw new Error(`unhandled grant outcome: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * A grant was recorded but could not be bound to its action, because a concurrent
 * writer changed the action's state.
 *
 * Thrown rather than returned so the caller's transaction ROLLS BACK: a grant that
 * exists without being attached to the action it authorizes is exactly the orphan
 * this module's single-transaction design exists to prevent.
 */
export class ApprovalIngestionConflictError extends Error {
  public readonly actionId: string;

  public constructor(actionId: string) {
    super(
      `action ${actionId} changed state while its approval was being granted; ` +
        `rolling back so no unattached grant survives`,
    );
    this.name = new.target.name;
    this.actionId = actionId;
  }
}

export type { PolicyApprovalConsumption, PolicyApprovalGrantOutcome };
