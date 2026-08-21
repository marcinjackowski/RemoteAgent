/**
 * The deterministic policy engine: which external write is allowed, which needs an
 * exact owner approval, and which is refused outright (RA-022-WU-03).
 *
 * This module is PURE. It takes an authoritative snapshot and returns a decision;
 * it opens no transaction, reads no clock of its own and performs no side effect.
 * That is a deliberate testability property — every branch below is reachable from
 * a plain object literal — but it is mainly an authority property: a decision that
 * depends only on its inputs can be recomputed identically before execution, which
 * is what AC3 ("policy is evaluated at proposal AND immediately before execute")
 * requires. An evaluator that consulted the database itself could not be re-run
 * cheaply at the execution boundary, and the second check would drift from the
 * first.
 *
 * THREE THINGS THE MODEL CANNOT DO HERE, each a reaction to a specific defect:
 *
 *  1. **The model cannot state a risk tier.** The tier is looked up from the
 *     server-owned {@link ACTION_REGISTRY} by tool name. This is the RA-021
 *     registry lesson: RA-012's `POLICY_NOT_EXTENSIBLE` defect was one inverted
 *     comparison in code that validated a model-supplied value, so the fix is not a
 *     better check — it is removing the value from model output entirely.
 *  2. **A remote tool annotation cannot lower a tier.** MCP descriptors carry
 *     hints like `readOnlyHint`. Those arrive from a remote server over an
 *     untrusted channel and are advisory metadata, never authorization. An
 *     annotation claiming a lower tier than the registry is not merely ignored —
 *     it is a REFUSAL, because something is wrong upstream and proceeding on the
 *     registry value would hide it (AC5).
 *  3. **An unknown tool is R4, not R0.** A tool absent from the registry has no
 *     established blast radius, and "no declaration" is not consent — the
 *     `CTF-010` finding 4 pattern that produced two HIGH defects in RA-014.
 *
 * WHY DENY IS EVALUATED BEFORE TIER. A kill switch, an unhealthy connection or an
 * out-of-scope target refuses the action regardless of how benign its tier is.
 * Ordering the other way round would let an R0 action slip past an active operator
 * stop.
 */
import {
  PolicyDecision,
  RiskTier,
  type Provider,
  type ConnectionHealth,
} from "@remoteagent/contracts";

import { ConnectionBlockedError, assertConnectionEffectAllowed } from "./connection-guard.js";
import type { KillSwitchState } from "./connection-guard.js";

/**
 * Every external write this task knows how to perform, with its server-owned risk
 * tier (Master Plan §10).
 *
 * The registry is keyed by the canonical tool name and is the ONLY source of a
 * tier. It is intentionally a closed allowlist rather than a pattern match on the
 * name: `jira.issue.*` would silently absorb a future `jira.issue.delete` at
 * whatever tier the pattern happened to assign.
 *
 * Tier assignments follow Master Plan §10 and the RA-022 scope note that R4 is
 * always merge, force-push, delete, prod deploy and permissions.
 */
export const ACTION_REGISTRY: Readonly<Record<string, RiskTier>> = Object.freeze({
  // R2 — drafts and case-branch pushes: visible to the owner, reversible, and not
  // yet communicated to anyone outside.
  "gitlab.mr.draft.update": RiskTier.R2,
  "gmail.draft.create": RiskTier.R2,

  // R3 — a real external effect another human can see. Master Plan §10 puts these
  // at "exact approval or an explicit rule".
  "jira.issue.comment": RiskTier.R3,
  "jira.issue.transition": RiskTier.R3,
  "gitlab.mr.comment": RiskTier.R3,
  "calendar.event.create": RiskTier.R3,
  "calendar.event.update": RiskTier.R3,
  "calendar.event.respond": RiskTier.R3,

  // R4 — irreversible, or an escalation of authority. Always an exact approval,
  // never auto-allowed, enforced additionally by the migration-008 CHECK and by
  // the `externalAction` contract.
  "gitlab.mr.merge": RiskTier.R4,
  "git.push.force": RiskTier.R4,
  "jira.issue.delete": RiskTier.R4,
  "calendar.event.delete": RiskTier.R4,
  "gitlab.branch.delete": RiskTier.R4,
});

/**
 * Tiers that may execute without an owner approval when nothing else refuses them.
 *
 * R0 (reads) and R1 (sandbox-local effects) are not external writes and do not
 * reach this engine; they are listed so the boundary is stated rather than implied
 * by omission. R2 is auto-allowed because Master Plan §10 assigns it to an owner
 * scope grant, which is exactly what the case's authoritative scope represents —
 * and the scope check below has already been applied by the time a tier is
 * consulted.
 */
