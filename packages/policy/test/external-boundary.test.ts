/**
 * RA-023-WU-05 — an external boundary may narrow, never widen (AC3).
 *
 * The fake here is a HOSTILE gateway, not a cooperative one. A cooperative fake proves
 * only that the happy path works, and the happy path is not the risk: the risk is a
 * managed boundary — or a compromised one, or simply a buggy one — asserting authority it
 * does not have. So every test below is the boundary trying something, and the assertion
 * is on the specific refusal code rather than on "it was refused".
 *
 * ADR-0008 records `DEFER` for every provider, so no Gateway is deployed and nothing here
 * talks to AWS. That is deliberate and does not weaken the suite: containment is a pure
 * function over an untrusted manifest, so a real gateway would add latency and cost
 * without adding a single reachable branch.
 */
import { PolicyDecision, RiskTier } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  BoundaryRefusalCode,
  MAX_BOUNDARY_OFFERS,
  assertEveryToolHasProvider,
  assertNoWidening,
  containExternalManifest,
  resolveToolProvider,
} from "../src/external-boundary.js";
import type { ExternalToolOffer, LocalScope } from "../src/external-boundary.js";

const SCOPE: LocalScope = {
  caseId: "case-a",
  ownerId: "owner-a",
  caseConnectionIds: ["conn-jira-sondermind"],
  caseProviders: ["jira"],
};

/** A well-formed offer for a tool that IS in our registry, at its real tier. */
function honestOffer(overrides: Partial<ExternalToolOffer> = {}): ExternalToolOffer {
  return {
    toolName: "jira.issue.comment",
    claimedConnectionId: "conn-jira-sondermind",
    ...overrides,
  };
}

describe("a well-formed offer is contained on LOCAL terms", () => {
  it("admits a registered tool on a granted connection", () => {
    const result = containExternalManifest([honestOffer()], SCOPE);
    expect(result.refused).toEqual([]);
    expect(result.allowed).toEqual([
      {
        toolName: "jira.issue.comment",
        riskTier: RiskTier.R3,
        connectionId: "conn-jira-sondermind",
        ownerId: "owner-a",
      },
    ]);
  });

  it("takes the tier from OUR registry even when the boundary agrees", () => {
    // The claimed value is discarded rather than passed through, which matters because a
    // pass-through makes a future divergence invisible: the day the boundary starts
    // sending something else, nothing would notice.
    const agreeing = containExternalManifest(
      [honestOffer({ claimedRiskTier: RiskTier.R3 })],
      SCOPE,
    );
    expect(agreeing.allowed[0]?.riskTier).toBe(RiskTier.R3);
    // Identical to the offer that claimed nothing at all.
    expect(agreeing.allowed).toEqual(containExternalManifest([honestOffer()], SCOPE).allowed);
  });

  it("derives the owner locally, so the boundary contributes nothing to it", () => {
    const result = containExternalManifest([honestOffer()], SCOPE);
    expect(result.allowed[0]?.ownerId).toBe("owner-a");
  });
});

describe("the boundary cannot widen the risk tier", () => {
  it("refuses a claimed tier LOWER than the registry's", () => {
    // The escalation that matters: a gateway describing a merge as a read.
    const result = containExternalManifest(
      [
        honestOffer({
          toolName: "gitlab.mr.merge",
          claimedRiskTier: RiskTier.R0,
        }),
      ],
      SCOPE,
    );
    expect(result.allowed).toEqual([]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.TIER_DOWNGRADE);
    expect(result.refused[0]?.reason).toMatch(/registry assigns R4/);
  });

  it("accepts a claimed tier HIGHER than the registry's, and still uses ours", () => {
    // A conservative boundary cannot grant anything, so refusing it would turn caution
    // into an outage. Our tier still governs the decision.
    const result = containExternalManifest([honestOffer({ claimedRiskTier: RiskTier.R4 })], SCOPE);
    expect(result.refused).toEqual([]);
    expect(result.allowed[0]?.riskTier).toBe(RiskTier.R3);
  });

  it("ignores a malformed tier claim rather than trusting or crashing on it", () => {
    // The field is `unknown` because it crosses a trust boundary. Garbage must not become
    // a decision input, and must not throw either — an exception here is a
    // denial-of-service on a legitimate tool.
    for (const bogus of ["R99", "", 0, -1, null, {}, [], true, { tier: "R0" }]) {
      const result = containExternalManifest([honestOffer({ claimedRiskTier: bogus })], SCOPE);
      expect(result.refused, JSON.stringify(bogus)).toEqual([]);
      expect(result.allowed[0]?.riskTier, JSON.stringify(bogus)).toBe(RiskTier.R3);
    }
  });
});

