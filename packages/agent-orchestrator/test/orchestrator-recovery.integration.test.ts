import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  agentCompletion,
  workUnit as workUnitSchema,
  type AgentCompletion,
  type WorkUnit,
} from "@remoteagent/contracts";
import { Database } from "../../database/src/client.js";
import {
  CaseRepository,
  ConnectionRepository,
  OwnerRepository,
  WorkUnitRepository,
} from "../../database/src/repositories/index.js";
import {
  JobStore,
  ManualClock,
  SequentialIdGenerator,
  StaleFencingTokenError,
} from "../../database/src/queue/index.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { FakeRoles } from "./fake-roles.js";
import {
  FairScheduler,
  SupervisorRuntime,
  WRITER_JOB_TYPE,
  WriterLeaseGuard,
  type RuntimePersistence,
  type RuntimeSnapshot,
  type RuntimeUnit,
  type RuntimeUnitState,
} from "../src/index.js";

const available = await ensurePostgres();

const done = (caseId: string, runId: string): AgentCompletion =>
  agentCompletion.parse({
    schema_version: 1,
    run_id: runId,
    case_id: caseId,
    status: "COMPLETED",
    summary: "done",
    completed_steps: [],
    evidence: [],
    checkpoint_patch: {},
    next_actions: [],
  });

class RecoveryStore implements RuntimePersistence {
  public claimFault = false;
  public claimBindingFault = false;
  public startFault = false;
  public startBindingFault = false;
  public finalizeFault = false;
  public resumeUnitCreated = false;
  readonly #db: Database;
  readonly #units = new WorkUnitRepository();

  public constructor(db: Database) {
    this.#db = db;
  }

