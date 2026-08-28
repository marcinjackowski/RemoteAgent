import { join } from "node:path";

import { subscriptionModelProfileV1 } from "@remoteagent/model-runtime";
import { describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_MCP_CONFIG_FILENAME,
  CLAUDE_CODE_SETTINGS_FILENAME,
  CLAUDE_CODE_SYSTEM_PROMPT,
  createClaudePrintArgv,
  serializeClaudeCodeMcpConfig,
  serializeClaudeCodeSettings,
} from "../src/index.js";

function profile(provider: "codex_cli" | "claude_code" = "claude_code") {
  return subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "claude-subscription",
    provider,
    executable: "/opt/remoteagent/bin/claude",
    model: "claude-opus-4-8",
    timeout_ms: 120_000,
    kill_grace_ms: 250,
    max_stdin_bytes: 262_144,
    max_stdout_bytes: 1_048_576,
    max_stderr_bytes: 65_536,
  });
}

describe("Claude Code invocation", () => {
  it("pins restricted safe-mode subscription invocation with no built-in authority or fallback", () => {
    const root = "/private/tmp/remoteagent-claude/invocation-1";
    const settings = join(root, CLAUDE_CODE_SETTINGS_FILENAME);
    const mcp = join(root, CLAUDE_CODE_MCP_CONFIG_FILENAME);
    const schema = '{"type":"object","additionalProperties":false}';
    const argv = createClaudePrintArgv({
      profile: profile(),
      invocationRoot: root,
      settingsPath: settings,
      mcpConfigPath: mcp,
      outputSchemaJson: schema,
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(argv).toEqual([
      "-p",
      "--restricted",
      "--safe-mode",
      "--setting-sources",
      "",
      "--settings",
      settings,
      "--strict-mcp-config",
      "--mcp-config",
      mcp,
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
      "claude-opus-4-8",
      "--session-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--system-prompt",
      CLAUDE_CODE_SYSTEM_PROMPT,
      "--json-schema",
      schema,
    ]);
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--fallback-model");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--add-dir");
    expect(Object.isFrozen(argv)).toBe(true);
    expect(JSON.parse(serializeClaudeCodeSettings())).toEqual({
      disableAllHooks: true,
      disableAgentView: true,
      disableAutoMode: "disable",
      disableDeepLinkRegistration: "disable",
      includeGitInstructions: false,
    });
    expect(JSON.parse(serializeClaudeCodeMcpConfig())).toEqual({ mcpServers: {} });
  });

  it("rejects foreign providers, paths, sessions and noncanonical schemas", () => {
    const root = "/private/tmp/remoteagent-claude/invocation-1";
    const settings = join(root, CLAUDE_CODE_SETTINGS_FILENAME);
    const mcp = join(root, CLAUDE_CODE_MCP_CONFIG_FILENAME);
    const valid = {
      profile: profile(),
      invocationRoot: root,
      settingsPath: settings,
      mcpConfigPath: mcp,
      outputSchemaJson: '{"type":"string"}',
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(() => createClaudePrintArgv({ ...valid, profile: profile("codex_cli") })).toThrow(
      /claude_code/u,
    );
    expect(() =>
      createClaudePrintArgv({ ...valid, settingsPath: "/private/tmp/settings.json" }),
    ).toThrow(/exact code-owned/u);
    expect(() => createClaudePrintArgv({ ...valid, sessionId: "not-a-uuid" })).toThrow(/UUID/u);
    expect(() =>
      createClaudePrintArgv({ ...valid, outputSchemaJson: '{ "type": "string" }' }),
    ).toThrow(/canonical/u);
  });
});
