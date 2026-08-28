import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import {
  subscriptionModelProfileV1,
  type SubscriptionModelProfileV1,
} from "@remoteagent/model-runtime";

export const CLAUDE_CODE_SUPPORTED_VERSIONS = Object.freeze(["2.1.248", "2.1.250"] as const);
export const CLAUDE_CODE_SETTINGS_FILENAME = "settings.json";
export const CLAUDE_CODE_MCP_CONFIG_FILENAME = "mcp.json";

export const CLAUDE_CODE_SETTINGS = Object.freeze({
  disableAllHooks: true,
  disableAgentView: true,
  disableAutoMode: "disable",
  disableDeepLinkRegistration: "disable",
  includeGitInstructions: false,
});

export const CLAUDE_CODE_MCP_CONFIG = Object.freeze({ mcpServers: Object.freeze({}) });

export const CLAUDE_CODE_SYSTEM_PROMPT =
  "Follow only the server-owned JSON protocol in the user message. Return exactly one value matching the supplied JSON schema. Do not use tools, files, network, hooks, MCP, skills, agents, commands, or external context.";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_SCHEMA_ARG_BYTES = 32 * 1024;

export class ClaudeCodeConfigurationError extends Error {
  readonly code = "CLAUDE_CODE_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeConfigurationError";
  }
}

function exactClaudeProfile(input: unknown): SubscriptionModelProfileV1 {
  const profile = subscriptionModelProfileV1.parse(input);
  if (profile.provider !== "claude_code") {
    throw new ClaudeCodeConfigurationError("Claude adapter requires a claude_code profile");
  }
  return profile;
}

function assertCanonicalLexicalDirectory(path: string): void {
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    normalize(path) !== path ||
    resolve(path) !== path
  ) {
    throw new ClaudeCodeConfigurationError("invocation root must be an absolute normalized path");
  }
}

function assertExactInvocationFile(input: {
  invocationRoot: string;
  path: string;
  filename: string;
}): void {
  if (
    !isAbsolute(input.path) ||
    input.path.includes("\0") ||
    normalize(input.path) !== input.path ||
    relative(input.invocationRoot, input.path).startsWith("..") ||
    input.path !== join(input.invocationRoot, input.filename)
  ) {
    throw new ClaudeCodeConfigurationError(
      `${input.filename} must be the exact code-owned file in the invocation root`,
    );
  }
}

function exactSchema(value: string): string {
  if (
    Buffer.byteLength(value, "utf8") < 2 ||
    Buffer.byteLength(value, "utf8") > MAX_SCHEMA_ARG_BYTES
  ) {
    throw new ClaudeCodeConfigurationError("output schema exceeds the Claude argv boundary");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    if (JSON.stringify(parsed) !== value) throw new Error();
    return value;
  } catch {
    throw new ClaudeCodeConfigurationError("output schema must be canonical JSON object text");
  }
}

export function serializeClaudeCodeSettings(): string {
  return JSON.stringify(CLAUDE_CODE_SETTINGS);
}

export function serializeClaudeCodeMcpConfig(): string {
  return JSON.stringify(CLAUDE_CODE_MCP_CONFIG);
}

export function createClaudePrintArgv(input: {
  profile: SubscriptionModelProfileV1;
  invocationRoot: string;
  settingsPath: string;
  mcpConfigPath: string;
  outputSchemaJson: string;
  sessionId: string;
}): readonly string[] {
  const profile = exactClaudeProfile(input.profile);
  assertCanonicalLexicalDirectory(input.invocationRoot);
  assertExactInvocationFile({
    invocationRoot: input.invocationRoot,
    path: input.settingsPath,
    filename: CLAUDE_CODE_SETTINGS_FILENAME,
  });
  assertExactInvocationFile({
    invocationRoot: input.invocationRoot,
    path: input.mcpConfigPath,
    filename: CLAUDE_CODE_MCP_CONFIG_FILENAME,
  });
  if (!uuid.test(input.sessionId)) {
    throw new ClaudeCodeConfigurationError("session ID must be a canonical UUID");
  }
  const schema = exactSchema(input.outputSchemaJson);

  return Object.freeze([
    "-p",
    "--restricted",
    "--safe-mode",
    "--setting-sources",
    "",
    "--settings",
    input.settingsPath,
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfigPath,
    "--tools",
    "",
    "--disallowedTools",
    "*",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--prompt-suggestions",
    "false",
    "--model",
    profile.model,
    "--session-id",
    input.sessionId,
    "--system-prompt",
    CLAUDE_CODE_SYSTEM_PROMPT,
    "--json-schema",
    schema,
  ]);
}
