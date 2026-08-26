import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalWorkspaceAdapter, resolveBaseBranch } from "../src/index.js";
import { InMemoryWorkspaceRegistry } from "../src/index.js";

const run = promisify(execFile);
const roots: string[] = [];
const fenceValidator = { assertCurrent: async () => undefined };

async function fixtureRepo(): Promise<{
  parent: string;
  source: string;
  baseSha: string;
  baseBranch: string;
}> {
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
  const branch = await run("git", ["-C", source, "symbolic-ref", "--short", "HEAD"]);
  roots.push(parent);
  return { parent, source, baseSha: stdout.trim(), baseBranch: branch.stdout.trim() };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local worktree adapter", () => {
  it("pins a server-owned base branch to one exact source commit without creating a mirror", async () => {
    const { parent, source, baseSha, baseBranch } = await fixtureRepo();
    const mirrorPath = join(parent, "not-created-by-resolution.git");
    await expect(resolveBaseBranch({ sourcePath: source, mirrorPath }, baseBranch)).resolves.toBe(
      baseSha,
    );
    await expect(readFile(mirrorPath)).rejects.toThrow();
    await expect(
      resolveBaseBranch({ sourcePath: source, mirrorPath }, "../hostile"),
    ).rejects.toThrow(/canonical bounded branch/);
  });

  it("creates two isolated worktrees at the explicit base SHA", async () => {
    const { parent, source, baseSha } = await fixtureRepo();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator,
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
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
      fenceValidator,
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
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
      fenceValidator,
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
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
    const retryAdapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator,
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
    });
    await expect(retryAdapter.create({ ...input, baseSha })).resolves.toMatchObject({ baseSha });
  });

  it("reports ambiguous ledger failure after worktree creation without FAILED replay", async () => {
    const { parent, source, baseSha } = await fixtureRepo();
    const metadata = join(parent, ".workspace-runner-metadata-sandbox");
    await mkdir(metadata);
    const ledgerPath = join(metadata, "operations.jsonl");
    await writeFile(ledgerPath, "x".repeat(8 * 1024 * 1024));
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator,
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
    });
    await expect(
      adapter.create({
        identity: { caseId: "case-ledger", workspaceId: "workspace-ledger" },
        fence: { leaseOwner: "test", fencingToken: 1 },
        repositoryId: "repo",
        baseSha,
        branchName: "case-ledger/workspace-ledger",
      }),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    await expect(
      readFile(join(parent, "sandbox", "case-ledger", "workspace-ledger", "README.md")),
    ).resolves.toBeTruthy();
    expect((await readFile(ledgerPath, "utf8")).includes("FAILED")).toBe(false);
  });

  it("rejects a ledger symlink into the workspace before Git or ledger writes", async () => {
    const { parent, source, baseSha } = await fixtureRepo();
    const workspace = join(parent, "sandbox");
    const ledgerPath = join(parent, "ledger-link");
    await symlink(workspace, ledgerPath);
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: workspace,
      ledgerRoot: ledgerPath,
      repositories: { repo: { sourcePath: source } },
      fenceValidator,
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
    });
    await expect(
      adapter.create({
        identity: { caseId: "case-link", workspaceId: "workspace-link" },
        fence: { leaseOwner: "test", fencingToken: 1 },
        repositoryId: "repo",
        baseSha,
        branchName: "case-link/workspace-link",
      }),
    ).rejects.toMatchObject({ code: "INVALID_LIFECYCLE" });
    await expect(readFile(join(workspace, "operations.jsonl"))).rejects.toThrow();
    await expect(
      readFile(join(workspace, "case-link", "workspace-link", "README.md")),
    ).rejects.toThrow();
  });

  it("fails closed before mkdir when server-owned fence validation is absent or stale", async () => {
    const { parent, source, baseSha } = await fixtureRepo();
    const input = {
      identity: { caseId: "case-fence", workspaceId: "workspace-fence" },
      fence: { leaseOwner: "forged", fencingToken: 999 },
      repositoryId: "repo",
      baseSha,
      branchName: "case-fence/workspace-fence",
    } as const;
    const missing = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
    });
    await expect(missing.create(input)).rejects.toMatchObject({ code: "INVALID_FENCE" });
    const stale = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: {
        assertCurrent: async () => {
          throw new Error("stale or reclaimed lease");
        },
      },
      workspaceRegistry: new InMemoryWorkspaceRegistry(),
    });
    await expect(stale.create(input)).rejects.toThrow("stale or reclaimed lease");
    await expect(
      readFile(join(parent, "sandbox", "case-fence", "workspace-fence", "README.md")),
    ).rejects.toThrow();
  });

  it("fails closed on resume when the server-owned registry is absent", async () => {
    const { parent } = await fixtureRepo();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: {},
    });
    await expect(
      adapter.resume({
        identity: { caseId: "case-resume", workspaceId: "workspace-resume" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
