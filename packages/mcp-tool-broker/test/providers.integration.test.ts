/**
 * WU-07 — the read-only provider catalogue, end to end across all four providers.
 *
 * Two classes of assertion here. First, catalogue INVARIANTS that hold for every
 * descriptor at once (all `R0`, no scope-naming argument, correct scope kind per
 * provider) — these are the ones that catch a tool added later without the reasoning
 * this task established. Second, cross-provider isolation driven through the real
 * broker: a case granted the work Jira project and the private mailbox must reach
 * exactly those and nothing else.
 *
 * The cross-account probe runs in BOTH directions, as RA-019 and RA-020 required of
 * their own suites: a leak that only manifests one way is still a leak.
 */
import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
} from "@remoteagent/database";
import { AgentRole, RiskTier } from "@remoteagent/contracts";
import { LocalArtifactStore } from "@remoteagent/test-evidence";
import type { AuthoritativeConnection } from "@remoteagent/policy";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  FORBIDDEN_ARGUMENT_NAMES,
  READ_SCOPE_KINDS,
  RefusalCode,
  isForbiddenArgumentName,
} from "../src/contracts.js";
import { McpToolBroker } from "../src/executor.js";
import { ToolCallLedgerRepository, ToolCallStatus } from "../src/ledger.js";
import {
  ALL_READ_TOOLS,
  CALENDAR_READ_TOOLS,
  DEFAULT_STEP_POLICIES,
  GITLAB_READ_TOOLS,
  GMAIL_READ_TOOLS,
  JIRA_READ_TOOLS,
} from "../src/providers.js";
import { ToolRegistry } from "../src/registry.js";
import type { BrokerCaseContext } from "../src/registry.js";
import type { ToolTransport, TransportCallInput } from "../src/transport.js";

const available = await ensurePostgres();

const OWNER = "owner-a";
const CASE = "case-a";

class RecordingTransport implements ToolTransport {
  public lastArguments: Record<string, unknown> | null = null;
  public lastTool: string | null = null;

  public async protocolVersion(): Promise<string> {
    return "2025-06-18";
  }

  public async listTools(): Promise<readonly unknown[]> {
    return [];
  }

  public async call(input: TransportCallInput): Promise<unknown> {
    input.onDispatch();
    this.lastTool = input.toolName;
    this.lastArguments = { ...input.arguments };
    return { ok: true };
  }
}

