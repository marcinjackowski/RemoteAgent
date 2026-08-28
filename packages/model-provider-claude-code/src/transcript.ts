import {
  normalizedSubscriptionModelEvent,
  TransportError,
  type NormalizedSubscriptionModelEvent,
  type RuntimeContent,
  type RuntimeJsonValue,
  type RuntimeUsage,
} from "@remoteagent/model-runtime";

import type { ClaudeResponseContract } from "./schema.js";

const MAX_EVENTS = 4096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const opaqueId = /^[A-Za-z0-9._:-]{1,256}$/u;
const safeToken = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export type ClaudeTurnOutcome =
  | "SUCCEEDED"
  | "AUTH_FAILED"
  | "QUOTA_OR_PROVIDER_FAILED"
  | "PROVIDER_FAILED"
  | "MALFORMED_OUTPUT"
  | "TOOL_BOUNDARY_VIOLATION";

export class ClaudeCodeTranscriptError extends TransportError {
  readonly providerCode = "CLAUDE_CODE_TRANSCRIPT_INVALID";
  readonly outcome: Exclude<ClaudeTurnOutcome, "SUCCEEDED">;

  constructor(outcome: Exclude<ClaudeTurnOutcome, "SUCCEEDED">) {
    super("Claude Code transcript failed the strict provider boundary", "FATAL");
    this.name = "ClaudeCodeTranscriptError";
    this.outcome = outcome;
  }
}

export type ParsedClaudeTranscript = Readonly<{
  sessionId: string;
  content: readonly RuntimeContent[];
  usage: RuntimeUsage;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown, state: { nodes: number } = { nodes: 0 }, depth = 0): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) boundedJson(entry, state, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) boundedJson(entry, state, depth + 1);
    return;
  }
  throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
}

function asJsonValue(value: unknown): RuntimeJsonValue {
  boundedJson(value);
  return value as RuntimeJsonValue;
}

