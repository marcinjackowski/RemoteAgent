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
    ).rejects.toBeInstanceOf(ToolLimitError);
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
    ).rejects.toBeInstanceOf(ToolLimitError);
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
    ).rejects.toBeInstanceOf(ToolLimitError);
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
    await expect(
      runToolLoop(transport, config(4, 4), {
        messages: [user],
        tools: [tool],
        execute: async () => {
          executions += 1;
          throw new ToolInputError([{ path: ["relative_path"], code: "invalid_format" }]);
        },
      }),
    ).rejects.toThrow("Repeated invalid tool input made no progress");
    expect(executions).toBe(3);
    expect(transport.requests).toHaveLength(3);
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
        return { raw: `${name}-result` };
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
      { model: bounded.model, content: [use("failed-write", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [use("corrected-write", "write")] },
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
          : { outcome: "SUCCEEDED", failure_code: null };
      },
    });

    expect(writes).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 2, calls: 2 });
    expect(JSON.stringify(transport.requests[2]?.messages)).toContain(
      "FAILED_MUTATION_NOT_RECOVERED",
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
      { model: bounded.model, content: [use("failed-write", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final" }] },
      { model: bounded.model, content: [use("corrected-write", "write")] },
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
          : { outcome: "SUCCEEDED", failure_code: null };
      },
    });

    expect(writes).toBe(2);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 2, calls: 2 });
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
      { model: bounded.model, content: [use("failed-write-1", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final 1" }] },
      { model: bounded.model, content: [use("failed-write-2", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final 2" }] },
      { model: bounded.model, content: [use("corrected-write", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "done" }] },
    ]);
    let writes = 0;
    const result = await runToolLoop(transport, bounded, {
      messages: [user],
      tools: [writeTool],
      execute: async () => {
        writes += 1;
        return writes < 3
          ? { outcome: "FAILED", failure_code: "WRITE_REQUIRES_NEW_FILE" }
          : { outcome: "SUCCEEDED", failure_code: null };
      },
    });

    expect(writes).toBe(3);
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result).toMatchObject({ iterations: 3, calls: 3 });
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
      { model: bounded.model, content: [use("failed-write-1", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final 1" }] },
      { model: bounded.model, content: [use("corrected-write-1", "write")] },
      { model: bounded.model, content: [use("failed-write-2", "write")] },
      { model: bounded.model, content: [{ type: "text", text: "premature final 2" }] },
      { model: bounded.model, content: [use("corrected-write-2", "write")] },
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
          : { outcome: "SUCCEEDED", failure_code: null };
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
        return { written: true };
      },
    });
    expect(executions).toBe(1);
    expect(result).toMatchObject({ iterations: 1, calls: 1 });
  });
});
