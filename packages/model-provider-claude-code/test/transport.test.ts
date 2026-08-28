import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimeConfig,
  runToolLoop,
  RuntimeCancelledError,
  subscriptionModelProfileV1,
  type NormalizedSubscriptionModelEvent,
  type SubscriptionAuthPreflight,
} from "@remoteagent/model-runtime";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCodeTransport } from "../src/index.js";

const temporary: string[] = [];
const spawnedChildren: number[] = [];
afterEach(async () => {
  for (const pid of spawnedChildren.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process-tree cancellation normally removes it first.
    }
  }
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeClaude(mode: "success" | "malformed" | "provider-error" = "success") {
  const root = await mkdtemp(join(tmpdir(), "ra-claude-transport-"));
  temporary.push(root);
  const executable = join(root, "claude");
  const record = join(root, "record.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const settingsPath = argv[argv.indexOf("--settings") + 1];
  const mcpPath = argv[argv.indexOf("--mcp-config") + 1];
  const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1]);
  const session = argv[argv.indexOf("--session-id") + 1];
  const model = argv[argv.indexOf("--model") + 1];
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv,
    env: Object.keys(process.env).sort(),
    stdinBytes: Buffer.byteLength(stdin),
    stdinDigest: crypto.createHash("sha256").update(stdin).digest("hex"),
    invocationRoot: process.cwd(),
    settings: JSON.parse(fs.readFileSync(settingsPath, "utf8")),
    mcp: JSON.parse(fs.readFileSync(mcpPath, "utf8")),
  }));
  process.stderr.write("private provider progress");
  if (${JSON.stringify(mode)} === "malformed") {
    process.stdout.write("{not-json}\\n");
    return;
  }
  if (${JSON.stringify(mode)} === "provider-error") {
    const events = [
      { type: "system", subtype: "init", uuid: "init-1", session_id: session, apiKeySource: "none", claude_code_version: "2.1.248", cwd: process.cwd(), tools: [], mcp_servers: [], model, permissionMode: "plan", slash_commands: [], output_style: "default", skills: [], plugins: [] },
      { type: "result", subtype: "error_during_execution", uuid: "result-1", session_id: session, is_error: true, errors: ["private provider failure"] },
    ];
    process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
    process.exitCode = 1;
    return;
  }
  const structured = { schema_version: 1, schema_digest: schema.properties.schema_digest.const, kind: "json", final: { schema_version: 1, answer: "ok" }, tool_call: null };
  const events = [
    { type: "system", subtype: "init", uuid: "init-1", session_id: session, apiKeySource: "none", claude_code_version: "2.1.248", cwd: process.cwd(), tools: [], mcp_servers: [], model, permissionMode: "plan", slash_commands: [], output_style: "default", skills: [], plugins: [] },
    { type: "assistant", uuid: "assistant-1", session_id: session, parent_tool_use_id: null, message: { model, content: [{ type: "text", text: "private reasoning" }] } },
    { type: "result", subtype: "success", uuid: "result-1", session_id: session, is_error: false, num_turns: 1, result: "private result", usage: { input_tokens: 17, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 17, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 32000, canonicalModel: model, provider: "firstParty" } }, permission_denials: [], structured_output: structured, terminal_reason: "completed" },
  ];
  const output = events.map(JSON.stringify).join("\\n") + "\\n";
  process.stdout.write(output.slice(0, 31));
  setTimeout(() => process.stdout.write(output.slice(31)), 5);
});
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable: await realpath(executable), record };
}

async function fakeHangingClaude() {
  const root = await mkdtemp(join(tmpdir(), "ra-claude-cancel-"));
  temporary.push(root);
  const executable = join(root, "claude");
  const childPid = join(root, "child.pid");
  const invocationRoot = join(root, "invocation-root");
  const source = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
writeFileSync(${JSON.stringify(invocationRoot)}, process.cwd());
setInterval(() => {}, 1000);
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable: await realpath(executable), childPid, invocationRoot };
}

