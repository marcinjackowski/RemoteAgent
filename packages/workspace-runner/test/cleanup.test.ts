import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWorkspace,
  InMemoryWorkspaceRegistry,
  LocalWorkspaceAdapter,
} from "../src/index.js";
import { cleanupWorkspaceWithTestSeam } from "../src/cleanup.js";

const run = promisify(execFile);
const roots: string[] = [];

async function fixture(): Promise<{ parent: string; source: string; baseSha: string }> {
  const parent = await mkdtemp(join("/tmp", "workspace-cleanup-"));
  const source = join(parent, "source");
  await mkdir(source);
  await mkdir(join(parent, "sandbox"));
  await run("git", ["init", "--quiet", source]);
  await run("git", ["-C", source, "config", "user.email", "cleanup@example.test"]);
  await run("git", ["-C", source, "config", "user.name", "Cleanup"]);
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

describe("safe workspace cleanup", () => {
  it("removes only the exact worktree and retries idempotently", async () => {
    const { parent, source, baseSha } = await fixture();
    const registry = new InMemoryWorkspaceRegistry();
    const fenceValidator = { assertCurrent: async () => undefined };
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator,
      workspaceRegistry: registry,
    });
    const input = {
      identity: { caseId: "case", workspaceId: "workspace" },
      fence: { leaseOwner: "writer", fencingToken: 1 },
      repositoryId: "repo",
      baseSha,
      branchName: "case/workspace",
    } as const;
    await adapter.create(input);
    await writeFile(join(parent, "sibling.txt"), "keep");
    const destroyed = await adapter.destroy(input);
    expect(destroyed.lifecycle).toBe("DESTROYED");
    await expect(
      readFile(join(parent, "sandbox", "case", "workspace", "README.md")),
    ).rejects.toThrow();
    await expect(readFile(join(source, "README.md"), "utf8")).resolves.toBe("base\n");
    await expect(readFile(join(parent, "sibling.txt"), "utf8")).resolves.toBe("keep");
    await expect(adapter.destroy(input)).resolves.toMatchObject({ lifecycle: "DESTROYED" });
  });

  it("fails closed for stale fence and missing target without a receipt", async () => {
    const { parent, source, baseSha } = await fixture();
    const registry = new InMemoryWorkspaceRegistry();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: {
        assertCurrent: async () => {
          throw new Error("stale fence");
        },
      },
      workspaceRegistry: registry,
    });
    const input = {
      identity: { caseId: "case", workspaceId: "workspace" },
      fence: { leaseOwner: "writer", fencingToken: 1 },
      repositoryId: "repo",
      baseSha,
      branchName: "case/workspace",
    } as const;
    await expect(adapter.create(input)).rejects.toThrow("stale fence");
    const mapping = await registry.recordIntent({
      workspaceId: input.identity.workspaceId,
      caseId: input.identity.caseId,
      repo: input.repositoryId,
      baseSha,
      branchName: input.branchName,
      target: join(await realpath(join(parent, "sandbox")), "case", "workspace"),
    });
    void mapping;
    await expect(adapter.destroy(input)).rejects.toMatchObject({ code: "AMBIGUOUS" });
  });

  it("rejects dirty cleanup without an explicit policy", async () => {
    const { parent, source, baseSha } = await fixture();
    const registry = new InMemoryWorkspaceRegistry();
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: { assertCurrent: async () => undefined },
      workspaceRegistry: registry,
    });
    const input = {
      identity: { caseId: "case", workspaceId: "workspace" },
      fence: { leaseOwner: "writer", fencingToken: 1 },
      repositoryId: "repo",
      baseSha,
      branchName: "case/workspace",
    } as const;
    await adapter.create(input);
    await writeFile(join(parent, "sandbox", "case", "workspace", "README.md"), "dirty\n");
    await expect(adapter.destroy(input)).rejects.toMatchObject({ code: "DIRTY" });
    await expect(
      readFile(join(parent, "sandbox", "case", "workspace", "README.md"), "utf8"),
    ).resolves.toBe("dirty\n");
  });

  it("fails closed for corrupt, oversized, stale, and symlinked ledgers", async () => {
    const { parent, source, baseSha } = await fixture();
    const registry = new InMemoryWorkspaceRegistry();
    const config = {
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: { assertCurrent: async () => undefined },
      workspaceRegistry: registry,
    } as const;
    const input = {
      identity: { caseId: "case", workspaceId: "workspace" },
      fence: { leaseOwner: "writer", fencingToken: 1 },
      repositoryId: "repo",
      baseSha,
      branchName: "case/workspace",
    } as const;
    const adapter = new LocalWorkspaceAdapter(config);
    await adapter.create(input);
    const ledgerPath = join(parent, ".workspace-runner-metadata-sandbox", "operations.jsonl");
    await writeFile(ledgerPath, "{broken\n");
    await expect(adapter.destroy(input)).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(
      readFile(join(parent, "sandbox", "case", "workspace", "README.md")),
    ).resolves.toBeTruthy();
    await writeFile(ledgerPath, "x".repeat(8 * 1024 * 1024 + 1));
    await expect(adapter.destroy(input)).rejects.toMatchObject({ code: "AMBIGUOUS" });
    const forged = {
      version: 1,
      operationId: "forged-id",
      identity: input.identity,
      kind: "CLEANUP_WORKTREE",
      beforeDigest: "sha256:" + "f".repeat(64),
      afterDigest: null,
      outcome: "SUCCEEDED",
    };
    await writeFile(
      ledgerPath,
      JSON.stringify(forged) +
        "\n" +
        JSON.stringify({ ...forged, operationId: "cleanup-case-workspace" }) +
        "\n",
    );
    await expect(adapter.destroy(input)).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await rm(join(parent, "sandbox", "case", "workspace"), { recursive: true, force: true });
    await writeFile(
      ledgerPath,
      JSON.stringify({
        version: 1,
        operationId: "stale",
        identity: input.identity,
        kind: "CLEANUP_WORKTREE",
        beforeDigest: "sha256:" + "f".repeat(64),
        afterDigest: null,
        outcome: "SUCCEEDED",
      }) + "\n",
    );
    await expect(adapter.destroy(input)).rejects.toMatchObject({ code: "AMBIGUOUS" });
    const linkedMetadata = join(parent, "linked-metadata");
    await symlink(join(parent, ".workspace-runner-metadata-sandbox"), linkedMetadata);
    const linkedAdapter = new LocalWorkspaceAdapter({ ...config, ledgerRoot: linkedMetadata });
    await expect(linkedAdapter.destroy(input)).rejects.toMatchObject({ code: "AMBIGUOUS" });
  });

  it("rejects root, parent, prefix-collision, and symlink targets", async () => {
    const { parent } = await fixture();
    const workspaceRoot = await realpath(join(parent, "sandbox"));
    const cases = [
      workspaceRoot,
      parent,
      `${workspaceRoot}-sibling/case/workspace`,
      join(workspaceRoot, "case", "workspace-link"),
    ];
    await mkdir(join(workspaceRoot, "case"), { recursive: true });
    await symlink(join(parent, "source"), cases[3]!);
    for (const target of cases) {
      const registry = new InMemoryWorkspaceRegistry();
      await registry.recordIntent({
        workspaceId: "workspace",
        caseId: "case",
        repo: "repo",
        baseSha: "a".repeat(40),
        branchName: "case/workspace",
        target,
      });
      await expect(
        cleanupWorkspace(
          {
            workspaceRoot,
            metadataRoot: join(parent, "metadata"),
            repositories: { repo: { mirrorPath: join(parent, "mirror") } },
            registry,
            fenceValidator: { assertCurrent: async () => undefined },
          },
          {
            identity: { caseId: "case", workspaceId: "workspace" },
            fence: { leaseOwner: "writer", fencingToken: 1 },
          },
        ),
      ).rejects.toMatchObject({ code: "INVALID_TARGET" });
    }
  });

  it("fails ambiguous after remove fault and protects against target swap", async () => {
    const { parent, source, baseSha } = await fixture();
    const registry = new InMemoryWorkspaceRegistry();
    const input = {
      identity: { caseId: "case", workspaceId: "workspace" },
      fence: { leaseOwner: "writer", fencingToken: 1 },
      repositoryId: "repo",
      baseSha,
      branchName: "case/workspace",
    } as const;
    const adapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: { assertCurrent: async () => undefined },
      workspaceRegistry: registry,
    });
    await adapter.create(input);
    const mirrorPath = join(parent, "sandbox", ".git-mirrors", "repo");
    let calls = 0;
    await expect(
      cleanupWorkspaceWithTestSeam(
        {
          workspaceRoot: join(parent, "sandbox"),
          metadataRoot: join(parent, ".workspace-runner-metadata-sandbox"),
          repositories: { repo: { mirrorPath } },
          registry,
          fenceValidator: { assertCurrent: async () => undefined },
        },
        input,
        {
          gitRunner: async (args) => {
            calls += 1;
            if (calls === 1) await run("git", args);
            else throw new Error("injected receipt failure");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(
      readFile(join(parent, "sandbox", "case", "workspace", "README.md")),
    ).rejects.toThrow();

    const secondRegistry = new InMemoryWorkspaceRegistry();
    const secondAdapter = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: { assertCurrent: async () => undefined },
      workspaceRegistry: secondRegistry,
    });
    const secondInput = {
      ...input,
      identity: { caseId: "case-two", workspaceId: "workspace-two" },
      branchName: "case-two/workspace-two",
    } as const;
    await secondAdapter.create(secondInput);
    const swappedTarget = join(parent, "outside");
    await mkdir(swappedTarget);
    let swapped = false;
    let armed = false;
    const swapping = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: {
        assertCurrent: async () => {
          if (armed && !swapped) {
            swapped = true;
            await rm(join(parent, "sandbox", "case-two", "workspace-two"), {
              recursive: true,
              force: true,
            });
            await symlink(swappedTarget, join(parent, "sandbox", "case-two", "workspace-two"));
          }
        },
      },
      workspaceRegistry: secondRegistry,
    });
    armed = true;
    await expect(swapping.destroy(secondInput)).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(readFile(join(swappedTarget, "README.md"))).rejects.toThrow();

    const thirdInput = {
      ...input,
      identity: { caseId: "case-three", workspaceId: "workspace-three" },
      branchName: "case-three/workspace-three",
    } as const;
    const thirdRegistry = new InMemoryWorkspaceRegistry();
    const thirdCreator = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: { assertCurrent: async () => undefined },
      workspaceRegistry: thirdRegistry,
    });
    await thirdCreator.create(thirdInput);
    const metadataRoot = join(parent, ".workspace-runner-metadata-sandbox");
    const outsideMetadata = join(parent, "outside-metadata");
    await mkdir(outsideMetadata);
    await expect(
      cleanupWorkspaceWithTestSeam(
        {
          workspaceRoot: join(parent, "sandbox"),
          metadataRoot,
          repositories: { repo: { mirrorPath: join(parent, "sandbox", ".git-mirrors", "repo") } },
          registry: thirdRegistry,
          fenceValidator: { assertCurrent: async () => undefined },
        },
        thirdInput,
        {
          beforeLedgerAppend: async () => {
            await rm(metadataRoot, { recursive: true, force: true });
            await symlink(outsideMetadata, metadataRoot);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(readFile(join(outsideMetadata, "operations.jsonl"))).rejects.toThrow();
    await rm(metadataRoot, { force: true });
    await mkdir(metadataRoot);

    const fourthInput = {
      ...input,
      identity: { caseId: "case-four", workspaceId: "workspace-four" },
      branchName: "case-four/workspace-four",
    } as const;
    const fourthRegistry = new InMemoryWorkspaceRegistry();
    const fourthCreator = new LocalWorkspaceAdapter({
      workspaceRoot: join(parent, "sandbox"),
      repositories: { repo: { sourcePath: source } },
      fenceValidator: { assertCurrent: async () => undefined },
      workspaceRegistry: fourthRegistry,
    });
    await fourthCreator.create(fourthInput);
    const operationsPath = join(metadataRoot, "operations.jsonl");
    const renamedOperations = join(parent, "renamed-operations.jsonl");
    const replacement = JSON.stringify({ replacement: true });
    await expect(
      cleanupWorkspaceWithTestSeam(
        {
          workspaceRoot: join(parent, "sandbox"),
          metadataRoot,
          repositories: { repo: { mirrorPath: join(parent, "sandbox", ".git-mirrors", "repo") } },
          registry: fourthRegistry,
          fenceValidator: { assertCurrent: async () => undefined },
        },
        fourthInput,
        {
          beforeLedgerAppend: async () => {
            await rename(operationsPath, renamedOperations);
            await writeFile(operationsPath, replacement);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS" });
    await expect(readFile(operationsPath, "utf8")).resolves.toBe(replacement);
  });
});
