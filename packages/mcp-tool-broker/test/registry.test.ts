/**
 * WU-02 — AC1 (scope cannot come from the model) and AC2 (minimal manifest).
 *
 * Every refusal here is asserted on its specific `RefusalCode`, never on "it
 * threw". `CTF-010` finding 1 is that a test asserting the weaker outcome passes
 * when a weaker layer than the intended one did the refusing — so a cross-scope
 * probe that merely throws would still pass if the strict schema rejected the key
 * as unknown and the AC1 gate were absent entirely.
 */
import { AgentRole, RiskTier } from "@remoteagent/contracts";
import type { AuthoritativeConnection } from "@remoteagent/policy";
import * as z from "zod";
import { describe, expect, it } from "vitest";

import {
  RefusalCode,
  ToolBrokerError,
  ToolBrokerRefusal,
  type ToolDescriptor,
} from "../src/contracts.js";
import {
  ToolRegistry,
  isSealedManifest,
  resolveToolScope,
  type BrokerCaseContext,
} from "../src/registry.js";

const OWNER = "owner-1";
const CASE = "case-1";

const jiraReadIssue: ToolDescriptor = {
  name: "jira.read_issue",
  provider: "jira",
  version: 1,
  risk_tier: RiskTier.R0,
  description: "Read one Jira issue in the case's project.",
  scope: { scope_kind: "project", required_capability: "jira:read" },
  arguments_schema: z.strictObject({ issue_key: z.string().min(1).max(64) }),
  allowed_roles: [AgentRole.PLANNER, AgentRole.REVIEWER],
};

const gitlabReadMr: ToolDescriptor = {
  name: "gitlab.read_merge_request",
  provider: "gitlab",
  version: 1,
  risk_tier: RiskTier.R0,
  description: "Read one merge request in the case's repository.",
  scope: { scope_kind: "repository", required_capability: "gitlab:read" },
  arguments_schema: z.strictObject({ iid: z.number().int().positive() }),
  allowed_roles: [AgentRole.REVIEWER],
};

function registry(): ToolRegistry {
  return new ToolRegistry(
    [jiraReadIssue, gitlabReadMr],
    [
      { role: AgentRole.PLANNER, step: "triage", tools: ["jira.read_issue"] },
      {
        role: AgentRole.REVIEWER,
        step: "review",
        tools: ["jira.read_issue", "gitlab.read_merge_request"],
      },
      { role: AgentRole.REVIEWER, step: "handoff", tools: [] },
    ],
  );
}

function jiraConnection(overrides: Partial<AuthoritativeConnection> = {}): AuthoritativeConnection {
  return {
    connectionId: "conn-jira-work",
    ownerId: OWNER,
    provider: "jira",
    alias: "sondermind",
    capabilities: ["jira:read"],
    health: "HEALTHY",
    scopes: [{ kind: "project", value: "MOBL" }],
    ...overrides,
  };
}

function context(overrides: Partial<BrokerCaseContext> = {}): BrokerCaseContext {
  const connections = overrides.connections ?? [jiraConnection()];
  return {
    caseScope: overrides.caseScope ?? {
      caseId: CASE,
      ownerId: OWNER,
      connectionIds: ["conn-jira-work"],
      resourceScopes: [{ connectionId: "conn-jira-work", kind: "project", value: "MOBL" }],
    },
    connections,
  };
}

function intent(args: Record<string, unknown>, toolName = "jira.read_issue") {
  return {
    schema_version: 1 as const,
    intent_id: "intent-1",
    tool_name: toolName,
    arguments: { trust: "UNTRUSTED_DATA" as const, value: args },
  };
}

/** Refuse and assert on the specific code, not merely that it threw. */
function expectRefusal(fn: () => unknown, code: RefusalCode): ToolBrokerRefusal {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected a refusal").toBeInstanceOf(ToolBrokerRefusal);
  const refusal = caught as ToolBrokerRefusal;
  expect(refusal.code).toBe(code);
  return refusal;
}

