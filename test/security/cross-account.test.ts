import {
  ConnectionAlias,
  ConnectionHealth,
  ConnectionScopeKind,
  PolicyDecision,
  Provider,
  RiskTier,
} from "@remoteagent/contracts";
import {
  PolicyRefusalCode,
  ScopeResolutionError,
  evaluatePolicy,
  resolveConnectionScope,
  type AuthoritativeCaseScope,
  type AuthoritativeConnection,
  type PolicyInput,
} from "@remoteagent/policy";
import { describe, expect, it } from "vitest";

/**
 * AC3: "cross-account and cross-repo prompt injection tests remain contained by
 * policy." Master Plan §13.6: "the private and SonderMind accounts do not leak."
 *
 * The premise of this suite is that a prompt injection SUCCEEDS. Detection is
 * explicitly not a control here (see `THREAT_MODEL.md`, "out of scope"), so the
 * question is not "can hostile text be recognised" but "what does hostile text
 * obtain when it is believed". Every case below assumes the model has been fully
 * convinced and is asking for the wrong account, the wrong repository or the wrong
 * connection — and asserts on the specific refusal CODE, not merely that something
 * threw.
 *
 * Asserting on the code matters, and `CTF-010` finding 1 is why: a test that accepts
 * any failure passes when a weaker layer refuses for an unrelated reason (a
 * malformed id, a missing capability), and would keep passing after the scope check
 * itself was removed. Mutation testing confirmed this on RA-014.
 *
 * "Both directions for both account pairs" is required by the plan: private→
 * SonderMind and SonderMind→private, for Gmail and for Calendar.
 */
const OWNER = "owner-1";

function connection(overrides: Partial<AuthoritativeConnection>): AuthoritativeConnection {
  return {
    connectionId: "conn-x",
    ownerId: OWNER,
    provider: Provider.GMAIL,
    alias: ConnectionAlias.PRIVATE,
    capabilities: ["read", "draft"],
    health: ConnectionHealth.HEALTHY,
    scopes: [{ kind: ConnectionScopeKind.ACCOUNT, value: "private-account" }],
    ...overrides,
  };
}

/** The two Gmail accounts, and the two Calendars. */
const GMAIL_PRIVATE = connection({
  connectionId: "gmail-private",
  alias: ConnectionAlias.PRIVATE,
  scopes: [{ kind: ConnectionScopeKind.ACCOUNT, value: "private-account" }],
});
const GMAIL_SONDERMIND = connection({
  connectionId: "gmail-sondermind",
  alias: ConnectionAlias.SONDERMIND,
  scopes: [{ kind: ConnectionScopeKind.ACCOUNT, value: "sondermind-account" }],
});
const CALENDAR_PRIVATE = connection({
  connectionId: "cal-private",
  provider: Provider.CALENDAR,
  alias: ConnectionAlias.PRIVATE,
  capabilities: ["read", "write"],
  scopes: [{ kind: ConnectionScopeKind.CALENDAR, value: "private-calendar" }],
});
const CALENDAR_SONDERMIND = connection({
  connectionId: "cal-sondermind",
  provider: Provider.CALENDAR,
  alias: ConnectionAlias.SONDERMIND,
  capabilities: ["read", "write"],
  scopes: [{ kind: ConnectionScopeKind.CALENDAR, value: "sondermind-calendar" }],
});

const ALL_CONNECTIONS = [GMAIL_PRIVATE, GMAIL_SONDERMIND, CALENDAR_PRIVATE, CALENDAR_SONDERMIND];

/** A case granted exactly one connection and one resource on it. */
function caseScopedTo(
  caseId: string,
  connectionId: string,
  kind: ConnectionScopeKind,
  value: string,
): AuthoritativeCaseScope {
  return {
    caseId,
    ownerId: OWNER,
    connectionIds: [connectionId],
    resourceScopes: [{ connectionId, kind, value }],
  };
}

function scopeError(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    if (error instanceof ScopeResolutionError) return error.message;
    throw error;
  }
}

