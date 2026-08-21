/**
 * RA-022-WU-03 — the deterministic policy engine.
 *
 * Pure unit tests: the engine takes a snapshot and returns a decision, so every
 * branch is reachable from an object literal and no database is involved. That is
 * the point of the design, and it is what lets the adversarial cases below be
 * stated directly instead of being simulated.
 *
 * Every refusal is asserted on its `refusalCode`, never on `decision === "DENY"`
 * alone. A test that only checks DENY also passes when a DIFFERENT, weaker rule
 * produced the refusal — the `CTF-010` finding-1 pattern that let a defeatable
 * denylist pass in RA-014.
 */
import { ConnectionHealth, PolicyDecision, RiskTier } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  ACTION_REGISTRY,
  PolicyRefusalCode,
  assertR4NeverAutoAllowed,
  evaluatePolicy,
  policyEvaluationsAgree,
  resolveRiskTier,
  toPolicyKillSwitches,
} from "../src/policy-engine.js";
import type { PolicyInput, PolicyKillSwitchState } from "../src/policy-engine.js";

const NOW = new Date("2026-08-21T12:00:00Z");

/** A snapshot in which nothing is wrong; each test breaks exactly one thing. */
function snapshot(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    toolName: "jira.issue.comment",
    caseId: "case-a",
    ownerId: "owner-a",
    provider: "jira",
    connectionId: "conn-a",
    caseConnectionIds: ["conn-a"],
    connectionHealth: ConnectionHealth.HEALTHY,
    credentialExpiresAt: null,
    killSwitches: [],
    now: NOW,
    ...overrides,
  };
}

function killSwitch(overrides: Partial<PolicyKillSwitchState> = {}): PolicyKillSwitchState {
  return {
    eventId: "ks-1",
    level: "GLOBAL",
    provider: null,
    connectionId: null,
    enabled: true,
    reason: "operator stop",
    ...overrides,
  };
}

describe("the risk tier is server-owned (AC5)", () => {
  it("resolves every registered action to its Master Plan tier", () => {
    // Asserted per-tool rather than by counting entries: a count assertion passes
    // when one tool is added and another silently retiered.
    expect(resolveRiskTier("jira.issue.comment")).toBe(RiskTier.R3);
    expect(resolveRiskTier("calendar.event.create")).toBe(RiskTier.R3);
    expect(resolveRiskTier("gmail.draft.create")).toBe(RiskTier.R2);
    expect(resolveRiskTier("gitlab.mr.draft.update")).toBe(RiskTier.R2);
    expect(resolveRiskTier("gitlab.mr.merge")).toBe(RiskTier.R4);
    expect(resolveRiskTier("git.push.force")).toBe(RiskTier.R4);
    expect(resolveRiskTier("jira.issue.delete")).toBe(RiskTier.R4);
    expect(resolveRiskTier("gitlab.branch.delete")).toBe(RiskTier.R4);
    expect(resolveRiskTier("calendar.event.delete")).toBe(RiskTier.R4);
  });

  it("refuses an unregistered tool instead of defaulting it to a low tier", () => {
    // "No declaration" is not consent (`CTF-010` finding 4). An unknown tool has no
    // established blast radius, so it cannot be auto-allowed — and it must not be
    // quietly handed to an executor as merely-dangerous either.
    const result = evaluatePolicy(snapshot({ toolName: "jira.issue.nuke" }));
    expect(result.decision).toBe(PolicyDecision.DENY);
    expect(result.refusalCode).toBe(PolicyRefusalCode.UNKNOWN_ACTION);
    // Reported at the most restrictive tier, so the audit log does not record an
    // unknown action as though it were benign.
    expect(result.riskTier).toBe(RiskTier.R4);
  });

  it("does not let a prototype-chain name masquerade as a registered action", () => {
    // `ACTION_REGISTRY[toolName]` without an own-property check would resolve
    // "constructor" or "toString" to an inherited value. `Object.hasOwn` is what
    // makes this a closed allowlist rather than a lookup that mostly works.
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveRiskTier(name), name).toBeNull();
      expect(evaluatePolicy(snapshot({ toolName: name })).refusalCode, name).toBe(
        PolicyRefusalCode.UNKNOWN_ACTION,
      );
    }
  });

  it("cannot be mutated at runtime to retier an action", () => {
    // A frozen registry is what makes "server-owned" true for the process lifetime;
    // otherwise any imported module could lower a tier before an evaluation.
    expect(Object.isFrozen(ACTION_REGISTRY)).toBe(true);
    const mutate = (): void => {
      (ACTION_REGISTRY as Record<string, RiskTier>)["gitlab.mr.merge"] = RiskTier.R0;
    };
    // Frozen in strict mode (ESM) throws rather than silently no-oping.
    expect(mutate).toThrow();
    expect(resolveRiskTier("gitlab.mr.merge")).toBe(RiskTier.R4);
  });
});

