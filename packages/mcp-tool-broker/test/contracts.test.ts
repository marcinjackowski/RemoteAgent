/**
 * WU-01 — broker contracts, and the export boundary that `CTF-002` demands.
 *
 * The intersection test is the load-bearing one here. `CTF-002` established by
 * probe that ESM silently DROPS a name exported by two modules of one `export *`
 * barrel: no compile error, no runtime error, just `undefined` where a schema was
 * expected. RA-021 is the task where that stops being theoretical, because it
 * consumes `contracts.toolIntent` while `implementation-tools` exports its own
 * differently-shaped tool contracts. So this package asserts its barrel shares no
 * name with either — the same guard `implementation-tools/test/contracts.test.ts`
 * carries, pointed the other way.
 */
import { describe, expect, it } from "vitest";

import { RiskTier } from "@remoteagent/contracts";

import * as brokerBarrel from "../src/index.js";
import {
  EXECUTABLE_RISK_TIERS,
  FORBIDDEN_ARGUMENT_NAMES,
  MAX_TOOL_ARGUMENTS_BYTES,
  MCP_MAX_TOOL_OUTPUT_BYTES,
  McpAmbiguityReason,
  READ_SCOPE_KINDS,
  RefusalCode,
  ToolBrokerRefusal,
  ToolCallOutcome,
  isForbiddenArgumentName,
  normalizeArgumentName,
  remoteToolAdvertisement,
  toolCallLedgerEntry,
} from "../src/contracts.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function ledgerEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    call_id: "call-1",
    intent_id: "intent-1",
    case_id: "case-1",
    role: "PLANNER",
    tool_name: "jira.read_issue",
    provider: "jira",
    tool_version: 1,
    risk_tier: RiskTier.R0,
    outcome: ToolCallOutcome.SUCCEEDED,
    refusal_code: null,
    ambiguity_reason: null,
    validated_arguments_digest: DIGEST,
    result_digest: DIGEST,
    artifact_id: null,
    latency_ms: 12,
    correlation_id: "corr-1",
    trace_id: "trace-1",
    observed_at: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("broker contracts build on the accepted tool contracts", () => {
  it("shares no exported name with @remoteagent/contracts", async () => {
    const contracts = await import("@remoteagent/contracts");
    const overlap = Object.keys(brokerBarrel).filter((name) => name in contracts);
    expect(overlap).toEqual([]);
  });

  it("shares no exported name with @remoteagent/implementation-tools", async () => {
    const implementationTools = await import("@remoteagent/implementation-tools");
    const overlap = Object.keys(brokerBarrel).filter((name) => name in implementationTools);
    expect(overlap).toEqual([]);
  });

  it("does not re-declare toolIntent, resolvedToolIntent or toolResult", () => {
    // The accepted contracts own these. A second definition here is precisely the
    // CTF-002 collision, and it would also mean two sources of truth for the
    // authority boundary AC1 rests on.
    expect(brokerBarrel).not.toHaveProperty("toolIntent");
    expect(brokerBarrel).not.toHaveProperty("resolvedToolIntent");
    expect(brokerBarrel).not.toHaveProperty("toolResult");
    expect(brokerBarrel).not.toHaveProperty("resolvedToolScope");
  });

  it("drops the skeleton packageName export", () => {
    // One of the six duplicate `packageName` literals in CTF-002.
    expect(brokerBarrel).not.toHaveProperty("packageName");
  });
});

describe("forbidden argument names", () => {
  it("collapses case and separators so spelling cannot bypass the check", () => {
    expect(normalizeArgumentName("Connection-Id")).toBe("connectionid");
    expect(normalizeArgumentName("connection_id")).toBe("connectionid");
    expect(normalizeArgumentName("  CONNECTION ID  ")).toBe("connectionid");
  });

  it("rejects every scope-naming spelling variant", () => {
    for (const name of [
      "connection_id",
      "connectionId",
      "Connection-ID",
      "owner_id",
      "repo",
      "repository_id",
      "project_id",
      "calendar_id",
      "case_id",
      "scope",
      "scopes",
      "alias",
    ]) {
      expect(isForbiddenArgumentName(name), name).toBe(true);
    }
  });

  it("rejects every credential-naming spelling variant", () => {
    for (const name of [
      "token",
      "access_token",
      "refreshToken",
      "api_key",
      "apiKey",
      "Authorization",
      "secret",
      "password",
      "credentials",
    ]) {
      expect(isForbiddenArgumentName(name), name).toBe(true);
    }
  });

  it("admits legitimate read arguments", () => {
    for (const name of ["issue_key", "query", "max_results", "message_id", "event_id", "since"]) {
      expect(isForbiddenArgumentName(name), name).toBe(false);
    }
  });

  it("keeps the list free of duplicates after normalization", () => {
    // A duplicate would be harmless but signals the list was edited without
    // understanding that normalization already collapses spellings.
    const normalized = FORBIDDEN_ARGUMENT_NAMES.map(normalizeArgumentName);
    expect(new Set(normalized).size).toBe(normalized.length);
  });
});