const AUTO_ALLOWED_TIERS: readonly RiskTier[] = [RiskTier.R0, RiskTier.R1, RiskTier.R2];

/**
 * Tiers that ALWAYS require an exact owner approval, with no configuration that can
 * relax them.
 *
 * R4 is in this set as an invariant, not as a default: {@link evaluatePolicy} never
 * consults any input that could move it, and the assertion in
 * {@link assertR4NeverAutoAllowed} is a second, independent statement of the same
 * rule. Two mechanisms because AC5 is the one criterion in this task whose failure
 * has no recovery — an auto-approved merge cannot be un-merged by a policy fix.
 */
const APPROVAL_REQUIRED_TIERS: readonly RiskTier[] = [RiskTier.R3, RiskTier.R4];

/**
 * A kill-switch state carrying the identity of the event it came from.
 *
 * Extends the accepted RA-005 {@link KillSwitchState} rather than modifying it: the
 * guard does not need an id to decide, but the policy engine must RECORD which
 * events it observed, because AC3 is about proving that the pre-execute snapshot is
 * the same one the proposal was decided on. "A switch was active" is not evidence;
 * "these event ids, newest per level" is. `kill_switch_events` is append-only, so
 * an id is a stable reference to an immutable row.
 */
export interface PolicyKillSwitchState extends KillSwitchState {
  eventId: string;
}

/** Why an action was refused. Specific codes, so a test cannot assert on a class. */
export const PolicyRefusalCode = {
  /** An operator kill switch is active at global, provider or connection level. */
  KILL_SWITCH_ACTIVE: "KILL_SWITCH_ACTIVE",
  /** The connection's credential is revoked, expired or unhealthy. */
  CONNECTION_BLOCKED: "CONNECTION_BLOCKED",
  /** The connection is not a member of this case's authoritative scope. */
  CONNECTION_OUT_OF_SCOPE: "CONNECTION_OUT_OF_SCOPE",
  /** The tool is not in the server-owned registry, so its blast radius is unknown. */
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  /**
   * A remote descriptor or caller-supplied annotation asserted a tier lower than
   * the registry's. Refused rather than ignored: the mismatch means something
   * upstream is wrong or hostile, and silently proceeding would hide it.
   */
  TIER_DOWNGRADE_ATTEMPT: "TIER_DOWNGRADE_ATTEMPT",
  /** The proposed action's digest does not match its canonical payload. */
  DIGEST_MISMATCH: "DIGEST_MISMATCH",
} as const;

export type PolicyRefusalCode = (typeof PolicyRefusalCode)[keyof typeof PolicyRefusalCode];

/**
 * The authoritative snapshot a decision is computed from.
 *
 * Everything here is server-owned. Notably absent: any field a model could fill in.
 * There is no `risk_tier`, no `policy_decision`, no `connection_id` chosen by the
 * caller-as-model — the tier comes from the registry and the connection is checked
 * against the case's grants.
 */
export interface PolicyInput {
  /** Canonical tool name; the registry key. */
  toolName: string;
  caseId: string;
  ownerId: string;
  provider: Provider;
  /** The connection deterministic code selected for this action. */
  connectionId: string;
  /** Connection ids this case is actually scoped to (RA-005 authoritative scope). */
  caseConnectionIds: readonly string[];
  connectionHealth: ConnectionHealth;
  /** Credential expiry, or null when the credential does not expire. */
  credentialExpiresAt: Date | null;
  /**
   * The effective kill-switch states for (owner, provider, connection), newest per
   * level. Passed in rather than read here so the CALLER controls the transaction
   * this snapshot came from — AC6 requires the pre-execute evaluation to read the
   * switch in the same transaction that consumes the approval, and a pure function
   * cannot enforce that. {@link evaluatePolicy} therefore records the snapshot it
   * used in its output, so the executor can prove which one it acted on.
   */
  killSwitches: readonly PolicyKillSwitchState[];
  /**
   * Instant to evaluate credential expiry against.
   *
   * **The caller must derive this from the DATABASE clock, not from `new Date()`.**
   * A pure evaluator cannot read a clock, so this is the one input it must trust —
   * and the WU-03 probe confirmed the consequence: a backdated `now` turns a refused,
   * expired credential into `REQUIRES_APPROVAL`. That is not a defect this function
   * can close (it is the same shape as the RA-005 guard it delegates to, which takes
   * `now` for the same reason), so it is closed at the boundary that HAS a clock:
   * `WU-05`'s executor reads `now()` inside the execution transaction and passes it
   * here, exactly as `ApprovalRepository.consume` compares `expires_at > now()` in
   * SQL rather than in TypeScript (AUDIT-04 HIGH-08).
   *
   * A worker with a skewed or hostile clock is therefore contained by the executor,
   * and this comment exists so a future caller does not reintroduce the gap by
   * passing a process timestamp.
   */
  now: Date;
  /**
   * A tier asserted by a remote tool descriptor or annotation, if any.
   *
   * Accepted as an input ONLY so the engine can detect and refuse a downgrade
   * attempt. It never contributes to the decision. `unknown` rather than
   * `RiskTier` on purpose: the value arrives from an untrusted remote channel, so
   * typing it as a valid tier would be a claim this code cannot make.
   */
  annotatedRiskTier?: unknown;
}

