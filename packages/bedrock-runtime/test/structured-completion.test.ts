import { describe, expect, it } from "vitest";

import {
  StructuredCompletionError,
  TransportError,
  createRuntimeConfig,
  runStructuredCompletion,
  type RuntimeConfig,
  type RuntimeJsonValue,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeTransport,
} from "../src/index.js";

const config: RuntimeConfig = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 1000,
  toolLimits: { maxIterations: 2, maxCalls: 2 },
});
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

class ScriptTransport implements RuntimeTransport {
  readonly requests: RuntimeRequest[] = [];
  private index = 0;

  constructor(private readonly responses: readonly RuntimeResponse[]) {}

  async converse(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.requests.push(request);
    const response = this.responses[this.index++];
    if (response === undefined) throw new Error("script exhausted");
    return response;
  }
}

const response = (value: RuntimeJsonValue, requestId = "request"): RuntimeResponse => ({
  model: config.model,
  content: [{ type: "json", value }],
  requestId,
  usage: { totalTokens: 1 },
});
const textResponse = (text: string, requestId = "request"): RuntimeResponse => ({
  model: config.model,
  content: [{ type: "text", text }],
  requestId,
  usage: { totalTokens: 1 },
});

describe("runStructuredCompletion", () => {
  it("retries repair without repeating a tool executor", async () => {
    const repairConfig = createRuntimeConfig({
      model: config.model,
      timeoutMs: 1000,
      toolLimits: config.toolLimits,
      retryPolicy: { maxAttempts: 2, baseDelayMs: 5 },
    });
    const invalid = response({ invalid: true }, "bad");
    let calls = 0;
    let repairAttempts = 0;
    const requests: RuntimeRequest[] = [];
    const transport: RuntimeTransport = {
      converse: async (request) => {
        requests.push(request);
        calls += 1;
        if (calls === 1)
          return {
            model: config.model,
            content: [{ type: "tool-use" as const, id: "u1", name: "lookup", input: {} }],
          };
        if (calls === 2) return invalid;
        repairAttempts += 1;
        if (repairAttempts === 1) throw new TransportError("transient", "TRANSIENT");
        return response(completion, "repair");
      },
    };
    let executions = 0;
    const delays: number[] = [];
    const result = await runStructuredCompletion(transport, repairConfig, {
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { found: true };
      },
      execution: {
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    });
    expect(executions).toBe(1);
    expect(calls).toBe(4);
    expect(delays).toEqual([5]);
    expect(result).toMatchObject({ repaired: true, requestId: "repair" });
    expect(result.transportCalls).toBe(4);
    expect(requests[2]?.tools).toBeUndefined();
    expect(requests[3]?.tools).toBeUndefined();
    expect(requests[2]?.outputSchema).toEqual(requests[3]?.outputSchema);
    expect(requests[2]?.messages).toEqual(requests[3]?.messages);
  });

  it("returns a valid completion without repair", async () => {
    const transport = new ScriptTransport([response(completion)]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.completion.status).toBe("COMPLETED");
    expect(result.repaired).toBe(false);
    expect(transport.requests).toHaveLength(1);
  });

  it("accepts exactly one text JSON object", async () => {
    const transport = new ScriptTransport([textResponse(JSON.stringify(completion))]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.repaired).toBe(false);
  });

  it("requires an executor when tools are configured", async () => {
    const transport = new ScriptTransport([]);
    await expect(
      runStructuredCompletion(transport, config, {
        messages: [],
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      }),
    ).rejects.toThrow("Tool executor is required");
    expect(transport.requests).toHaveLength(0);
  });

  it("repairs once and lets repair metadata win", async () => {
    const transport = new ScriptTransport([
      response({ raw: "invalid-canary" }, "bad"),
      response(completion, "repair"),
    ]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.repaired).toBe(true);
    expect(result.requestId).toBe("repair");
    expect(transport.requests[1]?.tools).toBeUndefined();
    expect(transport.requests[1]?.messages.at(-1)?.role).toBe("user");
  });

  it("executes a tool once and repairs using the complete history without tools", async () => {
    const invalidAssistant = {
      role: "assistant" as const,
      content: [{ type: "json" as const, value: { invalid: true } }],
    };
    const transport = new ScriptTransport([
      {
        model: config.model,
        content: [{ type: "tool-use", id: "u1", name: "lookup", input: {} }],
      },
      { model: config.model, content: invalidAssistant.content, requestId: "bad" },
      { ...response(completion, "repair"), usage: { totalTokens: 9 } },
    ]);
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "go" }] }];
    let executions = 0;
    const result = await runStructuredCompletion(transport, config, {
      messages,
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return { found: true };
      },
    });
    expect(executions).toBe(1);
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests[2]?.tools).toBeUndefined();
    expect(transport.requests[2]?.outputSchema).toBeDefined();
    const accumulatedHistory = transport.requests[1]?.messages;
    expect(accumulatedHistory).toBeDefined();
    expect(transport.requests[2]?.messages).toEqual([
      ...(accumulatedHistory ?? []),
      invalidAssistant,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Return only one valid JSON object matching the AgentCompletion schema.",
          },
        ],
      },
    ]);
    expect(result.requestId).toBe("repair");
    expect(result.usage?.totalTokens).toBe(9);
    expect(result.transportCalls).toBe(3);
    expect(result.toolCalls).toBe(1);
  });

  it("repairs mixed content exactly once", async () => {
    const transport = new ScriptTransport([
      {
        model: config.model,
        content: [
          { type: "text", text: JSON.stringify(completion) },
          { type: "text", text: "extra" },
        ],
      },
      response(completion, "repair"),
    ]);
    const result = await runStructuredCompletion(transport, config, { messages: [] });
    expect(result.repaired).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });

  it("throws a sanitized error after exactly one failed repair", async () => {
    const transport = new ScriptTransport([
      response({ raw: "secret-canary" }),
      response({ raw: "secret-canary" }),
    ]);
    const error = await runStructuredCompletion(transport, config, { messages: [] }).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(StructuredCompletionError);
    expect(String(error)).not.toContain("secret-canary");
    expect(transport.requests).toHaveLength(2);
  });
});
