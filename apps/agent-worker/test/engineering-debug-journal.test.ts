import {
  appendFile as appendToFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { canonicalDigest, canonicalJsonStringify } from "@remoteagent/contracts";
import type { Database, JobLease } from "@remoteagent/database";
import {
  createRuntimeConfig,
  createSubscriptionModelInvocationDescriptor,
  executeTransport,
  subscriptionModelProfileV1,
  ToolInputError,
  ToolLimitError,
  TransportError,
  type RuntimeTransport,
} from "@remoteagent/model-runtime";
import { StructuredLogger } from "@remoteagent/observability";
import { VerificationGateReceipt } from "@remoteagent/test-evidence";
import * as z from "zod";

import {
  ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER,
  ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  ENGINEERING_REVIEWER_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_MODEL_TARGET_TOKEN_LIMIT,
  ENGINEERING_VERIFIER_MODEL_CALL_TOKEN_RESERVE,
  ENGINEERING_MODEL_WARNING_TOKEN_LIMIT,
  EngineeringDebugJournal,
  closeExportAndDropEngineeringRun,
  exportEngineeringEvidence,
  reconstructEngineeringDebugJournal,
  writeReconstructedEngineeringDebugSummary,
  engineeringCompilerDiagnosticJournalRows,
  engineeringXcodeTestDiagnosticJournalRows,
  createEngineeringDebugTransport,
  assertEngineeringModelCallBudgetBeforeStage,
  createEngineeringInvocationJournalRunner,
  engineeringDebugErrorCode,
  engineeringDebugErrorDetailCode,
  engineeringDebugErrorDigest,
  engineeringDebugReplacementRepairDiagnostic,
  recordEngineeringDebugGateProgress,
  recordEngineeringDebugGateBoundaryError,
  recordEngineeringDebugToolInputRefusal,
  recordEngineeringDebugToolResult,
  runWithEngineeringCorrectionModelCallBudget,
  runWithEngineeringDebugJournal,
  runWithEngineeringDebugSlice,
  runWithEngineeringDebugStage,
} from "../src/engineering-debug-journal.js";
import { CaseResumeUnresolvedError } from "../src/handlers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("records deterministic stage lifecycle durations with the injected clock", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-clock-stage-"));
  roots.push(root);
  let now = 0;
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "clock-stage",
    now: () => new Date(now),
  });
  await runWithEngineeringDebugJournal(journal, async () => {
    await runWithEngineeringDebugStage("SYSTEM_DESIGN", async () => {
      now = 37;
    });
    await expect(
      runWithEngineeringDebugStage("PROGRAM_DESIGN", async () => {
        now = 91;
        throw new Error("bounded");
      }),
    ).rejects.toThrow("bounded");
  });
  await journal.close();
  const events = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "DECISION");
  expect(events.filter((event) => event.decision_code === "STAGE_COMPLETED")[0].duration_ms).toBe(
    37,
  );
  expect(events.filter((event) => event.decision_code === "STAGE_FAILED")[0].duration_ms).toBe(54);
});

it("records deterministic model response durations for success and error", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-clock-model-"));
  roots.push(root);
  let now = 0;
  const config = {
    model: { provider: "test", model_id: "model" },
    timeoutMs: 1000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
  } as const;
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "clock-model",
    now: () => new Date(now),
  });
  let call = 0;
  const transport = createEngineeringDebugTransport({
    converse: async (_request, cfg) => {
      now += call++ === 0 ? 12 : 19;
      if (call === 2) throw new Error("bounded");
      return {
        model: cfg.model,
        content: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  await runWithEngineeringDebugJournal(journal, async () => {
    await transport.converse({ messages: [] }, config);
    await expect(transport.converse({ messages: [] }, config)).rejects.toThrow("bounded");
  });
  await journal.close();
  const events = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "MODEL_USAGE");
  expect(events.map((event) => event.response_duration_ms)).toEqual([12, 19]);
});

it("uses the threefold diagnostic token budget selected for extended Codex runs", () => {
  expect(ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER).toBe(3);
  expect(ENGINEERING_MODEL_TARGET_TOKEN_LIMIT).toBe(750_000);
  expect(ENGINEERING_MODEL_WARNING_TOKEN_LIMIT).toBe(1_200_000);
  expect(ENGINEERING_MODEL_HARD_TOKEN_LIMIT).toBe(1_800_000);
  expect(ENGINEERING_MODEL_CALL_TOKEN_RESERVE).toBe(105_000);
  expect(ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE).toBe(128_000);
  expect(ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE).toBe(128_000);
  expect(ENGINEERING_REVIEWER_MODEL_CALL_TOKEN_RESERVE).toBe(32_000);
  expect(ENGINEERING_VERIFIER_MODEL_CALL_TOKEN_RESERVE).toBe(32_000);
});

it("classifies exact code-owned stage boundaries without persisting error prose", () => {
  expect(
    engineeringDebugErrorCode(
      new Error("code-owned generator output cannot be a model-authored test path"),
    ),
  ).toBe("GENERATOR_OUTPUT_IN_TEST_PATH");
  expect(
    engineeringDebugErrorCode(
      new Error("server-owned implementation context exceeds the code-owned discovery cap"),
    ),
  ).toBe("CORRECTION_CONTEXT_CAP_EXCEEDED");
  expect(engineeringDebugErrorCode(new z.ZodError([]))).toBe("SCHEMA_VALIDATION_FAILED");
  expect(engineeringDebugErrorCode(new Error("untrusted provider detail"))).toBeNull();
  expect(
    engineeringDebugErrorDetailCode(
      new ToolLimitError(
        "Repeated invalid tool input made no progress",
        "TOOL_INPUT_INVALID:patch:invalid_union:ROOT",
      ),
    ),
  ).toBe("TOOL_INPUT_INVALID:patch:invalid_union:ROOT");
});

it("records a content-free retryable provider attempt and its reported usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-retry-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "retryable-malformed-output",
  });
  const profile = subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "codex-implementer",
    provider: "codex_cli",
    executable: process.execPath,
    model: "gpt-5.6-sol",
    timeout_ms: 10_000,
    kill_grace_ms: 100,
    max_stdin_bytes: 65_536,
    max_stdout_bytes: 65_536,
    max_stderr_bytes: 4096,
  });
  const invocation = createSubscriptionModelInvocationDescriptor({
    role: "IMPLEMENTER",
    profile,
    clientVersion: "0.147.0",
    deploymentConfigDigest: `sha256:${"d".repeat(64)}`,
  });
  let calls = 0;
  const delegate: RuntimeTransport = {
    converse: async (_request, config) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new TransportError("private malformed prose", "TRANSIENT"), {
          outcome: "MALFORMED_OUTPUT",
          providerCode: "CODEX_CLI_TRANSCRIPT_INVALID",
          detailCode: "TRANSCRIPT_INCOMPLETE",
          usage: { inputTokens: 60, outputTokens: 10, totalTokens: 70 },
        });
      }
      return {
        model: config.model,
        content: [{ type: "text", text: "private successful response" }],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      };
    },
  };
  const transport = createEngineeringDebugTransport(delegate, {
    role: "IMPLEMENTER",
    invocation,
  });
  const config = createRuntimeConfig({
    model: { provider: "codex_cli", model_id: profile.model },
    timeoutMs: 10_000,
    toolLimits: { maxIterations: 0, maxCalls: 0 },
    retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
  });

  await runWithEngineeringDebugJournal(journal, () =>
    runWithEngineeringDebugSlice("SLICE_IMPLEMENTATION", "slice-one", 2, () =>
      executeTransport(transport, config, { messages: [] }, { sleep: async () => undefined }),
    ),
  );
  await journal.close();

  expect(calls).toBe(2);
  const text = await readFile(journal.filePath, "utf8");
  expect(text).toContain('"event":"MODEL_ATTEMPT_ERROR"');
  expect(text).toContain('"error_code":"MALFORMED_OUTPUT"');
  expect(text).toContain('"error_detail_code":"TRANSCRIPT_INCOMPLETE"');
  expect(text).toContain('"retryable":true');
  expect(text).toContain('"response_total_tokens":70');
  expect(text).toContain('"responses":2');
  expect(text).toContain('"total_tokens":100');
  expect(text).not.toContain("private malformed prose");
  expect(text).not.toContain("private successful response");
  const summary = await readFile(journal.summaryFilePath, "utf8");
  expect(summary).toContain("## Provider attempt failures");
  expect(summary).toContain(
    "| IMPLEMENTER | SLICE_IMPLEMENTATION | slice-one | 2 | MALFORMED_OUTPUT | TRANSCRIPT_INCOMPLETE | yes |",
  );
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
  await runWithEngineeringDebugJournal(first, () =>
    recordEngineeringDebugToolInputRefusal(
      "patch",
      new ToolInputError([{ path: [], code: "invalid_union" }]),
    ),
  );
  await first.append({
    event: "STAGE_ERROR",
    stage: "SLICE_IMPLEMENTATION",
    error_name: "ExampleError",
    error_code: "MALFORMED_OUTPUT",
    error_detail_code: "WRITE_ROOT_LIMIT",
    error_digest: engineeringDebugErrorDigest(
      new Error("secret-token at /Users/private/source.swift"),
    ),
  });
  await Promise.all([first.close(), second.close()]);

  const records = (await readFile(first.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.map((record) => record.sequence)).toEqual([0, 1, 2, 3]);
  expect(records.map((record) => record.event)).toEqual([
    "MODEL_USAGE",
    "TOOL_RESULT",
    "TOOL_INPUT_REFUSAL",
    "STAGE_ERROR",
  ]);
  expect(records.every((record) => record.recorded_at === "2026-08-26T21:00:00.000Z")).toBe(true);
  const serialized = JSON.stringify(records);
  expect(serialized).not.toContain("secret-token");
  expect(serialized).not.toContain("/Users/private/source.swift");
  expect(serialized).toContain('"error_code":"MALFORMED_OUTPUT"');
  expect(serialized).toContain('"error_detail_code":"WRITE_ROOT_LIMIT"');
  expect((await stat(first.filePath)).mode & 0o777).toBe(0o600);
  const summary = await readFile(first.summaryFilePath, "utf8");
  expect(summary).toContain("# Engineering invocation summary");
  expect(summary).toContain("## Model usage by role, slice, attempt and round");
  expect(summary).toContain("PATH_OUTSIDE_ALLOWED");
  expect(summary).toContain("## Stage failures");
  expect(summary).toContain("## Tool input validation refusals");
  expect(summary).toContain(
    "| ENGINEERING_INVOCATION | — | — | patch | TOOL_INPUT_INVALID | invalid_union:ROOT |",
  );
  expect(summary).toContain("WRITE_ROOT_LIMIT");
  expect(summary).not.toContain("secret-token");
  expect(summary).not.toContain("/Users/private/source.swift");
  expect((await stat(first.summaryFilePath)).mode & 0o777).toBe(0o600);
});

