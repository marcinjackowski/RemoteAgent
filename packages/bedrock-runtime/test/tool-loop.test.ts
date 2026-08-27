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
const config = (maxIterations: number, maxCalls: number) =>
  createRuntimeConfig({
    model: { provider: "test", model_id: "model" },
    timeoutMs: 1000,
    toolLimits: { maxIterations, maxCalls },
  });
const user = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] };
const use = (id: string, name = "lookup") => ({ type: "tool-use" as const, id, name, input: {} });

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
});
