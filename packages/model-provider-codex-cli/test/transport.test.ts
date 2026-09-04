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

import { CodexCliTransport } from "../src/index.js";

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

async function fakeCodex(
  mode:
    | "success"
    | "malformed"
    | "malformed-once"
    | "failed"
    | "process-failed"
    | "process-failed-once"
    | "tool-boundary" = "success",
) {
  const root = await mkdtemp(join(tmpdir(), "ra-codex-transport-"));
  temporary.push(root);
  const executable = join(root, "codex");
  const record = join(root, "record.json");
  const counter = join(root, "counter.txt");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const argv = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const callCount = fs.existsSync(${JSON.stringify(counter)})
    ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) + 1
    : 1;
  fs.writeFileSync(${JSON.stringify(counter)}, String(callCount));
  const schemaPath = argv[argv.indexOf("--output-schema") + 1];
  const invocationRoot = argv[argv.indexOf("--cd") + 1];
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv,
    env: Object.keys(process.env).sort(),
    stdinBytes: Buffer.byteLength(stdin),
    stdinDigest: crypto.createHash("sha256").update(stdin).digest("hex"),
    invocationRoot,
    schemaPath,
  }));
  process.stderr.write("provider progress containing secret-prose");
  const session = { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" };
  const started = { type: "turn.started" };
  if (${JSON.stringify(mode)} === "process-failed" || (${JSON.stringify(mode)} === "process-failed-once" && callCount === 1)) {
    process.exitCode = 75;
    return;
  }
  if (${JSON.stringify(mode)} === "malformed" || (${JSON.stringify(mode)} === "malformed-once" && callCount === 1)) {
    process.stdout.write("{not-json}\\n");
    return;
  }
  process.stdout.write(JSON.stringify(session).slice(0, 17));
  setTimeout(() => {
    process.stdout.write(JSON.stringify(session).slice(17) + "\\n" + JSON.stringify(started) + "\\n");
    if (${JSON.stringify(mode)} === "failed") {
      process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "quota prose" } }) + "\\n");
      return;
    }
    if (${JSON.stringify(mode)} === "tool-boundary") {
      process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "built-in-1", type: "command_execution", command: "private" } }) + "\\n");
      return;
    }
    const digest = schema.properties.schema_digest.const;
    const answer = JSON.stringify({ schema_version: 1, schema_digest: digest, kind: "json", final: { schema_version: 1, answer: "ok" }, tool_call: null });
    const message = { type: "item.completed", item: { id: "message-1", type: "agent_message", text: answer } };
    const complete = { type: "turn.completed", usage: { input_tokens: 17, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2 } };
    process.stdout.write(JSON.stringify(message) + "\\n" + JSON.stringify(complete) + "\\n");
  }, 5);
});
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable: await realpath(executable), record, counter };
}

async function fakeToolCodex(toolTurns = 1) {
  const root = await mkdtemp(join(tmpdir(), "ra-codex-tool-transport-"));
  temporary.push(root);
  const executable = join(root, "codex");
  const record = join(root, "calls.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  const schemaPath = argv[argv.indexOf("--output-schema") + 1];
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const payload = JSON.parse(stdin);
  const calls = fs.existsSync(${JSON.stringify(record)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(record)}, "utf8")) : [];
  calls.push({ argv, invocationRoot: process.cwd(), payload });
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(calls));
  const digest = schema.properties.schema_digest.const;
  const shouldUseTool = calls.length <= ${JSON.stringify(toolTurns)};
  const envelope = shouldUseTool
    ? { schema_version: 1, schema_digest: digest, kind: "tool_use", final: null, tool_call: { id: "tool-call-1", name: payload.protocol.tools[0].name, input: { relative_path: "src/feature.ts" } } }
    : { schema_version: 1, schema_digest: digest, kind: "json", final: { schema_version: 1, answer: "complete" }, tool_call: null };
  const events = [
    { type: "thread.started", thread_id: "session-" + calls.length },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "message-1", type: "agent_message", text: JSON.stringify(envelope) } },
    { type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } },
  ];
  process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
});
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { root, executable: await realpath(executable), record };
}

