import { describe, expect, it } from "vitest";

import {
  RuntimeCancelledError,
  RuntimeTimeoutError,
  TransportError,
  createRuntimeConfig,
} from "../src/index.js";
import { executeTransport } from "../src/retry.js";

const config = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 10,
  toolLimits: { maxIterations: 1, maxCalls: 1 },
  retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
});

describe("transport execution limits", () => {
  it.each(["success", "fatal", "timeout", "cancel"] as const)(
    "cleans timer and upstream listener exactly once on %s",
    async (outcome) => {
      let timerCallback: (() => void) | undefined;
      let clearCount = 0;
      let removeCount = 0;
      let abortListener: (() => void) | undefined;
      const signal = {
        aborted: false,
        addEventListener: (_type: string, listener: () => void) => {
          abortListener = listener;
        },
        removeEventListener: () => {
          removeCount += 1;
        },
      } as unknown as AbortSignal;
      const promise = executeTransport(
        {
          converse: async () => {
            if (outcome === "fatal") throw new Error("fatal");
            return { model: config.model, content: [] };
          },
        },
        config,
        { messages: [], signal },
        {
          setTimeout: (callback) => {
            timerCallback = callback;
            return 1;
          },
          clearTimeout: () => {
            clearCount += 1;
          },
        },
      );
      if (outcome === "timeout") timerCallback?.();
      if (outcome === "cancel") abortListener?.();
      if (outcome === "success") await expect(promise).resolves.toBeDefined();
      else await expect(promise).rejects.toBeDefined();
      expect(clearCount).toBe(1);
      expect(removeCount).toBe(1);
    },
  );

  it("returns typed timeout when transport ignores abort", async () => {
    let timeout: (() => void) | undefined;
    let transportSignal: AbortSignal | undefined;
    const promise = executeTransport(
      {
        converse: async (request) => {
          transportSignal = request.signal;
          return new Promise(() => {});
        },
      },
      config,
      { messages: [] },
      {
        setTimeout: (callback) => {
          timeout = callback;
          return 1;
        },
        clearTimeout: () => {},
      },
    );
    timeout?.();
    await expect(promise).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(promise).rejects.toBeInstanceOf(RuntimeTimeoutError);
    expect(transportSignal?.aborted).toBe(true);
  });

  it("returns typed cancellation before transport starts", async () => {
    const controller = new AbortController();
    let transportCalls = 0;
    controller.abort();
    await expect(
      executeTransport(
        {
          converse: async () => {
            transportCalls += 1;
            throw new Error("must not run");
          },
        },
        config,
        { messages: [], signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(transportCalls).toBe(0);
  });

  it("aborts the transport signal when upstream cancellation wins", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const promise = executeTransport(
      {
        converse: async (request) => {
          transportSignal = request.signal;
          return new Promise(() => {});
        },
      },
      config,
      { messages: [], signal: controller.signal },
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(transportSignal?.aborted).toBe(true);
  });

  it("times out during injected backoff without starting another attempt", async () => {
    let timerCallback: (() => void) | undefined;
    let attempts = 0;
    const promise = executeTransport(
      {
        converse: async () => {
          attempts += 1;
          throw new TransportError("retry", "TRANSIENT");
        },
      },
      config,
      { messages: [] },
      {
        setTimeout: (callback) => {
          timerCallback = callback;
          return 1;
        },
        clearTimeout: () => {},
        sleep: async () => new Promise<void>(() => {}),
      },
    );
    await Promise.resolve();
    timerCallback?.();
    await expect(promise).rejects.toBeInstanceOf(RuntimeTimeoutError);
    expect(attempts).toBe(1);
  });

  it("settles once when timeout wins over a late transport completion", async () => {
    let timeout: (() => void) | undefined;
    let complete: (() => void) | undefined;
    let clearCount = 0;
    let settlements = 0;
    const promise = executeTransport(
      {
        converse: async () =>
          new Promise((resolve) => {
            complete = () => resolve({ model: config.model, content: [] });
          }),
      },
      config,
      { messages: [] },
      {
        setTimeout: (callback) => {
          timeout = callback;
          return 1;
        },
        clearTimeout: () => {
          clearCount += 1;
        },
      },
    );
    const observed = promise.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    timeout?.();
    complete?.();
    await observed;
    expect(settlements).toBe(1);
    expect(clearCount).toBe(1);
  });

  it("settles once when completion wins over a late timeout", async () => {
    let timeout: (() => void) | undefined;
    let complete: (() => void) | undefined;
    let clearCount = 0;
    let settlements = 0;
    const promise = executeTransport(
      {
        converse: async () =>
          new Promise((resolve) => {
            complete = () => resolve({ model: config.model, content: [] });
          }),
      },
      config,
      { messages: [] },
      {
        setTimeout: (callback) => {
          timeout = callback;
          return 1;
        },
        clearTimeout: () => {
          clearCount += 1;
        },
      },
    );
    const observed = promise.then(
      () => {
        settlements += 1;
      },
      () => {
        settlements += 1;
      },
    );
    await Promise.resolve();
    complete?.();
    await observed;
    timeout?.();
    expect(settlements).toBe(1);
    expect(clearCount).toBe(1);
  });
});
