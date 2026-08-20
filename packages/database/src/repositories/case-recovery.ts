import {
  agentCompletion,
  agentCompletionStatusSchema,
  caseCheckpoint,
  decisionAnswer,
  decisionRequest,
  integrationScope,
  assertAnswerMatchesRequest,
  idString,
  label,
  agentRoleSchema,
  caseStatusSchema,
  providerSchema,
  runSafetyStateSchema,
} from "@remoteagent/contracts";
import * as z from "zod";
import type {
  AgentCompletion,
  CaseCheckpoint,
  DecisionAnswer,
  DecisionRequest,
  IntegrationScope,
  AgentRole,
  CaseStatus,
  Provider,
  RunSafetyState,
} from "@remoteagent/contracts";
import type { Database, Transaction } from "../client.js";
import { CaseRecoveryStateError } from "../errors.js";
import type { JobStatus } from "../queue/job-store.js";

export interface RecoveryBinding {
  readonly connectionId: string;
  readonly provider: Provider;
}

export interface RecoveryIntent {
  readonly intentId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly recordedAt: Date;
}

export interface RecoveryCompletion {
  readonly completionId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly status: AgentCompletion["status"];
  readonly completion: AgentCompletion;
  readonly recordedAt: Date;
}

export interface RecoveryRun {
  readonly runId: string;
  readonly caseId: string;
  readonly ownerId: string;
  readonly workUnitId: string;
  readonly role: AgentRole;
  readonly safetyState: RunSafetyState;
  readonly checkpointRevision: number;
  readonly intents: readonly RecoveryIntent[];
  readonly completion: RecoveryCompletion | null;
}

export type RecoveryCompletionState =
  | { readonly state: "ABSENT" }
  | { readonly state: "CONFIRMED"; readonly value: RecoveryCompletion };

export interface RecoveryDecision {
  readonly request: DecisionRequest;
  readonly answer: (DecisionAnswer & { readonly answerId: string }) | null;
}

export interface RecoveryResumeJob {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly payload: {
    readonly answerId: string;
    readonly decisionId: string;
    readonly caseId: string;
    readonly checkpointRevision: number;
  };
  readonly createdAt: Date;
}

export interface CaseRecoverySnapshot {
  readonly case: {
    readonly caseId: string;
    readonly ownerId: string;
    readonly status: CaseStatus;
    readonly integrationScope: IntegrationScope;
    readonly discordThreadId: string;
    readonly activeRunId: string | null;
    readonly checkpointRevision: number;
  };
  readonly bindings: readonly RecoveryBinding[];
  readonly checkpoint: CaseCheckpoint;
  readonly activeRun: RecoveryRun | null;
  readonly checkpointCompletion: RecoveryCompletionState;
  readonly decisions: readonly RecoveryDecision[];
  readonly resumeJobs: readonly RecoveryResumeJob[];
}

type Row = Record<string, unknown>;
const id = (value: unknown, name: string): string => {
  const result = idString.safeParse(value);
  return result.success ? result.data : invalid(`invalid persisted ${name}`);
};
const textLabel = (value: unknown, name: string): string => {
  const result = label.safeParse(value);
  return result.success ? result.data : invalid(`invalid persisted ${name}`);
};
const revision = (value: unknown, name: string): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : invalid(`invalid persisted ${name}`);
const jobStatus = z.enum([
  "PENDING",
  "LEASED",
  "SUCCEEDED",
  "FAILED",
  "DEAD_LETTER",
  "RECONCILING",
]);
const exactResumePayload = z.strictObject({
  answerId: idString,
  decisionId: idString,
  caseId: idString,
  checkpointRevision: z.int().nonnegative(),
});
const invalid = (message: string): never => {
  throw new CaseRecoveryStateError(message);
};
const row = (value: Row | undefined, name: string): Row => value ?? invalid(`${name} is missing`);
const date = (value: unknown, name: string): Date => {
  if (!(typeof value === "string" || value instanceof Date)) invalid(`invalid persisted ${name}`);
  const d = new Date(value as string | Date);
  if (!Number.isFinite(d.getTime())) invalid(`invalid persisted ${name}`);
  return d;
};
const parseCheckpoint = (value: unknown): CaseCheckpoint => {
  const result = caseCheckpoint.safeParse(value);
  return result.success ? result.data : invalid("invalid persisted checkpoint");
};
const parseCompletion = (value: unknown): AgentCompletion => {
  const result = agentCompletion.safeParse(value);
  return result.success ? result.data : invalid("invalid persisted completion");
};
const parseRequest = (row: Row): DecisionRequest => {
  const result = decisionRequest.safeParse({
    schema_version: 1,
    decision_id: row.decision_id,
    case_id: row.case_id,
    question: row.question,
    why_now: row.why_now,
    options: row.options,
    recommendation: row.recommendation,
    blocked_scope: row.blocked_scope,
    checkpoint_revision: row.checkpoint_revision,
    ...(row.expires_at == null
      ? {}
      : { expires_at: date(row.expires_at, "decision expiry").toISOString() }),
  });
  return result.success ? result.data : invalid("invalid persisted decision request");
};
const parseAnswer = (row: Row): DecisionAnswer & { answerId: string } => {
  const result = decisionAnswer.safeParse({
    schema_version: 1,
    decision_id: row.answer_decision_id,
    case_id: row.answer_case_id,
    checkpoint_revision: row.answer_revision,
    selected_option_id: row.selected_option_id,
    ...(row.note == null ? {} : { note: row.note }),
    answered_by: row.answered_by,
    answered_at: date(row.answered_at, "decision answer").toISOString(),
  });
  return result.success
    ? { ...result.data, answerId: id(row.answer_id, "answer id") }
    : invalid("invalid persisted decision answer");
};

