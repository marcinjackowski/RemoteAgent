import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalWorkspaceAdapter, adaptWorkspaceRepository, inspectWorkspace } from "../src/index.js";
import { WorkspaceRepository } from "../../database/src/repositories/workspace.js";
import { Database } from "../../database/src/client.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { WRITER_JOB_TYPE, WriterLeaseGuard } from "../../agent-orchestrator/src/index.js";
import { workUnit as workUnitSchema, type WorkUnit } from "../../contracts/src/work-unit.js";
import { JobStore, ManualClock, SequentialIdGenerator } from "../../database/src/queue/index.js";
import { bindWorkspaceFence } from "../src/index.js";

const run = promisify(execFile);
const available = await ensurePostgres();

async function fixture(): Promise<{ parent: string; source: string; baseSha: string }> {
  const parent = await mkdtemp(join("/tmp", "ra010-wu09-isolation-"));
  const source = join(parent, "source");
  await mkdir(source);
  await mkdir(join(parent, "sandbox"));
  await run("git", ["init", "--quiet", source]);
  await run("git", ["-C", source, "config", "user.email", "isolation@example.test"]);
  await run("git", ["-C", source, "config", "user.name", "Isolation"]);
  await writeFile(join(source, "README.md"), "base\n");
  await run("git", ["-C", source, "add", "README.md"]);
  await run("git", ["-C", source, "commit", "--quiet", "-m", "base"]);
  const { stdout } = await run("git", ["-C", source, "rev-parse", "HEAD"]);
  return { parent, source, baseSha: stdout.trim() };
}

