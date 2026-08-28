import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { subscriptionModelProfileV1 } from "@remoteagent/model-runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_CODE_SUPPORTED_VERSIONS,
  createClaudeSubscriptionAuthPreflight,
} from "../src/index.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeClaude(input: {
  version?: string;
  auth?: unknown;
  authText?: string;
  authExitCode?: number;
  stderr?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "ra-claude-preflight-"));
  temporary.push(root);
  const executable = join(root, "claude");
  const record = join(root, "record.jsonl");
  const auth =
    input.authText ??
    `${JSON.stringify(input.auth ?? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "discarded@example.invalid" })}\n`;
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }) + "\\n");
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(input.version ?? `${CLAUDE_CODE_SUPPORTED_VERSIONS[0]} (Claude Code)\n`)});
  process.stderr.write(${JSON.stringify(input.stderr ?? "")});
  process.exit(0);
}
if (process.argv[2] === "auth" && process.argv[3] === "status" && process.argv[4] === "--json") {
  process.stdout.write(${JSON.stringify(auth)});
  process.stderr.write(${JSON.stringify(input.stderr ?? "")});
  process.exit(${input.authExitCode ?? 0});
}
process.exit(64);
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable: await realpath(executable), record };
}

async function profile(executable: string, provider: "codex_cli" | "claude_code" = "claude_code") {
  return subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "claude-subscription",
    provider,
    executable,
    model: "claude-opus-4-8",
    timeout_ms: 2_000,
    kill_grace_ms: 50,
    max_stdin_bytes: 16_384,
    max_stdout_bytes: 65_536,
    max_stderr_bytes: 4096,
  });
}

const environment = Object.freeze({
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
});

describe("Claude subscription preflight", () => {
  it("proves an allowed client and exact first-party Claude subscription auth", async () => {
    const fake = await fakeClaude({});
    const result = await createClaudeSubscriptionAuthPreflight({ environment }).verify({
      profile: await profile(fake.executable),
    });
    expect(result).toEqual({
      status: "SUBSCRIPTION_AUTHENTICATED",
      provider: "claude_code",
      profile_name: "claude-subscription",
      client_version: CLAUDE_CODE_SUPPORTED_VERSIONS[0],
      model: "claude-opus-4-8",
    });
    const calls = (await readFile(fake.record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; env: string[] });
    expect(calls.map(({ argv }) => argv)).toEqual([["--version"], ["auth", "status", "--json"]]);
    for (const { env } of calls) {
      expect(env.filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual([
        "HOME",
        "LANG",
        "PATH",
      ]);
    }
    expect(JSON.stringify(result)).not.toContain("discarded@example.invalid");
  });

  it("rejects version drift before reading auth status", async () => {
    const fake = await fakeClaude({ version: "2.1.247 (Claude Code)\n" });
    await expect(
      createClaudeSubscriptionAuthPreflight({ environment }).verify({
        profile: await profile(fake.executable),
      }),
    ).resolves.toEqual({ status: "UNSUPPORTED_CLIENT", reason_code: "CLIENT_VERSION_MISMATCH" });
    expect((await readFile(fake.record, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it.each([
    [
      { loggedIn: false, authMethod: "none", apiProvider: "none" },
      1,
      "AUTH_REQUIRED",
      "CLAUDE_SUBSCRIPTION_LOGIN_REQUIRED",
    ],
    [
      { loggedIn: true, authMethod: "console", apiProvider: "firstParty" },
      0,
      "API_CREDENTIALS_PRESENT",
      "NON_SUBSCRIPTION_LOGIN_ACTIVE",
    ],
    [
      { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
      0,
      "API_CREDENTIALS_PRESENT",
      "NON_SUBSCRIPTION_LOGIN_ACTIVE",
    ],
    [
      { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" },
      0,
      "API_CREDENTIALS_PRESENT",
      "NON_SUBSCRIPTION_LOGIN_ACTIVE",
    ],
    [
      { loggedIn: true, authMethod: "unknown", apiProvider: "unknown" },
      0,
      "PREFLIGHT_FAILED",
      "UNKNOWN_AUTH_STATUS",
    ],
  ] as const)(
    "classifies non-subscription auth %#",
    async (auth, authExitCode, status, reasonCode) => {
      const fake = await fakeClaude({ auth, authExitCode });
      await expect(
        createClaudeSubscriptionAuthPreflight({ environment }).verify({
          profile: await profile(fake.executable),
        }),
      ).resolves.toEqual({ status, reason_code: reasonCode });
    },
  );

  it.each([
    { ANTHROPIC_API_KEY: "forbidden" },
    { ANTHROPIC_AUTH_TOKEN: "forbidden" },
    { CLAUDE_CODE_OAUTH_TOKEN: "forbidden" },
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_VERTEX: "1" },
    { CLAUDE_CODE_USE_FOUNDRY: "1" },
  ])("rejects credential or cloud environment before spawning %#", async (injected) => {
    const fake = await fakeClaude({});
    const result = await createClaudeSubscriptionAuthPreflight({
      environment: { ...environment, ...injected },
    }).verify({ profile: await profile(fake.executable) });
    expect(result).toEqual({
      status: "API_CREDENTIALS_PRESENT",
      reason_code: "API_CREDENTIAL_ENVIRONMENT_PRESENT",
    });
    await expect(readFile(fake.record)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed auth JSON and a foreign provider", async () => {
    const fake = await fakeClaude({ authText: "not-json\n" });
    await expect(
      createClaudeSubscriptionAuthPreflight({ environment }).verify({
        profile: await profile(fake.executable),
      }),
    ).resolves.toEqual({ status: "PREFLIGHT_FAILED", reason_code: "UNKNOWN_AUTH_STATUS" });
    const foreign = await fakeClaude({});
    await expect(
      createClaudeSubscriptionAuthPreflight({ environment }).verify({
        profile: await profile(foreign.executable, "codex_cli"),
      }),
    ).resolves.toEqual({ status: "UNSUPPORTED_CLIENT", reason_code: "WRONG_PROVIDER" });
    await expect(readFile(foreign.record)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
