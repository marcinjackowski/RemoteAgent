import { describe, expect, it } from "vitest";

import {
  RuntimeCancelledError,
  RuntimeTimeoutError,
  TransportError,
  createRuntimeConfig,
} from "../src/index.js";
import { classifyTransportFailure, executeTransport } from "../src/retry.js";

describe("classifyTransportFailure", () => {
  it.each([
    [{ name: "ThrottlingException" }, "THROTTLING"],
    [{ code: "TooManyRequestsException" }, "THROTTLING"],
    [{ name: "ServiceError", statusCode: 429 }, "THROTTLING"],
    [{ name: "InternalServerException" }, "TRANSIENT"],
    [{ code: "ETIMEDOUT" }, "TRANSIENT"],
    [{ name: "ModelTimeoutException" }, "TRANSIENT"],
    [{ $metadata: { httpStatusCode: 503 } }, "TRANSIENT"],
    [{ statusCode: 408 }, "TRANSIENT"],
    [{ name: "AbortError" }, "CANCELLED"],
    [{ code: "CancelledError" }, "CANCELLED"],
    [{ name: "Error", code: "ETIMEDOUT" }, "TRANSIENT"],
    [{ name: "Error", code: "AbortError" }, "CANCELLED"],
    [{ statusCode: "not-a-status", httpStatusCode: 503 }, "TRANSIENT"],
    [{ name: "ValidationException", statusCode: 400 }, "FATAL"],
    [{ name: "ValidationException", message: "throttling" }, "FATAL"],
  ] as const)("classifies %j as %s", (error, kind) => {
    expect(classifyTransportFailure(error)).toBe(kind);
  });

  it("uses the AWS retryable trait without inspecting message text", () => {
    expect(classifyTransportFailure({ $retryable: {} })).toBe("TRANSIENT");
    expect(classifyTransportFailure({ $retryable: { throttling: true } })).toBe("THROTTLING");
    expect(classifyTransportFailure({ retryable: true, message: "fatal" })).toBe("TRANSIENT");
  });
});

describe("executeTransport", () => {
  const config = (maxAttempts = 3, baseDelayMs = 10) =>
    createRuntimeConfig({
      model: { provider: "test", model_id: "model" },
      timeoutMs: 100,
      toolLimits: { maxIterations: 1, maxCalls: 1 },
      retryPolicy: { maxAttempts, baseDelayMs },
    });
  const response = { model: config().model, content: [{ type: "text" as const, text: "ok" }] };

  it("retries only retryable transport errors with exponential delays", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await executeTransport(
      {
        converse: async () => {
          attempts += 1;
          if (attempts < 3) throw new TransportError("retry", "TRANSIENT");
          return response;
        },
      },
      config(),
      { messages: [] },
      {
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );
    expect(result).toBe(response);
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("does not retry fatal errors and respects maximum attempts", async () => {
    let fatalAttempts = 0;
    await expect(
      executeTransport(
        {
          converse: async () => {
            fatalAttempts += 1;
            throw new TransportError("fatal", "FATAL");
          },
        },
        config(),
        { messages: [] },
      ),
    ).rejects.toMatchObject({ code: "TRANSPORT_ERROR", retryable: false });
    expect(fatalAttempts).toBe(1);

    let retryAttempts = 0;
    await expect(
      executeTransport(
        {
          converse: async () => {
            retryAttempts += 1;
            throw new TransportError("retry", "THROTTLING");
          },
        },
        config(2, 0),
        { messages: [] },
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ code: "TRANSPORT_ERROR", retryable: true });
    expect(retryAttempts).toBe(2);
  });

  it("maps pre-abort to cancellation and timeout to a typed result", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeTransport({ converse: async () => response }, config(), {
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RuntimeCancelledError);

    let fire: (() => void) | undefined;
    const timeoutPromise = executeTransport(
      { converse: async () => new Promise(() => {}) },
      config(),
      { messages: [] },
      {
        setTimeout: (callback) => {
          fire = callback;
          return 1;
        },
        clearTimeout: () => {},
      },
    );
    fire?.();
    await expect(timeoutPromise).rejects.toBeInstanceOf(RuntimeTimeoutError);
  });
});