describe("the boundary cannot widen connection or provider scope", () => {
  it("refuses a connection the case was never granted", () => {
    const result = containExternalManifest(
      [honestOffer({ claimedConnectionId: "conn-someone-elses" })],
      SCOPE,
    );
    expect(result.allowed).toEqual([]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.CONNECTION_NOT_IN_CASE_SCOPE);
  });

  it("refuses an offer with NO connection rather than choosing one", () => {
    // Fail closed on absence. Picking a connection for the boundary would be this
    // function inventing authority — the `declaredPaths` defect class from RA-014.
    const result = containExternalManifest([{ toolName: "jira.issue.comment" }], SCOPE);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.CONNECTION_NOT_IN_CASE_SCOPE);
  });

  it("refuses a non-string connection id", () => {
    for (const bogus of [42, null, {}, [], true]) {
      const result = containExternalManifest([honestOffer({ claimedConnectionId: bogus })], SCOPE);
      expect(result.refused[0]?.code, JSON.stringify(bogus)).toBe(
        BoundaryRefusalCode.CONNECTION_NOT_IN_CASE_SCOPE,
      );
    }
  });

  it("refuses a tool whose provider the case is not scoped to, even with NO claim", () => {
    // The WU-05 probe finding. Provider was only validated when the boundary CLAIMED one,
    // so an offer that claimed nothing skipped the check — and a case scoped to `jira`
    // alone was admitted `gmail.draft.create` and `calendar.event.*`. The omission was the
    // bypass, so the provider is now DERIVED from the tool name, a server-owned fact.
    for (const toolName of ["gmail.draft.create", "calendar.event.create", "gitlab.mr.comment"]) {
      const result = containExternalManifest([honestOffer({ toolName })], SCOPE);
      expect(result.allowed, toolName).toEqual([]);
      expect(result.refused[0]?.code, toolName).toBe(
        BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE,
      );
    }
  });

  it("admits a tool once its provider IS in the case's scope", () => {
    // The complement: the derived check must not become "refuse everything but jira". A
    // case scoped to gmail gets the gmail tool and still not the jira one.
    const gmailScope: LocalScope = {
      ...SCOPE,
      caseProviders: ["gmail"],
      caseConnectionIds: ["conn-gmail-private"],
    };
    const result = containExternalManifest(
      [
        { toolName: "gmail.draft.create", claimedConnectionId: "conn-gmail-private" },
        { toolName: "jira.issue.comment", claimedConnectionId: "conn-gmail-private" },
      ],
      gmailScope,
    );
    expect(result.allowed.map((t) => t.toolName)).toEqual(["gmail.draft.create"]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE);
  });

  it("refuses a claimed provider that contradicts the tool's canonical name", () => {
    // A boundary claiming `jira` for a gmail tool is not merely wrong about scope — the
    // disagreement itself means something upstream is broken or hostile.
    const result = containExternalManifest(
      [honestOffer({ toolName: "jira.issue.comment", claimedProvider: "gmail" })],
      SCOPE,
    );
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE);
    expect(result.refused[0]?.reason).toMatch(/canonical name declares jira/);
  });

  it("reports the PROVIDER refusal before the connection one", () => {
    // Ordering asserted so the audit log names the broader fact rather than the narrower
    // symptom.
    const result = containExternalManifest(
      [honestOffer({ toolName: "gmail.draft.create", claimedConnectionId: "conn-elsewhere" })],
      SCOPE,
    );
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE);
  });

  it("refuses everything when the case has NO granted connections", () => {
    const empty: LocalScope = { ...SCOPE, caseConnectionIds: [] };
    const result = containExternalManifest([honestOffer()], empty);
    expect(result.allowed).toEqual([]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.CONNECTION_NOT_IN_CASE_SCOPE);
  });
});

