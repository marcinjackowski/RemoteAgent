import {
  agentRoleSchema,
  idString,
  workUnit,
  type AgentRole,
  type WorkUnit,
  type WorkUnitStatus,
} from "@remoteagent/contracts";
import * as z from "zod";

import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import { ContractViolationError, WorkUnitConflictError, WorkUnitStateError } from "../errors.js";

export interface NewWorkUnit {
  readonly workUnitId: string;
  readonly caseId: string;
  readonly role: AgentRole;
  readonly objective: string;
  readonly authoritativeScope: WorkUnit["authoritative_scope"];
}

export interface WorkUnitRow {
  readonly schema_version: number;
  readonly work_unit_id: string;
  readonly case_id: string;
  readonly role: AgentRole;
  readonly status: WorkUnitStatus;
  readonly objective: string;
  readonly authoritative_scope: WorkUnit["authoritative_scope"];
  readonly run_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WorkUnitInsertResult {
  readonly workUnit: WorkUnitRow;
  readonly inserted: boolean;
}

export interface ClaimWorkUnit {
  readonly workUnitId: string;
  readonly runId: string;
  readonly checkpointRevision: number;
  readonly triggerEventId?: string | null;
  readonly model?: { readonly provider: string; readonly model_id: string };
}

export interface WorkUnitClaim {
  readonly workUnit: WorkUnitRow;
  readonly run: {
    readonly run_id: string;
    readonly case_id: string;
    readonly work_unit_id: string;
    readonly role: AgentRole;
    readonly safety_state: "PLANNED";
    readonly checkpoint_revision: number;
    readonly trigger_event_id: string | null;
    readonly model: Record<string, unknown> | null;
  };
}

export interface WorkUnitTransition {
  readonly workUnitId: string;
  readonly runId: string;
}

export interface WorkUnitFinalize extends WorkUnitTransition {
  readonly status: Extract<WorkUnitStatus, "COMPLETED" | "FAILED" | "CANCELLED">;
}

export interface WorkUnitFinalizeResult {
  readonly workUnit: WorkUnitRow;
  readonly replayed: boolean;
}

export interface WorkUnitTxDb {
  withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
}

const workUnitColumns = `schema_version, work_unit_id, case_id, role, status, objective,
  authoritative_scope, run_id, created_at, updated_at`;

const inputSchema = z.strictObject({
  workUnitId: idString,
  caseId: idString,
  role: agentRoleSchema,
  objective: z.string().min(1),
  authoritativeScope: z.unknown(),
});

function parseInput(input: NewWorkUnit): z.infer<typeof inputSchema> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ContractViolationError("invalid WorkUnit payload");
  const candidate = {
    schema_version: 1,
    work_unit_id: parsed.data.workUnitId,
    case_id: parsed.data.caseId,
    role: parsed.data.role,
    status: "PENDING",
    objective: parsed.data.objective,
    run_id: null,
    authoritative_scope: parsed.data.authoritativeScope,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const checked = workUnit.safeParse(candidate);
  if (!checked.success) throw new ContractViolationError("invalid WorkUnit contract");
  return parsed.data;
}

function mapRow(row: Record<string, unknown>): WorkUnitRow {
  const created = new Date(row.created_at as string | Date);
  const updated = new Date(row.updated_at as string | Date);
  const checked = workUnit.safeParse({
    schema_version: row.schema_version,
    work_unit_id: row.work_unit_id,
    case_id: row.case_id,
    role: row.role,
    status: row.status,
    objective: row.objective,
    authoritative_scope: row.authoritative_scope,
    run_id: row.run_id,
    created_at: created.toISOString(),
    updated_at: updated.toISOString(),
  });
  if (!checked.success) throw new ContractViolationError("invalid persisted WorkUnit");
  return {
    ...checked.data,
    created_at: created,
    updated_at: updated,
  };
}

function sameInput(row: WorkUnitRow, input: z.infer<typeof inputSchema>): boolean {
  return (
    row.work_unit_id === input.workUnitId &&
    row.case_id === input.caseId &&
    row.role === input.role &&
    row.status === "PENDING" &&
    row.objective === input.objective &&
    row.run_id === null &&
    stable(row.authoritative_scope) === stable(input.authoritativeScope)
  );
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

export class WorkUnitRepository {
  public async insert(q: Queryable, input: NewWorkUnit): Promise<WorkUnitInsertResult> {
    return this.save(q, input);
  }

  public async save(q: Queryable, input: NewWorkUnit): Promise<WorkUnitInsertResult> {
    const parsed = parseInput(input);
    try {
      const inserted = await q.query<Record<string, unknown>>(
        `INSERT INTO work_units
           (work_unit_id, case_id, role, status, objective, authoritative_scope, run_id)
         VALUES ($1, $2, $3, 'PENDING', $4, $5::jsonb, NULL)
         ON CONFLICT (work_unit_id) DO NOTHING
         RETURNING ${workUnitColumns}`,
        [
          parsed.workUnitId,
          parsed.caseId,
          parsed.role,
          parsed.objective,
          JSON.stringify(parsed.authoritativeScope),
        ],
      );
      if (inserted.rows[0]) return { workUnit: mapRow(inserted.rows[0]), inserted: true };
      const existing = await this.findById(q, parsed.workUnitId);
      if (!existing || !sameInput(existing, parsed))
        throw new WorkUnitConflictError(parsed.workUnitId);
      return { workUnit: existing, inserted: false };
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async upsert(q: Queryable, input: NewWorkUnit): Promise<WorkUnitInsertResult> {
    return this.save(q, input);
  }

  public async findById(q: Queryable, workUnitId: string): Promise<WorkUnitRow | null> {
    const id = idString.safeParse(workUnitId);
    if (!id.success) throw new ContractViolationError("invalid work unit id");
    const result = await q.query<Record<string, unknown>>(
      `SELECT ${workUnitColumns} FROM work_units WHERE work_unit_id = $1`,
      [id.data],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Atomically claims one pending unit and binds exactly one fresh PLANNED run. */
  public async claim(db: WorkUnitTxDb, input: ClaimWorkUnit): Promise<WorkUnitClaim | null> {
    const parsed = this.parseClaim(input);
    return db.withTransaction(async (tx) => {
      const candidate = await tx.query<Record<string, unknown>>(
        `SELECT ${workUnitColumns} FROM work_units w
         WHERE w.work_unit_id = $1
         FOR UPDATE`,
        [parsed.workUnitId],
      );
      const selected = candidate.rows[0];
      if (!selected) throw new WorkUnitStateError("work unit does not exist");
      const unit = mapRow(selected);
      if (unit.run_id !== null) {
        if (unit.run_id !== parsed.runId)
          throw new WorkUnitStateError("work unit is already bound to another run");
        if (unit.status !== "DISPATCHED" && unit.status !== "RUNNING")
          throw new WorkUnitStateError("terminal work unit cannot be claimed");
        const existingRun = await tx.query<WorkUnitClaim["run"]>(
          `SELECT run_id, case_id, work_unit_id, role, safety_state, checkpoint_revision,
                  trigger_event_id, model
           FROM agent_runs WHERE run_id = $1`,
          [parsed.runId],
        );
        if (!existingRun.rows[0]) throw new WorkUnitStateError("work unit binding run is missing");
        if (
          existingRun.rows[0].case_id !== unit.case_id ||
          existingRun.rows[0].work_unit_id !== unit.work_unit_id ||
          existingRun.rows[0].role !== unit.role ||
          existingRun.rows[0].checkpoint_revision !== parsed.checkpointRevision ||
          existingRun.rows[0].safety_state !== "PLANNED" ||
          existingRun.rows[0].trigger_event_id !== (parsed.triggerEventId ?? null) ||
          stable(existingRun.rows[0].model) !== stable(parsed.model ?? null)
        )
          throw new WorkUnitConflictError(parsed.workUnitId);
        return { workUnit: unit, run: existingRun.rows[0] };
      }
      if (unit.status !== "PENDING") throw new WorkUnitStateError("work unit is not claimable");
      const run = await tx.query<WorkUnitClaim["run"]>(
        `INSERT INTO agent_runs
           (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision,
           trigger_event_id, model)
         VALUES ($1, $2, (SELECT owner_id FROM cases WHERE case_id = $2), $3, $4,
                 'PLANNED', $5, $6, $7::jsonb)
         RETURNING run_id, case_id, work_unit_id, role, safety_state, checkpoint_revision,
                   trigger_event_id, model`,
        [
          parsed.runId,
          unit.case_id,
          unit.work_unit_id,
          unit.role,
          parsed.checkpointRevision,
          parsed.triggerEventId,
          parsed.model ? JSON.stringify(parsed.model) : null,
        ],
      );
      const bound = await tx.query<Record<string, unknown>>(
        `UPDATE work_units
         SET status = 'DISPATCHED', run_id = $2
         WHERE work_unit_id = $1 AND status = 'PENDING' AND run_id IS NULL
         RETURNING ${workUnitColumns}`,
        [unit.work_unit_id, parsed.runId],
      );
      if (!bound.rows[0]) throw new WorkUnitStateError("work unit claim guard failed");
      return { workUnit: mapRow(bound.rows[0]), run: run.rows[0]! };
    });
  }

  /** Apply the contract's DISPATCHED -> RUNNING transition for the bound run. */
  public async start(q: Queryable, input: WorkUnitTransition): Promise<WorkUnitRow> {
    const parsed = this.parseTransition(input);
    const result = await q.query<Record<string, unknown>>(
      `UPDATE work_units SET status = 'RUNNING'
       WHERE work_unit_id = $1 AND run_id = $2 AND status = 'DISPATCHED'
       RETURNING ${workUnitColumns}`,
      [parsed.workUnitId, parsed.runId],
    );
    if (result.rows[0]) return mapRow(result.rows[0]);
    const current = await this.findById(q, parsed.workUnitId);
    if (current?.run_id === parsed.runId && current.status === "RUNNING") return current;
    throw new WorkUnitStateError("work unit is not eligible to start");
  }

  public async dispatch(q: Queryable, input: WorkUnitTransition): Promise<WorkUnitRow> {
    return this.start(q, input);
  }

  /** Finalize only the currently bound run; an exact terminal retry is a no-op. */
  public async finalize(
    db: WorkUnitTxDb,
    input: WorkUnitFinalize,
  ): Promise<WorkUnitFinalizeResult> {
    const parsed = this.parseFinalize(input);
    return db.withTransaction(async (tx) => {
      const currentResult = await tx.query<Record<string, unknown>>(
        `SELECT ${workUnitColumns} FROM work_units WHERE work_unit_id = $1 FOR UPDATE`,
        [parsed.workUnitId],
      );
      const current = currentResult.rows[0] ? mapRow(currentResult.rows[0]) : null;
      if (!current) throw new WorkUnitStateError("work unit does not exist");
      if (current.run_id !== parsed.runId)
        throw new WorkUnitStateError("completion is stale for the current run binding");
      if (current.status === parsed.status) return { workUnit: current, replayed: true };
      if (current.status !== "RUNNING")
        throw new WorkUnitStateError("work unit is not eligible for finalization");
      const result = await tx.query<Record<string, unknown>>(
        `UPDATE work_units SET status = $3
         WHERE work_unit_id = $1 AND run_id = $2 AND status = 'RUNNING'
         RETURNING ${workUnitColumns}`,
        [parsed.workUnitId, parsed.runId, parsed.status],
      );
      if (!result.rows[0]) throw new WorkUnitStateError("work unit finalization guard failed");
      return { workUnit: mapRow(result.rows[0]), replayed: false };
    });
  }

  public async complete(
    db: WorkUnitTxDb,
    input: WorkUnitFinalize,
  ): Promise<WorkUnitFinalizeResult> {
    return this.finalize(db, input);
  }

  private parseClaim(input: ClaimWorkUnit): ClaimWorkUnit {
    const parsed = z
      .strictObject({
        workUnitId: idString,
        runId: idString,
        checkpointRevision: z.number().int().nonnegative(),
        triggerEventId: idString.nullable().optional(),
        model: z.strictObject({ provider: idString, model_id: idString }).optional(),
      })
      .safeParse(input);
    if (!parsed.success) throw new ContractViolationError("invalid work unit claim");
    return {
      workUnitId: parsed.data.workUnitId,
      runId: parsed.data.runId,
      checkpointRevision: parsed.data.checkpointRevision,
      ...(parsed.data.triggerEventId === undefined
        ? {}
        : { triggerEventId: parsed.data.triggerEventId }),
      ...(parsed.data.model === undefined ? {} : { model: parsed.data.model }),
    };
  }

  private parseTransition(input: WorkUnitTransition): WorkUnitTransition {
    const parsed = z.strictObject({ workUnitId: idString, runId: idString }).safeParse(input);
    if (!parsed.success) throw new ContractViolationError("invalid work unit transition");
    return parsed.data;
  }

  private parseFinalize(input: WorkUnitFinalize): WorkUnitFinalize {
    const parsed = z
      .strictObject({
        workUnitId: idString,
        runId: idString,
        status: z.enum(["COMPLETED", "FAILED", "CANCELLED"]),
      })
      .safeParse(input);
    if (!parsed.success) throw new ContractViolationError("invalid work unit finalization");
    return parsed.data;
  }
}
