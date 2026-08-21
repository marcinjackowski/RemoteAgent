/**
 * WU-04 — AC4 (oversized/malformed output is bounded and preserved) and AC5
 * (timeout/retry never becomes a false success), against real PostgreSQL.
 *
 * The fake transport is not a shortcut. Every property under test is about what the
 * broker does with what a server sends, and a fake lets a test send the things a
 * real server sends only when something has gone wrong: a 40 MB response, a
 * `NaN`, a `__proto__` key, a reply that never comes, a reply that arrives after
 * the deadline. A real HTTP client would make these cases harder to produce and
 * would prove nothing extra about the boundary.
 *
 * The load-bearing assertion for AC5 is the LEDGER STATE, not the returned value: a
 * caller could always misread a result, but the durable record of what happened is
 * what a reconciliation pass and an auditor read.
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
import * as z from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  MCP_MAX_TOOL_OUTPUT_BYTES,
  McpAmbiguityReason,
  RefusalCode,
  ToolBrokerRefusal,
  type ToolDescriptor,
} from "../src/contracts.js";
import { McpToolBroker, ProviderGuard, mergeServerScopeArgument } from "../src/executor.js";
import { ToolCallLedgerRepository, ToolCallStatus } from "../src/ledger.js";
import { ToolRegistry } from "../src/registry.js";
import type { BrokerCaseContext } from "../src/registry.js";
import {
  ToolTransportFailed,
  type ToolTransport,
  type TransportCallInput,
} from "../src/transport.js";

const available = await ensurePostgres();

const OWNER = "owner-a";
const CASE = "case-a";

const jiraReadIssue: ToolDescriptor = {
  name: "jira.read_issue",
  provider: "jira",
  version: 1,
  risk_tier: RiskTier.R0,
  description: "Read one Jira issue in the case's project.",
  scope: { scope_kind: "project", required_capability: "jira:read" },
  arguments_schema: z.strictObject({ issue_key: z.string().min(1).max(64) }),
  allowed_roles: [AgentRole.PLANNER],
};

/** A transport whose every behaviour is chosen by the test. */
class FakeTransport implements ToolTransport {
  public dispatchCount = 0;
  public callCount = 0;
  public lastArguments: Record<string, unknown> | null = null;

  public constructor(
    private readonly behaviour: {
      version?: string;
      /** Called after `onDispatch` has fired, unless `dispatchFirst` is false. */
      respond?: (input: TransportCallInput) => Promise<unknown>;
      /** When false, the call fails WITHOUT ever dispatching. */
      dispatchFirst?: boolean;
      tools?: readonly unknown[];
    } = {},
  ) {}

  public async protocolVersion(): Promise<string> {
    return this.behaviour.version ?? "2025-06-18";
  }

  public async listTools(): Promise<readonly unknown[]> {
    return this.behaviour.tools ?? [];
  }

  public async call(input: TransportCallInput): Promise<unknown> {
    this.callCount += 1;
    this.lastArguments = { ...input.arguments };
    if (this.behaviour.dispatchFirst !== false) {
      input.onDispatch();
      this.dispatchCount += 1;
    }
    if (this.behaviour.respond === undefined) return { ok: true };
    return this.behaviour.respond(input);
  }
}

/** Never resolves; the deadline is what ends the call. */
const neverResponds = (): Promise<never> => new Promise<never>(() => undefined);