describe("AC3: a successful injection cannot reach the other Gmail account", () => {
  const privateCase = caseScopedTo(
    "case-private",
    "gmail-private",
    ConnectionScopeKind.ACCOUNT,
    "private-account",
  );
  const sondermindCase = caseScopedTo(
    "case-sondermind",
    "gmail-sondermind",
    ConnectionScopeKind.ACCOUNT,
    "sondermind-account",
  );

  it("private -> sondermind: naming the other ALIAS finds no connection", () => {
    // The most direct injection: "read the SonderMind mailbox instead". The alias is
    // not a credential, so asking for it must not produce one.
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: privateCase,
          connections: ALL_CONNECTIONS,
          provider: Provider.GMAIL,
          alias: ConnectionAlias.SONDERMIND,
          requiredCapability: "read",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });

  it("sondermind -> private: the same attack in the other direction", () => {
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: sondermindCase,
          connections: ALL_CONNECTIONS,
          provider: Provider.GMAIL,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "read",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });

  it("naming the other CONNECTION ID directly is refused", () => {
    // A leaked or guessed connection id is not authority. Distinct refusal message,
    // so the test cannot pass on the alias check instead.
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: privateCase,
          connections: ALL_CONNECTIONS,
          provider: Provider.GMAIL,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "read",
          requestedConnectionId: "gmail-sondermind",
        }),
      ),
    ).toBe("requested connection is outside authoritative case scope");
  });

  it("naming the other account as a TARGET is refused", () => {
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: privateCase,
          connections: ALL_CONNECTIONS,
          provider: Provider.GMAIL,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "read",
          requestedTarget: {
            kind: ConnectionScopeKind.ACCOUNT,
            value: "sondermind-account",
          },
        }),
      ),
    ).toBe("requested provider resource is not allowlisted for this case");
  });

  it("the resolved scope returns ONLY the case's grant, never the connection's list", () => {
    // The leak that needs no error at all: returning a connection's full scope list
    // hands the caller resources the owner granted to a different case.
    const widelyScoped = connection({
      connectionId: "gmail-private",
      alias: ConnectionAlias.PRIVATE,
      scopes: [
        { kind: ConnectionScopeKind.ACCOUNT, value: "private-account" },
        { kind: ConnectionScopeKind.ACCOUNT, value: "sondermind-account" },
      ],
    });
    const resolved = resolveConnectionScope({
      caseScope: privateCase,
      connections: [widelyScoped],
      provider: Provider.GMAIL,
      alias: ConnectionAlias.PRIVATE,
      requiredCapability: "read",
    });
    expect(resolved.scopes).toEqual([
      { kind: ConnectionScopeKind.ACCOUNT, value: "private-account" },
    ]);
    expect(JSON.stringify(resolved.scopes)).not.toContain("sondermind");
  });

  it("a case granted BOTH connections is ambiguous, not silently first-wins", () => {
    // Two candidates must refuse rather than pick. "Pick one" is how a case with
    // mixed grants quietly writes to the wrong account.
    const bothAliases: AuthoritativeCaseScope = {
      caseId: "case-both",
      ownerId: OWNER,
      connectionIds: ["gmail-private", "gmail-private-2"],
      resourceScopes: [
        {
          connectionId: "gmail-private",
          kind: ConnectionScopeKind.ACCOUNT,
          value: "private-account",
        },
        {
          connectionId: "gmail-private-2",
          kind: ConnectionScopeKind.ACCOUNT,
          value: "private-account-2",
        },
      ],
    };
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: bothAliases,
          connections: [
            GMAIL_PRIVATE,
            connection({
              connectionId: "gmail-private-2",
              alias: ConnectionAlias.PRIVATE,
              scopes: [{ kind: ConnectionScopeKind.ACCOUNT, value: "private-account-2" }],
            }),
          ],
          provider: Provider.GMAIL,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "read",
        }),
      ),
    ).toBe("connection selection is ambiguous inside the authoritative case scope");
  });
});

