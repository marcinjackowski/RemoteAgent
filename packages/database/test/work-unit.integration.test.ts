import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import {
  CaseRepository,
  ConnectionRepository,
  OwnerRepository,
  WorkUnitConflictError,
  WorkUnitRepository,
  WorkUnitStateError,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "durable work-unit repository",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();
    const units = new WorkUnitRepository();

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
        `TRUNCATE work_units, agent_runs, case_checkpoints, cases, connections, owners
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

    function input(id: string, caseId: string) {
      return {
        workUnitId: id,
        caseId,
        role: "REVIEWER" as const,
        objective: `objective-${id}`,
        authoritativeScope: {
          connection_ids: [`connection-${caseId}`],
          repo_allowlist: [],
          can_write_workspace: false as const,
        },
      };
    }

    it("idempotently saves an exact unit and rejects an immutable mismatch", async () => {
      await seedCase("case-1");
      const first = await units.insert(db, input("unit-1", "case-1"));
      const replay = await units.upsert(db, input("unit-1", "case-1"));
      expect(first.inserted).toBe(true);
      expect(replay.inserted).toBe(false);
      await expect(
        units.save(db, { ...input("unit-1", "case-1"), objective: "changed" }),
      ).rejects.toBeInstanceOf(WorkUnitConflictError);
    });

    it("enforces role/scope authority in direct SQL", async () => {
      await seedCase("case-1");
      await expect(
        db.query(
          `INSERT INTO work_units
             (work_unit_id, case_id, role, status, objective, authoritative_scope)
           VALUES ('bad-unit', 'case-1', 'REVIEWER', 'PENDING', 'bad',
                   '{"connection_ids":[],"repo_allowlist":[],"can_write_workspace":true}'::jsonb)`,
        ),
      ).rejects.toThrow();
    });

    it("concurrently claims each pending unit once and binds PLANNED runs", async () => {
      await seedCase("case-a");
      await seedCase("case-b");
      await units.insert(db, input("unit-a", "case-a"));
      await units.insert(db, input("unit-b", "case-b"));
      const [a, b] = await Promise.all([
        units.claim(db, { workUnitId: "unit-a", runId: "run-a", checkpointRevision: 0 }),
        units.claim(db, { workUnitId: "unit-b", runId: "run-b", checkpointRevision: 0 }),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(new Set([a!.workUnit.work_unit_id, b!.workUnit.work_unit_id]).size).toBe(2);
      expect(a!.workUnit.status).toBe("DISPATCHED");
      expect(a!.run.safety_state).toBe("PLANNED");
      expect(b!.run.safety_state).toBe("PLANNED");
    });

    it("starts and finalizes the current binding, with safe replay and stale rejection", async () => {
      await seedCase("case-1");
      await units.insert(db, input("unit-1", "case-1"));
      const claimed = await units.claim(db, {
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
      });
      expect(claimed).not.toBeNull();
      const running = await units.start(db, { workUnitId: "unit-1", runId: "run-1" });
      expect(running.status).toBe("RUNNING");
      const startedReplay = await units.start(db, { workUnitId: "unit-1", runId: "run-1" });
      const completed = await units.finalize(db, {
        workUnitId: "unit-1",
        runId: "run-1",
        status: "COMPLETED",
      });
      const replay = await units.complete(db, {
        workUnitId: "unit-1",
        runId: "run-1",
        status: "COMPLETED",
      });
      expect(completed.replayed).toBe(false);
      expect(startedReplay.status).toBe("RUNNING");
      expect(replay.replayed).toBe(true);
      await expect(
        units.finalize(db, { workUnitId: "unit-1", runId: "old-run", status: "FAILED" }),
      ).rejects.toBeInstanceOf(WorkUnitStateError);
      await expect(
        units.claim(db, { workUnitId: "unit-1", runId: "run-2", checkpointRevision: 0 }),
      ).rejects.toBeInstanceOf(WorkUnitStateError);
    });

    it("concurrent retries of one concrete claim share one binding", async () => {
      await seedCase("case-1");
      await units.insert(db, input("unit-1", "case-1"));
      const [first, second] = await Promise.all([
        units.claim(db, { workUnitId: "unit-1", runId: "run-1", checkpointRevision: 0 }),
        units.claim(db, { workUnitId: "unit-1", runId: "run-1", checkpointRevision: 0 }),
      ]);
      expect(first!.run.run_id).toBe("run-1");
      expect(second!.run.run_id).toBe("run-1");
      await expect(
        units.claim(db, { workUnitId: "unit-1", runId: "run-other", checkpointRevision: 0 }),
      ).rejects.toBeInstanceOf(WorkUnitStateError);
    });

    it("rejects exact claim replay when trigger or model identity changes", async () => {
      await seedCase("case-1");
      await units.insert(db, input("unit-1", "case-1"));
      await units.claim(db, {
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        model: { provider: "provider-a", model_id: "model-a" },
      });
      await expect(
        units.claim(db, {
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          triggerEventId: "event-2",
          model: { provider: "provider-a", model_id: "model-a" },
        }),
      ).rejects.toBeInstanceOf(WorkUnitConflictError);
      await expect(
        units.claim(db, {
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          model: { provider: "provider-a", model_id: "model-b" },
        }),
      ).rejects.toBeInstanceOf(WorkUnitConflictError);
    });

    it("allows two read-only units for one case to be dispatched concurrently", async () => {
      await seedCase("case-1");
      await units.insert(db, input("unit-1", "case-1"));
      await units.insert(db, { ...input("unit-2", "case-1"), objective: "objective-unit-2" });
      const [first, second] = await Promise.all([
        units.claim(db, { workUnitId: "unit-1", runId: "run-1", checkpointRevision: 0 }),
        units.claim(db, { workUnitId: "unit-2", runId: "run-2", checkpointRevision: 0 }),
      ]);
      expect(first!.workUnit.status).toBe("DISPATCHED");
      expect(second!.workUnit.status).toBe("DISPATCHED");
    });
  },
  available,
);