async function fakeToolClaude() {
  const root = await mkdtemp(join(tmpdir(), "ra-claude-tool-"));
  temporary.push(root);
  const executable = join(root, "claude");
  const record = join(root, "calls.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1]);
  const session = argv[argv.indexOf("--session-id") + 1];
  const model = argv[argv.indexOf("--model") + 1];
  const payload = JSON.parse(stdin);
  const calls = fs.existsSync(${JSON.stringify(record)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(record)}, "utf8")) : [];
  calls.push({ argv, invocationRoot: process.cwd(), payload });
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(calls));
  const digest = schema.properties.schema_digest.const;
  const hasToolResult = payload.messages.some((message) => message.role === "tool");
  const structured = hasToolResult
    ? { schema_version: 1, schema_digest: digest, kind: "json", final: { schema_version: 1, answer: "complete" }, tool_call: null }
    : { schema_version: 1, schema_digest: digest, kind: "tool_use", final: null, tool_call: { id: "call-1", name: payload.protocol.tools[0].name, input: { relative_path: "src/feature.ts" } } };
  const events = [
    { type: "system", subtype: "init", uuid: "init-1", session_id: session, apiKeySource: "none", claude_code_version: "2.1.248", cwd: process.cwd(), tools: [], mcp_servers: [], model, permissionMode: "plan", slash_commands: [], output_style: "default", skills: [], plugins: [] },
    { type: "result", subtype: "success", uuid: "result-1", session_id: session, is_error: false, num_turns: 1, result: "discard", usage: { input_tokens: 7, output_tokens: 3 }, modelUsage: { [model]: { inputTokens: 7, outputTokens: 3, canonicalModel: model, provider: "firstParty" } }, permission_denials: [], structured_output: structured, terminal_reason: "completed" },
  ];
  process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
});
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable: await realpath(executable), record };
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

async function profile(executable: string) {
  return subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "claude-subscription",
    provider: "claude_code",
    executable,
    model: "claude-opus-4-8",
    timeout_ms: 2_000,
    kill_grace_ms: 50,
    max_stdin_bytes: 65_536,
    max_stdout_bytes: 65_536,
    max_stderr_bytes: 4096,
  });
}

const authenticated: SubscriptionAuthPreflight = {
  verify: async ({ profile: exact }) => ({
    status: "SUBSCRIPTION_AUTHENTICATED",
    provider: "claude_code",
    profile_name: exact.profile_name,
    client_version: "2.1.248",
    model: exact.model,
  }),
};
const environment = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" };
const sessionId = "550e8400-e29b-41d4-a716-446655440000";

