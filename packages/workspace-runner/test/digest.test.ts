import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { computeTreeDigest } from "../src/index.js";
import { inspectWorkspace } from "../src/index.js";

const run = promisify(execFile);

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

describe("workspace tree digest", () => {
  it("is stable and changes for tracked/untracked, mode and symlink mutations", async () => {
    const parent = await mkdtemp(join(tmpdir(), "workspace-digest-"));
    const root = join(parent, "root");
    await mkdir(root);
    roots.push(parent);
    await writeFile(join(root, "tracked"), "one");
    const first = await computeTreeDigest(root);
    await writeFile(join(root, "untracked"), "two");
    const second = await computeTreeDigest(root);
    expect(second).not.toBe(first);
    await writeFile(join(root, "tracked"), "changed");
    const third = await computeTreeDigest(root);
    expect(third).not.toBe(second);
    await symlink("tracked", join(root, "link"));
    const fourth = await computeTreeDigest(root);
    await rm(join(root, "link"));
    await symlink("untracked", join(root, "link"));
    expect(await computeTreeDigest(root)).not.toBe(fourth);
    expect(await readFile(join(root, "tracked"), "utf8")).toBe("changed");
  });

  it("reports clean, tracked modified, and untracked states from Git porcelain", async () => {
    const parent = await mkdtemp(join(tmpdir(), "workspace-digest-git-"));
    const root = join(parent, "root");
    await mkdir(root);
    roots.push(parent);
    await run("git", ["init", "--quiet", root]);
    await run("git", ["-C", root, "config", "user.email", "fixture@example.test"]);
    await run("git", ["-C", root, "config", "user.name", "Fixture"]);
    await writeFile(join(root, "tracked"), "one");
    await run("git", ["-C", root, "add", "tracked"]);
    await run("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    expect((await inspectWorkspace(root)).dirtyState).toBe("CLEAN");
    await writeFile(join(root, "tracked"), "changed");
    expect((await inspectWorkspace(root)).dirtyState).toBe("DIRTY");
    await run("git", ["-C", root, "checkout", "--", "tracked"]);
    await writeFile(join(root, "untracked"), "new");
    expect((await inspectWorkspace(root)).dirtyState).toBe("DIRTY");
  });
});
