import { describe, expect, it } from "vitest";

import {
  FakeTransport,
  ToolLimitError,
  TransportError,
  createRuntimeConfig,
  runToolLoop,
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

  it("returns a deterministic failed tool result without retrying", async () => {
    const transport = new FakeTransport([
      { model: config(2, 2).model, content: [use("failed")] },
      { model: config(2, 2).model, content: [{ type: "text", text: "ack" }] },
    ]);
    const result = await runToolLoop(transport, config(2, 2), {
      messages: [user],
      tools: [tool],
      execute: async () => {
        throw new Error("secret");
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "ack" }]);
    expect(transport.requests[1]?.messages[2]?.content).toEqual([
      { type: "tool-result", id: "failed", output: { ok: false, error: "Tool execution failed" } },
    ]);
  });
});
