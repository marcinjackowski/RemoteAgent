import type { AgentCompletion, WorkUnit } from "@remoteagent/contracts";
import { workUnit as workUnitSchema } from "@remoteagent/contracts";
import {
  CheckpointRepository,
  OutboxRepository,
  RunCompletionRepository,
  WorkUnitRepository,
  type Clock,
  type Database,
  type IdGenerator,
} from "@remoteagent/database";

/**
 * The PostgreSQL side of `RuntimePersistence` (RA-028-WU-01).
 *
 * WHY THIS LIVES IN THE APP, NOT IN `agent-orchestrator`: that package depends on
 * `contracts` and `observability` only — deliberately. It defines the port
 * (`RuntimePersistence`) and does not know PostgreSQL is behind it. Adding a database
 * dependency there would invert that and is an architecture change requiring an ADR.
 * A composition root is exactly the place that binds a port to a driver.
 *
 * This is a PROMOTION of the 199-line `PgRuntimeStore` that lived in
 * `packages/agent-orchestrator/test/orchestrator.integration.test.ts`. Three things
 * that were acceptable in a harness are NOT acceptable here, and each is a real defect
 * rather than a style difference:
 *
 *  1. The harness hardcoded `started_at`/`finished_at` as literal 2026-08-20 strings.
 *     In production every run would report the same instant, making duration and
 *     staleness unreadable. Time is injected via `Clock`, the convention already used
 *     by `OutboxRepository` and the queue.
 *  2. The harness hand-rolled `INSERT INTO run_completions`, bypassing
 *     `RunCompletionRepository.apply()` — which takes an advisory lock, locks the run
 *     and case `FOR UPDATE`, advances the checkpoint and writes the outbox row in ONE
 *     transaction. Bypassing it loses the checkpoint advance and the outbox event, so
 *     nothing downstream would ever learn the run completed. This adapter calls the
 *     audited path.
 *  3. The harness took `provider` from a constructor map supplied by the test. It is
 *     the FairScheduler's per-provider concurrency key: with it absent, per-provider
 *     limits silently do not apply (`fairness.ts` treats a missing provider as
 *     unlimited). It is derived from `external_entities` here.
 */

/** Injected so a test can drive completion timestamps without a hardcoded literal. */
export interface WorkerPersistenceRuntime {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

interface RunRow {
  readonly runId: string;
  readonly checkpointRevision: number;
  readonly triggerEventId: string | null;
  readonly model: { readonly provider: string; readonly model_id: string } | null;
}

export class WorkerPersistence {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #units = new WorkUnitRepository();
  readonly #checkpoints = new CheckpointRepository();
  readonly #completions: RunCompletionRepository;

  public constructor(db: Database, runtime: WorkerPersistenceRuntime) {
    this.#db = db;
    this.#clock = runtime.clock;
    this.#ids = runtime.ids;
    this.#completions = new RunCompletionRepository(
      db,
      new OutboxRepository({ clock: runtime.clock, ids: runtime.ids }),
    );
  }

