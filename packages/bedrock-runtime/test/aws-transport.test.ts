import { describe, expect, it } from "vitest";

import { AwsBedrockTransport, RuntimeCancelledError, TransportError } from "../src/index.js";
import type { RuntimeConfig } from "../src/types.js";

const config: RuntimeConfig = {
  model: { provider: "aws-bedrock", model_id: "amazon.nova-lite-v1:0" },
  timeoutMs: 5_000,
  toolLimits: { maxIterations: 0, maxCalls: 0 },
  retryPolicy: { maxAttempts: 2, baseDelayMs: 100 },
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

  it.each([
    [{ name: "ThrottlingException", message: "canary" }, "THROTTLING", true],
    [{ $metadata: { httpStatusCode: 503 }, message: "canary" }, "TRANSIENT", true],
    [{ name: "ValidationException", message: "canary" }, "FATAL", false],
  ] as const)("maps SDK failure to %s", async (failure, kind, retryable) => {
    const transport = new AwsBedrockTransport({
      client: {
        send: async () => {
          throw failure;
        },
      },
    });
    const result = transport.converse(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      config,
    );
    await expect(result).rejects.toMatchObject({ kind, retryable });
    await expect(result).rejects.not.toThrow("canary");
  });

  it("maps an AWS cancellation to RuntimeCancelledError without details", async () => {
    const transport = new AwsBedrockTransport({
      client: {
        send: async () => {
          throw Object.assign(new Error("canary"), { name: "AbortError" });
        },
      },
    });
    await expect(
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        config,
      ),
    ).rejects.toBeInstanceOf(RuntimeCancelledError);
  });

  it("keeps TransportError retryability consistent with its kind", () => {
    expect(new TransportError("x", "THROTTLING")).toMatchObject({
      kind: "THROTTLING",
      retryable: true,
    });
    expect(new TransportError("x", "FATAL")).toMatchObject({ kind: "FATAL", retryable: false });
  });

  it("serializes provider-neutral JSON history for a structured repair turn", async () => {
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
      { messages: [{ role: "assistant", content: [{ type: "json", value: { ok: true } }] }] },
      config,
    );
    expect(input).toMatchObject({
      messages: [{ role: "assistant", content: [{ text: '{"ok":true}' }] }],
    });
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

  it("maps a named output schema alongside existing tool configuration", async () => {
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
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        outputSchema: {
          name: "answer",
          description: "The answer payload",
          schema: { type: "object", properties: { answer: { type: "string" } } },
        },
      },
      config,
    );

    // Structured output is a TOOL (verified: Bedrock rejects outputConfig), alongside other tools.
    expect(input).toMatchObject({
      toolConfig: {
        tools: [
          { toolSpec: { name: "lookup" } },
          {
            toolSpec: {
              name: "answer",
              description: "The answer payload",
              // The schema is wrapped under `output` because Bedrock requires a top-level object.
              inputSchema: {
                json: {
                  type: "object",
                  properties: {
                    output: { type: "object", properties: { answer: { type: "string" } } },
                  },
                  required: ["output"],
                },
              },
            },
          },
        ],
      },
    });
    // Other tools present → the output tool must NOT be forced (that would block them).
    expect(input).not.toHaveProperty("toolConfig.toolChoice");
    expect(input).not.toHaveProperty("outputConfig");
  });

  it("forces the output-schema tool when it is the only tool", async () => {
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
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        outputSchema: { name: "answer", schema: { type: "object" } },
      },
      config,
    );
    expect(input).toMatchObject({
      toolConfig: {
        tools: [{ toolSpec: { name: "answer", inputSchema: { json: { type: "object" } } } }],
        toolChoice: { tool: { name: "answer" } },
      },
    });
    expect(input).not.toHaveProperty("outputConfig");
  });

  it("surfaces the output tool's input as a json content block", async () => {
    const transport = new AwsBedrockTransport({
      client: {
        send: async () => ({
          output: {
            message: {
              role: "assistant",
              // The model returns the completion wrapped under `output`; the transport unwraps it.
              content: [
                {
                  toolUse: { toolUseId: "t1", name: "answer", input: { output: { answer: "hi" } } },
                },
              ],
            },
          },
          $metadata: {},
        }),
      },
    });
    const res = await transport.converse(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        outputSchema: { name: "answer", schema: { type: "object" } },
      },
      config,
    );
    expect(res.content).toEqual([{ type: "json", value: { answer: "hi" } }]);
  });

  it("keeps one forced output tool authoritative over companion model prose", async () => {
    const transport = new AwsBedrockTransport({
      client: {
        send: async () => ({
          output: {
            message: {
              role: "assistant",
              content: [
                { text: "Here is the requested result." },
                {
                  toolUse: { toolUseId: "t1", name: "answer", input: { output: { answer: "hi" } } },
                },
              ],
            },
          },
          $metadata: {},
        }),
      },
    });
    const res = await transport.converse(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        outputSchema: { name: "answer", schema: { type: "object" } },
      },
      config,
    );
    expect(res.content).toEqual([{ type: "json", value: { answer: "hi" } }]);
  });
});
