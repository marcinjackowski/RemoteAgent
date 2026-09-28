import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
  it.skipIf(process.platform !== "darwin")(
    "allows Node ESM resolution while denying ancestor and sibling data",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "workspace-esm-sandbox-"));
      roots.push(parent);
      const canonicalParent = await realpath(parent);
      const root = join(canonicalParent, "nested", "workspace");
      const sibling = join(canonicalParent, "sibling-secret.txt");
      await mkdir(join(root, "node_modules", "tiny"), { recursive: true });
      await writeFile(
        join(root, "node_modules", "tiny", "package.json"),
        '{"type":"module","main":"index.mjs"}\n',
      );
      await writeFile(join(root, "node_modules", "tiny", "index.mjs"), "export const value = 7;\n");
      await writeFile(
        join(root, "main.mjs"),
        [
          "import { value } from 'tiny';",
          "import { readdirSync, readFileSync, statSync } from 'node:fs';",
          `const sibling = ${JSON.stringify(sibling)};`,
          `const ancestor = ${JSON.stringify(canonicalParent)};`,
          "const attempt = (fn) => { try { fn(); return true; } catch { return false; } };",
          "console.log(JSON.stringify({ value, siblingRead: attempt(() => readFileSync(sibling)), ancestorList: attempt(() => readdirSync(ancestor)), siblingStat: attempt(() => statSync(sibling)) }));",
        ].join("\n"),
      );
      await writeFile(sibling, "secret\n");
      const ordinary = await execFileAsync(process.execPath, [join(root, "main.mjs")]);
      expect(JSON.parse(ordinary.stdout.trim())).toEqual({
        value: 7,
        siblingRead: true,
        ancestorList: true,
        siblingStat: true,
      });
      const result = await runProcess({
        executable: process.execPath,
        args: [join(root, "main.mjs")],
        workspaceRoot: root,
        limits: { timeoutMs: 2000, outputBytes: 4096 },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        value: 7,
        siblingRead: false,
        ancestorList: false,
        siblingStat: false,
      });
    },
  );

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
