import {
  normalizedSubscriptionModelEvent,
  TransportError,
  type NormalizedSubscriptionModelEvent,
  type RuntimeContent,
  type RuntimeJsonValue,
  type RuntimeUsage,
} from "@remoteagent/model-runtime";
import * as z from "zod";

import type { CodexResponseContract } from "./schema.js";

const MAX_EVENTS = 4096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const boundedItemId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/u);
const boundedThreadId = z.string().regex(/^[A-Za-z0-9._:-]{1,256}$/u);
const boundedText = z.string().max(16 * 1024 * 1024);
const safeTokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const usageSchema = z
  .object({
    input_tokens: safeTokenCount,
    cached_input_tokens: safeTokenCount,
    cache_write_input_tokens: safeTokenCount.optional(),
    output_tokens: safeTokenCount,
    reasoning_output_tokens: safeTokenCount,
  })
  .strict();
const threadStarted = z
  .object({ type: z.literal("thread.started"), thread_id: boundedThreadId })
  .strict();
const turnStarted = z.object({ type: z.literal("turn.started") }).strict();
const turnCompleted = z.object({ type: z.literal("turn.completed"), usage: usageSchema }).strict();
const agentMessage = z
  .object({ id: boundedItemId, type: z.literal("agent_message"), text: boundedText })
  .strict();
const reasoning = z
  .object({ id: boundedItemId, type: z.literal("reasoning"), text: boundedText })
  .strict();
const todoItem = z.object({ text: boundedText, completed: z.boolean() }).strict();
const todoList = z
  .object({ id: boundedItemId, type: z.literal("todo_list"), items: z.array(todoItem).max(256) })
  .strict();
const allowedItem = z.discriminatedUnion("type", [agentMessage, reasoning, todoList]);
const itemEvent = z
  .object({
    type: z.enum(["item.started", "item.updated", "item.completed"]),
    item: allowedItem,
  })
  .strict();

const builtInToolKinds = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

export type CodexTurnOutcome =
  "SUCCEEDED" | "QUOTA_OR_PROVIDER_FAILED" | "MALFORMED_OUTPUT" | "TOOL_BOUNDARY_VIOLATION";

export type CodexTranscriptFailureDetail =
  | "UNCLASSIFIED"
  | "JSON_VALUE_BOUNDS"
  | "FINAL_JSON_PARSE"
  | "FINAL_NOT_OBJECT"
  | "FINAL_ENVELOPE"
  | "TOOL_ENVELOPE"
  | "TOOL_IDENTITY"
  | "TOOL_NOT_ALLOWED"
  | "FINAL_KIND"
  | "FINAL_TEXT"
  | "TRANSCRIPT_BOUNDS"
  | "EVENT_JSON"
  | "EVENT_ENVELOPE"
  | "THREAD_ORDER_OR_SHAPE"
  | "TURN_STARTED_ORDER_OR_SHAPE"
  | "PROVIDER_ERROR"
  | "TURN_COMPLETED_ORDER"
  | "TURN_COMPLETED_SHAPE"
  | "ITEM_ORDER_OR_SHAPE"
  | "BUILTIN_TOOL"
  | "ITEM_DUPLICATE"
  | "FINAL_DUPLICATE"
  | "EVENT_UNKNOWN"
  | "TRANSCRIPT_INCOMPLETE";

export class CodexCliTranscriptError extends TransportError {
  readonly providerCode = "CODEX_CLI_TRANSCRIPT_INVALID";
  readonly outcome: Exclude<CodexTurnOutcome, "SUCCEEDED">;
  readonly usage: RuntimeUsage | undefined;
  readonly detailCode: CodexTranscriptFailureDetail;

