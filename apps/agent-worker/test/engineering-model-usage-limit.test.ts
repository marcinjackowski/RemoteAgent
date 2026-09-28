import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { createRuntimeConfig, runToolLoop, type RuntimeResponse } from "@remoteagent/model-runtime";

import {
  EngineeringDebugJournal,
  EngineeringModelUsageLimitExceededError,
  EngineeringModelBudgetError,
  ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  createEngineeringDebugTransport,
  engineeringDebugErrorCode,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";
import { receiptBackedImplementationReport } from "../src/engineering-execution.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("records a typed post-response overrun without executing the proposed patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-model-usage-limit-"));
  roots.push(root);
  const journal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "post-response-limit",
  });
  let delegateCalls = 0;
  let toolCalls = 0;
  const response: RuntimeResponse = {
    model: { provider: "qualification_fake", model_id: "model" },
    content: [
      {
        type: "tool-use",
        id: "patch-use",
        name: "patch",
        input: {
          relative_path: "SonderClient/Sources/Private.swift",
          content: "PROPOSED_PATCH_TEXT_MUST_NOT_LEAK",
        },
      },
    ],
    usage: {
      inputTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
      outputTokens: 1,
      totalTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1,
    },
  };
  const transport = createEngineeringDebugTransport({
    converse: async () => {
      delegateCalls += 1;
      return response;
    },
  });
  const config = createRuntimeConfig({
    model: response.model,
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 1, maxCalls: 1 },
  });

  // Control: the same real tool-loop path executes a valid patch proposal when usage is below the
  // fence, proving the zero count above is due to the post-response guard rather than an unwired
  // executor.
  let controlCalls = 0;
  let controlToolCalls = 0;
  const controlJournal = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "below-limit-control",
  });
  const controlTransport = createEngineeringDebugTransport({
    converse: async (_request, cfg) => {
      controlCalls += 1;
      return {
        model: cfg.model,
        content: controlCalls === 1 ? response.content : [{ type: "text" as const, text: "done" }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
  });
  await runWithEngineeringDebugJournal(controlJournal, () =>
    runToolLoop(
      controlTransport,
      {
        ...config,
        toolLimits: { maxIterations: 2, maxCalls: 1 },
        toolLoopPolicy: {
          mutationToolNames: ["patch"],
          readonlyToolNames: [],
          mutationIterationsReserved: 0,
          retainRecentToolPairs: 1,
        },
      },
      {
        messages: [{ role: "user", content: [{ type: "text", text: "control" }] }],
        tools: [{ name: "patch", description: "bounded", inputSchema: { type: "object" } }],
        execute: async () => {
          controlToolCalls += 1;
          return {
            ok: true,
            outcome: "SUCCEEDED",
            changed_files: ["SonderClient/Sources/Private.swift"],
          };
        },
      },
    ),
  );
  await controlJournal.close();
  expect(controlCalls).toBe(2);
  expect(controlToolCalls).toBe(1);

  const error = await runWithEngineeringDebugJournal(journal, async () => {
    try {
      await runToolLoop(transport, config, {
        messages: [{ role: "user", content: [{ type: "text", text: "PRIVATE_PROMPT_TEXT" }] }],
        tools: [{ name: "patch", description: "bounded", inputSchema: { type: "object" } }],
        execute: async () => {
          toolCalls += 1;
          return {
            ok: true,
            outcome: "SUCCEEDED",
            changed_files: ["SonderClient/Sources/Private.swift"],
          };
        },
      });
      throw new Error("expected overrun");
    } catch (caught) {
      return caught;
    }
  });
  await journal.close();
  expect(toolCalls).toBe(0);
  expect(delegateCalls).toBe(1);
  expect(error).toBeInstanceOf(EngineeringModelUsageLimitExceededError);
  expect(error).not.toBeInstanceOf(EngineeringModelBudgetError);
  expect(engineeringDebugErrorCode(error)).toBe("ENGINEERING_MODEL_USAGE_LIMIT_EXCEEDED");
  expect(error).toMatchObject({
    code: "ENGINEERING_MODEL_USAGE_LIMIT_EXCEEDED",
    accountedTokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1,
    hardLimit: ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  });
  expect((error as EngineeringModelUsageLimitExceededError).name).toBe(
    "EngineeringModelUsageLimitExceededError",
  );

  let receiptError: unknown;
  try {
    receiptBackedImplementationReport({
      error,
      successfulMutationPaths: ["SonderClient/Sources/Private.swift"],
      unresolvedMutationFailure: false,
    });
  } catch (caught) {
    receiptError = caught;
  }
  expect(receiptError).toBe(error);
  const journalText = await readFile(journal.filePath, "utf8");
  expect(journalText).toContain('"comparison":"HARD_LIMIT"');
  expect(journalText).toContain('"response_input_tokens":1800000');
  const usages = journalText
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.event === "MODEL_USAGE");
  expect(usages).toHaveLength(1);
  expect(usages.at(-1)).toMatchObject({
    response_input_tokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
    response_output_tokens: 1,
    response_total_tokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1,
    accounted_tokens: ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1,
  });
  expect(journalText).not.toContain("PRIVATE_PROMPT_TEXT");
  expect(journalText).not.toContain("PROPOSED_PATCH_TEXT_MUST_NOT_LEAK");
});
