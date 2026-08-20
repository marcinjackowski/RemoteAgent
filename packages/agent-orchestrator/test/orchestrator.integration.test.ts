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
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { FakeRoles } from "./fake-roles.js";
import {
  FairScheduler,
  SupervisorRuntime,
  type RuntimePersistence,
  type RuntimeSnapshot,
  type RuntimeUnit,
  type RuntimeUnitState,
} from "../src/index.js";

const available = await ensurePostgres();

const completion = (caseId: string, runId: string, summary: string): AgentCompletion =>
  agentCompletion.parse({
    schema_version: 1,
    run_id: runId,
    case_id: caseId,
    status: "COMPLETED",
    summary,
    completed_steps: [{ description: summary }],
    evidence: [{ kind: "test", reference: `evidence-${runId}` }],
    checkpoint_patch: {},
    next_actions: [],
  });

class PgRuntimeStore implements RuntimePersistence {
  readonly #db: Database;
  readonly #units = new WorkUnitRepository();
  readonly #provider = new Map<string, string>();

  public constructor(db: Database, provider: Readonly<Record<string, string>>) {
    this.#db = db;
    for (const [id, value] of Object.entries(provider)) this.#provider.set(id, value);
  }

  public async listCaseIds(): Promise<readonly string[]> {
    const result = await this.#db.query<{ case_id: string }>(
      "SELECT DISTINCT case_id FROM work_units ORDER BY case_id",
    );
    return result.rows.map((row) => row.case_id);
  }

  public async recover(caseId: string): Promise<RuntimeSnapshot> {
    const result = await this.#db.query<Record<string, unknown>>(
      `SELECT w.schema_version, w.work_unit_id, w.case_id, w.role, w.status, w.objective,
              w.authoritative_scope, w.run_id, w.created_at, w.updated_at,
              r.checkpoint_revision, r.trigger_event_id, r.model,
              c.completion
         FROM work_units w
         LEFT JOIN agent_runs r ON r.run_id = w.run_id
         LEFT JOIN run_completions c ON c.run_id = w.run_id
        WHERE w.case_id = $1
        ORDER BY w.work_unit_id`,
      [caseId],
    );
    const units = result.rows.map((row) => this.state(row));
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
      units,
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
    const claimed = await this.#units.claim(this.#db, input);
    if (!claimed) return null;
    return {
      unit: {
        workUnit: this.toWorkUnit(claimed.workUnit as unknown as Record<string, unknown>),
        provider: this.#provider.get(input.workUnitId),
      },
      run: {
        runId: claimed.run.run_id,
        checkpointRevision: claimed.run.checkpoint_revision,
        triggerEventId: claimed.run.trigger_event_id,
        model: claimed.run.model as { provider: string; model_id: string } | null,
      },
    };
  }

  public async start(input: { workUnitId: string; runId: string }): Promise<RuntimeUnit> {
    const row = await this.#units.start(this.#db, input);
    await this.#db.query(
      "UPDATE agent_runs SET safety_state = 'STARTED', started_at = '2026-08-20T10:00:00Z' WHERE run_id = $1",
      [input.runId],
    );
    return {
      workUnit: this.toWorkUnit(row as unknown as Record<string, unknown>),
      provider: this.#provider.get(input.workUnitId),
    };
  }

  public async persistCompletion(input: {
    unit: RuntimeUnit;
    run: { runId: string };
    completion: AgentCompletion;
  }): Promise<{ replayed: boolean }> {
    const completionId = `completion-${input.run.runId}`;
    const existing = await this.#db.query<{ completion: unknown; completion_id: string }>(
      "SELECT completion, completion_id FROM run_completions WHERE run_id = $1",
      [input.run.runId],
    );
    if (existing.rows[0]) {
      const equal = (
        await this.#db.query<{ equal: boolean }>(
          "SELECT completion = $1::jsonb AS equal FROM run_completions WHERE run_id = $2",
          [JSON.stringify(input.completion), input.run.runId],
        )
      ).rows[0]?.equal;
      if (!equal) throw new Error("durable completion conflict");
      return { replayed: true };
    }
    await this.#db.withTransaction(async (tx) => {
      await tx.query(
        "INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [
          completionId,
          input.run.runId,
          input.unit.workUnit.case_id,
          input.completion.status,
          JSON.stringify(input.completion),
        ],
      );
      await tx.query(
        "UPDATE agent_runs SET safety_state = $2, finished_at = '2026-08-20T10:00:01Z' WHERE run_id = $1 AND safety_state = 'STARTED'",
        [
          input.run.runId,
          input.completion.status === "FAILED" || input.completion.status === "CANCELLED"
            ? "FAILED"
            : "SUCCEEDED",
        ],
      );
      await tx.query("UPDATE cases SET active_run_id = NULL WHERE case_id = $1", [
        input.unit.workUnit.case_id,
      ]);
    });
    return { replayed: false };
  }

  public async finalize(input: {
    workUnitId: string;
    runId: string;
    status: "COMPLETED" | "FAILED" | "CANCELLED";
  }): Promise<{ replayed: boolean }> {
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
    const run =
      row.run_id === null
        ? null
        : {
            runId: row.run_id as string,
            checkpointRevision: Number(row.checkpoint_revision),
            triggerEventId: row.trigger_event_id as string | null,
            model: row.model as { provider: string; model_id: string } | null,
          };
    const parsed =
      row.completion === null || row.completion === undefined
        ? null
        : agentCompletion.parse(row.completion);
    return {
      workUnit: unit,
      provider: this.#provider.get(unit.work_unit_id),
      run,
      completion: parsed,
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
  "supervisor runtime concurrency",
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
        "TRUNCATE work_units, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
    });

    async function seed(
      caseId: string,
      unitId: string,
      role: "REVIEWER" | "VERIFICATION",
    ): Promise<void> {
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
      await units.insert(db, {
        workUnitId: unitId,
        caseId,
        role,
        objective: unitId,
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
      });
    }

    it("advances two cases concurrently under global/provider limits and merges read-only evidence canonically", async () => {
      await seed("case-a", "unit-a", "REVIEWER");
      await seed("case-b", "unit-b", "REVIEWER");
      const store = new PgRuntimeStore(db, { "unit-a": "provider-a", "unit-b": "provider-b" });
      const roles = new FakeRoles({
        REVIEWER: {
          completion: ({ unit }) =>
            completion(unit.workUnit.case_id, unit.workUnit.run_id!, "review"),
        },
        VERIFICATION: {
          completion: ({ unit }) =>
            completion(unit.workUnit.case_id, unit.workUnit.run_id!, "verification"),
        },
      });
      const scheduler = new FairScheduler({
        globalLimit: 2,
        providerLimits: { "provider-a": 2, "provider-b": 1 },
      });
      let peakGlobal = 0;
      let peakProviderA = 0;
      let peakProviderB = 0;
      const observedScheduler = {
        enqueue: (unit: { workUnitId: string; caseId: string; provider?: string }) =>
          scheduler.enqueue(unit),
        acquire: () => {
          const lease = scheduler.acquire();
          peakGlobal = Math.max(peakGlobal, scheduler.globalUsed);
          peakProviderA = Math.max(peakProviderA, scheduler.providerUsed("provider-a"));
          peakProviderB = Math.max(peakProviderB, scheduler.providerUsed("provider-b"));
          return lease;
        },
      };
      const runtime = new SupervisorRuntime({
        persistence: store,
        roles: roles.roles,
        scheduler: observedScheduler,
        maxSteps: 2,
        makeRunId: (unit) => `run-${unit.workUnit.work_unit_id}`,
      });
      const result = await runtime.pumpOnce();
      expect(result.progressed).toBe(2);
      expect(result.merges).toHaveLength(2);
      expect(roles.calls("unit-a")).toBe(1);
      expect(roles.calls("unit-b")).toBe(1);
      expect(peakGlobal).toBe(2);
      expect(peakProviderA).toBeLessThanOrEqual(2);
      expect(peakProviderB).toBeLessThanOrEqual(1);
      expect(scheduler.globalUsed).toBe(0);
      expect((await store.recover("case-a")).units[0]!.workUnit.status).toBe("COMPLETED");
      const restarted = new SupervisorRuntime({
        persistence: store,
        roles: roles.roles,
        scheduler: new FairScheduler({ globalLimit: 2 }),
        maxSteps: 2,
        makeRunId: (unit) => `run-${unit.workUnit.work_unit_id}`,
      });
      await restarted.pumpOnce();
      expect(roles.totalCalls()).toBe(2);
    });

    it("starts Reviewer and Verification together for one case and canonicalizes completion order", async () => {
      await seed("case-parallel", "review-unit", "REVIEWER");
      await units.insert(db, {
        workUnitId: "verification-unit",
        caseId: "case-parallel",
        role: "VERIFICATION",
        objective: "verification-unit",
        authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
      });
      const store = new PgRuntimeStore(db, {
        "review-unit": "provider-a",
        "verification-unit": "provider-a",
      });
      let active = 0;
      let peak = 0;
      let entered = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const parallelCompletion = async (unit: RuntimeUnit) => {
        active += 1;
        peak = Math.max(peak, active);
        entered += 1;
        if (entered === 2) release();
        await barrier;
        active -= 1;
        return completion(unit.workUnit.case_id, unit.workUnit.run_id!, unit.workUnit.work_unit_id);
      };
      const roles = new FakeRoles({
        REVIEWER: {
          completion: ({ unit }) => parallelCompletion(unit),
        },
        VERIFICATION: {
          completion: ({ unit }) => parallelCompletion(unit),
        },
      });
      const scheduler = new FairScheduler({ globalLimit: 2, providerLimits: { "provider-a": 2 } });
      const runtime = new SupervisorRuntime({
        persistence: store,
        roles: roles.roles,
        scheduler,
        maxSteps: 2,
        makeRunId: (unit) => `run-${unit.workUnit.work_unit_id}`,
      });
      const result = await runtime.pumpOnce();
      expect(result.progressed).toBe(2);
      expect(peak).toBe(2);
      expect(result.merges).toHaveLength(1);
      expect(result.merges[0]!.results.map((item) => item.provenance.workUnitId)).toEqual([
        "review-unit",
        "verification-unit",
      ]);
    });
  },
  available,
);
