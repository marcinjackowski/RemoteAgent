import * as z from "zod";

import {
  canonicalDigest,
  engineeringArtifact,
  engineeringArtifactDigest,
  isEngineeringArtifactKindAllowedForStage,
  engineeringStage,
  idString,
  isoTimestamp,
  sha256Digest,
} from "@remoteagent/contracts";
import type { EngineeringArtifact, EngineeringStage } from "@remoteagent/contracts";

import type { Queryable, Transaction } from "../client.js";
import { translatePgError } from "../client.js";
import {
  ContractViolationError,
  EngineeringControlConflictError,
  EngineeringControlStateError,
  NotFoundError,
} from "../errors.js";
import { JobStore } from "../queue/job-store.js";
import type { JobLease, QueueRuntime, TxDb } from "../queue/index.js";

const effectClass = z.enum(["READ_ONLY", "MODEL_CALL", "COMMAND", "MUTATING_SIDE_EFFECT"]);

const bindOperationInput = z
  .object({
    operationId: idString,
    runId: idString,
    stage: engineeringStage,
    stageAttempt: z.int().positive(),
    operationKind: z.string().trim().min(1).max(256),
    effectClass,
    descriptor: z.record(z.string(), z.unknown()),
    configDigest: sha256Digest,
    schemaDigest: sha256Digest,
    deadlineAt: isoTimestamp,
  })
  .strict();

const operationIdentity = z.object({ operationId: idString }).strict();
const appendArtifactInput = z
  .object({
    operationId: idString,
    artifactKey: z.string().trim().min(1).max(512),
    artifact: z.unknown(),
  })
  .strict();
const observeCompletionInput = z.object({ operationId: idString, completionId: idString }).strict();
const resumeInput = z.object({ runId: idString }).strict();
const operatorStatusInput = z.object({ runId: idString, ownerId: idString }).strict();
const runControlIdentity = z
  .object({
    runId: idString,
    caseId: idString,
    ownerId: idString,
    checkpointRevision: z.int().nonnegative(),
  })
  .strict();
const runTraceIdentity = z
  .object({
    caseId: idString,
    ownerId: idString,
    runId: idString,
    checkpointRevision: z.int().nonnegative(),
  })
  .strict();
