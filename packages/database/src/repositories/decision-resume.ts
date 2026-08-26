import { AgentRole, decisionAnswer, idString } from "@remoteagent/contracts";
import type { DecisionAnswer, WorkUnit } from "@remoteagent/contracts";
import * as z from "zod";

import type { Database, Transaction } from "../client.js";
import {
  ContractViolationError,
  DecisionResumeConflictError,
  DecisionResumeStateError,
  UniqueViolationError,
} from "../errors.js";
import { JobStore, type JobRow } from "../queue/job-store.js";
import { JobType } from "../queue/dispatch.js";
import type { IdGenerator } from "../queue/runtime.js";
import { DecisionRepository, type DecisionAnswerRow } from "./decision.js";
import { WorkUnitRepository } from "./work-unit.js";

const inputSchema = z.strictObject({ answerId: idString, answer: decisionAnswer });

export interface DecisionResumeResult {
  readonly replayed: boolean;
  readonly answerId: string;
  readonly jobId: string;
}

type DecisionRow = {
  decision_id: string;
  case_id: string;
  checkpoint_revision: number;
};

function sameAnswer(
  existing: DecisionAnswerRow,
  answerId: string,
  answer: DecisionAnswer,
): boolean {
  return (
    existing.answer_id === answerId &&
    existing.decision_id === answer.decision_id &&
    existing.case_id === answer.case_id &&
    existing.checkpoint_revision === answer.checkpoint_revision &&
    existing.selected_option_id === answer.selected_option_id &&
    (existing.note ?? undefined) === (answer.note ?? undefined) &&
    existing.answered_by === answer.answered_by &&
    new Date(existing.answered_at).getTime() === new Date(answer.answered_at).getTime()
  );
}

interface ResumeParent {
  readonly runId: string;
  readonly workUnitId: string;
  readonly role: "SUPERVISOR" | "PLANNER" | "IMPLEMENTER" | "REVIEWER" | "VERIFICATION";
  readonly objective: string;
  readonly authoritativeScope: WorkUnit["authoritative_scope"];
}

function samePayload(
  job: JobRow,
  answerId: string,
  answer: DecisionAnswer,
  parent: ResumeParent | null,
): boolean {
  const payload = job.payload;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.getPrototypeOf(payload) !== Object.prototype
  )
    return false;
  const baseMatches =
    job.job_type ===
      (parent?.role === AgentRole.IMPLEMENTER ? "agent.implementer" : "case.resume") &&
    job.provider === null &&
    job.case_id === answer.case_id &&
    job.serialization_key === answer.case_id &&
    payload.answerId === answerId &&
    payload.decisionId === answer.decision_id &&
    payload.caseId === answer.case_id &&
    payload.checkpointRevision === answer.checkpoint_revision;
  if (!baseMatches) return false;
  if (parent === null) return Object.keys(payload).length === 4;
  return (
    payload.reason === "decision_answer" &&
    payload.parentRunId === parent.runId &&
    typeof payload.workUnitId === "string" &&
    typeof payload.runId === "string" &&
    Object.keys(payload).length === 8
  );
}

export class DecisionResumeRepository {
  private readonly decisions = new DecisionRepository();
  private readonly units = new WorkUnitRepository();

  public constructor(
    private readonly db: Database,
    private readonly jobs: JobStore,
    private readonly ids: IdGenerator,
  ) {}