describeIntegration(
  "workspace end-to-end isolation",
  () => {
    let db: Database;
    let drop: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop?.());

    it("isolates two cases on one repo and recovers clean/dirty state after restart", async () => {
      const { parent, source, baseSha } = await fixture();
      try {
        const owner = `owner-${randomUUID()}`;
        const connection = `connection-${randomUUID()}`;
        const caseA = `case-${randomUUID()}`;
        const caseB = `case-${randomUUID()}`;
        await db.query("INSERT INTO owners (owner_id, display_name) VALUES ($1,$2)", [
          owner,
          owner,
        ]);
        await db.query(
          "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ($1,$2,'jira',$3,$4)",
          [connection, owner, "Jira", "unconfigured://wu09"],
        );
        for (const [caseId, thread] of [
          [caseA, `thread-${caseA}`],
          [caseB, `thread-${caseB}`],
        ]) {
          await db.query(
            "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ($1,$2,'IMPLEMENTING',$3,$4)",
            [
              caseId,
              owner,
              JSON.stringify({ providers: ["jira"], connection_ids: [connection] }),
              thread,
            ],
          );
        }
        const registry = adaptWorkspaceRepository(
          new WorkspaceRepository(),
          db,
          join(parent, "sandbox"),
        );
        const fenceValidator = { assertCurrent: async () => undefined };
        const config = {
          workspaceRoot: join(parent, "sandbox"),
          repositories: { repo: { sourcePath: source } },
          workspaceRegistry: registry,
          fenceValidator,
        };
        const inputA = {
          identity: { caseId: caseA, workspaceId: "workspace-a" },
          fence: { leaseOwner: "writer", fencingToken: 1 },
          repositoryId: "repo",
          baseSha,
          branchName: `${caseA}/workspace-a`,
        } as const;
        const inputB = {
          identity: { caseId: caseB, workspaceId: "workspace-b" },
          fence: { leaseOwner: "writer", fencingToken: 2 },
          repositoryId: "repo",
          baseSha,
          branchName: `${caseB}/workspace-b`,
        } as const;
        await new LocalWorkspaceAdapter(config).create(inputA);
        await new LocalWorkspaceAdapter(config).create(inputB);
        const targetA = join(parent, "sandbox", caseA, "workspace-a");
        const targetB = join(parent, "sandbox", caseB, "workspace-b");
        await writeFile(join(targetA, "README.md"), "case-a\n");
        await writeFile(join(targetA, "only-a.txt"), "a\n");
        await expect(readFile(join(targetB, "README.md"), "utf8")).resolves.toBe("base\n");
        await expect(readFile(join(source, "README.md"), "utf8")).resolves.toBe("base\n");
        await expect(inspectWorkspace(targetA)).resolves.toMatchObject({ dirtyState: "DIRTY" });
        await expect(inspectWorkspace(targetB)).resolves.toMatchObject({ dirtyState: "CLEAN" });
        const restartedRegistry = adaptWorkspaceRepository(
          new WorkspaceRepository(),
          db,
          join(parent, "sandbox"),
        );
        const restartedConfig = { ...config, workspaceRegistry: restartedRegistry };
        const resumedA = await new LocalWorkspaceAdapter(restartedConfig).resume({
          identity: inputA.identity,
          fence: inputA.fence,
        });
        const resumedB = await new LocalWorkspaceAdapter(restartedConfig).resume({
          identity: inputB.identity,
          fence: inputB.fence,
        });
        expect(resumedA.dirtyState).toBe("DIRTY");
        expect(resumedB.dirtyState).toBe("CLEAN");
        await expect(readFile(join(targetB, "README.md"), "utf8")).resolves.toBe("base\n");
        await expect(readFile(join(targetA, "only-a.txt"), "utf8")).resolves.toBe("a\n");
        await expect(readFile(join(targetA, "README.md"), "utf8")).resolves.toBe("case-a\n");
        const mappingA = await restartedRegistry.find("workspace-a");
        const mappingB = await restartedRegistry.find("workspace-b");
        expect(mappingA).toMatchObject({
          caseId: caseA,
          repo: "repo",
          baseSha,
          branchName: `${caseA}/workspace-a`,
        });
        expect(mappingB).toMatchObject({
          caseId: caseB,
          repo: "repo",
          baseSha,
          branchName: `${caseB}/workspace-b`,
        });
        expect(mappingA?.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(mappingB?.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect((await inspectWorkspace(targetA)).treeDigest).not.toBe(mappingA?.treeDigest);
        expect((await inspectWorkspace(targetB)).treeDigest).toBe(mappingB?.treeDigest);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("rejects stale real writer fences before create and destroy mutations", async () => {
      const { parent, source, baseSha } = await fixture();
      try {
        const owner = `owner-${randomUUID()}`;
        const connection = `connection-${randomUUID()}`;
        const caseId = `case-${randomUUID()}`;
        await db.query("INSERT INTO owners (owner_id, display_name) VALUES ($1,$2)", [
          owner,
          owner,
        ]);
        await db.query(
          "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ($1,$2,'jira',$3,$4)",
          [connection, owner, "Jira", "unconfigured://wu09-fence"],
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
        const clock = new ManualClock(1_000);
        const jobs = new JobStore({
          clock,
          ids: new SequentialIdGenerator(),
          leaseTime: "injected",
        });
        await jobs.enqueue(db, {
          jobType: WRITER_JOB_TYPE,
          payload: { workUnitId: "unit", runId: "run" },
          caseId,
        });
        const lease = (await jobs.claim(db, { owner: "writer-a", leaseMs: 100 }))!;
        const guard = new WriterLeaseGuard(jobs);
        const unit = workUnitSchema.parse({
          schema_version: 1,
          work_unit_id: "unit",
          case_id: caseId,
          role: "IMPLEMENTER",
          status: "RUNNING",
          objective: "unit",
          run_id: "run",
          authoritative_scope: {
            connection_ids: [],
            repo_allowlist: [],
            can_write_workspace: true,
          },
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        }) as WorkUnit;
        const acquired = await guard.acquire(db, { workUnit: unit, lease });
        if (acquired.kind !== "WRITE") throw new Error("expected writer fence");
        const oldFence = bindWorkspaceFence({ caseId, workspaceId: "workspace-existing" }, db, {
          caseId: lease.caseId,
          leaseOwner: lease.leaseOwner,
          fencingToken: lease.fencingToken,
          assertCurrent: (query) => acquired.fence.assertCurrent(query),
        });
        const workspaceRoot = join(parent, "sandbox");
        const registry = adaptWorkspaceRepository(new WorkspaceRepository(), db, workspaceRoot);
        const config = {
          workspaceRoot,
          repositories: { repo: { sourcePath: source } },
          workspaceRegistry: registry,
          fenceValidator: oldFence,
        };
        const existing = {
          identity: { caseId, workspaceId: "workspace-existing" },
          fence: { leaseOwner: lease.leaseOwner, fencingToken: lease.fencingToken },
          repositoryId: "repo",
          baseSha,
          branchName: `${caseId}/workspace-existing`,
        } as const;
        await new LocalWorkspaceAdapter(config).create(existing);
        clock.advance(200);
        await jobs.reapExpired(db);
        const reclaimed = (await jobs.claim(db, { owner: "writer-b", leaseMs: 100 }))!;
        expect(reclaimed.leaseOwner).toBe("writer-b");
        const staleCreate = {
          ...existing,
          identity: { caseId, workspaceId: "workspace-new" },
          branchName: `${caseId}/workspace-new`,
        } as const;
        const staleCreateFence = bindWorkspaceFence({ caseId, workspaceId: "workspace-new" }, db, {
          caseId: lease.caseId,
          leaseOwner: lease.leaseOwner,
          fencingToken: lease.fencingToken,
          assertCurrent: (query) => acquired.fence.assertCurrent(query),
        });
        await expect(
          new LocalWorkspaceAdapter({ ...config, fenceValidator: staleCreateFence }).create(
            staleCreate,
          ),
        ).rejects.toMatchObject({
          code: "INVALID_FENCE",
        });
        await expect(registry.find("workspace-new")).resolves.toBeNull();
        await expect(new LocalWorkspaceAdapter(config).destroy(existing)).rejects.toMatchObject({
          code: "INVALID_FENCE",
        });
        await expect(
          readFile(join(workspaceRoot, caseId, "workspace-existing", "README.md"), "utf8"),
        ).resolves.toBe("base\n");
        await expect(
          readFile(join(workspaceRoot, caseId, "workspace-new", "README.md")),
        ).rejects.toThrow();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });

    it("rejects identity escape and symlink target before Git", async () => {
      const { parent, source, baseSha } = await fixture();
      try {
        const registry = new (await import("../src/index.js")).InMemoryWorkspaceRegistry();
        const adapter = new LocalWorkspaceAdapter({
          workspaceRoot: join(parent, "sandbox"),
          repositories: { repo: { sourcePath: source } },
          fenceValidator: { assertCurrent: async () => undefined },
          workspaceRegistry: registry,
        });
        await expect(
          adapter.create({
            identity: { caseId: "../escape", workspaceId: "workspace" },
            fence: { leaseOwner: "writer", fencingToken: 1 },
            repositoryId: "repo",
            baseSha,
            branchName: "escape/workspace",
          }),
        ).rejects.toMatchObject({ code: "INVALID_IDENTITY" });
        const sibling = join(parent, "sibling");
        await mkdir(sibling);
        await mkdir(join(parent, "sandbox", "case-link"));
        await symlink(sibling, join(parent, "sandbox", "case-link", "workspace-link"));
        await expect(
          adapter.create({
            identity: { caseId: "case-link", workspaceId: "workspace-link" },
            fence: { leaseOwner: "writer", fencingToken: 1 },
            repositoryId: "repo",
            baseSha,
            branchName: "case-link/workspace-link",
          }),
        ).rejects.toMatchObject({ code: "SYMLINK_NOT_ALLOWED" });
        await expect(readFile(join(sibling, "README.md"))).rejects.toThrow();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    });
  },
  available,
);
