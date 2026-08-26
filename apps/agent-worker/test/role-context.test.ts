import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FakeTransport } from "@remoteagent/bedrock-runtime";
import { ContextCacheState, MetricName, MetricRegistry } from "@remoteagent/observability";

import type { CompiledRoleContext } from "../src/context.js";
import { createRole, roleConfigFromEnv } from "../src/roles.js";

const config = roleConfigFromEnv({ RA_MODEL_ID: "test-model" } as NodeJS.ProcessEnv);

const invocation = {
  unit: {
    workUnit: {
      objective: "Reply to the owner",
      role: "SUPERVISOR",
      case_id: "case-1",
      work_unit_id: "unit-1",
    },
  },
  run: { runId: "run-1" },
} as const;

function textOf(transport: FakeTransport): string {
  return transport.requests[0]!.messages.flatMap((m) => m.content)
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
}

function context(packet: string): CompiledRoleContext {
  return {
    packet,
    packetBytes: new TextEncoder().encode(packet).byteLength,
    estimatedInputTokens: Math.ceil(packet.length / 4),
    cacheState: ContextCacheState.NOT_OBSERVED,
    snapshotDigest: `sha256:${"a".repeat(64)}`,
    compiled: {} as CompiledRoleContext["compiled"],
  };
}

it("requests exact durable identity and sends the compiled packet as a separate turn", async () => {
  const transport = new FakeTransport([]);
  const requests: unknown[] = [];
  const role = createRole({
    transport,
    config,
    readContext: async (request) => {
      requests.push(request);
      return context("ENGINEERING CONTEXT PACKET\nold relevant memoryleak evidence");
    },
  });
  await role.invoke(invocation).catch(() => undefined);

  expect(requests).toEqual([{ caseId: "case-1", runId: "run-1", workUnitId: "unit-1" }]);
  expect(transport.requests[0]!.messages).toHaveLength(2);
  const text = textOf(transport);
  expect(text).toContain("Reply to the owner");
  expect(text).toContain("old relevant memoryleak evidence");
  expect(text).toContain("case-1");
  expect(text).toContain("run-1");
  expect(text).toContain("summary");
  expect(text.toLowerCase()).toContain("first-person");
});

it("records provider input usage only when returned and never substitutes the estimate", async () => {
  const completion = {
    schema_version: 1,
    run_id: "run-1",
    case_id: "case-1",
    status: "COMPLETED",
    summary: "done",
    completed_steps: [],
    evidence: [],
    checkpoint_patch: {},
    next_actions: [],
  } as const;
  const metrics = new MetricRegistry();
  const withUsage = new FakeTransport([
    {
      model: config.model,
      content: [{ type: "json", value: completion }],
      usage: { inputTokens: 37 },
    },
  ]);
  await createRole({
    transport: withUsage,
    config,
    metrics,
    readContext: async () => context("x".repeat(400)), // estimate is 100, deliberately not 37
  }).invoke(invocation);
  expect(metrics.counter(MetricName.MODEL_INPUT_TOKENS)).toBe(37);

  const withoutUsage = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: completion }] },
  ]);
  await createRole({
    transport: withoutUsage,
    config,
    metrics,
    readContext: async () => context("y".repeat(800)),
  }).invoke(invocation);
  expect(metrics.counter(MetricName.MODEL_INPUT_TOKENS)).toBe(37);
});

it("sends only the objective when no context reader is bound", async () => {
  const transport = new FakeTransport([]);
  const role = createRole({ transport, config });
  await role.invoke(invocation).catch(() => undefined);
  expect(transport.requests[0]!.messages).toHaveLength(1);
});

it("production composition cannot silently restore fixed-count case history replay", async () => {
  const source = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  expect(source).toContain("createEngineeringRoleContextReader({");
  expect(source).toContain("persistence.ensureBaselineCheckpoint(caseId)");
  expect(source).not.toMatch(/CaseMessageRepository|\.listRecent\s*\(/u);
});
