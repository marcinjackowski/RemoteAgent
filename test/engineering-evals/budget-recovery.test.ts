import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createRuntimeConfig,
  executeTransportDetailed,
  TransportError,
} from "@remoteagent/model-runtime";
import { StructuredLogger } from "@remoteagent/observability";
import {
  ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
  createEngineeringDebugTransport,
  createEngineeringInvocationJournalRunner,
  EngineeringModelBudgetError,
  runWithEngineeringDebugJournal,
  runWithEngineeringCorrectionModelCallBudget,
  EngineeringDebugJournal,
  assertEngineeringModelCallBudget,
  recoverEngineeringCampaignUsage,
} from "../../apps/agent-worker/src/engineering-debug-journal.js";
import { canonicalDigest } from "@remoteagent/contracts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) =>
        (await import("node:fs/promises")).rm(root, { recursive: true, force: true }),
      ),
  );
});
const config = createRuntimeConfig({
  model: { provider: "test", model_id: "budget" },
  timeoutMs: 1000,
  toolLimits: { maxIterations: 1, maxCalls: 1 },
});

async function campaignJournal(
  root: string,
  invocationId: string,
  input: {
    caseId: string;
    runId: string;
    compatibilityDigest: string;
    totals: number[];
    snapshots?: number[];
    estimated?: number;
    legacy?: boolean;
  },
) {
  const campaignId = canonicalDigest({ case_id: input.caseId, run_id: input.runId });
  const journal = await EngineeringDebugJournal.create({ artifactRoot: root, invocationId });
  await journal.append({
    event: "RUN_STARTED",
    case_id: input.caseId,
    run_id: input.runId,
    model: "subscription",
    base_sha: null,
    config_digest: input.compatibilityDigest,
    ...(input.legacy
      ? {}
      : { campaign_id: campaignId, compatibility_digest: input.compatibilityDigest }),
  });
  for (const [index, total] of input.totals.entries())
    await journal.append({
      event: "MODEL_USAGE",
      stage: null,
      response_total_tokens: total,
      response_estimated_tokens: input.estimated ?? 0,
      responses: 1,
      input_tokens: total,
      output_tokens: 0,
      total_tokens: input.snapshots?.[index] ?? total,
      estimated_tokens: input.estimated ?? 0,
      accounted_tokens: (input.snapshots?.[index] ?? total) + (input.estimated ?? 0),
      responses_without_usage: 0,
      responses_with_partial_usage: 0,
      comparison: "TARGET",
    });
  await journal.append({
    event: "RUN_COMPLETED",
    status: "FAILED",
    commit_sha: null,
    artifact_kinds: [],
  });
  await journal.close();
  return { journal, campaignId };
}

it("sums response deltas rather than cumulative snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-deltas-"));
  roots.push(root);
  const compatibilityDigest = canonicalDigest({ execution: "delta" });
  await campaignJournal(root, "delta", {
    caseId: "case-delta",
    runId: "run-delta",
    compatibilityDigest,
    totals: [10, 20],
    snapshots: [10, 30],
  });
  await expect(
    recoverEngineeringCampaignUsage({
      artifactRoot: root,
      caseId: "case-delta",
      runId: "run-delta",
      campaignId: canonicalDigest({ case_id: "case-delta", run_id: "run-delta" }),
      compatibilityDigest,
    }),
  ).resolves.toMatchObject({ providerReportedTokens: 30 });
});

it("rejects compatibility drift for the same run", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-drift-"));
  roots.push(root);
  const oldDigest = canonicalDigest({ execution: "old" });
  await campaignJournal(root, "drift", {
    caseId: "case-drift",
    runId: "run-drift",
    compatibilityDigest: oldDigest,
    totals: [1],
  });
  await expect(
    recoverEngineeringCampaignUsage({
      artifactRoot: root,
      caseId: "case-drift",
      runId: "run-drift",
      campaignId: canonicalDigest({ case_id: "case-drift", run_id: "run-drift" }),
      compatibilityDigest: canonicalDigest({ execution: "new" }),
    }),
  ).rejects.toThrow(/compatibility drift/);
});

it("rejects legacy matching journals without campaign identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-legacy-"));
  roots.push(root);
  const digest = canonicalDigest({ execution: "legacy" });
  await campaignJournal(root, "legacy", {
    caseId: "case-legacy",
    runId: "run-legacy",
    compatibilityDigest: digest,
    totals: [1],
    legacy: true,
  });
  await expect(
    recoverEngineeringCampaignUsage({
      artifactRoot: root,
      caseId: "case-legacy",
      runId: "run-legacy",
      campaignId: canonicalDigest({ case_id: "case-legacy", run_id: "run-legacy" }),
      compatibilityDigest: digest,
    }),
  ).rejects.toThrow(/new run/);
});

