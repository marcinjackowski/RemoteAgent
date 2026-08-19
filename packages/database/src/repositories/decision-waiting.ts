import { agentCompletion, caseCheckpoint, decisionRequest, idString } from "@remoteagent/contracts";
import type { DecisionRequest } from "@remoteagent/contracts";
import * as z from "zod";

import type { Database, Transaction } from "../client.js";
import { ContractViolationError } from "../errors.js";
import { DecisionWaitingConflictError, DecisionWaitingStateError } from "../errors.js";
import { OutboxRepository } from "../queue/outbox.js";
import { DecisionRepository } from "./decision.js";

const preparedSchema = z.strictObject({ sourceRunId: idString, request: decisionRequest });

export interface PreparedDecisionWaiting {
  sourceRunId: string;
  request: DecisionRequest;
}

export interface DecisionWaitingResult {
  readonly replayed: boolean;
  readonly decisionId: string;
  readonly outboxId: string;
}

export class DecisionWaitingRepository {
  private readonly decisions = new DecisionRepository();

  public constructor(
    private readonly db: Database,
    private readonly outbox: OutboxRepository,
  ) {}

  /** Materialize a committed WAITING_FOR_USER completion atomically. */
  public async materialize(input: unknown): Promise<DecisionWaitingResult> {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new ContractViolationError("invalid prepared decision waiting result");
    const parsed = preparedSchema.safeParse(input);
    if (!parsed.success)
      throw new ContractViolationError("invalid prepared decision waiting result");
    return this.db.withTransaction((tx) =>
      this.applyInTransaction(tx, parsed.data.sourceRunId, parsed.data.request),
    );
  }

  /** Alias matching other atomic persistence repositories. */
  public async apply(input: unknown): Promise<DecisionWaitingResult> {
    return this.materialize(input);
  }

