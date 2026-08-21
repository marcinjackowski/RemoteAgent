import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRunnerError, runProcess } from "../src/index.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("confined process runner", () => {
  /**
   * Two claims, deliberately split into two assertions (`CTF-003`).
   *
   * The original test asserted "the tree was killed" by reading a `child.pid` file
   * the grandchild writes, under a 100 ms timeout. That races: the timeout can fire
   * before the grandchild has written the file, and the read then fails with
   * `ENOENT` — a flake measured at 1 fail per 4 full-repo runs while passing 6/6 in
   * isolation. The race was in the test, not in `runProcess`.
   *
   * The fix is to stop conflating two independent facts. "The parent timed out" is
   * observable from the result alone. "The grandchild was killed too" first requires
   * the grandchild to exist, so the timeout is given room and the file is polled
   * with its own, longer budget before anything is asserted about the pid.
   */
  it("reports a timeout for a process that outlives its limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    roots.push(root);
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      workspaceRoot: root,
      limits: { timeoutMs: 100, outputBytes: 1024 },
      network: "ALLOW",
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("kills the whole process tree, not just the direct child", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    roots.push(root);
    const script = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "fs.writeFileSync('child.pid', String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    // Generous enough that the grandchild reliably starts and records its pid, so
    // the assertion below is about `killTree` rather than about scheduling luck.
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", script],
      workspaceRoot: root,
      limits: { timeoutMs: 3_000, outputBytes: 1024 },
      network: "ALLOW",
    });
    expect(result.timedOut).toBe(true);

    // Poll rather than read once: the file's existence is a precondition of the
    // real assertion, so a missing file must not be reported as a kill failure.
    let recorded = "";
    for (let attempt = 0; attempt < 50 && recorded === ""; attempt += 1) {
      recorded = await readFile(join(root, "child.pid"), "utf8").catch(() => "");
      if (recorded === "") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(recorded, "grandchild never recorded its pid").not.toBe("");

    const childPid = Number(recorded);
    expect(Number.isInteger(childPid)).toBe(true);
    // The load-bearing assertion: the grandchild is gone, so the kill reached the
    // whole tree and not merely the process we spawned.
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("fails closed before spawn when CPU or memory enforcement is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    roots.push(root);
    await expect(
      runProcess({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        workspaceRoot: root,
        limits: { timeoutMs: 1000, cpuTimeMs: 10 },
        network: "ALLOW",
      }),
    ).rejects.toMatchObject<ProcessRunnerError>({ code: "NOT_ENFORCEABLE" });
  });

  it("rejects cwd escape and symlink cwd before spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    const sibling = await mkdtemp(join(tmpdir(), "workspace-sibling-"));
    roots.push(root);
    roots.push(sibling);
    await symlink(sibling, join(root, "link"));
    const input = {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      workspaceRoot: root,
      limits: { timeoutMs: 1000 },
      network: "ALLOW" as const,
    };
    await expect(runProcess({ ...input, cwd: "../" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
    await expect(runProcess({ ...input, cwd: "link" })).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
    });
  });

  it("rejects credential-like environment and truncates output", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    roots.push(root);
    await expect(
      runProcess({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        workspaceRoot: root,
        env: { GIT_TOKEN: "secret" },
        limits: { timeoutMs: 1000 },
        network: "ALLOW",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ENVIRONMENT" });
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(4096))"],
      workspaceRoot: root,
      limits: { timeoutMs: 1000, outputBytes: 64 },
      network: "ALLOW",
    });
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64);
  });

  it("confines reads and writes to the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    const sibling = await mkdtemp(join(tmpdir(), "workspace-sibling-"));
    roots.push(root, sibling);
    await writeFile(join(sibling, "secret"), "outside");
    const unsandboxed = await execFileAsync(process.execPath, [
      "-e",
      `require('node:fs').readFileSync(${JSON.stringify(join(sibling, "secret"))}); require('node:fs').writeFileSync(${JSON.stringify(join(sibling, "out"))}, 'outside');`,
    ]);
    expect(unsandboxed.stderr).toBe("");
    expect(await readFile(join(sibling, "out"), "utf8")).toBe("outside");
    await rm(join(sibling, "out"));
    const script = [
      "const fs = require('node:fs');",
      `try { fs.readFileSync(${JSON.stringify(join(sibling, "secret"))}); process.exitCode = 1; } catch {}`,
      `try { fs.writeFileSync(${JSON.stringify(join(sibling, "out"))}, 'bad'); process.exitCode = 1; } catch {}`,
      "fs.writeFileSync('inside', 'ok');",
    ].join(" ");
    const result = await runProcess({
      executable: process.execPath,
      args: ["-e", script],
      workspaceRoot: root,
      limits: { timeoutMs: 1000 },
      network: "ALLOW",
    });
    expect(result.exitCode).toBe(0);
    await expect(readFile(join(sibling, "out"))).rejects.toThrow();
    await expect(readFile(join(root, "inside"), "utf8")).resolves.toBe("ok");
  });

  it("rejects relative and symlink executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-process-"));
    const sibling = await mkdtemp(join(tmpdir(), "workspace-sibling-"));
    roots.push(root, sibling);
    const linked = join(root, "node");
    await symlink(process.execPath, linked);
    const input = {
      args: ["-e", "process.exit(0)"],
      workspaceRoot: root,
      limits: { timeoutMs: 1000 },
      network: "ALLOW" as const,
    };
    await expect(runProcess({ ...input, executable: "node" })).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
    await expect(runProcess({ ...input, executable: linked })).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
  });
});
