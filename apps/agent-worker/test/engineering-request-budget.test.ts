import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeConfig, type RuntimeRequest } from "@remoteagent/model-runtime";
import { canonicalJsonStringify } from "@remoteagent/contracts";
import { afterEach, expect, it } from "vitest";
import {
  ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  EngineeringModelBudgetError,
  EngineeringDebugJournal,
  createEngineeringDebugTransport,
  engineeringModelRequestTokenReserve,
  runWithEngineeringCorrectionModelCallBudget,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const config = createRuntimeConfig({
  model: { provider: "qualification_fake", model_id: "budget-test" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 1, maxCalls: 1 },
});

it("measures request bytes without signal and keeps the configured floor", () => {
  const request: RuntimeRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: "ż" }] }],
    tools: [{ name: "patch", description: "秘密", inputSchema: { type: "object" } }],
    outputSchema: { name: "result", schema: { type: "object" } },
    signal: new AbortController().signal,
  };
  const measured = engineeringModelRequestTokenReserve(request, 128_000);
  expect(measured.requestBytes).toBe(
    Buffer.byteLength(
      canonicalJsonStringify({
        messages: request.messages,
        tools: request.tools,
        outputSchema: request.outputSchema,
      }),
      "utf8",
    ),
  );
  expect(measured.reserveTokens).toBe(Math.max(128_000, measured.requestBytes + 16_384));
  const { signal, ...withoutSignal } = request;
  expect(signal?.aborted).toBe(false);
  expect(engineeringModelRequestTokenReserve(withoutSignal, 128_000)).toEqual(measured);
  expect(measured.reserveTokens).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
});

it.each(["tools", "outputSchema"] as const)("includes large %s in the reserve", (field) => {
  const text = "秘密".repeat(40_000);
  const request: RuntimeRequest = {
    messages: [],
    ...(field === "tools"
      ? { tools: [{ name: "patch", inputSchema: { description: text } }] }
      : { outputSchema: { name: "result", schema: { description: text } } }),
  };
  const expectedBytes = Buffer.byteLength(canonicalJsonStringify(request), "utf8");
  expect(engineeringModelRequestTokenReserve(request, 128_000)).toEqual({
    requestBytes: expectedBytes,
    reserveTokens: expectedBytes + 16_384,
  });
});

it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid floor %s",
  (floor) => {
    expect(() => engineeringModelRequestTokenReserve({ messages: [] }, floor)).toThrow(/invalid/u);
  },
);

it.each([
  { remaining: 205_487, calls: 1, decision: "RESERVED" },
  { remaining: 120_000, calls: 0, decision: "REFUSED" },
])("small correction with $remaining remaining makes $calls delegate calls", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "engineering-request-control-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "control",
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    converse: async () => {
      calls++;
      return {
        model: config.model,
        content: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  const request: RuntimeRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: "PRIVATE-CONTROL" }] }],
  };
  let failure: unknown;
  try {
    await runWithEngineeringDebugJournal(
      journal,
      () => runWithEngineeringCorrectionModelCallBudget(() => transport.converse(request, config)),
      {
        priorJournalCount: 0,
        providerReportedTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - scenario.remaining,
        accountedTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - scenario.remaining,
        estimatedTokens: 0,
        completeness: "COMPLETE",
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    await journal.close();
  }
  expect(calls).toBe(scenario.calls);
  if (scenario.calls === 0) expect(failure).toBeInstanceOf(EngineeringModelBudgetError);
  else expect(failure).toBeUndefined();
  const text = await readFile(journal.filePath, "utf8");
  const events = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events.filter((event) => event.event === "MODEL_CALL_ADMISSION")).toEqual([
    expect.objectContaining({
      decision: scenario.decision,
      reserved_tokens: 128_000,
      accounted_tokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - scenario.remaining,
    }),
  ]);
  expect(text).not.toContain("PRIVATE-CONTROL");
  expect(await readFile(journal.summaryFilePath, "utf8")).toContain("current reserve 128000");
});

it("refuses a large correction request before delegate dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-request-budget-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "large",
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    converse: async () => {
      calls += 1;
      return { model: config.model, content: [{ type: "text", text: "ok" }] };
    },
  });
  const request: RuntimeRequest = {
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200_000) }] }],
  };
  let error: unknown;
  await runWithEngineeringDebugJournal(
    journal,
    () =>
      runWithEngineeringCorrectionModelCallBudget(async () => {
        try {
          await transport.converse(request, config);
        } catch (caught) {
          error = caught;
        }
      }),
    {
      priorJournalCount: 0,
      providerReportedTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - 205_487,
      estimatedTokens: 0,
      accountedTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - 205_487,
      completeness: "COMPLETE",
    },
  );
  await journal.close();
  expect(calls).toBe(0);
  expect(error).toBeInstanceOf(EngineeringModelBudgetError);
  const journalText = await readFile(journal.filePath, "utf8");
  const admissions = journalText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === "MODEL_CALL_ADMISSION");
  expect(admissions).toHaveLength(1);
  const expected = engineeringModelRequestTokenReserve(request, 128_000);
  expect(admissions[0]).toMatchObject({
    decision: "REFUSED",
    request_bytes: expected.requestBytes,
    reserved_tokens: expected.reserveTokens,
    accounted_tokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - 205_487,
  });
  expect(journalText).not.toContain("x".repeat(100));
});
