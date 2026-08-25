import { describe, expect, it } from "vitest";
import {
  Runtime,
  createRuntimeConfig,
  type RuntimeResponse,
  type RuntimeStreamEvent,
  type RuntimeStreamTransport,
  type RuntimeTransport,
} from "../src/index.js";

const config = createRuntimeConfig({
  model: { provider: "contract", model_id: "model-v1" },
  timeoutMs: 100,
  toolLimits: { maxIterations: 1, maxCalls: 1 },
  retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
});
const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }];
const completion = {
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
const response: RuntimeResponse = {
  model: config.model,
  content: [{ type: "json", value: completion }],
  usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
  requestId: "request-1",
};

async function* events(): AsyncIterable<RuntimeStreamEvent> {
  yield { type: "text", text: "hello" };
  yield { type: "metadata", usage: response.usage };
  yield { type: "complete" };
}

describe("Runtime public contract", () => {
  it("returns common metadata for text, stream, and structured modes", async () => {
    const transport: RuntimeTransport = { converse: async () => response };
    const streamTransport: RuntimeStreamTransport = {
      converseStream: async () => ({ stream: events(), requestId: "request-1" }),
    };
    const runtime = new Runtime({
      config,
      transport,
      streamTransport,
      now: () => 0,
    });

    const results = await Promise.all([
      runtime.execute({ mode: "text", messages }),
      runtime.execute({ mode: "stream", messages }),
      runtime.execute({ mode: "structured", messages }),
    ]);

    for (const result of results) {
      expect(result.model).toEqual(config.model);
      expect(result.usage).toEqual(response.usage);
      expect(result.requestId).toBe("request-1");
      expect(result.latencyMs).toBe(0);
      expect(result.transportAttempts).toBe(1);
      expect(result.modelCompletions).toHaveLength(1);
      expect(result.modelCompletions[0]).toEqual({
        model: config.model,
        usage: response.usage,
        requestId: "request-1",
        transportAttempts: 1,
      });
      const traceKeys = Object.keys(result.modelCompletions[0] ?? {});
      expect(traceKeys).not.toContain("messages");
      expect(traceKeys).not.toContain("content");
      expect(traceKeys).not.toContain("input");
      expect(traceKeys).not.toContain("tools");
    }
    expect(results[0]).toMatchObject({ mode: "text", text: "" });
    expect(results[1]).toMatchObject({ mode: "stream", text: "hello" });
    expect(results[2]).toMatchObject({
      mode: "structured",
      repaired: false,
      completion: {
        schema_version: 1,
        run_id: "run",
        case_id: "case",
        status: "COMPLETED",
      },
    });
    expect(results[2]).not.toHaveProperty("value");
  });
});
