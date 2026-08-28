import type { NormalizedSubscriptionModelEvent } from "@remoteagent/model-runtime";
import { describe, expect, it } from "vitest";

import { createClaudeResponseContract, parseClaudeStreamJsonTranscript } from "../src/index.js";

const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const model = "claude-opus-4-8";
const version = "2.1.248";
const cwd = "/private/tmp/remoteagent-claude/invocation-1";
const contract = createClaudeResponseContract({
  messages: [],
  outputSchema: { name: "AnswerV1", schema: { type: "object" } },
});
const toolContract = createClaudeResponseContract({
  messages: [],
  outputSchema: { name: "AnswerV1", schema: { type: "object" } },
  tools: [
    {
      name: "files.read",
      inputSchema: {
        type: "object",
        properties: { relative_path: { type: "string" } },
        required: ["relative_path"],
        additionalProperties: false,
      },
    },
  ],
});

function envelope(
  final: unknown = { ok: true },
  schemaDigest = contract.schemaDigest,
  kind: "json" | "tool_use" = "json",
  toolCall: unknown = null,
) {
  return {
    schema_version: 1,
    schema_digest: schemaDigest,
    kind,
    final,
    tool_call: toolCall,
  };
}

function init(overrides: Record<string, unknown> = {}) {
  return {
    type: "system",
    subtype: "init",
    uuid: "init-1",
    session_id: sessionId,
    apiKeySource: "none",
    claude_code_version: version,
    cwd,
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: "plan",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    capabilities: ["future-capability"],
    ...overrides,
  };
}

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: "assistant-1",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { model, content: [{ type: "text", text: "private prose" }] },
    ...overrides,
  };
}

function result(structuredOutput: unknown = envelope(), overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    uuid: "result-1",
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "private final prose",
    usage: { input_tokens: 17, output_tokens: 5 },
    modelUsage: {
      [model]: {
        inputTokens: 17,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 200000,
        maxOutputTokens: 32000,
        canonicalModel: model,
        provider: "firstParty",
      },
    },
    permission_denials: [],
    structured_output: structuredOutput,
    terminal_reason: "completed",
    ...overrides,
  };
}

function transcript(events: unknown[] = [init(), assistant(), result()]): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function parse(
  stdout: string,
  exactContract = contract,
  events?: NormalizedSubscriptionModelEvent[],
) {
  return parseClaudeStreamJsonTranscript({
    stdout,
    contract: exactContract,
    expectedSessionId: sessionId,
    expectedModel: model,
    expectedClientVersion: version,
    expectedCwd: cwd,
    ...(events === undefined ? {} : { onEvent: (event) => events.push(event) }),
  });
}