export class CaseRecoveryRepository {
  public constructor(private readonly db: Database) {}

  public async snapshot(caseId: string): Promise<CaseRecoverySnapshot> {
    return this.db.withTransaction((tx) => this.read(tx, caseId));
  }

  public async recover(caseId: string): Promise<CaseRecoverySnapshot> {
    return this.snapshot(caseId);
  }

  private async read(tx: Transaction, caseId: string): Promise<CaseRecoverySnapshot> {
    if (!idString.safeParse(caseId).success) invalid("invalid case id");
    const cases = await tx.query<Row>(
      `SELECT case_id, owner_id, status, integration_scope, discord_thread_id, active_run_id, checkpoint_revision FROM cases WHERE case_id = $1 FOR UPDATE`,
      [caseId],
    );
    const c = row(cases.rows[0], "case");
    if (cases.rows.length !== 1) invalid("case not found");
    const persistedCaseId = id(c.case_id, "case id");
    const ownerId = id(c.owner_id, "owner id");
    if (persistedCaseId !== caseId) invalid("case identity is inconsistent");
    const statusResult = caseStatusSchema.safeParse(c.status);
    if (!statusResult.success) invalid("invalid persisted case status");
    const status = statusResult.data;
    const discordThreadId = id(c.discord_thread_id, "discord thread id");
    const checkpointRevision =
      typeof c.checkpoint_revision === "number" &&
      Number.isInteger(c.checkpoint_revision) &&
      c.checkpoint_revision >= 0
        ? c.checkpoint_revision
        : invalid("invalid case checkpoint revision");
    const activeRunId = c.active_run_id == null ? null : id(c.active_run_id, "active run id");
    const scope = integrationScope.safeParse(c.integration_scope);
    if (!scope.success) invalid("invalid persisted integration scope");
    const checkpointRows = await tx.query<Row>(
      `SELECT case_id, revision, checkpoint, last_run_id, last_event_id, created_at FROM case_checkpoints WHERE case_id = $1 AND revision = $2`,
      [caseId, checkpointRevision],
    );
    const checkpointRow = row(checkpointRows.rows[0], "checkpoint");
    if (
      checkpointRows.rows.length !== 1 ||
      checkpointRow.case_id !== caseId ||
      checkpointRow.revision !== checkpointRevision
    )
      invalid("case checkpoint is missing or inconsistent");
    const checkpoint = parseCheckpoint(checkpointRow.checkpoint);
    if (
      checkpoint.case_id !== caseId ||
      checkpoint.revision !== checkpointRevision ||
      checkpoint.last_run_id !== checkpointRow.last_run_id
    )
      invalid("case checkpoint relationships are inconsistent");

    const bindings = await tx.query<Row>(
      `SELECT cc.connection_id, cc.provider, co.owner_id FROM case_connections cc JOIN connections co ON co.connection_id = cc.connection_id WHERE cc.case_id = $1 ORDER BY cc.connection_id, cc.provider`,
      [caseId],
    );
    if (
      bindings.rows.some(
        (r) =>
          r.owner_id !== ownerId ||
          !idString.safeParse(r.connection_id).success ||
          !providerSchema.safeParse(r.provider).success ||
          !scope.data!.connection_ids.some((connectionId) => connectionId === r.connection_id) ||
          !scope.data!.providers.some((provider) => provider === r.provider),
      )
    )
      invalid("case connection binding is inconsistent");
    if (bindings.rows.length !== scope.data!.connection_ids.length)
      invalid("case connection binding is incomplete");

    const completionFor = async (runId: string | null): Promise<RecoveryCompletion | null> => {
      if (!runId) return null;
      const result = await tx.query<Row>(
        `SELECT completion_id, run_id, case_id, status, completion, recorded_at FROM run_completions WHERE run_id = $1`,
        [runId],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) invalid("confirmed completion is duplicated");
      const r = row(result.rows[0], "completion");
      const completion = parseCompletion(r.completion);
      if (
        r.case_id !== caseId ||
        completion.case_id !== caseId ||
        completion.run_id !== runId ||
        completion.status !== r.status
      )
        invalid("completion relationships are inconsistent");
      return {
        completionId: id(r.completion_id, "completion id"),
        runId,
        caseId,
        status: agentCompletionStatusSchema.safeParse(r.status).success
          ? agentCompletionStatusSchema.parse(r.status)
          : invalid("invalid persisted completion status"),
        completion,
        recordedAt: date(r.recorded_at, "completion timestamp"),
      };
    };
    const checkpointCompletion = checkpoint.last_run_id
      ? await completionFor(checkpoint.last_run_id)
      : null;
    if (checkpoint.last_run_id && !checkpointCompletion) invalid("checkpoint completion is absent");

    let activeRun: RecoveryRun | null = null;
    if (activeRunId) {
      const runResult = await tx.query<Row>(
        `SELECT run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision FROM agent_runs WHERE run_id = $1`,
        [activeRunId],
      );
      const r = row(runResult.rows[0], "active run");
      if (runResult.rows.length !== 1 || r.case_id !== caseId || r.owner_id !== ownerId)
        invalid("active run is missing or foreign");
      const intents = await tx.query<Row>(
        `SELECT intent_id, run_id, case_id, kind, payload, recorded_at FROM run_intents WHERE run_id = $1 AND case_id = $2 ORDER BY intent_id`,
        [r.run_id, caseId],
      );
      if (intents.rows.some((i) => i.run_id !== r.run_id || i.case_id !== caseId))
        invalid("run intent relationship is inconsistent");
      const completion = await completionFor(id(r.run_id, "run id"));
      activeRun = {
        runId: id(r.run_id, "run id"),
        caseId,
        ownerId,
        workUnitId: id(r.work_unit_id, "work unit id"),
        role: agentRoleSchema.safeParse(r.role).success
          ? agentRoleSchema.parse(r.role)
          : invalid("invalid persisted run role"),
        safetyState: runSafetyStateSchema.safeParse(r.safety_state).success
          ? runSafetyStateSchema.parse(r.safety_state)
          : invalid("invalid persisted run safety state"),
        checkpointRevision: revision(r.checkpoint_revision, "run checkpoint revision"),
        intents: intents.rows.map((i) => ({
          intentId: id(i.intent_id, "intent id"),
          runId: id(i.run_id, "intent run id"),
          caseId,
          kind: textLabel(i.kind, "intent kind"),
          payload: i.payload,
          recordedAt: date(i.recorded_at, "intent timestamp"),
        })),
        completion,
      };
    }

    const decisions = await tx.query<Row>(
      `SELECT d.decision_id, d.case_id, d.question, d.why_now, d.options, d.recommendation, d.blocked_scope, d.checkpoint_revision, d.expires_at, a.answer_id, a.selected_option_id, a.note, a.answered_by, a.answered_at, a.decision_id AS answer_decision_id, a.case_id AS answer_case_id, a.checkpoint_revision AS answer_revision FROM decisions d LEFT JOIN decision_answers a ON a.decision_id = d.decision_id WHERE d.case_id = $1 AND d.checkpoint_revision <= $2 ORDER BY d.checkpoint_revision, d.decision_id`,
      [caseId, checkpointRevision],
    );
    const decisionValues = decisions.rows.map((r) => {
      const request = parseRequest(r);
      if (request.case_id !== caseId || request.checkpoint_revision > checkpointRevision)
        invalid("decision relationship is inconsistent");
      const answer = r.answer_id == null ? null : parseAnswer(r);
      if (answer) {
        try {
          assertAnswerMatchesRequest(request, answer);
        } catch {
          invalid("decision answer relationship is inconsistent");
        }
      }
      return { request, answer };
    });

    const jobs = await tx.query<Row>(
      `SELECT job_id, status, payload, case_id, created_at FROM jobs WHERE case_id = $1 AND job_type = 'case.resume' ORDER BY job_id`,
      [caseId],
    );
    const resumeJobs = jobs.rows.map((r) => {
      if (r.case_id !== caseId) invalid("resume job relationship is inconsistent");
      const parsedPayload = exactResumePayload.safeParse(r.payload);
      if (!parsedPayload.success || parsedPayload.data.caseId !== caseId)
        invalid("invalid persisted resume job payload");
      const p = parsedPayload.data!;
      const d = decisionValues.find((x) => x.request.decision_id === p.decisionId);
      if (
        !d ||
        !d.answer ||
        d.answer.decision_id !== p.decisionId ||
        d.answer.answerId !== p.answerId ||
        d.answer.checkpoint_revision !== p.checkpointRevision
      )
        invalid("resume job does not match decision answer");
      const statusResult = jobStatus.safeParse(r.status);
      if (!statusResult.success) invalid("invalid persisted resume job status");
      return {
        jobId: id(r.job_id, "job id"),
        status: statusResult.data!,
        payload: p,
        createdAt: date(r.created_at, "job timestamp"),
      };
    });
    return {
      case: {
        caseId,
        ownerId,
        status: status!,
        integrationScope: scope.data!,
        discordThreadId,
        activeRunId,
        checkpointRevision,
      },
      bindings: bindings.rows.map((r) => ({
        connectionId: id(r.connection_id, "binding connection id"),
        provider: providerSchema.parse(r.provider),
      })),
      checkpoint,
      activeRun,
      checkpointCompletion: checkpointCompletion
        ? { state: "CONFIRMED", value: checkpointCompletion }
        : { state: "ABSENT" },
      decisions: decisionValues,
      resumeJobs,
    };
  }
}