it("aggregates provider-reported response deltas across routed roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "invocation-role-usage",
  });

  for (const usage of [
    { role: "DESIGNER" as const, total: 100 },
    { role: "IMPLEMENTER" as const, total: 300 },
    { role: "DESIGNER" as const, total: 350 },
  ]) {
    await journal.append({
      event: "MODEL_USAGE",
      role: usage.role,
      stage: usage.role === "DESIGNER" ? "SYSTEM_DESIGN" : "SLICE_IMPLEMENTATION",
      responses: 1,
      input_tokens: usage.total,
      output_tokens: 0,
      total_tokens: usage.total,
      response_total_tokens: usage.total === 350 ? 250 : usage.total,
      responses_without_usage: 0,
      responses_with_partial_usage: 0,
      comparison: "TARGET",
    });
  }
  await journal.close();

  const summary = await readFile(journal.summaryFilePath, "utf8");
  expect(summary).toContain("Provider-reported tokens: 650 / target");
  expect(summary).not.toContain("Provider-reported tokens: 350 / target");
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
      error_code: null,
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

it("enforces complete v2 outcome projections while accepting legacy v1", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-schema-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "schema-versioned",
  });
  expect(() =>
    journal.append({
      event: "RUN_COMPLETED",
      schema_version: 2,
      status: "FAILED",
      commit_sha: null,
      artifact_kinds: [],
    } as never),
  ).toThrow();
  expect(() =>
    journal.append({
      event: "RUN_COMPLETED",
      status: "FAILED",
      commit_sha: null,
      artifact_kinds: [],
      handler_outcome: "FAILED",
    } as never),
  ).toThrow();
  await journal.append({
    event: "RUN_COMPLETED",
    status: "FAILED",
    commit_sha: null,
    artifact_kinds: ["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"],
  });
  await journal.close();
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
          model: { provider: "qualification_fake", model_id: "model" },
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
  const summary = await readFile(journal.summaryFilePath, "utf8");
  expect(summary).toContain(
    "| IMPLEMENTER | SLICE_IMPLEMENTATION | slice-one | 2 | 1 | 90 | 30 | 120 |",
  );
  expect(JSON.stringify(snapshot)).toContain('"item":"TEST_FIRST","status":"PENDING"');
  expect(text).not.toContain("private objective");
  expect(text).not.toContain("private test bytes");
  expect(text).not.toContain("private-tool-id");
  expect(text).not.toContain(process.execPath);
  expect(() =>
    createEngineeringDebugTransport(transport, { role: "REVIEWER", invocation }),
  ).toThrow(/role does not match/u);
});

