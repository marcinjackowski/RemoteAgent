import { isAbsolute, join, normalize, relative, resolve } from "node:path";

import {
  subscriptionModelProfileV1,
  type SubscriptionModelProfileV1,
} from "@remoteagent/model-runtime";

export const CODEX_CLI_SUPPORTED_VERSION = "0.153.3";
export const CODEX_CLI_RESPONSE_SCHEMA_FILENAME = "response.schema.json";

/**
 * Every setting is code-owned and passed after --ignore-user-config. The empty
 * invocation root contains no project config, rules, plugins, MCP servers or
 * source tree.
 */
export const CODEX_CLI_SAFETY_CONFIG = Object.freeze([
  'approval_policy="never"',
  'forced_login_method="chatgpt"',
  'model_provider="openai"',
  'web_search="disabled"',
  "agents.enabled=false",
  "analytics.enabled=false",
  "check_for_update_on_startup=false",
  "features.apps=false",
  "features.goals=false",
  "features.hooks=false",
  "features.memories=false",
  "features.multi_agent=false",
  "features.network_proxy=false",
  "features.remote_plugin=false",
  "features.shell_snapshot=false",
  "features.shell_tool=false",
  "features.skill_mcp_dependency_install=false",
  "features.unified_exec=false",
  'file_opener="none"',
  "hide_agent_reasoning=true",
  'history.persistence="none"',
  "memories.generate_memories=false",
  "memories.use_memories=false",
] as const);

export class CodexCliConfigurationError extends Error {
  readonly code = "CODEX_CLI_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "CodexCliConfigurationError";
  }
}

function exactCodexProfile(input: unknown): SubscriptionModelProfileV1 {
  const profile = subscriptionModelProfileV1.parse(input);
  if (profile.provider !== "codex_cli") {
    throw new CodexCliConfigurationError("Codex adapter requires a codex_cli profile");
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
    throw new CodexCliConfigurationError("invocation root must be an absolute normalized path");
  }
}

export function createCodexExecArgv(input: {
  profile: SubscriptionModelProfileV1;
  invocationRoot: string;
  outputSchemaPath: string;
}): readonly string[] {
  const profile = exactCodexProfile(input.profile);
  assertCanonicalLexicalDirectory(input.invocationRoot);
  if (
    !isAbsolute(input.outputSchemaPath) ||
    input.outputSchemaPath.includes("\0") ||
    normalize(input.outputSchemaPath) !== input.outputSchemaPath ||
    relative(input.invocationRoot, input.outputSchemaPath).startsWith("..") ||
    input.outputSchemaPath !== join(input.invocationRoot, CODEX_CLI_RESPONSE_SCHEMA_FILENAME)
  ) {
    throw new CodexCliConfigurationError(
      "output schema must be the exact code-owned file in the invocation root",
    );
  }

  const argv: string[] = [
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--color",
    "never",
    "--model",
    profile.model,
    "--sandbox",
    "read-only",
    "--output-schema",
    input.outputSchemaPath,
    "--cd",
    input.invocationRoot,
  ];
  for (const value of CODEX_CLI_SAFETY_CONFIG) argv.push("--config", value);
  argv.push("-");
  return Object.freeze(argv);
}