function emitTurn(input: {
  emit: ((event: NormalizedSubscriptionModelEvent) => void) | undefined;
  sequence: () => number;
  sessionId: string | null;
  outcome: ClaudeTurnOutcome;
  usage: RuntimeUsage | null;
}): void {
  input.emit?.(
    normalizedSubscriptionModelEvent.parse({
      event: "MODEL_TURN_FINISHED",
      sequence: input.sequence(),
      provider: "claude_code",
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

function failFromRetry(error: unknown): Exclude<ClaudeTurnOutcome, "SUCCEEDED"> {
  if (error === "authentication_failed" || error === "oauth_org_not_allowed") return "AUTH_FAILED";
  if (
    error === "billing_error" ||
    error === "rate_limit" ||
    error === "overloaded" ||
    error === "max_output_tokens"
  ) {
    return "QUOTA_OR_PROVIDER_FAILED";
  }
  return "PROVIDER_FAILED";
}

function parseContent(value: unknown, contract: ClaudeResponseContract): readonly RuntimeContent[] {
  boundedJson(value);
  if (!isRecord(value)) throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
  if (
    Object.keys(value).sort().join(",") !== "final,kind,schema_digest,schema_version,tool_call" ||
    value.schema_version !== 1 ||
    value.schema_digest !== contract.schemaDigest
  ) {
    throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
  }
  if (value.kind === "tool_use") {
    if (value.final !== null || !isRecord(value.tool_call)) {
      throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
    }
    const tool = value.tool_call;
    if (
      Object.keys(tool).sort().join(",") !== "id,input,name" ||
      typeof tool.id !== "string" ||
      !opaqueId.test(tool.id) ||
      typeof tool.name !== "string" ||
      !("input" in tool)
    ) {
      throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
    }
    if (!contract.toolNames.includes(tool.name)) {
      throw new ClaudeCodeTranscriptError("TOOL_BOUNDARY_VIOLATION");
    }
    return Object.freeze([
      { type: "tool-use", id: tool.id, name: tool.name, input: asJsonValue(tool.input) },
    ]);
  }
  if (value.kind !== contract.finalKind || value.tool_call !== null) {
    throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
  }
  if (contract.finalKind === "text") {
    if (typeof value.final !== "string") throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
    return Object.freeze([{ type: "text", text: value.final }]);
  }
  return Object.freeze([{ type: "json", value: asJsonValue(value.final) }]);
}

function assistantHasToolUse(value: Record<string, unknown>): boolean {
  if (!isRecord(value.message) || !Array.isArray(value.message.content)) return false;
  return value.message.content.some((block) => isRecord(block) && block.type === "tool_use");
}

/** Parse one complete, already byte-bounded `claude -p --output-format stream-json` stdout. */
export function parseClaudeStreamJsonTranscript(input: {
  stdout: string;
  contract: ClaudeResponseContract;
  expectedSessionId: string;
  expectedModel: string;
  expectedClientVersion: string;
  expectedCwd: string;
  processSucceeded?: boolean;
  nextSequence?: () => number;
  onEvent?: (event: NormalizedSubscriptionModelEvent) => void;
}): ParsedClaudeTranscript {
  let sequence = 0;
  const nextSequence = input.nextSequence ?? (() => ++sequence);
  let initialized = false;
  let terminal = false;
  let sessionId: string | null = null;
  let content: readonly RuntimeContent[] | null = null;
  let usage: RuntimeUsage | null = null;
  const lines = input.stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const malformed = (): never => {
    emitTurn({
      emit: input.onEvent,
      sequence: nextSequence,
      sessionId,
      outcome: "MALFORMED_OUTPUT",
      usage: null,
    });
    throw new ClaudeCodeTranscriptError("MALFORMED_OUTPUT");
  };
  if (lines.length === 0 || lines.length > MAX_EVENTS || lines.some((line) => line.length === 0)) {
    return malformed();
  }

  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
      boundedJson(value);
    } catch {
      return malformed();
    }
    if (!isRecord(value) || typeof value.type !== "string" || terminal) return malformed();

    if (value.type === "system" && value.subtype === "init") {
      if (
        index !== 0 ||
        initialized ||
        value.session_id !== input.expectedSessionId ||
        typeof value.uuid !== "string" ||
        !opaqueId.test(value.uuid) ||
        value.claude_code_version !== input.expectedClientVersion ||
        value.cwd !== input.expectedCwd ||
        value.model !== input.expectedModel ||
        value.permissionMode !== "plan" ||
        value.apiKeySource !== "none" ||
        !Array.isArray(value.tools) ||
        value.tools.length !== 0 ||
        !Array.isArray(value.mcp_servers) ||
        value.mcp_servers.length !== 0 ||
        !Array.isArray(value.plugins) ||
        value.plugins.length !== 0 ||
        !Array.isArray(value.skills) ||
        value.skills.length !== 0 ||
        !Array.isArray(value.slash_commands) ||
        value.slash_commands.length !== 0
      ) {
        return malformed();
      }
      initialized = true;
      sessionId = input.expectedSessionId;
      input.onEvent?.(
        normalizedSubscriptionModelEvent.parse({
          event: "MODEL_SESSION_STARTED",
          sequence: nextSequence(),
          provider: "claude_code",
          session_id: sessionId,
        }),
      );
      continue;
    }

    if (value.type === "system" && value.subtype === "api_retry") {
      if (!initialized || value.session_id !== sessionId) return malformed();
      if (typeof value.uuid !== "string" || !opaqueId.test(value.uuid)) return malformed();
      const outcome = failFromRetry(value.error);
      emitTurn({ emit: input.onEvent, sequence: nextSequence, sessionId, outcome, usage: null });
      throw new ClaudeCodeTranscriptError(outcome);
    }

    if (value.type === "assistant") {
      if (
        !initialized ||
        value.session_id !== sessionId ||
        typeof value.uuid !== "string" ||
        !opaqueId.test(value.uuid) ||
        value.parent_tool_use_id !== null ||
        !isRecord(value.message) ||
        value.message.model !== input.expectedModel ||
        assistantHasToolUse(value)
      ) {
        const outcome = assistantHasToolUse(value) ? "TOOL_BOUNDARY_VIOLATION" : "MALFORMED_OUTPUT";
        emitTurn({ emit: input.onEvent, sequence: nextSequence, sessionId, outcome, usage: null });
        throw new ClaudeCodeTranscriptError(outcome);
      }
      continue;
    }

    if (value.type === "result") {
      if (!initialized || value.session_id !== sessionId || index !== lines.length - 1)
        return malformed();
      if (value.subtype !== "success" || input.processSucceeded === false) {
        emitTurn({
          emit: input.onEvent,
          sequence: nextSequence,
          sessionId,
          outcome: "PROVIDER_FAILED",
          usage: null,
        });
        throw new ClaudeCodeTranscriptError("PROVIDER_FAILED");
      }
      const exactModelUsage = isRecord(value.modelUsage)
        ? value.modelUsage[input.expectedModel]
        : undefined;
      if (
        value.is_error !== false ||
        typeof value.uuid !== "string" ||
        !opaqueId.test(value.uuid) ||
        !safeToken(value.num_turns) ||
        value.num_turns < 1 ||
        !Array.isArray(value.permission_denials) ||
        value.permission_denials.length !== 0 ||
        value.deferred_tool_use !== undefined ||
        (value.terminal_reason !== undefined && value.terminal_reason !== "completed") ||
        !isRecord(value.usage) ||
        !safeToken(value.usage.input_tokens) ||
        !safeToken(value.usage.output_tokens) ||
        !isRecord(value.modelUsage) ||
        Object.keys(value.modelUsage).length !== 1 ||
        !isRecord(exactModelUsage)
      ) {
        return malformed();
      }
      if (
        exactModelUsage.provider !== "firstParty" ||
        exactModelUsage.canonicalModel !== input.expectedModel ||
        !safeToken(exactModelUsage.inputTokens) ||
        !safeToken(exactModelUsage.outputTokens)
      ) {
        return malformed();
      }
      const totalTokens = exactModelUsage.inputTokens + exactModelUsage.outputTokens;
      if (!Number.isSafeInteger(totalTokens)) return malformed();
      try {
        content = parseContent(value.structured_output, input.contract);
      } catch (error) {
        const outcome =
          error instanceof ClaudeCodeTranscriptError ? error.outcome : "MALFORMED_OUTPUT";
        emitTurn({ emit: input.onEvent, sequence: nextSequence, sessionId, outcome, usage: null });
        throw error;
      }
      usage = Object.freeze({
        inputTokens: exactModelUsage.inputTokens,
        outputTokens: exactModelUsage.outputTokens,
        totalTokens,
      });
      terminal = true;
      continue;
    }
    return malformed();
  }

  if (!terminal || sessionId === null || content === null || usage === null) return malformed();
  emitTurn({ emit: input.onEvent, sequence: nextSequence, sessionId, outcome: "SUCCEEDED", usage });
  return Object.freeze({ sessionId, content, usage });
}
