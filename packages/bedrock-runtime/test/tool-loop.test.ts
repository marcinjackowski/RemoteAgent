import { describe, expect, it } from "vitest";

import {
  FakeTransport,
  ToolInputError,
  ToolLimitError,
  TransportError,
  createRuntimeConfig,
  runToolLoop,
  type RuntimeRequest,
} from "../src/index.js";

const tool = { name: "lookup", inputSchema: { type: "object" } };
const readTool = { name: "read", inputSchema: { type: "object" } };
const writeTool = { name: "write", inputSchema: { type: "object" } };
const config = (maxIterations: number, maxCalls: number) =>
  createRuntimeConfig({
    model: { provider: "test", model_id: "model" },
    timeoutMs: 1000,
    toolLimits: { maxIterations, maxCalls },
  });
const user = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] };
const use = (id: string, name = "lookup") => ({ type: "tool-use" as const, id, name, input: {} });
const policyConfig = () =>
  createRuntimeConfig({
    model: { provider: "test", model_id: "model" },
    timeoutMs: 1000,
    toolLimits: { maxIterations: 6, maxCalls: 12 },
    toolLoopPolicy: {
      readonlyToolNames: ["read"],
      mutationToolNames: ["write"],
      mutationIterationsReserved: 3,
      retainRecentToolPairs: 1,
    },
  });