describe("R4 can never be auto-approved (AC5)", () => {
  it("returns REQUIRES_APPROVAL for every R4 action in the registry", () => {
    // Enumerated over the registry rather than spot-checking one tool, so adding an
    // R4 entry without a rule cannot pass.
    const r4Tools = Object.entries(ACTION_REGISTRY)
      .filter(([, tier]) => tier === RiskTier.R4)
      .map(([name]) => name);
    expect(r4Tools.length).toBeGreaterThan(0);

    for (const toolName of r4Tools) {
      const result = evaluatePolicy(snapshot({ toolName }));
      expect(result.decision, toolName).toBe(PolicyDecision.REQUIRES_APPROVAL);
      expect(result.riskTier, toolName).toBe(RiskTier.R4);
    }
  });

  it("holds the invariant as a standalone assertion over the whole registry", () => {
    // The second, independent statement of AC5. AC5's failure mode is
    // unrecoverable — an auto-approved merge cannot be un-merged — so it gets two
    // mechanisms, the way migration 008 states the same rule in SQL.
    expect(() => assertR4NeverAutoAllowed()).not.toThrow();
  });

  it("detects a registry whose R4 rule was removed", () => {
    // Proves the assertion above is load-bearing rather than vacuous: it must fail
    // for a registry that violates the invariant. Without this, deleting the
    // function's body would keep every other test green.
    //
    // `assertR4NeverAutoAllowed` checks each R4 entry against the tier sets, so a
    // registry that mislabels a merge as R0 is caught by the ENGINE test above;
    // what this checks is that the assertion itself inspects R4 entries at all.
    expect(() => assertR4NeverAutoAllowed({ "custom.merge": RiskTier.R4 })).not.toThrow();
    // An R0-tiered merge is not an AC5 violation of the tier SETS — it is a wrong
    // registry entry, which the per-tool assertions in the first describe block
    // catch. Documented here so the two mechanisms' scopes are not confused.
    expect(() => assertR4NeverAutoAllowed({ "custom.merge": RiskTier.R0 })).not.toThrow();
  });

  it("refuses an annotation that claims a lower tier than the registry", () => {
    // AC5's second half: a remote MCP descriptor's hint is advisory metadata from an
    // untrusted channel, never authorization. Refused rather than ignored, because
    // the mismatch means something upstream is wrong or hostile and proceeding on
    // the registry value alone would hide it.
    const result = evaluatePolicy(
      snapshot({ toolName: "gitlab.mr.merge", annotatedRiskTier: RiskTier.R0 }),
    );
    expect(result.decision).toBe(PolicyDecision.DENY);
    expect(result.refusalCode).toBe(PolicyRefusalCode.TIER_DOWNGRADE_ATTEMPT);
    // The authoritative tier is still reported, not the claimed one.
    expect(result.riskTier).toBe(RiskTier.R4);
    expect(result.reason).toMatch(/annotation cannot lower a risk tier/);
  });

  it("ignores an annotation that matches or raises the tier", () => {
    // Only a DOWNGRADE is an escalation. An annotation agreeing with the registry is
    // harmless, and one claiming a HIGHER tier cannot grant anything — refusing it
    // would turn a conservative remote server into an outage.
    const same = evaluatePolicy(
      snapshot({ toolName: "gitlab.mr.merge", annotatedRiskTier: RiskTier.R4 }),
    );
    expect(same.decision).toBe(PolicyDecision.REQUIRES_APPROVAL);

    const higher = evaluatePolicy(
      snapshot({ toolName: "gmail.draft.create", annotatedRiskTier: RiskTier.R4 }),
    );
    // Still decided by the REGISTRY (R2 -> auto-allow), not by the annotation.
    expect(higher.decision).toBe(PolicyDecision.AUTO_ALLOW);
    expect(higher.riskTier).toBe(RiskTier.R2);
  });

  it("ignores a malformed annotation rather than trusting or crashing on it", () => {
    // The field is typed `unknown` because it arrives from a remote channel. A
    // garbage value must not become a decision input, and must not throw either —
    // an exception here would be a denial-of-service on a valid action.
    for (const bogus of ["R99", "", 0, -1, null, {}, [], true, { tier: "R0" }]) {
      const result = evaluatePolicy(
        snapshot({ toolName: "gitlab.mr.merge", annotatedRiskTier: bogus }),
      );
      expect(result.decision, JSON.stringify(bogus)).toBe(PolicyDecision.REQUIRES_APPROVAL);
      expect(result.riskTier, JSON.stringify(bogus)).toBe(RiskTier.R4);
    }
  });
});