/** The decision, plus everything needed to prove why it was reached. */
export interface PolicyEvaluation {
  decision: PolicyDecision;
  /** The server-owned tier the decision was based on. */
  riskTier: RiskTier;
  /** Present exactly when `decision` is DENY. */
  refusalCode: PolicyRefusalCode | null;
  /** Human-readable reason; for the audit log, never for a control-flow decision. */
  reason: string;
  /**
   * Evidence the decision was computed from, recorded so the second (pre-execute)
   * evaluation can be compared against the first. AC3 is about detecting that
   * something CHANGED between the two, which requires the first to be recorded.
   */
  evidence: {
    toolName: string;
    caseId: string;
    connectionId: string;
    /** Ids of the kill-switch events observed, newest per level. */
    killSwitchEventIds: readonly string[];
    /** Whether any observed switch was enabled. */
    killSwitchActive: boolean;
  };
}

/**
 * Resolve the server-owned risk tier for a tool name.
 *
 * An unregistered tool resolves to `null`, which {@link evaluatePolicy} turns into a
 * refusal. It deliberately does NOT default to R4-and-proceed: an unknown tool has
 * no known payload shape either, so treating it as "merely dangerous" would still
 * hand it to an executor.
 */
export function resolveRiskTier(toolName: string): RiskTier | null {
  return Object.hasOwn(ACTION_REGISTRY, toolName) ? ACTION_REGISTRY[toolName]! : null;
}

/**
 * Evaluate policy for one proposed external action.
 *
 * Deterministic and side-effect free: the same snapshot always yields the same
 * decision, which is what lets the executor re-run it immediately before the side
 * effect and compare (AC3).
 */