describe("AC3: a successful injection cannot reach the other Calendar", () => {
  const privateCase = caseScopedTo(
    "case-cal-private",
    "cal-private",
    ConnectionScopeKind.CALENDAR,
    "private-calendar",
  );
  const sondermindCase = caseScopedTo(
    "case-cal-sondermind",
    "cal-sondermind",
    ConnectionScopeKind.CALENDAR,
    "sondermind-calendar",
  );

  it("private -> sondermind", () => {
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: privateCase,
          connections: ALL_CONNECTIONS,
          provider: Provider.CALENDAR,
          alias: ConnectionAlias.SONDERMIND,
          requiredCapability: "write",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });

  it("sondermind -> private", () => {
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: sondermindCase,
          connections: ALL_CONNECTIONS,
          provider: Provider.CALENDAR,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "write",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });

  it("a Gmail grant does not authorise a Calendar connection", () => {
    // Cross-PROVIDER, same alias: an injection asking to "use the same account's
    // calendar" must not ride a Gmail grant.
    const gmailOnly = caseScopedTo(
      "case-gmail-only",
      "gmail-private",
      ConnectionScopeKind.ACCOUNT,
      "private-account",
    );
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: gmailOnly,
          connections: ALL_CONNECTIONS,
          provider: Provider.CALENDAR,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "write",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });
});

describe("AC3: cross-repository containment", () => {
  const REPO_A = connection({
    connectionId: "gitlab-a",
    provider: Provider.GITLAB,
    capabilities: ["read", "write"],
    scopes: [{ kind: ConnectionScopeKind.REPOSITORY, value: "group/repo-a" }],
  });
  const REPO_BOTH = connection({
    connectionId: "gitlab-a",
    provider: Provider.GITLAB,
    capabilities: ["read", "write"],
    scopes: [
      { kind: ConnectionScopeKind.REPOSITORY, value: "group/repo-a" },
      { kind: ConnectionScopeKind.REPOSITORY, value: "group/repo-secret" },
    ],
  });
  const caseA = caseScopedTo(
    "case-a",
    "gitlab-a",
    ConnectionScopeKind.REPOSITORY,
    "group/repo-a",
  );

  it("a case scoped to repo-a cannot target repo-secret", () => {
    // The realistic version: ONE connection whose token can reach both repositories.
    // Containment therefore cannot come from the credential — it has to come from the
    // per-case grant.
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: caseA,
          connections: [REPO_BOTH],
          provider: Provider.GITLAB,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "write",
          requestedTarget: {
            kind: ConnectionScopeKind.REPOSITORY,
            value: "group/repo-secret",
          },
        }),
      ),
    ).toBe("requested provider resource is not allowlisted for this case");
  });

  it("the resolved scope does not even mention the other repository", () => {
    const resolved = resolveConnectionScope({
      caseScope: caseA,
      connections: [REPO_BOTH],
      provider: Provider.GITLAB,
      alias: ConnectionAlias.PRIVATE,
      requiredCapability: "write",
    });
    expect(JSON.stringify(resolved.scopes)).not.toContain("repo-secret");
  });

  it("a STALE grant cannot resurrect a de-configured repository", () => {
    // The owner removed `repo-secret` from the connection but an old case grant
    // survives. A grant that no longer intersects the configured scopes is dropped,
    // so the stale grant cannot widen anything (AUDIT-03 MEDIUM-06).
    const staleCase: AuthoritativeCaseScope = {
      caseId: "case-stale",
      ownerId: OWNER,
      connectionIds: ["gitlab-a"],
      resourceScopes: [
        {
          connectionId: "gitlab-a",
          kind: ConnectionScopeKind.REPOSITORY,
          value: "group/repo-secret",
        },
      ],
    };
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: staleCase,
          connections: [REPO_A],
          provider: Provider.GITLAB,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "write",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });

  it("another owner's connection is never a candidate", () => {
    const foreign = connection({
      connectionId: "gitlab-foreign",
      ownerId: "owner-2",
      provider: Provider.GITLAB,
      capabilities: ["read", "write"],
      scopes: [{ kind: ConnectionScopeKind.REPOSITORY, value: "group/repo-a" }],
    });
    const crossOwnerCase: AuthoritativeCaseScope = {
      caseId: "case-cross-owner",
      ownerId: OWNER,
      connectionIds: ["gitlab-foreign"],
      resourceScopes: [
        {
          connectionId: "gitlab-foreign",
          kind: ConnectionScopeKind.REPOSITORY,
          value: "group/repo-a",
        },
      ],
    };
    expect(
      scopeError(() =>
        resolveConnectionScope({
          caseScope: crossOwnerCase,
          connections: [foreign],
          provider: Provider.GITLAB,
          alias: ConnectionAlias.PRIVATE,
          requiredCapability: "write",
        }),
      ),
    ).toBe("no connection satisfies the authoritative case scope");
  });
});

