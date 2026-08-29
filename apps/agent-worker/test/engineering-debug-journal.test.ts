import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { canonicalDigest } from "@remoteagent/contracts";
import type { Database, JobLease } from "@remoteagent/database";
import type { RuntimeTransport } from "@remoteagent/bedrock-runtime";
import {
  createSubscriptionModelInvocationDescriptor,
  subscriptionModelProfileV1,
} from "@remoteagent/model-runtime";
import { StructuredLogger } from "@remoteagent/observability";

import {
  ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  ENGINEERING_MODEL_TARGET_TOKEN_LIMIT,
  EngineeringDebugJournal,
  createEngineeringDebugTransport,
  assertEngineeringModelCallBudgetBeforeStage,
  createEngineeringInvocationJournalRunner,
  engineeringDebugErrorDigest,
  recordEngineeringDebugGateProgress,
  recordEngineeringDebugGateBoundaryError,
  recordEngineeringDebugToolResult,
  runWithEngineeringDebugJournal,
  runWithEngineeringDebugSlice,
  runWithEngineeringDebugStage,
} from "../src/engineering-debug-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("writes one ordered content-free JSONL file per Engineering invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const now = () => new Date("2026-08-26T21:00:00.000Z");
  const first = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "invocation-one",
    now,
  });
  const second = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "invocation-two",
    now,
  });
  expect(first.filePath).not.toBe(second.filePath);

  await first.append({
    event: "MODEL_USAGE",
    stage: null,
    responses: 1,
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    responses_without_usage: 0,
    responses_with_partial_usage: 0,
    comparison: "TARGET",
  });
  await first.append({
    event: "TOOL_RESULT",
    kind: "WRITE_FILE",
    outcome: "FAILED",
    failure_code: "PATH_OUTSIDE_ALLOWED",
    changed_files: [],
    operation_id_digest: engineeringDebugErrorDigest("operation-one"),
    output_truncated: false,
  });
  await first.append({
    event: "STAGE_ERROR",
    stage: "SLICE_IMPLEMENTATION",
    error_name: "ExampleError",
    error_digest: engineeringDebugErrorDigest(
      new Error("secret-token at /Users/private/source.swift"),
    ),
  });
  await Promise.all([first.close(), second.close()]);

  const records = (await readFile(first.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.sequence)).toEqual([0, 1, 2]);
  expect(records.map((record) => record.event)).toEqual([
    "MODEL_USAGE",
    "TOOL_RESULT",
    "STAGE_ERROR",
  ]);
  expect(records.every((record) => record.recorded_at === "2026-08-26T21:00:00.000Z")).toBe(true);
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain("secret-token");
  expect(serialized).not.toContain("/Users/private/source.swift");
  expect((await stat(first.filePath)).mode & 0o777).toBe(0o600);
});

it("rejects raw narrative fields and writes nothing after close", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "invocation-strict",
  });

  expect(() =>
    journal.append({
      event: "STAGE_ERROR",
      stage: "DISCOVERY",
      error_name: "Error",
      error_digest: engineeringDebugErrorDigest(new Error("bounded")),
      reasoning: "raw private chain of thought",
    } as never),
  ).toThrow();
  await journal.close();
  await expect(
    journal.append({
      event: "RUN_COMPLETED",
      status: "FAILED",
      commit_sha: null,
      artifact_kinds: [],
    }),
  ).rejects.toThrow(/closed/);
});

