import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceAdapter, adaptWorkspaceRepository, inspectWorkspace } from "../src/index.js";
import { WorkspaceRepository } from "../../database/src/repositories/workspace.js";
import { Database } from "../../database/src/client.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const run = promisify(execFile);
const available = await ensurePostgres();

async function fixture(): Promise<{ parent: string; source: string; baseSha: string }> {
  const parent = await mkdtemp(join("/tmp", "ra010-wu10-snapshot-"));
  const source = join(parent, "source");
  await mkdir(source);
  await mkdir(join(parent, "sandbox"));
  await run("git", ["init", "--quiet", source]);
  await run("git", ["-C", source, "config", "user.email", "snapshot@example.test"]);
  await run("git", ["-C", source, "config", "user.name", "Snapshot"]);
  await writeFile(join(source, "README.md"), "base\n");
  await run("git", ["-C", source, "add", "README.md"]);
  await run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
  const { stdout } = await run("git", ["-C", source, "rev-parse", "HEAD"]);
  return { parent, source, baseSha: stdout.trim() };
}

async function createCase(
  db: Database,
): Promise<{ owner: string; connection: string; caseId: string }> {
  const owner = `owner-${randomUUID()}`;
  const connection = `connection-${randomUUID()}`;
  const caseId = `case-${randomUUID()}`;
  await db.query("INSERT INTO owners (owner_id, display_name) VALUES ($1,$2)", [owner, owner]);
  await db.query(
    "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ($1,$2,'jira',$3,$4)",
    [connection, owner, "Jira", "unconfigured://snapshot"],
  );
  await db.query(
    "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ($1,$2,'IMPLEMENTING',$3,$4)",
    [
      caseId,
      owner,
      JSON.stringify({ providers: ["jira"], connection_ids: [connection] }),
      `thread-${caseId}`,
    ],
  );
  return { owner, connection, caseId };
}