it("marks TEST_FIRST complete only after a successful mutation receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-test-first-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "test-first-receipt",
  });
  const result = (outcome: "FAILED" | "SUCCEEDED") =>
    ({
      schema_version: 1,
      operation_id: `operation-${outcome.toLowerCase()}`,
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "APPLY_PATCH",
      before_digest: canonicalDigest({ before: outcome }),
      after_digest: canonicalDigest({ after: outcome }),
      changed_files: outcome === "SUCCEEDED" ? ["src/feature.test.ts"] : [],
      outcome,
      ...(outcome === "FAILED" ? { failure_code: "TEST_FIRST_MUTATION_REQUIRED" } : {}),
      output: {
        trust: "UNTRUSTED_DATA",
        value: "ok",
        truncated: false,
        original_byte_length: 2,
      },
    }) as const;

  await runWithEngineeringDebugJournal(journal, async () => {
    await runWithEngineeringDebugSlice("SLICE_IMPLEMENTATION", "slice-one", 1, async () => {
      const transport = createEngineeringDebugTransport({
        async converse(_request, config) {
          return {
            model: config.model,
            content: [
              {
                type: "tool-use",
                id: "failed-patch-request",
                name: "patch",
                input: { files: [] },
              },
            ],
          };
        },
      });
      await transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "private" }] }] },
        {
          model: { provider: "qualification_fake", model_id: "model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 2, maxCalls: 2 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        },
      );
      recordEngineeringDebugToolResult(result("FAILED"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      recordEngineeringDebugToolResult(result("SUCCEEDED"));
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
  });
  await journal.close();

  const records = (await readFile(journal.filePath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const snapshots = records.filter(
    (record) =>
      record.event === "PROGRESS_SNAPSHOT" && record.decision_code === "MUTATION_RESULT_RECORDED",
  );
  expect(JSON.stringify(snapshots[0])).toContain('"item":"TEST_FIRST","status":"PENDING"');
  expect(JSON.stringify(snapshots[1])).toContain('"item":"TEST_FIRST","status":"COMPLETE"');
});

it("journals only bounded replacement-repair coordinates and digests", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-replacement-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "replacement-coordinate",
  });
  const expectedDigest = canonicalDigest("stale private bytes");
  const currentDigest = canonicalDigest("current private bytes");
  const outputValue = JSON.stringify({
    repair_context: {
      relative_path: "src/Flow.swift",
      replacement_index: 1,
      expected_old_content_digest: expectedDigest,
      current_excerpt: "current private bytes",
      current_excerpt_digest: currentDigest,
      current_excerpt_complete: true,
    },
  });
  const toolResult = {
    schema_version: 1,
    operation_id: "private-operation-id",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "APPLY_PATCH",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    outcome: "FAILED",
    failure_code: "REPLACEMENT_MISMATCH",
    output: {
      trust: "UNTRUSTED_DATA",
      value: outputValue,
      truncated: false,
      original_byte_length: Buffer.byteLength(outputValue),
    },
  } as const;
  expect(engineeringDebugReplacementRepairDiagnostic(toolResult)).toEqual({
    relative_path: "src/Flow.swift",
    replacement_index: 1,
    expected_old_content_digest: expectedDigest,
    current_excerpt_digest: currentDigest,
    current_excerpt_complete: true,
  });

  await runWithEngineeringDebugJournal(journal, async () => {
    recordEngineeringDebugToolResult(toolResult);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  await journal.close();

  const text = await readFile(journal.filePath, "utf8");
  expect(text).toContain(
    `"repair_context":{"relative_path":"src/Flow.swift","replacement_index":1,"expected_old_content_digest":"${expectedDigest}","current_excerpt_digest":"${currentDigest}","current_excerpt_complete":true}`,
  );
  expect(text).not.toContain("stale private bytes");
  expect(text).not.toContain("current private bytes");
  expect(text).not.toContain("private-operation-id");
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
    model: { provider: "qualification_fake", model_id: "model" },
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
            value: {
              artifact_kind: "VerificationDecision",
              changed_files: ["src/app.ts"],
              decision: "FAILED",
              criterion_outcomes: [
                { criterion_id: "private-criterion", status: "FAILED" },
                { criterion_id: "private-second", status: "PASSED" },
              ],
              lines_examined: 17,
              findings: [
                {
                  severity: "MEDIUM",
                  summary: "private finding prose",
                  evidence: "private evidence",
                  required_fix: "private required fix",
                  location: { relative_path: "src/app.ts", line: 41 },
                },
              ],
              rationale: "private verifier prose",
            },
          },
        ],
      };
    },
  };
  const transport = createEngineeringDebugTransport(delegate);
  const config = {
    model: { provider: "qualification_fake", model_id: "model" },
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
    expect(text).toContain('"decision":"FAILED"');
    expect(text).toContain('"criterion_statuses":["FAILED","PASSED"]');
    expect(text).toContain(
      '"review_lines_examined":17,"review_findings":[{"severity":"MEDIUM","relative_path":"src/app.ts","line":41}]',
    );
    expect(text).not.toContain("private-prompt");
    expect(text).not.toContain("private source contents");
    expect(text).not.toContain("secret-first-query");
    expect(text).not.toContain("secret-second-query");
    expect(text).not.toContain("operation-private-id");
    expect(text).not.toContain("private verifier prose");
    expect(text).not.toContain("private finding prose");
    expect(text).not.toContain("private evidence");
    expect(text).not.toContain("private required fix");
    expect(text).not.toContain("private-criterion");
    expect(text).not.toContain("private boundary failure");
    expect(text).not.toContain("DerivedData");
  }
});

it("creates a distinct terminal journal for every production handler invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-"));
  roots.push(root);
  const gateDigest = canonicalDigest({ gate: 1 });
  const compilerMessage = "cannot convert value of type Bool to expected argument type closure";
  const compilerDiagnostic = {
    path: "Sources/Feature.swift",
    line: 41,
    column: 9,
    message: compilerMessage,
    excerpt: "route(enabled)",
  };
  const testMessage = "XCTAssertFalse failed - safety alert remained visible";
  const testDiagnostic = {
    test_name: "-[SharedTests.SafetyAlertTests testCloseDismissesAlert]",
    message: testMessage,
    path: "Tests/SafetyAlertTests.swift",
    line: 73,
  } as const;
  const diagnosticQueries: string[] = [];
  const database = {
    query: async (sql: string) => {
      diagnosticQueries.push(sql);
      if (sql.includes("artifact_kind = 'GateFailure'"))
        return {
          rows: [
            {
              stage_attempt: 2,
              payload: {
                schema_version: 1,
                artifact_kind: "GateFailure",
                case_id: "case-1",
                run_id: "run-1",
                revision: 0,
                authority: "SERVER_OWNED",
                slice_id: "slice-1",
                attempt: 2,
                tree_digest: gateDigest,
                diff_digest: gateDigest,
                context_digest: gateDigest,
                config_digest: gateDigest,
                blocking_gate_ids: ["unit"],
                receipt_ids: ["receipt-1"],
                decision_ids: [],
                diagnostics: [
                  {
                    gate_id: "unit",
                    outcome: "FAILED",
                    log_digest: gateDigest,
                    trust: "UNTRUSTED_DATA",
                    excerpt: `${compilerDiagnostic.path}:${String(compilerDiagnostic.line)}:${String(compilerDiagnostic.column)}: error: ${compilerMessage}`,
                    compiler_diagnostics: [],
                    test_diagnostics: [
                      {
                        ...testDiagnostic,
                        digest: canonicalDigest(testDiagnostic),
                      },
                    ],
                  },
                ],
              },
            },
          ],
        };
      if (sql.includes("engineering_artifact_revisions"))
        return {
          rows: [
            {
              artifact_kind: "LocalCommitReceipt",
              stage: "LOCAL_COMMIT",
              stage_attempt: 1,
              commit_sha: "a".repeat(40),
              review_decision: null,
              verification_decision: null,
            },
            {
              artifact_kind: "ReviewDecision",
              stage: "SLICE_REVIEW",
              stage_attempt: 2,
              commit_sha: null,
              review_decision: "PASS",
              verification_decision: null,
            },
            {
              artifact_kind: "VerificationDecision",
              stage: "FINAL_VERIFICATION",
              stage_attempt: 1,
              commit_sha: null,
              review_decision: null,
              verification_decision: "FAILED",
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
      throw new ToolLimitError("private budget message", "TOOL_CALL_LIMIT_EXCEEDED");
    }),
  ).rejects.toBeInstanceOf(ToolLimitError);

  const directory = join(root, "engineering-debug");
  const files = (await readdir(directory)).sort();
  expect(files).toHaveLength(4);
  const journals = files.filter((file) => file.endsWith(".jsonl"));
  const summaries = files.filter((file) => file.endsWith(".summary.md"));
  expect(journals).toHaveLength(2);
  expect(summaries).toHaveLength(2);
  const records = await Promise.all(
    journals.map((file) => readFile(join(directory, file), "utf8")),
  );
  expect(records.every((text) => text.includes('"status":"FAILED"'))).toBe(true);
  expect(records.every((text) => text.includes('"lease_deadline_at":"'))).toBe(true);
  expect(records.every((text) => text.includes('"commit_sha":"aaaaaaaa'))).toBe(true);
  expect(records.every((text) => text.includes('"gate_id":"unit"'))).toBe(true);
  expect(records.every((text) => text.includes('"outcome":"FAILED"'))).toBe(true);
  expect(records.every((text) => text.includes('"verification_decision":"FAILED"'))).toBe(true);
  expect(records.every((text) => text.includes(testDiagnostic.test_name))).toBe(true);
  expect(records.every((text) => !text.includes(testMessage))).toBe(true);
  expect(
    records.some((text) => text.includes('"error_detail_code":"TOOL_CALL_LIMIT_EXCEEDED"')),
  ).toBe(true);
  expect(records.every((text) => !text.includes("private budget message"))).toBe(true);
  expect(records.every((text) => !text.includes("/Users/private"))).toBe(true);
  const summaryRecords = await Promise.all(
    summaries.map((file) => readFile(join(directory, file), "utf8")),
  );
  expect(summaryRecords.every((text) => text.includes("Result: **FAILED**"))).toBe(true);
  expect(
    summaryRecords.every((text) => text.includes("| unit | CURRENT | FAILED | 1 | 123 |")),
  ).toBe(true);
  expect(
    summaryRecords.every((text) =>
      text.includes(
        `| unit | 2 | Sources/Feature.swift:41:9 | ${canonicalDigest(compilerMessage)}`,
      ),
    ),
  ).toBe(true);
  expect(
    summaryRecords.every((text) =>
      text.includes(
        `| unit | 2 | ${testDiagnostic.test_name} | ${testDiagnostic.path}:${String(testDiagnostic.line)} | ${canonicalDigest(testMessage)}`,
      ),
    ),
  ).toBe(true);
  expect(summaryRecords.every((text) => text.includes("## Xcode test diagnostic chain"))).toBe(
    true,
  );
  expect(summaryRecords.every((text) => !text.includes(testMessage))).toBe(true);
  expect(summaryRecords.every((text) => text.includes("Review attempt 2: PASS"))).toBe(true);
  expect(summaryRecords.every((text) => text.includes("Final verification: FAILED"))).toBe(true);
  expect(summaryRecords.every((text) => text.includes(`Commit: ${"a".repeat(40)}`))).toBe(true);
  expect(
    diagnosticQueries.some((sql) => sql.includes("i.kind = 'engineering.verification.gate'")),
  ).toBe(true);
  expect(diagnosticQueries.every((sql) => !sql.includes("i.operation_kind"))).toBe(true);
  expect(diagnosticQueries.every((sql) => !sql.includes("c.created_at"))).toBe(true);
  expect(diagnosticQueries.some((sql) => sql.includes("c.recorded_at"))).toBe(true);
  expect(
    diagnosticQueries.some(
      (sql) => sql.includes("artifact_kind = 'GateFailure'") && sql.includes("payload"),
    ),
  ).toBe(true);
  expect(diagnosticQueries.every((sql) => !sql.includes("jsonb_array_elements"))).toBe(true);
});