describe("the boundary cannot assert owner or policy decision at all", () => {
  it("refuses an offer carrying an owner, even the CORRECT one", () => {
    // Refused on presence, not on value. Accepting a matching owner would imply an
    // external assertion could be authoritative when it happens to agree — and the day it
    // disagrees, the comparison is the only thing standing between us and a cross-owner
    // action.
    const result = containExternalManifest([honestOffer({ claimedOwnerId: "owner-a" })], SCOPE);
    expect(result.allowed).toEqual([]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.OWNER_ASSERTED_EXTERNALLY);
  });

  it("refuses an offer carrying a DIFFERENT owner", () => {
    const result = containExternalManifest([honestOffer({ claimedOwnerId: "owner-b" })], SCOPE);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.OWNER_ASSERTED_EXTERNALLY);
  });

  it("refuses an offer claiming the action is pre-authorized", () => {
    // The vendor equivalent of the model claiming authorization (`AGENTS.md` §4). A
    // gateway saying AUTO_ALLOW is not a shortcut, it is a refusal.
    const result = containExternalManifest(
      [honestOffer({ claimedPolicyDecision: PolicyDecision.AUTO_ALLOW })],
      SCOPE,
    );
    expect(result.allowed).toEqual([]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.POLICY_DECISION_ASSERTED_EXTERNALLY);
  });

  it("refuses ANY claimed decision, including DENY", () => {
    // Even a restrictive claim is refused: accepting DENY from outside would make the
    // boundary able to disable our tools, which is a different failure but still a
    // transfer of authority.
    for (const decision of [
      PolicyDecision.DENY,
      PolicyDecision.REQUIRES_APPROVAL,
      "SOMETHING_ELSE",
    ]) {
      const result = containExternalManifest(
        [honestOffer({ claimedPolicyDecision: decision })],
        SCOPE,
      );
      expect(result.refused[0]?.code, String(decision)).toBe(
        BoundaryRefusalCode.POLICY_DECISION_ASSERTED_EXTERNALLY,
      );
    }
  });
});