describe("Claude Code transport", () => {
  it("runs a split-chunk fake binary in an empty root and retains only bound structured output", async () => {
    const fake = await fakeClaude();
    const events: NormalizedSubscriptionModelEvent[] = [];
    const exactProfile = await profile(fake.executable);
    const transport = new ClaudeCodeTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
      sessionIdFactory: () => sessionId,
      onEvent: (event) => events.push(event),
    });
    const response = await transport.converse(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "untrusted task" }] }],
        outputSchema: {
          name: "AnswerV1",
          schema: {
            type: "object",
            properties: { schema_version: { const: 1 }, answer: { type: "string" } },
            required: ["schema_version", "answer"],
            additionalProperties: false,
          },
        },
      },
      createRuntimeConfig({
        model: { provider: "claude_code", model_id: exactProfile.model },
        timeoutMs: 2_000,
        toolLimits: { maxIterations: 0, maxCalls: 0 },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      }),
    );
    expect(response).toEqual({
      model: { provider: "claude_code", model_id: "claude-opus-4-8" },
      content: [{ type: "json", value: { schema_version: 1, answer: "ok" } }],
      usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 },
      requestId: sessionId,
    });
    const record = JSON.parse(await readFile(fake.record, "utf8")) as {
      argv: string[];
      stdinBytes: number;
      stdinDigest: string;
      invocationRoot: string;
      settings: Record<string, unknown>;
      mcp: Record<string, unknown>;
    };
    expect(record.argv).toContain("--restricted");
    expect(record.argv).toContain("--safe-mode");
    expect(record.argv).not.toContain("--fallback-model");
    expect(record.stdinBytes).toBeGreaterThan(0);
    expect(record.stdinDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.settings).toMatchObject({ disableAllHooks: true, includeGitInstructions: false });
    expect(record.mcp).toEqual({ mcpServers: {} });
    await expect(realpath(record.invocationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify({ response, events, record })).not.toMatch(
      /private provider|private reasoning|private result/u,
    );
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("fails closed on malformed provider output", async () => {
    const fake = await fakeClaude("malformed");
    const exactProfile = await profile(fake.executable);
    const transport = new ClaudeCodeTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
      sessionIdFactory: () => sessionId,
    });
    await expect(
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "task" }] }] },
        createRuntimeConfig({
          model: { provider: "claude_code", model_id: exactProfile.model },
          timeoutMs: 2_000,
          toolLimits: { maxIterations: 0, maxCalls: 0 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        }),
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome: "MALFORMED_OUTPUT" }));
  });

  it("maps a nonzero typed provider result without retaining its prose", async () => {
    const fake = await fakeClaude("provider-error");
    const exactProfile = await profile(fake.executable);
    const events: NormalizedSubscriptionModelEvent[] = [];
    const transport = new ClaudeCodeTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
      sessionIdFactory: () => sessionId,
      onEvent: (event) => events.push(event),
    });
    await expect(
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "task" }] }] },
        createRuntimeConfig({
          model: { provider: "claude_code", model_id: exactProfile.model },
          timeoutMs: 2_000,
          toolLimits: { maxIterations: 0, maxCalls: 0 },
          retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
        }),
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome: "PROVIDER_FAILED" }));
    expect(JSON.stringify(events)).not.toContain("private provider failure");
  });

  it("round-trips one proposed tool through the provider-neutral bounded loop", async () => {
    const fake = await fakeToolClaude();
    const exactProfile = await profile(fake.executable);
    let session = 0;
    const transport = new ClaudeCodeTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
      sessionIdFactory: () => {
        session += 1;
        return session === 1
          ? "550e8400-e29b-41d4-a716-446655440001"
          : "550e8400-e29b-41d4-a716-446655440002";
      },
    });
    const executions: unknown[] = [];
    const result = await runToolLoop(
      transport,
      createRuntimeConfig({
        model: { provider: "claude_code", model_id: exactProfile.model },
        timeoutMs: 2_000,
        toolLimits: { maxIterations: 2, maxCalls: 2 },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      }),
      {
        messages: [{ role: "user", content: [{ type: "text", text: "bounded task" }] }],
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
        outputSchema: {
          name: "AnswerV1",
          schema: {
            type: "object",
            properties: { schema_version: { const: 1 }, answer: { type: "string" } },
            required: ["schema_version", "answer"],
            additionalProperties: false,
          },
        },
        execute: async (name, input) => {
          executions.push({ name, input });
          return { outcome: "SUCCEEDED", content: "bounded result" };
        },
      },
    );
    expect(executions).toEqual([
      { name: "files.read", input: { relative_path: "src/feature.ts" } },
    ]);
    expect(result).toMatchObject({
      content: [{ type: "json", value: { schema_version: 1, answer: "complete" } }],
      iterations: 1,
      calls: 1,
      transportAttempts: 2,
    });
    const calls = JSON.parse(await readFile(fake.record, "utf8")) as {
      invocationRoot: string;
      payload: { messages: { role: string }[]; protocol: { tools: unknown[] } };
    }[];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.payload.protocol.tools).toHaveLength(1);
    expect(calls[1]?.payload.messages.some((message) => message.role === "tool")).toBe(true);
    expect(new Set(calls.map(({ invocationRoot }) => invocationRoot)).size).toBe(2);
  });

  it("cancels the complete process tree and removes its invocation root", async () => {
    const fake = await fakeHangingClaude();
    const exactProfile = await profile(fake.executable);
    const controller = new AbortController();
    const transport = new ClaudeCodeTransport({
      profile: { ...exactProfile, timeout_ms: 10_000 },
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
      sessionIdFactory: () => sessionId,
    });
    const pending = transport.converse(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "task" }] }],
        signal: controller.signal,
      },
      createRuntimeConfig({
        model: { provider: "claude_code", model_id: exactProfile.model },
        timeoutMs: 10_000,
        toolLimits: { maxIterations: 0, maxCalls: 0 },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      }),
    );
    const childPid = Number(await eventuallyRead(fake.childPid));
    spawnedChildren.push(childPid);
    const root = await eventuallyRead(fake.invocationRoot);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(await processIsAlive(childPid)).toBe(false);
    await expect(realpath(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