it.each(["truncated", "tampered"] as const)("rejects matching %s journals", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), `ra-campaign-${kind}-`));
  roots.push(root);
  const digest = canonicalDigest({ execution: kind });
  const { journal } = await campaignJournal(root, kind, {
    caseId: `case-${kind}`,
    runId: `run-${kind}`,
    compatibilityDigest: digest,
    totals: [1],
  });
  const bytes = await readFile(journal.filePath, "utf8");
  await writeFile(
    journal.filePath,
    kind === "truncated"
      ? bytes.slice(0, -2)
      : bytes.replace('"record_digest":"', '"record_digest":"0'),
  );
  await expect(
    recoverEngineeringCampaignUsage({
      artifactRoot: root,
      caseId: `case-${kind}`,
      runId: `run-${kind}`,
      campaignId: canonicalDigest({ case_id: `case-${kind}`, run_id: `run-${kind}` }),
      compatibilityDigest: digest,
    }),
  ).rejects.toThrow();
});

it("ignores unrelated complete journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-unrelated-"));
  roots.push(root);
  const digest = canonicalDigest({ execution: "unrelated" });
  await campaignJournal(root, "unrelated", {
    caseId: "other-case",
    runId: "other-run",
    compatibilityDigest: digest,
    totals: [99],
  });
  await expect(
    recoverEngineeringCampaignUsage({
      artifactRoot: root,
      caseId: "target-case",
      runId: "target-run",
      campaignId: canonicalDigest({ case_id: "target-case", run_id: "target-run" }),
      compatibilityDigest: digest,
    }),
  ).resolves.toMatchObject({ priorJournalCount: 0, accountedTokens: 0 });
});

it("blocks a production runner before transport when recovered usage exhausts the budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-runner-hard-"));
  roots.push(root);
  const caseId = "case-runner-hard";
  const runId = "run-runner-hard";
  const compatibilityDigest = canonicalDigest({ execution: "runner-hard" });
  await campaignJournal(root, "runner-hard-prior", {
    caseId,
    runId,
    compatibilityDigest,
    totals: [ENGINEERING_MODEL_CALL_TOKEN_RESERVE + 1_700_000],
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    converse: async (_request, config) => {
      calls += 1;
      return { model: config.model, content: [] };
    },
  });
  const runner = createEngineeringInvocationJournalRunner({
    artifactRoot: root,
    db: { query: async () => ({ rows: [] }) } as never,
    model: "subscription",
    configDigest: compatibilityDigest,
    compatibilityDigest,
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
  });
  await expect(
    runner.run(
      {
        jobId: "job-hard",
        caseId,
        payload: { caseId, runId },
        attempts: 1,
        fencingToken: 1,
      } as never,
      () => transport.converse({ messages: [] }, config),
    ),
  ).rejects.toBeInstanceOf(EngineeringModelBudgetError);
  expect(calls).toBe(0);
  const recordTexts = await Promise.all(
    (await (await import("node:fs/promises")).readdir(join(root, "engineering-debug")))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(join(root, "engineering-debug", name), "utf8")),
  );
  const records = recordTexts.find((text) => text.includes("CAMPAIGN_USAGE_RECOVERED")) ?? "";
  expect(records).toContain("CAMPAIGN_USAGE_RECOVERED");
  expect(records).toContain("MODEL_CALL_REFUSED_BUDGET");
});

it("separates prior, current, and campaign totals in a production retry summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-runner-summary-"));
  roots.push(root);
  const caseId = "case-runner-summary";
  const runId = "run-runner-summary";
  const compatibilityDigest = canonicalDigest({ execution: "runner-summary" });
  await campaignJournal(root, "runner-summary-prior", {
    caseId,
    runId,
    compatibilityDigest,
    totals: [15],
    estimated: 5,
  });
  const transport = createEngineeringDebugTransport({
    converse: async (_request, cfg) => ({
      model: cfg.model,
      content: [],
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
    }),
  });
  const runner = createEngineeringInvocationJournalRunner({
    artifactRoot: root,
    db: { query: async () => ({ rows: [] }) } as never,
    model: "subscription",
    configDigest: compatibilityDigest,
    compatibilityDigest,
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
  });
  await runner.run(
    {
      jobId: "job-summary",
      caseId,
      payload: { caseId, runId },
      attempts: 1,
      fencingToken: 1,
    } as never,
    () => transport.converse({ messages: [] }, config),
  );
  const summaryTexts = await Promise.all(
    (await (await import("node:fs/promises")).readdir(join(root, "engineering-debug")))
      .filter((name) => name.endsWith(".summary.md"))
      .map((name) => readFile(join(root, "engineering-debug", name), "utf8")),
  );
  const summary = summaryTexts.find((text) => text.includes("prior journals 1")) ?? "";
  expect(summary).toContain("prior accounted 20");
  expect(summary).toContain("current accounted 10");
  expect(summary).toContain("campaign accounted 30");
});

