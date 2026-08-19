import { describe, expect, it, vi } from "vitest";

import { RuntimeCancelledError, converseStream, createRuntimeConfig } from "../src/index.js";
import type { RuntimeStreamTransport } from "../src/stream.js";

const config = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
});
const request = {
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function transportWithNext(
  next: Promise<IteratorResult<{ type: "text" | "complete"; text?: string }>>,
  nextCalled: { resolve: () => void },
  returned: { count: number; resolve: () => void },
): RuntimeStreamTransport {
  return {
    converseStream: async () => ({
      stream: {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              nextCalled.resolve();
              return next;
            },
            return: async () => {
              returned.count += 1;
              returned.resolve();
              return { done: true, value: undefined };
            },
          };
        },
      },
    }),
  };
}

describe("converseStream cancellation", () => {
  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport: RuntimeStreamTransport = { converseStream: vi.fn() };
    await expect(
      converseStream(transport, config, { ...request, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(transport.converseStream).not.toHaveBeenCalled();
  });

  it("cancels a pending stream and removes its listener", async () => {
    const controller = new AbortController();
    const gate = deferred<IteratorResult<{ type: "text" | "complete"; text?: string }>>();
    const nextCalled = deferred<void>();
    const returned = { ...deferred<void>(), count: 0 };
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = converseStream(transportWithNext(gate.promise, nextCalled, returned), config, {
      ...request,
      signal: controller.signal,
    });
    await nextCalled.promise;
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(RuntimeCancelledError);
    await returned.promise;
    expect(returned.count).toBe(1);
    expect(remove).toHaveBeenCalledTimes(2);
    gate.resolve({ done: true, value: undefined });
  });

  it("gives completion precedence when completion and cancellation are triggered together", async () => {
    const controller = new AbortController();
    const gate = deferred<IteratorResult<{ type: "text" | "complete"; text?: string }>>();
    const nextCalled = deferred<void>();
    const returned = { ...deferred<void>(), count: 0 };
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = converseStream(transportWithNext(gate.promise, nextCalled, returned), config, {
      ...request,
      signal: controller.signal,
    });
    await nextCalled.promise;
    let settlements = 0;
    const observed = result.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    gate.resolve({ done: false, value: { type: "complete" } });
    controller.abort();
    await expect(result).resolves.toMatchObject({ text: "", model: config.model });
    await observed;
    expect(settlements).toBe(1);
    expect(returned.count).toBe(0);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("cancels transport acquisition even when the transport ignores the signal", async () => {
    const controller = new AbortController();
    const gate = deferred<never>();
    const transport: RuntimeStreamTransport = { converseStream: vi.fn(() => gate.promise) };
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = converseStream(transport, config, { ...request, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(remove).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
  });
});
