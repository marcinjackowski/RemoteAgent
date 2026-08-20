import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessRunnerError, runProcess } from "../src/index.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("network deny policy", () => {
  it("allows an ordinary process to connect but denies the runner process", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-network-"));
    roots.push(root);
    const server = createServer((socket) => socket.end("ok"));
    try {
      await promisify(server.listen.bind(server))(0, "127.0.0.1");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      const script = [
        "const net = require('node:net');",
        `const socket = net.connect(${address.port}, '127.0.0.1', () => { console.log('connected'); socket.end(); });`,
        "socket.on('error', () => process.exit(2));",
      ].join(" ");
      const ordinary = await execFileAsync(process.execPath, ["-e", script]);
      expect(ordinary.stdout).toContain("connected");
      if (process.platform === "darwin") {
        const denied = await runProcess({
          executable: process.execPath,
          args: ["-e", script],
          workspaceRoot: root,
          limits: { timeoutMs: 1000, outputBytes: 4096 },
        });
        expect(denied.stdout).not.toContain("connected");
        expect(denied.exitCode).not.toBe(0);
      } else {
        await expect(
          runProcess({
            executable: process.execPath,
            args: ["-e", script],
            workspaceRoot: root,
            limits: { timeoutMs: 1000 },
          }),
        ).rejects.toMatchObject<ProcessRunnerError>({ code: "NOT_ENFORCEABLE" });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
