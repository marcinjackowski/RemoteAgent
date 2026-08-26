/** Stage-aware cross-fence classifier. It never owns queue scheduling or a generic writer lease. */
import {
  EngineeringStage,
  canonicalDigest,
  engineeringArtifact,
  engineeringArtifactDigest,
  engineeringRecoveryPlanV1,
  engineeringWriteDeploymentPolicyV1Digest,
  normalizeEngineeringWriteDeploymentPolicyV1,
  type EngineeringArtifact,
  type EngineeringRecoveryPlanV1,
  type EngineeringStage as EngineeringStageValue,
  type EngineeringWriteDeploymentPolicyV1,
} from "@remoteagent/contracts";
import type { EngineeringStageBinding } from "@remoteagent/agent-orchestrator";
import type { RuntimeConfig, RuntimeTransport } from "@remoteagent/bedrock-runtime";
import {
  EngineeringControlPlaneRepository,
  EngineeringRecoveryRepository,
  productionRuntime,
  type Database,
  type EngineeringRecoveryLease,
  type JobLease,
  type JobStore,
  type SchedulerContinuationLane,
} from "@remoteagent/database";
import type { PreCommitReviewSessionFactory } from "@remoteagent/review-loop";
import * as z from "zod";

import {
  engineeringContextPacketDigest,
  type CompiledRoleContext,
  type RoleContextReader,
} from "./context.js";
import {
  engineeringStageContextIntentDescriptor,
  gateExecutionIntentDescriptor,
  localCommitIntentDescriptor,
  type EngineeringGateStageExecutor,
  type EngineeringLocalCommitStageExecutor,
  type EngineeringStageExecutor,
} from "./engineering-workflow.js";
import {
  createEngineeringExecution,
  type EngineeringExecutionConfig,
} from "./engineering-execution.js";

const MODEL_CALL_LIMIT = 32;
const STAGE_CALL_LIMIT = 64;

const MODEL_STAGES = new Set<EngineeringStageValue>([
  EngineeringStage.OUTCOME_DEFINITION,
  EngineeringStage.SYSTEM_DESIGN,
  EngineeringStage.PROGRAM_DESIGN,
  EngineeringStage.DESIGN_APPROVAL,
  EngineeringStage.SLICE_PLANNING,
  EngineeringStage.SLICE_IMPLEMENTATION,
  EngineeringStage.SLICE_REVIEW,
  EngineeringStage.MEMORY_PROJECTION,
  EngineeringStage.FINAL_VERIFICATION,
]);

export type EngineeringRecoveryClassificationResult =
  | Readonly<{
      status: "CONTINUATION_READY";
      plan: EngineeringRecoveryPlanV1;
      planDigest: string;
      repairedArtifact: EngineeringArtifact | null;
    }>
  | Readonly<{
      status: "RETRY_READY";
      plan: EngineeringRecoveryPlanV1;
      planDigest: string;
      context: CompiledRoleContext;
    }>
  | Readonly<{
      status: "TERMINAL";
      plan: EngineeringRecoveryPlanV1;
      planDigest: string;
      terminal: "AMBIGUOUS" | "BLOCKED" | "CANCELLED";
    }>;

export interface EngineeringStageRecoveryOptions {
  readonly db: Database;
  readonly lease: EngineeringRecoveryLease;
  readonly readContext: RoleContextReader;
  readonly writeDeploymentPolicy: EngineeringWriteDeploymentPolicyV1;
  readonly stageConfigDigest: (stage: EngineeringStageValue) => string;
  readonly stageSchemaDigest: (stage: EngineeringStageValue) => string;
  readonly gateExecutor?: EngineeringGateStageExecutor;
  readonly localCommitExecutor?: EngineeringLocalCommitStageExecutor;
  readonly controlPlane?: EngineeringControlPlaneRepository;
  readonly recoveries?: EngineeringRecoveryRepository;
  readonly now?: () => number;
}