it("records slice checklist, round and token budgets with code-owned decision codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-progress-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "progress-slice-one",
  });
  const invocation = createSubscriptionModelInvocationDescriptor({
    role: "IMPLEMENTER",
    profile: subscriptionModelProfileV1.parse({
      schema_version: 1,
      profile_name: "codex-implementer",
      provider: "codex_cli",
      executable: process.execPath,
      model: "gpt-5.6-codex",
      timeout_ms: 10_000,
      kill_grace_ms: 100,
      max_stdin_bytes: 65_536,
      max_stdout_bytes: 65_536,
      max_stderr_bytes: 4096,
    }),
    clientVersion: "0.147.0",
    deploymentConfigDigest: `sha256:${"d".repeat(64)}`,
  });
  const transport = createEngineeringDebugTransport(
    {
      async converse(_request, config) {
        return {
          model: config.model,
          usage: { inputTokens: 90, outputTokens: 30, totalTokens: 120 },
          content: [
            {
              type: "tool-use",
              id: "private-tool-id",
              name: "write",
              input: { relative_path: "src/feature.test.ts", content: "private test bytes" },
            },
          ],
        };
      },
    },
    { role: "IMPLEMENTER", invocation },
  );
  await runWithEngineeringDebugJournal(journal, () =>
    runWithEngineeringDebugSlice("SLICE_IMPLEMENTATION", "slice-one", 2, () =>
      transport.converse(
        {
          messages: [{ role: "user", content: [{ type: "text", text: "private objective" }] }],
        },
        {
          model: { provider: "bedrock", model_id: "model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 6, maxCalls: 32 },
          toolLoopPolicy: {
            readonlyToolNames: ["read"],
            mutationToolNames: ["write"],
            mutationIterationsReserved: 3,
            retainRecentToolPairs: 1,
          },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        },
      ),
    ),
  );
  await journal.close();

  const text = await readFile(journal.filePath, "utf8");
  const records = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const codes = records
    .filter((record) => record.event === "DECISION")
    .map((record) => record.decision_code);
  expect(codes).toEqual(
    expect.arrayContaining([
      "STAGE_ENTERED",
      "MODEL_CALL_RESERVED",
      "MUTATION_BATCH_REQUESTED",
      "MODEL_RESPONSE_RECORDED",
      "STAGE_COMPLETED",
    ]),
  );
  const snapshot = [...records]
    .reverse()
    .find(
      (record) =>
        record.event === "PROGRESS_SNAPSHOT" && record.decision_code === "MODEL_RESPONSE_RECORDED",
    );
  expect(snapshot).toMatchObject({
    stage: "SLICE_IMPLEMENTATION",
    slice_id: "slice-one",
    attempt: 2,
    rounds: { used: 1, limit: 6, mutation_reserved: 0, remaining: 5 },
    calls: { used: 1, limit: 32, remaining: 31 },
    tokens: {
      used: 120,
      target: ENGINEERING_MODEL_TARGET_TOKEN_LIMIT,
      hard_limit: ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
      final_call_reserved: ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
    },
  });
  expect(records.find((record) => record.event === "MODEL_USAGE")).toMatchObject({
    stage: "SLICE_IMPLEMENTATION",
    role: "IMPLEMENTER",
    slice_id: "slice-one",
    attempt: 2,
    invocation_digest: canonicalDigest(invocation),
    provider: "codex_cli",
    profile_name: "codex-implementer",
    model: "gpt-5.6-codex",
    client_version: "0.147.0",
    response_input_tokens: 90,
    response_output_tokens: 30,
    response_total_tokens: 120,
    provider_reported: true,
  });
  expect(JSON.stringify(snapshot)).toContain('"item":"TEST_FIRST","status":"COMPLETE"');
  expect(text).not.toContain("private objective");
  expect(text).not.toContain("private test bytes");
  expect(text).not.toContain("private-tool-id");
  expect(text).not.toContain(process.execPath);
  expect(() =>
    createEngineeringDebugTransport(transport, { role: "REVIEWER", invocation }),
  ).toThrow(/role does not match/u);
});

it("resets round and call progress for each slice attempt while retaining global token usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-slice-reset-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "slice-reset",
  });
  let response = 0;
  const transport = createEngineeringDebugTransport({
    async converse(_request, config) {
      response += 1;
      return {
        model: config.model,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        content: [
          {
            type: "tool-use",
            id: `tool-${String(response)}`,
            name: "write",
            input: { relative_path: `src/slice-${String(response)}.test.ts`, content: "private" },
          },
        ],
      };
    },
  });
  const config = {
    model: { provider: "bedrock", model_id: "model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 6, maxCalls: 32 },
    toolLoopPolicy: {
      readonlyToolNames: ["read"],
      mutationToolNames: ["write"],
      mutationIterationsReserved: 3,
      retainRecentToolPairs: 1,
    },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
  } as const;
  await runWithEngineeringDebugJournal(journal, async () => {
    await runWithEngineeringDebugSlice("SLICE_IMPLEMENTATION", "slice-one", 1, () =>
      transport.converse({ messages: [] }, config),
    );
    await runWithEngineeringDebugSlice("SLICE_IMPLEMENTATION", "slice-two", 2, () =>
      transport.converse({ messages: [] }, config),
    );
  });
  await journal.close();

  const records = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const second = [...records]
    .reverse()
    .find(
      (record) =>
        record.event === "PROGRESS_SNAPSHOT" &&
        record.slice_id === "slice-two" &&
        record.decision_code === "MODEL_RESPONSE_RECORDED",
    );
  expect(second).toMatchObject({
    rounds: { used: 1, limit: 6, remaining: 5 },
    calls: { used: 1, limit: 32, remaining: 31 },
    tokens: { used: 240 },
  });
  expect(JSON.stringify(second)).toContain('"item":"IMPLEMENTATION","status":"IN_PROGRESS"');
});

