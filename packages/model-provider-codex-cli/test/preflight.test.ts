import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { subscriptionModelProfileV1 } from "@remoteagent/model-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { CODEX_CLI_SUPPORTED_VERSION, createCodexSubscriptionAuthPreflight } from "../src/index.js";

const temporary: string[] = [];
const spawnedChildren: number[] = [];
afterEach(async () => {
  for (const pid of spawnedChildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // A successful process-tree cancellation already removed it.
    }
  }
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeCodex(input: {
  version?: string;
  auth?: string;
  authExitCode?: number;
  versionStderr?: string;
  authStderr?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), "ra-codex-preflight-"));
  temporary.push(root);
  const executable = join(root, "codex");
  const record = join(root, "record.jsonl");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }) + "\\n");
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(input.version ?? `codex-cli ${CODEX_CLI_SUPPORTED_VERSION}\n`)});
  process.stderr.write(${JSON.stringify(input.versionStderr ?? "")});
  process.exit(0);
}

if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write(${JSON.stringify(
    input.auth ?? (input.authStderr === undefined ? "Logged in using ChatGPT\n" : ""),
  )});
  process.stderr.write(${JSON.stringify(input.authStderr ?? "")});
  process.exit(${input.authExitCode ?? 0});
}
process.exit(64);
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable: await realpath(executable), record };
}

async function fakeHangingControl() {
  const root = await mkdtemp(join(tmpdir(), "ra-codex-preflight-cancel-"));
  temporary.push(root);
  const executable = join(root, "codex");
  const childPid = join(root, "child.pid");
  const source = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
setInterval(() => {}, 1000);
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable: await realpath(executable), childPid };
}

async function eventuallyRead(path: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function processIsAlive(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return false;
    }
  }
  return true;
}

async function profile(executable: string, provider: "codex_cli" | "claude_code" = "codex_cli") {
  return subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "codex-subscription",
    provider,
    executable,
    model: "gpt-5.6-codex",
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

describe("Codex subscription preflight", () => {
  it("pins the authenticated production CLI to the qualified exact version", () => {
    expect(CODEX_CLI_SUPPORTED_VERSION).toBe("0.153.3");
  });

  it("proves exact client version and ChatGPT subscription login with bounded argv/env", async () => {
    const fake = await fakeCodex({});
    const exactProfile = await profile(fake.executable);
    const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
      profile: exactProfile,
    });

    expect(result).toEqual({
      status: "SUBSCRIPTION_AUTHENTICATED",
      provider: "codex_cli",
      profile_name: "codex-subscription",
      client_version: CODEX_CLI_SUPPORTED_VERSION,
      model: "gpt-5.6-codex",
    });
    const calls = (await readFile(fake.record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[]; env: string[] });
    expect(calls.map(({ argv }) => argv)).toEqual([["--version"], ["login", "status"]]);
    for (const { env } of calls) {
      // macOS may synthesize this process metadata variable after spawn; it is
      // not forwarded from the caller and carries no provider authority.
      expect(env.filter((name) => name !== "__CF_USER_TEXT_ENCODING")).toEqual([
        "HOME",
        "LANG",
        "PATH",
      ]);
      expect(env).not.toContain("OPENAI_API_KEY");
    }
  });

  it("rejects version drift and never asks the changed client for auth", async () => {
    const fake = await fakeCodex({ version: "codex-cli 0.146.0\n" });
    const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
      profile: await profile(fake.executable),
    });
    expect(result).toEqual({
      status: "UNSUPPORTED_CLIENT",
      reason_code: "CLIENT_VERSION_MISMATCH",
    });
    expect((await readFile(fake.record, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it.each([
    ["Logged in using an API key\n", 0, "API_CREDENTIALS_PRESENT", "API_KEY_LOGIN_ACTIVE"],
    ["Not logged in\n", 1, "AUTH_REQUIRED", "CHATGPT_LOGIN_REQUIRED"],
    ["Logged in through something else\n", 0, "PREFLIGHT_FAILED", "UNKNOWN_AUTH_STATUS"],
  ] as const)(
    "classifies the strict auth status %s",
    async (auth, authExitCode, status, reasonCode) => {
      const fake = await fakeCodex({ auth, authExitCode });
      const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
        profile: await profile(fake.executable),
      });
      expect(result).toEqual({ status, reason_code: reasonCode });
    },
  );

  it("accepts the exact ChatGPT subscription status from stderr", async () => {
    const fake = await fakeCodex({ authStderr: "Logged in using ChatGPT\n" });
    const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
      profile: await profile(fake.executable),
    });

    expect(result).toEqual({
      status: "SUBSCRIPTION_AUTHENTICATED",
      provider: "codex_cli",
      profile_name: "codex-subscription",
      client_version: CODEX_CLI_SUPPORTED_VERSION,
      model: "gpt-5.6-codex",
    });
  });

  it.each([
    ["Logged in using an API key\n", 0, "API_CREDENTIALS_PRESENT", "API_KEY_LOGIN_ACTIVE"],
    ["Not logged in\n", 1, "AUTH_REQUIRED", "CHATGPT_LOGIN_REQUIRED"],
  ] as const)(
    "classifies the strict auth status from stderr: %s",
    async (authStderr, authExitCode, status, reasonCode) => {
      const fake = await fakeCodex({ authStderr, authExitCode });
      const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
        profile: await profile(fake.executable),
      });
      expect(result).toEqual({ status, reason_code: reasonCode });
    },
  );

  it("rejects auth status when stdout and stderr both carry control data", async () => {
    const fake = await fakeCodex({
      auth: "Logged in using ChatGPT\n",
      authStderr: "Logged in using ChatGPT\n",
    });
    const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
      profile: await profile(fake.executable),
    });

    expect(result).toEqual({
      status: "PREFLIGHT_FAILED",
      reason_code: "AUTH_STATUS_CHANNEL_MISMATCH",
    });
  });

  it("rejects API credential environment before spawning either control command", async () => {
    const fake = await fakeCodex({});
    const result = await createCodexSubscriptionAuthPreflight({
      environment: { ...environment, OPENAI_API_KEY: "must-not-be-used" },
    }).verify({ profile: await profile(fake.executable) });
    expect(result).toEqual({
      status: "API_CREDENTIALS_PRESENT",
      reason_code: "API_CREDENTIAL_ENVIRONMENT_PRESENT",
    });
    await expect(readFile(fake.record)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a foreign provider without spawning Codex", async () => {
    const fake = await fakeCodex({});
    const result = await createCodexSubscriptionAuthPreflight({ environment }).verify({
      profile: await profile(fake.executable, "claude_code"),
    });
    expect(result).toEqual({ status: "UNSUPPORTED_CLIENT", reason_code: "WRONG_PROVIDER" });
    await expect(readFile(fake.record)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels and escalates the complete subscription-control process tree", async () => {
    const fake = await fakeHangingControl();
    const controller = new AbortController();
    const pending = createCodexSubscriptionAuthPreflight({ environment }).verify({
      profile: await profile(fake.executable),
      signal: controller.signal,
    });
    const childPid = Number(await eventuallyRead(fake.childPid));
    spawnedChildren.push(childPid);
    controller.abort();
    await expect(pending).resolves.toEqual({
      status: "PREFLIGHT_FAILED",
      reason_code: "CONTROL_COMMAND_FAILED",
    });
    expect(await processIsAlive(childPid)).toBe(false);
  });
});
