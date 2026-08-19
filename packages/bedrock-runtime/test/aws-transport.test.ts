import { describe, expect, it } from "vitest";

import { AwsBedrockTransport } from "../src/index.js";
import type { RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  model: { provider: "aws-bedrock", model_id: "amazon.nova-lite-v1:0" },
  timeoutMs: 5_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
};

describe("AwsBedrockTransport", () => {
  it("maps the complete text history and response metadata", async () => {
    const calls: Array<{ input: Record<string, unknown>; signal?: AbortSignal }> = [];
    const client = {
      send: async (
        command: { input: Record<string, unknown> },
        options?: { abortSignal?: AbortSignal },
      ) => {
        calls.push({
          input: command.input,
          ...(options?.abortSignal === undefined ? {} : { signal: options.abortSignal }),
        });
        return {
          output: { message: { role: "assistant", content: [{ text: "answer" }] } },
          usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
          $metadata: { requestId: "request-123" },
        };
      },
    };
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "earlier" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "latest" }] },
    ];

    const result = await new AwsBedrockTransport({ client }).converse({ messages }, config);

    expect(result).toEqual({
      model: config.model,
      content: [{ type: "text", text: "answer" }],
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      requestId: "request-123",
    });
    expect(calls[0]?.input).toEqual({
      modelId: config.model.model_id,
      messages: [
        { role: "user", content: [{ text: "first" }] },
        { role: "assistant", content: [{ text: "earlier" }] },
        { role: "user", content: [{ text: "latest" }] },
      ],
    });
  });

  it("does not expose credential canaries from SDK failures", async () => {
    const canary = "AKIA-CREDENTIAL-CANARY";
    const logs: unknown[] = [];
    const client = {
      send: async () => {
        throw new Error(`access key ${canary} rejected`);
      },
    };

    const transport = new AwsBedrockTransport({
      client,
      logger: { error: (metadata) => logs.push(metadata) },
    });
    const request = {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: canary }] }],
    };

    await expect(transport.converse(request, config)).rejects.toThrow(
      "Bedrock Converse request failed",
    );
    await expect(transport.converse(request, config)).rejects.not.toThrow(canary);
    expect(JSON.stringify(logs)).not.toContain(canary);
  });

  it("rejects unsupported content before sending", async () => {
    let sent = false;
    const transport = new AwsBedrockTransport({
      client: {
        send: async () => {
          sent = true;
          return {};
        },
      },
    });

    await expect(
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "json", value: { ok: true } }] }] },
        config,
      ),
    ).rejects.toThrow("Unsupported Bedrock content");
    expect(sent).toBe(false);
  });

  it("maps tool definitions, tool use responses, and tool results", async () => {
    const inputs: Record<string, unknown>[] = [];
    const transport = new AwsBedrockTransport({
      client: {
        send: async (command) => {
          inputs.push(command.input);
          return {
            output: {
              message: {
                role: "assistant",
                content: [{ toolUse: { toolUseId: "call-1", name: "lookup", input: { q: "x" } } }],
              },
            },
            $metadata: {},
          };
        },
      },
    });

    const result = await transport.converse(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-use", id: "call-0", name: "lookup", input: { q: "old" } }],
          },
          { role: "tool", content: [{ type: "tool-result", id: "call-0", output: { value: 1 } }] },
        ],
        tools: [{ name: "lookup", description: "Find a value", inputSchema: { type: "object" } }],
      },
      config,
    );

    expect(inputs[0]).toMatchObject({
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "lookup",
              description: "Find a value",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
      messages: [
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "call-0", name: "lookup", input: { q: "old" } } }],
        },
        {
          role: "user",
          content: [{ toolResult: { toolUseId: "call-0", content: [{ json: { value: 1 } }] } }],
        },
      ],
    });
    expect(result.content).toEqual([
      { type: "tool-use", id: "call-1", name: "lookup", input: { q: "x" } },
    ]);
  });

  it("omits toolConfig when no tools are configured", async () => {
    let input: Record<string, unknown> | undefined;
    const transport = new AwsBedrockTransport({
      client: {
        send: async (command) => {
          input = command.input;
          return {
            output: { message: { role: "assistant", content: [{ text: "ok" }] } },
            $metadata: {},
          };
        },
      },
    });
    await transport.converse(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
      config,
    );
    expect(input).not.toHaveProperty("toolConfig");
  });
});