describe("remote advertisements are pinned untrusted", () => {
  it("accepts a well-formed advertisement", () => {
    const parsed = remoteToolAdvertisement.parse({
      trust: "UNTRUSTED_DATA",
      name: "jira.read_issue",
      description: "Reads an issue.",
      input_schema: { type: "object" },
    });
    expect(parsed.trust).toBe("UNTRUSTED_DATA");
  });

  it("refuses an advertisement that relabels itself TRUSTED", () => {
    // Trust is assigned by the boundary, never chosen by the sender. A remote
    // server claiming TRUSTED is the simplest possible authority escalation.
    const result = remoteToolAdvertisement.safeParse({
      trust: "TRUSTED",
      name: "jira.read_issue",
      description: "Reads an issue.",
      input_schema: { type: "object" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields fail-closed", () => {
    const result = remoteToolAdvertisement.safeParse({
      trust: "UNTRUSTED_DATA",
      name: "jira.read_issue",
      description: "Reads an issue.",
      input_schema: { type: "object" },
      risk_tier: "R0",
    });
    expect(result.success).toBe(false);
  });
});

describe("ledger entry contract (AC6)", () => {
  it("accepts a complete successful entry", () => {
    expect(toolCallLedgerEntry.parse(ledgerEntry())).toMatchObject({
      outcome: ToolCallOutcome.SUCCEEDED,
      latency_ms: 12,
    });
  });

  it("requires every AC6 field", () => {
    for (const field of [
      "intent_id",
      "validated_arguments_digest",
      "latency_ms",
      "correlation_id",
      "trace_id",
    ]) {
      const entry = ledgerEntry();
      delete entry[field];
      expect(toolCallLedgerEntry.safeParse(entry).success, field).toBe(false);
    }
  });

  it("rejects a digest that is not sha256-shaped", () => {
    expect(
      toolCallLedgerEntry.safeParse(ledgerEntry({ validated_arguments_digest: "deadbeef" }))
        .success,
    ).toBe(false);
  });

  it("rejects a negative latency", () => {
    expect(toolCallLedgerEntry.safeParse(ledgerEntry({ latency_ms: -1 })).success).toBe(false);
  });

  it("rejects unknown fields fail-closed", () => {
    expect(toolCallLedgerEntry.safeParse(ledgerEntry({ raw_arguments: "{}" })).success).toBe(false);
  });
});

describe("closed enumerations", () => {
  it("keeps R0 the only executable tier and consumes the accepted enum", () => {
    // RiskTier is NOT redefined here: it comes from @remoteagent/contracts, which
    // already covers R0–R4. Only the executable subset is broker policy.
    expect(EXECUTABLE_RISK_TIERS).toEqual([RiskTier.R0]);
    expect(EXECUTABLE_RISK_TIERS).not.toContain(RiskTier.R2);
  });

  it("separates FAILED from AMBIGUOUS (AC5)", () => {
    expect(ToolCallOutcome.FAILED).not.toBe(ToolCallOutcome.AMBIGUOUS);
    expect(Object.keys(McpAmbiguityReason)).toContain("TIMEOUT_AFTER_DISPATCH");
  });

  it("keeps MCP ambiguity reasons distinct from local filesystem ones", async () => {
    // Two enums on purpose: a network read has no PARTIAL_WRITE mode and a file
    // write has no dispatch. The prefix makes the distinction visible rather than
    // letting ESM drop one of them (CTF-002).
    const implementationTools = await import("@remoteagent/implementation-tools");
    expect(Object.keys(McpAmbiguityReason)).not.toContain("PARTIAL_WRITE");
    expect(Object.keys(implementationTools.AmbiguityReason)).not.toContain(
      "TIMEOUT_AFTER_DISPATCH",
    );
  });

  it("gives every refusal its own code rather than a shared failure", () => {
    // CTF-010 finding 1: a test asserting only "it failed" passes when a weaker
    // layer refused. Distinct codes are what make those tests meaningful.
    const codes = Object.values(RefusalCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain(RefusalCode.SCOPE_IN_ARGUMENTS);
    expect(codes).toContain(RefusalCode.SCHEMA_DRIFT);
  });

  it("limits read scope kinds to provider resources", () => {
    expect(READ_SCOPE_KINDS).toEqual(["account", "repository", "calendar", "project"]);
    expect(READ_SCOPE_KINDS).not.toContain("discord_channel");
  });

  it("carries a refusal code on the error type", () => {
    const refusal = new ToolBrokerRefusal(RefusalCode.OUT_OF_SCOPE);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.code).toBe(RefusalCode.OUT_OF_SCOPE);
  });

  it("bounds arguments and output", () => {
    expect(MAX_TOOL_ARGUMENTS_BYTES).toBeLessThan(MCP_MAX_TOOL_OUTPUT_BYTES);
  });

  it("keeps its output ceiling distinct from the local toolset's", async () => {
    // Different values under one name is the CTF-002 collision; a remote provider
    // response is legitimately larger than a local command's output.
    const implementationTools = await import("@remoteagent/implementation-tools");
    expect(MCP_MAX_TOOL_OUTPUT_BYTES).not.toBe(implementationTools.MAX_TOOL_OUTPUT_BYTES);
  });
});