it("separates durable Engineering outcome from handler completion", async () => {
  const runScenario = async (input: {
    name: string;
    artifacts: readonly Record<string, unknown>[];
    work?: () => Promise<unknown>;
  }) => {
    const root = await mkdtemp(join(tmpdir(), `engineering-debug-${input.name}-`));
    roots.push(root);
    const database = {
      query: async (sql: string) => {
        if (sql.includes("artifact_kind = 'GateFailure'")) return { rows: [] };
        if (sql.includes("engineering_artifact_revisions")) return { rows: input.artifacts };
        return { rows: [] };
      },
    } as unknown as Database;
    const runner = createEngineeringInvocationJournalRunner({
      artifactRoot: root,
      db: database,
      model: "model",
      configDigest: canonicalDigest({ config: input.name }),
      logger: new StructuredLogger({ sink: { log: () => undefined } }),
    });
    const lease: JobLease = {
      jobId: `job-${input.name}`,
      caseId: `case-${input.name}`,
      jobType: "agent.implementer",
      payload: { caseId: `case-${input.name}`, runId: `run-${input.name}`, workUnitId: "unit" },
      provider: null,
      serializationKey: `case-${input.name}`,
      attempts: 1,
      maxAttempts: 3,
      fencingToken: 1,
      leaseExpiresAtMs: Date.now() + 60_000,
      leaseOwner: "worker-1",
    };
    let thrown: unknown;
    try {
      await runner.run(lease, input.work ?? (async () => "completed"));
    } catch (error) {
      thrown = error;
    }
    const journalFile = (await readdir(join(root, "engineering-debug"))).find((file) =>
      file.endsWith(".jsonl"),
    );
    if (journalFile === undefined) throw new Error("missing debug journal");
    return {
      thrown,
      text: await readFile(join(root, "engineering-debug", journalFile), "utf8"),
    };
  };
  const artifact = (artifactKind: string, commitSha: string | null = null) => ({
    artifact_kind: artifactKind,
    stage: "ENGINEERING",
    stage_attempt: 1,
    commit_sha: commitSha,
    review_decision: null,
    verification_decision: null,
    terminal_reason: null,
  });

  const blocked = await runScenario({
    name: "blocked",
    artifacts: [{ ...artifact("TerminalReason"), terminal_reason: "BLOCKED" }],
  });
  expect(blocked.thrown).toBeUndefined();
  expect(blocked.text).toContain('"status":"FAILED"');
  expect(blocked.text).toContain('"engineering_outcome":"BLOCKED"');
  expect(blocked.text).toContain('"handler_outcome":"SUCCEEDED"');

  const supervisorBlocked = await runScenario({
    name: "supervisor-gate-cap",
    artifacts: Array.from({ length: 8 }, () => artifact("GateFailure")),
    work: async () => ({ terminalReasonCode: "GATE_CORRECTION_LIMIT_EXHAUSTED" }),
  });
  expect(supervisorBlocked.thrown).toBeUndefined();
  expect(supervisorBlocked.text).toContain('"engineering_outcome":"BLOCKED"');
  expect(supervisorBlocked.text).toContain(
    '"terminal_reason_code":"GATE_CORRECTION_LIMIT_EXHAUSTED"',
  );
  expect(supervisorBlocked.text).toContain('"next_safe_step":"RETRY"');
  expect(supervisorBlocked.text).toContain('"reconciliation_required":false');

  const thrownSupervisorBlocked = await runScenario({
    name: "supervisor-gate-cap-thrown",
    artifacts: Array.from({ length: 8 }, () => artifact("GateFailure")),
    work: async () => {
      throw new CaseResumeUnresolvedError({
        progressed: 0,
        ambiguous: [],
        blocked: ["unit-gate-cap"],
        waiting: [],
        merges: [],
        terminalReasonCode: "GATE_CORRECTION_LIMIT_EXHAUSTED",
      });
    },
  });
  expect(thrownSupervisorBlocked.thrown).toBeInstanceOf(CaseResumeUnresolvedError);
  expect(thrownSupervisorBlocked.text).toContain('"handler_outcome":"FAILED"');
  expect(thrownSupervisorBlocked.text).toContain('"engineering_outcome":"BLOCKED"');
  expect(thrownSupervisorBlocked.text).toContain(
    '"terminal_reason_code":"GATE_CORRECTION_LIMIT_EXHAUSTED"',
  );
  expect(thrownSupervisorBlocked.text).toContain('"next_safe_step":"RETRY"');
  expect(thrownSupervisorBlocked.text).toContain('"reconciliation_required":false');

  const cancelled = await runScenario({
    name: "cancelled",
    artifacts: [{ ...artifact("TerminalReason"), terminal_reason: "CANCELLED" }],
  });
  expect(cancelled.text).toContain('"status":"FAILED"');
  expect(cancelled.text).toContain('"engineering_outcome":"CANCELLED"');
  expect(cancelled.text).toContain('"terminal_reason_code":"CANCELLED"');
  expect(cancelled.text).toContain('"next_safe_step":"WAIT"');
  expect(cancelled.text).toContain('"reconciliation_required":false');

  const ambiguous = await runScenario({
    name: "ambiguous",
    artifacts: [{ ...artifact("TerminalReason"), terminal_reason: "AMBIGUOUS" }],
  });
  expect(ambiguous.text).toContain('"terminal_reason_code":"AMBIGUOUS"');
  expect(ambiguous.text).toContain('"next_safe_step":"RECONCILE"');
  expect(ambiguous.text).toContain('"reconciliation_required":true');

  const waiting = await runScenario({
    name: "needs-clarification",
    artifacts: [{ ...artifact("TerminalReason"), terminal_reason: "NEEDS_CLARIFICATION" }],
  });
  expect(waiting.text).toContain('"status":"FAILED"');
  expect(waiting.text).toContain('"engineering_outcome":"WAITING"');

  const incomplete = await runScenario({ name: "empty", artifacts: [] });
  expect(incomplete.text).toContain('"engineering_outcome":"INCOMPLETE"');

  const committed = await runScenario({
    name: "committed",
    artifacts: [
      { ...artifact("ReviewDecision"), review_decision: "PASS" },
      { ...artifact("VerificationDecision"), verification_decision: "VERIFIED" },
      { ...artifact("LocalCommitReceipt", "a".repeat(40)), review_decision: null },
    ],
  });
  expect(committed.text).toContain('"engineering_outcome":"COMPLETED"');

  const supervisorCompleted = await runScenario({
    name: "supervisor-completed",
    artifacts: [
      { ...artifact("ReviewDecision"), review_decision: "PASS" },
      { ...artifact("VerificationDecision"), verification_decision: "VERIFIED" },
      { ...artifact("LocalCommitReceipt", "a".repeat(40)) },
    ],
    work: async () => ({ terminalReasonCode: "COMPLETED" }),
  });
  expect(supervisorCompleted.thrown).toBeUndefined();
  expect(supervisorCompleted.text).toContain('"engineering_outcome":"COMPLETED"');
  expect(supervisorCompleted.text).toContain('"terminal_reason_code":"COMPLETED"');
  expect(supervisorCompleted.text).toContain('"next_safe_step":"STOP"');

  const supervisorCompletedWithoutEvidence = await runScenario({
    name: "supervisor-completed-without-evidence",
    artifacts: [],
    work: async () => ({ terminalReasonCode: "COMPLETED" }),
  });
  expect(supervisorCompletedWithoutEvidence.text).toContain('"engineering_outcome":"INCOMPLETE"');
  expect(committed.text).toContain('"commit_sha":"aaaaaaaa');

  const missingCommit = await runScenario({
    name: "missing-commit",
    artifacts: [
      { ...artifact("ReviewDecision"), review_decision: "PASS" },
      { ...artifact("VerificationDecision"), verification_decision: "VERIFIED" },
    ],
  });
  expect(missingCommit.text).toContain('"status":"FAILED"');
  expect(missingCommit.text).toContain('"engineering_outcome":"INCOMPLETE"');
  expect(missingCommit.text).toContain('"commit_sha":null');

  const inconsistent = await runScenario({
    name: "inconsistent-commit",
    artifacts: [
      { ...artifact("ReviewDecision"), review_decision: "PASS" },
      { ...artifact("VerificationDecision"), verification_decision: "FAILED" },
      { ...artifact("LocalCommitReceipt", "b".repeat(40)), review_decision: null },
    ],
  });
  expect(inconsistent.text).toContain('"status":"FAILED"');
  expect(inconsistent.text).toContain('"engineering_outcome":"FAILED"');

  const thrown = await runScenario({
    name: "thrown",
    artifacts: [],
    work: async () => {
      throw new Error("callback failed");
    },
  });
  expect(thrown.thrown).toBeInstanceOf(Error);
  expect(thrown.text).toContain('"handler_outcome":"FAILED"');
  expect(thrown.text).toContain('"engineering_outcome":"FAILED"');
});

