import {
  agentCompletion,
  agentCompletionStatusSchema,
  caseCheckpoint,
  idString,
  isoTimestamp,
} from "@remoteagent/contracts";
import * as z from "zod";
import type { Database, Transaction } from "../client.js";
import { CheckpointRepository } from "./checkpoint.js";
import {
  ContractViolationError,
  RunCompletionConflictError,
  RunCompletionStateError,
} from "../errors.js";
import { OutboxRepository } from "../queue/outbox.js";

const outboxPayload = z.strictObject({
  completionId: idString,
  runId: idString,
  caseId: idString,
  status: agentCompletionStatusSchema,
  checkpointRevision: z.number().int().nonnegative(),
});

const preparedSchema = z.strictObject({
  completion: agentCompletion,
  checkpoint: caseCheckpoint,
  runSafetyState: z.enum(["SUCCEEDED", "FAILED"]),
  finishedAt: isoTimestamp,
  outbox: z.strictObject({
    aggregate: z.literal("case"),
    aggregateId: idString,
    eventType: z.literal("agent.completion.recorded"),
    payload: outboxPayload,
  }),
});

export type PreparedCompletion = z.infer<typeof preparedSchema>;
export interface CompletionApplyResult {
  readonly replayed: boolean;
  readonly completionId: string;
  readonly checkpointRevision: number;
  readonly outboxId: string;
}

export class RunCompletionRepository {
  private readonly checkpoints = new CheckpointRepository();

  public constructor(
    private readonly db: Database,
    private readonly outbox: OutboxRepository,
  ) {}

  public async apply(input: unknown): Promise<CompletionApplyResult> {
    const parsed = preparedSchema.safeParse(input);
    if (!parsed.success)
      throw new ContractViolationError("invalid prepared AgentCompletion result");
    const prepared = parsed.data;
    this.validateRelations(prepared);

    return this.db.withTransaction(async (tx) => this.applyInTransaction(tx, prepared));
  }

  private validateRelations(prepared: PreparedCompletion): void {
    const { completion, checkpoint, outbox } = prepared;
    if (
      completion.run_id !== outbox.payload.runId ||
      completion.case_id !== outbox.payload.caseId ||
      checkpoint.case_id !== completion.case_id ||
      checkpoint.last_run_id !== completion.run_id ||
      checkpoint.revision !== outbox.payload.checkpointRevision ||
      checkpoint.updated_at !== prepared.finishedAt ||
      outbox.aggregateId !== completion.case_id ||
      outbox.payload.status !== completion.status ||
      prepared.runSafetyState !==
        (completion.status === "FAILED" || completion.status === "CANCELLED"
          ? "FAILED"
          : "SUCCEEDED")
    ) {
      throw new ContractViolationError("prepared completion relationships are inconsistent");
    }
  }