const operatorActionBase = z.object({
  actionId: idString,
  operationId: idString,
  actorId: idString,
  reason: z.string().trim().min(1).max(4096),
  expectedProjectionDigest: sha256Digest,
});
const operatorActionInput = operatorActionBase.strict();
const operatorReconcileInput = operatorActionBase
  .extend({
    resolution: z.enum(["CONFIRMED", "ABSENT", "UNRESOLVED"]),
    evidence: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export type EngineeringControlEffectClass = z.infer<typeof effectClass>;

export interface EngineeringControlOperationRow {
  operation_id: string;
  intent_id: string;
  idempotency_key: string;
  job_id: string;
  case_id: string;
  owner_id: string;
  run_id: string;
  stage: EngineeringStage;
  stage_attempt: number;
  checkpoint_revision: number;
  operation_kind: string;
  effect_class: EngineeringControlEffectClass;
  integration_scope_digest: string;
  input_digest: string;
  config_digest: string;
  schema_digest: string;
  deadline_at: Date;
  recorded_at: Date;
}

interface EngineeringControlOperationAuthorityRow extends EngineeringControlOperationRow {
  descriptor: Record<string, unknown>;
}

export interface EngineeringControlArtifactRevisionRow {
  artifact_revision_id: string;
  artifact_key: string;
  revision: number;
  artifact_kind: string;
  payload: EngineeringArtifact;
  payload_digest: string;
  operation_id: string;
  intent_id: string;
  job_id: string;
  case_id: string;
  owner_id: string;
  run_id: string;
  stage: EngineeringStage;
  stage_attempt: number;
  checkpoint_revision: number;
  recorded_at: Date;
}

export interface EngineeringControlStageEventRow {
  event_id: string;
  event_sequence: string;
  event_type:
    | "INTENT_BOUND"
    | "STARTED"
    | "COMPLETION_OBSERVED"
    | "ARTIFACT_RECORDED"
    | "OPERATOR_ACKNOWLEDGED"
    | "OPERATOR_CANCEL_REQUESTED"
    | "OPERATOR_RECONCILE_REQUESTED"
    | "OPERATOR_RECONCILED"
    | "OPERATOR_RETRY_REQUESTED";
  operation_id: string;
  intent_id: string;
  job_id: string;
  case_id: string;
  owner_id: string;
  run_id: string;
  stage: EngineeringStage;
  stage_attempt: number;
  checkpoint_revision: number;
  artifact_revision_id: string | null;
  completion_id: string | null;
  reconciliation_id: string | null;
  payload: Record<string, unknown>;
  payload_digest: string;
  recorded_at: Date;
}

export interface EngineeringControlRunTraceRow {
  readonly event_id: string;
  readonly event_sequence: string;
  readonly event_type: EngineeringControlStageEventRow["event_type"];
  readonly case_id: string;
  readonly owner_id: string;
  readonly run_id: string;
  readonly checkpoint_revision: number;
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly effect_class: EngineeringControlEffectClass;
  readonly integration_scope_digest: string;
  readonly input_digest: string;
  readonly config_digest: string;
  readonly schema_digest: string;
  readonly stage: EngineeringStage;
  readonly stage_attempt: number;
  readonly artifact_revision_id: string | null;
  readonly artifact_kind: string | null;
  readonly completion_id: string | null;
  readonly completion_outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | null;
  readonly reconciliation_id: string | null;
  readonly reconciliation_resolution: "CONFIRMED" | "ABSENT" | "UNRESOLVED" | null;
  readonly payload_digest: string;
  readonly recorded_at: Date;
}

export type EngineeringControlRecoveryClassification =
  "RECOVERED" | "DIRTY" | "AMBIGUOUS" | "BLOCKED" | "CANCELLED";

export interface EngineeringControlResumePlan {
  run_id: string;
  case_id: string;
  owner_id: string;
  checkpoint_revision: number;
  operation_id: string;
  stage: EngineeringStage;
  stage_attempt: number;
  classification: EngineeringControlRecoveryClassification;
  cancellation_requested: boolean;
  terminal_reason: "AMBIGUOUS" | "BLOCKED" | "CANCELLED" | "EXHAUSTED" | null;
  reason: string;
  last_event_id: string;
  last_event_sequence: string;
  current_artifact_revision_id: string | null;
  projection_digest: string;
}

export interface EngineeringControlRunStatusRow {
  run_id: string;
  case_id: string;
  owner_id: string;
  checkpoint_revision: number;
  current_stage: EngineeringStage;
  stage_attempt: number;
  recovery_status: EngineeringControlRecoveryClassification | "READY";
  cancellation_requested: boolean;
  current_operation_id: string | null;
  current_artifact_revision_id: string | null;
  last_event_id: string;
  last_event_sequence: string;
  projection: Record<string, unknown>;
  projection_digest: string;
  updated_at: Date;
}

export interface EngineeringControlRunControlState {
  readonly cancelled: boolean;
}

export interface EngineeringControlOperatorResult {
  event: EngineeringControlStageEventRow;
  plan: EngineeringControlResumePlan;
}

export interface EngineeringControlOperationRecovery {
  readonly operation: EngineeringControlOperationRow;
  readonly started: boolean;
  readonly completion_outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | null;
  readonly artifact: EngineeringControlArtifactRevisionRow | null;
}

export interface EngineeringControlOperationCompletion {
  readonly operation: EngineeringControlOperationRow;
  readonly descriptor: Record<string, unknown>;
  readonly started: boolean;
  readonly completion: Readonly<{
    completion_id: string;
    outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS";
    receipt: unknown;
  }> | null;
  readonly completion_observed: boolean;
}

function validateArtifactRowBinding(
  row: EngineeringControlArtifactRevisionRow,
  expected?: EngineeringControlOperationRow,
): EngineeringControlArtifactRevisionRow {
  const artifact = parseInput(engineeringArtifact, row.payload, "engineering artifact ledger row");
  if (
    artifact.case_id !== row.case_id ||
    artifact.run_id !== row.run_id ||
    artifact.revision !== row.checkpoint_revision ||
    row.revision !== row.checkpoint_revision ||
    artifact.artifact_kind !== row.artifact_kind ||
    !isEngineeringArtifactKindAllowedForStage(row.stage, artifact.artifact_kind) ||
    engineeringArtifactDigest(artifact) !== row.payload_digest ||
    (expected !== undefined &&
      (row.operation_id !== expected.operation_id ||
        row.case_id !== expected.case_id ||
        row.owner_id !== expected.owner_id ||
        row.run_id !== expected.run_id ||
        row.stage !== expected.stage ||
        row.stage_attempt !== expected.stage_attempt ||
        row.checkpoint_revision !== expected.checkpoint_revision))
  ) {
    throw new EngineeringControlStateError("engineering artifact ledger binding is corrupted");
  }
  return { ...row, payload: artifact };
}

interface EngineeringControlRecoverySourceRow extends EngineeringControlOperationRow {
  intent_fencing_token: string;
  current_fencing_token: string;
  job_status: string;
  integration_scope: Record<string, unknown>;
  case_status: string;
  completion_id: string | null;
  completion_outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | null;
  terminal_resolution: "CONFIRMED" | "ABSENT" | null;
  has_unresolved_reconciliation: boolean;
  started: boolean;
  cancellation_requested: boolean;
  last_event_id: string;
  last_event_sequence: string;
  current_artifact_revision_id: string | null;
}

const OPERATION_COLUMNS = `
  operation_id, intent_id, idempotency_key, job_id, case_id, owner_id, run_id,
  stage, stage_attempt, checkpoint_revision, operation_kind, effect_class,
  integration_scope_digest, input_digest, config_digest, schema_digest,
  deadline_at, recorded_at`;
const OPERATION_COLUMNS_O = `
  o.operation_id, o.intent_id, o.idempotency_key, o.job_id, o.case_id,
  o.owner_id, o.run_id, o.stage, o.stage_attempt, o.checkpoint_revision,
  o.operation_kind, o.effect_class, o.integration_scope_digest, o.input_digest,
  o.config_digest, o.schema_digest, o.deadline_at, o.recorded_at`;

function projectEngineeringControlOperationRow(
  row: EngineeringControlOperationRow,
): EngineeringControlOperationRow {
  return {
    operation_id: row.operation_id,
    intent_id: row.intent_id,
    idempotency_key: row.idempotency_key,
    job_id: row.job_id,
    case_id: row.case_id,
    owner_id: row.owner_id,
    run_id: row.run_id,
    stage: row.stage,
    stage_attempt: row.stage_attempt,
    checkpoint_revision: row.checkpoint_revision,
    operation_kind: row.operation_kind,
    effect_class: row.effect_class,
    integration_scope_digest: row.integration_scope_digest,
    input_digest: row.input_digest,
    config_digest: row.config_digest,
    schema_digest: row.schema_digest,
    deadline_at: row.deadline_at,
    recorded_at: row.recorded_at,
  };
}

const EVENT_COLUMNS = `
  event_id, event_sequence, event_type, operation_id, intent_id, job_id, case_id,
  owner_id, run_id, stage, stage_attempt, checkpoint_revision,
  artifact_revision_id, completion_id, reconciliation_id, payload,
  payload_digest, recorded_at`;

function parseInput<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ContractViolationError(`invalid ${label}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function sameInstant(left: Date, right: string): boolean {
  return left.getTime() === new Date(right).getTime();
}

/**
 * Strict persistence boundary for the durable engineering stage protocol.
 *
 * It deliberately exposes no generic event append: callers cannot manufacture
 * STARTED, completion receipts or artifact provenance.  Each public method
 * derives case/owner/checkpoint/fence data from existing server-owned rows.
 */
export class EngineeringControlPlaneRepository {
  readonly #runtime: QueueRuntime;
  readonly #jobs: JobStore;

  public constructor(runtime: QueueRuntime, jobs = new JobStore(runtime)) {
    this.#runtime = runtime;
    this.#jobs = jobs;
  }

  /** Atomically record the existing queue intent and its engineering binding. */
  public async bindOperationIntent(
    db: TxDb,
    lease: JobLease,
    rawInput: unknown,
  ): Promise<EngineeringControlOperationRow> {
    const input = parseInput(bindOperationInput, rawInput, "engineering operation");
    if (lease.caseId === null) {
      throw new EngineeringControlStateError("engineering operations require a case-bound job");
    }
    const deadlineMs = new Date(input.deadlineAt).getTime();
    if (deadlineMs <= this.#runtime.clock.now()) {
      throw new EngineeringControlStateError(
        "engineering operation deadline must be in the future",
      );
    }

    return db
      .withTransaction(async (tx) => {
        // Keep the global lock order used by STARTED/artifact/operator paths:
        // live job fence first, then the run serialization authority. Any
        // invalid run binding rolls this intent back in the same transaction.
        const intentId = await this.#jobs.recordIntentInTransaction(tx, lease, {
          kind: input.operationKind,
          descriptor: input.descriptor,
          idempotencyKey: input.operationId,
        });
        const authority = await tx.query<{
          owner_id: string;
          integration_scope: Record<string, unknown>;
          checkpoint_revision: number;
        }>(
          `SELECT c.owner_id, c.integration_scope, r.checkpoint_revision
         FROM cases c
         JOIN agent_runs r ON r.case_id = c.case_id AND r.owner_id = c.owner_id
         WHERE c.case_id = $1 AND r.run_id = $2
         FOR SHARE OF c, r`,
          [lease.caseId, input.runId],
        );
        const scope = authority.rows[0];
        if (scope === undefined) {
          throw new EngineeringControlStateError(
            `run ${input.runId} is not in the leased case ${lease.caseId}`,
          );
        }

        const integrationScopeDigest = canonicalDigest(scope.integration_scope);
        const inputDigest = canonicalDigest(input.descriptor);
        const nowMs = this.#runtime.clock.now();

        const inserted = await tx.query<EngineeringControlOperationRow>(
          `INSERT INTO engineering_operations (
           operation_id, intent_id, idempotency_key, job_id, case_id, owner_id,
           run_id, stage, stage_attempt, checkpoint_revision, operation_kind,
           effect_class, integration_scope_digest, input_digest, config_digest,
           schema_digest, deadline_at, recorded_at)
         VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 to_timestamp($17 / 1000.0))
         ON CONFLICT DO NOTHING
         RETURNING ${OPERATION_COLUMNS}`,
          [
            input.operationId,
            intentId,
            lease.jobId,
            lease.caseId,
            scope.owner_id,
            input.runId,
            input.stage,
            input.stageAttempt,
            scope.checkpoint_revision,
            input.operationKind,
            input.effectClass,
            integrationScopeDigest,
            inputDigest,
            input.configDigest,
            input.schemaDigest,
            input.deadlineAt,
            nowMs,
          ],
        );

        let operation = inserted.rows[0];
        if (operation === undefined) {
          const existing = await tx.query<EngineeringControlOperationRow>(
            `SELECT ${OPERATION_COLUMNS}
           FROM engineering_operations
           WHERE operation_id = $1 OR intent_id = $2`,
            [input.operationId, intentId],
          );
          operation = existing.rows[0];
          if (
            operation === undefined ||
            operation.operation_id !== input.operationId ||
            operation.intent_id !== intentId ||
            operation.job_id !== lease.jobId ||
            operation.case_id !== lease.caseId ||
            operation.owner_id !== scope.owner_id ||
            operation.run_id !== input.runId ||
            operation.stage !== input.stage ||
            operation.stage_attempt !== input.stageAttempt ||
            operation.checkpoint_revision !== scope.checkpoint_revision ||
            operation.operation_kind !== input.operationKind ||
            operation.effect_class !== input.effectClass ||
            operation.integration_scope_digest !== integrationScopeDigest ||
            operation.input_digest !== inputDigest ||
            operation.config_digest !== input.configDigest ||
            operation.schema_digest !== input.schemaDigest ||
            !sameInstant(operation.deadline_at, input.deadlineAt)
          ) {
            throw new EngineeringControlConflictError(input.operationId);
          }
        }

        await this.#appendEvent(tx, operation, "INTENT_BOUND", {
          payload: { operation_id: operation.operation_id },
        });
        return operation;
      })
      .catch((error: unknown) => {
        throw translatePgError(error) ?? error;
      });
  }

  /** Commit the singleton STARTED marker; the caller dispatches only after this resolves. */
  public async commitOperationStarted(
    db: TxDb,
    lease: JobLease,
    rawInput: unknown,
  ): Promise<EngineeringControlStageEventRow> {
    const input = parseInput(operationIdentity, rawInput, "engineering operation identity");
    return db.withTransaction(async (tx) => {
      const operation = await this.#assertOperationLease(tx, lease, input.operationId);
      await this.#assertPreStartControls(tx, operation);
      return this.#appendEvent(
        tx,
        operation,
        "STARTED",
        {
          payload: { operation_id: operation.operation_id },
        },
        false,
      );
    });
  }

  /** Strict-parse an RA-037 artifact and atomically append it with its provenance event. */
  public async appendArtifactRevision(
    db: TxDb,
    lease: JobLease,
    rawInput: unknown,
  ): Promise<EngineeringControlArtifactRevisionRow> {
    const input = parseInput(appendArtifactInput, rawInput, "engineering artifact append");
    const artifact = parseInput(engineeringArtifact, input.artifact, "engineering artifact");
    return db
      .withTransaction(async (tx) => {
        const operation = await this.#assertOperationLease(tx, lease, input.operationId);
        if (
          artifact.case_id !== operation.case_id ||
          artifact.run_id !== operation.run_id ||
          artifact.revision !== operation.checkpoint_revision ||
          !isEngineeringArtifactKindAllowedForStage(operation.stage, artifact.artifact_kind)
        ) {
          throw new EngineeringControlStateError(
            "artifact crosses its operation case, run, checkpoint, or stage kind",
          );
        }

        const digest = engineeringArtifactDigest(artifact);
        const artifactRevisionId = this.#runtime.ids.next("eng-artifact");
        const inserted = await tx.query<EngineeringControlArtifactRevisionRow>(
          `INSERT INTO engineering_artifact_revisions (
           artifact_revision_id, artifact_key, revision, artifact_kind, payload,
           payload_digest, operation_id, intent_id, job_id, case_id, owner_id,
           run_id, stage, stage_attempt, checkpoint_revision, recorded_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 to_timestamp($16 / 1000.0))
         ON CONFLICT DO NOTHING
         RETURNING *`,
          [
            artifactRevisionId,
            input.artifactKey,
            artifact.revision,
            artifact.artifact_kind,
            JSON.stringify(artifact),
            digest,
            operation.operation_id,
            operation.intent_id,
            operation.job_id,
            operation.case_id,
            operation.owner_id,
            operation.run_id,
            operation.stage,
            operation.stage_attempt,
            operation.checkpoint_revision,
            this.#runtime.clock.now(),
          ],
        );

        let row = inserted.rows[0];
        if (row === undefined) {
          const existing = await tx.query<EngineeringControlArtifactRevisionRow>(
            `SELECT a.*
           FROM engineering_artifact_revisions a
           WHERE run_id = $1 AND artifact_key = $2 AND revision = $3
             AND a.payload IS NOT DISTINCT FROM $4::jsonb`,
            [operation.run_id, input.artifactKey, artifact.revision, JSON.stringify(artifact)],
          );
          const prior = existing.rows[0];
          if (
            prior === undefined ||
            prior.operation_id !== operation.operation_id ||
            prior.artifact_kind !== artifact.artifact_kind ||
            prior.payload_digest !== digest
          ) {
            throw new EngineeringControlConflictError(
              `${operation.run_id}/${input.artifactKey}/${artifact.revision}`,
            );
          }
          row = prior;
        }

        await this.#appendEvent(tx, operation, "ARTIFACT_RECORDED", {
          artifactRevisionId: row.artifact_revision_id,
          payload: {
            artifact_revision_id: row.artifact_revision_id,
            payload_digest: row.payload_digest,
          },
        });
        return validateArtifactRowBinding(row, operation);
      })
      .catch((error: unknown) => {
        throw translatePgError(error) ?? error;
      });
  }

  /** Observe an already-durable queue completion; receipt content is never accepted here. */
  public async observeOperationCompletion(
    db: TxDb,
    lease: JobLease,
    rawInput: unknown,
  ): Promise<EngineeringControlStageEventRow> {
    const input = parseInput(
      observeCompletionInput,
      rawInput,
      "engineering completion observation",
    );
    return db.withTransaction(async (tx) => {
      const operation = await this.#assertOperationLease(tx, lease, input.operationId);
      const completion = await tx.query<{ completion_id: string; outcome: string }>(
        `SELECT completion_id, outcome
         FROM job_completions
         WHERE completion_id = $1 AND intent_id = $2 AND job_id = $3`,
        [input.completionId, operation.intent_id, operation.job_id],
      );
      const observed = completion.rows[0];
      if (observed === undefined) {
        throw new NotFoundError(
          "engineering job_completion",
          `${input.operationId}/${input.completionId}`,
        );
      }
      return this.#appendEvent(tx, operation, "COMPLETION_OBSERVED", {
        completionId: observed.completion_id,
        payload: { completion_id: observed.completion_id, outcome: observed.outcome },
      });
    });
  }

  /** Read one exact operation for stage-level recovery; no run-wide "latest" inference. */
  public async readOperationRecovery(
    q: Queryable,
    rawInput: unknown,
  ): Promise<EngineeringControlOperationRecovery | null> {
    const input = parseInput(operationIdentity, rawInput, "engineering operation identity");
    const operationResult = await q.query<EngineeringControlOperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM engineering_operations WHERE operation_id = $1`,
      [input.operationId],
    );
    const operation = operationResult.rows[0];
    if (operation === undefined) return null;
    const state = await q.query<{
      started: boolean;
      completion_outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | null;
    }>(
      `SELECT EXISTS (
         SELECT 1 FROM engineering_stage_events
          WHERE operation_id = $1 AND event_type = 'STARTED'
       ) AS started,
       (
         SELECT c.outcome FROM job_completions c
          WHERE c.intent_id = $2 AND c.job_id = $3
       ) AS completion_outcome`,
      [operation.operation_id, operation.intent_id, operation.job_id],
    );
    const artifactResult = await q.query<EngineeringControlArtifactRevisionRow>(
      `SELECT a.*
         FROM engineering_artifact_revisions a
         JOIN engineering_stage_events e
           ON e.artifact_revision_id = a.artifact_revision_id
          AND e.operation_id = a.operation_id
          AND e.event_type = 'ARTIFACT_RECORDED'
        WHERE a.operation_id = $1
        ORDER BY e.event_sequence DESC
        LIMIT 1`,
      [operation.operation_id],
    );
    const artifactRow = artifactResult.rows[0] ?? null;
    const artifact =
      artifactRow === null ? null : validateArtifactRowBinding(artifactRow, operation);
    return {
      operation,
      started: state.rows[0]?.started ?? false,
      completion_outcome: state.rows[0]?.completion_outcome ?? null,
      artifact,
    };
  }

  /**
   * Read the exact queue completion for one operation and prove whether that
   * same completion was observed by the engineering event stream. No run-wide
   * latest-row inference is used: both joins retain the operation's intent/job
   * identity and the observation retains operation/intent/job/completion.
   */
  public async readOperationCompletion(
    q: Queryable,
    rawInput: unknown,
  ): Promise<EngineeringControlOperationCompletion | null> {
    const input = parseInput(operationIdentity, rawInput, "engineering operation identity");
    const result = await q.query<
      EngineeringControlOperationRow & {
        descriptor: Record<string, unknown>;
        started: boolean;
        completion_id: string | null;
        completion_outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | null;
        completion_receipt: unknown;
        completion_observed: boolean;
        completion_observation_payload_digest: string | null;
      }
    >(
      `SELECT ${OPERATION_COLUMNS_O}, i.descriptor,
              EXISTS (
                SELECT 1
                  FROM engineering_stage_events started
                 WHERE started.operation_id = o.operation_id
                   AND started.intent_id = o.intent_id
                   AND started.job_id = o.job_id
                   AND started.event_type = 'STARTED'
              ) AS started,
              completion.completion_id,
              completion.outcome AS completion_outcome,
              completion.receipt AS completion_receipt,
              CASE WHEN completion.completion_id IS NULL THEN false ELSE EXISTS (
                SELECT 1
                  FROM engineering_stage_events observed
                 WHERE observed.operation_id = o.operation_id
                   AND observed.intent_id = o.intent_id
                   AND observed.job_id = o.job_id
                   AND observed.event_type = 'COMPLETION_OBSERVED'
                   AND observed.completion_id = completion.completion_id
                   AND observed.payload IS NOT DISTINCT FROM
                       jsonb_build_object(
                         'completion_id', completion.completion_id,
                         'outcome', completion.outcome
                       )
              ) END AS completion_observed,
              (
                SELECT observed.payload_digest
                  FROM engineering_stage_events observed
                 WHERE observed.operation_id = o.operation_id
                   AND observed.intent_id = o.intent_id
                   AND observed.job_id = o.job_id
                   AND observed.event_type = 'COMPLETION_OBSERVED'
                   AND observed.completion_id = completion.completion_id
                   AND observed.payload IS NOT DISTINCT FROM
                       jsonb_build_object(
                         'completion_id', completion.completion_id,
                         'outcome', completion.outcome
                       )
                 LIMIT 1
              ) AS completion_observation_payload_digest
         FROM engineering_operations o
         JOIN job_intents i
           ON i.intent_id = o.intent_id AND i.job_id = o.job_id
         LEFT JOIN job_completions completion
           ON completion.intent_id = o.intent_id AND completion.job_id = o.job_id
        WHERE o.operation_id = $1`,
      [input.operationId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (
      (row.completion_id === null) !== (row.completion_outcome === null) ||
      (row.completion_id === null && row.completion_receipt !== null) ||
      (row.completion_id === null && row.completion_observed)
    ) {
      throw new EngineeringControlStateError("engineering completion relationship is inconsistent");
    }
    if (
      row.completion_observed &&
      row.completion_id !== null &&
      row.completion_outcome !== null &&
      row.completion_observation_payload_digest !==
        canonicalDigest({
          completion_id: row.completion_id,
          outcome: row.completion_outcome,
        })
    ) {
      throw new EngineeringControlStateError("engineering completion observation is corrupted");
    }
    return {
      operation: projectEngineeringControlOperationRow(row),
      descriptor: row.descriptor,
      started: row.started,
      completion:
        row.completion_id === null || row.completion_outcome === null
          ? null
          : {
              completion_id: row.completion_id,
              outcome: row.completion_outcome,
              receipt: row.completion_receipt,
            },
      completion_observed: row.completion_observed,
    };
  }

  /** Strictly validated immutable artifacts for one exact run, in durable event order. */
  public async listRunArtifactRevisions(
    q: Queryable,
    rawInput: unknown,
  ): Promise<readonly EngineeringControlArtifactRevisionRow[]> {
    const input = parseInput(resumeInput, rawInput, "engineering run identity");
    const result = await q.query<EngineeringControlArtifactRevisionRow>(
      `SELECT a.*
         FROM engineering_artifact_revisions a
         JOIN engineering_stage_events e
           ON e.artifact_revision_id = a.artifact_revision_id
          AND e.operation_id = a.operation_id
          AND e.event_type = 'ARTIFACT_RECORDED'
        WHERE a.run_id = $1
        ORDER BY e.event_sequence ASC, a.artifact_revision_id ASC`,
      [input.runId],
    );
    return result.rows.map((row) => {
      if (row.run_id !== input.runId)
        throw new EngineeringControlStateError("run artifact query crossed run authority");
      return validateArtifactRowBinding(row);
    });
  }

  /** Metadata-only, exact-authority trace; deliberately never selects body/receipt/descriptor. */
  public async listRunTrace(
    q: Queryable,
    rawInput: unknown,
  ): Promise<readonly EngineeringControlRunTraceRow[]> {
    const input = parseInput(runTraceIdentity, rawInput, "engineering run trace identity");
    const result = await q.query<
      EngineeringControlRunTraceRow & {
        artifact_bound: boolean;
        completion_bound: boolean;
        reconciliation_bound: boolean;
      }
    >(
      `SELECT e.event_id, e.event_sequence, e.event_type,
              e.case_id, e.owner_id, e.run_id, e.checkpoint_revision,
              e.operation_id, o.operation_kind, o.effect_class,
              o.integration_scope_digest, o.input_digest, o.config_digest, o.schema_digest,
              e.stage, e.stage_attempt,
              e.artifact_revision_id, a.artifact_kind,
              e.completion_id, completion.outcome AS completion_outcome,
              e.reconciliation_id, reconciliation.resolution AS reconciliation_resolution,
              e.payload_digest, e.recorded_at,
              (e.artifact_revision_id IS NULL OR a.artifact_revision_id IS NOT NULL) AS artifact_bound,
              (e.completion_id IS NULL OR completion.completion_id IS NOT NULL) AS completion_bound,
              (e.reconciliation_id IS NULL OR reconciliation.reconciliation_id IS NOT NULL)
                AS reconciliation_bound
         FROM engineering_stage_events e
         JOIN engineering_operations o
           ON o.operation_id = e.operation_id
          AND o.intent_id = e.intent_id AND o.job_id = e.job_id
          AND o.case_id = e.case_id AND o.owner_id = e.owner_id AND o.run_id = e.run_id
          AND o.stage = e.stage AND o.stage_attempt = e.stage_attempt
          AND o.checkpoint_revision = e.checkpoint_revision
         JOIN agent_runs r
           ON r.run_id = e.run_id AND r.case_id = e.case_id AND r.owner_id = e.owner_id
         JOIN cases c ON c.case_id = e.case_id AND c.owner_id = e.owner_id
         LEFT JOIN engineering_artifact_revisions a
           ON a.artifact_revision_id = e.artifact_revision_id
          AND a.operation_id = e.operation_id AND a.intent_id = e.intent_id AND a.job_id = e.job_id
          AND a.case_id = e.case_id AND a.owner_id = e.owner_id AND a.run_id = e.run_id
          AND a.stage = e.stage AND a.stage_attempt = e.stage_attempt
          AND a.checkpoint_revision = e.checkpoint_revision AND a.revision = e.checkpoint_revision
         LEFT JOIN job_completions completion
           ON completion.completion_id = e.completion_id
          AND completion.intent_id = e.intent_id AND completion.job_id = e.job_id
         LEFT JOIN job_reconciliations reconciliation
           ON reconciliation.reconciliation_id = e.reconciliation_id
          AND reconciliation.intent_id = e.intent_id AND reconciliation.job_id = e.job_id
        WHERE e.case_id = $1 AND e.owner_id = $2 AND e.run_id = $3
          AND e.checkpoint_revision = $4
        ORDER BY e.event_sequence ASC`,
      [input.caseId, input.ownerId, input.runId, input.checkpointRevision],
    );
    return result.rows.map((row) => {
      if (
        !row.artifact_bound ||
        !row.completion_bound ||
        !row.reconciliation_bound ||
        (row.completion_id === null) !== (row.completion_outcome === null) ||
        (row.reconciliation_id === null) !== (row.reconciliation_resolution === null) ||
        (row.artifact_kind !== null &&
          !isEngineeringArtifactKindAllowedForStage(
            row.stage,
            row.artifact_kind as EngineeringArtifact["artifact_kind"],
          ))
      ) {
        throw new EngineeringControlStateError("engineering run trace relationship is corrupted");
      }
      const trace = { ...row } as Partial<typeof row>;
      delete trace.artifact_bound;
      delete trace.completion_bound;
      delete trace.reconciliation_bound;
      return trace as EngineeringControlRunTraceRow;
    });
  }

  /**
   * Reconstruct the current run solely from immutable ledgers and replace the
   * disposable materialized projection. Unknown mutating outcomes always win
   * over cancellation; no branch maps an uncertain write to success.
   */
  public async prepareResume(db: TxDb, rawInput: unknown): Promise<EngineeringControlResumePlan> {
    const input = parseInput(resumeInput, rawInput, "engineering resume identity");
    return db.withTransaction(async (tx) => {
      const source = await this.#recoverySource(tx, input.runId);
      const currentScopeDigest = canonicalDigest(source.integration_scope);
      const scopeChanged = currentScopeDigest !== source.integration_scope_digest;
      const fenceChanged = source.current_fencing_token !== source.intent_fencing_token;
      const killSwitchEventIds = await this.#effectiveKillSwitches(
        tx,
        source.case_id,
        source.owner_id,
      );

      let classification: EngineeringControlRecoveryClassification;
      let reason: string;
      if (source.terminal_resolution === "CONFIRMED") {
        classification = "RECOVERED";
        reason = "terminal reconciliation confirms the effect";
      } else if (source.terminal_resolution === "ABSENT") {
        classification = "DIRTY";
        reason = "terminal reconciliation proves the effect absent";
      } else if (
        source.completion_outcome === "AMBIGUOUS" ||
        source.has_unresolved_reconciliation
      ) {
        classification = "AMBIGUOUS";
        reason = "the durable completion or reconciliation remains unresolved";
      } else if (source.completion_outcome === "SUCCEEDED") {
        classification = "RECOVERED";
        reason = "the durable completion receipt is authoritative";
      } else if (source.completion_outcome === "FAILED") {
        classification = "DIRTY";
        reason = "the durable completion confirms no successful effect";
      } else if (
        source.started &&
        (source.effect_class === "COMMAND" || source.effect_class === "MUTATING_SIDE_EFFECT")
      ) {
        classification = "AMBIGUOUS";
        reason = "a mutating operation started without a confirmed receipt";
      } else {
        classification = "DIRTY";
        reason = source.started
          ? "a retry-safe operation started without a completion"
          : "the operation intent exists but STARTED was never committed";
      }

      let terminalReason: EngineeringControlResumePlan["terminal_reason"] = null;
      // Unknown writes retain their conservative state even when cancellation,
      // scope or fencing changes are observed afterwards.
      if (classification === "AMBIGUOUS") {
        terminalReason = "AMBIGUOUS";
      } else if (source.cancellation_requested || source.case_status === "CANCELLED") {
        classification = "CANCELLED";
        terminalReason = "CANCELLED";
        reason = "cancellation was durably requested with no unresolved write";
      } else if (
        scopeChanged ||
        fenceChanged ||
        killSwitchEventIds.length > 0 ||
        source.case_status === "BLOCKED" ||
        source.case_status === "DONE"
      ) {
        classification = "BLOCKED";
        terminalReason = "BLOCKED";
        const blockers = [
          scopeChanged ? "integration scope changed" : null,
          fenceChanged ? "fencing token changed" : null,
          killSwitchEventIds.length > 0
            ? `kill switch active (${killSwitchEventIds.join(",")})`
            : null,
          source.case_status === "BLOCKED" || source.case_status === "DONE"
            ? `case is ${source.case_status}`
            : null,
        ].filter((value): value is string => value !== null);
        reason = blockers.join("; ");
      } else if (
        classification === "DIRTY" &&
        source.deadline_at.getTime() <= this.#runtime.clock.now()
      ) {
        classification = "BLOCKED";
        terminalReason = "EXHAUSTED";
        reason = "operation deadline elapsed before a confirmed completion";
      }

      const projection = {
        schema_version: 1,
        run_id: source.run_id,
        case_id: source.case_id,
        owner_id: source.owner_id,
        checkpoint_revision: source.checkpoint_revision,
        operation_id: source.operation_id,
        stage: source.stage,
        stage_attempt: source.stage_attempt,
        classification,
        cancellation_requested: source.cancellation_requested,
        terminal_reason: terminalReason,
        reason,
        last_event_id: source.last_event_id,
        last_event_sequence: source.last_event_sequence,
        current_artifact_revision_id: source.current_artifact_revision_id,
      };
      const projectionDigest = canonicalDigest(projection);

      await tx.query(
        `INSERT INTO engineering_run_projections (
           run_id, case_id, owner_id, checkpoint_revision, current_stage,
           stage_attempt, recovery_status, cancellation_requested,
           current_operation_id, current_artifact_revision_id, last_event_id,
           last_event_sequence, projection, projection_digest,
           updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,
                 to_timestamp($15 / 1000.0))
         ON CONFLICT (run_id) DO UPDATE SET
           case_id = EXCLUDED.case_id,
           owner_id = EXCLUDED.owner_id,
           checkpoint_revision = EXCLUDED.checkpoint_revision,
           current_stage = EXCLUDED.current_stage,
           stage_attempt = EXCLUDED.stage_attempt,
           recovery_status = EXCLUDED.recovery_status,
           cancellation_requested = EXCLUDED.cancellation_requested,
           current_operation_id = EXCLUDED.current_operation_id,
           current_artifact_revision_id = EXCLUDED.current_artifact_revision_id,
           last_event_id = EXCLUDED.last_event_id,
           last_event_sequence = EXCLUDED.last_event_sequence,
           projection = EXCLUDED.projection,
           projection_digest = EXCLUDED.projection_digest,
           updated_at = EXCLUDED.updated_at`,
        [
          source.run_id,
          source.case_id,
          source.owner_id,
          source.checkpoint_revision,
          source.stage,
          source.stage_attempt,
          classification,
          source.cancellation_requested,
          source.operation_id,
          source.current_artifact_revision_id,
          source.last_event_id,
          source.last_event_sequence,
          JSON.stringify(projection),
          projectionDigest,
          this.#runtime.clock.now(),
        ],
      );

      return {
        run_id: source.run_id,
        case_id: source.case_id,
        owner_id: source.owner_id,
        checkpoint_revision: source.checkpoint_revision,
        operation_id: source.operation_id,
        stage: source.stage,
        stage_attempt: source.stage_attempt,
        classification,
        cancellation_requested: source.cancellation_requested,
        terminal_reason: terminalReason,
        reason,
        last_event_id: source.last_event_id,
        last_event_sequence: source.last_event_sequence,
        current_artifact_revision_id: source.current_artifact_revision_id,
        projection_digest: projectionDigest,
      };
    });
  }

  /** Read the latest materialized status without changing any durable state. */
  public async readRunStatus(
    q: Queryable,
    rawInput: unknown,
  ): Promise<EngineeringControlRunStatusRow | null> {
    const input = parseInput(operatorStatusInput, rawInput, "engineering status identity");
    const result = await q.query<EngineeringControlRunStatusRow>(
      `SELECT run_id, case_id, owner_id, checkpoint_revision, current_stage,
              stage_attempt, recovery_status, cancellation_requested,
              current_operation_id, current_artifact_revision_id, last_event_id,
              last_event_sequence::text, projection, projection_digest, updated_at
       FROM engineering_run_projections WHERE run_id = $1 AND owner_id = $2`,
      [input.runId, input.ownerId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Read execution control from authoritative run/case rows and the immutable event ledger.
   * The disposable projection is deliberately excluded: a crash may follow the cancellation
   * event commit but precede projection repair.
   */
  public async readRunControlState(
    q: Queryable,
    rawInput: unknown,
  ): Promise<EngineeringControlRunControlState> {
    const input = parseInput(runControlIdentity, rawInput, "engineering run control identity");
    const result = await q.query<{ case_status: string; cancellation_requested: boolean }>(
      `SELECT c.status AS case_status,
              EXISTS (
                SELECT 1
                FROM engineering_stage_events e
                WHERE e.run_id = r.run_id
                  AND e.case_id = r.case_id
                  AND e.owner_id = r.owner_id
                  AND e.checkpoint_revision = r.checkpoint_revision
                  AND e.event_type = 'OPERATOR_CANCEL_REQUESTED'
              ) AS cancellation_requested
       FROM agent_runs r
       JOIN cases c ON c.case_id = r.case_id AND c.owner_id = r.owner_id
       WHERE r.run_id = $1 AND r.case_id = $2 AND r.owner_id = $3
         AND r.checkpoint_revision = $4`,
      [input.runId, input.caseId, input.ownerId, input.checkpointRevision],
    );
    const state = result.rows[0];
    if (state === undefined) throw new NotFoundError("engineering_run_control", input.runId);
    return Object.freeze({
      cancelled: state.cancellation_requested || state.case_status === "CANCELLED",
    });
  }

  /** Record operator knowledge without changing the recovered outcome. */
  public async acknowledgeOperation(
    db: TxDb,
    rawInput: unknown,
  ): Promise<EngineeringControlOperatorResult> {
    const input = parseInput(operatorActionInput, rawInput, "operator acknowledge");
    const event = await this.#recordOperatorEvent(db, input, "OPERATOR_ACKNOWLEDGED", {
      action_id: input.actionId,
      actor_id: input.actorId,
      reason: input.reason,
    });
    const plan = await this.prepareResume(db, { runId: event.run_id });
    return { event, plan };
  }

  /** Persist cancellation; STARTED remains blocked and unknown writes stay AMBIGUOUS. */
  public async requestCancellation(
    db: TxDb,
    rawInput: unknown,
  ): Promise<EngineeringControlOperatorResult> {
    const input = parseInput(operatorActionInput, rawInput, "operator cancellation");
    const event = await this.#recordOperatorEvent(db, input, "OPERATOR_CANCEL_REQUESTED", {
      action_id: input.actionId,
      actor_id: input.actorId,
      reason: input.reason,
      cancellation_requested: true,
    });
    const plan = await this.prepareResume(db, { runId: event.run_id });
    return { event, plan };
  }

  /**
   * Authorize a new operation identity only when the target never STARTED or a
   * terminal reconciliation proved its effect ABSENT.
   */
  public async requestRetry(
    db: TxDb,
    rawInput: unknown,
  ): Promise<EngineeringControlOperatorResult & { retry_operation_id: string }> {
    const input = parseInput(operatorActionInput, rawInput, "operator retry");
    const retryOperationId = `eng-retry-${canonicalDigest({
      action_id: input.actionId,
      operation_id: input.operationId,
    }).slice(7, 39)}`;
    const event = await this.#recordOperatorEvent(
      db,
      input,
      "OPERATOR_RETRY_REQUESTED",
      {
        action_id: input.actionId,
        actor_id: input.actorId,
        reason: input.reason,
        retry_operation_id: retryOperationId,
      },
      null,
      async (tx, operation) => {
        const eligibility = await tx.query<{ started: boolean; absent: boolean }>(
          `SELECT
             EXISTS (
               SELECT 1 FROM engineering_stage_events e
               WHERE e.operation_id = $1 AND e.event_type = 'STARTED'
             ) AS started,
             EXISTS (
               SELECT 1 FROM job_reconciliations r
               WHERE r.intent_id = $2 AND r.resolution = 'ABSENT'
             ) AS absent`,
          [operation.operation_id, operation.intent_id],
        );
        const state = eligibility.rows[0]!;
        if (state.started && !state.absent) {
          throw new EngineeringControlStateError(
            "retry requires no STARTED marker or terminal ABSENT reconciliation",
          );
        }
      },
    );
    const plan = await this.prepareResume(db, { runId: event.run_id });
    return { event, plan, retry_operation_id: retryOperationId };
  }

  /**
   * Reconcile only through the existing JobStore ledger. A durable request event
   * precedes the reconciliation; a separate event observes its exact receipt.
   */
  public async reconcileOperation(
    db: TxDb,
    rawInput: unknown,
  ): Promise<EngineeringControlOperatorResult & { reconciliation_id: string }> {
    const input = parseInput(operatorReconcileInput, rawInput, "operator reconciliation");
    const requestEvent = await this.#recordOperatorEvent(
      db,
      input,
      "OPERATOR_RECONCILE_REQUESTED",
      {
        action_id: input.actionId,
        actor_id: input.actorId,
        reason: input.reason,
        resolution: input.resolution,
        evidence_digest: canonicalDigest(input.evidence ?? null),
      },
    );
    const requestPlan = await this.prepareResume(db, { runId: requestEvent.run_id });

    const reconciled = await this.#jobs.reconcile(db, {
      intentId: requestEvent.intent_id,
      jobId: requestEvent.job_id,
      resolution: input.resolution,
      attemptKey: input.actionId,
      evidence: input.evidence ?? null,
    });
    const receiptActionId = `operator-receipt-${canonicalDigest({
      action_id: input.actionId,
      reconciliation_id: reconciled.reconciliationId,
    }).slice(7, 39)}`;
    const receiptEvent = await this.#recordOperatorEvent(
      db,
      {
        ...input,
        actionId: receiptActionId,
        expectedProjectionDigest: requestPlan.projection_digest,
      },
      "OPERATOR_RECONCILED",
      {
        action_id: input.actionId,
        actor_id: input.actorId,
        reconciliation_id: reconciled.reconciliationId,
        resolution: reconciled.resolution,
        job_status: reconciled.jobStatus,
      },
      reconciled.reconciliationId,
    );
    const plan = await this.prepareResume(db, { runId: receiptEvent.run_id });
    return { event: receiptEvent, plan, reconciliation_id: reconciled.reconciliationId };
  }

  async #recordOperatorEvent(
    db: TxDb,
    input: z.infer<typeof operatorActionBase>,
    eventType:
      | "OPERATOR_ACKNOWLEDGED"
      | "OPERATOR_CANCEL_REQUESTED"
      | "OPERATOR_RECONCILE_REQUESTED"
      | "OPERATOR_RECONCILED"
      | "OPERATOR_RETRY_REQUESTED",
    payload: Record<string, unknown>,
    reconciliationId: string | null = null,
    precondition?: (tx: Transaction, operation: EngineeringControlOperationRow) => Promise<void>,
  ): Promise<EngineeringControlStageEventRow> {
    const payloadDigest = canonicalDigest(payload);
    return db.withTransaction(async (tx) => {
      const prior = await tx.query<EngineeringControlStageEventRow>(
        `SELECT ${EVENT_COLUMNS}
         FROM engineering_stage_events WHERE event_id = $1`,
        [input.actionId],
      );
      const existing = prior.rows[0];
      if (existing !== undefined) {
        if (
          existing.event_type !== eventType ||
          existing.operation_id !== input.operationId ||
          existing.payload_digest !== payloadDigest ||
          existing.reconciliation_id !== reconciliationId
        ) {
          throw new EngineeringControlConflictError(input.actionId);
        }
        return existing;
      }

      const operation = await this.#operationById(tx, input.operationId);
      if (input.actorId !== operation.owner_id) {
        throw new EngineeringControlStateError("operator actor does not own the target case");
      }
      // Use the same lock order as STARTED/artifact writes: authoritative job
      // fence first, then the existing run row used by the event-sequence trigger.
      // The following projection query runs under a fresh READ COMMITTED statement
      // snapshot, so it cannot authorize from a digest that missed a concurrent event.
      await tx.query(`SELECT 1 FROM jobs WHERE job_id = $1 AND case_id = $2 FOR UPDATE`, [
        operation.job_id,
        operation.case_id,
      ]);
      await tx.query(`SELECT 1 FROM agent_runs WHERE run_id = $1 AND case_id = $2 FOR UPDATE`, [
        operation.run_id,
        operation.case_id,
      ]);
      const projection = await tx.query<{ one: number }>(
        `SELECT 1 AS one
         FROM engineering_run_projections p
         WHERE p.run_id = $1 AND p.current_operation_id = $2
           AND p.projection_digest = $3
           AND p.last_event_sequence = (
             SELECT max(e.event_sequence)
             FROM engineering_stage_events e WHERE e.run_id = p.run_id
           )
         FOR UPDATE`,
        [operation.run_id, operation.operation_id, input.expectedProjectionDigest],
      );
      if (projection.rowCount !== 1) {
        throw new EngineeringControlStateError(
          "operator action has a stale projection or targets a non-current operation",
        );
      }
      await precondition?.(tx, operation);

      const inserted = await tx.query<EngineeringControlStageEventRow>(
        `INSERT INTO engineering_stage_events (
           event_id, event_sequence, event_type, operation_id, intent_id, job_id,
           case_id, owner_id, run_id, stage, stage_attempt, checkpoint_revision,
           reconciliation_id, payload, payload_digest, recorded_at)
         VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,
                 to_timestamp($15 / 1000.0))
         ON CONFLICT DO NOTHING
         RETURNING ${EVENT_COLUMNS}`,
        [
          input.actionId,
          eventType,
          operation.operation_id,
          operation.intent_id,
          operation.job_id,
          operation.case_id,
          operation.owner_id,
          operation.run_id,
          operation.stage,
          operation.stage_attempt,
          operation.checkpoint_revision,
          reconciliationId,
          JSON.stringify(payload),
          payloadDigest,
          this.#runtime.clock.now(),
        ],
      );
      const event = inserted.rows[0];
      if (event !== undefined) return event;

      const raced = await tx.query<EngineeringControlStageEventRow>(
        `SELECT ${EVENT_COLUMNS}
         FROM engineering_stage_events WHERE event_id = $1`,
        [input.actionId],
      );
      const winner = raced.rows[0];
      if (
        winner === undefined ||
        winner.event_type !== eventType ||
        winner.operation_id !== input.operationId ||
        winner.payload_digest !== payloadDigest ||
        winner.reconciliation_id !== reconciliationId
      ) {
        throw new EngineeringControlConflictError(input.actionId);
      }
      return winner;
    });
  }

  async #recoverySource(
    tx: Transaction,
    runId: string,
  ): Promise<EngineeringControlRecoverySourceRow> {
    const result = await tx.query<EngineeringControlRecoverySourceRow>(
      `SELECT ${OPERATION_COLUMNS_O},
              i.fencing_token::text AS intent_fencing_token,
              j.fencing_token::text AS current_fencing_token,
              j.status AS job_status,
              c.integration_scope,
              c.status AS case_status,
              completion.completion_id,
              completion.outcome AS completion_outcome,
              terminal.resolution AS terminal_resolution,
              EXISTS (
                SELECT 1 FROM job_reconciliations unresolved
                WHERE unresolved.intent_id = o.intent_id
                  AND unresolved.resolution = 'UNRESOLVED'
              ) AS has_unresolved_reconciliation,
              EXISTS (
                SELECT 1 FROM engineering_stage_events started
                WHERE started.operation_id = o.operation_id
                  AND started.event_type = 'STARTED'
              ) AS started,
              EXISTS (
                SELECT 1 FROM engineering_stage_events cancelled
                WHERE cancelled.operation_id = o.operation_id
                  AND cancelled.event_type = 'OPERATOR_CANCEL_REQUESTED'
              ) AS cancellation_requested,
              latest.event_id AS last_event_id,
              latest.event_sequence::text AS last_event_sequence,
              artifact.artifact_revision_id AS current_artifact_revision_id
       FROM engineering_operations o
       JOIN job_intents i ON i.intent_id = o.intent_id AND i.job_id = o.job_id
       JOIN jobs j ON j.job_id = o.job_id AND j.case_id = o.case_id
       JOIN cases c ON c.case_id = o.case_id AND c.owner_id = o.owner_id
       LEFT JOIN job_completions completion
         ON completion.intent_id = o.intent_id AND completion.job_id = o.job_id
       LEFT JOIN LATERAL (
         SELECT resolution
         FROM job_reconciliations r
         WHERE r.intent_id = o.intent_id
           AND r.resolution IN ('CONFIRMED', 'ABSENT')
         ORDER BY reconciled_at DESC
         LIMIT 1
       ) terminal ON true
       JOIN LATERAL (
         SELECT event_id, event_sequence
         FROM engineering_stage_events e
         WHERE e.operation_id = o.operation_id
         ORDER BY event_sequence DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT artifact_revision_id
         FROM engineering_stage_events e
         WHERE e.operation_id = o.operation_id
           AND e.event_type = 'ARTIFACT_RECORDED'
         ORDER BY event_sequence DESC
         LIMIT 1
       ) artifact ON true
       WHERE o.run_id = $1
       ORDER BY latest.event_sequence DESC, o.recorded_at DESC
       LIMIT 1
       FOR SHARE OF o, i, j, c`,
      [runId],
    );
    const source = result.rows[0];
    if (source === undefined) throw new NotFoundError("engineering_run", runId);
    return source;
  }

  async #effectiveKillSwitches(q: Queryable, caseId: string, ownerId: string): Promise<string[]> {
    const result = await q.query<{ event_id: string }>(
      `WITH latest AS (
         SELECT k.*,
                row_number() OVER (
                  PARTITION BY scope_level, owner_id, provider, connection_id
                  ORDER BY event_sequence DESC
                ) AS rn
         FROM kill_switch_events k
       )
       SELECT DISTINCT l.event_id
       FROM latest l
       WHERE l.rn = 1 AND l.enabled = true
         AND (
           l.scope_level = 'GLOBAL'
           OR (l.scope_level = 'PROVIDER' AND EXISTS (
             SELECT 1 FROM case_connections cc
             WHERE cc.case_id = $1 AND cc.provider = l.provider
           ))
           OR (l.scope_level = 'CONNECTION' AND l.owner_id = $2 AND EXISTS (
             SELECT 1 FROM case_connections cc
             WHERE cc.case_id = $1 AND cc.connection_id = l.connection_id
               AND cc.provider = l.provider
           ))
         )
       ORDER BY l.event_id`,
      [caseId, ownerId],
    );
    return result.rows.map((row) => row.event_id);
  }

  async #assertOperationLease(
    tx: Transaction,
    lease: JobLease,
    operationId: string,
  ): Promise<EngineeringControlOperationAuthorityRow> {
    const operation = await this.#operationById(tx, operationId);
    if (operation.job_id !== lease.jobId || operation.case_id !== lease.caseId) {
      throw new EngineeringControlStateError("operation is outside the supplied job lease");
    }
    await this.#jobs.recordIntentInTransaction(tx, lease, {
      kind: operation.operation_kind,
      descriptor: operation.descriptor,
      idempotencyKey: operation.operation_id,
    });
    return operation;
  }

  async #assertPreStartControls(
    tx: Transaction,
    operation: EngineeringControlOperationRow,
  ): Promise<void> {
    const current = await tx.query<{
      status: string;
      integration_scope: Record<string, unknown>;
      cancelled: boolean;
    }>(
      `SELECT c.status, c.integration_scope,
              EXISTS (
                SELECT 1 FROM engineering_stage_events e
                WHERE e.run_id = $2
                  AND e.event_type = 'OPERATOR_CANCEL_REQUESTED'
              ) AS cancelled
       FROM cases c
       WHERE c.case_id = $1 AND c.owner_id = $3
       FOR SHARE`,
      [operation.case_id, operation.run_id, operation.owner_id],
    );
    const control = current.rows[0];
    if (control === undefined) {
      throw new EngineeringControlStateError("operation case authority disappeared");
    }
    if (canonicalDigest(control.integration_scope) !== operation.integration_scope_digest) {
      throw new EngineeringControlStateError("integration scope changed before STARTED");
    }
    if (["BLOCKED", "CANCELLED", "DONE"].includes(control.status) || control.cancelled) {
      throw new EngineeringControlStateError("operation is stopped by case or cancellation state");
    }
    if (operation.deadline_at.getTime() <= this.#runtime.clock.now()) {
      throw new EngineeringControlStateError("operation deadline elapsed before STARTED");
    }
    const switches = await this.#effectiveKillSwitches(tx, operation.case_id, operation.owner_id);
    if (switches.length > 0) {
      throw new EngineeringControlStateError("operation is stopped by an active kill switch");
    }
  }

  async #operationById(
    q: Queryable,
    operationId: string,
  ): Promise<EngineeringControlOperationAuthorityRow> {
    const result = await q.query<EngineeringControlOperationAuthorityRow>(
      `SELECT ${OPERATION_COLUMNS_O}, i.descriptor
       FROM engineering_operations o
       JOIN job_intents i ON i.intent_id = o.intent_id AND i.job_id = o.job_id
       WHERE o.operation_id = $1`,
      [operationId],
    );
    const operation = result.rows[0];
    if (operation === undefined) throw new NotFoundError("engineering_operation", operationId);
    return operation;
  }

  async #appendEvent(
    tx: Transaction,
    operation: EngineeringControlOperationRow,
    eventType: EngineeringControlStageEventRow["event_type"],
    input: {
      artifactRevisionId?: string;
      completionId?: string;
      payload: Record<string, unknown>;
    },
    allowReplay = true,
  ): Promise<EngineeringControlStageEventRow> {
    const eventId = this.#runtime.ids.next("eng-event");
    const payloadDigest = canonicalDigest(input.payload);
    const inserted = await tx.query<EngineeringControlStageEventRow>(
      `INSERT INTO engineering_stage_events (
         event_id, event_sequence, event_type, operation_id, intent_id, job_id,
         case_id, owner_id, run_id, stage, stage_attempt, checkpoint_revision,
         artifact_revision_id, completion_id, payload, payload_digest, recorded_at)
       VALUES ($1,0,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,
               to_timestamp($16 / 1000.0))
       ON CONFLICT DO NOTHING
       RETURNING ${EVENT_COLUMNS}`,
      [
        eventId,
        eventType,
        operation.operation_id,
        operation.intent_id,
        operation.job_id,
        operation.case_id,
        operation.owner_id,
        operation.run_id,
        operation.stage,
        operation.stage_attempt,
        operation.checkpoint_revision,
        input.artifactRevisionId ?? null,
        input.completionId ?? null,
        JSON.stringify(input.payload),
        payloadDigest,
        this.#runtime.clock.now(),
      ],
    );
    const fresh = inserted.rows[0];
    if (fresh !== undefined) return fresh;
    if (!allowReplay) {
      throw new EngineeringControlStateError(
        `${eventType} already exists for operation ${operation.operation_id}; recover before dispatch`,
      );
    }

    const selector =
      eventType === "ARTIFACT_RECORDED"
        ? "artifact_revision_id = $3"
        : eventType === "COMPLETION_OBSERVED"
          ? "completion_id = $3"
          : "operation_id = $3";
    const source = input.artifactRevisionId ?? input.completionId ?? operation.operation_id;
    const existing = await tx.query<EngineeringControlStageEventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM engineering_stage_events
       WHERE event_type = $1 AND operation_id = $2 AND ${selector}
         AND payload IS NOT DISTINCT FROM $4::jsonb`,
      [eventType, operation.operation_id, source, JSON.stringify(input.payload)],
    );
    const prior = existing.rows[0];
    if (
      prior === undefined ||
      prior.payload_digest !== payloadDigest ||
      prior.artifact_revision_id !== (input.artifactRevisionId ?? null) ||
      prior.completion_id !== (input.completionId ?? null)
    ) {
      throw new EngineeringControlConflictError(`${eventType}/${source}`);
    }
    return prior;
  }
}