describeIntegration(
  "workspace snapshot lifecycle",
  () => {
    let db: Database;
    let drop: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop?.());

    it("returns deterministic clean/dirty snapshots after restart without mutation", async () => {
      const { parent, source, baseSha } = await fixture();
      try {
        const { caseId } = await createCase(db);
        const workspaceId = `workspace-${randomUUID()}`;
        const workspaceRoot = join(parent, "sandbox");
        const input = {
          identity: { caseId, workspaceId },
          fence: { leaseOwner: "writer", fencingToken: 1 },
          repositoryId: "repo",
          baseSha,
          branchName: `${caseId}/${workspaceId}`,
        } as const;
        const fenceValidator = { assertCurrent: async () => undefined };
        const registry = adaptWorkspaceRepository(new WorkspaceRepository(), db, workspaceRoot);
        const config = {
          workspaceRoot,
          repositories: { repo: { sourcePath: source } },
          fenceValidator,
          workspaceRegistry: registry,
        };
        await new LocalWorkspaceAdapter(config).create(input);
        const target = join(workspaceRoot, caseId, workspaceId);
        const ledgerPath = join(parent, ".workspace-runner-metadata-sandbox", "operations.jsonl");
        const ledgerBefore = await readFile(ledgerPath);
        const ledgerStatBefore = await stat(ledgerPath);
        const mappingBefore = await db.query<{
          workspace_id: string;
          case_id: string;
          repo: string;
          base_sha: string | null;
          branch_name: string | null;
          tree_digest: string | null;
          status: string;
        }>(
          "SELECT workspace_id, case_id, repo, base_sha, branch_name, tree_digest, status FROM workspaces WHERE workspace_id = $1",
          [workspaceId],
        );
        const treeBefore = await inspectWorkspace(target);
        const restartedRegistry = adaptWorkspaceRepository(
          new WorkspaceRepository(),
          db,
          workspaceRoot,
        );
        const clean = await new LocalWorkspaceAdapter({
          ...config,
          workspaceRegistry: restartedRegistry,
          fenceValidator: undefined,
        }).snapshot({ identity: input.identity });
        expect(clean).toMatchObject({
          lifecycle: "SNAPSHOTTED",
          dirtyState: "CLEAN",
          operationId: `snapshot:${caseId}:${workspaceId}`,
        });
        expect(clean.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        const cleanAgain = await new LocalWorkspaceAdapter({
          ...config,
          workspaceRegistry: restartedRegistry,
          fenceValidator: undefined,
        }).snapshot({ identity: input.identity });
        expect(cleanAgain.treeDigest).toBe(clean.treeDigest);
        expect((await inspectWorkspace(target)).treeDigest).toBe(treeBefore.treeDigest);
        await writeFile(join(target, "README.md"), "changed\n");
        await writeFile(join(target, "untracked.txt"), "untracked\n");
        const dirty = await new LocalWorkspaceAdapter({
          ...config,
          workspaceRegistry: restartedRegistry,
          fenceValidator: undefined,
        }).snapshot({ identity: input.identity });
        expect(dirty.dirtyState).toBe("DIRTY");
        expect(dirty.treeDigest).not.toBe(clean.treeDigest);
        const ledgerAfter = await readFile(ledgerPath);
        const ledgerStatAfter = await stat(ledgerPath);
        expect(ledgerAfter).toEqual(ledgerBefore);
        expect({
          dev: ledgerStatAfter.dev,
          ino: ledgerStatAfter.ino,
          mode: ledgerStatAfter.mode,
          size: ledgerStatAfter.size,
          mtimeMs: ledgerStatAfter.mtimeMs,
        }).toEqual({
          dev: ledgerStatBefore.dev,
          ino: ledgerStatBefore.ino,
          mode: ledgerStatBefore.mode,
          size: ledgerStatBefore.size,
          mtimeMs: ledgerStatBefore.mtimeMs,
        });
        const mappingAfter = await db.query<(typeof mappingBefore.rows)[number]>(
          "SELECT workspace_id, case_id, repo, base_sha, branch_name, tree_digest, status FROM workspaces WHERE workspace_id = $1",
          [workspaceId],
        );
        expect(mappingAfter.rows).toEqual(mappingBefore.rows);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("fails closed for missing, foreign, and symlink targets", async () => {
      const { parent, source, baseSha } = await fixture();
      try {
        const { caseId } = await createCase(db);
        const workspaceId = `workspace-${randomUUID()}`;
        const workspaceRoot = join(parent, "sandbox");
        const registry = adaptWorkspaceRepository(new WorkspaceRepository(), db, workspaceRoot);
        const config = {
          workspaceRoot,
          repositories: { repo: { sourcePath: source } },
          workspaceRegistry: registry,
          fenceValidator: { assertCurrent: async () => undefined },
        };
        const input = {
          identity: { caseId, workspaceId },
          fence: { leaseOwner: "writer", fencingToken: 1 },
          repositoryId: "repo",
          baseSha,
          branchName: `${caseId}/${workspaceId}`,
        } as const;
        await new LocalWorkspaceAdapter(config).create(input);
        await expect(
          new LocalWorkspaceAdapter({ ...config, fenceValidator: undefined }).snapshot({
            identity: { caseId, workspaceId: "missing" },
          }),
        ).rejects.toMatchObject({ code: "MISSING_MAPPING" });
        await expect(
          new LocalWorkspaceAdapter({ ...config, fenceValidator: undefined }).snapshot({
            identity: { caseId: `case-foreign-${randomUUID()}`, workspaceId },
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        const target = join(workspaceRoot, caseId, workspaceId);
        const sibling = join(parent, "sibling");
        const ledgerPath = join(parent, ".workspace-runner-metadata-sandbox", "operations.jsonl");
        const ledgerBefore = await readFile(ledgerPath);
        await rm(target, { recursive: true, force: true });
        await mkdir(sibling);
        await symlink(sibling, target);
        await expect(
          new LocalWorkspaceAdapter({ ...config, fenceValidator: undefined }).snapshot({
            identity: input.identity,
          }),
        ).rejects.toMatchObject({ code: "AMBIGUOUS" });
        await expect(readFile(ledgerPath)).resolves.toEqual(ledgerBefore);
        await expect(stat(sibling)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  },
  available,
);