describe("the boundary cannot introduce tools we do not know", () => {
  it("refuses a tool absent from the server-owned registry", () => {
    // "The gateway offered it" is not a reason to expose it: an unregistered tool has no
    // established blast radius.
    const result = containExternalManifest([honestOffer({ toolName: "jira.project.nuke" })], SCOPE);
    expect(result.allowed).toEqual([]);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.UNREGISTERED_TOOL);
  });

  it("refuses the destructive tools the real AgentCore Jira template exposes", () => {
    // Concrete and evidence-driven: the verified template ships `deleteIssue`,
    // `deleteProject`, `deleteSprint` and `deleteComment`
    // (`docs/research/RA-023-CAPABILITY-MATRIX.md`). Those names are not in our registry,
    // so containment refuses them outright rather than admitting them at some tier.
    const templateNames = [
      "deleteIssue",
      "deleteProject",
      "deleteSprint",
      "deleteComment",
      "createProject",
    ];
    const result = containExternalManifest(
      templateNames.map((toolName) => honestOffer({ toolName })),
      SCOPE,
    );
    expect(result.allowed).toEqual([]);
    expect(result.refused).toHaveLength(templateNames.length);
    for (const refusal of result.refused) {
      expect(refusal.code, refusal.toolName).toBe(BoundaryRefusalCode.UNREGISTERED_TOOL);
    }
  });

  it("refuses a manifest above the size ceiling, WHOLESALE rather than truncated", () => {
    // The WU-05 probe handed containment 20 000 offers and got 20 000 back, unbounded.
    // Truncating to the first 64 would let the boundary choose WHICH 64 by controlling the
    // order, so the whole manifest is refused and the refusal is visible.
    const huge = Array.from({ length: MAX_BOUNDARY_OFFERS + 1 }, (_unused, i) => ({
      toolName: `jira.issue.comment.${i}`,
      claimedConnectionId: "conn-jira-sondermind",
    }));
    const result = containExternalManifest(huge, SCOPE);
    expect(result.allowed).toEqual([]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.code).toBe(BoundaryRefusalCode.MANIFEST_TOO_LARGE);
  });

  it("accepts a manifest exactly AT the ceiling, so the bound is not off by one", () => {
    // Guards against a ceiling that is stricter than documented. Uses the same registered
    // tool name repeatedly, so all but the first are deduplicated — which is what makes
    // this test about the SIZE check rather than about registry contents.
    const atLimit = Array.from({ length: MAX_BOUNDARY_OFFERS }, () => honestOffer());
    const result = containExternalManifest(atLimit, SCOPE);
    expect(result.refused.some((r) => r.code === BoundaryRefusalCode.MANIFEST_TOO_LARGE)).toBe(
      false,
    );
    expect(result.allowed).toHaveLength(1);
  });

  it("admits a duplicated tool exactly once", () => {
    // Three identical offers previously yielded three allowed entries, which let the
    // boundary control how many times a tool appears in the model's manifest.
    const result = containExternalManifest([honestOffer(), honestOffer(), honestOffer()], SCOPE);
    expect(result.allowed).toHaveLength(1);
    expect(result.refused.map((r) => r.code)).toEqual([
      BoundaryRefusalCode.DUPLICATE_OFFER,
      BoundaryRefusalCode.DUPLICATE_OFFER,
    ]);
  });

  it("yields NO capability for an empty manifest", () => {
    // Fail closed on empty, which is also AWS's own stated guidance for Gateway
    // interceptors: deny by default when authorization cannot be determined.
    expect(containExternalManifest([], SCOPE)).toEqual({ allowed: [], refused: [] });
  });
});

describe("containment is an intersection, and mixed manifests are handled per-tool", () => {
  it("admits the honest offers and refuses the rest, without either affecting the other", () => {
    // A hostile entry must not poison a legitimate one, and a legitimate one must not
    // launder a hostile one. Asserted together because a per-tool loop that bailed early
    // would pass every single-offer test above.
    const result = containExternalManifest(
      [
        honestOffer(),
        honestOffer({ toolName: "gitlab.mr.merge", claimedRiskTier: RiskTier.R0 }),
        honestOffer({ toolName: "gmail.draft.create", claimedConnectionId: "conn-elsewhere" }),
        honestOffer({ toolName: "jira.issue.transition" }),
        honestOffer({ toolName: "jira.issue.delete", claimedOwnerId: "owner-b" }),
      ],
      SCOPE,
    );

    expect(result.allowed.map((t) => t.toolName)).toEqual([
      "jira.issue.comment",
      "jira.issue.transition",
    ]);
    // `gitlab.mr.merge` is refused on TIER first (checked before provider);
    // `gmail.draft.create` on PROVIDER, since this case is scoped to jira alone; the last
    // on OWNER, which is refused before anything else is even looked at.
    expect(result.refused.map((r) => r.code)).toEqual([
      BoundaryRefusalCode.TIER_DOWNGRADE,
      BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE,
      BoundaryRefusalCode.OWNER_ASSERTED_EXTERNALLY,
    ]);
  });

  it("never returns more tools than the boundary offered", () => {
    // Narrowing means the result is a subset. A containment that could invent a tool
    // would be widening in the most direct sense.
    const offers = [honestOffer(), honestOffer({ toolName: "jira.issue.transition" })];
    const result = containExternalManifest(offers, SCOPE);
    expect(result.allowed.length).toBeLessThanOrEqual(offers.length);
  });
});