it("shares the durable compiler diagnostic projection with the live invocation journal", () => {
  const digest = canonicalDigest({ diagnostic: "live" });
  const message = "value of type 'SafetyAlert' has no member 'onText988'";
  const excerpt = `Sources/SafetyAlertView.swift:37:42: error: ${message}`;
  const rows = engineeringCompilerDiagnosticJournalRows([
    {
      stage_attempt: 7,
      payload: {
        schema_version: 1,
        artifact_kind: "GateFailure",
        case_id: "case-1",
        run_id: "run-1",
        revision: 0,
        authority: "SERVER_OWNED",
        slice_id: "slice-3",
        attempt: 7,
        tree_digest: digest,
        diff_digest: digest,
        context_digest: digest,
        config_digest: digest,
        blocking_gate_ids: ["ios-compile"],
        receipt_ids: ["receipt-7"],
        decision_ids: [],
        diagnostics: [
          {
            gate_id: "ios-compile",
            outcome: "FAILED",
            log_digest: digest,
            trust: "UNTRUSTED_DATA",
            excerpt,
            compiler_diagnostics: [],
          },
        ],
      },
    },
  ]);

  expect(rows).toEqual([
    expect.objectContaining({
      gate_id: "ios-compile",
      stage_attempt: 7,
      path: "Sources/SafetyAlertView.swift",
      line: 37,
      column: 42,
      message_digest: canonicalDigest(message),
    }),
  ]);
  expect(JSON.stringify(rows)).not.toContain(message);
  expect(Object.isFrozen(rows)).toBe(true);
});

it("shares a content-free durable XCTest projection with the live invocation journal", () => {
  const digest = canonicalDigest({ diagnostic: "xctest-live" });
  const identity = {
    test_name: "-[SharedTests.SafetyAlertTests testCloseDismissesAlert]",
    message: "XCTAssertFalse failed - safety alert remained visible",
    path: "Tests/SafetyAlertTests.swift",
    line: 73,
  } as const;
  const rows = engineeringXcodeTestDiagnosticJournalRows([
    {
      stage_attempt: 9,
      payload: {
        schema_version: 1,
        artifact_kind: "GateFailure",
        case_id: "case-1",
        run_id: "run-1",
        revision: 0,
        authority: "SERVER_OWNED",
        slice_id: "slice-3",
        attempt: 9,
        tree_digest: digest,
        diff_digest: digest,
        context_digest: digest,
        config_digest: digest,
        blocking_gate_ids: ["ios-tests"],
        receipt_ids: ["receipt-9"],
        decision_ids: [],
        diagnostics: [
          {
            gate_id: "ios-tests",
            outcome: "FAILED",
            log_digest: digest,
            trust: "UNTRUSTED_DATA",
            excerpt: "bounded test failure",
            compiler_diagnostics: [],
            test_diagnostics: [{ ...identity, digest: canonicalDigest(identity) }],
          },
        ],
      },
    },
  ]);

  expect(rows).toEqual([
    expect.objectContaining({
      gate_id: "ios-tests",
      stage_attempt: 9,
      test_name: identity.test_name,
      path: identity.path,
      line: identity.line,
      message_digest: canonicalDigest(identity.message),
      diagnostic_digest: canonicalDigest(identity),
    }),
  ]);
  expect(JSON.stringify(rows)).not.toContain(identity.message);
  expect(Object.isFrozen(rows)).toBe(true);
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
        usage: {
          inputTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
          outputTokens: 1,
          totalTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1,
        },
        content: [],
      };
    },
  });

  await expect(
    runWithEngineeringDebugJournal(journal, () =>
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "private" }] }] },
        {
          model: { provider: "qualification_fake", model_id: "model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 1, maxCalls: 1 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        },
      ),
    ),
  ).rejects.toThrow(
    new RegExp(`${String(ENGINEERING_MODEL_HARD_TOKEN_LIMIT)}-token hard limit`, "u"),
  );
  await journal.close();
  const text = await readFile(journal.filePath, "utf8");
  expect(text).toContain(`"total_tokens":${String(ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1)}`);
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
        usage: {
          inputTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
          outputTokens: 1,
          totalTokens:
            ENGINEERING_MODEL_HARD_TOKEN_LIMIT - ENGINEERING_MODEL_CALL_TOKEN_RESERVE + 1,
        },
        content: [],
      };
    },
  });
  const config = {
    model: { provider: "qualification_fake", model_id: "model" },
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

it("uses the conservative correction reserve without weakening ordinary calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-correction-reserve-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "correction-tail-reserve",
  });
  let calls = 0;
  const totals = [
    ENGINEERING_MODEL_HARD_TOKEN_LIMIT - ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
    0,
    0,
    0,
  ];
  const transport = createEngineeringDebugTransport({
    async converse(_request, config) {
      const totalTokens = totals[calls] ?? 1;
      calls += 1;
      return {
        model: config.model,
        usage: { inputTokens: totalTokens, outputTokens: 0, totalTokens },
        content: [],
      };
    },
  });
  const config = {
    model: { provider: "qualification_fake", model_id: "model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
  } as const;

  await runWithEngineeringDebugJournal(journal, async () => {
    await transport.converse({ messages: [] }, config);
    await transport.converse({ messages: [] }, config);
    await runWithEngineeringCorrectionModelCallBudget(async () => {
      await transport.converse({ messages: [] }, config);
      await transport.converse({ messages: [] }, config);
    });
  });
  expect(calls).toBe(4);
  await journal.close();
});