it("records FAST and FULL gate states without gate output or model narrative", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-gates-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "gate-progress",
  });
  await runWithEngineeringDebugJournal(journal, async () => {
    await recordEngineeringDebugGateProgress({ tier: "FAST", status: "PASSED" });
    await recordEngineeringDebugGateProgress({ tier: "FULL", status: "BLOCKED" });
  });
  await journal.close();
  const text = await readFile(journal.filePath, "utf8");
  expect(text).toContain('"decision_code":"FAST_GATES_PASSED"');
  expect(text).toContain('"decision_code":"FULL_GATES_BLOCKED"');
  expect(text).toContain('"gates":{"fast":"COMPLETE","full":"BLOCKED"}');
  expect(text).not.toContain("gate stdout");
});

it("routes concurrent model and tool events to separate async-local invocation files", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const first = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "async-first",
  });
  const second = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "async-second",
  });
  const delegate: RuntimeTransport = {
    async converse(request, config) {
      const marker = request.messages[0]?.content[0];
      const firstRequest = marker?.type === "text" && marker.text === "first-private-prompt";
      return {
        model: config.model,
        usage: {
          inputTokens: firstRequest ? 100 : 200,
          outputTokens: firstRequest ? 10 : 20,
          totalTokens: firstRequest ? 110 : 220,
        },
        content: [
          {
            type: "tool-use",
            id: firstRequest ? "tool-first" : "tool-second",
            name: "search",
            input: {
              query: firstRequest ? "secret-first-query" : "secret-second-query",
              relative_path: "src",
            },
          },
          {
            type: "json",
            value: { artifact_kind: "SliceContract", changed_files: ["src/app.ts"] },
          },
        ],
      };
    },
  };
  const transport = createEngineeringDebugTransport(delegate);
  const config = {
    model: { provider: "bedrock", model_id: "model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
  } as const;
  const toolResult = {
    schema_version: 1,
    operation_id: "operation-private-id",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "READ_FILE",
    before_digest: null,
    after_digest: canonicalDigest({ after: true }),
    changed_files: [],
    outcome: "SUCCEEDED",
    output: {
      trust: "UNTRUSTED_DATA",
      value: "private source contents",
      truncated: false,
      original_byte_length: 23,
    },
  } as const;

  await Promise.all([
    runWithEngineeringDebugJournal(first, async () => {
      await runWithEngineeringDebugStage("SLICE_IMPLEMENTATION", () =>
        transport.converse(
          {
            messages: [{ role: "user", content: [{ type: "text", text: "first-private-prompt" }] }],
          },
          config,
        ),
      );
      recordEngineeringDebugToolResult(toolResult);
      recordEngineeringDebugGateBoundaryError({
        gate_id: "ios-tests",
        target: "CURRENT",
        phase: "RECEIPT_VALIDATION",
        error: Object.assign(new Error("private boundary failure at /Users/private/DerivedData"), {
          code: "PROTECTED_TREE_CHANGED",
          protectedChanges: [
            {
              path: "SonderClient/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
              change: "MODIFIED",
            },
            { path: "/Users/private/secret", change: "ADDED" },
          ],
        }),
      });
    }),
    runWithEngineeringDebugJournal(second, async () => {
      await transport.converse(
        {
          messages: [{ role: "user", content: [{ type: "text", text: "second-private-prompt" }] }],
        },
        config,
      );
      recordEngineeringDebugToolResult(toolResult);
    }),
  ]);
  await Promise.all([first.close(), second.close()]);

  const firstText = await readFile(first.filePath, "utf8");
  const secondText = await readFile(second.filePath, "utf8");
  expect(firstText).toContain('"total_tokens":110');
  expect(firstText).toContain('"stage":"SLICE_IMPLEMENTATION"');
  expect(firstText).not.toContain('"total_tokens":220');
  expect(secondText).toContain('"total_tokens":220');
  expect(secondText).not.toContain('"total_tokens":110');
  expect(firstText).toContain('"event":"GATE_BOUNDARY_ERROR"');
  expect(firstText).toContain('"phase":"RECEIPT_VALIDATION"');
  expect(firstText).toContain('"error_code":"PROTECTED_TREE_CHANGED"');
  expect(firstText).toContain(
    '"protected_changes":[{"relative_path":"SonderClient/project.xcworkspace/xcshareddata/swiftpm/Package.resolved","change":"MODIFIED"}]',
  );
  expect(secondText).not.toContain('"event":"GATE_BOUNDARY_ERROR"');
  for (const text of [firstText, secondText]) {
    expect(text).toContain('"event":"TOOL_BATCH"');
    expect(text).toContain('"event":"TOOL_RESULT"');
    expect(text).toContain('"event":"MODEL_OUTPUT_SHAPE"');
    expect(text).not.toContain("private-prompt");
    expect(text).not.toContain("private source contents");
    expect(text).not.toContain("secret-first-query");
    expect(text).not.toContain("secret-second-query");
    expect(text).not.toContain("operation-private-id");
    expect(text).not.toContain("private boundary failure");
    expect(text).not.toContain("DerivedData");
  }
});

