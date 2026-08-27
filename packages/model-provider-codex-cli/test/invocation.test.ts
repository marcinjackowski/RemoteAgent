import { join } from "node:path";

import { subscriptionModelProfileV1 } from "@remoteagent/model-runtime";
import { describe, expect, it } from "vitest";

import {
  CODEX_CLI_RESPONSE_SCHEMA_FILENAME,
  CODEX_CLI_SAFETY_CONFIG,
  createCodexExecArgv,
} from "../src/index.js";

function profile(provider: "codex_cli" | "claude_code" = "codex_cli") {
  return subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "codex-subscription",
    provider,
    executable: "/opt/remoteagent/bin/codex",
    model: "gpt-5.6-codex",
    timeout_ms: 120_000,
    kill_grace_ms: 250,
    max_stdin_bytes: 262_144,
    max_stdout_bytes: 1_048_576,
    max_stderr_bytes: 65_536,
  });
}

describe("Codex CLI invocation", () => {
  it("pins the official non-interactive client and every no-authority setting", () => {
    const root = "/private/tmp/remoteagent-codex/invocation-1";
    const schema = join(root, CODEX_CLI_RESPONSE_SCHEMA_FILENAME);
    const argv = createCodexExecArgv({
      profile: profile(),
      invocationRoot: root,
      outputSchemaPath: schema,
    });

    expect(argv).toEqual([
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
      "gpt-5.6-codex",
      "--sandbox",
      "read-only",
      "--output-schema",
      schema,
      "--cd",
      root,
      ...CODEX_CLI_SAFETY_CONFIG.flatMap((value) => ["--config", value]),
      "-",
    ]);
    expect(argv).toContain("features.shell_tool=false");
    expect(argv).toContain('web_search="disabled"');
    expect(argv).toContain('forced_login_method="chatgpt"');
    expect(argv).not.toContain("--profile");
    expect(argv.join(" ")).not.toMatch(/danger-full-access|workspace-write|--search|--add-dir/u);
    expect(Object.isFrozen(argv)).toBe(true);
  });

  it("rejects a foreign provider and any schema path outside the exact empty root", () => {
    const root = "/private/tmp/remoteagent-codex/invocation-1";
    expect(() =>
      createCodexExecArgv({
        profile: profile("claude_code"),
        invocationRoot: root,
        outputSchemaPath: join(root, CODEX_CLI_RESPONSE_SCHEMA_FILENAME),
      }),
    ).toThrow(/codex_cli/u);
    expect(() =>
      createCodexExecArgv({
        profile: profile(),
        invocationRoot: root,
        outputSchemaPath: "/private/tmp/foreign.schema.json",
      }),
    ).toThrow(/exact code-owned file/u);
    expect(() =>
      createCodexExecArgv({
        profile: profile(),
        invocationRoot: `${root}/../invocation-1`,
        outputSchemaPath: join(root, CODEX_CLI_RESPONSE_SCHEMA_FILENAME),
      }),
    ).toThrow(/normalized/u);
  });
});