it("refuses a correction at the live-accounted hard-limit boundary before delegate dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-correction-admission-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "correction-admission-boundary",
  });
  let delegateCalls = 0;
  const transport = createEngineeringDebugTransport({
    async converse() {
      delegateCalls += 1;
      return { model: { provider: "qualification_fake", model_id: "model" }, content: [] };
    },
  });
  const config = {
    model: { provider: "qualification_fake", model_id: "model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
  } as const;
  await expect(
    runWithEngineeringDebugJournal(
      journal,
      () =>
        runWithEngineeringCorrectionModelCallBudget(() =>
          transport.converse({ messages: [] }, config),
        ),
      {
        priorJournalCount: 1,
        providerReportedTokens: 1_721_856,
        estimatedTokens: 0,
        accountedTokens: 1_721_856,
        completeness: "COMPLETE",
      },
    ),
  ).rejects.toThrow(/128000-token reserve/u);
  expect(delegateCalls).toBe(0);
  await journal.close();
});

it.each(["REVIEWER", "VERIFIER"] as const)(
  "uses the bounded %s tail reserve instead of the implementer reserve",
  async (role) => {
    const root = await mkdtemp(join(tmpdir(), `engineering-debug-${role.toLowerCase()}-reserve-`));
    roots.push(root);
    const journal = await EngineeringDebugJournal.create({
      artifactRoot: root,
      invocationId: `${role.toLowerCase()}-tail-reserve`,
    });
    const reserve =
      role === "REVIEWER"
        ? ENGINEERING_REVIEWER_MODEL_CALL_TOKEN_RESERVE
        : ENGINEERING_VERIFIER_MODEL_CALL_TOKEN_RESERVE;
    const profile = subscriptionModelProfileV1.parse({
      schema_version: 1,
      profile_name: `codex-${role.toLowerCase()}`,
      provider: "codex_cli",
      executable: process.execPath,
      model: "gpt-5.6-sol",
      timeout_ms: 10_000,
      kill_grace_ms: 100,
      max_stdin_bytes: 65_536,
      max_stdout_bytes: 65_536,
      max_stderr_bytes: 4096,
    });
    const invocation = createSubscriptionModelInvocationDescriptor({
      role,
      profile,
      clientVersion: "0.147.0",
      deploymentConfigDigest: `sha256:${"d".repeat(64)}`,
    });
    let calls = 0;
    const transport = createEngineeringDebugTransport(
      {
        async converse(_request, config) {
          calls += 1;
          const totalTokens = calls === 1 ? ENGINEERING_MODEL_HARD_TOKEN_LIMIT - reserve : 1;
          return {
            model: config.model,
            usage: { inputTokens: totalTokens, outputTokens: 0, totalTokens },
            content: [],
          };
        },
      },
      { role, invocation },
    );
    const config = {
      model: { provider: "codex_cli", model_id: profile.model },
      timeoutMs: 1_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    } as const;

    await runWithEngineeringDebugJournal(journal, async () => {
      await transport.converse({ messages: [] }, config);
      await transport.converse({ messages: [] }, config);
      await expect(transport.converse({ messages: [] }, config)).rejects.toThrow(
        new RegExp(`${String(reserve)}-token reserve`, "u"),
      );
    });
    expect(calls).toBe(2);
    await journal.close();
  },
);

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
        usage: {
          inputTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT - ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
          outputTokens: 1,
          totalTokens:
            ENGINEERING_MODEL_HARD_TOKEN_LIMIT - ENGINEERING_MODEL_CALL_TOKEN_RESERVE + 1,
        },
        content: [],
      };
    },
  });
  const config = {
    model: { provider: "qualification_fake", model_id: "model" },
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
  expect(files).toHaveLength(2);
  const journalFile = files.find((file) => file.endsWith(".jsonl"));
  if (journalFile === undefined) throw new Error("missing debug journal");
  const text = await readFile(join(directory, journalFile), "utf8");
  expect(text).toContain('"stage":"RUN_DIAGNOSTIC"');
  expect(text).toContain('"event":"RUN_COMPLETED"');
  expect(text).toContain('"status":"FAILED"');
  expect(text).toContain('"engineering_outcome":"UNKNOWN"');
  expect(text).toContain('"diagnostic_completeness":"INCOMPLETE"');
  expect(text).not.toContain("private database detail");
  expect(text).not.toContain("/Users/private");
  expect(JSON.stringify(warnings)).not.toContain("private database detail");
});

it("reconstructs chained journals and fails closed for truncation, legacy, and tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-reconstruct-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "reconstruct",
  });
  await journal.append({
    event: "RUN_STARTED",
    case_id: "case-reconstruct",
    run_id: "run-reconstruct",
    model: "model",
    base_sha: "a".repeat(40),
    config_digest: canonicalDigest({ config: 1 }),
  });
  await journal.append({
    event: "RUN_COMPLETED",
    schema_version: 2,
    status: "SUCCEEDED",
    commit_sha: "b".repeat(40),
    artifact_kinds: ["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"],
    handler_outcome: "SUCCEEDED",
    engineering_outcome: "COMPLETED",
    diagnostic_completeness: "COMPLETE",
    terminal_reason_code: "COMPLETED",
    next_safe_step: "STOP",
    reconciliation_required: false,
    elapsed_ms: 10,
    last_event_at: new Date().toISOString(),
  });
  await journal.close();
  const recovered = await reconstructEngineeringDebugJournal(journal.filePath);
  expect(recovered.diagnostic_completeness).toBe("COMPLETE");
  expect(recovered.events).toHaveLength(2);
  const recoveredSummary = join(root, "engineering-debug", "recovered.summary.md");
  await writeReconstructedEngineeringDebugSummary(recovered, recoveredSummary);
  await expect(
    writeReconstructedEngineeringDebugSummary(recovered, recoveredSummary),
  ).rejects.toThrow();

  const truncated = join(root, "engineering-debug", "truncated.jsonl");
  const raw = await readFile(journal.filePath, "utf8");
  await writeFile(truncated, raw.slice(0, raw.lastIndexOf("\n")), { mode: 0o600 });
  const truncatedResult = await reconstructEngineeringDebugJournal(truncated);
  expect(truncatedResult.truncated_final_line).toBe(true);
  expect(truncatedResult.diagnostic_completeness).toBe("INCOMPLETE");
  expect(truncatedResult.events).toHaveLength(1);
});