describe("Claude stream-JSON transcript", () => {
  it("binds the declared tool surface into the structured response digest", () => {
    const changedToolContract = createClaudeResponseContract({
      messages: [],
      outputSchema: { name: "AnswerV1", schema: { type: "object" } },
      tools: [
        {
          name: "files.list",
          inputSchema: {
            type: "object",
            properties: { relative_path: { type: "string" } },
            required: ["relative_path"],
            additionalProperties: false,
          },
        },
      ],
    });
    expect(changedToolContract.schemaDigest).not.toBe(toolContract.schemaDigest);
  });

  it("binds isolated init, session/model, structured result and provider usage without retaining prose", () => {
    const events: NormalizedSubscriptionModelEvent[] = [];
    const parsed = parse(transcript(), contract, events);
    expect(parsed).toEqual({
      sessionId,
      content: [{ type: "json", value: { ok: true } }],
      usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 },
    });
    expect(events).toEqual([
      {
        event: "MODEL_SESSION_STARTED",
        sequence: 1,
        provider: "claude_code",
        session_id: sessionId,
      },
      {
        event: "MODEL_TURN_FINISHED",
        sequence: 2,
        provider: "claude_code",
        session_id: sessionId,
        outcome: "SUCCEEDED",
        usage: {
          input_tokens: 17,
          output_tokens: 5,
          total_tokens: 22,
          provider_reported: true,
        },
      },
    ]);
    expect(JSON.stringify({ parsed, events })).not.toMatch(/private prose|private final prose/u);
  });

  it.each([
    ["foreign session", transcript([init({ session_id: "foreign" }), result()])],
    ["foreign client", transcript([init({ claude_code_version: "2.1.250" }), result()])],
    ["foreign cwd", transcript([init({ cwd: "/tmp/foreign" }), result()])],
    ["model fallback", transcript([init({ model: "claude-sonnet" }), result()])],
    ["API key", transcript([init({ apiKeySource: "ANTHROPIC_API_KEY" }), result()])],
    ["built-in tool advertised", transcript([init({ tools: ["Read"] }), result()])],
    [
      "MCP loaded",
      transcript([init({ mcp_servers: [{ name: "foreign", status: "connected" }] }), result()]),
    ],
    [
      "plugin loaded",
      transcript([init({ plugins: [{ name: "foreign", path: "/tmp/plugin" }] }), result()]),
    ],
    ["skill loaded", transcript([init({ skills: ["foreign"] }), result()])],
    ["slash command loaded", transcript([init({ slash_commands: ["foreign"] }), result()])],
    ["permission widened", transcript([init({ permissionMode: "bypassPermissions" }), result()])],
    ["forged result session", transcript([init(), result(envelope(), { session_id: "foreign" })])],
    [
      "forged model usage",
      transcript([
        init(),
        result(envelope(), {
          modelUsage: {
            [model]: {
              inputTokens: 1,
              outputTokens: 1,
              canonicalModel: model,
              provider: "bedrock",
            },
          },
        }),
      ]),
    ],
    [
      "permission denial",
      transcript([init(), result(envelope(), { permission_denials: [{ tool_name: "Read" }] })]),
    ],
    [
      "deferred tool",
      transcript([
        init(),
        result(envelope(), { deferred_tool_use: { id: "x", name: "Read", input: {} } }),
      ]),
    ],
    [
      "foreign schema digest",
      transcript([init(), result(envelope({ ok: true }, "sha256:foreign"))]),
    ],
    ["post-terminal event", transcript([init(), result(), assistant()])],
    ["missing result", transcript([init(), assistant()])],
    ["malformed JSON", "{\n"],
  ])("rejects %s without partial success", (_name, stdout) => {
    expect(() => parse(stdout)).toThrowError(
      expect.objectContaining({ outcome: "MALFORMED_OUTPUT" }),
    );
  });

  it("rejects a built-in tool-use block even though assistant prose is otherwise discarded", () => {
    expect(() =>
      parse(
        transcript([
          init(),
          assistant({
            message: { model, content: [{ type: "tool_use", name: "Read", input: {} }] },
          }),
          result(),
        ]),
      ),
    ).toThrowError(expect.objectContaining({ outcome: "TOOL_BOUNDARY_VIOLATION" }));
  });

  it.each([
    ["authentication_failed", "AUTH_FAILED"],
    ["rate_limit", "QUOTA_OR_PROVIDER_FAILED"],
    ["overloaded", "QUOTA_OR_PROVIDER_FAILED"],
    ["server_error", "PROVIDER_FAILED"],
  ] as const)("maps typed retry %s to content-free refusal", (error, outcome) => {
    const events: NormalizedSubscriptionModelEvent[] = [];
    expect(() =>
      parse(
        transcript([
          init(),
          { type: "system", subtype: "api_retry", uuid: "retry-1", session_id: sessionId, error },
          result(),
        ]),
        contract,
        events,
      ),
    ).toThrowError(expect.objectContaining({ outcome }));
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("maps a terminal provider error without parsing its prose", () => {
    const events: NormalizedSubscriptionModelEvent[] = [];
    expect(() =>
      parse(
        transcript([
          init(),
          result(undefined, {
            subtype: "error_during_execution",
            is_error: true,
            errors: ["credential or quota prose"],
            structured_output: undefined,
          }),
        ]),
        contract,
        events,
      ),
    ).toThrowError(expect.objectContaining({ outcome: "PROVIDER_FAILED" }));
    expect(JSON.stringify(events)).not.toContain("credential or quota prose");
  });

  it("returns one declared tool proposal as data and refuses a foreign tool name", () => {
    const proposal = envelope(null, toolContract.schemaDigest, "tool_use", {
      id: "call-1",
      name: "files.read",
      input: { relative_path: "src/feature.ts" },
    });
    expect(parse(transcript([init(), result(proposal)]), toolContract).content).toEqual([
      {
        type: "tool-use",
        id: "call-1",
        name: "files.read",
        input: { relative_path: "src/feature.ts" },
      },
    ]);
    const foreign = envelope(null, toolContract.schemaDigest, "tool_use", {
      id: "call-1",
      name: "command",
      input: {},
    });
    expect(() => parse(transcript([init(), result(foreign)]), toolContract)).toThrowError(
      expect.objectContaining({ outcome: "TOOL_BOUNDARY_VIOLATION" }),
    );
  });

  it("bounds provider-controlled nesting", () => {
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    expect(() => parse(transcript([init(), result(envelope(nested))]))).toThrowError(
      expect.objectContaining({ outcome: "MALFORMED_OUTPUT" }),
    );
  });
});