it("creates a distinct terminal journal for every production handler invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const gateDigest = canonicalDigest({ gate: 1 });
  const diagnosticQueries: string[] = [];
  const database = {
    query: async (sql: string) => {
      diagnosticQueries.push(sql);
      if (sql.includes("engineering_artifact_revisions"))
        return {
          rows: [
            {
              artifact_kind: "LocalCommitReceipt",
              stage: "LOCAL_COMMIT",
              stage_attempt: 1,
              commit_sha: "a".repeat(40),
            },
          ],
        };
      if (sql.includes("engineering.verification.gate"))
        return {
          rows: [
            {
              gate_id: "unit",
              target: "CURRENT",
              outcome: "FAILED",
              exit_code: 1,
              duration_ms: 123,
              tree_digest: gateDigest,
              config_digest: gateDigest,
              command_digest: gateDigest,
              log_digest: gateDigest,
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as Database;
  const runner = createEngineeringInvocationJournalRunner({
    artifactRoot: root,
    db: database,
    model: "model",
    configDigest: canonicalDigest({ config: 1 }),
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
  });
  const lease: JobLease = {
    jobId: "job-1",
    caseId: "case-1",
    jobType: "agent.implementer",
    payload: { caseId: "case-1", runId: "run-1", workUnitId: "unit-1" },
    provider: null,
    serializationKey: "case-1",
    attempts: 1,
    maxAttempts: 3,
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
    leaseOwner: "worker-1",
  };

  await runner.run(lease, async () => undefined);
  await expect(
    runner.run(lease, async () => {
      throw new Error("private failure at /Users/private/source.swift");
    }),
  ).rejects.toThrow(/private failure/);

  const directory = join(root, "engineering-debug");
  const files = (await readdir(directory)).sort();
  expect(files).toHaveLength(2);
  expect(files[0]).not.toBe(files[1]);
  const records = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
  expect(records.some((text) => text.includes('"status":"SUCCEEDED"'))).toBe(true);
  expect(records.some((text) => text.includes('"status":"FAILED"'))).toBe(true);
  expect(records.every((text) => text.includes('"commit_sha":"aaaaaaaa'))).toBe(true);
  expect(records.every((text) => text.includes('"gate_id":"unit"'))).toBe(true);
  expect(records.every((text) => text.includes('"outcome":"FAILED"'))).toBe(true);
  expect(records.every((text) => !text.includes("private failure"))).toBe(true);
  expect(records.every((text) => !text.includes("/Users/private"))).toBe(true);
  expect(
    diagnosticQueries.some((sql) => sql.includes("i.kind = 'engineering.verification.gate'")),
  ).toBe(true);
  expect(diagnosticQueries.every((sql) => !sql.includes("i.operation_kind"))).toBe(true);
  expect(diagnosticQueries.every((sql) => !sql.includes("c.created_at"))).toBe(true);
  expect(diagnosticQueries.some((sql) => sql.includes("c.recorded_at"))).toBe(true);
});

it("records provider usage and stops an invocation above the hard token limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "hard-token-limit",
  });
  const transport = createEngineeringDebugTransport({
    async converse(_request, config) {
      return {
        model: config.model,
        usage: { inputTokens: 600_000, outputTokens: 1, totalTokens: 600_001 },
        content: [],
      };
    },
  });

  await expect(
    runWithEngineeringDebugJournal(journal, () =>
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "private" }] }] },
        {
          model: { provider: "bedrock", model_id: "model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 1, maxCalls: 1 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        },
      ),
    ),
  ).rejects.toThrow(/600000-token hard limit/);
  await journal.close();
  const text = await readFile(journal.filePath, "utf8");
  expect(text).toContain('"total_tokens":600001');
  expect(text).toContain('"comparison":"HARD_LIMIT"');
  expect(text).not.toContain("private");
});