  private async applyInTransaction(
    tx: Transaction,
    prepared: PreparedCompletion,
  ): Promise<CompletionApplyResult> {
    const { completion, checkpoint, outbox } = prepared;
    const runResult = await tx.query<{
      run_id: string;
      case_id: string;
      safety_state: string;
      checkpoint_revision: number;
      finished_at: Date | null;
    }>(
      `SELECT run_id, case_id, safety_state, checkpoint_revision, finished_at FROM agent_runs WHERE run_id = $1 FOR UPDATE`,
      [completion.run_id],
    );
    const run = runResult.rows[0];
    if (!run) throw new RunCompletionStateError(`run not found: ${completion.run_id}`);
    const caseResult = await tx.query<{
      case_id: string;
      checkpoint_revision: number;
      active_run_id: string | null;
    }>(
      `SELECT case_id, checkpoint_revision, active_run_id FROM cases WHERE case_id = $1 FOR UPDATE`,
      [completion.case_id],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) throw new RunCompletionStateError(`case not found: ${completion.case_id}`);

    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      outbox.payload.completionId,
    ]);

    // Replay is intentionally checked before STARTED/active-state checks.
    const existing = await tx.query<{
      completion_id: string;
      run_id: string;
      case_id: string;
      status: string;
      completion: unknown;
    }>(
      `SELECT completion_id, run_id, case_id, status, completion FROM run_completions WHERE run_id = $1`,
      [completion.run_id],
    );
    const completionIdCollision = await tx.query<{ completion_id: string; run_id: string }>(
      `SELECT completion_id, run_id FROM run_completions WHERE completion_id = $1`,
      [outbox.payload.completionId],
    );
    if (
      existing.rows.length > 0 ||
      completionIdCollision.rows.some((r) => r.run_id !== completion.run_id)
    ) {
      const row = existing.rows[0];
      const checkpointRow = await tx.query<{ checkpoint: unknown }>(
        `SELECT checkpoint FROM case_checkpoints WHERE case_id = $1 AND revision = $2`,
        [checkpoint.case_id, checkpoint.revision],
      );
      const outboxRow = await tx.query<{ outbox_id: string }>(
        `SELECT outbox_id FROM outbox WHERE aggregate = $1 AND aggregate_id = $2 AND event_type = $3 AND payload = $4::jsonb`,
        [outbox.aggregate, outbox.aggregateId, outbox.eventType, JSON.stringify(outbox.payload)],
      );
      const dispatch =
        outboxRow.rows.length === 1
          ? await tx.query(`SELECT 1 FROM outbox_dispatch WHERE outbox_id = $1`, [
              outboxRow.rows[0]!.outbox_id,
            ])
          : { rows: [] };
      const completionEqual = row
        ? (
            await tx.query<{ equal: boolean }>(`SELECT $1::jsonb = $2::jsonb AS equal`, [
              row.completion,
              JSON.stringify(completion),
            ])
          ).rows[0]?.equal === true
        : false;
      const checkpointEqual =
        checkpointRow.rows.length === 1 &&
        (
          await tx.query<{ equal: boolean }>(`SELECT $1::jsonb = $2::jsonb AS equal`, [
            checkpointRow.rows[0]!.checkpoint,
            JSON.stringify(checkpoint),
          ])
        ).rows[0]?.equal === true;
      const exact =
        row !== undefined &&
        row.completion_id === outbox.payload.completionId &&
        row.case_id === completion.case_id &&
        row.status === completion.status &&
        row.completion !== null &&
        checkpointRow.rows.length === 1 &&
        outboxRow.rows.length === 1 &&
        dispatch.rows.length === 1 &&
        run.safety_state === prepared.runSafetyState &&
        run.finished_at !== null &&
        new Date(run.finished_at).getTime() === new Date(prepared.finishedAt).getTime() &&
        run.checkpoint_revision === checkpoint.revision - 1 &&
        caseRow.checkpoint_revision === checkpoint.revision &&
        caseRow.active_run_id === null &&
        completionEqual &&
        checkpointEqual;
      if (!exact)
        throw new RunCompletionConflictError(completion.run_id, outbox.payload.completionId);
      return {
        replayed: true,
        completionId: row.completion_id,
        checkpointRevision: checkpoint.revision,
        outboxId: outboxRow.rows[0]!.outbox_id,
      };
    }

    if (
      run.case_id !== completion.case_id ||
      run.safety_state !== "STARTED" ||
      run.checkpoint_revision !== checkpoint.revision - 1 ||
      caseRow.checkpoint_revision !== checkpoint.revision - 1 ||
      caseRow.active_run_id !== completion.run_id
    ) {
      throw new RunCompletionStateError("run/case is not eligible for completion");
    }

    await tx.query(
      `INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        outbox.payload.completionId,
        completion.run_id,
        completion.case_id,
        completion.status,
        JSON.stringify(completion),
      ],
    );
    await this.checkpoints.append(tx, {
      caseId: completion.case_id,
      expectedRevision: checkpoint.revision - 1,
      checkpoint,
      lastRunId: completion.run_id,
    });
    const terminal = await tx.query(
      `UPDATE agent_runs SET safety_state = $2, finished_at = $3 WHERE run_id = $1 AND safety_state = 'STARTED' RETURNING run_id`,
      [completion.run_id, prepared.runSafetyState, prepared.finishedAt],
    );
    if (terminal.rows.length !== 1)
      throw new RunCompletionStateError("run terminal state guard failed");
    const cleared = await tx.query(
      `UPDATE cases SET active_run_id = NULL WHERE case_id = $1 AND active_run_id = $2 RETURNING case_id`,
      [completion.case_id, completion.run_id],
    );
    if (cleared.rows.length !== 1)
      throw new RunCompletionStateError("active run clear guard failed");
    const outboxRow = await this.outbox.enqueue(tx, {
      aggregate: outbox.aggregate,
      aggregateId: outbox.aggregateId,
      eventType: outbox.eventType,
      payload: outbox.payload,
    });
    return {
      replayed: false,
      completionId: outbox.payload.completionId,
      checkpointRevision: checkpoint.revision,
      outboxId: outboxRow.outbox_id,
    };
  }
}
