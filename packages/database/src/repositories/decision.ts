import {
  assertAnswerMatchesRequest,
  decisionAnswer,
  decisionRequest,
  idString,
} from "@remoteagent/contracts";
import type { DecisionAnswer, DecisionRequest } from "@remoteagent/contracts";

import type { Queryable } from "../client.js";
import { translatePgError } from "../client.js";
import { ContractViolationError, DecisionAnswerConflictError } from "../errors.js";

export interface DecisionRequestRow extends DecisionRequest {
  created_at: Date;
}

export interface DecisionAnswerRow extends DecisionAnswer {
  answer_id: string;
}

export interface DecisionAnswerInsertResult {
  answer: DecisionAnswerRow;
  inserted: boolean;
}

export interface NewDecisionAnswer {
  answerId: string;
  answer: DecisionAnswer;
}

function parseRequest(input: DecisionRequest): DecisionRequest {
  const parsed = decisionRequest.safeParse(input);
  if (!parsed.success) {
    throw new ContractViolationError("invalid DecisionRequest payload");
  }
  return parsed.data;
}

function parseAnswer(input: DecisionAnswer): DecisionAnswer {
  const parsed = decisionAnswer.safeParse(input);
  if (!parsed.success) {
    throw new ContractViolationError("invalid DecisionAnswer payload");
  }
  return parsed.data;
}

function mapRequest(row: Record<string, unknown>): DecisionRequestRow {
  const parsed = decisionRequest.safeParse({
    schema_version: 1,
    decision_id: row.decision_id,
    case_id: row.case_id,
    question: row.question,
    why_now: row.why_now,
    options: row.options,
    recommendation: row.recommendation,
    blocked_scope: row.blocked_scope,
    checkpoint_revision: row.checkpoint_revision,
    ...(row.expires_at === null || row.expires_at === undefined
      ? {}
      : { expires_at: new Date(row.expires_at as string | Date).toISOString() }),
  });
  if (!parsed.success) throw new ContractViolationError("invalid persisted DecisionRequest");
  return { ...parsed.data, created_at: row.created_at as Date };
}

function mapAnswer(row: Record<string, unknown>): DecisionAnswerRow {
  const parsed = decisionAnswer.safeParse({
    schema_version: 1,
    decision_id: row.decision_id,
    case_id: row.case_id,
    checkpoint_revision: row.checkpoint_revision,
    selected_option_id: row.selected_option_id,
    ...(row.note === null || row.note === undefined ? {} : { note: row.note }),
    answered_by: row.answered_by,
    answered_at: new Date(row.answered_at as string | Date).toISOString(),
  });
  if (!parsed.success) throw new ContractViolationError("invalid persisted DecisionAnswer");
  return { ...parsed.data, answer_id: row.answer_id as string };
}

const requestColumns = `decision_id, case_id, question, why_now, options,
  recommendation, blocked_scope, checkpoint_revision, expires_at, created_at`;
const answerColumns = `answer_id, decision_id, case_id, checkpoint_revision,
  selected_option_id, note, answered_by, answered_at`;

export class DecisionRepository {
  public async insertRequest(q: Queryable, input: DecisionRequest): Promise<DecisionRequestRow> {
    const request = parseRequest(input);
    try {
      const result = await q.query<Record<string, unknown>>(
        `INSERT INTO decisions
           (decision_id, case_id, question, why_now, options, recommendation,
            blocked_scope, checkpoint_revision, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         RETURNING ${requestColumns}`,
        [
          request.decision_id,
          request.case_id,
          request.question,
          request.why_now,
          JSON.stringify(request.options),
          request.recommendation,
          request.blocked_scope,
          request.checkpoint_revision,
          request.expires_at ? new Date(request.expires_at) : null,
        ],
      );
      return mapRequest(result.rows[0]!);
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findRequest(q: Queryable, decisionId: string): Promise<DecisionRequestRow | null> {
    const result = await q.query<Record<string, unknown>>(
      `SELECT ${requestColumns} FROM decisions WHERE decision_id = $1`,
      [decisionId],
    );
    return result.rows[0] ? mapRequest(result.rows[0]) : null;
  }

  public async answer(q: Queryable, input: NewDecisionAnswer): Promise<DecisionAnswerInsertResult> {
    const answerIdResult = idString.safeParse(input.answerId);
    if (!answerIdResult.success) throw new ContractViolationError("invalid DecisionAnswer payload");
    const answerId = answerIdResult.data;
    const answer = parseAnswer(input.answer);
    const request = await this.findRequest(q, answer.decision_id);
    if (!request) throw new ContractViolationError("decision request does not exist");
    assertAnswerMatchesRequest(request, answer);

    try {
      const inserted = await q.query<Record<string, unknown>>(
        `INSERT INTO decision_answers
           (answer_id, decision_id, case_id, checkpoint_revision,
            selected_option_id, note, answered_by, answered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (decision_id) DO NOTHING
         RETURNING ${answerColumns}`,
        [
          answerId,
          answer.decision_id,
          answer.case_id,
          answer.checkpoint_revision,
          answer.selected_option_id,
          answer.note ?? null,
          answer.answered_by,
          new Date(answer.answered_at),
        ],
      );
      if (inserted.rows[0]) return { answer: mapAnswer(inserted.rows[0]), inserted: true };

      const existingResult = await q.query<Record<string, unknown>>(
        `SELECT ${answerColumns} FROM decision_answers WHERE decision_id = $1`,
        [answer.decision_id],
      );
      const existing = existingResult.rows[0] && mapAnswer(existingResult.rows[0]);
      if (!existing) throw new DecisionAnswerConflictError(answer.decision_id);
      const same =
        existing.answer_id === answerId &&
        existing.decision_id === answer.decision_id &&
        existing.case_id === answer.case_id &&
        existing.checkpoint_revision === answer.checkpoint_revision &&
        existing.selected_option_id === answer.selected_option_id &&
        (existing.note ?? undefined) === (answer.note ?? undefined) &&
        existing.answered_by === answer.answered_by &&
        new Date(existing.answered_at).getTime() === new Date(answer.answered_at).getTime();
      if (same) return { answer: existing, inserted: false };
      throw new DecisionAnswerConflictError(answer.decision_id);
    } catch (error) {
      throw translatePgError(error) ?? error;
    }
  }

  public async findAnswer(q: Queryable, decisionId: string): Promise<DecisionAnswerRow | null> {
    const result = await q.query<Record<string, unknown>>(
      `SELECT ${answerColumns} FROM decision_answers WHERE decision_id = $1`,
      [decisionId],
    );
    return result.rows[0] ? mapAnswer(result.rows[0]) : null;
  }
}