it("recovers compatible campaign response deltas exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-campaign-recovery-"));
  roots.push(root);
  const caseId = "case-campaign";
  const runId = "run-campaign";
  const campaignId = canonicalDigest({ case_id: caseId, run_id: runId });
  const compatibilityDigest = canonicalDigest({ execution: "config", roles: ["IMPLEMENTER"] });
  const prior = await EngineeringDebugJournal.create({ artifactRoot: root, invocationId: "prior" });
  await prior.append({
    event: "RUN_STARTED",
    case_id: caseId,
    run_id: runId,
    model: "subscription",
    base_sha: null,
    config_digest: compatibilityDigest,
    campaign_id: campaignId,
    compatibility_digest: compatibilityDigest,
  });
  await prior.append({
    event: "MODEL_USAGE",
    stage: null,
    response_total_tokens: 15,
    response_estimated_tokens: 5,
    responses: 1,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    estimated_tokens: 5,
    accounted_tokens: 20,
    responses_without_usage: 0,
    responses_with_partial_usage: 0,
    comparison: "TARGET",
  });
  await prior.append({
    event: "RUN_COMPLETED",
    status: "FAILED",
    commit_sha: null,
    artifact_kinds: [],
  });
  await prior.close();
  await expect(
    recoverEngineeringCampaignUsage({
      artifactRoot: root,
      caseId,
      runId,
      campaignId,
      compatibilityDigest,
    }),
  ).resolves.toMatchObject({
    priorJournalCount: 1,
    providerReportedTokens: 15,
    estimatedTokens: 5,
    accountedTokens: 20,
    completeness: "COMPLETE",
  });
});

it("records failed-attempt usage and estimates missing usage separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-budget-recovery-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "failed-usage",
  });
  const transport = createEngineeringDebugTransport({
    converse: async (_request, _config) => {
      throw Object.assign(new Error("provider"), {
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
    },
  });
  await expect(
    runWithEngineeringDebugJournal(journal, () => transport.converse({ messages: [] }, config)),
  ).rejects.toThrow("provider");
  await journal.close();
  const line = (await readFile(journal.filePath, "utf8"))
    .split("\n")
    .find((value) => value.includes("MODEL_USAGE"));
  expect(line).toContain('"response_total_tokens":15');
  expect(line).toContain('"total_tokens":15');
});

it("classifies complete, partial, and missing responses without polluting reported totals", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-budget-sequence-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "sequence",
  });
  let call = 0;
  const transport = createEngineeringDebugTransport({
    converse: async (_request, cfg) => {
      const n = call++;
      return {
        model: cfg.model,
        content: [],
        ...(n === 0
          ? { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
          : n === 1
            ? { usage: { inputTokens: 7, outputTokens: 3 } }
            : {}),
      };
    },
  });
  await runWithEngineeringDebugJournal(journal, async () => {
    await transport.converse({ messages: [] }, config);
    await transport.converse({ messages: [] }, config);
    await transport.converse({ messages: [] }, config);
  });
  await journal.close();
  const events = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "MODEL_USAGE");
  expect(events.map((event) => event.usage_completeness)).toEqual([
    "COMPLETE",
    "PARTIAL",
    "MISSING",
  ]);
  expect(events.map((event) => event.response_total_tokens)).toEqual([15, 10, null]);
  expect(events.map((event) => event.response_estimated_tokens)).toEqual([
    0,
    ENGINEERING_MODEL_CALL_TOKEN_RESERVE - 10,
    ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
  ]);
  expect(events.map((event) => event.total_tokens)).toEqual([15, 25, 25]);
  expect(events.map((event) => event.estimated_tokens)).toEqual([
    0,
    ENGINEERING_MODEL_CALL_TOKEN_RESERVE - 10,
    ENGINEERING_MODEL_CALL_TOKEN_RESERVE * 2 - 10,
  ]);
  expect(events.map((event) => event.accounted_tokens)).toEqual([
    15,
    ENGINEERING_MODEL_CALL_TOKEN_RESERVE + 15,
    ENGINEERING_MODEL_CALL_TOKEN_RESERVE * 2 + 15,
  ]);
  expect(events.map((event) => event.provider_reported)).toEqual([true, true, false]);
  expect(events.map((event) => event.responses_with_partial_usage)).toEqual([0, 1, 1]);
  expect(events.map((event) => event.responses_without_usage)).toEqual([0, 0, 1]);
});

