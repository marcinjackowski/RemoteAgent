import { describe, expect, it } from "vitest";

import {
  AwsBedrockStreamTransport,
  TransportError,
  converseStream,
  createRuntimeConfig,
} from "../src/index.js";

const config = createRuntimeConfig({
  model: { provider: "aws", model_id: "model-a" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
});
const request = {
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
};

function transportFor(events: AsyncIterable<unknown>, requestId = "req-1") {
  return new AwsBedrockStreamTransport({
    client: {
      send: async () => ({ stream: events, $metadata: { requestId } }),
    },
  });
}

async function* eventsOf(events: readonly unknown[]) {
  yield* events;
}

describe("converseStream", () => {
  it("assembles deltas and preserves identity, request ID, and usage after messageStop", async () => {
    const transport = transportFor(
      eventsOf([
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hel" } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, metrics: {} } },
      ]),
    );

    await expect(converseStream(transport, config, request)).resolves.toEqual({
      text: "hello",
      model: config.model,
      requestId: "req-1",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
  });

  it.each([
    ["EOF", []],
    ["provider error", [{ validationException: { message: "invalid" } }]],
  ])("rejects partial output on %s", async (_name, streamEvents) => {
    const transport = transportFor(
      eventsOf([
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
        ...streamEvents,
      ]),
    );

    await expect(converseStream(transport, config, request)).rejects.toBeInstanceOf(TransportError);
  });
});
