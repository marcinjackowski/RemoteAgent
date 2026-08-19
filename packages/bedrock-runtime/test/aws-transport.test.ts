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

    expect(input).toMatchObject({
      toolConfig: { tools: [{ toolSpec: { name: "lookup" } }] },
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: {
              name: "answer",
              description: "The answer payload",
              schema: '{"properties":{"answer":{"type":"string"}},"type":"object"}',
            },
          },
        },
      },
    });
  });

  it("serializes semantically identical schemas canonically", async () => {
    const inputs: Record<string, unknown>[] = [];
    const transport = new AwsBedrockTransport({
      client: {
        send: async (command) => {
          inputs.push(command.input);
          return {
            output: { message: { role: "assistant", content: [{ text: "ok" }] } },
            $metadata: {},
          };
        },
      },
    });
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];

    await transport.converse(
      {
        messages,
        outputSchema: { name: "answer", schema: { b: 2, a: [3, { d: 4, c: 5 }] } },
      },
      config,
    );
    await transport.converse(
      {
        messages,
        outputSchema: { name: "answer", schema: { a: [3, { c: 5, d: 4 }], b: 2 } },
      },
      config,
    );

    expect(inputs[0]).toMatchObject({
      outputConfig: {
        textFormat: {
          structure: {
            jsonSchema: {
              schema: '{"a":[3,{"c":5,"d":4}],"b":2}',
            },
          },
        },
      },
    });
    expect(inputs[1]).toEqual(inputs[0]);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite schema numbers before sending (%s)",
    async (value) => {
      let sends = 0;
      const transport = new AwsBedrockTransport({
        client: {
          send: async () => {
            sends += 1;
            return {
              output: { message: { role: "assistant", content: [{ text: "ok" }] } },
              $metadata: {},
            };
          },
        },
      });

      await expect(
        transport.converse(
          {
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
            outputSchema: { name: "answer", schema: { value } },
          },
          config,
        ),
      ).rejects.toThrow("Unsupported non-finite JSON schema number");
      expect(sends).toBe(0);
    },
  );
});