  private async applyInTransaction(
    tx: Transaction,
    sourceRunId: string,
    prepared: DecisionRequest,
  ): Promise<DecisionWaitingResult> {
    // All decision-related writers (including answer/resume) take this lock
    // before row locks. Keeping one global order prevents cross-repository
    // decision/case deadlocks.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [prepared.decision_id]);
    const runResult = await tx.query<{
      run_id: string;
      case_id: string;
      safety_state: string;
      checkpoint_revision: number;
      finished_at: Date | null;
    }>(
      `SELECT run_id, case_id, safety_state, checkpoint_revision, finished_at FROM agent_runs WHERE run_id = $1 FOR UPDATE`,
      [sourceRunId],
    );
    const run = runResult.rows[0];
    if (!run) throw new DecisionWaitingStateError(`source run not found: ${sourceRunId}`);

    const completionResult = await tx.query<{
      completion: unknown;
      status: string;
      case_id: string;
    }>(`SELECT completion, status, case_id FROM run_completions WHERE run_id = $1 FOR UPDATE`, [
      sourceRunId,
    ]);
    const completionRow = completionResult.rows[0];
    const completion = completionRow && agentCompletion.safeParse(completionRow.completion);
    const caseResult = await tx.query<{
      case_id: string;
      status: string;
      active_run_id: string | null;
      checkpoint_revision: number;
    }>(
      `SELECT case_id, status, active_run_id, checkpoint_revision FROM cases WHERE case_id = $1 FOR UPDATE`,
      [run.case_id],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow || !completionRow || !completion?.success)
      throw new DecisionWaitingStateError("source completion is missing or invalid");

    const completionRequest =
      completion.data.status === "WAITING_FOR_USER" ? completion.data.decision_request : undefined;
    const checkpointResult = await tx.query<{ checkpoint: unknown; last_run_id: string | null }>(
      `SELECT checkpoint, last_run_id FROM case_checkpoints
       WHERE case_id = $1 AND revision = $2`,
      [run.case_id, caseRow.checkpoint_revision],
    );
    const checkpointRow = checkpointResult.rows[0];
    const checkpoint = checkpointRow && caseCheckpoint.safeParse(checkpointRow.checkpoint);
    const authoritativeRequest =
      completionRequest && checkpoint?.success
        ? decisionRequest.safeParse({
            ...completionRequest,
            case_id: caseRow.case_id,
            checkpoint_revision: caseRow.checkpoint_revision,
          })
        : undefined;
    const payload = {
      decisionId: prepared.decision_id,
      caseId: caseRow.case_id,
      checkpointRevision: caseRow.checkpoint_revision,
      sourceRunId,
    };

    const requestEquality = authoritativeRequest?.success
      ? await tx.query<{ equal: boolean }>(`SELECT $1::jsonb = $2::jsonb AS equal`, [
          JSON.stringify(authoritativeRequest.data),
          JSON.stringify(prepared),
        ])
      : undefined;
    const requestMatches = requestEquality?.rows[0]?.equal === true;
    const sourceValid =
      run.case_id === prepared.case_id &&
      run.safety_state === "SUCCEEDED" &&
      run.finished_at !== null &&
      completion.data.run_id === sourceRunId &&
      completion.data.case_id === run.case_id &&
      completionRow.case_id === run.case_id &&
      completionRow.status === completion.data.status &&
      completionRow.status === "WAITING_FOR_USER" &&
      completion.data.status === "WAITING_FOR_USER" &&
      run.checkpoint_revision === caseRow.checkpoint_revision - 1 &&
      requestMatches &&
      checkpoint?.success === true &&
      checkpoint.data.case_id === caseRow.case_id &&
      checkpoint.data.revision === caseRow.checkpoint_revision &&
      checkpoint.data.last_run_id === sourceRunId &&
      checkpointRow?.last_run_id === sourceRunId &&
      caseRow.active_run_id === null;

    const existing = await this.decisions.findRequest(tx, prepared.decision_id);
    const decisionEvents = await tx.query<{
      outbox_id: string;
      aggregate: string;
      aggregate_id: string;
      event_type: string;
      payload: unknown;
    }>(
      `SELECT outbox_id, aggregate, aggregate_id, event_type, payload FROM outbox
       WHERE event_type = 'decision.requested' AND payload->>'decisionId' = $1`,
      [prepared.decision_id],
    );
    const matchingOutbox = await tx.query<{ outbox_id: string }>(
      `SELECT outbox_id FROM outbox
       WHERE aggregate = 'case' AND aggregate_id = $1 AND event_type = 'decision.requested'
         AND payload = $2::jsonb`,
      [caseRow.case_id, JSON.stringify(payload)],
    );
    const dispatch =
      matchingOutbox.rows.length === 1
        ? await tx.query<{
            status: string;
            attempts: number;
            lease_owner: string | null;
            lease_expires_at: Date | null;
            published_at: Date | null;
          }>(
            `SELECT status, attempts, lease_owner, lease_expires_at, published_at
             FROM outbox_dispatch WHERE outbox_id = $1`,
            [matchingOutbox.rows[0]!.outbox_id],
          )
        : { rows: [] };
    const exact =
      existing !== null &&
      sourceValid &&
      caseRow.status === "WAITING_FOR_USER" &&
      caseRow.active_run_id === null &&
      caseRow.checkpoint_revision === prepared.checkpoint_revision &&
      matchingOutbox.rows.length === 1 &&
      decisionEvents.rows.length === 1 &&
      decisionEvents.rows[0]!.aggregate === "case" &&
      decisionEvents.rows[0]!.aggregate_id === caseRow.case_id &&
      decisionEvents.rows[0]!.event_type === "decision.requested" &&
      dispatch.rows.length === 1;
    if (exact) {
      const equality = await tx.query<{ equal: boolean }>(`SELECT $1::jsonb = $2::jsonb AS equal`, [
        JSON.stringify(
          Object.fromEntries(Object.entries(existing!).filter(([key]) => key !== "created_at")),
        ),
        JSON.stringify(prepared),
      ]);
      if (!equality.rows[0]?.equal) throw new DecisionWaitingConflictError(prepared.decision_id);
      return {
        replayed: true,
        decisionId: prepared.decision_id,
        outboxId: matchingOutbox.rows[0]!.outbox_id,
      };
    }
    if (existing !== null || decisionEvents.rows.length > 0 || matchingOutbox.rows.length > 0)
      throw new DecisionWaitingConflictError(prepared.decision_id);

    if (!sourceValid || !["PLANNING", "IMPLEMENTING"].includes(caseRow.status)) {
      throw new DecisionWaitingStateError("source completion or case is not eligible");
    }
    if (!authoritativeRequest?.success)
      throw new DecisionWaitingStateError("source decision request is invalid");

    await this.decisions.insertRequest(tx, authoritativeRequest.data);
    const transitioned = await tx.query(
      `UPDATE cases SET status = 'WAITING_FOR_USER'
       WHERE case_id = $1 AND status IN ('PLANNING', 'IMPLEMENTING')
         AND active_run_id IS NULL AND checkpoint_revision = $2
       RETURNING case_id`,
      [caseRow.case_id, prepared.checkpoint_revision],
    );
    if (transitioned.rows.length !== 1)
      throw new DecisionWaitingStateError("case status transition guard failed");
    const outbox = await this.outbox.enqueue(tx, {
      aggregate: "case",
      aggregateId: caseRow.case_id,
      eventType: "decision.requested",
      payload,
    });
    return { replayed: false, decisionId: prepared.decision_id, outboxId: outbox.outbox_id };
  }
}