export interface ProductionEngineeringRecoveryCoordinatorOptions {
  readonly db: Database;
  readonly jobs: JobStore;
  readonly owner: string;
  readonly config: EngineeringExecutionConfig;
  readonly transport: RuntimeTransport;
  readonly modelConfig: RuntimeConfig;
  readonly readContext: RoleContextReader;
  readonly stageExecutor: EngineeringStageExecutor;
  readonly createReviewerSession: PreCommitReviewSessionFactory;
  readonly workflowDeadlineMs?: number;
  readonly recoveryLeaseMs?: number;
  readonly recoveries?: EngineeringRecoveryRepository;
  readonly controlPlane?: EngineeringControlPlaneRepository;
}

type ContextDescriptor = z.infer<typeof engineeringStageContextIntentDescriptor>;

function binding(lease: EngineeringRecoveryLease): EngineeringStageBinding {
  const row = lease.recovery;
  if (row.source_stage === null || row.source_stage_attempt === null) {
    throw new Error("engineering recovery has no source stage binding");
  }
  return Object.freeze({
    caseId: row.case_id,
    workUnitId: row.work_unit_id,
    runId: row.run_id,
    checkpointRevision: row.checkpoint_revision,
    stage: z.enum(EngineeringStage).parse(row.source_stage),
    attempt: row.source_stage_attempt,
  });
}

function contextDescriptor(raw: unknown, stage: EngineeringStageValue): ContextDescriptor {
  if (stage === EngineeringStage.GATE_EXECUTION) return gateExecutionIntentDescriptor.parse(raw);
  if (stage === EngineeringStage.LOCAL_COMMIT) return localCommitIntentDescriptor.parse(raw);
  return engineeringStageContextIntentDescriptor.parse(raw);
}

function assertDescriptor(input: {
  descriptor: ContextDescriptor;
  binding: EngineeringStageBinding;
  inputDigest: string;
}): void {
  const { descriptor, binding: exact } = input;
  if (
    descriptor.case_id !== exact.caseId ||
    descriptor.work_unit_id !== exact.workUnitId ||
    descriptor.run_id !== exact.runId ||
    descriptor.checkpoint_revision !== exact.checkpointRevision ||
    descriptor.stage !== exact.stage ||
    descriptor.attempt !== exact.attempt ||
    descriptor.context_manifest.case_id !== exact.caseId ||
    descriptor.context_manifest.run_id !== exact.runId ||
    descriptor.context_manifest.revision !== exact.checkpointRevision ||
    descriptor.context_manifest_digest !== engineeringArtifactDigest(descriptor.context_manifest) ||
    canonicalDigest(rawDescriptor(descriptor)) !== input.inputDigest
  ) {
    throw new Error("engineering recovery descriptor is not exact");
  }
}

function rawDescriptor(descriptor: ContextDescriptor): unknown {
  return descriptor;
}

async function exactContext(
  readContext: RoleContextReader,
  exact: EngineeringStageBinding,
  descriptor: ContextDescriptor,
): Promise<CompiledRoleContext> {
  const context = await readContext({
    caseId: exact.caseId,
    workUnitId: exact.workUnitId,
    runId: exact.runId,
    stage: exact.stage,
  });
  if (
    context.compiled.stage !== exact.stage ||
    context.snapshotDigest !== descriptor.context_snapshot_digest ||
    engineeringArtifactDigest(context.compiled.manifest) !== descriptor.context_manifest_digest ||
    engineeringContextPacketDigest(context) !== descriptor.context_packet_digest
  ) {
    throw new Error("engineering recovery context packet changed across the fence");
  }
  return context;
}