  /**
   * Cases with work that is not finished. The harness selected DISTINCT over every
   * `work_units` row, which on a long-lived database means recovery walks every case
   * the system has ever handled — including thousands of terminal ones — on each start.
   */
  public async listCaseIds(): Promise<readonly string[]> {
    const result = await this.#db.query<{ case_id: string }>(
      `SELECT DISTINCT case_id FROM work_units
        WHERE status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
        ORDER BY case_id`,
    );
    return result.rows.map((row) => row.case_id);
  }

  public async recover(caseId: string): Promise<{
    caseId: string;
    checkpointRevision: number;
    writerBlocked: boolean;
    units: readonly {
      workUnit: WorkUnit;
      provider?: string;
      run: RunRow | null;
      completion: AgentCompletion | null;
    }[];
  }> {
    const providers = await this.providersByUnit(caseId);
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
    const revision = await this.#db.query<{ checkpoint_revision: number }>(
      "SELECT checkpoint_revision FROM cases WHERE case_id = $1",
      [caseId],
    );
    // AC5: an unresolved model or tool outcome must never be replayed. `AMBIGUOUS` is
    // listed alongside the in-progress states so recovery reports the case as blocked
    // rather than starting a second writer over an effect nobody has confirmed.
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
      units: result.rows.map((row) => {
        const workUnit = this.toWorkUnit(row);
        const provider = providers.get(workUnit.work_unit_id);
        return {
          workUnit,
          ...(provider === undefined ? {} : { provider }),
          run:
            row.run_id === null
              ? null
              : {
                  runId: row.run_id as string,
                  checkpointRevision: Number(row.checkpoint_revision),
                  triggerEventId: row.trigger_event_id as string | null,
                  model: row.model as RunRow["model"],
                },
          completion: (row.completion ?? null) as AgentCompletion | null,
        };
      }),
    };
  }

  public async claim(input: {
    readonly workUnitId: string;
    readonly runId: string;
    readonly checkpointRevision: number;
    readonly triggerEventId?: string | null;
    readonly model?: { readonly provider: string; readonly model_id: string };
  }): Promise<{ unit: { workUnit: WorkUnit; provider?: string }; run: RunRow } | null> {
    const claimed = await this.#units.claim(this.#db, input);
    if (!claimed) return null;
    const workUnit = this.toWorkUnit(claimed.workUnit as unknown as Record<string, unknown>);
    const provider = await this.providerFor(workUnit.case_id, workUnit.work_unit_id);
    return {
      unit: { workUnit, ...(provider === undefined ? {} : { provider }) },
      run: {
        runId: claimed.run.run_id,
        checkpointRevision: claimed.run.checkpoint_revision,
        triggerEventId: claimed.run.trigger_event_id,
        model: claimed.run.model as RunRow["model"],
      },
    };
  }

  public async start(input: {
    readonly workUnitId: string;
    readonly runId: string;
  }): Promise<{ workUnit: WorkUnit; provider?: string }> {
    const row = await this.#units.start(this.#db, input);
    // Parsed, NOT cast. `WorkUnitRow` types `created_at`/`updated_at` as `Date`, while the
    // `WorkUnit` contract requires ISO strings — so a blind cast produces a value that
    // typechecks and fails `workUnit.safeParse` at runtime. `WriterLeaseGuard` re-parses the
    // unit it is handed, which is what surfaced this: the writer was rejected with "invalid
    // work unit for writer lease" even under a perfectly valid lease.
    const workUnit = this.toWorkUnit(row as unknown as Record<string, unknown>);
    await this.#db.withTransaction(async (tx) => {
      // Guarded on PLANNED so a duplicate `start` cannot rewind `started_at` on a run
      // that is already executing, and cannot resurrect a run that finished.
      await tx.query(
        `UPDATE agent_runs SET safety_state = 'STARTED', started_at = $2
          WHERE run_id = $1 AND safety_state = 'PLANNED'`,
        [input.runId, new Date(this.#clock.now()).toISOString()],
      );
      // CLAIM THE CASE'S ACTIVE RUN. This was MISSING everywhere in the repository: no
      // production code set `cases.active_run_id`, only `RunCompletionRepository` cleared
      // it — so every test that reached completion had set it by hand, and the first real
      // pass failed with `run/case is not eligible for completion`.
      //
      // The `IS NULL OR = $2` guard makes this the durable single-writer gate for a case
      // (`AGENTS.md` §7): a second run cannot claim a case that already has an active one,
      // and the FK added in migration 011 pins the run to this same case. Re-running with
      // the same run id is idempotent, which recovery depends on.
      const claimed = await tx.query(
        `UPDATE cases SET active_run_id = $2
          WHERE case_id = $1 AND (active_run_id IS NULL OR active_run_id = $2)
          RETURNING case_id`,
        [workUnit.case_id, input.runId],
      );
      if (claimed.rowCount !== 1) {
        throw new Error(
          `case ${workUnit.case_id} already has a different active run; refusing to start ${input.runId}`,
        );
      }
    });
    const provider = await this.providerFor(workUnit.case_id, workUnit.work_unit_id);
    return { workUnit, ...(provider === undefined ? {} : { provider }) };
  }

  /**
   * Delegates to the audited `RunCompletionRepository.apply()`; `prepareCompletion` in
   * `agent-orchestrator` builds the checkpoint and outbox payload it validates. The
   * caller supplies the prepared value because preparation is pure and belongs on the
   * orchestrator side of the port.
   */
  public async persistPrepared(prepared: unknown): Promise<{ replayed: boolean }> {
    const result = await this.#completions.apply(prepared);
    return { replayed: result.replayed };
  }

  public async latestCheckpoint(caseId: string): Promise<unknown | null> {
    const row = await this.#checkpoints.latest(this.#db, caseId);
    return row?.checkpoint ?? null;
  }

  /**
   * CTF-020: create the revision-0 baseline checkpoint a fresh case lacks (nothing in production
   * writes the first one), so the first completion can advance from it instead of throwing.
   * Idempotent; leaves `cases.checkpoint_revision` at 0 so the run (claimed at 0) stays aligned.
   */
  public async ensureBaselineCheckpoint(caseId: string): Promise<unknown> {
    return this.#db.withTransaction((tx) =>
      this.#checkpoints.ensureBaseline(tx, { caseId, updatedAt: this.nowIso() }),
    );
  }

  public async finalize(input: {
    readonly workUnitId: string;
    readonly runId: string;
    readonly status: "COMPLETED" | "FAILED" | "CANCELLED";
  }): Promise<{ replayed: boolean }> {
    const result = await this.#units.finalize(this.#db, input);
    return { replayed: result.replayed };
  }

  /**
   * AC5. Guarded on `STARTED` so a run that already reached a terminal safety state is
   * not dragged back into `AMBIGUOUS`, which would block its case forever.
   */
  public async markAmbiguous(input: {
    readonly workUnitId: string;
    readonly runId: string;
    readonly reason: string;
  }): Promise<void> {
    // Temporary diagnostic: log the root-cause before it is discarded.
    process.stderr.write(
      `[markAmbiguous] unit=${input.workUnitId} run=${input.runId} reason=${input.reason}\n`,
    );
    await this.#db.query(
      `UPDATE agent_runs SET safety_state = 'AMBIGUOUS'
        WHERE run_id = $1 AND safety_state = 'STARTED'`,
      [input.runId],
    );
  }

  public nextRunId(): string {
    return this.#ids.next("run");
  }

  public nextCompletionId(): string {
    return this.#ids.next("completion");
  }

  public nowIso(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  /**
   * The FairScheduler's per-provider concurrency key, derived from the case's external entities.
   * A case touching exactly one provider yields that provider; a case touching several
   * yields `undefined` rather than an arbitrary pick, because charging a
   * multi-provider case against one provider's limit would throttle the wrong one.
   */
  private async providersByUnit(caseId: string): Promise<Map<string, string>> {
    const result = await this.#db.query<{ work_unit_id: string; provider: string }>(
      `SELECT w.work_unit_id, MIN(e.provider) AS provider
         FROM work_units w
         JOIN external_entities e ON e.case_id = w.case_id
        WHERE w.case_id = $1
        GROUP BY w.work_unit_id
       HAVING COUNT(DISTINCT e.provider) = 1`,
      [caseId],
    );
    return new Map(result.rows.map((row) => [row.work_unit_id, row.provider]));
  }

  private async providerFor(caseId: string, workUnitId: string): Promise<string | undefined> {
    return (await this.providersByUnit(caseId)).get(workUnitId);
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