  /** Answer a waiting decision and enqueue its one-shot resume atomically. */
  public async answer(input: unknown): Promise<DecisionResumeResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw new ContractViolationError("invalid decision answer input");
    return this.db.withTransaction((tx) =>
      this.applyInTransaction(tx, parsed.data.answerId, parsed.data.answer),
    );
  }

  public async apply(input: unknown): Promise<DecisionResumeResult> {
    return this.answer(input);
  }

  private async applyInTransaction(
    tx: Transaction,
    answerId: string,
    answer: DecisionAnswer,
  ): Promise<DecisionResumeResult> {
    // Every decision writer takes this lock before decision and case row locks.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [answer.decision_id]);
    const decisionResult = await tx.query<DecisionRow>(
      `SELECT decision_id, case_id, checkpoint_revision
       FROM decisions WHERE decision_id = $1 FOR UPDATE`,
      [answer.decision_id],
    );
    const decision = decisionResult.rows[0];
    if (!decision) throw new DecisionResumeStateError("decision request does not exist");
    const request = await this.decisions.findRequest(tx, answer.decision_id);
    if (!request) throw new DecisionResumeStateError("decision request does not exist");
    const caseResult = await tx.query<{
      case_id: string;
      status: string;
      checkpoint_revision: number;
      active_run_id: string | null;
    }>(
      `SELECT case_id, status, checkpoint_revision, active_run_id
       FROM cases WHERE case_id = $1 FOR UPDATE`,
      [decision.case_id],
    );
    const caseRow = caseResult.rows[0];
    if (!caseRow) throw new DecisionResumeStateError("decision case does not exist");

    const parentEvents = await tx.query<{ source_run_id: string }>(
      `SELECT payload->>'sourceRunId' AS source_run_id
         FROM outbox
        WHERE event_type = 'decision.requested'
          AND aggregate = 'case'
          AND aggregate_id = $1
          AND payload->>'decisionId' = $2
          AND payload->>'checkpointRevision' = $3::text
        FOR UPDATE`,
      [decision.case_id, decision.decision_id, decision.checkpoint_revision],
    );
    if (parentEvents.rows.length > 1) {
      throw new DecisionResumeConflictError(answer.decision_id);
    }
    const parentRunId = parentEvents.rows[0]?.source_run_id;
    let parent: ResumeParent | null = null;
    if (parentRunId !== undefined) {
      const parentResult = await tx.query<{
        run_id: string;
        work_unit_id: string;
        role: ResumeParent["role"];
        objective: string;
        authoritative_scope: WorkUnit["authoritative_scope"];
      }>(
        `SELECT r.run_id, r.work_unit_id, r.role, w.objective, w.authoritative_scope
           FROM agent_runs r
           JOIN work_units w
             ON w.work_unit_id = r.work_unit_id
            AND w.case_id = r.case_id
            AND w.run_id = r.run_id
          WHERE r.run_id = $1 AND r.case_id = $2 AND r.safety_state = 'SUCCEEDED'`,
        [parentRunId, decision.case_id],
      );
      const row = parentResult.rows[0];
      // Only an engineering writer needs the new exact claimed-run continuation. Other roles
      // remain on the audited four-field case.resume contract consumed by CaseRecoveryRepository;
      // widening that payload would make otherwise valid legacy recovery fail closed.
      if (row?.role === AgentRole.IMPLEMENTER) {
        parent = {
          runId: row.run_id,
          workUnitId: row.work_unit_id,
          role: row.role,
          objective: row.objective,
          authoritativeScope: row.authoritative_scope,
        };
      }
    }

    const answerCollisions = await tx.query<{ decision_id: string; answer_id: string }>(
      `SELECT decision_id, answer_id FROM decision_answers
       WHERE decision_id = $1 OR answer_id = $2
       FOR UPDATE`,
      [answer.decision_id, answerId],
    );
    if (answerCollisions.rows.some((row) => row.decision_id !== answer.decision_id))
      throw new DecisionResumeConflictError(answer.decision_id);
    const existing = await this.decisions.findAnswer(tx, answer.decision_id);
    const relatedJobs = await tx.query<JobRow>(
      `SELECT job_id, case_id, job_type, status, payload, provider, serialization_key,
              lease_owner, lease_expires_at, fencing_token, attempts, max_attempts,
              backoff_base_ms, backoff_cap_ms, available_at, leased_at,
              last_heartbeat_at, last_error, dead_lettered_at, dlq_reason,
              finished_at, created_at, updated_at
       FROM jobs
       WHERE job_type IN ('case.resume', 'agent.implementer')
         AND (payload->>'decisionId' = $1 OR payload->>'answerId' = $2)
       FOR UPDATE`,
      [answer.decision_id, answerId],
    );
    const compatible = relatedJobs.rows.filter((job) => samePayload(job, answerId, answer, parent));
    if (existing) {
      if (
        !sameAnswer(existing, answerId, answer) ||
        relatedJobs.rows.length !== 1 ||
        compatible.length !== 1
      )
        throw new DecisionResumeConflictError(answer.decision_id);
      return { replayed: true, answerId, jobId: compatible[0]!.job_id };
    }
    if (relatedJobs.rows.length > 0) throw new DecisionResumeConflictError(answer.decision_id);

    if (answer.case_id !== decision.case_id)
      throw new DecisionResumeStateError("answer case does not match decision");
    if (answer.checkpoint_revision !== decision.checkpoint_revision)
      throw new DecisionResumeStateError("answer revision is stale");
    if (caseRow.status !== "WAITING_FOR_USER")
      throw new DecisionResumeStateError("case is not waiting for user");
    if (caseRow.checkpoint_revision !== decision.checkpoint_revision)
      throw new DecisionResumeStateError("case revision is stale");
    if (caseRow.active_run_id !== null)
      throw new DecisionResumeStateError("case has an active run");
    if (
      request.expires_at !== undefined &&
      new Date(answer.answered_at).getTime() >= new Date(request.expires_at).getTime()
    )
      throw new DecisionResumeStateError("decision answer is expired");
    if (!request.options.some((option) => option.id === answer.selected_option_id))
      throw new DecisionResumeStateError("answer option does not match decision");

    let inserted;
    try {
      inserted = await this.decisions.answer(tx, { answerId, answer });
    } catch (error) {
      // A concurrent writer for another decision can win the answer_id PK
      // without sharing this decision's advisory lock. Keep that race public
      // and domain-typed rather than leaking a generic unique violation.
      if (error instanceof UniqueViolationError)
        throw new DecisionResumeConflictError(answer.decision_id);
      throw error;
    }
    if (!inserted.inserted) throw new DecisionResumeConflictError(answer.decision_id);
    const transition = await tx.query(
      `UPDATE cases SET status = 'PLANNING'
       WHERE case_id = $1 AND status = 'WAITING_FOR_USER'
         AND checkpoint_revision = $2 AND active_run_id IS NULL
       RETURNING case_id`,
      [answer.case_id, answer.checkpoint_revision],
    );
    if (transition.rows.length !== 1)
      throw new DecisionResumeStateError("case transition guard failed");
    let resumeIdentity:
      | { readonly workUnitId: string; readonly runId: string; readonly parentRunId: string }
      | undefined;
    if (parent !== null) {
      const workUnitId = this.ids.next("work-unit");
      const runId = this.ids.next("run");
      await this.units.insert(tx, {
        workUnitId,
        caseId: answer.case_id,
        role: parent.role,
        objective: parent.objective,
        authoritativeScope: parent.authoritativeScope,
      });
      await this.units.claimInTransaction(tx, {
        workUnitId,
        runId,
        checkpointRevision: answer.checkpoint_revision,
      });
      resumeIdentity = { workUnitId, runId, parentRunId: parent.runId };
    }
    const job = await this.jobs.enqueue(tx, {
      jobType:
        parent?.role === AgentRole.IMPLEMENTER ? JobType.AGENT_IMPLEMENTER : JobType.CASE_RESUME,
      caseId: answer.case_id,
      serializationKey: answer.case_id,
      payload: {
        answerId,
        decisionId: answer.decision_id,
        caseId: answer.case_id,
        checkpointRevision: answer.checkpoint_revision,
        ...(resumeIdentity === undefined
          ? {}
          : {
              reason: "decision_answer",
              parentRunId: resumeIdentity.parentRunId,
              workUnitId: resumeIdentity.workUnitId,
              runId: resumeIdentity.runId,
            }),
      },
    });
    return { replayed: false, answerId, jobId: job.job_id };
  }
}
