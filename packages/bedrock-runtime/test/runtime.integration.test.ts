import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  Runtime,
  RuntimeCancelledError,
  RuntimeTimeoutError,
  TransportError,
  createRuntimeConfig,
  type RuntimeResponse,
  type RuntimeStreamEvent,
} from "../src/index.js";

const config = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 10_000,
  toolLimits: { maxIterations: 2, maxCalls: 2 },
  retryPolicy: { maxAttempts: 3, baseDelayMs: 7 },
});
const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }];
const valid = {
  schema_version: 1,
  run_id: "run",
  case_id: "case",
  status: "COMPLETED",
  summary: "done",
  completed_steps: [],
  evidence: [],
  checkpoint_patch: {},
  next_actions: [],
};
const jsonResponse = (value: unknown, requestId?: string): RuntimeResponse => ({
  model: config.model,
  content: [{ type: "json", value: value as never }],
  usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
  ...(requestId === undefined ? {} : { requestId }),
});

describe("Runtime integration", () => {
  it("retries text transient failures with exact attempts and delay", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const runtime = new Runtime({
      config,
      transport: {
        converse: async () => {
          attempts += 1;
          if (attempts < 3) throw new TransportError("retry", "TRANSIENT");
          return { model: config.model, content: [{ type: "text", text: "ok" }] };
        },
      },
      execution: { sleep: async (delay) => delays.push(delay) },
    });
    await expect(runtime.execute({ mode: "text", messages })).resolves.toMatchObject({
      text: "ok",
      transportAttempts: 3,
    });
    expect(attempts).toBe(3);
    expect(delays).toEqual([7, 14]);
  });

  it("executes one tool, then repairs invalid structured output", async () => {
    let calls = 0;
    let executions = 0;
    const runtime = new Runtime({
      config,
      transport: {
        converse: async () => {
          calls += 1;
          if (calls === 1)
            return {
              model: config.model,
              content: [{ type: "tool-use", id: "u1", name: "lookup", input: {} }],
              requestId: "tool",
              usage: { totalTokens: 1 },
            };
          if (calls === 2)
            return { ...jsonResponse({ invalid: true }, "invalid"), usage: { totalTokens: 2 } };
          return { ...jsonResponse(valid, "repair"), usage: { totalTokens: 3 } };
        },
      },
    });
    const result = await runtime.execute({
      mode: "structured",
      messages,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { found: true };
      },
    });
    expect(result).toMatchObject({
      repaired: true,
      toolCalls: 1,
      transportAttempts: 3,
      requestId: "repair",
      usage: { totalTokens: 3 },
    });
    expect(result.modelCompletions).toEqual([
      { model: config.model, requestId: "tool", usage: { totalTokens: 1 }, transportAttempts: 1 },
      {
        model: config.model,
        requestId: "invalid",
        usage: { totalTokens: 2 },
        transportAttempts: 1,
      },
      {
        model: config.model,
        requestId: "repair",
        usage: { totalTokens: 3 },
        transportAttempts: 1,
      },
    ]);
    expect(executions).toBe(1);
  });

  it("returns stream usage and request metadata", async () => {
    async function* stream(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: "text", text: "ok" };
      yield { type: "metadata", usage: { totalTokens: 2 } };
      yield { type: "complete" };
    }
    const runtime = new Runtime({
      config,
      transport: { converse: async () => ({ model: config.model, content: [] }) },
      streamTransport: {
        converseStream: async () => ({ stream: stream(), requestId: "stream-1" }),
      },
    });
    await expect(runtime.execute({ mode: "stream", messages })).resolves.toMatchObject({
      text: "ok",
      usage: { totalTokens: 2 },
      requestId: "stream-1",
      transportAttempts: 1,
    });
  });

  it("rejects missing adapter and pre-abort without provider calls", async () => {
    let calls = 0;
    const runtime = new Runtime({
      config,
      transport: {
        converse: async () => {
          calls += 1;
          return { model: config.model, content: [] };
        },
      },
    });
    await expect(runtime.execute({ mode: "stream", messages })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    const controller = new AbortController();
    controller.abort();
    const withStream = new Runtime({
      config,
      transport: { converse: async () => ({ model: config.model, content: [] }) },
      streamTransport: {
        converseStream: async () => {
          calls += 1;
          return { stream: (async function* () {})() };
        },
      },
    });
    await expect(
      withStream.execute({ mode: "stream", messages, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(calls).toBe(0);
  });

  it("cancels an active stream, aborts provider signal, and cleans up", async () => {
    let providerSignal: AbortSignal | undefined;
    let timerCallback: (() => void) | undefined;
    let clearCount = 0;
    let addCount = 0;
    let removeCount = 0;
    let upstreamListener: (() => void) | undefined;
    const upstreamSignal = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => {
        addCount += 1;
        upstreamListener = listener;
      },
      removeEventListener: () => {
        removeCount += 1;
      },
    } as unknown as AbortSignal;
    const runtime = new Runtime({
      config,
      transport: { converse: async () => ({ model: config.model, content: [] }) },
      streamTransport: {
        converseStream: async (request) => {
          providerSignal = request.signal;
          async function* hanging(): AsyncIterable<RuntimeStreamEvent> {
            await new Promise<never>(() => {});
          }
          return { stream: hanging() };
        },
      },
      timers: {
        setTimeout: (callback) => {
          timerCallback = callback;
          return 1;
        },
        clearTimeout: () => {
          clearCount += 1;
        },
      },
    });
    const promise = runtime.execute({ mode: "stream", messages, signal: upstreamSignal });
    await Promise.resolve();
    upstreamListener?.();
    await expect(promise).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(providerSignal?.aborted).toBe(true);
    expect(clearCount).toBe(1);
    expect(addCount).toBe(1);
    expect(removeCount).toBe(1);
    expect(timerCallback).toBeDefined();
  });

  it("times out an adapter that ignores its signal and settles a completion race once", async () => {
    let timerCallback: (() => void) | undefined;
    let providerSignal: AbortSignal | undefined;
    const runtime = new Runtime({
      config,
      transport: { converse: async () => ({ model: config.model, content: [] }) },
      streamTransport: {
        converseStream: async (request) => {
          providerSignal = request.signal;
          return new Promise(() => {});
        },
      },
      timers: {
        setTimeout: (callback) => {
          timerCallback = callback;
          return 1;
        },
        clearTimeout: () => {},
      },
    });
    const promise = runtime.execute({ mode: "stream", messages });
    await Promise.resolve();
    timerCallback?.();
    await expect(promise).rejects.toBeInstanceOf(RuntimeTimeoutError);
    expect(providerSignal?.aborted).toBe(true);
  });

  it("keeps the first completion when timeout fires late", async () => {
    let timerCallback: (() => void) | undefined;
    let clearCount = 0;
    async function* complete(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: "complete" };
    }
    const runtime = new Runtime({
      config,
      transport: { converse: async () => ({ model: config.model, content: [] }) },
      streamTransport: { converseStream: async () => ({ stream: complete() }) },
      timers: {
        setTimeout: (callback) => {
          timerCallback = callback;
          return 1;
        },
        clearTimeout: () => {
          clearCount += 1;
        },
      },
    });
    const promise = runtime.execute({ mode: "stream", messages });
    await expect(promise).resolves.toMatchObject({ mode: "stream", text: "" });
    timerCallback?.();
    await expect(promise).resolves.toMatchObject({ mode: "stream" });
    expect(clearCount).toBe(1);
  });

  it("keeps timeout when a deferred provider completes later", async () => {
    let timerCallback: (() => void) | undefined;
    let lateComplete: (() => void) | undefined;
    let nextStartedResolve = () => {};
    const nextStarted = new Promise<void>((resolve) => {
      nextStartedResolve = resolve;
    });
    const stream: AsyncIterable<RuntimeStreamEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<RuntimeStreamEvent>>((resolve) => {
              nextStartedResolve();
              lateComplete = () => resolve({ done: false, value: { type: "complete" } });
            }),
          return: async () => ({ done: true, value: undefined }),
        };
      },
    };
    const runtime = new Runtime({
      config,
      transport: { converse: async () => ({ model: config.model, content: [] }) },
      streamTransport: { converseStream: async () => ({ stream }) },
      timers: {
        setTimeout: (callback) => {
          timerCallback = callback;
          return 1;
        },
        clearTimeout: () => {},
      },
    });
    const promise = runtime.execute({ mode: "stream", messages });
    await nextStarted;
    expect(timerCallback).toBeDefined();
    if (timerCallback === undefined) throw new Error("timer was not installed");
    timerCallback();
    await expect(promise).rejects.toBeInstanceOf(RuntimeTimeoutError);
    expect(lateComplete).toBeDefined();
    if (lateComplete === undefined) throw new Error("stream next was not deferred");
    lateComplete();
    await Promise.resolve();
    await expect(promise).rejects.toBeInstanceOf(RuntimeTimeoutError);
  });
});