async function fakeHangingCodex() {
  const root = await mkdtemp(join(tmpdir(), "ra-codex-cancel-"));
  temporary.push(root);
  const executable = join(root, "codex");
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
    profile_name: "codex-subscription",
    provider: "codex_cli",
    executable,
    model: "gpt-5.6-codex",
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
    provider: "codex_cli",
    profile_name: exact.profile_name,
    client_version: "0.147.0",
    model: exact.model,
  }),
};

const environment = { HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" };

describe("Codex CLI transport", () => {
  it("runs a split-chunk fake binary in an isolated root and returns only bound structured output", async () => {
    const fake = await fakeCodex();
    const events: NormalizedSubscriptionModelEvent[] = [];
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
      onEvent: (event) => events.push(event),
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
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
      config,
    );
    expect(response).toEqual({
      model: { provider: "codex_cli", model_id: "gpt-5.6-codex" },
      content: [{ type: "json", value: { schema_version: 1, answer: "ok" } }],
      usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 },
      requestId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
    });
    const record = JSON.parse(await readFile(fake.record, "utf8")) as {
      argv: string[];
      env: string[];
      stdinBytes: number;
      stdinDigest: string;
      invocationRoot: string;
      schemaPath: string;
    };
    expect(record.argv.slice(0, 4)).toEqual([
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
    ]);
    expect(record.argv).toContain("features.shell_tool=false");
    expect(record.argv).toContain('forced_login_method="chatgpt"');
    expect(record.argv.at(-1)).toBe("-");
    expect(record.stdinBytes).toBeGreaterThan(0);
    expect(record.stdinDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.schemaPath).toBe(join(record.invocationRoot, "response.schema.json"));
    await expect(realpath(record.invocationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify({ response, events, record })).not.toContain("secret-prose");
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it.each([
    ["malformed", "MALFORMED_OUTPUT"],
    ["failed", "QUOTA_OR_PROVIDER_FAILED"],
  ] as const)("fails closed on %s provider output", async (mode, outcome) => {
    const fake = await fakeCodex(mode);
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    });
    await expect(
      transport.converse(
        { messages: [{ role: "user", content: [{ type: "text", text: "task" }] }] },
        config,
      ),
    ).rejects.toEqual(expect.objectContaining({ outcome }));
  });

  it("retries one malformed transcript before any custom tool can be dispatched", async () => {
    const fake = await fakeCodex("malformed-once");
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
    });

    const result = await runToolLoop(transport, config, {
      messages: [{ role: "user", content: [{ type: "text", text: "bounded retry" }] }],
      tools: [],
      outputSchema: {
        name: "AnswerV1",
        schema: {
          type: "object",
          properties: { schema_version: { const: 1 }, answer: { type: "string" } },
          required: ["schema_version", "answer"],
          additionalProperties: false,
        },
      },
      execute: async () => {
        throw new Error("no tool is available");
      },
      execution: { sleep: async () => undefined },
    });

    expect(result.transportAttempts).toBe(2);
    expect(result.content).toEqual([{ type: "json", value: { schema_version: 1, answer: "ok" } }]);
    expect(await readFile(fake.counter, "utf8")).toBe("2");
  });

  it("retries one authenticated process failure before any custom tool can be dispatched", async () => {
    const fake = await fakeCodex("process-failed-once");
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
    });

    const result = await runToolLoop(transport, config, {
      messages: [{ role: "user", content: [{ type: "text", text: "bounded process retry" }] }],
      tools: [],
      outputSchema: {
        name: "AnswerV1",
        schema: {
          type: "object",
          properties: { schema_version: { const: 1 }, answer: { type: "string" } },
          required: ["schema_version", "answer"],
          additionalProperties: false,
        },
      },
      execute: async () => {
        throw new Error("no tool is available");
      },
      execution: { sleep: async () => undefined },
    });

    expect(result.transportAttempts).toBe(2);
    expect(result.content).toEqual([{ type: "json", value: { schema_version: 1, answer: "ok" } }]);
    expect(await readFile(fake.counter, "utf8")).toBe("2");
  });

  it("keeps an exhausted process failure structural and content-free", async () => {
    const fake = await fakeCodex("process-failed");
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
    });

    const failure = await transport
      .converse(
        {
          messages: [{ role: "user", content: [{ type: "text", text: "bounded refusal" }] }],
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
        config,
      )
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      providerCode: "CODEX_CLI_PROCESS_FAILED",
      outcome: "FAILED",
      detailCode: "PROCESS_EXIT_FAILED",
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain("secret-prose");
    expect(failure instanceof Error ? failure.message : "").not.toContain("secret-prose");
  });

  it.each([
    ["failed", "QUOTA_OR_PROVIDER_FAILED"],
    ["tool-boundary", "TOOL_BOUNDARY_VIOLATION"],
  ] as const)("never retries %s output", async (mode, outcome) => {
    const fake = await fakeCodex(mode);
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 0 },
    });

    await expect(
      runToolLoop(transport, config, {
        messages: [{ role: "user", content: [{ type: "text", text: "no retry" }] }],
        tools: [],
        outputSchema: {
          name: "AnswerV1",
          schema: {
            type: "object",
            properties: { schema_version: { const: 1 }, answer: { type: "string" } },
            required: ["schema_version", "answer"],
            additionalProperties: false,
          },
        },
        execute: async () => {
          throw new Error("no tool is available");
        },
        execution: { sleep: async () => undefined },
      }),
    ).rejects.toEqual(expect.objectContaining({ outcome, retryable: false }));
    expect(await readFile(fake.counter, "utf8")).toBe("1");
  });

  it("round-trips one proposed tool through the provider-neutral bounded loop", async () => {
    const fake = await fakeToolCodex();
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 2, maxCalls: 2 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    });
    const executions: unknown[] = [];
    const result = await runToolLoop(transport, config, {
      messages: [{ role: "user", content: [{ type: "text", text: "bounded task" }] }],
      tools: [
        {
          name: "files.read",
          description: "Read one bounded repository path",
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
    });

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
      argv: string[];
      invocationRoot: string;
      payload: { messages: { role: string; content: unknown[] }[]; protocol: { tools: unknown[] } };
    }[];
    expect(calls).toHaveLength(2);
    expect(calls[0]?.payload.protocol.tools).toHaveLength(1);
    expect(calls[1]?.payload.messages.some((message) => message.role === "tool")).toBe(true);
    expect(new Set(calls.map(({ invocationRoot: root }) => root)).size).toBe(2);
    for (const call of calls) {
      expect(call.argv).toContain("features.shell_tool=false");
      await expect(realpath(call.invocationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("namespaces repeated model-local tool ids by fresh Codex session", async () => {
    const fake = await fakeToolCodex(2);
    const exactProfile = await profile(fake.executable);
    const transport = new CodexCliTransport({
      profile: exactProfile,
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 2_000,
      toolLimits: { maxIterations: 3, maxCalls: 3 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    });
    let executions = 0;
    const result = await runToolLoop(transport, config, {
      messages: [{ role: "user", content: [{ type: "text", text: "two bounded reads" }] }],
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
      execute: async () => {
        executions += 1;
        return { outcome: "SUCCEEDED" };
      },
    });

    const ids = result.history.flatMap((message) =>
      message.content.flatMap((item) => (item.type === "tool-use" ? [item.id] : [])),
    );
    expect(executions).toBe(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^sha256:[0-9a-f]{64}$/u.test(id))).toBe(true);
  });

  it("cancels the complete fake Codex process tree and removes the invocation root", async () => {
    const fake = await fakeHangingCodex();
    const exactProfile = await profile(fake.executable);
    const controller = new AbortController();
    const transport = new CodexCliTransport({
      profile: { ...exactProfile, timeout_ms: 10_000 },
      preflight: authenticated,
      environment,
      temporaryParent: fake.root,
    });
    const config = createRuntimeConfig({
      model: { provider: "codex_cli", model_id: exactProfile.model },
      timeoutMs: 10_000,
      toolLimits: { maxIterations: 0, maxCalls: 0 },
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    });
    const pending = transport.converse(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "cancel" }] }],
        signal: controller.signal,
      },
      config,
    );
    const childPid = Number(await eventuallyRead(fake.childPid));
    spawnedChildren.push(childPid);
    const invocationRoot = await eventuallyRead(fake.invocationRoot);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RuntimeCancelledError);
    expect(await processIsAlive(childPid)).toBe(false);
    await expect(realpath(invocationRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