export function evaluatePolicy(input: PolicyInput): PolicyEvaluation {
  // ANY enabled switch in the snapshot counts, regardless of the scope it names.
  //
  // The RA-005 guard matches a CONNECTION-level switch on provider AND connection
  // id, which is correct for its own purpose but leaves a gap here: an action whose
  // `provider` disagrees with the switch's slips past a stop that was appended for
  // the very connection it is about to write to. The WU-03 probe hit this — a
  // `CONNECTION` switch on (`jira`, `conn-a`) did not stop an action on `conn-a`
  // declaring provider `gitlab`.
  //
  // The caller obtained this list from `listEffective` for (owner, provider,
  // connection), so every entry in it is by construction applicable to THIS action.
  // Re-filtering it by provider here can only ever discard a switch the query
  // already decided was relevant, so the safe reading of a present, enabled switch
  // is "stop", not "stop if the fields also line up".
  const killSwitchActive = input.killSwitches.some((state) => state.enabled);
  const evidence = {
    toolName: input.toolName,
    caseId: input.caseId,
    connectionId: input.connectionId,
    // Sorted, so an evaluation is invariant to the order the caller passed the
    // switches in. `listEffective` orders by sequence, but AC3 compares two
    // independently-built snapshots and a pure reordering is not a policy change —
    // the probe showed it produced a FALSE mismatch, which would block a legitimate
    // execution and is the fail-OPEN-looking failure that erodes trust in the check.
    killSwitchEventIds: [...input.killSwitches].map((state) => state.eventId).sort(),
    killSwitchActive,
  } as const;

  const deny = (refusalCode: PolicyRefusalCode, reason: string): PolicyEvaluation => ({
    decision: PolicyDecision.DENY,
    // A refused action still reports its tier when one is known, so the audit log
    // records what was attempted. An unknown tool reports R4: the most restrictive
    // tier is the honest answer when the blast radius cannot be established.
    riskTier: resolveRiskTier(input.toolName) ?? RiskTier.R4,
    refusalCode,
    reason,
    evidence,
  });

  // 1. Any enabled switch in the applicable snapshot stops the action, checked
  //    BEFORE the RA-005 guard and before any tier lookup.
  //
  //    Before the guard, because the guard's scope matching would let a
  //    provider-mismatched action through (see the note on `killSwitchActive`).
  //    Before the tier, because an operator stop must reject an R0 read as firmly as
  //    an R4 merge — a tier lookup running first would auto-allow R2 during a stop.
  if (killSwitchActive) {
    const active = input.killSwitches.find((state) => state.enabled)!;
    return deny(
      PolicyRefusalCode.KILL_SWITCH_ACTIVE,
      `new external effects are disabled by ${active.level} kill switch: ${active.reason}`,
    );
  }

  // 2. Connection health and credential expiry, via the RA-005 guard, so there is
  //    one implementation of "may this connection produce an effect at all" rather
  //    than a second copy of its precedence rules here.
  try {
    assertConnectionEffectAllowed({
      connectionId: input.connectionId,
      provider: input.provider,
      health: input.connectionHealth,
      expiresAt: input.credentialExpiresAt,
      now: input.now,
      killSwitches: input.killSwitches,
    });
  } catch (error) {
    if (error instanceof ConnectionBlockedError) {
      // Reached only when no switch was enabled (step 1 returned otherwise), so this
      // is unambiguously a credential/health refusal. Kept as a distinct code from
      // KILL_SWITCH_ACTIVE because an operator stop and a dead credential need
      // different operator responses.
      return deny(PolicyRefusalCode.CONNECTION_BLOCKED, error.message);
    }
    throw error;
  }

  // 3. The connection must belong to this case. RA-005 makes the membership
  //    authoritative and durable; this is the policy-layer statement of it, so an
  //    action naming a connection the case was never granted is refused here rather
  //    than discovered at the provider.
  if (!input.caseConnectionIds.includes(input.connectionId)) {
    return deny(
      PolicyRefusalCode.CONNECTION_OUT_OF_SCOPE,
      `connection ${input.connectionId} is not in the authoritative scope of case ${input.caseId}`,
    );
  }

  // 4. Tier from the server-owned registry — never from the caller.
  const riskTier = resolveRiskTier(input.toolName);
  if (riskTier === null) {
    return deny(
      PolicyRefusalCode.UNKNOWN_ACTION,
      `tool ${input.toolName} is not in the server-owned action registry; an unregistered action has no established risk tier`,
    );
  }

  // 5. A remote annotation may not lower the tier. Checked AFTER the registry
  //    lookup so the comparison is against the authoritative value, and refused
  //    rather than ignored (AC5).
  if (input.annotatedRiskTier !== undefined) {
    const annotated = input.annotatedRiskTier;
    if (isRiskTier(annotated) && tierRank(annotated) < tierRank(riskTier)) {
      return {
        decision: PolicyDecision.DENY,
        riskTier,
        refusalCode: PolicyRefusalCode.TIER_DOWNGRADE_ATTEMPT,
        reason:
          `a tool annotation claimed ${annotated} for ${input.toolName}, but the server-owned ` +
          `registry assigns ${riskTier}; an annotation cannot lower a risk tier`,
        evidence,
      };
    }
  }

  // 6. Tier decides. R4 can only reach REQUIRES_APPROVAL: it is in
  //    APPROVAL_REQUIRED_TIERS and no input above can move it there.
  if (APPROVAL_REQUIRED_TIERS.includes(riskTier)) {
    return {
      decision: PolicyDecision.REQUIRES_APPROVAL,
      riskTier,
      refusalCode: null,
      reason:
        riskTier === RiskTier.R4
          ? `${riskTier} always requires an exact owner approval (Master Plan §10)`
          : `${riskTier} produces an externally-visible effect and requires an exact owner approval`,
      evidence,
    };
  }

  if (AUTO_ALLOWED_TIERS.includes(riskTier)) {
    return {
      decision: PolicyDecision.AUTO_ALLOW,
      riskTier,
      refusalCode: null,
      reason: `${riskTier} is within the owner's standing scope grant for this case`,
      evidence,
    };
  }

  // Unreachable while every RiskTier is in exactly one of the two sets above. Kept
  // as a fail-closed default rather than an exhaustiveness `never`, because the
  // failure mode of a future tier being added to neither set must be DENY, not a
  // compile error that a rushed change might suppress.
  return deny(
    PolicyRefusalCode.UNKNOWN_ACTION,
    `risk tier ${riskTier} has no policy rule; refusing fail-closed`,
  );
}