describeIntegration(
  "brokered execution (real PostgreSQL)",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let artifactRoot: string;
    let ledger: ToolCallLedgerRepository;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      artifactRoot = await mkdtemp(join(tmpdir(), "ra-mcp-artifacts-"));
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
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-jira",
        ownerId: OWNER,
        provider: "jira",
        alias: "sondermind",
        displayName: "conn-jira",
      });
      await new CaseRepository().insert(db, {
        caseId: CASE,
        ownerId: OWNER,
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-jira"] },
        discordThreadId: `thread-${CASE}`,
      });
    });

    function connection(): AuthoritativeConnection {
      return {
        connectionId: "conn-jira",
        ownerId: OWNER,
        provider: "jira",
        alias: "sondermind",
        capabilities: ["jira:read"],
        health: "HEALTHY",
        scopes: [{ kind: "project", value: "MOBL" }],
      };
    }

    function context(): BrokerCaseContext {
      return {
        caseScope: {
          caseId: CASE,
          ownerId: OWNER,
          connectionIds: ["conn-jira"],
          resourceScopes: [{ connectionId: "conn-jira", kind: "project", value: "MOBL" }],
        },
        connections: [connection()],
      };
    }

    function brokerWith(
      transport: ToolTransport,
      options: { guard?: ProviderGuard; knownSecrets?: readonly string[] } = {},
    ): McpToolBroker {
      return new McpToolBroker({
        registry: new ToolRegistry(
          [jiraReadIssue],
          [{ role: AgentRole.PLANNER, step: "triage", tools: ["jira.read_issue"] }],
        ),
        ledger,
        transport,
        artifacts: new LocalArtifactStore({ root: artifactRoot }),
        artifactWorkspaceId: "ws-broker",
        guard: options.guard,
        knownSecrets: options.knownSecrets,
      });
    }

    function manifest() {
      return new ToolRegistry(
        [jiraReadIssue],
        [{ role: AgentRole.PLANNER, step: "triage", tools: ["jira.read_issue"] }],
      ).manifestFor({ caseId: CASE, role: AgentRole.PLANNER, step: "triage" });
    }

    function execInput(callId: string, args: Record<string, unknown> = { issue_key: "MOBL-1" }) {
      return {
        intent: {
          schema_version: 1 as const,
          intent_id: `intent-${callId}`,
          tool_name: "jira.read_issue",
          arguments: { trust: "UNTRUSTED_DATA" as const, value: args },
        },
        role: AgentRole.PLANNER,
        manifest: manifest(),
        context: context(),
        callId,
        correlationId: `corr-${callId}`,
        traceId: `trace-${callId}`,
      };
    }

    describe("the happy path establishes provenance (AC6)", () => {
      it("succeeds, records a digest, and marks the output untrusted", async () => {
        const transport = new FakeTransport({ respond: async () => ({ summary: "Fix login" }) });
        const result = await brokerWith(transport).execute(db, execInput("call-ok"));

        expect(result.status).toBe("SUCCEEDED");
        expect(result.output.trust).toBe("UNTRUSTED_DATA");
        expect(result.output.value).toEqual({ summary: "Fix login" });

        const row = await ledger.find(db, "call-ok", { caseId: CASE, ownerId: OWNER });
        expect(row).toMatchObject({
          status: ToolCallStatus.SUCCEEDED,
          toolName: "jira.read_issue",
          correlationId: "corr-call-ok",
          traceId: "trace-call-ok",
        });
        expect(row?.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      });

      it("injects the resolved target as a server-side argument", async () => {
        // The model supplied only `issue_key`. The project came from the case grant.
        const transport = new FakeTransport({ respond: async () => ({ ok: true }) });
        await brokerWith(transport).execute(db, execInput("call-inject"));
        expect(transport.lastArguments).toEqual({ issue_key: "MOBL-1", project_id: "MOBL" });
      });

      it("errors rather than choosing when a validated argument collides with the injected one", () => {
        // Driven directly because the executor path is unreachable by design: two
        // earlier layers reject `project_id` from model output. A mutation probe
        // showed that a spread-order-only guarantee broke no test, so the collision
        // is an explicit refusal instead of a silent precedence rule.
        expect(() =>
          mergeServerScopeArgument({ issue_key: "MOBL-1" }, "project", "MOBL"),
        ).not.toThrow();
        expect(mergeServerScopeArgument({ issue_key: "MOBL-1" }, "project", "MOBL")).toEqual({
          issue_key: "MOBL-1",
          project_id: "MOBL",
        });
        let caught: unknown;
        try {
          mergeServerScopeArgument({ project_id: "OTHER" }, "project", "MOBL");
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(ToolBrokerRefusal);
        expect((caught as ToolBrokerRefusal).code).toBe(RefusalCode.SCOPE_IN_ARGUMENTS);
      });
    });

    describe("AC5: a timeout after dispatch is AMBIGUOUS, never a success or a retry", () => {
      it("records AMBIGUOUS with a reason and does not call twice", async () => {
        const transport = new FakeTransport({ respond: neverResponds });
        const result = await brokerWith(transport).execute(db, {
          ...execInput("call-timeout"),
          timeoutMs: 40,
        });

        // The contract has two statuses; the payload must not read as a success.
        expect(result.status).toBe("FAILED");
        expect(result.output.value).toMatchObject({
          ambiguous: true,
          requires_reconciliation: true,
        });
        // No blind replay. This is the assertion that would fail if a retry were
        // added "because reads are safe".
        expect(transport.callCount).toBe(1);

        const row = await ledger.find(db, "call-timeout", { caseId: CASE, ownerId: OWNER });
        expect(row).toMatchObject({
          status: ToolCallStatus.AMBIGUOUS,
          ambiguityReason: McpAmbiguityReason.TIMEOUT_AFTER_DISPATCH,
          resultDigest: null,
          requiresReconciliation: true,
        });
      });

      it("classifies a pre-dispatch failure as FAILED, not AMBIGUOUS", async () => {
        // Nothing was sent, so this one IS retryable. Collapsing the two cases in
        // either direction is the defect AC5 describes.
        const transport = new FakeTransport({
          dispatchFirst: false,
          respond: async () => {
            throw new ToolTransportFailed("connection refused");
          },
        });
        const result = await brokerWith(transport).execute(db, execInput("call-predispatch"));
        expect(result.status).toBe("FAILED");
        expect(transport.dispatchCount).toBe(0);

        const row = await ledger.find(db, "call-predispatch", { caseId: CASE, ownerId: OWNER });
        expect(row).toMatchObject({
          status: ToolCallStatus.FAILED,
          ambiguityReason: null,
        });
      });

      it("treats an unclassified post-dispatch error as AMBIGUOUS", async () => {
        // The fail-safe direction: the transport did not state that the request had
        // no effect, so we may not assume it.
        const transport = new FakeTransport({
          respond: async () => {
            throw new Error("socket hung up");
          },
        });
        await brokerWith(transport).execute(db, execInput("call-lost"));
        const row = await ledger.find(db, "call-lost", { caseId: CASE, ownerId: OWNER });
        expect(row?.status).toBe(ToolCallStatus.AMBIGUOUS);
      });

      it("leaves a dispatched row resolvable when the process dies mid-call", async () => {
        // Simulates the crash: the dispatch row is committed, the settle never runs.
        // A later pass in any process must resolve it to AMBIGUOUS, never SUCCEEDED.
        await ledger.recordDispatch(db, {
          callId: "call-crashed",
          intentId: "intent-crashed",
          scope: { caseId: CASE, ownerId: OWNER },
          role: AgentRole.PLANNER,
          toolName: "jira.read_issue",
          toolVersion: 1,
          provider: "jira",
          riskTier: RiskTier.R0,
          validatedArgumentsDigest: `sha256:${"c".repeat(64)}`,
          correlationId: "corr-crashed",
          traceId: "trace-crashed",
        });
        expect(await ledger.reconcileUnresolved(db, { caseId: CASE, ownerId: OWNER })).toBe(1);
        expect(
          (await ledger.find(db, "call-crashed", { caseId: CASE, ownerId: OWNER }))?.status,
        ).toBe(ToolCallStatus.AMBIGUOUS);
      });
    });

    describe("AC4: oversized and malformed output is bounded and preserved", () => {
      it("truncates a huge response and keeps the full payload as an artifact", async () => {
        const huge = "x".repeat(MCP_MAX_TOOL_OUTPUT_BYTES + 50_000);
        const transport = new FakeTransport({ respond: async () => ({ body: huge }) });
        const result = await brokerWith(transport).execute(db, execInput("call-huge"));

        expect(result.status).toBe("SUCCEEDED");
        const value = result.output.value as Record<string, unknown>;
        expect(value["truncated"]).toBe(true);
        expect(value["original_byte_length"]).toBeGreaterThan(MCP_MAX_TOOL_OUTPUT_BYTES);
        expect(typeof value["artifact_id"]).toBe("string");
        // The bounded payload really is bounded.
        expect(Buffer.byteLength(JSON.stringify(result.output.value), "utf8")).toBeLessThan(
          MCP_MAX_TOOL_OUTPUT_BYTES,
        );

        const row = await ledger.find(db, "call-huge", { caseId: CASE, ownerId: OWNER });
        expect(row?.artifactId).toBe(value["artifact_id"]);
      });

      it("refuses a non-finite number as a protocol violation", async () => {
        const transport = new FakeTransport({ respond: async () => ({ count: Number.NaN }) });
        await expect(
          brokerWith(transport).execute(db, execInput("call-nan")),
        ).rejects.toMatchObject({ code: RefusalCode.PROTOCOL_VIOLATION });
        // Malformed output is still preserved as evidence before being rejected.
        const row = await ledger.find(db, "call-nan", { caseId: CASE, ownerId: OWNER });
        expect(row?.status).toBe(ToolCallStatus.FAILED);
        expect(row?.artifactId).not.toBeNull();
      });

      it("drops prototype-polluting keys instead of carrying them", async () => {
        const transport = new FakeTransport({
          respond: async () => JSON.parse('{"ok":true,"__proto__":{"admin":true}}'),
        });
        const result = await brokerWith(transport).execute(db, execInput("call-proto"));
        const value = result.output.value as Record<string, unknown>;
        expect(value["ok"]).toBe(true);
        expect(Object.keys(value)).not.toContain("__proto__");
        expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
      });

      it("refuses a response that nests too deeply", async () => {
        let deep: Record<string, unknown> = { end: true };
        for (let i = 0; i < 60; i += 1) deep = { next: deep };
        const transport = new FakeTransport({ respond: async () => deep });
        await expect(
          brokerWith(transport).execute(db, execInput("call-deep")),
        ).rejects.toMatchObject({ code: RefusalCode.PROTOCOL_VIOLATION });
      });

      it("refuses a function-valued response", async () => {
        const transport = new FakeTransport({ respond: async () => (() => "nope") as unknown });
        await expect(brokerWith(transport).execute(db, execInput("call-fn"))).rejects.toMatchObject(
          { code: RefusalCode.PROTOCOL_VIOLATION },
        );
      });
    });

    describe("refusals are recorded, not merely thrown", () => {
      it("records a cross-scope attempt in the ledger", async () => {
        // The audit question this table exists to answer.
        const transport = new FakeTransport();
        await expect(
          brokerWith(transport).execute(
            db,
            execInput("call-crossscope", { issue_key: "MOBL-1", connection_id: "conn-elsewhere" }),
          ),
        ).rejects.toMatchObject({ code: RefusalCode.SCOPE_IN_ARGUMENTS });

        const row = await ledger.find(db, "call-crossscope", { caseId: CASE, ownerId: OWNER });
        expect(row).toMatchObject({
          status: ToolCallStatus.REFUSED,
          refusalCode: RefusalCode.SCOPE_IN_ARGUMENTS,
          resultDigest: null,
        });
        // Nothing reached the transport.
        expect(transport.callCount).toBe(0);
      });

      it("records an unknown tool without a descriptor", async () => {
        const transport = new FakeTransport();
        await expect(
          brokerWith(transport).execute(db, {
            ...execInput("call-unknown"),
            intent: {
              schema_version: 1 as const,
              intent_id: "intent-unknown",
              tool_name: "jira.delete_project",
              arguments: { trust: "UNTRUSTED_DATA" as const, value: {} },
            },
          }),
        ).rejects.toMatchObject({ code: RefusalCode.UNKNOWN_TOOL });
        const row = await ledger.find(db, "call-unknown", { caseId: CASE, ownerId: OWNER });
        expect(row?.refusalCode).toBe(RefusalCode.UNKNOWN_TOOL);
      });

      it("refuses an unsupported protocol version before dispatching", async () => {
        const transport = new FakeTransport({ version: "1999-01-01" });
        await expect(
          brokerWith(transport).execute(db, execInput("call-version")),
        ).rejects.toMatchObject({ code: RefusalCode.VERSION_UNSUPPORTED });
        expect(transport.callCount).toBe(0);
        const row = await ledger.find(db, "call-version", { caseId: CASE, ownerId: OWNER });
        expect(row?.refusalCode).toBe(RefusalCode.VERSION_UNSUPPORTED);
      });
    });

    describe("circuit breaker and rate limit", () => {
      it("opens after consecutive failures and refuses with CIRCUIT_OPEN", async () => {
        const guard = new ProviderGuard({ failureThreshold: 2, openMs: 60_000 });
        const failing = new FakeTransport({
          respond: async () => {
            throw new ToolTransportFailed("upstream 500");
          },
          dispatchFirst: false,
        });
        const broker = brokerWith(failing, { guard });
        await broker.execute(db, execInput("call-f1"));
        await broker.execute(db, execInput("call-f2"));

        await expect(broker.execute(db, execInput("call-f3"))).rejects.toMatchObject({
          code: RefusalCode.CIRCUIT_OPEN,
        });
        const row = await ledger.find(db, "call-f3", { caseId: CASE, ownerId: OWNER });
        expect(row?.refusalCode).toBe(RefusalCode.CIRCUIT_OPEN);
      });

      it("counts AMBIGUOUS toward opening the breaker", async () => {
        // A server producing ambiguous outcomes is exactly one that should stop
        // being called; treating AMBIGUOUS as neutral would keep it in rotation.
        const guard = new ProviderGuard({ failureThreshold: 1, openMs: 60_000 });
        const stalling = new FakeTransport({ respond: neverResponds });
        const broker = brokerWith(stalling, { guard });
        await broker.execute(db, { ...execInput("call-a1"), timeoutMs: 30 });
        await expect(
          broker.execute(db, { ...execInput("call-a2"), timeoutMs: 30 }),
        ).rejects.toMatchObject({ code: RefusalCode.CIRCUIT_OPEN });
      });

      it("refuses with RATE_LIMITED when the window budget is spent", async () => {
        const guard = new ProviderGuard({ maxCallsPerWindow: 2, windowMs: 60_000 });
        const transport = new FakeTransport({ respond: async () => ({ ok: true }) });
        const broker = brokerWith(transport, { guard });
        await broker.execute(db, execInput("call-r1"));
        await broker.execute(db, execInput("call-r2"));
        await expect(broker.execute(db, execInput("call-r3"))).rejects.toMatchObject({
          code: RefusalCode.RATE_LIMITED,
        });
      });

      it("allows one probe after the open window elapses", async () => {
        let clock = 1_000;
        const guard = new ProviderGuard({ failureThreshold: 1, openMs: 500 }, () => clock);
        const transport = new FakeTransport({
          respond: async () => {
            throw new ToolTransportFailed("down");
          },
          dispatchFirst: false,
        });
        const broker = brokerWith(transport, { guard });
        await broker.execute(db, execInput("call-p1"));
        clock += 100;
        await expect(broker.execute(db, execInput("call-p2"))).rejects.toBeInstanceOf(
          ToolBrokerRefusal,
        );
        clock += 1_000;
        // Half-open: the probe is permitted (and fails on its own merits).
        const result = await broker.execute(db, execInput("call-p3"));
        expect(result.status).toBe("FAILED");
      });
    });

    describe("secret hygiene", () => {
      it("redacts a known secret from an error message", async () => {
        const transport = new FakeTransport({
          dispatchFirst: false,
          respond: async () => {
            throw new ToolTransportFailed("auth failed for glpat-AAAABBBBCCCCDDDDEEEE");
          },
        });
        const result = await brokerWith(transport, {
          knownSecrets: ["glpat-AAAABBBBCCCCDDDDEEEE"],
        }).execute(db, execInput("call-secret"));
        expect(result.error_message ?? "").not.toContain("glpat-AAAABBBBCCCCDDDDEEEE");
      });
    });
  },
  available,
);
