import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceFencingError,
  bindWorkspaceFence,
  type WorkspaceFenceValidator,
} from "../src/index.js";
import { WRITER_JOB_TYPE, WriterLeaseGuard } from "../../agent-orchestrator/src/index.js";
import { workUnit as workUnitSchema, type WorkUnit } from "../../contracts/src/work-unit.js";
import { Database } from "../../database/src/client.js";
import {
  OwnerRepository,
  CaseRepository,
  ConnectionRepository,
} from "../../database/src/repositories/index.js";
import { JobStore, ManualClock, SequentialIdGenerator } from "../../database/src/queue/index.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "workspace fencing authority",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => {
      await drop?.();
    });
    it("requires an injected server-owned validator", async () => {
      const validator: WorkspaceFenceValidator = {
        assertCurrent: async ({ identity, fence }) => {
          if (identity.caseId !== "case" || fence.fencingToken !== 7) {
            throw new WorkspaceFencingError();
          }
        },
      };
      await expect(
        validator.assertCurrent({
          identity: { caseId: "case", workspaceId: "workspace" },
          fence: { leaseOwner: "server", fencingToken: 7 },
        }),
      ).resolves.toBeUndefined();
      await expect(
        validator.assertCurrent({
          identity: { caseId: "case", workspaceId: "workspace" },
          fence: { leaseOwner: "forged", fencingToken: 8 },
        }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
    });

    it("binds exact RA-009 lease and rejects reclaimed old fence", async () => {
      await db.query("TRUNCATE jobs, cases, owners RESTART IDENTITY CASCADE");
      const owners = new OwnerRepository();
      const cases = new CaseRepository();
      const connections = new ConnectionRepository();
      await owners.insert(db, { ownerId: "owner-pg", displayName: "owner" });
      await connections.insert(db, {
        connectionId: "connection-pg",
        ownerId: "owner-pg",
        provider: "jira",
        displayName: "connection",
      });
      await cases.insert(db, {
        caseId: "case-pg",
        ownerId: "owner-pg",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-pg"] },
        discordThreadId: "thread-pg",
      });
      const clock = new ManualClock(1_000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        payload: { workUnitId: "unit", runId: "run" },
        caseId: "case-pg",
      });
      const lease = (await jobs.claim(db, { owner: "writer", leaseMs: 100 }))!;
      expect(await jobs.claim(db, { owner: "writer-2", leaseMs: 100 })).toBeNull();
      const guard = new WriterLeaseGuard(jobs);
      const unit = workUnitSchema.parse({
        schema_version: 1,
        work_unit_id: "unit",
        case_id: "case-pg",
        role: "IMPLEMENTER",
        status: "RUNNING",
        objective: "unit",
        run_id: "run",
        authoritative_scope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      }) as WorkUnit;
      const acquired = await guard.acquire(db, { workUnit: unit, lease });
      if (acquired.kind !== "WRITE") throw new Error("expected writer fence");
      const bound = bindWorkspaceFence({ caseId: "case-pg", workspaceId: "workspace" }, db, {
        caseId: lease.caseId,
        leaseOwner: lease.leaseOwner,
        fencingToken: lease.fencingToken,
        assertCurrent: (query) => acquired.fence.assertCurrent(query),
      });
      await bound.assertCurrent({
        identity: { caseId: "case-pg", workspaceId: "workspace" },
        fence: { leaseOwner: lease.leaseOwner, fencingToken: lease.fencingToken },
      });
      await expect(
        bound.assertCurrent({
          identity: { caseId: "case-pg", workspaceId: "workspace" },
          fence: { leaseOwner: "forged", fencingToken: lease.fencingToken },
        }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
      await expect(
        bound.assertCurrent({
          identity: { caseId: "case-pg", workspaceId: "workspace" },
          fence: { leaseOwner: lease.leaseOwner, fencingToken: 999 },
        }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
      clock.advance(200);
      await jobs.reapExpired(db);
      const parent = await mkdtemp(join(tmpdir(), "workspace-fence-pg-"));
      const workspaceRoot = join(parent, "workspace");
      await mkdir(workspaceRoot);
      try {
        const adapter = new (await import("../src/index.js")).LocalWorkspaceAdapter({
          workspaceRoot,
          repositories: { repo: { sourcePath: join(parent, "not-a-repo") } },
          fenceValidator: bindWorkspaceFence({ caseId: "case-pg", workspaceId: "workspace" }, db, {
            caseId: lease.caseId,
            leaseOwner: lease.leaseOwner,
            fencingToken: lease.fencingToken,
            assertCurrent: (query) => acquired.fence.assertCurrent(query),
          }),
        });
        await expect(
          adapter.create({
            identity: { caseId: "case-pg", workspaceId: "workspace" },
            fence: { leaseOwner: lease.leaseOwner, fencingToken: lease.fencingToken },
            repositoryId: "repo",
            baseSha: "a".repeat(40),
            branchName: "case-pg/workspace",
          }),
        ).rejects.toMatchObject({ code: "INVALID_FENCE" });
        await expect(
          readFile(join(workspaceRoot, "case-pg", "workspace", "README.md")),
        ).rejects.toThrow();
        await expect(
          readFile(join(parent, ".workspace-runner-metadata-workspace", "operations.jsonl")),
        ).rejects.toThrow();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
      const reclaimed = (await jobs.claim(db, { owner: "writer-2", leaseMs: 100 }))!;
      expect((await guard.acquire(db, { workUnit: unit, lease: reclaimed })).kind).toBe("WRITE");
      const reclaimedBound = bindWorkspaceFence(
        { caseId: "case-pg", workspaceId: "workspace" },
        db,
        {
          caseId: reclaimed.caseId,
          leaseOwner: reclaimed.leaseOwner,
          fencingToken: reclaimed.fencingToken,
          assertCurrent: (query) => jobs.assertCurrentLease(query, reclaimed),
        },
      );
      await reclaimedBound.assertCurrent({
        identity: { caseId: "case-pg", workspaceId: "workspace" },
        fence: { leaseOwner: reclaimed.leaseOwner, fencingToken: reclaimed.fencingToken },
      });
      await expect(
        bound.assertCurrent({
          identity: { caseId: "case-pg", workspaceId: "workspace" },
          fence: { leaseOwner: lease.leaseOwner, fencingToken: lease.fencingToken },
        }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
      await expect(
        bound.assertCurrent({
          identity: { caseId: "wrong-case", workspaceId: "workspace" },
          fence: { leaseOwner: lease.leaseOwner, fencingToken: lease.fencingToken },
        }),
      ).rejects.toBeInstanceOf(WorkspaceFencingError);
    });
  },
  available,
);