describe("registration is the policy gate", () => {
  it("refuses a descriptor above the executable risk tier", () => {
    expect(() => new ToolRegistry([{ ...jiraReadIssue, risk_tier: RiskTier.R2 }])).toThrow(
      ToolBrokerError,
    );
  });

  it("refuses a descriptor declaring a scope-naming argument", () => {
    // The layer that makes the forbidden-name list more than a runtime check: an
    // author cannot legitimize `connection_id` by declaring it.
    expect(
      () =>
        new ToolRegistry([
          {
            ...jiraReadIssue,
            arguments_schema: z.strictObject({
              issue_key: z.string(),
              connection_id: z.string(),
            }),
          },
        ]),
    ).toThrow(/names authoritative scope/);
  });

  it("refuses a scope-naming argument spelled differently", () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...jiraReadIssue,
            arguments_schema: z.strictObject({ connectionId: z.string() }),
          },
        ]),
    ).toThrow(/names authoritative scope/);
  });

  it("refuses a non-strict arguments schema", () => {
    // z.object passes unknown keys through, so an unvalidated argument would reach
    // the provider. Only strictObject makes an unknown key an error.
    expect(
      () =>
        new ToolRegistry([
          { ...jiraReadIssue, arguments_schema: z.object({ issue_key: z.string() }) },
        ]),
    ).toThrow(/strict object schema/);
    expect(
      () =>
        new ToolRegistry([
          { ...jiraReadIssue, arguments_schema: z.looseObject({ issue_key: z.string() }) },
        ]),
    ).toThrow(/strict object schema/);
  });

  it("refuses a non-read scope kind", () => {
    expect(
      () =>
        new ToolRegistry([
          {
            ...jiraReadIssue,
            scope: { scope_kind: "discord_channel", required_capability: "jira:read" },
          },
        ]),
    ).toThrow(/not a provider read resource/);
  });

  it("refuses a step policy that widens past the descriptor's roles", () => {
    // A step policy narrows; it never widens. The Implementer is not in
    // jira.read_issue's allowed_roles.
    expect(
      () =>
        new ToolRegistry(
          [jiraReadIssue],
          [{ role: AgentRole.IMPLEMENTER, step: "triage", tools: ["jira.read_issue"] }],
        ),
    ).toThrow(/does not allow role/);
  });

  it("refuses a step policy naming an unregistered tool", () => {
    expect(
      () =>
        new ToolRegistry(
          [jiraReadIssue],
          [{ role: AgentRole.PLANNER, step: "triage", tools: ["jira.delete_everything"] }],
        ),
    ).toThrow(/unknown tool/);
  });

  it("refuses a duplicate registration", () => {
    expect(() => new ToolRegistry([jiraReadIssue, jiraReadIssue])).toThrow(/registered twice/);
  });
});

describe("AC2 — a role sees the minimal manifest for its step", () => {
  it("gives a role only the tools its step declares", () => {
    const manifest = registry().manifestFor({
      caseId: CASE,
      role: AgentRole.PLANNER,
      step: "triage",
    });
    expect(manifest.tools.map((tool) => tool.name)).toEqual(["jira.read_issue"]);
  });

  it("narrows per step, not per role", () => {
    // The same Reviewer sees two tools while reviewing and none at handoff. A
    // role-only manifest could not express this.
    const reg = registry();
    expect(
      reg.manifestFor({ caseId: CASE, role: AgentRole.REVIEWER, step: "review" }).tools,
    ).toHaveLength(2);
    expect(
      reg.manifestFor({ caseId: CASE, role: AgentRole.REVIEWER, step: "handoff" }).tools,
    ).toHaveLength(0);
  });

  it("yields an EMPTY manifest for an unknown step, not the full registry", () => {
    // CTF-010 finding 4: a missing declaration is not consent. Falling back to
    // "everything this role may use" would turn an omission into a widening.
    const manifest = registry().manifestFor({
      caseId: CASE,
      role: AgentRole.REVIEWER,
      step: "step-that-was-never-configured",
    });
    expect(manifest.tools).toEqual([]);
  });

  it("carries the server-authored description, not remote prose", () => {
    const manifest = registry().manifestFor({
      caseId: CASE,
      role: AgentRole.PLANNER,
      step: "triage",
    });
    expect(manifest.tools[0]?.description).toBe(jiraReadIssue.description);
  });

  it("seals the manifest and freezes it", () => {
    const manifest = registry().manifestFor({
      caseId: CASE,
      role: AgentRole.PLANNER,
      step: "triage",
    });
    expect(isSealedManifest(manifest)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.tools)).toBe(true);
  });

  it("refuses a hand-built manifest that looks identical", () => {
    // AC2 would be bypassable by an object literal if the executor trusted shape
    // instead of provenance.
    const real = registry().manifestFor({
      caseId: CASE,
      role: AgentRole.PLANNER,
      step: "triage",
    });
    const forged = { ...real, tools: [...real.tools] };
    expect(isSealedManifest(forged)).toBe(false);
    expect(() =>
      resolveToolScope({
        registry: registry(),
        manifest: forged,
        context: context(),
        intent: intent({ issue_key: "MOBL-1" }),
        role: AgentRole.PLANNER,
      }),
    ).toThrow(/not produced by the registry/);
  });
});