describe("catalogue invariants", () => {
  it("registers every tool without error", () => {
    // Registration is the policy gate, so this alone proves every descriptor is R0,
    // read-scoped, and free of scope-naming arguments.
    expect(() => new ToolRegistry(ALL_READ_TOOLS, DEFAULT_STEP_POLICIES)).not.toThrow();
  });

  it("keeps every tool at the read-only risk tier", () => {
    for (const tool of ALL_READ_TOOLS) {
      expect(tool.risk_tier, tool.name).toBe(RiskTier.R0);
    }
  });

  it("offers no write tool for any provider", () => {
    // RA-021 is read-only; external writes belong to RA-022 behind approval.
    const forbidden = /\b(create|update|delete|send|post|add|push|merge|close|assign|comment)\b/i;
    for (const tool of ALL_READ_TOOLS) {
      expect(forbidden.test(tool.name), `${tool.name} looks like a write`).toBe(false);
    }
  });

  it("declares no scope-naming argument anywhere", () => {
    for (const tool of ALL_READ_TOOLS) {
      const shape = (tool.arguments_schema as { def: { shape: Record<string, unknown> } }).def
        .shape;
      for (const key of Object.keys(shape)) {
        expect(isForbiddenArgumentName(key), `${tool.name}.${key}`).toBe(false);
      }
    }
  });

  it("binds each provider to the scope kind its own task established", () => {
    // Gmail is per ACCOUNT (RA-019: two mailboxes that must not mix). Calendar is per
    // CALENDAR, not per account (RA-020: the unit is the account/calendar pair, since
    // a per-account cursor would let one calendar advance another's position).
    for (const tool of JIRA_READ_TOOLS) expect(tool.scope.scope_kind, tool.name).toBe("project");
    for (const tool of GMAIL_READ_TOOLS) expect(tool.scope.scope_kind, tool.name).toBe("account");
    for (const tool of CALENDAR_READ_TOOLS)
      expect(tool.scope.scope_kind, tool.name).toBe("calendar");
    for (const tool of GITLAB_READ_TOOLS)
      expect(tool.scope.scope_kind, tool.name).toBe("repository");
  });

  it("uses only provider read scope kinds", () => {
    for (const tool of ALL_READ_TOOLS) {
      expect(READ_SCOPE_KINDS).toContain(tool.scope.scope_kind);
    }
  });

  it("gives every tool a unique name and at least one role", () => {
    const names = ALL_READ_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of ALL_READ_TOOLS) expect(tool.allowed_roles.length).toBeGreaterThan(0);
  });

  it("requires a bounded window for calendar listing", () => {
    // An unbounded list is how a scoped read becomes an export of the whole calendar.
    const listing = CALENDAR_READ_TOOLS.find(
      (tool) => tool.name === "calendar.list_events_in_window",
    );
    const shape = (listing?.arguments_schema as { def: { shape: Record<string, unknown> } }).def
      .shape;
    expect(Object.keys(shape)).toContain("window_start");
    expect(Object.keys(shape)).toContain("window_end");
    expect(listing?.arguments_schema.safeParse({ limit: 10 }).success).toBe(false);
  });

  it("does not expose mail bodies or attachment content", () => {
    // RA-019 made fetching a body a separate, justified act; re-exposing it as a tool
    // argument would route around that decision.
    for (const tool of GMAIL_READ_TOOLS) {
      const shape = (tool.arguments_schema as { def: { shape: Record<string, unknown> } }).def
        .shape;
      for (const key of Object.keys(shape)) {
        expect(key).not.toMatch(/body|attachment|content|raw/i);
      }
    }
  });

  it("gives the Implementer no provider tools", () => {
    const registry = new ToolRegistry(ALL_READ_TOOLS, DEFAULT_STEP_POLICIES);
    const manifest = registry.manifestFor({
      caseId: CASE,
      role: AgentRole.IMPLEMENTER,
      step: "implement",
    });
    expect(manifest.tools).toEqual([]);
  });

  it("narrows the Planner's manifest between triage and context", () => {
    const registry = new ToolRegistry(ALL_READ_TOOLS, DEFAULT_STEP_POLICIES);
    const triage = registry.manifestFor({
      caseId: CASE,
      role: AgentRole.PLANNER,
      step: "triage",
    });
    const context = registry.manifestFor({
      caseId: CASE,
      role: AgentRole.PLANNER,
      step: "context",
    });
    // Triage is Jira-only; a Planner triaging an issue has no reason to read a mailbox.
    expect(triage.tools.every((tool) => tool.provider === "jira")).toBe(true);
    expect(context.tools.length).toBeGreaterThan(triage.tools.length);
  });

  it("does not create a dependency edge to any connector package", async () => {
    // The red-team correction: eslint's boundaries allow package -> package, so a
    // cycle would not be caught by lint. A connector supplies the TRANSPORT at wiring
    // time; the broker must not import one.
    const manifest = await import("../package.json", { with: { type: "json" } });
    const dependencies = Object.keys(
      (manifest.default as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(dependencies.filter((name) => name.includes("connector"))).toEqual([]);
  });

  it("keeps the forbidden-argument list covering every injected scope name", () => {
    // If a scope argument name were absent from the list, a descriptor could declare
    // it and scope would arrive from the model with no rule broken.
    for (const name of ["project_id", "account_id", "calendar_id", "repository_id"]) {
      expect(
        FORBIDDEN_ARGUMENT_NAMES.some(
          (entry) => isForbiddenArgumentName(entry) && isForbiddenArgumentName(name),
        ),
      ).toBe(true);
      expect(isForbiddenArgumentName(name), name).toBe(true);
    }
  });
});

describeIntegration(
  "provider reads stay inside the case's grants (real PostgreSQL)",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let artifactRoot: string;
    let ledger: ToolCallLedgerRepository;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      artifactRoot = await mkdtemp(join(tmpdir(), "ra-mcp-providers-"));
    });

    afterAll(async () => {
      await drop();
      await rm(artifactRoot, { recursive: true, force: true });
    });

    beforeEach(async () => {
      ledger = new ToolCallLedgerRepository();
      await db.query(
        "TRUNCATE mcp_tool_calls, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: OWNER, displayName: OWNER });
      const connections = new ConnectionRepository();
      for (const [id, provider, alias] of [
        ["conn-jira-work", "jira", "sondermind"],
        ["conn-gmail-private", "gmail", "private"],
        ["conn-gmail-work", "gmail", "sondermind"],
        ["conn-cal-work", "calendar", "sondermind"],
        ["conn-gitlab-work", "gitlab", "sondermind"],
      ] as const) {
        await connections.insert(db, {
          connectionId: id,
          ownerId: OWNER,
          provider,
          alias,
          displayName: id,
        });
      }
      await new CaseRepository().insert(db, {
        caseId: CASE,
        ownerId: OWNER,
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-jira-work"] },
        discordThreadId: `thread-${CASE}`,
      });
    });

    function connection(
      id: string,
      provider: "jira" | "gmail" | "calendar" | "gitlab",
      alias: "private" | "sondermind",
      scopes: readonly { kind: "project" | "account" | "calendar" | "repository"; value: string }[],
    ): AuthoritativeConnection {
      return {
        connectionId: id,
        ownerId: OWNER,
        provider,
        alias,
        capabilities: [`${provider}:read`],
        health: "HEALTHY",
        scopes,
      };
    }

    /** A case granted: work Jira, PRIVATE mailbox, work calendar, work repo. */
    function context(): BrokerCaseContext {
      return {
        caseScope: {
          caseId: CASE,
          ownerId: OWNER,
          connectionIds: [
            "conn-jira-work",
            "conn-gmail-private",
            "conn-cal-work",
            "conn-gitlab-work",
          ],
          resourceScopes: [
            { connectionId: "conn-jira-work", kind: "project", value: "MOBL" },
            { connectionId: "conn-gmail-private", kind: "account", value: "me@private.example" },
            { connectionId: "conn-cal-work", kind: "calendar", value: "work-primary" },
            { connectionId: "conn-gitlab-work", kind: "repository", value: "acme/app" },
          ],
        },
        connections: [
          connection("conn-jira-work", "jira", "sondermind", [{ kind: "project", value: "MOBL" }]),
          connection("conn-gmail-private", "gmail", "private", [
            { kind: "account", value: "me@private.example" },
          ]),
          // Granted on NEITHER resource: present as a connection the owner has, but
          // not in the case's grants. It must be unreachable.
          connection("conn-gmail-work", "gmail", "sondermind", [
            { kind: "account", value: "me@sondermind.example" },
          ]),
          connection("conn-cal-work", "calendar", "sondermind", [
            { kind: "calendar", value: "work-primary" },
          ]),
          connection("conn-gitlab-work", "gitlab", "sondermind", [
            { kind: "repository", value: "acme/app" },
          ]),
        ],
      };
    }

    function broker(transport: ToolTransport): McpToolBroker {
      return new McpToolBroker({
        registry: new ToolRegistry(ALL_READ_TOOLS, DEFAULT_STEP_POLICIES),
        ledger,
        transport,
        artifacts: new LocalArtifactStore({ root: artifactRoot }),
        artifactWorkspaceId: "ws-broker",
      });
    }

    function exec(
      callId: string,
      toolName: string,
      role: AgentRole,
      step: string,
      args: Record<string, unknown>,
    ) {
      return {
        intent: {
          schema_version: 1 as const,
          intent_id: `intent-${callId}`,
          tool_name: toolName,
          arguments: { trust: "UNTRUSTED_DATA" as const, value: args },
        },
        role,
        manifest: new ToolRegistry(ALL_READ_TOOLS, DEFAULT_STEP_POLICIES).manifestFor({
          caseId: CASE,
          role,
          step,
        }),
        context: context(),
        callId,
        correlationId: `corr-${callId}`,
        traceId: `trace-${callId}`,
      };
    }

    it("injects the granted Jira project, not one the model could name", async () => {
      const transport = new RecordingTransport();
      await broker(transport).execute(
        db,
        exec("c-jira", "jira.read_issue", AgentRole.PLANNER, "triage", { issue_key: "MOBL-7" }),
      );
      expect(transport.lastArguments).toEqual({ issue_key: "MOBL-7", project_id: "MOBL" });
    });

    it("injects the granted PRIVATE mailbox and never the work one", async () => {
      // The RA-019 isolation property, enforced here by grant rather than by filter.
      const transport = new RecordingTransport();
      await broker(transport).execute(
        db,
        exec("c-gmail", "gmail.read_thread_metadata", AgentRole.PLANNER, "context", {
          thread_id: "t-1",
        }),
      );
      expect(transport.lastArguments).toEqual({
        thread_id: "t-1",
        account_id: "me@private.example",
      });
      expect(JSON.stringify(transport.lastArguments)).not.toContain("sondermind.example");
    });

    it("injects the granted calendar, keeping the account/calendar pair intact", async () => {
      const transport = new RecordingTransport();
      await broker(transport).execute(
        db,
        exec("c-cal", "calendar.read_event", AgentRole.PLANNER, "context", { event_id: "e-1" }),
      );
      expect(transport.lastArguments).toEqual({ event_id: "e-1", calendar_id: "work-primary" });
    });

    it("injects the granted repository for a GitLab read", async () => {
      const transport = new RecordingTransport();
      await broker(transport).execute(
        db,
        exec("c-gitlab", "gitlab.read_merge_request", AgentRole.REVIEWER, "review", {
          merge_request_iid: 42,
        }),
      );
      expect(transport.lastArguments).toEqual({
        merge_request_iid: 42,
        repository_id: "acme/app",
      });
    });

    it("refuses a cross-account attempt in BOTH directions", async () => {
      const transport = new RecordingTransport();
      // Direction 1: name the work mailbox explicitly.
      await expect(
        broker(transport).execute(
          db,
          exec("c-cross-1", "gmail.read_thread_metadata", AgentRole.PLANNER, "context", {
            thread_id: "t-1",
            account_id: "me@sondermind.example",
          }),
        ),
      ).rejects.toMatchObject({ code: RefusalCode.SCOPE_IN_ARGUMENTS });
      // Direction 2: name the private mailbox explicitly. Even the GRANTED value is
      // refused when it arrives from the model — the channel is closed, not filtered.
      await expect(
        broker(transport).execute(
          db,
          exec("c-cross-2", "gmail.read_thread_metadata", AgentRole.PLANNER, "context", {
            thread_id: "t-1",
            account_id: "me@private.example",
          }),
        ),
      ).rejects.toMatchObject({ code: RefusalCode.SCOPE_IN_ARGUMENTS });
      expect(transport.lastArguments).toBeNull();
      // Both attempts are durably recorded for audit.
      for (const callId of ["c-cross-1", "c-cross-2"]) {
        expect((await ledger.find(db, callId, { caseId: CASE, ownerId: OWNER }))?.status).toBe(
          ToolCallStatus.REFUSED,
        );
      }
    });

    it("refuses a provider the case holds no grant on", async () => {
      const transport = new RecordingTransport();
      const bare: BrokerCaseContext = {
        caseScope: {
          caseId: CASE,
          ownerId: OWNER,
          connectionIds: ["conn-jira-work"],
          resourceScopes: [{ connectionId: "conn-jira-work", kind: "project", value: "MOBL" }],
        },
        connections: [
          connection("conn-jira-work", "jira", "sondermind", [{ kind: "project", value: "MOBL" }]),
        ],
      };
      await expect(
        broker(transport).execute(db, {
          ...exec("c-nogrant", "calendar.read_event", AgentRole.PLANNER, "context", {
            event_id: "e-1",
          }),
          context: bare,
        }),
      ).rejects.toMatchObject({ code: RefusalCode.OUT_OF_SCOPE });
      expect(transport.lastArguments).toBeNull();
    });

    it("refuses a tool outside the current step even when the role may use it", async () => {
      // The Reviewer may read pipelines in `verify`, but not in `review`.
      const transport = new RecordingTransport();
      await expect(
        broker(transport).execute(
          db,
          exec("c-step", "gitlab.read_pipeline_status", AgentRole.REVIEWER, "review", {
            pipeline_id: 9,
          }),
        ),
      ).rejects.toMatchObject({ code: RefusalCode.TOOL_NOT_IN_MANIFEST });
    });

    it("records every provider read in one ledger with full provenance", async () => {
      const transport = new RecordingTransport();
      const instance = broker(transport);
      await instance.execute(
        db,
        exec("c-l1", "jira.read_issue", AgentRole.PLANNER, "triage", { issue_key: "MOBL-1" }),
      );
      await instance.execute(
        db,
        exec("c-l2", "gitlab.read_merge_request", AgentRole.REVIEWER, "review", {
          merge_request_iid: 1,
        }),
      );
      for (const [callId, provider] of [
        ["c-l1", "jira"],
        ["c-l2", "gitlab"],
      ] as const) {
        const row = await ledger.find(db, callId, { caseId: CASE, ownerId: OWNER });
        expect(row).toMatchObject({
          provider,
          status: ToolCallStatus.SUCCEEDED,
          correlationId: `corr-${callId}`,
          traceId: `trace-${callId}`,
        });
        expect(row?.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    });
  },
  available,
);