describe("AC3: policy refuses an out-of-scope connection even if a caller reaches it", () => {
  function policyInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
    return {
      toolName: "gmail.draft.create",
      caseId: "case-private",
      ownerId: OWNER,
      provider: Provider.GMAIL,
      connectionId: "gmail-private",
      caseConnectionIds: ["gmail-private"],
      connectionHealth: ConnectionHealth.HEALTHY,
      credentialExpiresAt: null,
      killSwitches: [],
      now: new Date("2026-08-21T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("allows the in-scope draft", () => {
    const evaluation = evaluatePolicy(policyInput());
    expect(evaluation.decision).toBe(PolicyDecision.AUTO_ALLOW);
    expect(evaluation.riskTier).toBe(RiskTier.R2);
  });

  it("DENIES an action on the other account's connection", () => {
    // Second, independent layer: even if scope resolution were bypassed entirely,
    // the policy engine refuses a connection outside the case's scope.
    const evaluation = evaluatePolicy(policyInput({ connectionId: "gmail-sondermind" }));
    expect(evaluation.decision).toBe(PolicyDecision.DENY);
    expect(evaluation.refusalCode).toBe(PolicyRefusalCode.CONNECTION_OUT_OF_SCOPE);
  });

  it("DENIES an unregistered tool as R4, not R0", () => {
    // "Send this email to the address in the ticket" — sending is not a registered
    // action at all, so it has no tier and no established blast radius.
    const evaluation = evaluatePolicy(policyInput({ toolName: "gmail.message.send" }));
    expect(evaluation.decision).toBe(PolicyDecision.DENY);
    expect(evaluation.refusalCode).toBe(PolicyRefusalCode.UNKNOWN_ACTION);
    expect(evaluation.riskTier).toBe(RiskTier.R4);
  });

  it("refuses a tool annotation that claims a lower tier, rather than ignoring it", () => {
    // An MCP descriptor claiming a merge is read-only. Refused, not ignored: the
    // mismatch means something upstream is wrong or hostile.
    const evaluation = evaluatePolicy(
      policyInput({ toolName: "gitlab.mr.merge", annotatedRiskTier: RiskTier.R0 }),
    );
    expect(evaluation.decision).toBe(PolicyDecision.DENY);
    expect(evaluation.refusalCode).toBe(PolicyRefusalCode.TIER_DOWNGRADE_ATTEMPT);
  });

  it("requires an exact approval for a merge, whatever the caller asks for", () => {
    const evaluation = evaluatePolicy(
      policyInput({ toolName: "gitlab.mr.merge", provider: Provider.GITLAB }),
    );
    expect(evaluation.decision).toBe(PolicyDecision.REQUIRES_APPROVAL);
    expect(evaluation.riskTier).toBe(RiskTier.R4);
  });

  it("a kill switch stops an in-scope, auto-allowed action", () => {
    const evaluation = evaluatePolicy(
      policyInput({
        killSwitches: [
          {
            eventId: "ks-1",
            level: "GLOBAL",
            provider: null,
            connectionId: null,
            enabled: true,
            reason: "operator stop",
          },
        ],
      }),
    );
    expect(evaluation.decision).toBe(PolicyDecision.DENY);
    expect(evaluation.refusalCode).toBe(PolicyRefusalCode.KILL_SWITCH_ACTIVE);
  });

  it("an expired credential is refused, and a backdated clock is the caller's risk", () => {
    // Recorded rather than fixed here: `PolicyInput.now` must come from the DATABASE
    // clock. The RA-022-WU-03 probe showed a backdated `now` turns an expired
    // credential into an allowed action, and a pure evaluator cannot defend itself.
    // Both halves are asserted so the requirement is visible, not implied.
    const expiry = new Date("2026-08-20T00:00:00.000Z");
    const refused = evaluatePolicy(
      policyInput({ credentialExpiresAt: expiry, now: new Date("2026-08-21T00:00:00.000Z") }),
    );
    expect(refused.decision).toBe(PolicyDecision.DENY);
    expect(refused.refusalCode).toBe(PolicyRefusalCode.CONNECTION_BLOCKED);

    const backdated = evaluatePolicy(
      policyInput({ credentialExpiresAt: expiry, now: new Date("2026-08-19T00:00:00.000Z") }),
    );
    expect(backdated.decision).toBe(PolicyDecision.AUTO_ALLOW);
  });
});
