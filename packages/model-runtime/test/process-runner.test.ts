import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  runSubscriptionProcess,
  runSubscriptionControlCommand,
  subscriptionModelProfileV1,
  subscriptionProcessEnvironment,
  type NormalizedSubscriptionModelEvent,
  type SubscriptionAuthPreflight,
} from "../src/index.js";

const temporary: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ra-model-runtime-"));
  temporary.push(root);
  return root;
}

async function profile(overrides: Record<string, unknown> = {}) {
  return subscriptionModelProfileV1.parse({
    schema_version: 1,
    profile_name: "codex-local",
    provider: "codex_cli",
    executable: await realpath(process.execPath),
    model: "gpt-5.6-codex",
    timeout_ms: 2_000,
    kill_grace_ms: 50,
    max_stdin_bytes: 1024,
    max_stdout_bytes: 4096,
    max_stderr_bytes: 1024,
    ...overrides,
  });
}

const authenticated: SubscriptionAuthPreflight = {
  verify: async ({ profile: exact }) => ({
    status: "SUBSCRIPTION_AUTHENTICATED",
    provider: exact.provider,
    profile_name: exact.profile_name,
    client_version: "1.2.3",
    model: exact.model,
  }),
};

const safeEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };

describe("subscription CLI process boundary", () => {
  it("constructs an allowlisted environment and refuses API/cloud authentication", () => {
    expect(
      subscriptionProcessEnvironment({
        ...safeEnvironment,
        RANDOM_SECRET: "not-forwarded",
      }),
    ).toEqual(safeEnvironment);
    for (const name of [
      "OPENAI_API_KEY",
      "OPENAI_ACCESS_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "AWS_PROFILE",
      "CLAUDE_CODE_USE_BEDROCK",
      "OPENAI_BASE_URL",
    ]) {
      expect(() =>
        subscriptionProcessEnvironment({ ...safeEnvironment, [name]: "present" }),
      ).toThrow(/forbidden/u);
    }
  });

  it("fails closed at subscription preflight without spawning the executable", async () => {
    const root = await fixture();
    const marker = join(root, "spawned");
    const result = await runSubscriptionProcess({
      profile: await profile(),
      argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      preflight: {
        verify: async () => ({ status: "AUTH_REQUIRED", reason_code: "LOGIN_REQUIRED" }),
      },
    });
    expect(result.outcome).toBe("AUTH_REQUIRED");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds and cancels subscription preflight before any process starts", async () => {
    const root = await fixture();
    const marker = join(root, "spawned");
    const hanging: SubscriptionAuthPreflight = {
      verify: async () => new Promise(() => undefined),
    };
    const startedAt = Date.now();
    const timedOut = await runSubscriptionProcess({
      profile: await profile({ timeout_ms: 1_000 }),
      argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      preflight: hanging,
    });
    expect(timedOut.outcome).toBe("TIMED_OUT");
    expect(Date.now() - startedAt).toBeLessThan(1_800);

    const controller = new AbortController();
    const cancelled = runSubscriptionProcess({
      profile: await profile({ timeout_ms: 10_000 }),
      argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      signal: controller.signal,
      preflight: hanging,
    });
    controller.abort();
    await expect(cancelled).resolves.toMatchObject({ outcome: "CANCELLED" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels the entire subscription process tree", async () => {
    const root = await fixture();
    const ready = join(root, "child-ready");
    const pidFile = join(root, "child-pid");
    const release = join(root, "release-child");
    const marker = join(root, "child-marker");
    const childScript = `const fs=require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const wait=setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(wait); fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); process.exit(0); } }, 10);`;
    const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore'}); setTimeout(() => {}, 10000);`;
    const controller = new AbortController();
    const running = runSubscriptionProcess({
      profile: await profile({ timeout_ms: 10_000, kill_grace_ms: 50 }),
      argv: ["-e", parentScript],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      signal: controller.signal,
      preflight: authenticated,
    });
    let childPid: number | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await readFile(ready);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await expect(readFile(ready, "utf8")).resolves.toBe("ready");
      const parsedChildPid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(parsedChildPid) && parsedChildPid > 1).toBe(true);
      if (!Number.isInteger(parsedChildPid) || parsedChildPid <= 1)
        throw new Error("child PID is invalid");
      childPid = parsedChildPid;
      controller.abort();
      await expect(running).resolves.toMatchObject({ outcome: "CANCELLED" });
      await writeFile(release, "release-after-cancel");
      const childExitDeadline = Date.now() + 5_000;
      let childExited = false;
      while (Date.now() < childExitDeadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          childExited = true;
          break;
        }
      }
      expect(childExited).toBe(true);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await running.catch(() => undefined);
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The process group cleanup may already have terminated the child.
        }
      }
    }
  });

  it("cancels the control-command process tree before rejecting", async () => {
    const root = await fixture();
    const ready = join(root, "control-child-ready");
    const pidFile = join(root, "control-child-pid");
    const release = join(root, "control-release-child");
    const marker = join(root, "control-child-marker");
    const childScript = `const fs=require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const wait=setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(wait); fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); process.exit(0); } }, 10);`;
    const parentScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore'}); setTimeout(() => {}, 10000);`;
    const controller = new AbortController();
    const running = runSubscriptionControlCommand({
      profile: await profile({ timeout_ms: 10_000, kill_grace_ms: 50 }),
      argv: ["-e", parentScript],
      environment: safeEnvironment,
      signal: controller.signal,
      deadline: Date.now() + 10_000,
    });
    let childPid: number | undefined;
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await readFile(ready);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      await expect(readFile(ready, "utf8")).resolves.toBe("ready");
      const parsedChildPid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(parsedChildPid) && parsedChildPid > 1).toBe(true);
      if (!Number.isInteger(parsedChildPid) || parsedChildPid <= 1)
        throw new Error("child PID is invalid");
      childPid = parsedChildPid;
      controller.abort();
      await expect(running).rejects.toThrow(/cancelled/u);
      await writeFile(release, "release-after-cancel");
      const childExitDeadline = Date.now() + 5_000;
      let childExited = false;
      while (Date.now() < childExitDeadline) {
        try {
          process.kill(childPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 20));
        } catch {
          childExited = true;
          break;
        }
      }
      expect(childExited).toBe(true);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await running.catch(() => undefined);
      if (childPid !== undefined) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The process group cleanup may already have terminated the child.
        }
      }
    }
  });

  it("uses argv without a shell and emits only normalized content-free events", async () => {
    const root = await fixture();
    const events: NormalizedSubscriptionModelEvent[] = [];
    const result = await runSubscriptionProcess({
      profile: await profile(),
      argv: ["-e", "process.stdin.pipe(process.stdout)", "; touch should-not-exist"],
      stdin: "hello",
      cwd: root,
      environment: { ...safeEnvironment, RANDOM_SECRET: "never-forwarded" },
      preflight: authenticated,
      onEvent: (event) => events.push(event),
    });
    expect(result).toMatchObject({ outcome: "SUCCEEDED", stdout: "hello", clientVersion: "1.2.3" });
    expect(events.map((event) => event.event)).toEqual([
      "PREFLIGHT_STARTED",
      "PREFLIGHT_FINISHED",
      "PROCESS_STARTED",
      "PROCESS_EXITED",
    ]);
    expect(JSON.stringify(events)).not.toContain("hello");
    await expect(readFile(join(root, "should-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a successful preflight whose exact provider identity differs from the profile", async () => {
    const root = await fixture();
    const marker = join(root, "spawned");
    await expect(
      runSubscriptionProcess({
        profile: await profile(),
        argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        stdin: "",
        cwd: root,
        environment: safeEnvironment,
        preflight: {
          verify: async ({ profile: exact }) => ({
            status: "SUBSCRIPTION_AUTHENTICATED",
            provider: exact.provider,
            profile_name: exact.profile_name,
            client_version: "1.2.3",
            model: "different-model",
          }),
        },
      }),
    ).rejects.toThrow(/identity does not match/u);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-canonical executable symlink before preflight", async () => {
    const root = await fixture();
    const link = join(root, "node-link");
    await symlink(await realpath(process.execPath), link);
    let calls = 0;
    await expect(
      runSubscriptionProcess({
        profile: await profile({ executable: link }),
        argv: ["--version"],
        stdin: "",
        cwd: root,
        environment: safeEnvironment,
        preflight: {
          verify: async () => ((calls += 1), authenticated.verify({ profile: await profile() })),
        },
      }),
    ).rejects.toThrow(/canonical/u);
    expect(calls).toBe(0);
  });

  it("kills the process group on timeout", async () => {
    const root = await fixture();
    const childPid = join(root, "child.pid");
    const script = join(root, "parent.cjs");
    await writeFile(
      script,
      `const {spawn}=require('node:child_process');\n` +
        `const {writeFileSync}=require('node:fs');\n` +
        `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);\n` +
        `writeFileSync(${JSON.stringify(childPid)},String(child.pid));\n` +
        `setInterval(()=>{},1000);\n`,
    );
    const result = await runSubscriptionProcess({
      profile: await profile({ timeout_ms: 1_000 }),
      argv: [script],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      preflight: authenticated,
    });
    expect(result.outcome).toBe("TIMED_OUT");
    const pid = Number(await readFile(childPid, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("bounds stdout and terminates the producer", async () => {
    const root = await fixture();
    const result = await runSubscriptionProcess({
      profile: await profile({ max_stdout_bytes: 32 }),
      argv: ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(()=>{},1000)"],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      preflight: authenticated,
    });
    expect(result.outcome).toBe("OUTPUT_LIMIT_EXCEEDED");
    expect(Buffer.byteLength(result.stdout)).toBe(32);
  });

  it("rejects invalid UTF-8 provider output", async () => {
    const root = await fixture();
    await expect(
      runSubscriptionProcess({
        profile: await profile(),
        argv: ["-e", "process.stdout.write(Buffer.from([0xff]))"],
        stdin: "",
        cwd: root,
        environment: safeEnvironment,
        preflight: authenticated,
      }),
    ).rejects.toThrow(/valid UTF-8/u);
  });

  it("cancels and kills a running process without waiting for the timeout", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const result = await runSubscriptionProcess({
      profile: await profile({ timeout_ms: 10_000 }),
      argv: ["-e", "setInterval(()=>{},1000)"],
      stdin: "",
      cwd: root,
      environment: safeEnvironment,
      signal: controller.signal,
      preflight: authenticated,
      onEvent: (event) => {
        if (event.event === "PROCESS_STARTED") controller.abort();
      },
    });
    expect(result.outcome).toBe("CANCELLED");
  });
});