  public async listCaseIds(): Promise<readonly string[]> {
    return (
      await this.#db.query<{ case_id: string }>(
        "SELECT DISTINCT case_id FROM work_units ORDER BY case_id",
      )
    ).rows.map((row) => row.case_id);
  }

  public async recover(caseId: string): Promise<RuntimeSnapshot> {
    const rows = await this.#db.query<Record<string, unknown>>(
      `SELECT w.schema_version, w.work_unit_id, w.case_id, w.role, w.status, w.objective,
              w.authoritative_scope, w.run_id, w.created_at, w.updated_at,
              r.checkpoint_revision, r.trigger_event_id, r.model, c.completion
         FROM work_units w LEFT JOIN agent_runs r ON r.run_id = w.run_id
         LEFT JOIN run_completions c ON c.run_id = w.run_id
        WHERE w.case_id = $1 ORDER BY w.work_unit_id`,
      [caseId],
    );
    const revision = await this.#db.query<{ checkpoint_revision: number }>(
      "SELECT checkpoint_revision FROM cases WHERE case_id = $1",
      [caseId],
    );
    const writer = await this.#db.query<{ blocked: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agent_runs
          WHERE case_id = $1 AND role = 'IMPLEMENTER'
            AND safety_state IN ('INTENT_RECORDED', 'STARTED', 'AMBIGUOUS')
       ) AS blocked`,
      [caseId],
    );
    return {
      caseId,
      checkpointRevision: revision.rows[0]?.checkpoint_revision ?? 0,
      writerBlocked: writer.rows[0]?.blocked ?? false,
      units: rows.rows.map((row) => this.state(row)),
    };
  }

  public async claim(input: {
    workUnitId: string;
    runId: string;
    checkpointRevision: number;
    triggerEventId?: string | null;
    model?: { provider: string; model_id: string };
  }): Promise<{
    unit: RuntimeUnit;
    run: {
      runId: string;
      checkpointRevision: number;
      triggerEventId: string | null;
      model: { provider: string; model_id: string } | null;
    };
  } | null> {
    if (this.claimFault) throw new Error("fault before claim");
    const claim = await this.#units.claim(this.#db, input);
    if (!claim) return null;
    const claimedUnit = this.toWorkUnit(claim.workUnit as unknown as Record<string, unknown>);
    return {
      unit: {
        workUnit: this.claimBindingFault
          ? { ...claimedUnit, case_id: "foreign-case" }
          : claimedUnit,
      },
      run: {
        runId: claim.run.run_id,
        checkpointRevision: claim.run.checkpoint_revision,
        triggerEventId: claim.run.trigger_event_id,
        model: claim.run.model as { provider: string; model_id: string } | null,
      },
    };
  }

  public async start(input: { workUnitId: string; runId: string }): Promise<RuntimeUnit> {
    if (this.startFault) throw new Error("fault after durable claim");
    const row = await this.#units.start(this.#db, input);
    await this.#db.query(
      "UPDATE agent_runs SET safety_state = 'STARTED', started_at = '2026-08-20T10:00:00Z' WHERE run_id = $1",
      [input.runId],
    );
    const startedUnit = this.toWorkUnit(row as unknown as Record<string, unknown>);
    return {
      workUnit: this.startBindingFault ? { ...startedUnit, case_id: "foreign-case" } : startedUnit,
    };
  }

  public async persistCompletion(input: {
    unit: RuntimeUnit;
    run: { runId: string };
    completion: AgentCompletion;
  }): Promise<{ replayed: boolean }> {
    const existing = await this.#db.query<{ completion: unknown }>(
      "SELECT completion FROM run_completions WHERE run_id = $1",
      [input.run.runId],
    );
    if (existing.rows[0]) return { replayed: true };
    await this.#db.query(
      "INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [
        `completion-${input.run.runId}`,
        input.run.runId,
        input.unit.workUnit.case_id,
        input.completion.status,
        JSON.stringify(input.completion),
      ],
    );
    await this.#db.query(
      "UPDATE agent_runs SET safety_state = 'SUCCEEDED', finished_at = '2026-08-20T10:00:01Z' WHERE run_id = $1",
      [input.run.runId],
    );
    return { replayed: false };
  }

  public async resumeAnswer(input: unknown): Promise<RuntimeUnitState | null> {
    if (!input || typeof input !== "object") throw new Error("invalid answer");
    if (!this.resumeUnitCreated) {
      this.resumeUnitCreated = true;
      await this.#units.save(this.#db, {
        workUnitId: "resume-unit",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "resume",
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
      });
    }
    return (
      (await this.recover("case-1")).units.find(
        (state) => state.workUnit.work_unit_id === "resume-unit",
      ) ?? null
    );
  }

  public async finalize(input: {
    workUnitId: string;
    runId: string;
    status: "COMPLETED" | "FAILED" | "CANCELLED";
  }): Promise<{ replayed: boolean }> {
    if (this.finalizeFault) {
      this.finalizeFault = false;
      throw new Error("fault after durable completion");
    }
    const result = await this.#units.finalize(this.#db, input);
    return { replayed: result.replayed };
  }

  public async markAmbiguous(input: {
    workUnitId: string;
    runId: string;
    reason: string;
  }): Promise<void> {
    await this.#db.query(
      "UPDATE agent_runs SET safety_state = 'AMBIGUOUS' WHERE run_id = $1 AND safety_state = 'STARTED'",
      [input.runId],
    );
  }

  private state(row: Record<string, unknown>): RuntimeUnitState {
    const unit = this.toWorkUnit(row);
    return {
      workUnit: unit,
      run:
        row.run_id === null
          ? null
          : {
              runId: row.run_id as string,
              checkpointRevision: Number(row.checkpoint_revision),
              triggerEventId: row.trigger_event_id as string | null,
              model: row.model as { provider: string; model_id: string } | null,
            },
      completion:
        row.completion === null || row.completion === undefined
          ? null
          : agentCompletion.parse(row.completion),
    };
  }

  private toWorkUnit(row: Record<string, unknown>): WorkUnit {
    return workUnitSchema.parse({
      schema_version: row.schema_version,
      work_unit_id: row.work_unit_id,
      case_id: row.case_id,
      role: row.role,
      status: row.status,
      objective: row.objective,
      authoritative_scope: row.authoritative_scope,
      run_id: row.run_id,
      created_at: new Date(row.created_at as string | Date).toISOString(),
      updated_at: new Date(row.updated_at as string | Date).toISOString(),
    });
  }
}

describeIntegration(
  "supervisor runtime recovery",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();
    const units = new WorkUnitRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE jobs, work_units, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
    });

    async function seed(unitId: string): Promise<void> {
      await owners.insert(db, { ownerId: "owner-1", displayName: "owner" });
      await connections.insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "connection",
      });
      await cases.insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await units.insert(db, {
        workUnitId: unitId,
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: unitId,
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
      });
    }

    function runtime(
      store: RecoveryStore,
      roles: FakeRoles,
      writerAuthority: {
        acquire: (input: {
          unit: WorkUnit;
          run: { runId: string };
        }) => Promise<{ assertCurrent: () => Promise<void> }>;
      },
      options: { maxSteps?: number; globalLimit?: number } = {},
    ): SupervisorRuntime {
      return new SupervisorRuntime({
        persistence: store,
        roles: roles.roles,
        scheduler: new FairScheduler({
          globalLimit: options.globalLimit ?? 1,
          providerLimits: { writer: 1 },
        }),
        writerAuthority,
        makeRunId: (unit) => `run-${unit.workUnit.work_unit_id}`,
        maxSteps: options.maxSteps ?? 1,
      });
    }

    it("does not invoke a role when claim fails, and marks post-start faults ambiguous", async () => {
      await seed("unit-claim-fault");
      const store = new RecoveryStore(db);
      store.claimFault = true;
      const roles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const first = await runtime(store, roles, {
        acquire: async () => ({ assertCurrent: async () => undefined }),
      }).pumpOnce();
      expect(first.blocked).toEqual(["unit-claim-fault"]);
      expect(roles.totalCalls()).toBe(0);

      await db.query(
        "TRUNCATE work_units, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await seed("unit-dispatch-fault");
      const afterClaim = new RecoveryStore(db);
      afterClaim.startFault = true;
      const dispatchRoles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const dispatchResult = await runtime(afterClaim, dispatchRoles, {
        acquire: async () => ({ assertCurrent: async () => undefined }),
      }).pumpOnce();
      expect(dispatchResult.blocked).toEqual(["unit-dispatch-fault"]);
      expect(dispatchRoles.totalCalls()).toBe(0);
      expect((await afterClaim.recover("case-1")).units[0]!.workUnit.status).toBe("DISPATCHED");

      await db.query(
        "TRUNCATE work_units, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await seed("unit-start-fault");
      const afterStart = new RecoveryStore(db);
      const faultyRoles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
          fault: "BEFORE_RETURN",
        },
      });
      let released = 0;
      const faultWriter = {
        acquire: async () => ({
          assertCurrent: async () => undefined,
          release: async () => {
            released += 1;
          },
        }),
      };
      const result = await runtime(afterStart, faultyRoles, faultWriter).pumpOnce();
      expect(result.ambiguous).toEqual(["unit-start-fault"]);
      expect(faultyRoles.calls("unit-start-fault")).toBe(1);
      expect(released).toBe(1);
      expect(
        (
          await db.query<{ safety_state: string }>(
            "SELECT safety_state FROM agent_runs WHERE run_id = 'run-unit-start-fault'",
          )
        ).rows[0]!.safety_state,
      ).toBe("AMBIGUOUS");
      const recoveredAmbiguous = await runtime(afterStart, faultyRoles, {
        acquire: async () => ({ assertCurrent: async () => undefined }),
      }).pumpOnce();
      expect(recoveredAmbiguous.ambiguous).toContain("unit-start-fault");
      expect(faultyRoles.calls("unit-start-fault")).toBe(1);
    });

    it("fails closed on claim and start binding mismatches", async () => {
      await seed("unit-claim-binding");
      const claimStore = new RecoveryStore(db);
      claimStore.claimBindingFault = true;
      const claimRoles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const claimResult = await runtime(claimStore, claimRoles, {
        acquire: async () => ({ assertCurrent: async () => undefined }),
      }).pumpOnce();
      expect(claimResult.blocked).toEqual(["unit-claim-binding"]);
      expect(claimRoles.totalCalls()).toBe(0);
      expect((await claimStore.recover("case-1")).units[0]!.workUnit.status).toBe("DISPATCHED");

      await db.query(
        "TRUNCATE work_units, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await seed("unit-start-binding");
      const startStore = new RecoveryStore(db);
      startStore.startBindingFault = true;
      const startRoles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const startResult = await runtime(startStore, startRoles, {
        acquire: async () => ({ assertCurrent: async () => undefined }),
      }).pumpOnce();
      expect(startResult.ambiguous).toEqual(["unit-start-binding"]);
      expect(startRoles.totalCalls()).toBe(0);
      expect((await startStore.recover("case-1")).units[0]!.workUnit.status).toBe("RUNNING");
    });

    it("recovers durable completion after local acknowledgement fault without replaying the role", async () => {
      await seed("unit-completion-fault");
      const store = new RecoveryStore(db);
      store.finalizeFault = true;
      const roles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const clock = new ManualClock(1_000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        caseId: "case-1",
        payload: { workUnitId: "unit-completion-fault", runId: "run-unit-completion-fault" },
      });
      const guard = new WriterLeaseGuard(jobs);
      let oldFence: { assertCurrent: () => Promise<void> } | null = null;
      const writerAuthority = {
        acquire: async (input: { unit: WorkUnit; run: { runId: string } }) => {
          const lease = await jobs.claim(db, { owner: "runtime-writer", leaseMs: 100 });
          if (!lease) throw new Error("writer job was not claimable");
          const result = await guard.acquire(db, { workUnit: input.unit, lease });
          if (result.kind !== "WRITE") throw new Error("expected writer fence");
          const fence = { assertCurrent: () => result.fence.assertCurrent(db) };
          oldFence = fence;
          return fence;
        },
      };
      const first = await runtime(store, roles, writerAuthority).pumpOnce();
      expect(first.blocked).toEqual(["unit-completion-fault"]);
      expect(roles.calls("unit-completion-fault")).toBe(1);
      expect(
        (await db.query<{ count: string }>("SELECT count(*) FROM run_completions")).rows[0]!.count,
      ).toBe("1");
      clock.advance(100);
      await jobs.reapExpired(db);
      const newLease = (await jobs.claim(db, { owner: "new-writer", leaseMs: 100 }))!;
      await expect(oldFence!.assertCurrent()).rejects.toBeInstanceOf(StaleFencingTokenError);
      const currentUnit = (await store.recover("case-1")).units[0]!.workUnit;
      const newFenceResult = await guard.acquire(db, {
        workUnit: { ...currentUnit, status: "RUNNING" },
        lease: newLease,
      });
      expect(newFenceResult.kind).toBe("WRITE");

      const restarted = runtime(store, roles, writerAuthority);
      const recovered = await restarted.pumpOnce();
      expect(recovered.progressed).toBe(0);
      expect(roles.calls("unit-completion-fault")).toBe(1);
      expect((await store.recover("case-1")).units[0]!.workUnit.status).toBe("COMPLETED");
    });

    it("keeps a deferred writer pending after an ambiguous writer, including restart", async () => {
      await seed("ambiguous-a");
      await units.insert(db, {
        workUnitId: "ambiguous-b",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "ambiguous-b",
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
      });
      const store = new RecoveryStore(db);
      const roles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
          fault: "BEFORE_RETURN",
        },
      });
      const clock = new ManualClock(1_000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      for (const workUnitId of ["ambiguous-a", "ambiguous-b"]) {
        await jobs.enqueue(db, {
          jobType: WRITER_JOB_TYPE,
          caseId: "case-1",
          payload: { workUnitId, runId: `run-${workUnitId}` },
        });
      }
      const guard = new WriterLeaseGuard(jobs);
      let writers = 0;
      const writerAuthority = {
        acquire: async (input: { unit: WorkUnit; run: { runId: string } }) => {
          writers += 1;
          const lease = await jobs.claim(db, {
            owner: `ambiguous-${input.unit.work_unit_id}`,
            leaseMs: 100,
          });
          if (!lease) throw new Error("writer job was not claimable");
          const result = await guard.acquire(db, { workUnit: input.unit, lease });
          if (result.kind !== "WRITE") throw new Error("expected writer fence");
          return { assertCurrent: () => result.fence.assertCurrent(db) };
        },
      };
      const runtimeInstance = runtime(store, roles, writerAuthority, {
        maxSteps: 2,
        globalLimit: 2,
      });
      const first = await runtimeInstance.pumpOnce();
      expect(first.ambiguous).toEqual(["ambiguous-a"]);
      expect(roles.calls("ambiguous-a")).toBe(1);
      expect(roles.calls("ambiguous-b")).toBe(0);
      expect(
        (await store.recover("case-1")).units.find(
          (state) => state.workUnit.work_unit_id === "ambiguous-b",
        )!.workUnit.status,
      ).toBe("PENDING");

      const retried = await runtimeInstance.pumpOnce();
      expect(retried.blocked).toContain("ambiguous-b");
      expect(roles.calls("ambiguous-b")).toBe(0);
      const restarted = await runtime(store, roles, writerAuthority, {
        maxSteps: 2,
        globalLimit: 2,
      }).pumpOnce();
      expect(restarted.blocked).toContain("ambiguous-b");
      expect(roles.calls("ambiguous-b")).toBe(0);
      expect(writers).toBe(1);
      expect(
        (await store.recover("case-1")).units.find(
          (state) => state.workUnit.work_unit_id === "ambiguous-b",
        )!.workUnit.status,
      ).toBe("PENDING");
    });

    it("updates in-memory writer state after recovery finalization", async () => {
      await seed("recovered-a");
      await units.insert(db, {
        workUnitId: "recovered-b",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "recovered-b",
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
      });
      const claimed = await units.claim(db, {
        workUnitId: "recovered-a",
        runId: "run-recovered-a",
        checkpointRevision: 0,
      });
      expect(claimed).not.toBeNull();
      await units.start(db, { workUnitId: "recovered-a", runId: "run-recovered-a" });
      const completion = done("case-1", "run-recovered-a");
      await db.query(
        "INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ('completion-recovered-a', 'run-recovered-a', 'case-1', 'COMPLETED', $1::jsonb)",
        [JSON.stringify(completion)],
      );
      await db.query(
        "UPDATE agent_runs SET safety_state = 'SUCCEEDED', finished_at = '2026-08-20T10:00:01Z' WHERE run_id = 'run-recovered-a'",
      );

      const store = new RecoveryStore(db);
      const roles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const clock = new ManualClock(1_000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        caseId: "case-1",
        payload: { workUnitId: "recovered-b", runId: "run-recovered-b" },
      });
      const guard = new WriterLeaseGuard(jobs);
      const writerAuthority = {
        acquire: async (input: { unit: WorkUnit; run: { runId: string } }) => {
          const lease = await jobs.claim(db, { owner: "recovered-writer", leaseMs: 100 });
          if (!lease) throw new Error("writer job was not claimable");
          const result = await guard.acquire(db, { workUnit: input.unit, lease });
          if (result.kind !== "WRITE") throw new Error("expected writer fence");
          return { assertCurrent: () => result.fence.assertCurrent(db) };
        },
      };
      const result = await runtime(store, roles, writerAuthority, {
        maxSteps: 2,
        globalLimit: 2,
      }).pumpOnce();
      expect(result.progressed).toBe(1);
      expect(roles.calls("recovered-a")).toBe(0);
      expect(roles.calls("recovered-b")).toBe(1);
      const states = (await store.recover("case-1")).units.map((state) => state.workUnit.status);
      expect(
        states.filter((status) => status === "RUNNING" || status === "DISPATCHED"),
      ).toHaveLength(0);
      expect(states.filter((status) => status === "COMPLETED")).toHaveLength(2);
    });

    it("closes WAITING once and delegates an answer to a fresh unbound run", async () => {
      await seed("unit-waiting");
      const store = new RecoveryStore(db);
      const roles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) =>
            agentCompletion.parse({
              schema_version: 1,
              run_id: unit.workUnit.run_id,
              case_id: unit.workUnit.case_id,
              status: "WAITING_FOR_USER",
              summary: "needs answer",
              completed_steps: [],
              evidence: [],
              checkpoint_patch: {},
              next_actions: [],
              decision_request: {
                schema_version: 1,
                decision_id: "decision-1",
                case_id: unit.workUnit.case_id,
                question: "choose",
                why_now: "now",
                options: [
                  { id: "a", label: "A", consequences: "a" },
                  { id: "b", label: "B", consequences: "b" },
                ],
                recommendation: "a",
                blocked_scope: "scope",
                checkpoint_revision: 0,
              },
            }),
        },
      });
      const runtimeInstance = runtime(store, roles, {
        acquire: async () => ({ assertCurrent: async () => undefined }),
      });
      const first = await runtimeInstance.pumpOnce();
      expect(first.waiting).toEqual(["unit-waiting"]);
      expect(roles.calls("unit-waiting")).toBe(1);
      expect(
        (await store.recover("case-1")).units.find(
          (state) => state.workUnit.work_unit_id === "unit-waiting",
        )!.workUnit.status,
      ).toBe("COMPLETED");
      const resumed = await runtimeInstance.answer({
        caseId: "case-1",
        decisionId: "decision-1",
        selectedOptionId: "a",
        revision: 0,
      });
      expect(resumed.workUnit.work_unit_id).toBe("resume-unit");
      expect(resumed.workUnit.status).toBe("PENDING");
      expect(resumed.workUnit.run_id).toBeNull();
      expect(roles.calls("unit-waiting")).toBe(1);
    });

    it("keeps two implementer units in one case behind one writer authority", async () => {
      await seed("writer-a");
      await units.insert(db, {
        workUnitId: "writer-b",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "writer-b",
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
      });
      const store = new RecoveryStore(db);
      const roles = new FakeRoles({
        IMPLEMENTER: {
          completion: ({ unit }) => done(unit.workUnit.case_id, unit.workUnit.run_id!),
        },
      });
      const clock = new ManualClock(1_000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        caseId: "case-1",
        payload: { workUnitId: "writer-a", runId: "run-writer-a" },
      });
      await jobs.enqueue(db, {
        jobType: WRITER_JOB_TYPE,
        caseId: "case-1",
        payload: { workUnitId: "writer-b", runId: "run-writer-b" },
      });
      const guard = new WriterLeaseGuard(jobs);
      let writers = 0;
      let activeWriters = 0;
      let peakActiveWriters = 0;
      const writerAuthority = {
        acquire: async (input: { unit: WorkUnit; run: { runId: string } }) => {
          writers += 1;
          const lease = await jobs.claim(db, {
            owner: `runtime-${input.unit.work_unit_id}`,
            leaseMs: 100,
          });
          if (!lease) throw new Error("second writer has no active lease");
          const result = await guard.acquire(db, { workUnit: input.unit, lease });
          if (result.kind !== "WRITE") throw new Error("expected writer fence");
          activeWriters += 1;
          peakActiveWriters = Math.max(peakActiveWriters, activeWriters);
          return { assertCurrent: () => result.fence.assertCurrent(db) };
        },
      };
      const result = await runtime(store, roles, writerAuthority, {
        maxSteps: 2,
        globalLimit: 2,
      }).pumpOnce();
      expect(result.progressed).toBe(1);
      expect(result.blocked).toHaveLength(0);
      expect(roles.totalCalls()).toBe(1);
      expect(writers).toBe(1);
      expect(
        (await db.query<{ count: string }>("SELECT count(*) FROM run_completions")).rows[0]!.count,
      ).toBe("1");
      const states = (await store.recover("case-1")).units.map((state) => state.workUnit.status);
      expect(
        states.filter((status) => status === "RUNNING" || status === "DISPATCHED"),
      ).toHaveLength(0);
      expect(states.filter((status) => status === "PENDING")).toHaveLength(1);
      clock.advance(100);
      await jobs.reapExpired(db);
      activeWriters = 0;
      const next = await runtime(store, roles, writerAuthority, {
        maxSteps: 2,
        globalLimit: 2,
      }).pumpOnce();
      expect(next.progressed).toBe(1);
      expect(roles.totalCalls()).toBe(2);
      expect(writers).toBe(2);
      expect(peakActiveWriters).toBe(1);
    });
  },
  available,
);