describe("assertNoWidening is a second, independent statement of the rule", () => {
  it("passes for a legitimately contained result", () => {
    const result = containExternalManifest([honestOffer()], SCOPE);
    expect(() => assertNoWidening(result, SCOPE)).not.toThrow();
  });

  it("catches a widened owner that containment somehow let through", () => {
    // Driven with a hand-built result rather than through `containExternalManifest`,
    // because the point is to check the ASSERTION, not the function it double-checks. If
    // this were routed through containment it would only ever test the happy path and
    // would pass even if the assertion body were deleted.
    expect(() =>
      assertNoWidening(
        {
          allowed: [
            {
              toolName: "jira.issue.comment",
              riskTier: RiskTier.R3,
              connectionId: "conn-jira-sondermind",
              ownerId: "owner-b",
            },
          ],
          refused: [],
        },
        SCOPE,
      ),
    ).toThrow(/carries owner owner-b/);
  });

  it("catches a widened connection", () => {
    expect(() =>
      assertNoWidening(
        {
          allowed: [
            {
              toolName: "jira.issue.comment",
              riskTier: RiskTier.R3,
              connectionId: "conn-elsewhere",
              ownerId: "owner-a",
            },
          ],
          refused: [],
        },
        SCOPE,
      ),
    ).toThrow(/outside case case-a/);
  });

  it("catches a downgraded tier", () => {
    expect(() =>
      assertNoWidening(
        {
          allowed: [
            {
              toolName: "gitlab.mr.merge",
              riskTier: RiskTier.R0,
              connectionId: "conn-jira-sondermind",
              ownerId: "owner-a",
            },
          ],
          refused: [],
        },
        SCOPE,
      ),
    ).toThrow(/carries tier R0, but the registry assigns R4/);
  });

  it("catches an unregistered tool", () => {
    expect(() =>
      assertNoWidening(
        {
          allowed: [
            {
              toolName: "jira.project.nuke",
              riskTier: RiskTier.R3,
              connectionId: "conn-jira-sondermind",
              ownerId: "owner-a",
            },
          ],
          refused: [],
        },
        SCOPE,
      ),
    ).toThrow(/not in the server-owned registry/);
  });
});

describe("the provider table covers the whole registry", () => {
  it("resolves a provider for every registered tool", () => {
    // A tool whose prefix is unrecognized is refused at the boundary, which fails in the
    // direction that LOOKS safe — it just becomes quietly unreachable. This turns that
    // silent capability loss into a startup failure.
    expect(() => assertEveryToolHasProvider()).not.toThrow();
  });

  it("detects a registry entry with no provider prefix", () => {
    // Proves the assertion is load-bearing rather than vacuous.
    expect(() => assertEveryToolHasProvider({ "unknownvendor.thing": RiskTier.R2 })).toThrow(
      /declare no provider/,
    );
  });

  it("maps each tool family to the provider its name declares", () => {
    expect(resolveToolProvider("jira.issue.comment")).toBe("jira");
    expect(resolveToolProvider("gmail.draft.create")).toBe("gmail");
    expect(resolveToolProvider("calendar.event.create")).toBe("calendar");
    expect(resolveToolProvider("gitlab.mr.merge")).toBe("gitlab");
    // A local Git operation applied to a GitLab remote (RA-014/RA-017 own that path).
    expect(resolveToolProvider("git.push.force")).toBe("gitlab");
    expect(resolveToolProvider("unknownvendor.thing")).toBeNull();
  });
});