  constructor(
    outcome: Exclude<CodexTurnOutcome, "SUCCEEDED">,
    usage?: RuntimeUsage,
    detailCode: CodexTranscriptFailureDetail = outcome === "QUOTA_OR_PROVIDER_FAILED"
      ? "PROVIDER_ERROR"
      : outcome === "TOOL_BOUNDARY_VIOLATION"
        ? "TOOL_NOT_ALLOWED"
        : "UNCLASSIFIED",
  ) {
    super(
      "Codex CLI transcript failed the strict provider boundary",
      outcome === "MALFORMED_OUTPUT" ? "TRANSIENT" : "FATAL",
    );
    this.name = "CodexCliTranscriptError";
    this.outcome = outcome;
    this.usage = usage === undefined ? undefined : Object.freeze({ ...usage });
    this.detailCode = detailCode;
  }
}

export type ParsedCodexTranscript = Readonly<{
  sessionId: string;
  content: readonly RuntimeContent[];
  usage: RuntimeUsage;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitTurn(input: {
  emit: ((event: NormalizedSubscriptionModelEvent) => void) | undefined;
  sequence: () => number;
  sessionId: string | null;
  outcome: CodexTurnOutcome;
  usage: RuntimeUsage | null;
}): void {
  input.emit?.(
    normalizedSubscriptionModelEvent.parse({
      event: "MODEL_TURN_FINISHED",
      sequence: input.sequence(),
      provider: "codex_cli",
      session_id: input.sessionId,
      outcome: input.outcome,
      usage:
        input.usage === null
          ? null
          : {
              input_tokens: input.usage.inputTokens ?? null,
              output_tokens: input.usage.outputTokens ?? null,
              total_tokens: input.usage.totalTokens ?? null,
              provider_reported: true,
            },
    }),
  );
}

function asJsonValue(
  value: unknown,
  state: { nodes: number } = { nodes: 0 },
  depth = 0,
): RuntimeJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "JSON_VALUE_BOUNDS");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => asJsonValue(entry, state, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, entry]) => [key, asJsonValue(entry, state, depth + 1)] as const,
      ),
    );
  }
  throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "JSON_VALUE_BOUNDS");
}

function schemaAllowsNull(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) return true;
  const anyOf = schema["anyOf"];
  return Array.isArray(anyOf) && anyOf.some(schemaAllowsNull);
}

function objectSchemaForValue(schema: unknown, value: Record<string, RuntimeJsonValue>) {
  if (!isRecord(schema)) return null;
  if (schema["type"] === "object" || isRecord(schema["properties"])) return schema;
  const anyOf = schema["anyOf"];
  if (!Array.isArray(anyOf)) return null;
  const candidates = anyOf.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && (candidate["type"] === "object" || isRecord(candidate["properties"])),
  );
  return (
    candidates.find((candidate) => {
      const properties = candidate["properties"];
      return (
        isRecord(properties) &&
        Object.keys(value).every(
          (key) => key in properties || candidate["additionalProperties"] !== false,
        )
      );
    }) ?? null
  );
}

/** Undo only the null placeholders introduced by the Codex response schema. */
function decodeCodexOptionalToolInput(value: RuntimeJsonValue, schema: unknown): RuntimeJsonValue {
  if (Array.isArray(value)) {
    const items = isRecord(schema) ? schema["items"] : undefined;
    return value.map((entry) => decodeCodexOptionalToolInput(entry, items));
  }
  if (!isRecord(value)) return value;
  const objectSchema = objectSchemaForValue(schema, value);
  if (objectSchema === null) return value;
  const properties = objectSchema["properties"];
  if (!isRecord(properties)) return value;
  const required = new Set(
    Array.isArray(objectSchema["required"])
      ? objectSchema["required"].filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const propertySchema = properties[key];
      if (propertySchema === undefined) return [[key, entry] as const];
      if (entry === null && !required.has(key) && !schemaAllowsNull(propertySchema)) return [];
      return [[key, decodeCodexOptionalToolInput(entry, propertySchema)] as const];
    }),
  );
}