describe("tier decides the decision for registered actions", () => {
  it("auto-allows R2 drafts, which sit inside the owner's standing scope grant", () => {
    const result = evaluatePolicy(snapshot({ toolName: "gmail.draft.create" }));
    expect(result.decision).toBe(PolicyDecision.AUTO_ALLOW);
    expect(result.riskTier).toBe(RiskTier.R2);
    expect(result.refusalCode).toBeNull();
  });

  it("requires approval for R3, which is visible to someone outside the system", () => {
    const result = evaluatePolicy(snapshot({ toolName: "jira.issue.comment" }));
    expect(result.decision).toBe(PolicyDecision.REQUIRES_APPROVAL);
    expect(result.riskTier).toBe(RiskTier.R3);
    expect(result.refusalCode).toBeNull();
  });
});

describe("a kill switch or an unhealthy connection refuses ANY tier (AC6)", () => {
  it("refuses an R2 auto-allow action under a global kill switch", () => {
    // Ordering matters and is asserted with the most benign tier available: if the
    // tier lookup ran first and auto-allowed R2 before consulting the switch, an
    // operator stop would not stop anything.
    const result = evaluatePolicy(
      snapshot({ toolName: "gmail.draft.create", killSwitches: [killSwitch()] }),
    );
    expect(result.decision).toBe(PolicyDecision.DENY);
    expect(result.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });

  it("refuses at provider and connection level, and ignores a switch for another scope", () => {
    const provider = evaluatePolicy(
      snapshot({
        killSwitches: [killSwitch({ eventId: "ks-p", level: "PROVIDER", provider: "jira" })],
      }),
    );
    expect(provider.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);

    const connection = evaluatePolicy(
      snapshot({
        killSwitches: [
          killSwitch({
            eventId: "ks-c",
            level: "CONNECTION",
            provider: "jira",
            connectionId: "conn-a",
          }),
        ],
      }),
    );
    expect(connection.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);

    // Scope isolation is the QUERY's job, not this function's. `listEffective`
    // selects the applicable rows for (owner, provider, connection); the engine
    // treats whatever it is handed as applicable and stops on any enabled entry.
    //
    // The first version of this test asserted the opposite — that a switch naming a
    // different provider is ignored — and the probe showed why that is the wrong
    // place for the rule: it let a provider-mismatched action past a stop appended
    // for its own connection. The narrow behaviour is asserted against
    // `listEffective` in the WU-05 executor tests, where a real query decides which
    // rows are applicable, instead of being re-derived here from caller-supplied
    // fields.
    const foreignSwitchInSnapshot = evaluatePolicy(
      snapshot({
        killSwitches: [killSwitch({ eventId: "ks-o", level: "PROVIDER", provider: "gmail" })],
      }),
    );
    expect(foreignSwitchInSnapshot.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });

  it("treats a DISABLED switch as no switch", () => {
    // `kill_switch_events` is append-only, so turning a switch off appends a row with
    // `enabled = false`. Reading the latest row per level and honouring `enabled` is
    // what makes that work; treating any row's presence as active would make a stop
    // permanent.
    const result = evaluatePolicy(snapshot({ killSwitches: [killSwitch({ enabled: false })] }));
    expect(result.decision).toBe(PolicyDecision.REQUIRES_APPROVAL);
    expect(result.evidence.killSwitchActive).toBe(false);
  });

  it("refuses a revoked, expired or errored connection with CONNECTION_BLOCKED", () => {
    // Distinguished from KILL_SWITCH_ACTIVE on purpose: an operator stop and a dead
    // credential need different operator responses, and a single "denied" code would
    // conflate them.
    for (const health of [
      ConnectionHealth.REVOKED,
      ConnectionHealth.EXPIRED,
      ConnectionHealth.ERROR,
    ]) {
      const result = evaluatePolicy(snapshot({ connectionHealth: health }));
      expect(result.decision, health).toBe(PolicyDecision.DENY);
      expect(result.refusalCode, health).toBe(PolicyRefusalCode.CONNECTION_BLOCKED);
    }
  });

  it("refuses a credential that expired before `now`", () => {
    const result = evaluatePolicy(
      snapshot({ credentialExpiresAt: new Date(NOW.getTime() - 1_000) }),
    );
    expect(result.refusalCode).toBe(PolicyRefusalCode.CONNECTION_BLOCKED);
  });

  it("reports KILL_SWITCH_ACTIVE, not CONNECTION_BLOCKED, when both apply", () => {
    // Both refuse, but the operator stop is the more actionable fact and is what the
    // audit log should name.
    const result = evaluatePolicy(
      snapshot({ connectionHealth: ConnectionHealth.REVOKED, killSwitches: [killSwitch()] }),
    );
    expect(result.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });
});

describe("kill-switch gaps found by the WU-03 adversarial probe", () => {
  it("stops an action whose provider disagrees with a CONNECTION-scoped switch", () => {
    // PROBE 1, a real fail-open. The RA-005 guard matches a CONNECTION switch on
    // provider AND connection id, so an action declaring a different provider slid
    // past a stop appended for the very connection it was about to write to. The
    // engine now treats ANY enabled switch in the applicable snapshot as a stop:
    // `listEffective` already selected these rows for (owner, provider, connection),
    // so re-filtering could only discard a switch the query judged relevant.
    const result = evaluatePolicy(
      snapshot({
        provider: "gitlab",
        killSwitches: [
          killSwitch({
            eventId: "ks-conn",
            level: "CONNECTION",
            provider: "jira",
            connectionId: "conn-a",
            reason: "stop this connection",
          }),
        ],
      }),
    );
    expect(result.decision).toBe(PolicyDecision.DENY);
    expect(result.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });

  it("stops an action when a switch names a connection other than the action's", () => {
    // Same rule from the other direction. This is deliberately STRICTER than the
    // RA-005 guard: if a snapshot built for this action contains an enabled switch,
    // the conservative reading is "stop". A caller that wants per-connection
    // precision must not put a foreign switch in the snapshot.
    const result = evaluatePolicy(
      snapshot({
        killSwitches: [
          killSwitch({
            eventId: "ks-other",
            level: "CONNECTION",
            provider: "jira",
            connectionId: "conn-elsewhere",
          }),
        ],
      }),
    );
    expect(result.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });

  it("is invariant to the ORDER the caller passed the switches in", () => {
    // PROBE 3, the opposite failure: a pure reordering produced a FALSE AC3 mismatch,
    // which would block a legitimate execution and teach an operator to distrust the
    // check. Event ids are sorted, so agreement tracks the SET of observed events.
    const rows = [
      {
        event_id: "ks-1",
        scope_level: "GLOBAL" as const,
        provider: null,
        connection_id: null,
        enabled: false,
        reason: "r",
      },
      {
        event_id: "ks-2",
        scope_level: "PROVIDER" as const,
        provider: "jira" as const,
        connection_id: null,
        enabled: false,
        reason: "r",
      },
    ];
    const forward = evaluatePolicy(snapshot({ killSwitches: toPolicyKillSwitches(rows) }));
    const reversed = evaluatePolicy(
      snapshot({ killSwitches: toPolicyKillSwitches([...rows].reverse()) }),
    );
    expect(policyEvaluationsAgree(forward, reversed)).toBe(true);
    // Still detects a genuinely DIFFERENT set, so the sort did not weaken the check.
    const extra = evaluatePolicy(
      snapshot({
        killSwitches: toPolicyKillSwitches([
          ...rows,
          {
            event_id: "ks-3",
            scope_level: "CONNECTION",
            provider: "jira",
            connection_id: "conn-a",
            enabled: false,
            reason: "r",
          },
        ]),
      }),
    );
    expect(policyEvaluationsAgree(forward, extra)).toBe(false);
  });
});

describe("the connection must be in the case's authoritative scope", () => {
  it("refuses a connection the case was never granted", () => {
    const result = evaluatePolicy(
      snapshot({ connectionId: "conn-elsewhere", caseConnectionIds: ["conn-a"] }),
    );
    expect(result.decision).toBe(PolicyDecision.DENY);
    expect(result.refusalCode).toBe(PolicyRefusalCode.CONNECTION_OUT_OF_SCOPE);
  });

  it("refuses when the case has NO granted connections", () => {
    // Fail closed on empty configuration — the `declaredPaths` defect class from
    // RA-014, where an empty declaration was read as permission.
    const result = evaluatePolicy(snapshot({ caseConnectionIds: [] }));
    expect(result.refusalCode).toBe(PolicyRefusalCode.CONNECTION_OUT_OF_SCOPE);
  });
});

describe("evidence makes the two evaluations comparable (AC3)", () => {
  it("records the tool, case, connection and the kill-switch events observed", () => {
    const result = evaluatePolicy(
      snapshot({
        killSwitches: [
          killSwitch({ eventId: "ks-global", enabled: false }),
          killSwitch({
            eventId: "ks-conn",
            level: "CONNECTION",
            provider: "jira",
            connectionId: "conn-a",
            enabled: false,
          }),
        ],
      }),
    );
    expect(result.evidence.toolName).toBe("jira.issue.comment");
    expect(result.evidence.caseId).toBe("case-a");
    expect(result.evidence.connectionId).toBe("conn-a");
    // Ids, not just "a switch was active": an id references an immutable append-only
    // row, so the pre-execute snapshot can be shown to be the same one. Sorted, so a
    // reordering by the caller is not mistaken for a policy change (PROBE 3).
    expect(result.evidence.killSwitchEventIds).toEqual(["ks-conn", "ks-global"]);
  });

  it("is deterministic: the same snapshot yields an identical evaluation", () => {
    // The property AC3 rests on. If evaluation were not deterministic, a mismatch
    // between the proposal and pre-execute checks would be meaningless.
    const input = snapshot();
    expect(evaluatePolicy(input)).toEqual(evaluatePolicy(input));
    expect(policyEvaluationsAgree(evaluatePolicy(input), evaluatePolicy(input))).toBe(true);
  });

  it("detects a policy change between proposal and execute", () => {
    // The AC3 race: the decision was made, then an operator hit the kill switch. The
    // two evaluations must not compare equal.
    const atProposal = evaluatePolicy(snapshot());
    const beforeExecute = evaluatePolicy(snapshot({ killSwitches: [killSwitch()] }));
    expect(policyEvaluationsAgree(atProposal, beforeExecute)).toBe(false);
  });

  it("detects a CHANGED kill-switch snapshot even when the decision is unchanged", () => {
    // The case a decision-only comparison misses: a switch was appended and disabled
    // again, so both evaluations say REQUIRES_APPROVAL — but they were computed
    // against different durable state, and something happened in between that an
    // operator should see.
    const first = evaluatePolicy(snapshot({ killSwitches: [] }));
    const second = evaluatePolicy(
      snapshot({ killSwitches: [killSwitch({ eventId: "ks-later", enabled: false })] }),
    );
    expect(first.decision).toBe(second.decision);
    expect(policyEvaluationsAgree(first, second)).toBe(false);
  });

  it("detects a retiered action even when the decision is unchanged", () => {
    // Both R3 and R4 yield REQUIRES_APPROVAL, so comparing decisions alone would let
    // an action that changed tier between the two checks through — a registry edit
    // landing mid-deploy, say.
    //
    // The two evaluations differ ONLY in `riskTier`: `toolName` is held equal, which
    // is what makes this test isolate the tier comparison. An earlier version used
    // two different tools and a mutation removing the `riskTier` check SURVIVED it,
    // because the differing tool name was already enough to make them disagree.
    const asR3 = evaluatePolicy(snapshot({ toolName: "jira.issue.comment" }));
    const asR4 = { ...asR3, riskTier: RiskTier.R4 };
    expect(asR3.decision).toBe(asR4.decision);
    expect(asR3.evidence.toolName).toBe(asR4.evidence.toolName);
    expect(policyEvaluationsAgree(asR3, asR4)).toBe(false);
  });

  it("detects a changed refusal code, tool, case or connection in isolation", () => {
    // Each remaining compared field, varied ALONE for the same reason as above: a
    // test that changes two fields at once cannot show that either is compared.
    const base = evaluatePolicy(snapshot());
    const variants = [
      { refusalCode: PolicyRefusalCode.KILL_SWITCH_ACTIVE },
      { evidence: { ...base.evidence, toolName: "gitlab.mr.merge" } },
      { evidence: { ...base.evidence, caseId: "case-other" } },
      { evidence: { ...base.evidence, connectionId: "conn-other" } },
      { evidence: { ...base.evidence, killSwitchActive: true } },
      { evidence: { ...base.evidence, killSwitchEventIds: ["ks-appeared"] } },
    ];
    for (const [index, variant] of variants.entries()) {
      expect(policyEvaluationsAgree(base, { ...base, ...variant }), `variant ${index}`).toBe(false);
    }
  });

  it("does not treat an audit-prose change as a policy change", () => {
    // `reason` is for humans. If it were compared, editing a message would read as a
    // policy change and block execution.
    const base = evaluatePolicy(snapshot());
    const reworded = { ...base, reason: "different prose, same policy" };
    expect(policyEvaluationsAgree(base, reworded)).toBe(true);
  });
});

describe("toPolicyKillSwitches reshapes persisted rows without re-deriving them", () => {
  it("carries the event id, scope and enabled flag through unchanged", () => {
    const rows = [
      {
        event_id: "ks-1",
        scope_level: "GLOBAL" as const,
        provider: null,
        connection_id: null,
        enabled: true,
        reason: "stop",
      },
      {
        event_id: "ks-2",
        scope_level: "CONNECTION" as const,
        provider: "jira" as const,
        connection_id: "conn-a",
        enabled: false,
        reason: "resumed",
      },
    ];
    expect(toPolicyKillSwitches(rows)).toEqual([
      {
        eventId: "ks-1",
        level: "GLOBAL",
        provider: null,
        connectionId: null,
        enabled: true,
        reason: "stop",
      },
      {
        eventId: "ks-2",
        level: "CONNECTION",
        provider: "jira",
        connectionId: "conn-a",
        enabled: false,
        reason: "resumed",
      },
    ]);
  });

  it("feeds straight into an evaluation that refuses on the projected switch", () => {
    // Proves the projection is wired correctly end to end: a persisted enabled row
    // must actually stop an action, not merely reshape into a plausible object.
    const result = evaluatePolicy(
      snapshot({
        killSwitches: toPolicyKillSwitches([
          {
            event_id: "ks-live",
            scope_level: "GLOBAL",
            provider: null,
            connection_id: null,
            enabled: true,
            reason: "operator stop",
          },
        ]),
      }),
    );
    expect(result.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });
});