async function budgetReservation(input: {
  db: Database;
  runId: string;
  retryModel: boolean;
  context: CompiledRoleContext | null;
}): Promise<EngineeringRecoveryPlanV1["budget_reservation"] | null> {
  const prior = await input.db.query<{
    stage_calls: string;
    model_calls: string;
    reserved_stages: string;
    reserved_models: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM engineering_artifact_revisions WHERE run_id=$1) stage_calls,
       (SELECT (count(*) FILTER (WHERE stage = ANY($2::text[])) * 2)::text
          FROM engineering_artifact_revisions WHERE run_id=$1) model_calls,
       (SELECT coalesce(sum((plan->'budget_reservation'->>'stage_attempts')::bigint),0)::text
          FROM engineering_recoveries WHERE run_id=$1 AND plan IS NOT NULL) reserved_stages,
       (SELECT coalesce(sum((plan->'budget_reservation'->>'model_calls')::bigint),0)::text
          FROM engineering_recoveries WHERE run_id=$1 AND plan IS NOT NULL) reserved_models`,
    [input.runId, [...MODEL_STAGES]],
  );
  const row = prior.rows[0]!;
  const stages = Number(row.stage_calls) + Number(row.reserved_stages);
  const models = Number(row.model_calls) + Number(row.reserved_models);
  const requestedStages = 1;
  const requestedModels = input.retryModel ? 2 : 0;
  if (stages + requestedStages > STAGE_CALL_LIMIT || models + requestedModels > MODEL_CALL_LIMIT) {
    return null;
  }
  return Object.freeze({
    stage_attempts: requestedStages,
    model_calls: requestedModels,
    input_tokens: input.retryModel ? (input.context?.estimatedInputTokens ?? 0) * 2 : 0,
    output_tokens: 0,
  });
}

function operationPlan(
  lease: EngineeringRecoveryLease,
  descriptor: ContextDescriptor,
): NonNullable<EngineeringRecoveryPlanV1["operation"]> {
  const row = lease.recovery;
  if (
    row.source_operation_id === null ||
    row.source_intent_id === null ||
    row.source_stage === null ||
    row.source_stage_attempt === null ||
    row.source_effect_class === null ||
    row.source_input_digest === null ||
    row.source_config_digest === null ||
    row.source_schema_digest === null ||
    row.source_scope_digest === null ||
    row.source_deadline_at === null
  ) {
    throw new Error("engineering recovery operation tuple is incomplete");
  }
  return {
    operation_id: row.source_operation_id,
    intent_id: row.source_intent_id,
    stage: z.enum(EngineeringStage).parse(row.source_stage),
    stage_attempt: row.source_stage_attempt,
    effect_class: row.source_effect_class,
    input_digest: row.source_input_digest,
    config_digest: row.source_config_digest,
    schema_digest: row.source_schema_digest,
    scope_digest: row.source_scope_digest,
    deadline_at: row.source_deadline_at.toISOString(),
    context_manifest_digest: descriptor.context_manifest_digest,
    context_snapshot_digest: descriptor.context_snapshot_digest,
    context_packet_digest: descriptor.context_packet_digest,
  };
}

function plan(input: {
  lease: EngineeringRecoveryLease;
  classification: EngineeringRecoveryPlanV1["classification"];
  operation: EngineeringRecoveryPlanV1["operation"];
  evidenceDigest: string;
  budget: EngineeringRecoveryPlanV1["budget_reservation"];
}): EngineeringRecoveryPlanV1 {
  const row = input.lease.recovery;
  return engineeringRecoveryPlanV1.parse({
    schema_version: 1,
    recovery_id: row.recovery_id,
    root_recovery_id: row.root_recovery_id,
    source_job_id: row.source_job_id,
    source_fencing_token: Number(row.source_fencing_token),
    recovery_job_id: row.recovery_job_id,
    recovery_fencing_token: input.lease.job.fencingToken,
    case_id: row.case_id,
    owner_id: row.owner_id,
    work_unit_id: row.work_unit_id,
    run_id: row.run_id,
    checkpoint_revision: row.checkpoint_revision,
    repository_id: row.repository_id,
    workflow_deadline_at: row.workflow_deadline_at.toISOString(),
    classification: input.classification,
    operation: input.operation,
    evidence_digest: input.evidenceDigest,
    budget_reservation: input.budget,
  });
}

export async function classifyEngineeringRecovery(
  input: EngineeringStageRecoveryOptions,
): Promise<EngineeringRecoveryClassificationResult> {
  const control = input.controlPlane ?? new EngineeringControlPlaneRepository(productionRuntime());
  const recoveries = input.recoveries ?? new EngineeringRecoveryRepository(productionRuntime());
  const row = input.lease.recovery;
  const writePolicy = normalizeEngineeringWriteDeploymentPolicyV1(input.writeDeploymentPolicy);
  const currentAuthority = await input.db.query<{
    owner_id: string;
    checkpoint_revision: number;
    integration_scope: unknown;
    deployment_policy_digest: string;
    proposal_repository_id: string;
  }>(
    `SELECT r.owner_id,r.checkpoint_revision,c.integration_scope,
            p.deployment_policy_digest,p.repository_id AS proposal_repository_id
       FROM agent_runs r
       JOIN cases c ON c.case_id=r.case_id AND c.owner_id=r.owner_id
       JOIN engineering_write_proposals p
         ON p.proposal_id=$3 AND p.case_id=r.case_id AND p.owner_id=r.owner_id
        AND p.work_unit_id=r.work_unit_id AND p.run_id=r.run_id
        AND p.checkpoint_revision=r.checkpoint_revision AND p.status='GRANTED'
      WHERE r.run_id=$1 AND r.case_id=$2`,
    [row.run_id, row.case_id, row.proposal_id],
  );
  const authority = currentAuthority.rows[0];
  if (
    authority === undefined ||
    authority.owner_id !== row.owner_id ||
    authority.checkpoint_revision !== row.checkpoint_revision ||
    authority.proposal_repository_id !== row.repository_id ||
    row.repository_id !== writePolicy.repository_id ||
    authority.deployment_policy_digest !== engineeringWriteDeploymentPolicyV1Digest(writePolicy) ||
    (row.source_scope_digest !== null &&
      canonicalDigest(authority.integration_scope) !== row.source_scope_digest)
  ) {
    throw new Error("engineering recovery deployment policy changed");
  }
  const controlState = await control.readRunControlState(input.db, {
    runId: row.run_id,
    caseId: row.case_id,
    ownerId: row.owner_id,
    checkpointRevision: row.checkpoint_revision,
  });
  if (row.source_operation_id === null) {
    const deadlineExceeded = (input.now ?? Date.now)() >= row.workflow_deadline_at.getTime();
    const classification = controlState.cancelled
      ? "CANCELLED"
      : deadlineExceeded
        ? "BLOCKED"
        : "CONTINUE_NEXT_STAGE";
    const next = plan({
      lease: input.lease,
      classification,
      operation: null,
      evidenceDigest: canonicalDigest({ source: "BETWEEN_STAGES", run_id: row.run_id }),
      budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    const bound = await recoveries.bindPlan(input.db, input.lease, next);
    if (classification === "CANCELLED" || classification === "BLOCKED") {
      await recoveries.terminateRecovery(input.db, input.lease, bound.planDigest);
      return { status: "TERMINAL", ...bound, terminal: classification };
    }
    return { status: "CONTINUATION_READY", ...bound, repairedArtifact: null };
  }

  const exactBinding = binding(input.lease);
  const completion = await control.readOperationCompletion(input.db, {
    operationId: row.source_operation_id,
  });
  const recovered = await control.readOperationRecovery(input.db, {
    operationId: row.source_operation_id,
  });
  if (completion === null || recovered === null) {
    throw new Error("engineering recovery source operation disappeared");
  }
  const descriptor = contextDescriptor(completion.descriptor, exactBinding.stage);
  assertDescriptor({ descriptor, binding: exactBinding, inputDigest: row.source_input_digest! });
  const expectedConfig =
    exactBinding.stage === EngineeringStage.GATE_EXECUTION
      ? input.gateExecutor?.configDigest
      : exactBinding.stage === EngineeringStage.LOCAL_COMMIT
        ? input.localCommitExecutor?.configDigest
        : input.stageConfigDigest(exactBinding.stage);
  const expectedSchema =
    exactBinding.stage === EngineeringStage.GATE_EXECUTION
      ? input.gateExecutor?.schemaDigest
      : exactBinding.stage === EngineeringStage.LOCAL_COMMIT
        ? input.localCommitExecutor?.schemaDigest
        : input.stageSchemaDigest(exactBinding.stage);
  if (
    expectedConfig === undefined ||
    expectedSchema === undefined ||
    row.source_config_digest !== expectedConfig ||
    row.source_schema_digest !== expectedSchema ||
    row.source_deadline_at?.getTime() !== row.workflow_deadline_at.getTime()
  ) {
    throw new Error("engineering recovery config, schema, or deadline changed");
  }
  const opPlan = operationPlan(input.lease, descriptor);
  const durableEvidence = canonicalDigest({
    operation_id: row.source_operation_id,
    started: recovered.started,
    artifact_digest: recovered.artifact?.payload_digest ?? null,
    completion_id: completion.completion?.completion_id ?? null,
    completion_outcome: completion.completion?.outcome ?? null,
  });

  if (recovered.artifact !== null) {
    const exactPlan = plan({
      lease: input.lease,
      classification: "REPAIR_ARTIFACT_COMPLETION",
      operation: opPlan,
      evidenceDigest: durableEvidence,
      budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    const bound = await recoveries.bindPlan(input.db, input.lease, exactPlan);
    await recoveries.repairStageDurability(input.db, input.lease, {
      planDigest: bound.planDigest,
      operationId: row.source_operation_id,
      artifactKey: recovered.artifact.artifact_key,
      artifact: recovered.artifact.payload,
    });
    return {
      status: "CONTINUATION_READY",
      ...bound,
      repairedArtifact: recovered.artifact.payload,
    };
  }
  if (completion.completion !== null) {
    const terminalPlan = plan({
      lease: input.lease,
      classification: "AMBIGUOUS",
      operation: opPlan,
      evidenceDigest: durableEvidence,
      budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    const bound = await recoveries.bindPlan(input.db, input.lease, terminalPlan);
    await recoveries.terminateRecovery(input.db, input.lease, bound.planDigest);
    return { status: "TERMINAL", ...bound, terminal: "AMBIGUOUS" };
  }

  if (row.source_effect_class === "MODEL_CALL" || row.source_effect_class === "READ_ONLY") {
    const context = await exactContext(input.readContext, exactBinding, descriptor);
    const retryModel = row.source_effect_class === "MODEL_CALL";
    const budget = await budgetReservation({
      db: input.db,
      runId: row.run_id,
      retryModel,
      context,
    });
    if (
      controlState.cancelled ||
      budget === null ||
      (input.now ?? Date.now)() >= row.workflow_deadline_at.getTime()
    ) {
      const classification = controlState.cancelled ? "CANCELLED" : "BLOCKED";
      const terminalPlan = plan({
        lease: input.lease,
        classification,
        operation: opPlan,
        evidenceDigest: durableEvidence,
        budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
      });
      const bound = await recoveries.bindPlan(input.db, input.lease, terminalPlan);
      await recoveries.terminateRecovery(input.db, input.lease, bound.planDigest);
      return { status: "TERMINAL", ...bound, terminal: classification };
    }
    const retryPlan = plan({
      lease: input.lease,
      classification: retryModel ? "RETRY_MODEL" : "RETRY_READ_ONLY",
      operation: opPlan,
      evidenceDigest: durableEvidence,
      budget,
    });
    const bound = await recoveries.bindPlan(input.db, input.lease, retryPlan);
    return { status: "RETRY_READY", ...bound, context };
  }

  if (recovered.started && exactBinding.stage === EngineeringStage.GATE_EXECUTION) {
    const executor = input.gateExecutor;
    if (executor === undefined) throw new Error("gate recovery executor is unavailable");
    const gateDescriptor = gateExecutionIntentDescriptor.parse(completion.descriptor);
    const gatePlan = plan({
      lease: input.lease,
      classification: "RECOVER_GATE_RECEIPTS",
      operation: opPlan,
      evidenceDigest: durableEvidence,
      budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    const bound = await recoveries.bindPlan(input.db, input.lease, gatePlan);
    const rows = await control.listRunArtifactRevisions(input.db, { runId: row.run_id });
    const result = await executor.recover({
      binding: exactBinding,
      contextManifestDigest: gateDescriptor.context_manifest_digest,
      orderedArtifacts: rows,
      decisionIds: gateDescriptor.decision_ids,
      deadlineAt: gateDescriptor.deadline_at,
      recoveryOnly: true,
      recoveryObserveCompletion: ({ operationId, completionId }) =>
        recoveries.repairOperationObservation(input.db, input.lease, {
          planDigest: bound.planDigest,
          operationId,
          completionId,
        }),
    });
    if (result.status === "AMBIGUOUS") {
      await recoveries.terminateRecovery(input.db, input.lease, {
        planDigest: bound.planDigest,
        terminal: "AMBIGUOUS",
      });
      return { status: "TERMINAL", ...bound, terminal: "AMBIGUOUS" };
    }
    const artifact = engineeringArtifact.parse(result.artifact);
    await recoveries.repairStageDurability(input.db, input.lease, {
      planDigest: bound.planDigest,
      operationId: row.source_operation_id,
      artifactKey: `${exactBinding.stage.toLowerCase()}:${exactBinding.attempt}`,
      artifact,
    });
    return { status: "CONTINUATION_READY", ...bound, repairedArtifact: artifact };
  }

  if (recovered.started && exactBinding.stage === EngineeringStage.LOCAL_COMMIT) {
    const executor = input.localCommitExecutor;
    if (executor === undefined) throw new Error("local commit recovery executor is unavailable");
    const descriptor = localCommitIntentDescriptor.parse(completion.descriptor);
    const commitPlan = plan({
      lease: input.lease,
      classification: "OBSERVE_LOCAL_COMMIT",
      operation: opPlan,
      evidenceDigest: durableEvidence,
      budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    const bound = await recoveries.bindPlan(input.db, input.lease, commitPlan);
    const artifact = await executor.recover({
      binding: exactBinding,
      descriptor: descriptor.commit,
    });
    if (artifact === null) {
      await recoveries.terminateRecovery(input.db, input.lease, {
        planDigest: bound.planDigest,
        terminal: "AMBIGUOUS",
      });
      return { status: "TERMINAL", ...bound, terminal: "AMBIGUOUS" };
    }
    await recoveries.repairStageDurability(input.db, input.lease, {
      planDigest: bound.planDigest,
      operationId: row.source_operation_id,
      artifactKey: `${exactBinding.stage.toLowerCase()}:${exactBinding.attempt}`,
      artifact,
    });
    return { status: "CONTINUATION_READY", ...bound, repairedArtifact: artifact };
  }

  const terminalPlan = plan({
    lease: input.lease,
    classification: "AMBIGUOUS",
    operation: opPlan,
    evidenceDigest: durableEvidence,
    budget: { stage_attempts: 0, model_calls: 0, input_tokens: 0, output_tokens: 0 },
  });
  const bound = await recoveries.bindPlan(input.db, input.lease, terminalPlan);
  await recoveries.terminateRecovery(input.db, input.lease, bound.planDigest);
  return { status: "TERMINAL", ...bound, terminal: "AMBIGUOUS" };
}

/**
 * Production scheduler lane. It owns only recovery classification and dedicated continuation
 * claim; the returned implementer lease still runs through the existing SupervisorRuntime.
 */
export function createProductionEngineeringRecoveryCoordinator(
  input: ProductionEngineeringRecoveryCoordinatorOptions,
): SchedulerContinuationLane {
  const recoveries = input.recoveries ?? new EngineeringRecoveryRepository(productionRuntime());
  const control = input.controlPlane ?? new EngineeringControlPlaneRepository(productionRuntime());
  const recoveryLeaseMs = input.recoveryLeaseMs ?? 120_000;
  const workflowDeadlineMs = input.workflowDeadlineMs ?? 15 * 60_000;

  const prepare = async (): Promise<void> => {
    await recoveries.reapExpiredRecovery(input.db);
    await recoveries.materializeExpired(input.db, { workflowDeadlineMs });
    const recoveryLease = await recoveries.claimRecovery(input.db, {
      owner: `${input.owner}:engineering-recovery`,
      leaseMs: recoveryLeaseMs,
    });
    if (recoveryLease === null) return;
    await recoveries.heartbeatRecovery(input.db, recoveryLease, recoveryLeaseMs);
    const source = await input.jobs.findById(input.db, recoveryLease.recovery.source_job_id);
    if (
      source === null ||
      source.status !== "RECONCILING" ||
      source.case_id !== recoveryLease.recovery.case_id ||
      source.job_type !== "agent.implementer"
    ) {
      throw new Error("engineering recovery source job is not exact RECONCILING implementer");
    }
    const observationLease: JobLease = Object.freeze({
      jobId: source.job_id,
      caseId: source.case_id,
      jobType: source.job_type,
      payload: source.payload,
      provider: source.provider,
      serializationKey: source.serialization_key,
      attempts: source.attempts,
      maxAttempts: source.max_attempts,
      fencingToken: recoveryLease.job.fencingToken,
      leaseExpiresAtMs: recoveryLease.job.leaseExpiresAtMs,
      leaseOwner: recoveryLease.job.leaseOwner,
    });
    const recoveryWriter = Object.freeze({
      caseId: recoveryLease.recovery.case_id,
      leaseOwner: recoveryLease.job.leaseOwner,
      fencingToken: recoveryLease.job.fencingToken,
      assertCurrent: () => recoveries.assertCurrentRecovery(input.db, recoveryLease),
    });
    const execution = createEngineeringExecution({
      db: input.db,
      jobs: input.jobs,
      lease: observationLease,
      config: input.config,
      transport: input.transport,
      modelConfig: input.modelConfig,
      taskBrief: "Recover exact durable engineering evidence without replaying an unknown effect.",
      createReviewerSession: input.createReviewerSession,
      recoveryWriter,
    });
    const result = await classifyEngineeringRecovery({
      db: input.db,
      lease: recoveryLease,
      readContext: input.readContext,
      writeDeploymentPolicy: input.config.writeDeploymentPolicy,
      stageConfigDigest: () => input.stageExecutor.configDigest,
      stageSchemaDigest: (stage) => input.stageExecutor.schemaDigest(stage),
      gateExecutor: execution.gateExecutor,
      localCommitExecutor: execution.localCommitExecutor,
      controlPlane: control,
      recoveries,
    });
    if (result.status === "TERMINAL") return;
    await recoveries.heartbeatRecovery(input.db, recoveryLease, recoveryLeaseMs);
    await recoveries.publishContinuation(input.db, recoveryLease, result.planDigest);
  };

  return Object.freeze({
    prepare,
    claim: async () =>
      (
        await recoveries.claimContinuation(input.db, {
          owner: input.owner,
          leaseMs: recoveryLeaseMs,
        })
      )?.job ?? null,
    suspend: async (lease: JobLease, error: string) => {
      await recoveries.expireFailedContinuation(input.db, lease, error);
      await recoveries.materializeExpired(input.db, { workflowDeadlineMs });
    },
  });
}