function parseFinalContent(
  text: string,
  contract: CodexResponseContract,
): readonly RuntimeContent[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "FINAL_JSON_PARSE");
  }
  if (!isRecord(value)) {
    throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "FINAL_NOT_OBJECT");
  }
  const keys = Object.keys(value).sort();
  if (
    value["schema_version"] !== 1 ||
    value["schema_digest"] !== contract.schemaDigest ||
    keys.join(",") !== "final,kind,schema_digest,schema_version,tool_call"
  ) {
    throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "FINAL_ENVELOPE");
  }
  if (value["kind"] === "tool_use") {
    if (value["final"] !== null || !isRecord(value["tool_call"])) {
      throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "TOOL_ENVELOPE");
    }
    const toolCall = value["tool_call"];
    if (
      Object.keys(toolCall).sort().join(",") !== "id,input,name" ||
      typeof toolCall["id"] !== "string" ||
      !/^[A-Za-z0-9._:-]{1,256}$/u.test(toolCall["id"]) ||
      typeof toolCall["name"] !== "string" ||
      !("input" in toolCall)
    ) {
      throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "TOOL_IDENTITY");
    }
    if (!contract.toolNames.includes(toolCall["name"])) {
      throw new CodexCliTranscriptError("TOOL_BOUNDARY_VIOLATION", undefined, "TOOL_NOT_ALLOWED");
    }
    const definition = contract.tools.find((tool) => tool.name === toolCall["name"]);
    if (definition === undefined) {
      throw new CodexCliTranscriptError("TOOL_BOUNDARY_VIOLATION", undefined, "TOOL_NOT_ALLOWED");
    }
    const encodedInput = asJsonValue(toolCall["input"]);
    return Object.freeze([
      {
        type: "tool-use",
        id: toolCall["id"],
        name: toolCall["name"],
        input: decodeCodexOptionalToolInput(encodedInput, definition.inputSchema),
      },
    ]);
  }
  if (value["kind"] !== contract.finalKind || value["tool_call"] !== null) {
    throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "FINAL_KIND");
  }
  if (contract.finalKind === "text") {
    if (typeof value["final"] !== "string") {
      throw new CodexCliTranscriptError("MALFORMED_OUTPUT", undefined, "FINAL_TEXT");
    }
    return Object.freeze([{ type: "text", text: value["final"] }]);
  }
  return Object.freeze([{ type: "json", value: asJsonValue(value["final"]) }]);
}