it("rejects record/event tampering, sequence gaps, and missing terminal evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-integrity-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "integrity",
  });
  await journal.append({
    event: "RUN_STARTED",
    case_id: "case",
    run_id: "run",
    model: "model",
    base_sha: null,
    config_digest: canonicalDigest(1),
  });
  await journal.append({
    event: "RUN_COMPLETED",
    schema_version: 2,
    status: "SUCCEEDED",
    commit_sha: "a".repeat(40),
    artifact_kinds: ["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"],
    handler_outcome: "SUCCEEDED",
    engineering_outcome: "COMPLETED",
    diagnostic_completeness: "COMPLETE",
    terminal_reason_code: "COMPLETED",
    next_safe_step: "STOP",
    reconciliation_required: false,
    elapsed_ms: 10,
    last_event_at: new Date().toISOString(),
  });
  await journal.close();
  const raw = await readFile(journal.filePath, "utf8");
  const lines = raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const tamperDigest = join(root, "tamper-digest.jsonl");
  const integrity = lines[0]!.integrity as Record<string, unknown>;
  await writeFile(
    tamperDigest,
    `${JSON.stringify({ ...lines[0], integrity: { ...integrity, record_digest: canonicalDigest("wrong") } })}\n${JSON.stringify(lines[1])}\n`,
  );
  await expect(reconstructEngineeringDebugJournal(tamperDigest)).rejects.toThrow(/integrity/);
  const tamperEvent = join(root, "tamper-event.jsonl");
  await writeFile(
    tamperEvent,
    `${JSON.stringify({ ...lines[0], model: "other" })}\n${JSON.stringify(lines[1])}\n`,
  );
  await expect(reconstructEngineeringDebugJournal(tamperEvent)).rejects.toThrow(/integrity/);
  const sequence = join(root, "sequence.jsonl");
  await writeFile(sequence, `${JSON.stringify({ ...lines[0], sequence: 4 })}\n`);
  await expect(reconstructEngineeringDebugJournal(sequence)).rejects.toThrow(/sequence/);
  const legacy = join(root, "legacy.jsonl");
  await writeFile(
    legacy,
    `${JSON.stringify({ sequence: 0, recorded_at: new Date().toISOString(), schema_version: 1, event: "RUN_STARTED", case_id: "case", run_id: "run", model: "model", base_sha: null, config_digest: canonicalDigest(1) })}\n`,
  );
  const legacyResult = await reconstructEngineeringDebugJournal(legacy);
  expect(legacyResult.legacy_records).toBe(true);
  expect(legacyResult.diagnostic_completeness).toBe("INCOMPLETE");
  const legacyComplete = join(root, "legacy-complete.jsonl");
  await writeFile(
    legacyComplete,
    `${JSON.stringify({ sequence: 0, recorded_at: new Date().toISOString(), schema_version: 1, event: "RUN_STARTED", case_id: "case", run_id: "run", model: "model", base_sha: null, config_digest: canonicalDigest(1) })}\n${JSON.stringify({ sequence: 1, recorded_at: new Date().toISOString(), schema_version: 1, event: "RUN_COMPLETED", status: "SUCCEEDED", commit_sha: "a".repeat(40), artifact_kinds: [] })}\n`,
  );
  const legacyCompleteResult = await reconstructEngineeringDebugJournal(legacyComplete);
  expect(legacyCompleteResult.terminal_present).toBe(true);
  expect(legacyCompleteResult.legacy_records).toBe(true);
  expect(legacyCompleteResult.integrity_valid).toBe(false);
  expect(legacyCompleteResult.diagnostic_completeness).toBe("INCOMPLETE");
  const noTerminal = join(root, "no-terminal.jsonl");
  await writeFile(noTerminal, `${JSON.stringify(lines[0])}\n`);
  expect((await reconstructEngineeringDebugJournal(noTerminal)).diagnostic_completeness).toBe(
    "INCOMPLETE",
  );
  const terminalOnlyRoot = await mkdtemp(join(tmpdir(), "engineering-debug-terminal-only-"));
  roots.push(terminalOnlyRoot);
  const terminalOnly = await EngineeringDebugJournal.create({
    artifactRoot: terminalOnlyRoot,
    invocationId: "terminal-only",
  });
  await terminalOnly.append({
    event: "RUN_COMPLETED",
    schema_version: 2,
    status: "SUCCEEDED",
    commit_sha: "c".repeat(40),
    artifact_kinds: ["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"],
    handler_outcome: "SUCCEEDED",
    engineering_outcome: "COMPLETED",
    diagnostic_completeness: "COMPLETE",
    terminal_reason_code: "COMPLETED",
    next_safe_step: "STOP",
    reconciliation_required: false,
    elapsed_ms: 10,
    last_event_at: new Date().toISOString(),
  });
  await terminalOnly.close();
  expect(
    (await reconstructEngineeringDebugJournal(terminalOnly.filePath)).diagnostic_completeness,
  ).toBe("INCOMPLETE");
  const afterTerminal = join(root, "after-terminal.jsonl");
  await writeFile(afterTerminal, `${raw}${JSON.stringify({ ...lines[1], sequence: 2 })}\n`);
  await expect(reconstructEngineeringDebugJournal(afterTerminal)).rejects.toThrow();
});

it("rejects semantically inconsistent RUN_COMPLETED v2 events", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-v2-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({ artifactRoot: root, invocationId: "v2" });
  expect(() =>
    journal.append({
      event: "RUN_COMPLETED",
      schema_version: 2,
      status: "FAILED",
      commit_sha: null,
      artifact_kinds: [],
      handler_outcome: "SUCCEEDED",
      engineering_outcome: "COMPLETED",
      diagnostic_completeness: "COMPLETE",
    }),
  ).toThrow();
  expect(() =>
    journal.append({
      event: "RUN_COMPLETED",
      schema_version: 2,
      status: "SUCCEEDED",
      commit_sha: null,
      artifact_kinds: [],
      handler_outcome: "SUCCEEDED",
      engineering_outcome: "BLOCKED",
      diagnostic_completeness: "COMPLETE",
    }),
  ).toThrow();
  expect(() =>
    journal.append({
      event: "RUN_COMPLETED",
      schema_version: 2,
      status: "FAILED",
      commit_sha: null,
      artifact_kinds: [],
      handler_outcome: "FAILED",
      engineering_outcome: "UNKNOWN",
      diagnostic_completeness: "COMPLETE",
    }),
  ).toThrow();
  await journal.close();
});

it("recovers after one append write failure without a sequence gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-append-recovery-"));
  roots.push(root);
  let writes = 0;
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "append-recovery",
    appendFile: async (data) => {
      writes += 1;
      if (writes === 2) throw new Error("injected append failure");
      await appendToFile(journal.filePath, data, "utf8");
    },
  });
  await journal.append({
    event: "RUN_STARTED",
    case_id: "case",
    run_id: "run",
    model: "model",
    base_sha: null,
    config_digest: canonicalDigest(1),
  });
  await expect(
    journal.append({
      event: "TOOL_INPUT_REFUSAL",
      stage: null,
      slice_id: null,
      attempt: null,
      tool_name: "tool",
      failure_code: "TOOL_INPUT_INVALID",
      issues: [{ code: "invalid", path: ["input"] }],
    }),
  ).rejects.toThrow();
  await journal.append({
    event: "RUN_COMPLETED",
    schema_version: 2,
    status: "SUCCEEDED",
    commit_sha: "a".repeat(40),
    artifact_kinds: ["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"],
    handler_outcome: "SUCCEEDED",
    engineering_outcome: "COMPLETED",
    diagnostic_completeness: "COMPLETE",
    terminal_reason_code: "COMPLETED",
    next_safe_step: "STOP",
    reconciliation_required: false,
    elapsed_ms: 10,
    last_event_at: new Date().toISOString(),
  });
  await journal.close();
  const result = await reconstructEngineeringDebugJournal(journal.filePath);
  expect(result.events.map((event) => event.sequence)).toEqual([0, 1]);
  expect(result.diagnostic_completeness).toBe("COMPLETE");
});

it("guarantees export teardown ordering and drop after failures", async () => {
  const calls: string[] = [];
  await expect(
    closeExportAndDropEngineeringRun({
      close: async () => {
        calls.push("close");
        throw new Error("close");
      },
      export: async () => {
        calls.push("export");
        throw new Error("export");
      },
      drop: async () => {
        calls.push("drop");
      },
    }),
  ).rejects.toThrow("close");
  expect(calls).toEqual(["close", "export", "drop"]);
});