describe("AC1 — the model cannot select connection, repo or account", () => {
  it("resolves scope from the case grants with no model input", () => {
    const resolved = resolveToolScope({
      registry: registry(),
      manifest: registry().manifestFor({
        caseId: CASE,
        role: AgentRole.PLANNER,
        step: "triage",
      }),
      context: context(),
      intent: intent({ issue_key: "MOBL-1" }),
      role: AgentRole.PLANNER,
    });
    expect(resolved.intent.scope.owner_id).toBe(OWNER);
    expect(resolved.intent.scope.connection_ids).toEqual(["conn-jira-work"]);
    expect(resolved.target).toEqual({ kind: "project", value: "MOBL" });
    // Only the validated arguments are forwarded.
    expect(resolved.intent.arguments).toEqual({ issue_key: "MOBL-1" });
  });

  it("refuses a foreign connection_id with SCOPE_IN_ARGUMENTS, not a generic error", () => {
    // The adversarial probe AC1 names: another owner's connection supplied as an
    // argument must be REFUSED, not ignored and not used.
    const refusal = expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context(),
          intent: intent({ issue_key: "MOBL-1", connection_id: "conn-of-another-owner" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.SCOPE_IN_ARGUMENTS,
    );
    // The rejected value is untrusted content and must not be echoed into a log.
    expect(refusal.message).not.toContain("conn-of-another-owner");
  });

  it("refuses every scope-naming spelling in arguments", () => {
    for (const key of [
      "connection_id",
      "connectionId",
      "Connection-Id",
      "owner_id",
      "repository",
      "repo_allowlist",
      "project_id",
      "account_id",
      "calendar_id",
      "case_id",
      "scope",
      "alias",
    ]) {
      expectRefusal(
        () =>
          resolveToolScope({
            registry: registry(),
            manifest: registry().manifestFor({
              caseId: CASE,
              role: AgentRole.PLANNER,
              step: "triage",
            }),
            context: context(),
            intent: intent({ issue_key: "MOBL-1", [key]: "anything" }),
            role: AgentRole.PLANNER,
          }),
        RefusalCode.SCOPE_IN_ARGUMENTS,
      );
    }
  });

  it("refuses a scope-naming key NESTED inside a permissive argument", () => {
    // Found by an audit probe, not by the unit tests. A descriptor may legitimately
    // accept a record (a filter map), and a top-level-only check forwarded
    // `{ filters: { connection_id: ... } }` straight to the provider. Authoritative
    // scope stayed correct, but a provider-side filter by that name could still
    // narrow or redirect the read, so the channel is closed at every depth.
    const nested: ToolDescriptor = {
      ...jiraReadIssue,
      name: "jira.search_filtered",
      arguments_schema: z.strictObject({ filters: z.record(z.string(), z.string()) }),
    };
    const reg = new ToolRegistry(
      [nested],
      [{ role: AgentRole.PLANNER, step: "triage", tools: ["jira.search_filtered"] }],
    );
    expectRefusal(
      () =>
        resolveToolScope({
          registry: reg,
          manifest: reg.manifestFor({ caseId: CASE, role: AgentRole.PLANNER, step: "triage" }),
          context: context(),
          intent: intent({ filters: { connection_id: "conn-elsewhere" } }, "jira.search_filtered"),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.SCOPE_IN_ARGUMENTS,
    );
  });

  it("refuses a scope-naming key nested inside an array", () => {
    const nested: ToolDescriptor = {
      ...jiraReadIssue,
      name: "jira.search_many",
      arguments_schema: z.strictObject({
        clauses: z.array(z.record(z.string(), z.string())),
      }),
    };
    const reg = new ToolRegistry(
      [nested],
      [{ role: AgentRole.PLANNER, step: "triage", tools: ["jira.search_many"] }],
    );
    expectRefusal(
      () =>
        resolveToolScope({
          registry: reg,
          manifest: reg.manifestFor({ caseId: CASE, role: AgentRole.PLANNER, step: "triage" }),
          context: context(),
          intent: intent({ clauses: [{ ok: "yes" }, { repo: "other/repo" }] }, "jira.search_many"),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.SCOPE_IN_ARGUMENTS,
    );
  });

  it("still admits a legitimate nested record with no scope-naming key", () => {
    // The guard must not make nested arguments unusable: only scope names are barred.
    const nested: ToolDescriptor = {
      ...jiraReadIssue,
      name: "jira.search_ok",
      arguments_schema: z.strictObject({ filters: z.record(z.string(), z.string()) }),
    };
    const reg = new ToolRegistry(
      [nested],
      [{ role: AgentRole.PLANNER, step: "triage", tools: ["jira.search_ok"] }],
    );
    const resolved = resolveToolScope({
      registry: reg,
      manifest: reg.manifestFor({ caseId: CASE, role: AgentRole.PLANNER, step: "triage" }),
      context: context(),
      intent: intent({ filters: { status: "open", label: "bug" } }, "jira.search_ok"),
      role: AgentRole.PLANNER,
    });
    expect(resolved.intent.arguments).toEqual({ filters: { status: "open", label: "bug" } });
  });

  it("refuses credential material in arguments", () => {
    for (const key of ["token", "access_token", "api_key", "authorization", "password"]) {
      expectRefusal(
        () =>
          resolveToolScope({
            registry: registry(),
            manifest: registry().manifestFor({
              caseId: CASE,
              role: AgentRole.PLANNER,
              step: "triage",
            }),
            context: context(),
            intent: intent({ issue_key: "MOBL-1", [key]: "glpat-SHOULD-NEVER-ARRIVE" }),
            role: AgentRole.PLANNER,
          }),
        RefusalCode.SCOPE_IN_ARGUMENTS,
      );
    }
  });

  it("refuses a resource the case was not granted", () => {
    // The case is a member of the connection but holds no grant on it: migration
    // 016's distinction between connection membership and per-case resource grant.
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context({
            caseScope: {
              caseId: CASE,
              ownerId: OWNER,
              connectionIds: ["conn-jira-work"],
              resourceScopes: [],
            },
          }),
          intent: intent({ issue_key: "MOBL-1" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.OUT_OF_SCOPE,
    );
  });

  it("refuses a stale grant whose resource is no longer configured", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context({
            connections: [jiraConnection({ scopes: [{ kind: "project", value: "OTHER" }] })],
          }),
          intent: intent({ issue_key: "MOBL-1" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.OUT_OF_SCOPE,
    );
  });

  it("refuses when the connection lacks the required capability", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context({
            connections: [jiraConnection({ capabilities: ["jira:write"] })],
          }),
          intent: intent({ issue_key: "MOBL-1" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.OUT_OF_SCOPE,
    );
  });

  it("refuses to choose between two aliases of one provider", () => {
    // Cross-account mixing is what RA-019 and RA-020 exist to prevent. Picking one
    // would make the effective mailbox/project depend on ordering.
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context({
            caseScope: {
              caseId: CASE,
              ownerId: OWNER,
              connectionIds: ["conn-jira-work", "conn-jira-private"],
              resourceScopes: [
                { connectionId: "conn-jira-work", kind: "project", value: "MOBL" },
                { connectionId: "conn-jira-private", kind: "project", value: "PRIV" },
              ],
            },
            connections: [
              jiraConnection(),
              jiraConnection({
                connectionId: "conn-jira-private",
                alias: "private",
                scopes: [{ kind: "project", value: "PRIV" }],
              }),
            ],
          }),
          intent: intent({ issue_key: "MOBL-1" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.OUT_OF_SCOPE,
    );
  });

  it("refuses an ambiguous target rather than guessing the first grant", () => {
    // Two projects granted on one connection: the target is not derivable, so the
    // call is refused instead of silently reading whichever grant sorts first.
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context({
            caseScope: {
              caseId: CASE,
              ownerId: OWNER,
              connectionIds: ["conn-jira-work"],
              resourceScopes: [
                { connectionId: "conn-jira-work", kind: "project", value: "MOBL" },
                { connectionId: "conn-jira-work", kind: "project", value: "OTHER" },
              ],
            },
            connections: [
              jiraConnection({
                scopes: [
                  { kind: "project", value: "MOBL" },
                  { kind: "project", value: "OTHER" },
                ],
              }),
            ],
          }),
          intent: intent({ issue_key: "MOBL-1" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.OUT_OF_SCOPE,
    );
  });

  it("refuses another case's owner even with matching ids", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context({
            connections: [jiraConnection({ ownerId: "owner-2" })],
          }),
          intent: intent({ issue_key: "MOBL-1" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.OUT_OF_SCOPE,
    );
  });
});

describe("tool visibility and argument validation", () => {
  it("refuses an unknown tool", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context(),
          intent: intent({ issue_key: "MOBL-1" }, "jira.delete_project"),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.UNKNOWN_TOOL,
    );
  });

  it("refuses a registered tool that is outside this step's manifest", () => {
    // gitlab.read_merge_request exists and the Reviewer may use it — but not in
    // the Planner's triage step.
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context(),
          intent: intent({ iid: 1 }, "gitlab.read_merge_request"),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.TOOL_NOT_IN_MANIFEST,
    );
  });

  it("refuses arguments that fail the descriptor schema", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context(),
          intent: intent({ issue_key: 42 }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.ARGUMENTS_INVALID,
    );
  });

  it("refuses an unknown argument key", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context(),
          intent: intent({ issue_key: "MOBL-1", expand: "changelog" }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.ARGUMENTS_INVALID,
    );
  });

  it("refuses oversized arguments", () => {
    expectRefusal(
      () =>
        resolveToolScope({
          registry: registry(),
          manifest: registry().manifestFor({
            caseId: CASE,
            role: AgentRole.PLANNER,
            step: "triage",
          }),
          context: context(),
          intent: intent({ issue_key: "x".repeat(20_000) }),
          role: AgentRole.PLANNER,
        }),
      RefusalCode.ARGUMENTS_TOO_LARGE,
    );
  });

  it("refuses a manifest minted for another case", () => {
    const other = registry().manifestFor({
      caseId: "case-other",
      role: AgentRole.PLANNER,
      step: "triage",
    });
    expect(() =>
      resolveToolScope({
        registry: registry(),
        manifest: other,
        context: context(),
        intent: intent({ issue_key: "MOBL-1" }),
        role: AgentRole.PLANNER,
      }),
    ).toThrow(/manifest case does not match/);
  });

  it("refuses a manifest minted for another role", () => {
    const reviewerManifest = registry().manifestFor({
      caseId: CASE,
      role: AgentRole.REVIEWER,
      step: "review",
    });
    expect(() =>
      resolveToolScope({
        registry: registry(),
        manifest: reviewerManifest,
        context: context(),
        intent: intent({ issue_key: "MOBL-1" }),
        role: AgentRole.PLANNER,
      }),
    ).toThrow(/manifest role does not match/);
  });
});
