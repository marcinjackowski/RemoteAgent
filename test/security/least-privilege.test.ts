import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Provider, RiskTier } from "@remoteagent/contracts";
import {
  FORBIDDEN_SCOPES,
  OvergrantDecision,
  PRIVILEGE_GRANTS,
  overgrants,
  writeGrants,
} from "@remoteagent/observability";
import { ACTION_REGISTRY, assertR4NeverAutoAllowed, resolveRiskTier } from "@remoteagent/policy";
import { describe, expect, it } from "vitest";

/**
 * Least-privilege review of every scope (RA-024-WU-04).
 *
 * THE DIRECTION OF THE CHECK IS THE POINT. Verifying "does every action have a scope?"
 * finds nothing: a missing scope breaks the feature immediately and gets fixed. The
 * dangerous case is the reverse — a scope requested during development, never removed,
 * never noticed because everything works. A grant nobody uses cannot make anything
 * work and is available to anything that gets in.
 *
 * So the register is checked for scopes with no justification, and each WRITE scope is
 * checked against the server-owned `ACTION_REGISTRY` to confirm the action it claims to
 * serve is actually registered and at the tier the review assumed.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const DOCUMENT = await readFile(join(REPO_ROOT, "docs", "security", "LEAST_PRIVILEGE.md"), "utf8");

describe("every requested privilege is justified", () => {
  it("no grant has an empty justification", () => {
    // An empty `requiredBy` is the over-grant this register exists to catch.
    const unjustified = PRIVILEGE_GRANTS.filter((grant) => grant.requiredBy.length === 0).map(
      (grant) => `${grant.provider}:${grant.scope}`,
    );
    expect(unjustified).toEqual([]);
  });

  it("no scope is registered twice for the same provider", () => {
    // A duplicate row is how two reviews disagree about the same grant, with the
    // weaker justification winning by being read first.
    const keys = PRIVILEGE_GRANTS.map(
      (grant) => `${grant.surface}|${grant.provider}|${grant.scope}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every over-grant has a decision AND a compensating control", () => {
    // RA-026 AC3 requires every known residual risk to have an owner and an
    // accept/fix/defer decision. An unexplained over-grant is not a valid state, and
    // deleting the row because it looks bad would hide a real risk.
    for (const grant of overgrants()) {
      expect(grant.overgrant, `${grant.scope} has no decision`).not.toBe(OvergrantDecision.NONE);
      if (grant.overgrant === OvergrantDecision.ACCEPTED) {
        expect(
          grant.compensatingControl ?? "",
          `${grant.scope} is ACCEPTED with no compensating control`,
        ).not.toBe("");
        expect((grant.compensatingControl ?? "").length).toBeGreaterThan(60);
      }
    }
  });

  it("no over-grant is left in the FIX state", () => {
    // `FIX` means "we know it is too broad and have not narrowed it". Allowed to exist
    // in the type so the register can express it honestly, but not allowed to pass the
    // gate — otherwise it becomes a permanent parking space.
    const unfixed = overgrants()
      .filter((grant) => grant.overgrant === OvergrantDecision.FIX)
      .map((grant) => grant.scope);
    expect(unfixed).toEqual([]);
  });

  it("covers every provider in the contracts", () => {
    const covered = new Set(PRIVILEGE_GRANTS.map((grant) => grant.provider));
    const missing = Object.values(Provider).filter((provider) => !covered.has(provider));
    expect(missing).toEqual([]);
  });

  it("covers the non-provider privilege surfaces too", () => {
    const covered = new Set(PRIVILEGE_GRANTS.map((grant) => grant.provider));
    for (const surface of ["bedrock", "secrets"]) {
      expect(covered).toContain(surface);
    }
  });
});

describe("the write surface is exactly what the action registry needs", () => {
  it("every registered action name in a write grant resolves in ACTION_REGISTRY", () => {
    // The check that makes the review non-decorative: a write scope justified by an
    // action nobody registered is justified by nothing. Names that are read
    // operations (`gitlab.clone`, `discord.post_status`) are excluded — they are not
    // external writes and correctly absent from the registry.
    const unknown: string[] = [];
    for (const grant of writeGrants()) {
      for (const action of grant.requiredBy) {
        if (!Object.hasOwn(ACTION_REGISTRY, action)) unknown.push(`${grant.scope} -> ${action}`);
      }
    }
    // Only the provider-write grants are expected to map one-to-one; Discord and
    // Secrets writes are not external-effect actions in the registry sense.
    const providerWrites = unknown.filter(
      (entry) => !entry.includes("discord.") && !entry.includes("credential."),
    );
    expect(providerWrites).toEqual([]);
  });

  it("every R3 and R4 action in the registry is covered by some write grant", () => {
    // The other direction: an action that can produce an external effect with no scope
    // backing it would fail at runtime, but silently — as a provider 403 that reads
    // like a transient error and gets retried.
    const justified = new Set(writeGrants().flatMap((grant) => grant.requiredBy));
    const uncovered = Object.entries(ACTION_REGISTRY)
      .filter(([, tier]) => tier === RiskTier.R3 || tier === RiskTier.R4)
      .map(([name]) => name)
      .filter((name) => !justified.has(name));
    expect(uncovered).toEqual([]);
  });

  it("no read-only scope is justified by a registry write action", () => {
    // A read scope claiming to serve `jira.issue.comment` means the review has the
    // scope's nature wrong, and the whole justification is then unreliable.
    const misfiled: string[] = [];
    for (const grant of PRIVILEGE_GRANTS.filter((entry) => !entry.writes)) {
      for (const action of grant.requiredBy) {
        const tier = resolveRiskTier(action);
        if (tier === RiskTier.R3 || tier === RiskTier.R4) {
          misfiled.push(`${grant.scope} claims ${action} (${tier})`);
        }
      }
    }
    expect(misfiled).toEqual([]);
  });

  it("R4 can never be auto-allowed, which every write over-grant relies on", () => {
    // Three write grants name this as their compensating control, so the register's
    // safety depends on it. Asserted here rather than assumed, because a compensating
    // control nobody checks is a comment.
    expect(() => assertR4NeverAutoAllowed()).not.toThrow();
  });

  it("sending mail is not a registered action, which contains gmail.compose", () => {
    // The `gmail.compose` over-grant's whole containment. Google has no draft-only
    // scope, so the OAuth layer cannot help — this is where it is actually stopped.
    expect(Object.hasOwn(ACTION_REGISTRY, "gmail.message.send")).toBe(false);
    expect(resolveRiskTier("gmail.message.send")).toBeNull();
  });
});

describe("forbidden scopes stay absent", () => {
  it("no forbidden scope is requested", () => {
    const requested = new Set(PRIVILEGE_GRANTS.map((grant) => grant.scope));
    const violations = Object.keys(FORBIDDEN_SCOPES).filter((scope) => requested.has(scope));
    expect(violations).toEqual([]);
  });

  it("every forbidden scope carries a reason", () => {
    // A denylist entry without a reason gets deleted by the next person who needs the
    // scope. With one, adding it means deleting an explanation — which is the friction
    // this list is for.
    for (const [scope, reason] of Object.entries(FORBIDDEN_SCOPES)) {
      expect(reason.length, `${scope} has no reason`).toBeGreaterThan(20);
    }
  });

  it("no requested scope is a wildcard", () => {
    // RA-025 AC2 requires an ADR for any wildcard. Enforced from here, so a wildcard
    // cannot be introduced during RA-025 without the ADR the criterion names.
    const wildcards = PRIVILEGE_GRANTS.filter((grant) => grant.scope.includes("*")).map(
      (grant) => grant.scope,
    );
    expect(wildcards).toEqual([]);
  });

  it("no scope grants full mailbox or admin access", () => {
    // A belt-and-braces shape check, so a NEW scope with these markers fails even if
    // nobody adds it to FORBIDDEN_SCOPES.
    for (const grant of PRIVILEGE_GRANTS) {
      expect(grant.scope, `${grant.scope} looks like an admin scope`).not.toMatch(
        /\b(admin|sudo|owner|superuser)\b/i,
      );
      expect(grant.scope).not.toBe("https://mail.google.com/");
    }
  });
});

describe("the document and the register agree", () => {
  it("documents every write grant, since those are the reviewable risk", () => {
    const undocumented = writeGrants()
      .filter((grant) => !DOCUMENT.includes(grant.scope))
      .map((grant) => grant.scope);
    expect(undocumented).toEqual([]);
  });

  it("documents every over-grant and its decision", () => {
    for (const grant of overgrants()) {
      expect(DOCUMENT, `${grant.scope} is not in the document`).toContain(grant.scope);
    }
    expect(DOCUMENT).toContain("ACCEPTED");
  });

  it("documents every forbidden scope", () => {
    const undocumented = Object.keys(FORBIDDEN_SCOPES).filter((scope) => !DOCUMENT.includes(scope));
    expect(undocumented).toEqual([]);
  });
});