/**
 * Assert the AC5 invariant over the WHOLE registry: no R4 action can be
 * auto-allowed, for any snapshot.
 *
 * This is not a test helper — it is a second, independent statement of the rule
 * that {@link evaluatePolicy} implements through `APPROVAL_REQUIRED_TIERS`, and it
 * is exported so a caller assembling a registry (or a future task widening it) can
 * run it as a startup check. AC5's failure mode is unrecoverable, so it gets two
 * mechanisms rather than one, matching how migration 008 states the same rule in
 * SQL.
 *
 * @throws {Error} if any R4 entry could ever be auto-allowed.
 */
export function assertR4NeverAutoAllowed(
  registry: Readonly<Record<string, RiskTier>> = ACTION_REGISTRY,
): void {
  for (const [toolName, tier] of Object.entries(registry)) {
    if (tier !== RiskTier.R4) continue;
    if (AUTO_ALLOWED_TIERS.includes(tier)) {
      throw new Error(
        `AC5 violation: ${toolName} is R4 but R4 appears in the auto-allowed tier set`,
      );
    }
    if (!APPROVAL_REQUIRED_TIERS.includes(tier)) {
      throw new Error(
        `AC5 violation: ${toolName} is R4 but R4 is not in the approval-required tier set`,
      );
    }
  }
}

/**
 * Project persisted `kill_switch_events` rows into the engine's snapshot type.
 *
 * Lives here rather than in `packages/database` so this package keeps no dependency
 * on it (the cycle recorded in WU-01), and takes a structural row type rather than
 * importing `KillSwitchEventRow` for the same reason. The caller supplies rows from
 * `KillSwitchRepository.listEffective`, which already returns the newest event per
 * applicable level — this function does not re-derive that, it only reshapes.
 */
export function toPolicyKillSwitches(
  rows: readonly {
    event_id: string;
    scope_level: "GLOBAL" | "PROVIDER" | "CONNECTION";
    provider: Provider | null;
    connection_id: string | null;
    enabled: boolean;
    reason: string;
  }[],
): PolicyKillSwitchState[] {
  return rows.map((row) => ({
    eventId: row.event_id,
    level: row.scope_level,
    provider: row.provider,
    connectionId: row.connection_id,
    enabled: row.enabled,
    reason: row.reason,
  }));
}

/**
 * Whether two evaluations agree on everything that authorizes execution.
 *
 * The executor calls this to satisfy AC3: policy is evaluated at proposal and again
 * immediately before the side effect, and the two must MATCH. Comparing the decision
 * alone is not enough — a kill switch that was appended and then disabled again
 * yields the same decision from a different snapshot, and an action whose tier moved
 * (a registry change during a deploy) would also pass a decision-only comparison.
 *
 * `reason` is deliberately NOT compared: it is audit prose, and making it
 * load-bearing would turn a message edit into a policy change.
 */
export function policyEvaluationsAgree(first: PolicyEvaluation, second: PolicyEvaluation): boolean {
  return (
    first.decision === second.decision &&
    first.riskTier === second.riskTier &&
    first.refusalCode === second.refusalCode &&
    first.evidence.toolName === second.evidence.toolName &&
    first.evidence.caseId === second.evidence.caseId &&
    first.evidence.connectionId === second.evidence.connectionId &&
    first.evidence.killSwitchActive === second.evidence.killSwitchActive &&
    first.evidence.killSwitchEventIds.length === second.evidence.killSwitchEventIds.length &&
    first.evidence.killSwitchEventIds.every(
      (id, index) => id === second.evidence.killSwitchEventIds[index],
    )
  );
}

/** Ordering over tiers, so "lower" in a downgrade attempt has a precise meaning. */
function tierRank(tier: RiskTier): number {
  switch (tier) {
    case RiskTier.R0:
      return 0;
    case RiskTier.R1:
      return 1;
    case RiskTier.R2:
      return 2;
    case RiskTier.R3:
      return 3;
    case RiskTier.R4:
      return 4;
  }
}

/** Narrow an untrusted value to a known tier without trusting its type. */
function isRiskTier(value: unknown): value is RiskTier {
  return (
    value === RiskTier.R0 ||
    value === RiskTier.R1 ||
    value === RiskTier.R2 ||
    value === RiskTier.R3 ||
    value === RiskTier.R4
  );
}