it("uses accounted lower-bound plus estimate for preflight", () => {
  expect(() =>
    assertEngineeringModelCallBudget(
      1_800_000 - ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
      "IMPLEMENTER",
      undefined,
      1,
    ),
  ).toThrow(/reserve would exceed/u);
});

it("propagates a provider transport exit once without fallback or retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-budget-transport-exit-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "transport-exit",
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    converse: async (_request, _config) => {
      calls += 1;
      throw new TransportError("provider process exited", false);
    },
  });
  const retryConfig = createRuntimeConfig({
    model: { provider: "test", model_id: "budget" },
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 0 },
    toolLimits: { maxIterations: 1, maxCalls: 1 },
  });
  await expect(
    runWithEngineeringDebugJournal(journal, () =>
      executeTransportDetailed(transport, retryConfig, { messages: [] }),
    ),
  ).rejects.toThrow("provider process exited");
  await journal.close();
  expect(calls).toBe(1);
  const contents = await readFile(journal.filePath, "utf8");
  expect(contents).toContain('"event":"MODEL_ATTEMPT_ERROR"');
  expect(contents).not.toContain("fallback");
});

it("refuses a missing-usage call when its conservative reserve reaches the hard budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-budget-missing-preflight-"));
  roots.push(root);
  const caseId = "case-missing-preflight";
  const runId = "run-missing-preflight";
  const compatibilityDigest = canonicalDigest({ execution: "missing-preflight" });
  await campaignJournal(root, "missing-prior", {
    caseId,
    runId,
    compatibilityDigest,
    totals: [0],
    estimated: 1_800_000 - ENGINEERING_MODEL_CALL_TOKEN_RESERVE + 1,
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    converse: async (_request, config) => {
      calls += 1;
      return { model: config.model, content: [] };
    },
  });
  const runner = createEngineeringInvocationJournalRunner({
    artifactRoot: root,
    db: { query: async () => ({ rows: [] }) } as never,
    model: "subscription",
    configDigest: compatibilityDigest,
    compatibilityDigest,
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
  });
  await expect(
    runner.run(
      {
        jobId: "job-missing-preflight",
        caseId,
        payload: { caseId, runId },
        attempts: 1,
        fencingToken: 1,
      } as never,
      () => transport.converse({ messages: [] }, config),
    ),
  ).rejects.toBeInstanceOf(EngineeringModelBudgetError);
  expect(calls).toBe(0);
});

it("records a single-component partial lower bound and operator fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-budget-partial-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "partial-input",
  });
  const transport = createEngineeringDebugTransport({
    converse: async (_request, cfg) => ({
      model: cfg.model,
      content: [],
      usage: { inputTokens: 9 },
    }),
  });
  await runWithEngineeringDebugJournal(journal, () => transport.converse({ messages: [] }, config));
  await journal.close();
  const events = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "MODEL_USAGE");
  expect(events[0]).toMatchObject({
    usage_completeness: "PARTIAL",
    response_total_tokens: 9,
    response_estimated_tokens: ENGINEERING_MODEL_CALL_TOKEN_RESERVE - 9,
    response_reserved_tokens: ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
    total_tokens: 9,
    estimated_tokens: ENGINEERING_MODEL_CALL_TOKEN_RESERVE - 9,
    accounted_tokens: ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
  });
  const summary = await readFile(journal.summaryFilePath, "utf8");
  expect(summary).toContain("estimated");
  expect(summary).toContain("accounted");
  expect(summary).toContain("partial responses 1");
});

it("uses correction initial and tail reserves for missing responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "ra-budget-correction-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "correction",
  });
  const transport = createEngineeringDebugTransport({
    converse: async (_request, cfg) => ({ model: cfg.model, content: [] }),
  });
  await runWithEngineeringDebugJournal(journal, () =>
    runWithEngineeringCorrectionModelCallBudget(async () => {
      await transport.converse({ messages: [] }, config);
      await transport.converse({ messages: [] }, config);
    }),
  );
  await journal.close();
  const events = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "MODEL_USAGE");
  expect(events.map((event) => event.usage_completeness)).toEqual(["MISSING", "MISSING"]);
  expect(events.map((event) => event.response_reserved_tokens)).toEqual([
    ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
    ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE,
  ]);
  expect(events.map((event) => event.response_estimated_tokens)).toEqual([
    ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
    ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE,
  ]);
  expect(events.map((event) => event.total_tokens)).toEqual([0, 0]);
  expect(events.map((event) => event.accounted_tokens)).toEqual([
    ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
    ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE +
      ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE,
  ]);
});