it("refuses the next provider call before the remaining hard-limit reserve can be consumed", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-reserve-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "reserved-token-limit",
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    async converse(_request, config) {
      calls += 1;
      return {
        model: config.model,
        usage: { inputTokens: 565_999, outputTokens: 1, totalTokens: 566_000 },
        content: [],
      };
    },
  });
  const config = {
    model: { provider: "bedrock", model_id: "model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
  } as const;

  await expect(
    runWithEngineeringDebugJournal(journal, async () => {
      await transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "first" }] }] },
        config,
      );
      return transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "second" }] }] },
        config,
      );
    }),
  ).rejects.toThrow(/reserve would exceed/);
  expect(calls).toBe(1);
  await journal.close();
  const text = await readFile(journal.filePath, "utf8");
  expect(text).toContain('"decision_code":"MODEL_CALL_REFUSED_BUDGET"');
});

it("refuses an exhausted model-backed stage before transport dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-stage-reserve-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "stage-reserved-token-limit",
  });
  let calls = 0;
  const transport = createEngineeringDebugTransport({
    async converse(_request, config) {
      calls += 1;
      return {
        model: config.model,
        usage: { inputTokens: 565_999, outputTokens: 1, totalTokens: 566_000 },
        content: [],
      };
    },
  });
  const config = {
    model: { provider: "bedrock", model_id: "model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
  } as const;

  await expect(
    runWithEngineeringDebugJournal(journal, async () => {
      await transport.converse({ messages: [] }, config);
      await assertEngineeringModelCallBudgetBeforeStage();
    }),
  ).rejects.toThrow(/reserve would exceed/);
  expect(calls).toBe(1);
  await journal.close();
  const text = await readFile(journal.filePath, "utf8");
  expect(text.match(/MODEL_CALL_REFUSED_BUDGET/gu)).toHaveLength(2);
});

it("keeps a completed Engineering result when only diagnostic persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-diagnostic-"));
  roots.push(root);
  const warnings: unknown[] = [];
  const runner = createEngineeringInvocationJournalRunner({
    artifactRoot: root,
    db: {
      query: async () => {
        throw new Error("private database detail at /Users/private/db");
      },
    } as unknown as Database,
    model: "model",
    configDigest: canonicalDigest({ config: "diagnostic-failure" }),
    logger: new StructuredLogger({ sink: { log: (entry) => warnings.push(entry) } }),
  });
  const lease: JobLease = {
    jobId: "job-diagnostic",
    caseId: "case-diagnostic",
    jobType: "agent.implementer",
    payload: {
      caseId: "case-diagnostic",
      runId: "run-diagnostic",
      workUnitId: "unit-diagnostic",
    },
    provider: null,
    serializationKey: "case-diagnostic",
    attempts: 1,
    maxAttempts: 3,
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
    leaseOwner: "worker-1",
  };

  await expect(runner.run(lease, async () => "completed")).resolves.toBe("completed");
  const directory = join(root, "engineering-debug");
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const text = await readFile(join(directory, files[0]!), "utf8");
  expect(text).toContain('"stage":"RUN_DIAGNOSTIC"');
  expect(text).toContain('"event":"RUN_COMPLETED"');
  expect(text).toContain('"status":"SUCCEEDED"');
  expect(text).not.toContain("private database detail");
  expect(text).not.toContain("/Users/private");
  expect(JSON.stringify(warnings)).not.toContain("private database detail");
});

it("does not discard a provider response when its journal is already unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-unavailable-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "unavailable-after-create",
  });
  await journal.close();
  const transport = createEngineeringDebugTransport({
    async converse(_request, config) {
      return {
        model: config.model,
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        content: [{ type: "json", value: { schema_version: 1 } }],
      };
    },
  });

  await expect(
    runWithEngineeringDebugJournal(journal, () =>
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "private" }] }] },
        {
          model: { provider: "bedrock", model_id: "model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 1, maxCalls: 1 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        },
      ),
    ),
  ).resolves.toMatchObject({ usage: { totalTokens: 12 } });
});