describe("runToolLoop", () => {
  it("retries the next model turn without repeating the executor", async () => {
    const retryConfig = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 2, maxCalls: 2 },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 7 },
    });
    let transportCalls = 0;
    const requests: RuntimeRequest[] = [];
    const transport = {
      converse: async (request: RuntimeRequest) => {
        requests.push(request);
        transportCalls += 1;
        if (transportCalls === 1)
          return {
            model: retryConfig.model,
            content: [use("u1")],
            requestId: "tool",
            usage: { totalTokens: 1 },
          };
        if (transportCalls === 2) throw new TransportError("transient", "TRANSIENT");
        return {
          model: retryConfig.model,
          content: [{ type: "text" as const, text: "done" }],
          requestId: "success",
          usage: { totalTokens: 2 },
        };
      },
    };
    let executions = 0;
    const delays: number[] = [];
    const result = await runToolLoop(transport, retryConfig, {
      messages: [user],
      tools: [tool],
      execute: async () => {
        executions += 1;
        return { value: 1 };
      },
      execution: {
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(executions).toBe(1);
    expect(transportCalls).toBe(3);
    expect(result.transportAttempts).toBe(3);
    expect(result.modelCompletions).toEqual([
      {
        model: retryConfig.model,
        requestId: "tool",
        usage: { totalTokens: 1 },
        transportAttempts: 1,
      },
      {
        model: retryConfig.model,
        requestId: "success",
        usage: { totalTokens: 2 },
        transportAttempts: 2,
      },
    ]);
    expect(delays).toEqual([7]);
    expect(requests[1]?.messages).toEqual(requests[2]?.messages);
    expect(requests[1]?.tools).toEqual([tool]);
  });

  it("executes once, appends history, and returns metadata", async () => {
    const transport = new FakeTransport([
      { model: config(2, 3).model, content: [use("u1")] },
      {
        model: config(2, 3).model,
        content: [{ type: "text", text: "done" }],
        requestId: "r",
        usage: { totalTokens: 4 },
      },
    ]);
    const calls: unknown[] = [];
    const result = await runToolLoop(transport, config(2, 3), {
      messages: [user],
      tools: [tool],
      execute: async (...args) => {
        calls.push(args);
        return { value: 1 };
      },
    });
    expect(calls).toHaveLength(1);
    expect(config(2, 3).toolLoopPolicy).toBeUndefined();
    expect(result).toMatchObject({ requestId: "r", iterations: 1, calls: 1 });
    expect(transport.requests[1]?.messages).toHaveLength(3);
    expect(transport.requests[1]?.messages[1]?.role).toBe("assistant");
    expect(transport.requests[1]?.messages[2]?.role).toBe("tool");
    expect(transport.requests[1]?.messages[2]?.content).toEqual([
      {
        type: "tool-result",
        id: "u1",
        output: {
          ok: true,
          value: { value: 1 },
          progress: { tool_iterations_remaining: 1, tool_calls_remaining: 2 },
        },
      },
    ]);
  });

  it("shows the same bounded remaining budget after a safe tool failure", async () => {
    const transport = new FakeTransport([
      { model: config(2, 3).model, content: [use("bad")] },
      { model: config(2, 3).model, content: [{ type: "text", text: "done" }] },
    ]);
    await runToolLoop(transport, config(2, 3), {
      messages: [user],
      tools: [tool],
      execute: async () => {
        throw new ToolInputError([{ path: ["relative_path"], code: "invalid_format" }]);
      },
    });
    expect(transport.requests[1]?.messages[2]?.content).toEqual([
      {
        type: "tool-result",
        id: "bad",
        output: {
          ok: false,
          error: {
            code: "TOOL_INPUT_INVALID",
            issues: [{ path: ["relative_path"], code: "invalid_format" }],
          },
          progress: { tool_iterations_remaining: 1, tool_calls_remaining: 2 },
        },
      },
    ]);
  });

  it("preflights an over-limit batch before any executor side effect", async () => {
    let count = 0;
    const transport = new FakeTransport([
      { model: config(1, 1).model, content: [use("a"), use("b")] },
    ]);
    await expect(
      runToolLoop(transport, config(1, 1), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          count += 1;
        },
      }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      detailCode: "TOOL_CALL_LIMIT_EXCEEDED",
    });
    expect(count).toBe(0);
  });

  it("preflights iteration and zero limits", async () => {
    let iterationCount = 0;
    const scripted = [
      { model: config(1, 2).model, content: [use("a")] },
      { model: config(1, 2).model, content: [use("b")] },
    ];
    await expect(
      runToolLoop(new FakeTransport(scripted), config(1, 2), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          iterationCount += 1;
        },
      }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      detailCode: "TOOL_ITERATION_LIMIT_EXCEEDED",
    });
    expect(iterationCount).toBe(1);
    let zeroCount = 0;
    const zeroTransport = new FakeTransport([scripted[0]!]);
    await expect(
      runToolLoop(zeroTransport, config(0, 2), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          zeroCount += 1;
        },
      }),
    ).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
      detailCode: "TOOL_EXECUTION_DISABLED",
    });
    expect(zeroCount).toBe(0);
    expect(zeroTransport.requests[0]).not.toHaveProperty("tools");
  });

  it("rejects duplicate and unknown tools before execution", async () => {
    let count = 0;
    const duplicate = new FakeTransport([
      { model: config(2, 2).model, content: [use("same"), use("same")] },
    ]);
    await expect(
      runToolLoop(duplicate, config(2, 2), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          count += 1;
        },
      }),
    ).rejects.toBeInstanceOf(TransportError);
    const unknown = new FakeTransport([
      { model: config(2, 2).model, content: [use("unknown", "missing")] },
    ]);
    await expect(
      runToolLoop(unknown, config(2, 2), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          count += 1;
        },
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(count).toBe(0);
  });

  it("rejects duplicate IDs across iterations without a second side effect", async () => {
    let count = 0;
    const transport = new FakeTransport([
      { model: config(2, 2).model, content: [use("same")] },
      { model: config(2, 2).model, content: [use("same")] },
    ]);
    await expect(
      runToolLoop(transport, config(2, 2), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          count += 1;
        },
      }),
    ).rejects.toBeInstanceOf(TransportError);
    expect(count).toBe(1);
  });

  it("returns bounded machine-readable tool errors without leaking exception text", async () => {
    const transport = new FakeTransport([
      { model: config(2, 2).model, content: [use("failed")] },
      { model: config(2, 2).model, content: [{ type: "text", text: "ack" }] },
    ]);
    const result = await runToolLoop(transport, config(2, 2), {
      messages: [user],
      tools: [tool],
      execute: async () => {
        throw new ToolInputError([{ path: ["files", "0", "content"], code: "invalid_type" }]);
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "ack" }]);
    expect(transport.requests[1]?.messages[2]?.content).toEqual([
      {
        type: "tool-result",
        id: "failed",
        output: {
          ok: false,
          error: {
            code: "TOOL_INPUT_INVALID",
            issues: [{ path: ["files", "0", "content"], code: "invalid_type" }],
          },
          progress: { tool_iterations_remaining: 1, tool_calls_remaining: 1 },
        },
      },
    ]);
  });

  it("stops a third identical invalid input as bounded no-progress", async () => {
    let executions = 0;
    const transport = new FakeTransport([
      { model: config(4, 4).model, content: [use("bad-1")] },
      { model: config(4, 4).model, content: [use("bad-2")] },
      { model: config(4, 4).model, content: [use("bad-3")] },
    ]);
    const failure = await runToolLoop(transport, config(4, 4), {
      messages: [user],
      tools: [tool],
      execute: async () => {
        executions += 1;
        throw new ToolInputError([{ path: ["relative_path"], code: "invalid_format" }]);
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ToolLimitError",
      code: "LIMIT_EXCEEDED",
      detailCode: "TOOL_INPUT_INVALID:lookup:invalid_format:relative_path",
    });
    expect(failure).toBeInstanceOf(ToolLimitError);
    expect(executions).toBe(3);
    expect(transport.requests).toHaveLength(3);
  });

  it("preserves the exact bounded schema issue when two invalid mutations hit one target", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const target = "Tests/EmergencyResourcesTextFlowAdapterTests.swift";
    const invalidUse = (id: string) => ({
      ...use(id, "write"),
      input: { relative_path: target, files: [], replacement_files: [] },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [invalidUse("invalid-1")] },
      { model: bounded.model, content: [invalidUse("invalid-2")] },
    ]);

    const failure = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        throw new ToolInputError([{ path: [], code: "invalid_union" }]);
      },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "ToolLimitError",
      code: "LIMIT_EXCEEDED",
      detailCode: "TOOL_INPUT_INVALID:write:invalid_union:ROOT",
    });
    expect(transport.requests).toHaveLength(2);
  });

  it("does not expose arbitrary executor exception messages", async () => {
    const transport = new FakeTransport([
      { model: config(2, 2).model, content: [use("failed")] },
      { model: config(2, 2).model, content: [{ type: "text", text: "ack" }] },
    ]);
    await runToolLoop(transport, config(2, 2), {
      messages: [user],
      tools: [tool],
      execute: async () => {
        throw new Error("/Users/private/path secret-token");
      },
    });
    const serialized = JSON.stringify(transport.requests[1]);
    expect(serialized).toContain("TOOL_EXECUTION_FAILED");
    expect(serialized).not.toContain("/Users/private/path");
    expect(serialized).not.toContain("secret-token");
  });

  it("refuses discovery at the reserve boundary without executing it and keeps mutation available", async () => {
    const bounded = policyConfig();
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("r1", "read")] },
      { model: bounded.model, content: [use("r2", "read")] },
      { model: bounded.model, content: [use("r3", "read")] },
      { model: bounded.model, content: [use("r4", "read")] },
      { model: bounded.model, content: [use("w1", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    const executed: string[] = [];
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [readTool, writeTool],
      execute: async (name) => {
        executed.push(name);
        return name === "write"
          ? { outcome: "SUCCEEDED", changed_files: ["src/Feature.swift"] }
          : { raw: `${name}-result` };
      },
    });

    expect(executed).toEqual(["read", "read", "read", "write"]);
    expect(result).toMatchObject({ iterations: 4, calls: 4 });
    const refusal = transport.requests[4]?.messages
      .flatMap((message) => message.content)
      .find((content) => content.type === "tool-result" && content.id === "r4");
    expect(refusal).toMatchObject({
      output: {
        ok: false,
        error: { code: "TOOL_MUTATION_RESERVE" },
        progress: {
          tool_iterations_remaining: 3,
          mutation_iterations_reserved: 3,
        },
      },
    });
    const mutation = result.history
      .flatMap((message) => message.content)
      .find((content) => content.type === "tool-result" && content.id === "w1");
    expect(mutation).toMatchObject({
      output: {
        progress: { tool_iterations_remaining: 2, tool_calls_remaining: 8 },
      },
    });
  });

  it("enforces the code-owned two-round discovery ceiling before the mutation reserve", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 8, maxCalls: 16 },
      toolLoopPolicy: {
        readonlyToolNames: ["read"],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 3,
        maxReadonlyIterationsBeforeMutation: 2,
        retainRecentToolPairs: 1,
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("r1", "read")] },
      { model: bounded.model, content: [use("r2", "read")] },
      { model: bounded.model, content: [use("r3", "read")] },
      { model: bounded.model, content: [use("w1", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    const executed: string[] = [];
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [readTool, writeTool],
      execute: async (name) => {
        executed.push(name);
        return { outcome: "SUCCEEDED", changed_files: [] };
      },
    });

    expect(executed).toEqual(["read", "read", "write"]);
    expect(result).toMatchObject({ iterations: 3, calls: 3 });
    const refusal = transport.requests[3]?.messages
      .flatMap((message) => message.content)
      .find((content) => content.type === "tool-result" && content.id === "r3");
    expect(refusal).toMatchObject({
      output: {
        ok: false,
        error: { code: "TOOL_DISCOVERY_LIMIT" },
        progress: {
          readonly_iterations_used: 2,
          readonly_iterations_limit: 2,
          mutation_iterations_reserved: 3,
        },
      },
    });
  });

  it("preserves initial contracts and compacts old raw pairs to deterministic digests", async () => {
    const bounded = policyConfig();
    const useWithRawInput = (id: string, raw: string) => ({
      type: "tool-use" as const,
      id,
      name: "read",
      input: { raw },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [useWithRawInput("r1", "OLD_INPUT_ONE")] },
      { model: bounded.model, content: [useWithRawInput("r2", "OLD_INPUT_TWO")] },
      { model: bounded.model, content: [useWithRawInput("r3", "RECENT_INPUT")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    await runToolLoop(transport, bounded, {
      messages: [
        user,
        {
          role: "user",
          content: [{ type: "text", text: "INITIAL_CONTRACT_CANARY" }],
        },
      ],
      tools: [readTool, writeTool],
      execute: async (_name, input) => {
        if (JSON.stringify(input).includes("OLD_INPUT_ONE")) {
          throw new ToolInputError([{ path: ["raw"], code: "invalid_value" }]);
        }
        return { raw: `OUTPUT_${JSON.stringify(input)}` };
      },
    });

    const compacted = JSON.stringify(transport.requests[3]?.messages);
    expect(compacted).toContain("INITIAL_CONTRACT_CANARY");
    expect(compacted).toContain("TOOL_HISTORY_PROJECTION");
    expect(compacted).toContain('"tool_name":"read"');
    expect(compacted).toContain('"outcome":"SUCCEEDED"');
    expect(compacted).toContain('"outcome":"FAILED"');
    expect(compacted).toContain('"error_code":"TOOL_INPUT_INVALID"');
    expect(compacted).toMatch(/sha256:[0-9a-f]{64}/u);
    expect(compacted).not.toContain("OLD_INPUT_ONE");
    expect(compacted).not.toContain("OLD_INPUT_TWO");
    expect(compacted).toContain("RECENT_INPUT");
  });

  it("rotates a subscription context to a code-owned digest handoff every three pairs", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 6, maxCalls: 6 },
      toolLoopPolicy: {
        readonlyToolNames: ["read"],
        mutationToolNames: [],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 2,
        contextEpochPairLimit: 3,
      },
    });
    const rawUse = (id: string, raw: string) => ({
      type: "tool-use" as const,
      id,
      name: "read",
      input: { raw },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [rawUse("r1", "RAW_ONE")] },
      { model: bounded.model, content: [rawUse("r2", "RAW_TWO")] },
      { model: bounded.model, content: [rawUse("r3", "RAW_THREE")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);

    await runToolLoop(transport, bounded, {
      messages: [user, { role: "user", content: [{ type: "text", text: "HUGE_INITIAL_CANARY" }] }],
      epochHandoffMessages: [
        {
          role: "user",
          content: [
            {
              type: "json",
              value: {
                kind: "CONTEXT_EPOCH_HANDOFF",
                initial_contract_digest: "sha256:handoff",
              },
            },
          ],
        },
      ],
      tools: [readTool],
      execute: async (_name, input) => ({ raw: `OUTPUT_${JSON.stringify(input)}` }),
    });

    const rotated = JSON.stringify(transport.requests[3]?.messages);
    expect(rotated).toContain("CONTEXT_EPOCH_HANDOFF");
    expect(rotated).not.toContain("HUGE_INITIAL_CANARY");
    expect(rotated).not.toContain("RAW_ONE");
    expect(rotated).toContain("RAW_TWO");
    expect(rotated).toContain("RAW_THREE");
    expect(rotated).toContain("TOOL_HISTORY_PROJECTION");
    expect(rotated).toContain('"context_epoch":1');
    expect(rotated).toMatch(/sha256:[0-9a-f]{64}/u);
  });

  it("refuses an epoch policy without a code-owned handoff", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: ["read"],
        mutationToolNames: [],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        contextEpochPairLimit: 3,
      },
    });
    await expect(
      runToolLoop(new FakeTransport([]), bounded, {
        messages: [user],
        tools: [readTool],
        execute: async () => null,
      }),
    ).rejects.toThrow(/context epoch handoff is required/i);
  });

  it("preserves a domain refusal code after the full tool result is compacted", async () => {
    const bounded = policyConfig();
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("w1", "write")] },
      { model: bounded.model, content: [use("r2", "read")] },
      { model: bounded.model, content: [use("r3", "read")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [readTool, writeTool],
      execute: async (name) =>
        name === "write"
          ? {
              outcome: "FAILED",
              failure_code: "WRITE_REQUIRES_NEW_FILE",
              output: { value: "RAW_REFUSAL_DETAIL" },
            }
          : { outcome: "SUCCEEDED", output: { value: "RAW_READ_DETAIL" } },
    });

    const compacted = JSON.stringify(transport.requests[3]?.messages);
    expect(compacted).toContain('"outcome":"FAILED"');
    expect(compacted).toContain('"error_code":"WRITE_REQUIRES_NEW_FILE"');
    expect(compacted).not.toContain("RAW_REFUSAL_DETAIL");
    expect(compacted).toContain("RAW_READ_DETAIL");
  });

  it("preserves exact successful mutation paths after raw tool results are compacted", async () => {
    const bounded = policyConfig();
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [
          {
            ...use("w1", "write"),
            input: {
              relative_path: "Sources/Feature.swift",
              content: "RAW_SOURCE_CONTENT",
            },
          },
        ],
      },
      { model: bounded.model, content: [use("r2", "read")] },
      { model: bounded.model, content: [use("r3", "read")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [readTool, writeTool],
      execute: async (name) =>
        name === "write"
          ? {
              outcome: "SUCCEEDED",
              failure_code: null,
              changed_files: ["Sources/Feature.swift"],
              output: { value: "RAW_WRITE_OUTPUT" },
            }
          : { outcome: "SUCCEEDED", changed_files: [], output: { value: "RAW_READ_OUTPUT" } },
    });

    const compacted = JSON.stringify(transport.requests[3]?.messages);
    expect(compacted).toContain('"changed_files":["Sources/Feature.swift"]');
    expect(compacted).not.toContain("RAW_SOURCE_CONTENT");
    expect(compacted).not.toContain("RAW_WRITE_OUTPUT");
    expect(compacted).toContain("RAW_READ_OUTPUT");
  });

  it("requires a successful mutation after a domain refusal before accepting the final report", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("failed-write", "write"), input: { relative_path: "src/A.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      {
        model: bounded.model,
        content: [{ ...use("corrected-write", "write"), input: { relative_path: "src/A.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return writes === 1
          ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE", changed_files: [] }
          : { outcome: "SUCCEEDED", failure_code: null, changed_files: ["src/A.swift"] };
      },
    });

    expect(writes).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 2, calls: 2 });
    expect(JSON.stringify(transport.requests[2]?.messages)).toContain(
      "FAILED_MUTATION_NOT_RECOVERED",
    );
  });

  it("reconciles only the exact failed target, never a later successful sibling", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const targetA = "src/A.swift";
    const targetB = "src/B.swift";
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("failed-a", "write"), input: { relative_path: targetA } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      {
        model: bounded.model,
        content: [{ ...use("success-b", "write"), input: { relative_path: targetB } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "must remain blocked" }] },
      { model: bounded.model, content: [{ type: "text", text: "still blocked" }] },
    ]);
    let writes = 0;
    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => {
          writes += 1;
          return writes === 1
            ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE", changed_files: [] }
            : { outcome: "SUCCEEDED", failure_code: null, changed_files: [targetB] };
        },
      }),
    ).rejects.toThrow(/failed mutation was recovered/);
    expect(writes).toBe(2);
    const recovery = JSON.stringify(transport.requests[2]?.messages);
    expect(recovery).toContain('"unresolved_failed_mutation_paths":["src/A.swift"]');
    expect(recovery).toContain("every exact failed path");
    expect(transport.requests).toHaveLength(4);
  });

  it("lists every unresolved failed mutation path in sorted recovery evidence", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 2, maxCalls: 2 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["patch"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const patchTool = { name: "patch", inputSchema: { type: "object" } };
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [
          {
            ...use("failed-batch", "patch"),
            input: {
              replacement_files: [
                { relative_path: "src/Z.swift", replacements: [] },
                { relative_path: "src/A.swift", replacements: [] },
              ],
            },
          },
        ],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
    ]);
    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [patchTool],
        execute: async () => ({
          outcome: "FAILED",
          failure_code: "REPLACEMENT_MISMATCH",
          changed_files: [],
        }),
      }),
    ).rejects.toThrow(/failed mutation was recovered/);
    const recovery = transport.requests
      .map((request) => JSON.stringify(request.messages))
      .join("\n");
    expect(recovery).toContain('"unresolved_failed_mutation_paths":["src/A.swift","src/Z.swift"]');
  });

  it.each(["THROWN_INPUT_ERROR", "DOMAIN_FAILED"] as const)(
    "keeps an unscoped failed mutation unresolved after an unrelated success (%s)",
    async (failureMode) => {
      const bounded = createRuntimeConfig({
        model: { provider: "test", model_id: "model" },
        timeoutMs: 1000,
        toolLimits: { maxIterations: 4, maxCalls: 4 },
        toolLoopPolicy: {
          readonlyToolNames: [],
          mutationToolNames: ["write"],
          mutationIterationsReserved: 0,
          retainRecentToolPairs: 1,
          requireSuccessfulMutationAfterFailure: true,
        },
      });
      const transport = new FakeTransport([
        { model: bounded.model, content: [use("unscoped-failure", "write")] },
        { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
        {
          model: bounded.model,
          content: [
            { ...use("unrelated-success", "write"), input: { relative_path: "src/B.swift" } },
          ],
        },
        { model: bounded.model, content: [{ type: "text", text: "must remain blocked" }] },
      ]);
      await expect(
        runToolLoop(transport, bounded, {
          messages: [user],
          tools: [writeTool],
          execute: async (name, input) => {
            if (name === "write" && Object.keys(input as object).length === 0) {
              if (failureMode === "THROWN_INPUT_ERROR") {
                throw new ToolInputError([{ path: [], code: "invalid_input" }]);
              }
              return { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE" };
            }
            return { outcome: "SUCCEEDED", failure_code: null, changed_files: ["src/B.swift"] };
          },
        }),
      ).rejects.toThrow(/failed mutation was recovered/);
      const recovery = transport.requests
        .map((request) => JSON.stringify(request.messages))
        .join("\n");
      expect(recovery).toContain('"unresolved_unscoped_mutation_failure":true');
      expect(transport.requests).toHaveLength(4);
    },
  );

  it("reconciles a failed target only after its later successful receipt", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const target = "src/A.swift";
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("failed-a", "write"), input: { relative_path: target } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      {
        model: bounded.model,
        content: [{ ...use("success-a", "write"), input: { relative_path: target } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return writes === 1
          ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE", changed_files: [] }
          : { outcome: "SUCCEEDED", failure_code: null, changed_files: [target] };
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(writes).toBe(2);
  });

  it("keeps an ambiguous mutation sticky even after a later success", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("ambiguous-a", "write"), input: { relative_path: "src/A.swift" } }],
      },
      {
        model: bounded.model,
        content: [{ ...use("success-b", "write"), input: { relative_path: "src/B.swift" } }],
      },
    ]);
    let writes = 0;
    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => {
          writes += 1;
          return writes === 1
            ? {
                outcome: "AMBIGUOUS",
                failure_code: null,
                changed_files: ["src/A.swift"],
                ambiguity_reason: "UNVERIFIED_POST_STATE",
                requires_reconciliation: true,
              }
            : { outcome: "SUCCEEDED", failure_code: null, changed_files: ["src/B.swift"] };
        },
      }),
    ).rejects.toThrow(/Ambiguous mutation cannot be retried/);
    expect(writes).toBe(1);
  });

  it.each([
    ["null", null, { relative_path: "src/B.swift" }],
    ["empty object", {}, {}],
    ["unknown outcome", { outcome: "UNKNOWN" }, { relative_path: "src/B.swift" }],
  ] as const)(
    "treats malformed domain outcome as ambiguous (%s), including after prior success",
    async (_label, malformed, malformedInput) => {
      const bounded = createRuntimeConfig({
        model: { provider: "test", model_id: "model" },
        timeoutMs: 1000,
        toolLimits: { maxIterations: 4, maxCalls: 4 },
        toolLoopPolicy: {
          readonlyToolNames: [],
          mutationToolNames: ["write"],
          mutationIterationsReserved: 0,
          retainRecentToolPairs: 1,
          requireSuccessfulMutationAfterFailure: true,
          requireSuccessfulMutationBeforeFinal: true,
        },
      });
      const transport = new FakeTransport([
        {
          model: bounded.model,
          content: [{ ...use("success-a", "write"), input: { relative_path: "src/A.swift" } }],
        },
        {
          model: bounded.model,
          content: [{ ...use("malformed-b", "write"), input: malformedInput }],
        },
        {
          model: bounded.model,
          content: [{ ...use("must-not-run", "write"), input: { relative_path: "src/C.swift" } }],
        },
      ]);
      let writes = 0;
      await expect(
        runToolLoop(transport, bounded, {
          messages: [user],
          tools: [writeTool],
          execute: async (_name, input) => {
            writes += 1;
            if ((input as { relative_path?: string }).relative_path === "src/A.swift") {
              return { outcome: "SUCCEEDED", changed_files: ["src/A.swift"] };
            }
            if (writes === 2) return malformed;
            return { outcome: "SUCCEEDED", changed_files: ["src/C.swift"] };
          },
        }),
      ).rejects.toThrow(/Ambiguous mutation cannot be retried/);
      expect(writes).toBe(2);
      expect(transport.requests).toHaveLength(2);
    },
  );

  it.each([
    ["distinct targets", "src/B.swift"],
    ["same target", "src/A.swift"],
  ] as const)(
    "does not execute a mutation after same-batch ambiguity (%s)",
    async (_label, secondPath) => {
      const bounded = createRuntimeConfig({
        model: { provider: "test", model_id: "model" },
        timeoutMs: 1000,
        toolLimits: { maxIterations: 3, maxCalls: 4 },
        toolLoopPolicy: {
          readonlyToolNames: [],
          mutationToolNames: ["write"],
          mutationIterationsReserved: 0,
          retainRecentToolPairs: 1,
          requireSuccessfulMutationAfterFailure: true,
        },
      });
      const transport = new FakeTransport([
        {
          model: bounded.model,
          content: [
            { ...use("ambiguous", "write"), input: { relative_path: "src/A.swift" } },
            { ...use("must-not-run", "write"), input: { relative_path: secondPath } },
          ],
        },
      ]);
      let writes = 0;
      await expect(
        runToolLoop(transport, bounded, {
          messages: [user],
          tools: [writeTool],
          execute: async (_name, _input) => {
            writes += 1;
            if (writes === 1) {
              return { outcome: "AMBIGUOUS", changed_files: [] };
            }
            return { outcome: "SUCCEEDED", changed_files: [secondPath] };
          },
        }),
      ).rejects.toThrow(/Ambiguous mutation cannot be retried/);
      expect(writes).toBe(1);
    },
  );

  it("requires a successful mutation before accepting the first compiler-repair final report", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 1, maxCalls: 1 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [use("required-write", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;

    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return { outcome: "SUCCEEDED", failure_code: null };
      },
    });

    expect(writes).toBe(1);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 1, calls: 1 });
    expect(JSON.stringify(transport.requests[1]?.messages)).toContain(
      "SUCCESSFUL_MUTATION_REQUIRED",
    );
  });

  it("bounds repeated compiler-repair finals that never mutate", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 1, maxCalls: 1 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [{ type: "text", text: "still premature" }] },
    ]);

    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => ({ outcome: "SUCCEEDED", failure_code: null }),
      }),
    ).rejects.toThrow(/required mutation was completed/);
  });

  it("requires a successful mutation on a code-owned correction path before final", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
        requiredSuccessfulMutationPaths: ["src/Flow.swift", "src/FlowView.swift"],
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("test-only", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [use("flow-fix", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;

    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return {
          outcome: "SUCCEEDED",
          failure_code: null,
          changed_files: [writes === 1 ? "tests/FlowTests.swift" : "src/Flow.swift"],
        };
      },
    });

    expect(writes).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(JSON.stringify(transport.requests[2]?.messages)).toContain(
      "REQUIRED_CORRECTION_PATH_NOT_CHANGED",
    );
    expect(JSON.stringify(transport.requests[2]?.messages)).toContain("src/Flow.swift");
  });

  it("requires successful mutations on every blocking review path and reports only remaining paths", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
        requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("flow-fix", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [use("view-fix", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;

    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => ({
        outcome: "SUCCEEDED",
        failure_code: null,
        changed_files: [writes++ === 0 ? "src/Flow.swift" : "src/FlowView.swift"],
      }),
    });

    const recovery = transport.requests[2]?.messages
      .flatMap((message) => message.content)
      .find(
        (content) =>
          content.type === "json" &&
          typeof content.value === "object" &&
          content.value !== null &&
          !Array.isArray(content.value) &&
          content.value.kind === "MUTATION_RECOVERY_REQUIRED",
      );
    expect(writes).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(recovery).toMatchObject({
      type: "json",
      value: {
        reason_code: "REQUIRED_CORRECTION_PATH_NOT_CHANGED",
        required_correction_paths: ["src/FlowView.swift"],
        required_correction_paths_any: [],
        required_correction_paths_all: ["src/FlowView.swift"],
      },
    });
  });

  it("bounds repeated finals that never touch the required correction path", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 1, maxCalls: 1 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
        requiredSuccessfulMutationPaths: ["src/Flow.swift"],
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("test-only", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [{ type: "text", text: "still premature" }] },
      { model: bounded.model, content: [{ type: "text", text: "third premature final" }] },
    ]);

    const error = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => ({
        outcome: "SUCCEEDED",
        failure_code: null,
        changed_files: ["tests/FlowTests.swift"],
      }),
    }).catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(ToolLimitError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/required correction path was changed/u),
      detailCode: "FINAL_WITHOUT_REQUIRED_CORRECTION_RECEIPT",
    });
    expect(JSON.stringify(transport.requests[3]?.messages)).toContain(
      "final_report_claims_are_not_mutation_receipts",
    );
  });

  it("allows one extra mutation-only recovery after two receipt-less correction finals", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 1, maxCalls: 1 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
        requiredSuccessfulMutationPaths: ["src/Flow.swift"],
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [{ type: "text", text: "claimed changed_files" }] },
      { model: bounded.model, content: [{ type: "text", text: "claimed again" }] },
      { model: bounded.model, content: [use("real-flow-fix", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;

    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return {
          outcome: "SUCCEEDED",
          failure_code: null,
          changed_files: ["src/Flow.swift"],
        };
      },
    });

    expect(writes).toBe(1);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(JSON.stringify(transport.requests[2]?.messages)).toContain(
      "final_report_claims_are_not_mutation_receipts",
    );
  });

  it("allows one bounded mutation-only extension for a required path left unapplied by an atomic batch failure", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 2, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationBeforeFinal: true,
        requireSuccessfulMutationAfterFailure: true,
        requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "tests/FlowTests.swift"],
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("atomic-batch", "write"), input: { relative_path: "src/Flow.swift" } }],
      },
      { model: bounded.model, content: [use("repair-source", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [use("repair-test", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let calls = 0;

    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            outcome: "FAILED",
            failure_code: "REPLACEMENT_MISMATCH",
            changed_files: [],
          };
        }
        return {
          outcome: "SUCCEEDED",
          failure_code: null,
          changed_files: [calls === 2 ? "src/Flow.swift" : "tests/FlowTests.swift"],
        };
      },
    });

    expect(calls).toBe(3);
    expect(result.iterations).toBe(3);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(JSON.stringify(transport.requests[3]?.messages)).toContain(
      '"required_correction_paths_all":["tests/FlowTests.swift"]',
    );
    expect(JSON.stringify(transport.requests[3]?.messages)).toContain(
      '"mutation_recovery_extension_remaining":1',
    );
  });

  it("executes exactly one mutation-only recovery batch when the refusal consumed the last normal iteration", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 1, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("failed-write", "write"), input: { relative_path: "src/A.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      {
        model: bounded.model,
        content: [{ ...use("corrected-write", "write"), input: { relative_path: "src/A.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return writes === 1
          ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE" }
          : { outcome: "SUCCEEDED", failure_code: null, changed_files: ["src/A.swift"] };
      },
    });

    expect(writes).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 2, calls: 2 });
  });

  it("never retries a mutation whose domain outcome is ambiguous", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 2, maxCalls: 2 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("ambiguous-write", "write")] },
      { model: bounded.model, content: [use("must-not-run", "write")] },
    ]);
    let writes = 0;

    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => {
          writes += 1;
          return {
            outcome: "AMBIGUOUS",
            failure_code: null,
            changed_files: ["src/possibly-written.ts"],
          };
        },
      }),
    ).rejects.toThrow(/Ambiguous mutation cannot be retried/);
    expect(writes).toBe(1);
  });

  it("offers another bounded recovery instruction after a new mutation attempt is refused", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("failed-write-1", "write"), input: { relative_path: "src/A.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final 1" }] },
      {
        model: bounded.model,
        content: [{ ...use("failed-write-2", "write"), input: { relative_path: "src/B.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final 2" }] },
      {
        model: bounded.model,
        content: [{ ...use("corrected-write", "write"), input: { relative_path: "src/B.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
      { model: bounded.model, content: [{ type: "text", text: "still premature" }] },
    ]);
    let writes = 0;
    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => {
          writes += 1;
          return writes < 3
            ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE" }
            : { outcome: "SUCCEEDED", failure_code: null, changed_files: ["src/B.swift"] };
        },
      }),
    ).rejects.toThrow(/failed mutation was recovered/);
    expect(writes).toBe(3);
    expect(JSON.stringify(transport.requests[4]?.messages)).toContain(
      "FAILED_MUTATION_NOT_RECOVERED",
    );
  });

  it("stops after two refused mutations of the same target even when the model changes the guess", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 6, maxCalls: 6 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const target = "Sources/Localizable.strings";
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [
          {
            ...use("failed-write-1", "write"),
            input: { relative_path: target, content: "first guess" },
          },
        ],
      },
      {
        model: bounded.model,
        content: [
          {
            ...use("failed-write-2", "write"),
            input: { relative_path: target, content: "different guess" },
          },
        ],
      },
      { model: bounded.model, content: [{ type: "text", text: "must not run" }] },
    ]);
    let writes = 0;

    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => {
          writes += 1;
          return { outcome: "FAILED", failure_code: "REPLACEMENT_MISMATCH" };
        },
      }),
    ).rejects.toThrow(/Repeated mutation target refusal made no progress/);
    expect(writes).toBe(2);
    expect(transport.requests).toHaveLength(2);
  });

  it("narrows replacement-mismatch recovery to the exact server-observed path", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["patch"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
        requireSuccessfulMutationBeforeFinal: true,
        requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
      },
    });
    const patchTool = { name: "patch", inputSchema: { type: "object" } };
    const patchUse = (id: string, paths: readonly string[]) => ({
      ...use(id, "patch"),
      input: {
        replacement_files: paths.map((relative_path) => ({ relative_path, replacements: [] })),
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [patchUse("stale-batch", ["src/Flow.swift", "src/FlowView.swift"])],
      },
      { model: bounded.model, content: [patchUse("flow-retry", ["src/Flow.swift"])] },
      { model: bounded.model, content: [patchUse("view-retry", ["src/FlowView.swift"])] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let executions = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [patchTool],
      execute: async () => {
        executions += 1;
        if (executions === 1) {
          return {
            outcome: "FAILED",
            failure_code: "REPLACEMENT_MISMATCH",
            changed_files: [],
            output: {
              value: JSON.stringify({
                repair_context: {
                  relative_path: "src/Flow.swift",
                  replacement_index: 0,
                  expected_old_content_digest: `sha256:${"b".repeat(64)}`,
                  current_excerpt_digest: `sha256:${"a".repeat(64)}`,
                  current_excerpt_complete: true,
                  current_excerpt: "current bytes",
                },
              }),
            },
          };
        }
        return {
          outcome: "SUCCEEDED",
          failure_code: null,
          changed_files: [executions === 2 ? "src/Flow.swift" : "src/FlowView.swift"],
        };
      },
    });

    const recovery = transport.requests[1]?.messages
      .flatMap((message) => message.content)
      .find(
        (content) =>
          content.type === "json" &&
          typeof content.value === "object" &&
          content.value !== null &&
          !Array.isArray(content.value) &&
          content.value.kind === "REPLACEMENT_REPAIR_REQUIRED",
      );
    expect(recovery).toMatchObject({
      type: "json",
      value: {
        authority: "SERVER_OWNED",
        reason_code: "REPLACEMENT_MISMATCH",
        relative_path: "src/Flow.swift",
        replacement_index: 0,
        expected_old_content_digest: `sha256:${"b".repeat(64)}`,
        current_excerpt_digest: `sha256:${"a".repeat(64)}`,
        current_excerpt_complete: true,
        next_action: expect.stringContaining("minimal unique old_content block"),
      },
    });
    expect(executions).toBe(3);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("does not let an unrelated successful patch hide an unresolved failed target", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 2, maxCalls: 3 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["patch"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
        requireSuccessfulMutationBeforeFinal: true,
      },
    });
    const patchTool = { name: "patch", inputSchema: { type: "object" } };
    const patchUse = (id: string, path: string) => ({
      ...use(id, "patch"),
      input: {
        replacement_files: [{ relative_path: path, replacements: [] }],
      },
    });
    const flow = "Tests/SafetyAlertTests.swift";
    const adapter = "Tests/EmergencyResourcesTextFlowAdapterTests.swift";
    const transport = new FakeTransport([
      { model: bounded.model, content: [patchUse("stale-flow", flow)] },
      { model: bounded.model, content: [patchUse("fix-adapter", adapter)] },
      { model: bounded.model, content: [{ type: "text", text: "premature" }] },
      { model: bounded.model, content: [patchUse("fix-flow", flow)] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let executions = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [patchTool],
      execute: async () => {
        executions += 1;
        if (executions === 1) {
          return {
            outcome: "FAILED",
            failure_code: "REPLACEMENT_MISMATCH",
            changed_files: [],
            output: {
              value: JSON.stringify({
                repair_context: {
                  relative_path: flow,
                  replacement_index: 0,
                  expected_old_content_digest: `sha256:${"b".repeat(64)}`,
                  current_excerpt_digest: `sha256:${"a".repeat(64)}`,
                  current_excerpt_complete: false,
                },
              }),
            },
          };
        }
        return {
          outcome: "SUCCEEDED",
          failure_code: null,
          changed_files: [executions === 2 ? adapter : flow],
        };
      },
    });

    expect(executions).toBe(3);
    expect(transport.requests).toHaveLength(5);
    expect(JSON.stringify(transport.requests[3]?.messages)).toContain(
      "FAILED_MUTATION_NOT_RECOVERED",
    );
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("counts different failing paths in one multi-file replacement as distinct progress", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["patch"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
        requireSuccessfulMutationBeforeFinal: true,
        requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
      },
    });
    const patchTool = { name: "patch", inputSchema: { type: "object" } };
    const patchUse = (id: string, paths: readonly string[]) => ({
      ...use(id, "patch"),
      input: {
        replacement_files: paths.map((relative_path) => ({ relative_path, replacements: [] })),
      },
    });
    const both = ["src/Flow.swift", "src/FlowView.swift"] as const;
    const transport = new FakeTransport([
      { model: bounded.model, content: [patchUse("stale-flow", both)] },
      { model: bounded.model, content: [patchUse("stale-view", both)] },
      { model: bounded.model, content: [patchUse("fix-view", ["src/FlowView.swift"])] },
      { model: bounded.model, content: [patchUse("fix-flow", ["src/Flow.swift"])] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let executions = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [patchTool],
      execute: async () => {
        executions += 1;
        if (executions <= 2) {
          const relativePath = executions === 1 ? "src/Flow.swift" : "src/FlowView.swift";
          const digestByte = executions === 1 ? "a" : "b";
          return {
            outcome: "FAILED",
            failure_code: "REPLACEMENT_MISMATCH",
            changed_files: [],
            output: {
              value: JSON.stringify({
                repair_context: {
                  relative_path: relativePath,
                  replacement_index: 0,
                  expected_old_content_digest: `sha256:${"c".repeat(64)}`,
                  current_excerpt_digest: `sha256:${digestByte.repeat(64)}`,
                  current_excerpt_complete: false,
                },
              }),
            },
          };
        }
        return {
          outcome: "SUCCEEDED",
          failure_code: null,
          changed_files: [executions === 3 ? "src/FlowView.swift" : "src/Flow.swift"],
        };
      },
    });

    expect(executions).toBe(4);
    expect(transport.requests).toHaveLength(5);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("allows a correction when the same mutation target reports a different failure code", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const target = "Sources/Feature.swift";
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("invalid-request", "write"), input: { relative_path: target } }],
      },
      {
        model: bounded.model,
        content: [{ ...use("stale-prestate", "write"), input: { relative_path: target } }],
      },
      {
        model: bounded.model,
        content: [{ ...use("corrected", "write"), input: { relative_path: target } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    const failureCodes: Array<"INVALID_REQUEST" | "PRE_STATE_MISMATCH" | null> = [
      "INVALID_REQUEST",
      "PRE_STATE_MISMATCH",
      null,
    ];

    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        const failureCode = failureCodes.shift();
        return failureCode === null
          ? { outcome: "SUCCEEDED", failure_code: null, changed_files: [target] }
          : { outcome: "FAILED", failure_code: failureCode };
      },
    });

    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 3, calls: 3 });
    expect(transport.requests).toHaveLength(4);
  });

  it("does not consume the one beyond-limit recovery on an earlier in-budget correction", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 3, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      {
        model: bounded.model,
        content: [{ ...use("failed-write-1", "write"), input: { relative_path: "src/A.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final 1" }] },
      {
        model: bounded.model,
        content: [
          { ...use("corrected-write-1", "write"), input: { relative_path: "src/A.swift" } },
        ],
      },
      {
        model: bounded.model,
        content: [{ ...use("failed-write-2", "write"), input: { relative_path: "src/B.swift" } }],
      },
      { model: bounded.model, content: [{ type: "text", text: "premature final 2" }] },
      {
        model: bounded.model,
        content: [
          { ...use("corrected-write-2", "write"), input: { relative_path: "src/B.swift" } },
        ],
      },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return writes === 1 || writes === 3
          ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE" }
          : {
              outcome: "SUCCEEDED",
              failure_code: null,
              changed_files: [writes === 2 ? "src/A.swift" : "src/B.swift"],
            };
      },
    });

    expect(writes).toBe(4);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 4, calls: 4 });
  });

  it("bounds repeated final reports that do not recover a failed mutation", async () => {
    const bounded = createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 1000,
      toolLimits: { maxIterations: 4, maxCalls: 4 },
      toolLoopPolicy: {
        readonlyToolNames: [],
        mutationToolNames: ["write"],
        mutationIterationsReserved: 0,
        retainRecentToolPairs: 1,
        requireSuccessfulMutationAfterFailure: true,
      },
    });
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("failed-write", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [{ type: "text", text: "still premature" }] },
    ]);

    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [writeTool],
        execute: async () => ({ outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE" }),
      }),
    ).rejects.toThrow(/Final report repeated/);
  });

  it("rejects a duplicate ID after its full pair was compacted", async () => {
    const bounded = policyConfig();
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("old-id", "read")] },
      { model: bounded.model, content: [use("r2", "read")] },
      { model: bounded.model, content: [use("r3", "read")] },
      { model: bounded.model, content: [use("old-id", "read")] },
    ]);
    let executions = 0;
    await expect(
      runToolLoop(transport, bounded, {
        messages: [user],
        tools: [readTool, writeTool],
        execute: async () => {
          executions += 1;
          return { ok: true };
        },
      }),
    ).rejects.toThrow(/Duplicate or unknown tool-use id/);
    expect(executions).toBe(3);
    expect(JSON.stringify(transport.requests[3]?.messages)).not.toContain('"id":"old-id"');
  });

  it("keeps prefetched mutation-only sessions valid under the generic policy", async () => {
    const bounded = policyConfig();
    const transport = new FakeTransport([
      { model: bounded.model, content: [use("w1", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let executions = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        executions += 1;
        return { outcome: "SUCCEEDED", changed_files: ["src/Feature.swift"] };
      },
    });
    expect(executions).toBe(1);
    expect(result).toMatchObject({ iterations: 1, calls: 1 });
  });
});
