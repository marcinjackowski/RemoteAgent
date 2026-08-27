import type { NormalizedSubscriptionModelEvent } from "@remoteagent/model-runtime";
import { describe, expect, it } from "vitest";

import { createCodexResponseContract, parseCodexJsonlTranscript } from "../src/index.js";

const output = { name: "AnswerV1", schema: { type: "object" } } as const;
const contract = createCodexResponseContract({
  messages: [],
  outputSchema: output,
});
const digest = contract.schemaDigest;
const toolContract = createCodexResponseContract({
  messages: [],
  outputSchema: output,
  tools: [
    {
      name: "files.read",
      description: "Read a bounded file",
      inputSchema: {
        type: "object",
        properties: { relative_path: { type: "string" } },
        required: ["relative_path"],
        additionalProperties: false,
      },
    },
  ],
});
const threadId = "0199a213-81c0-7800-8aa1-bbab2a035a53";

function finalText(value: unknown = { ok: true }, schemaDigest = digest): string {
  return JSON.stringify({
    schema_version: 1,
    schema_digest: schemaDigest,
    kind: "json",
    final: value,
    tool_call: null,
  });
}

function transcript(final = finalText()): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "reason-1", type: "reasoning", text: "private reasoning must disappear" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: final },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 80,
        cache_write_input_tokens: 2,
        output_tokens: 30,
        reasoning_output_tokens: 20,
      },
    }),
  ].join("\n");
}

function deeplyNestedFinal(): string {
  let value: unknown = "leaf";
  for (let depth = 0; depth < 70; depth += 1) value = { nested: value };
  return transcript(finalText(value));
}

describe("Codex JSONL transcript", () => {
  it("binds one session, one final response and provider-reported usage without retaining prose", () => {
    const events: NormalizedSubscriptionModelEvent[] = [];
    const parsed = parseCodexJsonlTranscript({
      stdout: `${transcript()}\n`,
      contract,
      onEvent: (event) => events.push(event),
    });
    expect(parsed).toEqual({
      sessionId: threadId,
      content: [{ type: "json", value: { ok: true } }],
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    });
    expect(events).toEqual([
      { event: "MODEL_SESSION_STARTED", sequence: 1, provider: "codex_cli", session_id: threadId },
      {
        event: "MODEL_TURN_FINISHED",
        sequence: 2,
        provider: "codex_cli",
        session_id: threadId,
        outcome: "SUCCEEDED",
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          provider_reported: true,
        },
      },
    ]);
    expect(JSON.stringify({ parsed, events })).not.toContain("private reasoning");
  });

  it.each(["command_execution", "file_change", "mcp_tool_call", "web_search"])(
    "fails closed when Codex emits built-in %s activity",
    (kind) => {
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({ type: "item.started", item: { id: "forbidden-1", type: kind } }),
      ].join("\n");
      expect(() => parseCodexJsonlTranscript({ stdout, contract })).toThrowError(
        expect.objectContaining({ outcome: "TOOL_BOUNDARY_VIOLATION" }),
      );
    },
  );

  it.each([
    [JSON.stringify({ type: "turn.failed", error: { message: "quota prose" } })],
    [JSON.stringify({ type: "error", message: "auth prose" })],
    [
      JSON.stringify({
        type: "item.completed",
        item: { id: "error-1", type: "error", message: "prose" },
      }),
    ],
  ])("maps provider/quota failures to one content-free terminal outcome", (failure) => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({ type: "turn.started" }),
      failure,
    ].join("\n");
    const events: NormalizedSubscriptionModelEvent[] = [];
    expect(() =>
      parseCodexJsonlTranscript({
        stdout,
        contract,
        onEvent: (event) => events.push(event),
      }),
    ).toThrowError(expect.objectContaining({ outcome: "QUOTA_OR_PROVIDER_FAILED" }));
    expect(JSON.stringify(events)).not.toMatch(/quota prose|auth prose|"prose"/u);
  });

  it.each([
    ["malformed JSON", "{"],
    ["missing session", transcript().split("\n").slice(1).join("\n")],
    ["wrong response digest", transcript(finalText({ ok: true }, "0".repeat(64)))],
    ["missing turn completion", transcript().split("\n").slice(0, -1).join("\n")],
    [
      "duplicate final message",
      transcript().replace(
        '"type":"turn.completed"',
        '"type":"item.completed","item":{"id":"message-2","type":"agent_message","text":"{}"}}\n{"type":"turn.completed"',
      ),
    ],
    [
      "event after terminal",
      `${transcript()}\n${JSON.stringify({
        type: "item.completed",
        item: { id: "reason-after-terminal", type: "reasoning", text: "forged" },
      })}`,
    ],
    [
      "forged usage",
      transcript().replace(
        '"reasoning_output_tokens":20',
        '"reasoning_output_tokens":20,"foreign":1',
      ),
    ],
    [
      "overflowed usage",
      transcript().replace('"input_tokens":120', `"input_tokens":${Number.MAX_SAFE_INTEGER}`),
    ],
    ["forged session", transcript().replace(threadId, `${threadId}\"`)],
    ["deeply nested final output", deeplyNestedFinal()],
  ])("rejects %s as malformed rather than accepting partial success", (_name, stdout) => {
    expect(() => parseCodexJsonlTranscript({ stdout, contract })).toThrowError(
      expect.objectContaining({ outcome: "MALFORMED_OUTPUT" }),
    );
  });

  it("returns one declared tool request as data for the code-owned tool loop", () => {
    const final = JSON.stringify({
      schema_version: 1,
      schema_digest: toolContract.schemaDigest,
      kind: "tool_use",
      final: null,
      tool_call: {
        id: "call-1",
        name: "files.read",
        input: { relative_path: "src/feature.ts" },
      },
    });
    expect(
      parseCodexJsonlTranscript({ stdout: transcript(final), contract: toolContract }).content,
    ).toEqual([
      {
        type: "tool-use",
        id: "call-1",
        name: "files.read",
        input: { relative_path: "src/feature.ts" },
      },
    ]);
  });

  it("refuses a model-supplied tool name outside the bound code-owned set", () => {
    const final = JSON.stringify({
      schema_version: 1,
      schema_digest: toolContract.schemaDigest,
      kind: "tool_use",
      final: null,
      tool_call: { id: "call-1", name: "command", input: { value: "whoami" } },
    });
    expect(() =>
      parseCodexJsonlTranscript({ stdout: transcript(final), contract: toolContract }),
    ).toThrowError(expect.objectContaining({ outcome: "TOOL_BOUNDARY_VIOLATION" }));
  });
});