/** Parse one complete, already byte-bounded `codex exec --json` stdout. */
export function parseCodexJsonlTranscript(input: {
  stdout: string;
  contract: CodexResponseContract;
  nextSequence?: () => number;
  onEvent?: (event: NormalizedSubscriptionModelEvent) => void;
}): ParsedCodexTranscript {
  let sequence = 0;
  const nextSequence = input.nextSequence ?? (() => ++sequence);
  let sessionId: string | null = null;
  let started = false;
  let terminal = false;
  let finalMessage: string | null = null;
  let usage: RuntimeUsage | null = null;
  const completedItems = new Set<string>();
  const rawLines = input.stdout.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();

  const malformed = (detailCode: CodexTranscriptFailureDetail): never => {
    emitTurn({
      emit: input.onEvent,
      sequence: nextSequence,
      sessionId,
      outcome: "MALFORMED_OUTPUT",
      usage,
    });
    throw new CodexCliTranscriptError("MALFORMED_OUTPUT", usage ?? undefined, detailCode);
  };
  if (
    rawLines.length === 0 ||
    rawLines.length > MAX_EVENTS ||
    rawLines.some((line) => line.length === 0)
  ) {
    return malformed("TRANSCRIPT_BOUNDS");
  }

  for (const [index, line] of rawLines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return malformed("EVENT_JSON");
    }
    if (!isRecord(value) || typeof value["type"] !== "string" || terminal) {
      return malformed("EVENT_ENVELOPE");
    }
    const type = value["type"];

    if (type === "thread.started") {
      if (index !== 0 || sessionId !== null) return malformed("THREAD_ORDER_OR_SHAPE");
      const event = threadStarted.safeParse(value);
      if (!event.success) return malformed("THREAD_ORDER_OR_SHAPE");
      sessionId = event.data.thread_id;
      input.onEvent?.(
        normalizedSubscriptionModelEvent.parse({
          event: "MODEL_SESSION_STARTED",
          sequence: nextSequence(),
          provider: "codex_cli",
          session_id: sessionId,
        }),
      );
      continue;
    }
    if (type === "turn.started") {
      if (sessionId === null || started || !turnStarted.safeParse(value).success)
        return malformed("TURN_STARTED_ORDER_OR_SHAPE");
      started = true;
      continue;
    }
    if (type === "turn.failed" || type === "error") {
      emitTurn({
        emit: input.onEvent,
        sequence: nextSequence,
        sessionId,
        outcome: "QUOTA_OR_PROVIDER_FAILED",
        usage: null,
      });
      throw new CodexCliTranscriptError("QUOTA_OR_PROVIDER_FAILED");
    }
    if (type === "turn.completed") {
      if (sessionId === null || !started || finalMessage === null) {
        return malformed("TURN_COMPLETED_ORDER");
      }
      const event = turnCompleted.safeParse(value);
      if (!event.success) return malformed("TURN_COMPLETED_SHAPE");
      const totalTokens = event.data.usage.input_tokens + event.data.usage.output_tokens;
      if (!Number.isSafeInteger(totalTokens)) return malformed("TURN_COMPLETED_SHAPE");
      terminal = true;
      usage = Object.freeze({
        inputTokens: event.data.usage.input_tokens,
        outputTokens: event.data.usage.output_tokens,
        totalTokens,
      });
      continue;
    }
    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      const rawItem = value["item"];
      if (!isRecord(rawItem) || typeof rawItem["type"] !== "string") {
        return malformed("ITEM_ORDER_OR_SHAPE");
      }
      if (builtInToolKinds.has(rawItem["type"])) {
        emitTurn({
          emit: input.onEvent,
          sequence: nextSequence,
          sessionId,
          outcome: "TOOL_BOUNDARY_VIOLATION",
          usage: null,
        });
        throw new CodexCliTranscriptError("TOOL_BOUNDARY_VIOLATION", undefined, "BUILTIN_TOOL");
      }
      if (rawItem["type"] === "error") {
        emitTurn({
          emit: input.onEvent,
          sequence: nextSequence,
          sessionId,
          outcome: "QUOTA_OR_PROVIDER_FAILED",
          usage: null,
        });
        throw new CodexCliTranscriptError("QUOTA_OR_PROVIDER_FAILED");
      }
      const event = itemEvent.safeParse(value);
      if (!event.success || sessionId === null || !started) {
        return malformed("ITEM_ORDER_OR_SHAPE");
      }
      if (event.data.type === "item.completed") {
        if (completedItems.has(event.data.item.id)) return malformed("ITEM_DUPLICATE");
        completedItems.add(event.data.item.id);
        if (event.data.item.type === "agent_message") {
          // Codex may emit bounded progress prose as completed agent messages before the
          // response-schema envelope. Only the last completed message at turn completion is the
          // provider result. Same-item replay remains rejected by `completedItems`, and no
          // intermediate text is retained or emitted across this boundary.
          finalMessage = event.data.item.text;
        }
      }
      continue;
    }
    return malformed("EVENT_UNKNOWN");
  }

  if (!terminal || sessionId === null || usage === null || finalMessage === null)
    return malformed("TRANSCRIPT_INCOMPLETE");
  let content: readonly RuntimeContent[];
  try {
    content = parseFinalContent(finalMessage, input.contract);
  } catch (error) {
    const outcome = error instanceof CodexCliTranscriptError ? error.outcome : "MALFORMED_OUTPUT";
    emitTurn({
      emit: input.onEvent,
      sequence: nextSequence,
      sessionId,
      outcome,
      usage,
    });
    throw new CodexCliTranscriptError(
      outcome,
      usage,
      error instanceof CodexCliTranscriptError ? error.detailCode : "UNCLASSIFIED",
    );
  }
  emitTurn({ emit: input.onEvent, sequence: nextSequence, sessionId, outcome: "SUCCEEDED", usage });
  return Object.freeze({ sessionId, content, usage });
}
