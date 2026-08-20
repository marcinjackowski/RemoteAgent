import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceAdapter } from "../src/index.js";

const run = promisify(execFile);
const roots: string[] = [];

async function fixtureRepo(): Promise<{ parent: string; source: string; baseSha: string }> {
  const parent = await mkdtemp(join("/tmp", "workspace-runner-git-"));
  const source = join(parent, "source");
  const sandbox = join(parent, "sandbox");
  await mkdir(source);
  await mkdir(sandbox);
  await run("git", ["init", "--quiet", source]);
  await run("git", ["-C", source, "config", "user.email", "fixture@example.test"]);
  await run("git", ["-C", source, "config", "user.name", "Fixture"]);
  await writeFile(join(source, "README.md"), "base\n");
  await run("git", ["-C", source, "add", "README.md"]);
  await run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
  const { stdout } = await run("git", ["-C", source, "rev-parse", "HEAD"]);
  roots.push(parent);
  return { parent, source, baseSha: stdout.trim() };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local worktree adapter", () => {
  it("creates two isolated worktrees at the explicit base SHA", async () => {
    const { parent, source, baseSha } = await fixtureRepo();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
    });
    const first = await adapter.create({
      identity: { caseId: "case-a", workspaceId: "workspace-a" },
      fence: { leaseOwner: "test", fencingToken: 1 },
      repositoryId: "repo",
      baseSha,
      branchName: "case-a/workspace-a",
    });
    const second = await adapter.create({
      identity: { caseId: "case-b", workspaceId: "workspace-b" },
      fence: { leaseOwner: "test", fencingToken: 2 },
      repositoryId: "repo",
      baseSha,
      branchName: "case-b/workspace-b",
    });

    expect(first.baseSha).toBe(baseSha);
    expect(second.baseSha).toBe(baseSha);
    await writeFile(join(parent, "sandbox", "case-a", "workspace-a", "README.md"), "case-a\n");
    expect(
      await readFile(join(parent, "sandbox", "case-b", "workspace-b", "README.md"), "utf8"),
    ).toBe("base\n");
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("base\n");
  });

  it("rejects a repository that is not on the server allowlist before creating a worktree", async () => {
    const { parent, baseSha } = await fixtureRepo();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: {},
    });
    await expect(
      adapter.create({
        identity: { caseId: "case", workspaceId: "workspace" },
        fence: { leaseOwner: "test", fencingToken: 1 },
        repositoryId: "not-allowed",
        baseSha,
        branchName: "case/workspace",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" });
    await expect(
      readFile(join(parent, "sandbox", "case", "workspace", "README.md")),
    ).rejects.toThrow();
  });

  it("does not leave a target after invalid SHA and permits a retry", async () => {
    const { parent, source, baseSha } = await fixtureRepo();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
    });
    const input = {
      identity: { caseId: "case-retry", workspaceId: "workspace-retry" },
      fence: { leaseOwner: "test", fencingToken: 1 },
      repositoryId: "repo",
      baseSha: "0000000000000000000000000000000000000000",
      branchName: "case-retry/workspace-retry",
    } as const;
    await expect(adapter.create(input)).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    await expect(
      readFile(join(parent, "sandbox", "case-retry", "workspace-retry", "README.md")),
    ).rejects.toThrow();
    await expect(adapter.create({ ...input, baseSha })).resolves.toMatchObject({ baseSha });
  });
});
