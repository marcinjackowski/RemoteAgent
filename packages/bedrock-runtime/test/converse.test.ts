import { describe, expect, it } from "vitest";

import { converseText, createRuntimeConfig, FakeTransport } from "../src/index.js";

const config = createRuntimeConfig({
  model: { provider: "test-provider", model_id: "test-model" },
  timeoutMs: 5_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
});

describe("converseText", () => {
  it("forwards the complete history and preserves response metadata", async () => {
    const transport = new FakeTransport([
      {
        model: { provider: "test-provider", model_id: "response-model" },
        content: [{ type: "text", text: "answer" }],
        requestId: "request-123",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      },
    ]);
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "earlier" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "latest" }] },
    ];

    const result = await converseText(transport, config, { messages });

    expect(result).toEqual({
      text: "answer",
      model: { provider: "test-provider", model_id: "response-model" },
      content: [{ type: "text", text: "answer" }],
      requestId: "request-123",
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.messages).toEqual(messages);
  });

  it("serves scripted responses in order and fails when exhausted", async () => {
    const transport = new FakeTransport([
      { model: config.model, content: [{ type: "text", text: "one" }] },
      { model: config.model, content: [{ type: "text", text: "two" }] },
    ]);
    const request = {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }],
    };

    await expect(converseText(transport, config, request)).resolves.toMatchObject({ text: "one" });
    await expect(converseText(transport, config, request)).resolves.toMatchObject({ text: "two" });
    await expect(converseText(transport, config, request)).rejects.toThrow("script is exhausted");
    expect(transport.getRequests()).toHaveLength(3);
  });
});