it("exports private canonical artifacts and gate receipts exclusively", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-private-export-"));
  roots.push(root);
  const artifact = {
    schema_version: 1,
    artifact_kind: "TerminalReason",
    case_id: "case",
    run_id: "run",
    revision: 0,
    reason: "COMPLETED",
    detail: "completed",
  };
  const receipt = VerificationGateReceipt.parse({
    schema_version: 1,
    receipt_id: "receipt-1",
    case_id: "case",
    workspace_id: "workspace",
    run_id: "run",
    operation_id: "operation",
    gate_id: "gate",
    target: "CURRENT",
    tree_digest: canonicalDigest("tree"),
    config_digest: canonicalDigest("config"),
    command_digest: canonicalDigest("command"),
    outcome: "PASSED",
    exit_code: 0,
    signal: null,
    duration_ms: 1,
    log_artifact: {
      artifact_id: "log-1",
      digest: canonicalDigest("log"),
      scope: { case_id: "case", workspace_id: "workspace" },
      relative_path: "log.txt",
      byte_length: 3,
      complete: true,
      original_byte_length: 3,
    },
    log_digest: canonicalDigest("log"),
  });
  const queries: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
  const db = {
    query: async (sql: string, params?: readonly unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("engineering_artifact_revisions"))
        return {
          rows: [
            {
              revision: 0,
              artifact_kind: "TerminalReason",
              payload: artifact,
              payload_digest: canonicalDigest(artifact),
            },
          ],
        };
      return { rows: [{ receipt }] };
    },
  } as unknown as Database;
  const exported = await exportEngineeringEvidence({
    artifactRoot: root,
    caseId: "case",
    runId: "run",
    jobId: "job",
    invocationId: "invocation",
    db,
  });
  expect(exported.export.artifacts).toHaveLength(1);
  expect(exported.export.gate_receipts).toHaveLength(1);
  expect((await stat(exported.filePath)).mode & 0o777).toBe(0o600);
  expect((await stat(join(root, "engineering-private-evidence"))).mode & 0o777).toBe(0o700);
  expect(exported.filePath).not.toContain("engineering-debug");
  expect(queries[1]?.params).toEqual(["job", "run"]);
  const before = await readFile(exported.filePath, "utf8");
  expect(before).toBe(canonicalJsonStringify(exported.export));
  const roundTrip = JSON.parse(before) as typeof exported.export;
  expect(roundTrip).toEqual(exported.export);
  const artifactRecord = { ...exported.export.artifacts[0], record_digest: undefined };
  delete (artifactRecord as { record_digest?: unknown }).record_digest;
  expect(exported.export.artifacts[0]?.record_digest).toBe(canonicalDigest(artifactRecord));
  const receiptRecord = { ...exported.export.gate_receipts[0], record_digest: undefined };
  delete (receiptRecord as { record_digest?: unknown }).record_digest;
  expect(exported.export.gate_receipts[0]?.record_digest).toBe(canonicalDigest(receiptRecord));
  const unsignedExport = { ...exported.export };
  delete (unsignedExport as { export_digest?: unknown }).export_digest;
  expect(exported.export.export_digest).toBe(canonicalDigest(unsignedExport));
  await expect(
    exportEngineeringEvidence({
      artifactRoot: root,
      caseId: "case",
      runId: "run",
      jobId: "job",
      invocationId: "invocation",
      db,
    }),
  ).rejects.toThrow();
  expect(await readFile(exported.filePath, "utf8")).toBe(before);
  await expect(
    exportEngineeringEvidence({
      artifactRoot: root,
      caseId: "case",
      runId: "run",
      jobId: "",
      invocationId: "bad-job",
      db,
    }),
  ).rejects.toThrow();
  const badArtifactDb = {
    query: async (sql: string) =>
      sql.includes("engineering_artifact_revisions")
        ? {
            rows: [
              {
                revision: 0,
                artifact_kind: "TerminalReason",
                payload: artifact,
                payload_digest: canonicalDigest("wrong"),
              },
            ],
          }
        : { rows: [{ receipt }] },
  } as unknown as Database;
  await expect(
    exportEngineeringEvidence({
      artifactRoot: root,
      caseId: "case",
      runId: "run",
      jobId: "job",
      invocationId: "invocation-2",
      db: badArtifactDb,
    }),
  ).rejects.toThrow(/digest/);
  const badReceiptDb = {
    query: async (sql: string) =>
      sql.includes("engineering_artifact_revisions")
        ? {
            rows: [
              {
                revision: 0,
                artifact_kind: "TerminalReason",
                payload: artifact,
                payload_digest: canonicalDigest(artifact),
              },
            ],
          }
        : { rows: [{ receipt: {} }] },
  } as unknown as Database;
  await expect(
    exportEngineeringEvidence({
      artifactRoot: root,
      caseId: "case-3",
      runId: "run-3",
      jobId: "job",
      invocationId: "invocation-3",
      db: badReceiptDb,
    }),
  ).rejects.toThrow();
  const foreignArtifact = { ...artifact, case_id: "foreign" };
  const foreignDb = {
    query: async (sql: string) =>
      sql.includes("engineering_artifact_revisions")
        ? {
            rows: [
              {
                revision: 0,
                artifact_kind: "TerminalReason",
                payload: foreignArtifact,
                payload_digest: canonicalDigest(foreignArtifact),
              },
            ],
          }
        : { rows: [{ receipt }] },
  } as unknown as Database;
  await expect(
    exportEngineeringEvidence({
      artifactRoot: root,
      caseId: "case-4",
      runId: "run",
      jobId: "job",
      invocationId: "invocation-4",
      db: foreignDb,
    }),
  ).rejects.toThrow(/identity/);
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
          model: { provider: "qualification_fake", model_id: "model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 1, maxCalls: 1 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        },
      ),
    ),
  ).resolves.toMatchObject({ usage: { totalTokens: 12 } });
});

it("renders exact content-free operator aggregates", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-aggregates-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "aggregates",
  });
  await journal.append({
    event: "TOOL_BATCH",
    stage: "SLICE_IMPLEMENTATION",
    slice_id: "slice",
    attempt: 1,
    tools: [
      {
        name: "patch",
        relative_path: "src/Flow.swift",
        query_digest: null,
        files: ["src/Flow.swift"],
        input_keys: ["files"],
      },
    ],
  });
  await journal.append({
    event: "TOOL_RESULT",
    stage: "SLICE_IMPLEMENTATION",
    slice_id: "slice",
    attempt: 1,
    kind: "APPLY_PATCH",
    outcome: "SUCCEEDED",
    failure_code: null,
    changed_files: ["src/Flow.swift"],
    operation_id_digest: canonicalDigest("op"),
    output_truncated: false,
  });
  await journal.append({
    event: "MODEL_OUTPUT_SHAPE",
    keys: [],
    artifact_kind: null,
    changed_files: null,
    decision: null,
    criterion_statuses: ["PASSED", "FAILED", "INCONCLUSIVE"],
    review_lines_examined: null,
    review_findings: [],
  });
  await journal.close();
  const summary = await readFile(journal.summaryFilePath, "utf8");
  expect(summary).toContain("tools requested 1, succeeded 1");
  expect(summary).toContain("changed paths 1");
  expect(summary).toContain("criteria PASSED 1, FAILED 1, INCONCLUSIVE 1");
});

it("rejects every incomplete v2 success terminal mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-debug-terminal-contract-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "terminal-contract",
  });
  const valid = {
    event: "RUN_COMPLETED" as const,
    schema_version: 2 as const,
    status: "SUCCEEDED" as const,
    commit_sha: "a".repeat(40),
    artifact_kinds: ["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"],
    handler_outcome: "SUCCEEDED" as const,
    engineering_outcome: "COMPLETED" as const,
    diagnostic_completeness: "COMPLETE" as const,
    terminal_reason_code: "COMPLETED",
    next_safe_step: "STOP" as const,
    reconciliation_required: false,
    elapsed_ms: 12,
    last_event_at: new Date().toISOString(),
  };
  const mutations = [
    ["missing diagnostic completeness", { diagnostic_completeness: undefined }],
    ["missing terminal reason", { terminal_reason_code: undefined }],
    ["missing next step", { next_safe_step: undefined }],
    ["missing reconciliation", { reconciliation_required: undefined }],
    ["missing elapsed", { elapsed_ms: undefined }],
    ["missing last event", { last_event_at: undefined }],
    ["incomplete diagnostics", { diagnostic_completeness: "INCOMPLETE" }],
    ["unknown reason", { terminal_reason_code: "UNKNOWN" }],
    ["retry next step", { next_safe_step: "RETRY" }],
    ["requires reconciliation", { reconciliation_required: true }],
    ...(["LocalCommitReceipt", "ReviewDecision", "VerificationDecision"] as const).map(
      (kind) =>
        [
          `missing ${kind}`,
          { artifact_kinds: valid.artifact_kinds.filter((item) => item !== kind) },
        ] as const,
    ),
  ] as const;
  for (const [name, mutation] of mutations) {
    expect(() => journal.append({ ...valid, ...mutation } as never), name).toThrow();
  }
  await journal.append(valid);
  await journal.close();
});
