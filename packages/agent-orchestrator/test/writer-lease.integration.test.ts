import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { WRITER_JOB_TYPE, WriterLeaseGuard } from "../src/index.js";
import { workUnit as workUnitSchema, type WorkUnit } from "@remoteagent/contracts";
import { Database } from "../../database/src/client.js";
import {
  CaseRepository,
  ConnectionRepository,
  OwnerRepository,
} from "../../database/src/repositories/index.js";
import {
  JobStore,
  ManualClock,
  SequentialIdGenerator,
  StaleFencingTokenError,
} from "../../database/src/queue/index.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

const makeWorkUnit = (
  caseId: string,
  workUnitId: string,
  role: WorkUnit["role"],
  status: WorkUnit["status"] = "RUNNING",
  runId: string | null = "run-1",
): WorkUnit =>
  workUnitSchema.parse({
    schema_version: 1,
    work_unit_id: workUnitId,
    case_id: caseId,
    role,
    status,
    objective: workUnitId,
    run_id: runId,
    authoritative_scope:
      role === "IMPLEMENTER"
        ? { connection_ids: [], repo_allowlist: [], can_write_workspace: true }
        : { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

describeIntegration(
  "writer lease guard",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

    beforeEach(async () => {
      await db.query(
        `TRUNCATE job_reconciliations, job_completions, job_intents, job_attempts,
                  outbox_dispatch, outbox, jobs, case_checkpoints, external_entities,
                  case_messages, cases, events, raw_events, connections, owners
         RESTART IDENTITY CASCADE`,
      );
    });

    async function seedCase(caseId: string): Promise<void> {
      await owners.insert(db, { ownerId: `owner-${caseId}`, displayName: "owner" });
      await connections.insert(db, {
        connectionId: `connection-${caseId}`,
        ownerId: `owner-${caseId}`,
        provider: "jira",
        displayName: "connection",
      });
      await cases.insert(db, {
        caseId,
        ownerId: `owner-${caseId}`,
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: [`connection-${caseId}`] },
        discordThreadId: `thread-${caseId}`,
      });
    }

    it("allows one implementer writer and never two jobs for one case", async () => {
      await seedCase("case-1");
      const jobs = new JobStore({
        clock: new ManualClock(1_000),
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        payload: { workUnitId: "unit-1", runId: "run-1" },
        caseId: "case-1",
      });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        payload: { workUnitId: "unit-2", runId: "run-1" },
        caseId: "case-1",
      });
      const [first, second] = await Promise.all([
        jobs.claim(db, { owner: "writer-a", leaseMs: 100 }),
        jobs.claim(db, { owner: "writer-b", leaseMs: 100 }),
      ]);
      const lease = first ?? second;
      expect(lease).not.toBeNull();
      expect([first, second].filter((value) => value !== null)).toHaveLength(1);
      const guard = new WriterLeaseGuard(jobs);
      const result = await guard.acquire(db, {
        workUnit: makeWorkUnit("case-1", lease!.payload.workUnitId as string, "IMPLEMENTER"),
        lease: lease!,
      });
      expect(result.kind).toBe("WRITE");
    });

    it("rejects an expired old fence and accepts the reclaimed lease", async () => {
      await seedCase("case-1");
      const clock = new ManualClock(1_000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        payload: { workUnitId: "unit-1", runId: "run-1" },
        caseId: "case-1",
      });
      const oldLease = (await jobs.claim(db, { owner: "writer-a", leaseMs: 100 }))!;
      const guard = new WriterLeaseGuard(jobs);
      const oldResult = await guard.acquire(db, {
        workUnit: makeWorkUnit("case-1", "unit-1", "IMPLEMENTER"),
        lease: oldLease,
      });
      if (oldResult.kind !== "WRITE") throw new Error("expected writer fence");
      const oldFence = oldResult.fence;
      await oldFence.assertCurrent(db);
      clock.advance(100);
      await jobs.reapExpired(db);
      const newLease = (await jobs.claim(db, { owner: "writer-b", leaseMs: 100 }))!;
      await expect(oldFence.assertCurrent(db)).rejects.toBeInstanceOf(StaleFencingTokenError);
      const newResult = await guard.acquire(db, {
        workUnit: makeWorkUnit("case-1", "unit-1", "IMPLEMENTER"),
        lease: newLease,
      });
      expect(newResult.kind).toBe("WRITE");
    });

    it("returns an explicit read-only bypass without acquiring a writer fence", async () => {
      let assertions = 0;
      const guard = new WriterLeaseGuard({
        assertCurrentLease: async () => {
          assertions += 1;
        },
      });
      const result = await guard.acquire(
        {},
        {
          workUnit: makeWorkUnit("case-1", "unit-review", "REVIEWER"),
        },
      );
      expect(result).toEqual({
        kind: "READ_ONLY",
        canWrite: false,
        caseId: "case-1",
        workUnitId: "unit-review",
      });
      expect(assertions).toBe(0);
    });

    it("rejects an implementer without a lease or with a different case before checking the database", async () => {
      let assertions = 0;
      const guard = new WriterLeaseGuard({
        assertCurrentLease: async () => {
          assertions += 1;
        },
      });
      const implementer = makeWorkUnit("case-1", "unit-writer", "IMPLEMENTER");

      await expect(guard.acquire({}, { workUnit: implementer })).rejects.toThrow(
        "implementer writer lease is required",
      );
      await expect(
        guard.acquire(
          {},
          {
            workUnit: implementer,
            lease: {
              jobId: "job-1",
              caseId: "case-2",
              leaseOwner: "writer",
              fencingToken: 1,
              jobType: WRITER_JOB_TYPE,
              payload: { workUnitId: "unit-writer", runId: "run-1" },
            },
          },
        ),
      ).rejects.toThrow("implementer writer scope does not match the lease case");
      expect(assertions).toBe(0);
    });

    it("does not accept an unrelated live job from the same case", async () => {
      await seedCase("case-1");
      const jobs = new JobStore({
        clock: new ManualClock(1_000),
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await jobs.enqueue(db, {
        jobType: "jira.ingress",
        payload: { eventId: "event-1" },
        caseId: "case-1",
      });
      const unrelated = (await jobs.claim(db, { owner: "jira", leaseMs: 100 }))!;
      const forged = {
        ...unrelated,
        jobType: WRITER_JOB_TYPE,
        payload: { workUnitId: "unit-1", runId: "run-1" },
      };
      const guard = new WriterLeaseGuard(jobs);
      await expect(
        guard.acquire(db, {
          workUnit: makeWorkUnit("case-1", "unit-1", "IMPLEMENTER"),
          lease: forged,
        }),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);
    });

    it("rejects a completed implementer before checking the database", async () => {
      let assertions = 0;
      const guard = new WriterLeaseGuard({
        assertCurrentLease: async () => {
          assertions += 1;
        },
      });
      await expect(
        guard.acquire(
          {},
          {
            workUnit: makeWorkUnit("case-1", "unit-1", "IMPLEMENTER", "COMPLETED", "run-1"),
            lease: {
              jobId: "job-1",
              caseId: "case-1",
              leaseOwner: "writer",
              fencingToken: 1,
              jobType: WRITER_JOB_TYPE,
              payload: { workUnitId: "unit-1", runId: "run-1" },
            },
          },
        ),
      ).rejects.toThrow("implementer work unit must be RUNNING with a run binding");
      expect(assertions).toBe(0);

      await expect(
        guard.acquire(
          {},
          {
            workUnit: makeWorkUnit("case-1", "unit-1", "IMPLEMENTER", "RUNNING", null),
            lease: {
              jobId: "job-1",
              caseId: "case-1",
              leaseOwner: "writer",
              fencingToken: 1,
              jobType: WRITER_JOB_TYPE,
              payload: { workUnitId: "unit-1", runId: "run-1" },
            },
          },
        ),
      ).rejects.toThrow("implementer work unit must be RUNNING with a run binding");
      expect(assertions).toBe(0);
    });
  },
  available,
);
