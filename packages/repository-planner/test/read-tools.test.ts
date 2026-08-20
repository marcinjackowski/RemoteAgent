import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkspacePathPolicy,
  type VerifiedWorkspacePath,
} from "@remoteagent/workspace-runner";
import { createPlannerReadPort } from "../src/read-tools.js";
import { createPlannerReadPortWithTestSeam } from "../src/read-tools.js";

const roots: string[] = [];

async function fixture(): Promise<VerifiedWorkspacePath> {
  const root = await mkdtemp(join(tmpdir(), "repository-planner-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "nested"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "node_modules"));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, "README.md"), "read me\n");
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(root, "src", "app.ts"), "const answer = 42;\nfunction run() {}\n");
  await writeFile(join(root, "nested", "safe.txt"), "safe\n");
  await writeFile(join(root, "tokenizer.ts"), "export const tokenizer = true;\n");
  await writeFile(join(root, ".environment.ts"), "export const environment = true;\n");
  await writeFile(join(root, "node_modules", "canary.js"), "should not be read\n");
  await writeFile(join(root, "dist", "canary.js"), "should not be read\n");
  await writeFile(join(root, ".github", "workflows", "ci.yml"), "run: ./ci.sh\n");
  await writeFile(join(root, ".env"), "TOKEN=not-for-planner\n");
  await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(root, "invalid-utf8.txt"), Buffer.from([0xff, 0xfe]));
  await symlink(join(root, "nested", "safe.txt"), join(root, "unrelated-link"));
  return (await createWorkspacePathPolicy(root)).root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sealed read-only discovery tools", () => {
  it("provides bounded tree/read/search/symbols with a read-only manifest", async () => {
    const root = await fixture();
    const visited: string[] = [];
    const port = await createPlannerReadPortWithTestSeam(root, (path) => {
      visited.push(path);
    });
    const tree = await port.tree({});
    expect(tree.entries.some((entry) => entry.provenance.relative_path === ".git")).toBe(false);
    expect(tree.entries.some((entry) => entry.provenance.relative_path === ".env")).toBe(false);
    expect(
      tree.entries.some((entry) => entry.provenance.relative_path.includes("node_modules")),
    ).toBe(false);
    expect(tree.entries.some((entry) => entry.provenance.relative_path.includes("dist"))).toBe(
      false,
    );
    expect(visited.some((path) => path.includes("node_modules") || path.includes("dist"))).toBe(
      false,
    );
    expect(tree.entries.some((entry) => entry.kind === "symlink")).toBe(true);
    expect(port.manifest.tools).toEqual([
      "workspace.read",
      "workspace.search",
      "workspace.tree",
      "workspace.symbols",
      "workspace.config",
    ]);
    expect(port.manifest.can_write_workspace).toBe(false);
    expect(port.manifest.can_execute_commands).toBe(false);
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.isFrozen(port.manifest)).toBe(true);
    expect(Object.isFrozen(port.manifest.tools)).toBe(true);
    expect(() => (port.manifest.tools as string[]).push("workspace.write")).toThrow();

    const read = await port.read({ relative_path: "src/app.ts" });
    expect(read.content).toEqual({
      trust: "UNTRUSTED_DATA",
      value: expect.stringContaining("answer"),
    });
    expect(read.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const search = await port.search({ query: "answer" });
    expect(search.matches[0]?.content.trust).toBe("UNTRUSTED_DATA");
    const symbols = await port.symbols({ relative_path: "src/app.ts" });
    expect(symbols.symbols.map((symbol) => symbol.name)).toEqual(["answer", "run"]);
    const subtree = await port.tree({ relative_path: "src" });
    expect(
      subtree.entries.every((entry) => entry.provenance.relative_path.startsWith("src/")),
    ).toBe(true);
    await expect(port.read({ relative_path: "tokenizer.ts" })).resolves.toBeDefined();
    await expect(port.read({ relative_path: ".environment.ts" })).resolves.toBeDefined();
  });

  it("rejects git, secret, binary, oversize and non-canonical paths before content", async () => {
    const root = await fixture();
    const port = await createPlannerReadPort(root);
    for (const relativePath of [
      ".git/config",
      ".env",
      "../outside",
      "/etc/passwd",
      "file://secret",
    ]) {
      await expect(port.read({ relative_path: relativePath })).rejects.toThrow();
    }
    await expect(port.read({ relative_path: "binary.bin" })).rejects.toMatchObject({
      code: "BINARY_FILE",
    });
    await expect(port.read({ relative_path: "invalid-utf8.txt" })).rejects.toMatchObject({
      code: "BINARY_FILE",
    });
    await expect(port.read({ relative_path: "nested/safe.txt" })).resolves.toBeDefined();
    await writeFile(root + "/large.txt", Buffer.alloc(1_048_577, 65));
    await expect(port.read({ relative_path: "large.txt" })).rejects.toMatchObject({
      code: "OVERSIZE",
    });
    await expect(port.tree({ unexpected: true } as never)).rejects.toThrow();
    await expect(
      port.read({ relative_path: "nested/safe.txt", unexpected: true } as never),
    ).rejects.toThrow();
    await expect(
      port.config({ relative_path: "README.md", unexpected: true } as never),
    ).rejects.toThrow();
  });

  it("enforces total byte and entry budgets across tree scans", async () => {
    const root = await fixture();
    await writeFile(root + "/first.txt", Buffer.alloc(600_000, 65));
    await writeFile(root + "/second.txt", Buffer.alloc(600_000, 66));
    const port = await createPlannerReadPort(root);
    await expect(port.tree({})).resolves.toBeDefined();
    for (let index = 0; index < 14; index += 1)
      await writeFile(
        root + `/search-${index}.txt`,
        Buffer.concat([Buffer.from("needle\n"), Buffer.alloc(999_990, 65)]),
      );
    const searchPort = await createPlannerReadPort(root);
    await expect(searchPort.search({ query: "needle" })).rejects.toMatchObject({
      code: "OVERSIZE",
    });
    for (let index = 0; index < 513; index += 1) await writeFile(root + `/entry-${index}.txt`, "x");
    const entryPort = await createPlannerReadPort(root);
    await expect(entryPort.tree({})).rejects.toMatchObject({ code: "OVERSIZE" });
    for (let index = 0; index < 17; index += 1)
      await writeFile(root + `/huge-${index}.txt`, Buffer.alloc(1_000_000, 67));
    const bytePort = await createPlannerReadPort(root);
    await expect(bytePort.tree({})).rejects.toMatchObject({ code: "OVERSIZE" });
  });

  it("fails closed when a parent is swapped to a symlink before the second check", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "planner-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    const port = await createPlannerReadPortWithTestSeam(root, async (path) => {
      if (path !== "nested/safe.txt") return;
      await rm(join(root, "nested"), { recursive: true });
      await symlink(outside, join(root, "nested"));
    });
    await expect(port.read({ relative_path: "nested/safe.txt" })).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
    });
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("outside\n");
  });

  it("fails closed when a directory is swapped before descent", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "planner-outside-tree-"));
    roots.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside\n");
    const port = await createPlannerReadPortWithTestSeam(root, async (path) => {
      if (path !== "nested") return;
      await rm(join(root, "nested"), { recursive: true });
      await symlink(outside, join(root, "nested"));
    });
    await expect(port.tree({})).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
  });
});
