import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import {
  engineeringArtifact,
  engineeringArtifactDigest,
  engineeringContextManifest,
  engineeringWriteAuthorizationScopeV2Digest,
  engineeringWriteDeploymentPolicyV1Digest,
  EngineeringStage,
  TrustLevel,
  canonicalDigest,
  type EngineeringArtifact,
  type WorkUnit,
} from "@remoteagent/contracts";
import { FakeTransport, createRuntimeConfig } from "@remoteagent/model-runtime";
import { subscriptionModelInvocationDescriptorV1 } from "@remoteagent/model-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  ApprovalRepository,
  EngineeringControlPlaneRepository,
  JobStore,
  OutboxRepository,
  OwnerRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { MetricName, MetricRegistry, StructuredLogger } from "@remoteagent/observability";
import { gitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";
import { evaluateEngineeringProgress } from "@remoteagent/agent-orchestrator";

import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import type { CompiledRoleContext } from "../src/context.js";
import {
  createStructuredEngineeringStageExecutor,
  createStructuredPreCommitReviewSessionFactory,
  assertEngineeringProgramDesignBlueprints,
  assertGateEvidenceAuthority,
  createPostgresEngineeringRuntimePort as createPostgresEngineeringRuntimePortProduction,
  engineeringApprovalCandidateFromLease,
  gateExecutionIntentDescriptor,
  type EngineeringStageExecutor,
  type EngineeringSliceImplementationStageExecutor,
  type EngineeringLocalCommitStageExecutor,
  type EngineeringGateStageExecutor,
} from "../src/engineering-workflow.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";
import {
  createEngineeringDebugTransport,
  EngineeringDebugJournal,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";

const available = await ensurePostgres();
const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
const runtime = productionRuntime();
const WRITE_POLICY = Object.freeze({
  schema_version: 1 as const,
  purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY" as const,
  repository_id: "repo-1",
  write_path_allowlist: Object.freeze(["apps/agent-worker/src"]),
});
const SLICE_PLANNING_CONSTRAINTS = Object.freeze({
  allowedPaths: WRITE_POLICY.write_path_allowlist,
  allowedTestPaths: WRITE_POLICY.write_path_allowlist,
  requiredGateIds: Object.freeze(["gate-1"]),
});
const createPostgresEngineeringRuntimePort = (
  input: Omit<
    Parameters<typeof createPostgresEngineeringRuntimePortProduction>[0],
    "writeDeploymentPolicy"
  >,
) =>
  createPostgresEngineeringRuntimePortProduction({
    ...input,
    executor:
      input.executor.slicePlanningConstraints === undefined
        ? Object.freeze({
            ...input.executor,
            slicePlanningConstraints: SLICE_PLANNING_CONSTRAINTS,
          })
        : input.executor,
    writeDeploymentPolicy: WRITE_POLICY,
  });
const smallRiskFacts = Object.freeze({
  authority: "SERVER_OWNED" as const,
  security_or_policy: false,
  migration: false,
  irreversible_side_effect: false,
  broad_public_contract_change: false,
  multi_module: false,
  new_architecture: false,
  deterministic_oracle: true,
  user_data: false,
  concurrency: false,
  external_side_effect: false,
});

function exactWriteScope(patch: Record<string, unknown> = {}) {
  const policyDigest = engineeringWriteDeploymentPolicyV1Digest(WRITE_POLICY);
  return {
    schema_version: 2 as const,
    purpose: "ENGINEERING_WORKFLOW_WRITE" as const,
    case_id: "case-1",
    owner_id: "owner-1",
    checkpoint_revision: 0,
    work_unit_id: "unit-1",
    run_id: "run-1",
    process_class: "LARGE_OR_HIGH_RISK" as const,
    authoritative_scope: {
      connection_ids: [] as string[],
      repo_allowlist: [WRITE_POLICY.repository_id],
      can_write_workspace: true as const,
    },
    repository_id: WRITE_POLICY.repository_id,
    write_path_allowlist: WRITE_POLICY.write_path_allowlist,
    deployment_policy_digest: policyDigest,
    ...patch,
  };
}

async function materializeGrantedProposal(
  db: Database,
  input: {
    proposalId: string;
    approvalId: string;
    jobId: string;
    actionDigest: string;
    scope?: ReturnType<typeof exactWriteScope>;
  },
): Promise<void> {
  const scope = input.scope ?? exactWriteScope();
  const approval = await db.query<{ expires_at: Date; granted_by: string }>(
    `SELECT expires_at, granted_by FROM approvals WHERE approval_id=$1`,
    [input.approvalId],
  );
  const row = approval.rows[0];
  if (row === undefined) throw new Error("approval fixture missing");
  await db.withTransaction(async (tx) => {
    const outbox = await new OutboxRepository(runtime).enqueue(tx, {
      aggregate: "discord_case",
      aggregateId: "case-1",
      eventType: "discord.thread_message",
      payload: { case_id: "case-1", seq: 1, body: "fixture" },
    });
    const seq = await tx.query<{ next: string }>(
      `SELECT (COALESCE(max(discord_seq),0)+1)::text AS next
         FROM engineering_write_proposals WHERE case_id='case-1'`,
    );
    const triggerId = `fixture:propose:${input.proposalId}`;
    const grantId = `fixture:grant:${input.proposalId}`;
    await tx.query(
      `INSERT INTO engineering_ingress_interactions (
         interaction_id,case_id,owner_id,proposal_id,checkpoint_revision,interaction_kind)
       VALUES ($1,'case-1','owner-1',$3,0,'PROPOSE'),
              ($2,'case-1','owner-1',$3,0,'GRANT')`,
      [triggerId, grantId, input.proposalId],
    );
    await tx.query(
      `INSERT INTO engineering_write_proposals (
         proposal_id,trigger_interaction_id,case_id,owner_id,checkpoint_revision,
         work_unit_id,run_id,process_class,objective,repository_id,write_path_allowlist,
         authoritative_scope,deployment_policy_digest,action_digest,expires_at,status,
         terminal_interaction_id,terminal_choice,terminal_actor_id,approval_id,job_id,
         discord_outbox_id,discord_seq,terminal_at)
       VALUES ($1,$2,'case-1','owner-1',0,'unit-1','run-1',$3,'fixture',$4,$5::jsonb,$6::jsonb,
               $7,$8,$9,'GRANTED',$10,'GRANT',$11,$12,$13,$14,$15,now())`,
      [
        input.proposalId,
        triggerId,
        scope.process_class,
        scope.repository_id,
        JSON.stringify(scope.write_path_allowlist),
        JSON.stringify(scope.authoritative_scope),
        scope.deployment_policy_digest,
        input.actionDigest,
        row.expires_at.toISOString(),
        grantId,
        row.granted_by,
        input.approvalId,
        input.jobId,
        outbox.outbox_id,
        seq.rows[0]!.next,
      ],
    );
  });
}

function manifest(stage: EngineeringStage, revision = 0) {
  const value = engineeringContextManifest.parse({
    schema_version: 1,
    artifact_kind: "ContextManifest",
    case_id: "case-1",
    run_id: "run-1",
    revision,
    authority: "SERVER_OWNED",
    sources: [
      {
        source_id: `source-${stage}`,
        kind: "RAW_EVIDENCE",
        ref: `source-${stage}`,
        revision: 0,
        observed_at: "2026-08-26T00:00:00.000Z",
        digest: sha("a"),
        trust: TrustLevel.UNTRUSTED_DATA,
        freshness: "pinned to run",
        inclusion_reason: "stage policy",
        byte_budget: 64,
        full_artifact_ref: `source-${stage}`,
      },
    ],
    total_byte_budget: 1024,
  });
  return {
    packet: `packet for ${stage}`,
    packetBytes: 32,
    estimatedInputTokens: 8,
    cacheState: "NOT_OBSERVED",
    snapshotDigest: canonicalDigest({ stage, revision }),
    compiled: { stage, manifest: value } as CompiledRoleContext["compiled"],
  } as CompiledRoleContext;
}

function modelArtifact(stage: EngineeringStage): EngineeringArtifact {
  const common = { schema_version: 1, case_id: "case-1", run_id: "run-1", revision: 0 };
  switch (stage) {
    case EngineeringStage.OUTCOME_DEFINITION:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "OutcomeContract",
        problem: "bounded problem",
        outcome: "verified outcome",
        non_goals: [],
        objective: "bounded engineering workflow",
        success_criteria: ["all gates pass"],
        constraints: ["no workspace writes in RA-041"],
        process_class: "LARGE_OR_HIGH_RISK",
        source_digest: sha("7"),
      });
    case EngineeringStage.SYSTEM_DESIGN:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "SystemDesign",
        boundaries: ["worker to durable control plane"],
        data: ["strict stage artifacts"],
        api: ["single-stage port"],
        integrations: ["PostgreSQL"],
        invariants: ["SupervisorRuntime is the sole driver"],
        architecture: "one runtime with a durable stage port",
        components: ["SupervisorRuntime", "EngineeringRuntimePort"],
        interfaces: ["recover, prepare, start, invoke-and-record"],
        data_flow: "context to stage to durable artifact",
        risks: [],
        source_digest: sha("7"),
      });
    case EngineeringStage.PROGRAM_DESIGN:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "ProgramDesign",
        call_flow: ["handler -> runtime -> port"],
        file_tree_delta: ["apps/agent-worker/src/engineering-workflow.ts"],
        key_types_and_signatures: ["EngineeringRuntimePort.open(): session"],
        uncertainty_review: ["none"],
        expected_tests: ["real PG workflow"],
        slice_order: ["slice-1"],
        source_digest: sha("7"),
      });
    case EngineeringStage.DESIGN_APPROVAL:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "DesignDecision",
        decision_id: "design-review-1",
        rationale: "all required designs are durable",
        decision: "APPROVE",
        artifact_digest: sha("8"),
        findings: [],
        required_changes: [],
      });
    case EngineeringStage.SLICE_PLANNING:
      return engineeringArtifact.parse({
        ...common,
        schema_version: 2,
        artifact_kind: "SliceContract",
        slice_id: "slice-1",
        objective: "bounded slice",
        observable_result: "one observable result",
        allowed_paths: ["apps/agent-worker/src"],
        test_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
        gate_ids: ["gate-1"],
        inspection_method: "inspect the durable receipt",
        stop_condition: "receipt is confirmed",
      });
    case EngineeringStage.SLICE_REVIEW:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "ReviewDecision",
        decision_id: "review-1",
        rationale: "evidence is sufficient",
        decision: "PASS",
        findings: [],
        reviewed_digest: sha("b"),
      });
    case EngineeringStage.MEMORY_PROJECTION:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "MemoryUpdate",
        source_watermark: sha("c"),
        evidence_digests: [sha("d")],
        trust: TrustLevel.UNTRUSTED_DATA,
        authority: "MODEL_PROJECTION",
        completed_requirements: ["requirement-1"],
        open_issues: [],
      });
    case EngineeringStage.FINAL_VERIFICATION:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "verification-1",
        rationale: "all evidence is confirmed",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "criterion-1", status: "PASSED", evidence_digest: sha("d") },
        ],
        evidence_digest: sha("d"),
      });
    default:
      throw new Error(`unexpected model stage ${stage}`);
  }
}

function currentProgramDesignArtifact(input: {
  count: number;
  gateId?: string;
  gateIdsByIndex?: readonly (readonly string[])[];
  allowedPath?: string;
  testPath?: string;
}): EngineeringArtifact {
  const legacy = modelArtifact(EngineeringStage.PROGRAM_DESIGN);
  if (legacy.artifact_kind !== "ProgramDesign") throw new Error("program fixture mismatch");
  const allowedPath = input.allowedPath ?? "apps/agent-worker/src";
  const blueprints = Array.from({ length: input.count }, (_, index) => ({
    slice_id: `slice-${index + 1}`,
    objective: `bounded result ${index + 1}`,
    observable_result: `result ${index + 1} is observable`,
    allowed_paths: [allowedPath],
    test_paths: [input.testPath ?? `${allowedPath}/engineering-workflow.ts`],
    gate_ids: input.gateIdsByIndex?.[index] ?? [input.gateId ?? "gate-1"],
    inspection_method: `inspect evidence ${index + 1}`,
    stop_condition: `review ${index + 1} passes`,
  }));
  return engineeringArtifact.parse({
    ...legacy,
    schema_version: 2,
    slice_order: blueprints.map((blueprint) => blueprint.slice_id),
    slice_blueprints: blueprints,
  });
}

function systemArtifact(stage: EngineeringStage, attempt = 1): EngineeringArtifact {
  const common = { schema_version: 1, case_id: "case-1", run_id: "run-1", revision: 0 };
  if (stage === EngineeringStage.GATE_EXECUTION) {
    return engineeringArtifact.parse({
      ...common,
      artifact_kind: "EvidenceBundle",
      authority: "SERVER_OWNED",
      tree_digest: sha("e"),
      config_digests: [sha("f")],
      command_receipts: ["receipt-1"],
      diff_digest: sha("1"),
      review_findings: [],
      decisions: [],
      items: [
        {
          kind: "no-write-test",
          digest: sha("2"),
          summary: "fake gate",
          trust: TrustLevel.TRUSTED,
        },
      ],
      context_digest: sha("3"),
      test_first_evidence: [],
    });
  }
  if (stage === EngineeringStage.LOCAL_COMMIT) {
    return engineeringArtifact.parse({
      ...common,
      artifact_kind: "LocalCommitReceipt",
      authority: "SERVER_OWNED",
      receipt_id: "commit-receipt-1",
      branch: "remoteagent/case-1",
      commit_sha: "a".repeat(40),
      parent_sha: "b".repeat(40),
      tree_digest: sha("e"),
      diff_digest: sha("1"),
      evidence_digest: sha("2"),
      review_digest: sha("2-review"),
      verification_decision_digest: sha("3"),
    });
  }
  if (stage === EngineeringStage.SLICE_IMPLEMENTATION) {
    return engineeringArtifact.parse({
      ...common,
      artifact_kind: "SliceImplementationReceipt",
      authority: "SERVER_OWNED",
      receipt_id: `implementation-${String(attempt)}`,
      work_unit_id: "unit-1",
      slice_id: "slice-1",
      attempt,
      workspace_id: "engineering-workspace-1",
      repository_id: "repo-1",
      base_sha: "b".repeat(40),
      branch: "remoteagent/case-1",
      baseline: {
        baseline_id: `slice-baseline-${"a".repeat(64)}`,
        tree_digest: sha("9"),
      },
      tree_digest: sha("e"),
      diff_digest: sha("1"),
      raw_patch_digest: sha("b"),
      changed_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
      cumulative_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
      files_changed: 1,
      insertions: 1,
      deletions: 0,
      tool_receipt_digests: [sha("a")],
    });
  }
  return engineeringArtifact.parse({
    ...common,
    artifact_kind: "EngineeringPhase",
    stage,
    process_class: "SMALL",
    checkpoint_revision: 0,
    stage_attempt: attempt,
    active_slice_id: "slice-1",
    context_manifest_digest: sha("4"),
    artifact_digests: [],
  });
}

function fakeImplementationExecutor(): EngineeringSliceImplementationStageExecutor {
  return {
    configDigest: sha("4"),
    schemaDigest: sha("5"),
    execute: async ({ binding }) => ({
      kind: "ARTIFACT",
      artifact: systemArtifact(binding.stage, binding.attempt),
      modelCalls: 1,
    }),
  };
}

function fakeLocalCommitExecutor(): EngineeringLocalCommitStageExecutor {
  return {
    configDigest: sha("5"),
    schemaDigest: sha("6"),
    prepare: async ({ binding, operationId, provenance }) => {
      const accepted = provenance.accepted.map((pair) => ({
        slice_id: pair.sliceId,
        attempt: pair.attempt,
        evidence_digest: pair.evidenceDigest,
        review_digest: pair.reviewDigest,
      }));
      return gitEvidenceBoundCommitDescriptor.parse({
        schema_version: 1,
        operation_id: operationId,
        case_id: binding.caseId,
        work_unit_id: binding.workUnitId,
        workspace_id: "engineering-workspace-1",
        repository_id: "repo-1",
        run_id: binding.runId,
        checkpoint_revision: binding.checkpointRevision,
        branch_name: "remoteagent/case-1",
        expected_parent_sha: "b".repeat(40),
        exact_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
        message: `verified workflow\n\n[remoteagent-operation:${operationId}]`,
        operation_marker: `[remoteagent-operation:${operationId}]`,
        tree_digest: provenance.finalTreeDigest,
        actual_diff_digest: provenance.finalActualDiffDigest,
        raw_patch_digest: provenance.finalRawPatchDigest,
        accepted,
        evidence_digest: canonicalDigest(accepted.map((pair) => pair.evidence_digest)),
        review_digest: canonicalDigest(accepted.map((pair) => pair.review_digest)),
        final_verification_digest: provenance.finalVerificationDigest,
      });
    },
    execute: async ({ binding, descriptor }) =>
      engineeringArtifact.parse({
        schema_version: 1,
        artifact_kind: "LocalCommitReceipt",
        case_id: binding.caseId,
        run_id: binding.runId,
        revision: binding.checkpointRevision,
        authority: "SERVER_OWNED",
        receipt_id: "commit-receipt-1",
        branch: descriptor.branch_name,
        commit_sha: "a".repeat(40),
        parent_sha: descriptor.expected_parent_sha,
        tree_digest: descriptor.tree_digest,
        diff_digest: descriptor.actual_diff_digest,
        evidence_digest: descriptor.evidence_digest,
        review_digest: descriptor.review_digest,
        verification_decision_digest: descriptor.final_verification_digest,
      }),
    recover: async () => null,
  };
}

it("binds GateFailure correction evidence to the immutable gate context and decisions", () => {
  const context = manifest(EngineeringStage.GATE_EXECUTION);
  const contextDigest = engineeringArtifactDigest(context.compiled.manifest);
  const descriptor = gateExecutionIntentDescriptor.parse({
    case_id: "case-1",
    work_unit_id: "unit-1",
    run_id: "run-1",
    checkpoint_revision: 0,
    stage: EngineeringStage.GATE_EXECUTION,
    attempt: 2,
    process_class: "SMALL",
    context_snapshot_digest: context.snapshotDigest,
    context_manifest: context.compiled.manifest,
    context_manifest_digest: contextDigest,
    context_packet_digest: sha("6"),
    decision_authority: "DURABLE_VERIFIED_ANSWERS",
    decision_ids: ["decision-1"],
    deadline_at: "2026-08-27T12:00:00.000Z",
  });
  const artifact = engineeringArtifact.parse({
    schema_version: 1,
    artifact_kind: "GateFailure",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    authority: "SERVER_OWNED",
    slice_id: "slice-1",
    attempt: 2,
    tree_digest: sha("1"),
    diff_digest: sha("2"),
    context_digest: contextDigest,
    config_digest: sha("3"),
    blocking_gate_ids: ["xcode-full"],
    receipt_ids: ["receipt-xcode"],
    decision_ids: ["decision-1"],
    diagnostics: [
      {
        gate_id: "xcode-full",
        outcome: "FAILED",
        log_digest: sha("4"),
        trust: TrustLevel.UNTRUSTED_DATA,
        excerpt: "error: cannot find Bundle in scope",
      },
    ],
  });

  expect(() => assertGateEvidenceAuthority({ artifact, descriptor })).not.toThrow();
  expect(() =>
    assertGateEvidenceAuthority({
      artifact: { ...artifact, decision_ids: ["foreign-decision"] } as EngineeringArtifact,
      descriptor,
    }),
  ).toThrow(/immutable intent authority/);
  expect(() =>
    assertGateEvidenceAuthority({
      artifact: { ...artifact, context_digest: sha("0") } as EngineeringArtifact,
      descriptor,
    }),
  ).toThrow(/immutable intent authority/);
});

function runtimeIdentity() {
  const workUnit: WorkUnit = {
    schema_version: 1,
    work_unit_id: "unit-1",
    case_id: "case-1",
    role: "IMPLEMENTER",
    status: "DISPATCHED",
    objective: "bounded engineering workflow",
    authoritative_scope: {
      connection_ids: [],
      repo_allowlist: ["repo-1"],
      can_write_workspace: true,
    },
    run_id: "run-1",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
  return {
    unit: { workUnit },
    run: { runId: "run-1", checkpointRevision: 0 },
  } as const;
}

it("extracts only a bounded engineering approval identity from the lease", () => {
  const baseLease = {
    jobId: "job-1",
    caseId: "case-1",
    jobType: "agent.implementer",
    payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
    provider: null,
    serializationKey: "case-1",
    attempts: 0,
    maxAttempts: 3,
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 30_000,
    leaseOwner: "worker-1",
  } as const;
  expect(engineeringApprovalCandidateFromLease(baseLease)).toBeUndefined();
  expect(
    engineeringApprovalCandidateFromLease({
      ...baseLease,
      payload: {
        ...baseLease.payload,
        reason: "decision_answer",
        decisionId: "decision-1",
        checkpointRevision: 4,
      },
    }),
  ).toBeUndefined();
  expect(
    engineeringApprovalCandidateFromLease({
      ...baseLease,
      payload: {
        ...baseLease.payload,
        reason: "engineering_approval",
        proposalId: "proposal-1",
        approvalId: "approval-1",
        checkpointRevision: 4,
        actionDigest: sha("0"),
        authoritativeScope: { repo_allowlist: ["foreign"] },
      },
    }),
  ).toEqual({
    proposalId: "proposal-1",
    approvalId: "approval-1",
    checkpointRevision: 4,
  });
  expect(() =>
    engineeringApprovalCandidateFromLease({
      ...baseLease,
      payload: {
        ...baseLease.payload,
        reason: "engineering_approval",
        approvalId: "approval-1",
        checkpointRevision: 4,
      },
    }),
  ).toThrow(/approval binding/);
});

describeIntegration(
  "worker EngineeringRuntimePort",
  () => {
    let db: Database;
    let drop: () => Promise<void>;

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',0,$1::jsonb)",
        [JSON.stringify(makeCheckpoint("case-1", 0))],
      );
      const units = new WorkUnitRepository();
      await units.insert(db, {
        workUnitId: "unit-1",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "bounded engineering workflow",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: ["repo-1"],
          can_write_workspace: true,
        },
      });
      await units.claim(db, { workUnitId: "unit-1", runId: "run-1", checkpointRevision: 0 });
    });

    afterEach(async () => drop());

    async function durableReviewProgress(
      mode: "NO_PROGRESS" | "OSCILLATION",
    ): Promise<ReturnType<typeof evaluateEngineeringProgress>> {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected qualification lease");
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          modelCalls: 1,
          artifact:
            binding.stage === EngineeringStage.SLICE_REVIEW
              ? engineeringArtifact.parse({
                  ...modelArtifact(binding.stage),
                  decision: "CHANGES_REQUIRED",
                  findings: ["[precommit-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] stable finding"],
                })
              : modelArtifact(binding.stage),
        }),
      };
      const options = {
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        implementationExecutor: fakeImplementationExecutor(),
        executeSystemStage: async ({ binding }: { binding: { attempt: number } }) =>
          engineeringArtifact.parse({
            ...systemArtifact(EngineeringStage.GATE_EXECUTION, binding.attempt),
            tree_digest: mode === "NO_PROGRESS" || binding.attempt % 2 === 1 ? sha("a") : sha("b"),
          }),
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED" as const,
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      };
      const port = createPostgresEngineeringRuntimePort(options);
      await port.open(runtimeIdentity());
      const invoke = async (stage: EngineeringStage, attempt: number) => {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt,
        } as const;
        const context = await port.prepareContext(binding);
        await port.commitStarted(binding);
        await port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: stage === EngineeringStage.SLICE_IMPLEMENTATION ? "IMPLEMENTER" : "REVIEWER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access:
              stage === EngineeringStage.SLICE_IMPLEMENTATION ? "WRITE" : "READ_ONLY",
          },
        });
      };
      await invoke(EngineeringStage.SLICE_PLANNING, 1);
      const attempts = mode === "NO_PROGRESS" ? 5 : 6;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        await invoke(EngineeringStage.SLICE_IMPLEMENTATION, attempt);
        await invoke(EngineeringStage.GATE_EXECUTION, attempt);
        await invoke(EngineeringStage.SLICE_REVIEW, attempt);
      }
      const resumed = createPostgresEngineeringRuntimePort(options);
      const session = await resumed.open(runtimeIdentity());
      expect(session.fingerprints).toHaveLength(attempts);
      return evaluateEngineeringProgress({
        ...session,
        nowMs: session.deadlineMs - 1,
      });
    }

    it("refuses an exhausted implementation budget before binding a mutating STARTED operation", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected qualification lease");
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async ({ binding }) => ({
            kind: "ARTIFACT",
            artifact: modelArtifact(binding.stage),
            modelCalls: 1,
          }),
        },
        implementationExecutor: fakeImplementationExecutor(),
        policy: { riskFacts: smallRiskFacts },
      });
      const root = await mkdtemp(join(tmpdir(), "ra048-pre-start-budget-"));
      const journal = await EngineeringDebugJournal.create({
        artifactRoot: root,
        invocationId: "pre-start-budget",
      });
      const transport = createEngineeringDebugTransport({
        async converse(_request, config) {
          return {
            model: config.model,
            usage: { inputTokens: 565_999, outputTokens: 1, totalTokens: 566_000 },
            content: [],
          };
        },
      });
      const config = {
        model: { provider: "qualification_fake", model_id: "model" },
        timeoutMs: 1_000,
        toolLimits: { maxIterations: 1, maxCalls: 1 },
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      } as const;
      try {
        await runWithEngineeringDebugJournal(journal, async () => {
          await transport.converse({ messages: [] }, config);
          await port.open(runtimeIdentity());
          await expect(
            port.prepareContext({
              caseId: "case-1",
              workUnitId: "unit-1",
              runId: "run-1",
              checkpointRevision: 0,
              stage: EngineeringStage.SLICE_IMPLEMENTATION,
              attempt: 1,
            }),
          ).rejects.toThrow(/reserve would exceed/);
        });
        const operations = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM engineering_operations WHERE run_id='run-1' AND stage='SLICE_IMPLEMENTATION'",
        );
        expect(operations.rows[0]?.count).toBe("0");
        await journal.close();
        expect(await readFile(journal.filePath, "utf8")).toContain(
          '"decision_code":"MODEL_CALL_REFUSED_BUDGET"',
        );
      } finally {
        await journal.close().catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });

    it("runs the production handler through PG intent/STARTED/artifact boundaries", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const calls: EngineeringStage[] = [];
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => {
          calls.push(binding.stage);
          return { kind: "ARTIFACT", artifact: modelArtifact(binding.stage), modelCalls: 1 };
        },
      };
      const persistence = new WorkerPersistence(db, runtime);
      const metrics = new MetricRegistry();
      const handler = createWorkerHandlers({
        persistence,
        roles: {},
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
        db,
        jobs,
        engineering: (writerLease) =>
          createPostgresEngineeringRuntimePort({
            db,
            lease: writerLease,
            jobs,
            readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
            executor,
            reviewExecutor: executor,
            implementationExecutor: fakeImplementationExecutor(),
            localCommitExecutor: fakeLocalCommitExecutor(),
            metrics,
            executeSystemStage: async ({ binding }) =>
              systemArtifact(binding.stage, binding.attempt),
            policy: {
              riskFacts: {
                authority: "SERVER_OWNED",
                security_or_policy: false,
                migration: false,
                irreversible_side_effect: false,
                broad_public_contract_change: false,
                multi_module: false,
                new_architecture: false,
                deterministic_oracle: true,
                user_data: false,
                concurrency: false,
                external_side_effect: false,
              },
            },
          }),
      })["agent.implementer"]!;

      await handler(lease!, async () => undefined);
      expect(calls).toEqual([
        EngineeringStage.SLICE_PLANNING,
        EngineeringStage.SLICE_REVIEW,
        EngineeringStage.MEMORY_PROJECTION,
        EngineeringStage.FINAL_VERIFICATION,
      ]);
      expect((await db.query("SELECT 1 FROM run_completions")).rows).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rows).toHaveLength(8);
      expect((await db.query("SELECT 1 FROM engineering_artifact_revisions")).rows).toHaveLength(8);
      expect(
        (
          await db.query<{ event_type: string }>(
            "SELECT event_type FROM engineering_stage_events ORDER BY event_sequence",
          )
        ).rows.filter((row) => row.event_type === "STARTED"),
      ).toHaveLength(8);
      expect(metrics.counter(MetricName.ENGINEERING_STAGE_TRANSITIONS)).toBe(16);
      expect(metrics.counter(MetricName.ENGINEERING_TERMINALS)).toBe(1);
      const telemetry = JSON.stringify(metrics.snapshot().counters);
      expect(telemetry).not.toMatch(/case-1|owner-1|unit-1|run-1|packet for/u);
      expect(
        metrics
          .snapshot()
          .counters.every((sample) =>
            Object.keys(sample.labels).every((key) => key === "kind" || key === "outcome"),
          ),
      ).toBe(true);
    });

    it.each(["NO_PROGRESS", "OSCILLATION"] as const)(
      "derives %s from production ordered review artifacts",
      async (expected) => {
        expect(await durableReviewProgress(expected)).toBe(expected);
      },
    );

    it("recovers a durable stage artifact without context or executor replay", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      let contextReads = 0;
      let executorCalls = 0;
      const runCreated = await db.query<{ created_at: Date }>(
        "SELECT created_at FROM agent_runs WHERE run_id='run-1'",
      );
      const expectedDeadline = runCreated.rows[0]!.created_at.getTime() + 5_000;
      const options = {
        db,
        lease: lease!,
        jobs,
        workflowDeadlineMs: 5_000,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => {
          contextReads += 1;
          return manifest(stage);
        },
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            executorCalls += 1;
            throw new Error("discovery must be assembled by server code");
          },
        } satisfies EngineeringStageExecutor,
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED" as const,
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      };
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.DISCOVERY,
        attempt: 1,
      } as const;
      const first = createPostgresEngineeringRuntimePort(options);
      const firstSession = await first.open(runtimeIdentity());
      expect(firstSession).toMatchObject({
        stageCalls: 0,
        modelCalls: 0,
        deadlineMs: expectedDeadline,
      });
      expect(await first.recoverStage(binding)).toEqual({ status: "NOT_STARTED" });
      const context = await first.prepareContext(binding);
      await first.commitStarted(binding);
      expect(
        await first.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "PLANNER",
            input_artifacts: ["EngineeringContextManifest"],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).toMatchObject({ status: "COMPLETED" });
      expect(contextReads).toBe(1);
      expect(executorCalls).toBe(0);

      const recovered = createPostgresEngineeringRuntimePort(options);
      const recoveredSession = await recovered.open(runtimeIdentity());
      expect(recoveredSession).toMatchObject({
        stageCalls: 1,
        modelCalls: 0,
        deadlineMs: expectedDeadline,
      });
      expect(await recovered.recoverStage(binding)).toMatchObject({ status: "RECOVERED" });
      expect(recoveredSession.fingerprints).toHaveLength(0);
      expect(contextReads).toBe(1);
      expect(executorCalls).toBe(0);
    });

    it("replays a retry-safe STARTED model intent without recording a second STARTED", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected qualification lease");
      let modelCalls = 0;
      const modelInvocation = subscriptionModelInvocationDescriptorV1.parse({
        schema_version: 1,
        role: "DESIGNER",
        provider: "codex_cli",
        profile_name: "codex-local",
        client_version: "1.2.3",
        model: "gpt-5.6-codex",
        executable_digest: sha("1"),
        deployment_config_digest: sha("2"),
        profile_config_digest: sha("3"),
      });
      let preflightCalls = 0;
      const options = {
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          configDigestForStage: () => sha("7"),
          schemaDigest: () => sha("6"),
          modelInvocation: () => modelInvocation,
          execute: async ({ binding }) => {
            modelCalls += 1;
            return {
              kind: "ARTIFACT" as const,
              artifact: modelArtifact(binding.stage),
              modelCalls: 1,
            };
          },
        } satisfies EngineeringStageExecutor,
        modelPreflight: async (input: { invocation: typeof modelInvocation }) => {
          preflightCalls += 1;
          expect(input.invocation).toEqual(modelInvocation);
          if (preflightCalls === 1) {
            const operations = await db.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM engineering_operations WHERE run_id='run-1'`,
            );
            expect(operations.rows[0]?.count).toBe("0");
          }
        },
        policy: { riskFacts: smallRiskFacts },
      };
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_PLANNING,
        attempt: 1,
      } as const;
      const refused = createPostgresEngineeringRuntimePort({
        ...options,
        modelPreflight: async () => {
          throw new Error("subscription auth refused");
        },
      });
      await refused.open(runtimeIdentity());
      await expect(refused.prepareContext(binding)).rejects.toThrow(/subscription auth refused/u);
      expect(
        (
          await db.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM engineering_operations WHERE run_id='run-1'`,
          )
        ).rows[0]?.count,
      ).toBe("0");
      const crashed = createPostgresEngineeringRuntimePort(options);
      await crashed.open(runtimeIdentity());
      await crashed.prepareContext(binding);
      expect(preflightCalls).toBe(1);
      const intent = await db.query<{
        descriptor: Record<string, unknown>;
        config_digest: string;
      }>(
        `SELECT i.descriptor,o.config_digest
           FROM engineering_operations o
           JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id='run-1' AND o.stage='SLICE_PLANNING' AND o.stage_attempt=1`,
      );
      expect(intent.rows[0]!.descriptor.model_invocation).toEqual(modelInvocation);
      expect(intent.rows[0]!.config_digest).toBe(sha("7"));
      const intentOnly = createPostgresEngineeringRuntimePort(options);
      await intentOnly.open(runtimeIdentity());
      expect(await intentOnly.recoverStage(binding)).toEqual({ status: "NOT_STARTED" });
      expect(modelCalls).toBe(0);
      await crashed.commitStarted(binding);
      const changedProvider = createPostgresEngineeringRuntimePort({
        ...options,
        executor: {
          ...options.executor,
          modelInvocation: () => ({ ...modelInvocation, model: "gpt-5.7-codex" }),
        },
      });
      await changedProvider.open(runtimeIdentity());
      await expect(changedProvider.recoverStage(binding)).rejects.toThrow(
        /provider\/profile binding mismatch/u,
      );
      const resumed = createPostgresEngineeringRuntimePort(options);
      await resumed.open(runtimeIdentity());
      expect(await resumed.recoverStage(binding)).toEqual({ status: "NOT_STARTED" });
      const context = await resumed.prepareContext(binding);
      await resumed.commitStarted(binding);
      await expect(
        resumed.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "PRODUCT_MANAGER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED" });
      expect(modelCalls).toBe(1);
      const starts = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM engineering_stage_events WHERE run_id='run-1' AND stage='SLICE_PLANNING' AND event_type='STARTED'",
      );
      expect(starts.rows[0]!.count).toBe("1");
    });

    it("recovers a STARTED gate through its dedicated hook using only immutable intent authority", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected qualification lease");
      await db.query(
        `INSERT INTO decisions (
           decision_id, case_id, question, why_now, options, recommendation,
           blocked_scope, checkpoint_revision)
         VALUES ('gate-recovery-decision','case-1','Proceed?','Before gate recovery',
                 '[{"id":"grant","label":"Grant","consequences":"Proceed"}]'::jsonb,
                 'grant','gate recovery',0);
         INSERT INTO decision_answers (
           answer_id, decision_id, case_id, checkpoint_revision, selected_option_id,
           answered_by, answered_at)
         VALUES ('gate-recovery-answer','gate-recovery-decision','case-1',0,'grant','owner-1',now())`,
      );
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.GATE_EXECUTION,
        attempt: 1,
      } as const;
      let normalCalls = 0;
      let recoverCalls = 0;
      let recoveredDigest = "";
      let recoveredDeadline = "";
      let foreignAuthority = false;
      let contextReads = 0;
      const gateExecutor: EngineeringGateStageExecutor = {
        configDigest: sha("3"),
        schemaDigest: sha("4"),
        execute: async () => {
          normalCalls += 1;
          return systemArtifact(EngineeringStage.GATE_EXECUTION);
        },
        recover: async ({ contextManifestDigest, decisionIds, deadlineAt }) => {
          recoverCalls += 1;
          recoveredDigest = contextManifestDigest;
          recoveredDeadline = deadlineAt;
          expect(decisionIds).toEqual(["gate-recovery-decision"]);
          return {
            status: "RECOVERED",
            artifact: engineeringArtifact.parse({
              ...systemArtifact(EngineeringStage.GATE_EXECUTION),
              context_digest: foreignAuthority ? sha("0") : contextManifestDigest,
              decisions: foreignAuthority ? ["foreign-decision"] : [...decisionIds],
            }),
          };
        },
      };
      const options = {
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => {
          contextReads += 1;
          return manifest(stage);
        },
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            throw new Error("generic executor must not replay GATE_EXECUTION");
          },
        } satisfies EngineeringStageExecutor,
        gateExecutor,
        policy: {
          riskFacts: smallRiskFacts,
          ownerEscalation: {
            authority: "OWNER_DECISION" as const,
            decisionId: "gate-recovery-decision",
            checkpointRevision: 0,
            processClass: "SMALL" as const,
          },
        },
      };
      const first = createPostgresEngineeringRuntimePort(options);
      await first.open(runtimeIdentity());
      const context = await first.prepareContext(binding);
      await first.commitStarted(binding);
      const descriptorRow = await db.query<{
        descriptor: Record<string, unknown>;
        input_digest: string;
        deadline_at: Date;
      }>(
        `SELECT i.descriptor, o.input_digest, o.deadline_at
           FROM engineering_operations o JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id='run-1' AND o.stage='GATE_EXECUTION'`,
      );
      expect(descriptorRow.rows[0]!.descriptor).toMatchObject({
        decision_authority: "DURABLE_VERIFIED_ANSWERS",
        decision_ids: ["gate-recovery-decision"],
        deadline_at: descriptorRow.rows[0]!.deadline_at.toISOString(),
      });
      expect(descriptorRow.rows[0]!.input_digest).toBe(
        canonicalDigest(descriptorRow.rows[0]!.descriptor),
      );

      foreignAuthority = true;
      const rejected = createPostgresEngineeringRuntimePort(options);
      await rejected.open(runtimeIdentity());
      await expect(rejected.recoverStage(binding)).rejects.toThrow(/immutable intent authority/);
      foreignAuthority = false;
      const recovered = createPostgresEngineeringRuntimePort(options);
      await recovered.open(runtimeIdentity());
      expect(await recovered.recoverStage(binding)).toMatchObject({ status: "RECOVERED" });
      expect(normalCalls).toBe(0);
      expect(recoverCalls).toBe(2);
      expect(recoveredDigest).toBe(engineeringArtifactDigest(context.compiled.manifest));
      expect(recoveredDeadline).toBe(descriptorRow.rows[0]!.deadline_at.toISOString());
      expect(contextReads).toBe(1);
      const repaired = await db.query<{ completions: string; observations: string }>(
        `SELECT
           (SELECT count(*)::text FROM job_completions c
             JOIN engineering_operations o ON o.intent_id=c.intent_id AND o.job_id=c.job_id
            WHERE o.run_id='run-1' AND o.stage='GATE_EXECUTION') AS completions,
           (SELECT count(*)::text FROM engineering_stage_events
            WHERE run_id='run-1' AND stage='GATE_EXECUTION'
              AND event_type='COMPLETION_OBSERVED') AS observations`,
      );
      expect(repaired.rows[0]).toEqual({ completions: "1", observations: "1" });
    });

    it("does not recover a completion-only gate and never invokes the recovery hook", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected qualification lease");
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.GATE_EXECUTION,
        attempt: 1,
      } as const;
      let recoverCalls = 0;
      const gateExecutor: EngineeringGateStageExecutor = {
        configDigest: sha("3"),
        schemaDigest: sha("4"),
        execute: async () => systemArtifact(EngineeringStage.GATE_EXECUTION),
        recover: async () => {
          recoverCalls += 1;
          return { status: "AMBIGUOUS", detail: "must not be called" };
        },
      };
      const options = {
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            throw new Error("not expected");
          },
        } satisfies EngineeringStageExecutor,
        gateExecutor,
        policy: { riskFacts: smallRiskFacts },
      };
      const first = createPostgresEngineeringRuntimePort(options);
      await first.open(runtimeIdentity());
      await first.prepareContext(binding);
      const operation = await db.query<{ intent_id: string }>(
        "SELECT intent_id FROM engineering_operations WHERE run_id='run-1' AND stage='GATE_EXECUTION'",
      );
      await jobs.recordCompletion(db, {
        intentId: operation.rows[0]!.intent_id,
        jobId: lease.jobId,
        outcome: "SUCCEEDED",
        receipt: { durable: true },
        lease,
      });
      const recovered = createPostgresEngineeringRuntimePort(options);
      await recovered.open(runtimeIdentity());
      expect(await recovered.recoverStage(binding)).toMatchObject({ status: "AMBIGUOUS" });
      expect(recoverCalls).toBe(0);
    });

    it("reads durable run cancellation and blocks the next operation before STARTED", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async ({ binding }) => ({
            kind: "ARTIFACT",
            artifact: modelArtifact(binding.stage),
            modelCalls: 1,
          }),
        },
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED",
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      });
      await port.open(runtimeIdentity());
      const discovery = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.DISCOVERY,
        attempt: 1,
      } as const;
      const context = await port.prepareContext(discovery);
      await port.commitStarted(discovery);
      await port.invokeAndRecord({
        binding: discovery,
        context,
        definition: {
          role: "PLANNER",
          input_artifacts: ["EngineeringContextManifest"],
          output_artifacts: [],
          completion_contract: null,
          workspace_access: "READ_ONLY",
        },
      });
      const control = new EngineeringControlPlaneRepository(runtime);
      const projection = await control.prepareResume(db, { runId: "run-1" });
      await control.requestCancellation(db, {
        actionId: "cancel-between-stages",
        operationId: projection.operation_id,
        actorId: "owner-1",
        reason: "qualification cancellation",
        expectedProjectionDigest: projection.projection_digest,
      });
      await db.query("DELETE FROM engineering_run_projections WHERE run_id = 'run-1'");

      await expect(port.readControlState()).resolves.toEqual({ cancelled: true });
      const next = { ...discovery, stage: EngineeringStage.SLICE_PLANNING } as const;
      await port.prepareContext(next);
      await expect(port.commitStarted(next)).rejects.toThrow(/cancellation state/);
    });

    it("repairs artifact-only stage completion and runs recovered durable-review cleanup", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      let implementationCalls = 0;
      const cleanedStages: EngineeringStage[] = [];
      const implementationExecutor: EngineeringSliceImplementationStageExecutor = {
        configDigest: sha("4"),
        schemaDigest: sha("5"),
        execute: async ({ binding }) => {
          implementationCalls += 1;
          return {
            kind: "ARTIFACT",
            artifact: systemArtifact(binding.stage, binding.attempt),
            modelCalls: 1,
          };
        },
        afterDurableArtifact: async ({ binding }) => {
          cleanedStages.push(binding.stage);
        },
      };
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const options = {
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        implementationExecutor,
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED" as const,
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      };
      const control = new EngineeringControlPlaneRepository(runtime);
      const appendWithoutCompletion = async (
        binding: {
          readonly caseId: string;
          readonly workUnitId: string;
          readonly runId: string;
          readonly checkpointRevision: number;
          readonly stage: EngineeringStage;
          readonly attempt: number;
        },
        artifact: EngineeringArtifact,
      ) => {
        const first = createPostgresEngineeringRuntimePort(options);
        await first.open(runtimeIdentity());
        await first.prepareContext(binding);
        await first.commitStarted(binding);
        const operation = await db.query<{ operation_id: string }>(
          "SELECT operation_id FROM engineering_operations WHERE run_id=$1 AND stage=$2 AND stage_attempt=$3",
          [binding.runId, binding.stage, binding.attempt],
        );
        expect(operation.rows).toHaveLength(1);
        await control.appendArtifactRevision(db, lease!, {
          operationId: operation.rows[0]!.operation_id,
          artifactKey: `${binding.stage.toLowerCase()}:${String(binding.attempt)}`,
          artifact,
        });
      };

      const implementationBinding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_IMPLEMENTATION,
        attempt: 1,
      } as const;
      await appendWithoutCompletion(
        implementationBinding,
        systemArtifact(EngineeringStage.SLICE_IMPLEMENTATION, 1),
      );
      const staleRecovery = createPostgresEngineeringRuntimePort({
        ...options,
        lease: { ...lease!, fencingToken: lease!.fencingToken + 1 },
      });
      await staleRecovery.open(runtimeIdentity());
      await expect(staleRecovery.recoverStage(implementationBinding)).rejects.toThrow();
      const implementationRecovery = createPostgresEngineeringRuntimePort(options);
      await implementationRecovery.open(runtimeIdentity());
      expect(await implementationRecovery.recoverStage(implementationBinding)).toMatchObject({
        status: "RECOVERED",
      });
      expect(implementationCalls).toBe(0);

      const reviewBinding = {
        ...implementationBinding,
        stage: EngineeringStage.SLICE_REVIEW,
      } as const;
      await appendWithoutCompletion(reviewBinding, modelArtifact(EngineeringStage.SLICE_REVIEW));
      const reviewRecovery = createPostgresEngineeringRuntimePort(options);
      await reviewRecovery.open(runtimeIdentity());
      expect(await reviewRecovery.recoverStage(reviewBinding)).toMatchObject({
        status: "RECOVERED",
      });
      expect(cleanedStages).toEqual([EngineeringStage.SLICE_REVIEW]);

      const terminalBinding = {
        ...implementationBinding,
        stage: EngineeringStage.GATE_EXECUTION,
        attempt: 2,
      } as const;
      await appendWithoutCompletion(
        terminalBinding,
        engineeringArtifact.parse({
          schema_version: 1,
          artifact_kind: "TerminalReason",
          case_id: terminalBinding.caseId,
          run_id: terminalBinding.runId,
          revision: terminalBinding.checkpointRevision,
          reason: "BLOCKED",
          detail: "gate route unavailable before an implementation receipt existed",
        }),
      );
      const mismatchedTerminalRecovery = createPostgresEngineeringRuntimePort({
        ...options,
        gateExecutor: {
          configDigest: sha("3"),
          schemaDigest: sha("4"),
          execute: async () => systemArtifact(EngineeringStage.GATE_EXECUTION),
          recover: async () => ({
            status: "RECOVERED" as const,
            artifact: systemArtifact(EngineeringStage.GATE_EXECUTION),
          }),
        },
      });
      await mismatchedTerminalRecovery.open(runtimeIdentity());
      await expect(mismatchedTerminalRecovery.recoverStage(terminalBinding)).rejects.toThrow(
        /immutable recovery descriptor/,
      );
      const terminalRecovery = createPostgresEngineeringRuntimePort(options);
      await terminalRecovery.open(runtimeIdentity());
      expect(await terminalRecovery.recoverStage(terminalBinding)).toMatchObject({
        status: "RECOVERED",
      });
      expect(cleanedStages).toEqual([EngineeringStage.SLICE_REVIEW]);
      expect(implementationCalls).toBe(0);
      const repaired = await db.query<{ completions: string; observations: string }>(
        `SELECT
           (SELECT count(*)::text FROM job_completions c
             JOIN engineering_operations o ON o.intent_id=c.intent_id AND o.job_id=c.job_id
            WHERE o.run_id='run-1' AND o.stage IN ('SLICE_IMPLEMENTATION','SLICE_REVIEW','GATE_EXECUTION')) AS completions,
           (SELECT count(*)::text FROM engineering_stage_events
            WHERE run_id='run-1' AND stage IN ('SLICE_IMPLEMENTATION','SLICE_REVIEW','GATE_EXECUTION')
              AND event_type='COMPLETION_OBSERVED') AS observations`,
      );
      expect(repaired.rows[0]).toEqual({ completions: "3", observations: "3" });
    });

    it("fails closed when the dedicated production review route is disconnected", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      let genericCalls = 0;
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            genericCalls += 1;
            return {
              kind: "ARTIFACT",
              artifact: modelArtifact(EngineeringStage.SLICE_REVIEW),
              modelCalls: 1,
            };
          },
        },
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED",
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      });
      await port.open(runtimeIdentity());
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_REVIEW,
        attempt: 1,
      } as const;
      const context = await port.prepareContext(binding);
      await port.commitStarted(binding);
      await expect(
        port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "REVIEWER",
            input_artifacts: [],
            output_artifacts: ["ReviewDecision"],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).resolves.toMatchObject({
        status: "TERMINAL",
        modelCalls: 0,
        completion: { status: "BLOCKED", blocker_reason: expect.stringMatching(/not connected/) },
      });
      expect(genericCalls).toBe(0);
    });

    it("fails closed when the dedicated implementation route is disconnected", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      let genericCalls = 0;
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            genericCalls += 1;
            throw new Error("generic route must not receive SLICE_IMPLEMENTATION");
          },
        },
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED",
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      });
      await port.open(runtimeIdentity());
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_IMPLEMENTATION,
        attempt: 1,
      } as const;
      const context = await port.prepareContext(binding);
      await port.commitStarted(binding);
      await expect(
        port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "IMPLEMENTER",
            input_artifacts: [],
            output_artifacts: ["SliceImplementationReceipt"],
            completion_contract: null,
            workspace_access: "READ_WRITE",
          },
        }),
      ).resolves.toMatchObject({
        status: "TERMINAL",
        modelCalls: 0,
        completion: { status: "BLOCKED", blocker_reason: expect.stringMatching(/not connected/) },
      });
      expect(genericCalls).toBe(0);
    });

    it("rejects a dedicated implementation artifact that reports zero model calls", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const implementationExecutor: EngineeringSliceImplementationStageExecutor = {
        configDigest: sha("4"),
        schemaDigest: sha("5"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: systemArtifact(binding.stage, binding.attempt),
          modelCalls: 0,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            throw new Error("generic route must not receive SLICE_IMPLEMENTATION");
          },
        },
        implementationExecutor,
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED",
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      });
      await port.open(runtimeIdentity());
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_IMPLEMENTATION,
        attempt: 1,
      } as const;
      const context = await port.prepareContext(binding);
      await port.commitStarted(binding);
      await expect(
        port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "IMPLEMENTER",
            input_artifacts: [],
            output_artifacts: ["SliceImplementationReceipt"],
            completion_contract: null,
            workspace_access: "READ_WRITE",
          },
        }),
      ).rejects.toThrow(/zero model calls/u);
      expect(
        (await db.query("SELECT 1 FROM engineering_artifact_revisions WHERE run_id='run-1'")).rows,
      ).toHaveLength(0);
    });

    it("uses dedicated review config/schema identity and preserves real modelCalls", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const generic: EngineeringStageExecutor = {
        configDigest: sha("1"),
        schemaDigest: () => sha("2"),
        execute: async () => {
          throw new Error("generic route must not receive SLICE_REVIEW");
        },
      };
      let reportedModelCalls = 2;
      const review: EngineeringStageExecutor = {
        configDigest: sha("3"),
        schemaDigest: () => sha("4"),
        execute: async () => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(EngineeringStage.SLICE_REVIEW),
          modelCalls: reportedModelCalls,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: generic,
        reviewExecutor: review,
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED",
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      });
      await port.open(runtimeIdentity());
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_REVIEW,
        attempt: 1,
      } as const;
      const context = await port.prepareContext(binding);
      await port.commitStarted(binding);
      await expect(
        port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "REVIEWER",
            input_artifacts: [],
            output_artifacts: ["ReviewDecision"],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED", modelCalls: 2 });
      const identity = await db.query<{ config_digest: string; schema_digest: string }>(
        "SELECT config_digest, schema_digest FROM engineering_operations WHERE stage='SLICE_REVIEW'",
      );
      expect(identity.rows).toEqual([{ config_digest: sha("3"), schema_digest: sha("4") }]);

      reportedModelCalls = 0;
      const zeroBinding = { ...binding, attempt: 2 } as const;
      const zeroContext = await port.prepareContext(zeroBinding);
      await port.commitStarted(zeroBinding);
      await expect(
        port.invokeAndRecord({
          binding: zeroBinding,
          context: zeroContext,
          definition: {
            role: "REVIEWER",
            input_artifacts: [],
            output_artifacts: ["ReviewDecision"],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).rejects.toThrow(/zero model calls/);
    });

    it("reconstructs correction identity, attempts and review-boundary fingerprint history", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => {
          if (binding.stage === EngineeringStage.SLICE_REVIEW) {
            return {
              kind: "ARTIFACT",
              modelCalls: 1,
              artifact: engineeringArtifact.parse({
                ...modelArtifact(binding.stage),
                decision: "CHANGES_REQUIRED",
                findings: ["fix the bounded slice"],
              }),
            };
          }
          return { kind: "ARTIFACT", artifact: modelArtifact(binding.stage), modelCalls: 1 };
        },
      };
      const options = {
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        implementationExecutor: fakeImplementationExecutor(),
        localCommitExecutor: fakeLocalCommitExecutor(),
        executeSystemStage: async ({
          binding,
        }: {
          binding: { stage: EngineeringStage; attempt: number };
        }) => systemArtifact(binding.stage, binding.attempt),
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED" as const,
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      };
      const first = createPostgresEngineeringRuntimePort(options);
      await first.open(runtimeIdentity());
      let reviewEvidence: unknown;
      for (const stage of [
        EngineeringStage.SLICE_PLANNING,
        EngineeringStage.SLICE_IMPLEMENTATION,
        EngineeringStage.GATE_EXECUTION,
        EngineeringStage.SLICE_REVIEW,
      ] as const) {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt: 1,
        } as const;
        const context = await first.prepareContext(binding);
        await first.commitStarted(binding);
        const result = await first.invokeAndRecord({
          binding,
          context,
          definition: {
            role: stage === EngineeringStage.SLICE_IMPLEMENTATION ? "IMPLEMENTER" : "REVIEWER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access:
              stage === EngineeringStage.SLICE_IMPLEMENTATION ? "WRITE" : "READ_ONLY",
          },
        });
        if (stage === EngineeringStage.SLICE_REVIEW) reviewEvidence = result;
      }
      expect(reviewEvidence).toMatchObject({
        status: "COMPLETED",
        evidence: {
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            directive: "CORRECT_SLICE",
          },
        },
      });

      const resumed = createPostgresEngineeringRuntimePort(options);
      const session = await resumed.open(runtimeIdentity());
      expect(session.fingerprints).toHaveLength(1);
      const recoveredReview = await resumed.recoverStage({
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_REVIEW,
        attempt: 1,
      });
      expect(recoveredReview).toMatchObject({
        status: "RECOVERED",
        evidence: { slice: { activeSliceId: "slice-1", directive: "CORRECT_SLICE" } },
      });
      const correction = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_IMPLEMENTATION,
        attempt: 2,
      } as const;
      expect(await resumed.recoverStage(correction)).toEqual({ status: "NOT_STARTED" });
      const correctionContext = await resumed.prepareContext(correction);
      await resumed.commitStarted(correction);
      expect(
        await resumed.invokeAndRecord({
          binding: correction,
          context: correctionContext,
          definition: {
            role: "IMPLEMENTER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "WRITE",
          },
        }),
      ).toMatchObject({
        status: "COMPLETED",
        evidence: { slice: { activeSliceId: "slice-1", directive: "CORRECT_SLICE" } },
      });
    });

    it("clears a historical gate correction after the corrected attempt passes its gates", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        implementationExecutor: fakeImplementationExecutor(),
        localCommitExecutor: fakeLocalCommitExecutor(),
        executeSystemStage: async ({ binding, context, decisionIds }) => {
          const contextDigest = engineeringArtifactDigest(context.compiled.manifest);
          if (binding.attempt === 1) {
            return engineeringArtifact.parse({
              schema_version: 1,
              artifact_kind: "GateFailure",
              case_id: binding.caseId,
              run_id: binding.runId,
              revision: binding.checkpointRevision,
              authority: "SERVER_OWNED",
              slice_id: "slice-1",
              attempt: binding.attempt,
              tree_digest: sha("e"),
              diff_digest: sha("1"),
              context_digest: contextDigest,
              config_digest: sha("3"),
              blocking_gate_ids: ["gate-1"],
              receipt_ids: ["receipt-failed"],
              decision_ids: decisionIds,
              diagnostics: [
                {
                  gate_id: "gate-1",
                  outcome: "FAILED",
                  log_digest: sha("4"),
                  trust: TrustLevel.UNTRUSTED_DATA,
                  excerpt: "bounded gate failure",
                },
              ],
            });
          }
          const passed = systemArtifact(EngineeringStage.GATE_EXECUTION);
          if (passed.artifact_kind !== "EvidenceBundle") throw new Error("gate fixture mismatch");
          return engineeringArtifact.parse({
            ...passed,
            context_digest: contextDigest,
            decisions: decisionIds,
          });
        },
        policy: { riskFacts: smallRiskFacts },
      });
      await port.open(runtimeIdentity());

      const runStage = async (stage: EngineeringStage, attempt: number) => {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt,
        } as const;
        const context = await port.prepareContext(binding);
        await port.commitStarted(binding);
        return port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: stage === EngineeringStage.SLICE_IMPLEMENTATION ? "IMPLEMENTER" : "REVIEWER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access:
              stage === EngineeringStage.SLICE_IMPLEMENTATION ? "WRITE" : "READ_ONLY",
          },
        });
      };

      await runStage(EngineeringStage.SLICE_PLANNING, 1);
      await runStage(EngineeringStage.SLICE_IMPLEMENTATION, 1);
      expect(await runStage(EngineeringStage.GATE_EXECUTION, 1)).toMatchObject({
        status: "COMPLETED",
        evidence: { slice: { activeSliceId: "slice-1", directive: "CORRECT_SLICE" } },
      });
      await runStage(EngineeringStage.SLICE_IMPLEMENTATION, 2);
      expect(await runStage(EngineeringStage.GATE_EXECUTION, 2)).toMatchObject({
        status: "COMPLETED",
        evidence: {
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-1",
            directive: "CONTINUE",
          },
        },
      });
    });

    it("materializes two v2 blueprints in order without model slice planning", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      let modelPlanningCalls = 0;
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        slicePlanningConstraints: SLICE_PLANNING_CONSTRAINTS,
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => {
          let artifact = modelArtifact(binding.stage);
          if (binding.stage === EngineeringStage.PROGRAM_DESIGN)
            artifact = engineeringArtifact.parse({
              ...artifact,
              schema_version: 2,
              slice_order: ["slice-1", "slice-2"],
              slice_blueprints: [
                {
                  slice_id: "slice-1",
                  objective: "first bounded result",
                  observable_result: "first result is reviewable",
                  allowed_paths: ["apps/agent-worker/src"],
                  test_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
                  gate_ids: ["gate-1"],
                  inspection_method: "inspect first evidence",
                  stop_condition: "first review passes",
                },
                {
                  slice_id: "slice-2",
                  objective: "second bounded result",
                  observable_result: "second result is reviewable",
                  allowed_paths: ["apps/agent-worker/src"],
                  test_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
                  gate_ids: ["gate-1"],
                  inspection_method: "inspect second evidence",
                  stop_condition: "second review passes",
                },
              ],
            });
          if (binding.stage === EngineeringStage.SLICE_PLANNING) {
            modelPlanningCalls += 1;
            throw new Error("model slice planning must remain disconnected");
          }
          return { kind: "ARTIFACT", artifact, modelCalls: 1 };
        },
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        implementationExecutor: fakeImplementationExecutor(),
        localCommitExecutor: fakeLocalCommitExecutor(),
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED",
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: true,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      });
      await port.open(runtimeIdentity());
      const invoke = async (stage: EngineeringStage, attempt: number) => {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt,
        } as const;
        const context = await port.prepareContext(binding);
        await port.commitStarted(binding);
        return port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "PLANNER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        });
      };
      await invoke(EngineeringStage.PROGRAM_DESIGN, 1);
      expect(await invoke(EngineeringStage.SLICE_PLANNING, 1)).toMatchObject({ modelCalls: 0 });
      await invoke(EngineeringStage.SLICE_IMPLEMENTATION, 1);
      await invoke(EngineeringStage.GATE_EXECUTION, 1);
      const firstReview = await invoke(EngineeringStage.SLICE_REVIEW, 1);
      expect(firstReview).toMatchObject({
        status: "COMPLETED",
        evidence: {
          slice: {
            activeSliceId: "slice-1",
            expectedSliceId: "slice-2",
            completedSliceIds: ["slice-1"],
            directive: "NEXT_SLICE",
          },
        },
      });
      const secondPlan = await invoke(EngineeringStage.SLICE_PLANNING, 2);
      expect(secondPlan).toMatchObject({
        status: "COMPLETED",
        modelCalls: 0,
        evidence: {
          slice: {
            activeSliceId: "slice-2",
            expectedSliceId: "slice-2",
            completedSliceIds: ["slice-1"],
            directive: "CONTINUE",
          },
        },
      });
      await invoke(EngineeringStage.SLICE_IMPLEMENTATION, 2);
      await invoke(EngineeringStage.GATE_EXECUTION, 2);
      const secondReview = await invoke(EngineeringStage.SLICE_REVIEW, 2);
      expect(secondReview).toMatchObject({
        status: "COMPLETED",
        evidence: {
          slice: {
            activeSliceId: "slice-2",
            expectedSliceId: null,
            completedSliceIds: ["slice-1", "slice-2"],
            directive: "COMPLETE",
          },
        },
      });
      expect(modelPlanningCalls).toBe(0);
    });

    it.each(["PATH", "GATE", "TEST", "MINIMUM"] as const)(
      "refuses a v2 %s blueprint mismatch before implementation",
      async (mismatch) => {
        const jobs = new JobStore(runtime);
        await jobs.enqueue(db, {
          caseId: "case-1",
          jobType: "agent.implementer",
          payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
        });
        const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
        expect(lease).not.toBeNull();
        const artifact = currentProgramDesignArtifact({
          count: mismatch === "MINIMUM" ? 1 : 2,
          ...(mismatch === "GATE" ? { gateId: "foreign-gate" } : {}),
        });
        let implementationCalls = 0;
        const implementation = fakeImplementationExecutor();
        const executor: EngineeringStageExecutor = {
          configDigest: sha("5"),
          slicePlanningConstraints:
            mismatch === "PATH"
              ? {
                  allowedPaths: ["apps/agent-worker/test"],
                  allowedTestPaths: ["apps/agent-worker/test"],
                  requiredGateIds: ["gate-1"],
                }
              : mismatch === "TEST"
                ? {
                    allowedPaths: WRITE_POLICY.write_path_allowlist,
                    allowedTestPaths: ["apps/agent-worker/test"],
                    requiredGateIds: ["gate-1"],
                  }
                : SLICE_PLANNING_CONSTRAINTS,
          schemaDigest: () => sha("6"),
          execute: async () => ({ kind: "ARTIFACT", artifact, modelCalls: 1 }),
        };
        const port = createPostgresEngineeringRuntimePort({
          db,
          lease: lease!,
          jobs,
          readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
          executor,
          implementationExecutor: {
            ...implementation,
            execute: async (input) => {
              implementationCalls += 1;
              return implementation.execute(input);
            },
          },
          policy: { riskFacts: { ...smallRiskFacts, multi_module: true } },
        });
        await port.open(runtimeIdentity());
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage: EngineeringStage.PROGRAM_DESIGN,
          attempt: 1,
        } as const;
        const context = await port.prepareContext(binding);
        await port.commitStarted(binding);
        await expect(
          port.invokeAndRecord({
            binding,
            context,
            definition: {
              role: "PLANNER",
              input_artifacts: [],
              output_artifacts: [],
              completion_contract: "EngineeringProgramDesign",
              workspace_access: "READ_ONLY",
            },
          }),
        ).rejects.toThrow();
        expect(implementationCalls).toBe(0);
        expect(
          (
            await db.query(
              "SELECT 1 FROM engineering_artifact_revisions WHERE artifact_kind='ProgramDesign'",
            )
          ).rowCount,
        ).toBe(0);
      },
    );

    it("stops a legacy planning result whose identity changes the durable order", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        slicePlanningConstraints: SLICE_PLANNING_CONSTRAINTS,
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => {
          const artifact = modelArtifact(binding.stage);
          if (binding.stage === EngineeringStage.PROGRAM_DESIGN) {
            return {
              kind: "ARTIFACT",
              artifact: engineeringArtifact.parse({
                ...artifact,
                slice_order: ["slice-1", "slice-2"],
              }),
              modelCalls: 1,
            };
          }
          if (binding.stage === EngineeringStage.SLICE_PLANNING) {
            return {
              kind: "ARTIFACT",
              artifact: engineeringArtifact.parse({ ...artifact, slice_id: "slice-2" }),
              modelCalls: 1,
            };
          }
          return { kind: "ARTIFACT", artifact, modelCalls: 1 };
        },
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        policy: { riskFacts: { ...smallRiskFacts, multi_module: true } },
      });
      await port.open(runtimeIdentity());
      const invoke = async (stage: EngineeringStage) => {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt: 1,
        } as const;
        const context = await port.prepareContext(binding);
        await port.commitStarted(binding);
        return port.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "PLANNER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        });
      };
      await invoke(EngineeringStage.PROGRAM_DESIGN);
      expect(await invoke(EngineeringStage.SLICE_PLANNING)).toMatchObject({
        status: "COMPLETED",
        modelCalls: 1,
        evidence: {
          slice: {
            activeSliceId: null,
            expectedSliceId: "slice-1",
            directive: "STOP",
          },
        },
      });
    });

    it("binds correction attempt evidence and reconciles a crash without a second commit", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const generic: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const review: EngineeringStageExecutor = {
        ...generic,
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact:
            binding.attempt === 1
              ? engineeringArtifact.parse({
                  ...modelArtifact(EngineeringStage.SLICE_REVIEW),
                  decision: "CHANGES_REQUIRED",
                  findings: ["correct the same slice"],
                })
              : modelArtifact(EngineeringStage.SLICE_REVIEW),
          modelCalls: 1,
        }),
      };
      const baseCommit = fakeLocalCommitExecutor();
      let captured:
        Parameters<EngineeringLocalCommitStageExecutor["prepare"]>[0]["provenance"] | null = null;
      let capturedDescriptor: Awaited<
        ReturnType<EngineeringLocalCommitStageExecutor["prepare"]>
      > | null = null;
      let externalCommitCount = 0;
      const crashingCommit: EngineeringLocalCommitStageExecutor = {
        ...baseCommit,
        prepare: async (input) => {
          captured = input.provenance;
          capturedDescriptor = await baseCommit.prepare(input);
          return capturedDescriptor;
        },
        execute: async () => {
          externalCommitCount += 1;
          throw new Error("simulated crash after local commit");
        },
        recover: async ({ binding, descriptor }) =>
          externalCommitCount === 1 ? baseCommit.execute({ binding, descriptor }) : null,
      };
      const options = {
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor: generic,
        reviewExecutor: review,
        implementationExecutor: fakeImplementationExecutor(),
        localCommitExecutor: crashingCommit,
        executeSystemStage: async ({
          binding,
        }: {
          binding: { stage: EngineeringStage; attempt: number };
        }) => systemArtifact(binding.stage, binding.attempt),
        policy: {
          riskFacts: {
            authority: "SERVER_OWNED" as const,
            security_or_policy: false,
            migration: false,
            irreversible_side_effect: false,
            broad_public_contract_change: false,
            multi_module: false,
            new_architecture: false,
            deterministic_oracle: true,
            user_data: false,
            concurrency: false,
            external_side_effect: false,
          },
        },
      };
      const first = createPostgresEngineeringRuntimePort(options);
      await first.open(runtimeIdentity());
      const invoke = async (stage: EngineeringStage, attempt: number) => {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt,
        } as const;
        const context = await first.prepareContext(binding);
        await first.commitStarted(binding);
        return first.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "PLANNER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        });
      };
      await invoke(EngineeringStage.SLICE_PLANNING, 1);
      await invoke(EngineeringStage.GATE_EXECUTION, 1);
      await invoke(EngineeringStage.SLICE_REVIEW, 1);
      await invoke(EngineeringStage.GATE_EXECUTION, 2);
      await invoke(EngineeringStage.SLICE_REVIEW, 2);
      await invoke(EngineeringStage.FINAL_VERIFICATION, 1);
      const localBinding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.LOCAL_COMMIT,
        attempt: 1,
      } as const;
      const context = await first.prepareContext(localBinding);
      expect(captured?.accepted).toEqual([
        expect.objectContaining({ sliceId: "slice-1", attempt: 2 }),
      ]);
      const durableDescriptor = await db.query<{
        descriptor: Record<string, unknown>;
        started: boolean;
      }>(
        `SELECT i.descriptor,
                EXISTS (
                  SELECT 1 FROM engineering_stage_events e
                   WHERE e.operation_id=o.operation_id AND e.event_type='STARTED'
                ) AS started
           FROM engineering_operations o
           JOIN job_intents i ON i.intent_id=o.intent_id AND i.job_id=o.job_id
          WHERE o.stage='LOCAL_COMMIT'`,
      );
      expect(durableDescriptor.rows[0]).toMatchObject({
        descriptor: {
          commit: {
            operation_id: expect.any(String),
            accepted: [expect.objectContaining({ slice_id: "slice-1", attempt: 2 })],
            final_verification_digest: expect.stringMatching(/^sha256:/),
          },
        },
        started: false,
      });
      await first.commitStarted(localBinding);
      await expect(
        first.invokeAndRecord({
          binding: localBinding,
          context,
          definition: {
            role: "IMPLEMENTER",
            input_artifacts: [],
            output_artifacts: ["LocalCommitReceipt"],
            completion_contract: null,
            workspace_access: "READ_WRITE",
          },
        }),
      ).rejects.toThrow(/simulated crash/);

      const resumed = createPostgresEngineeringRuntimePort(options);
      await resumed.open(runtimeIdentity());
      expect(await resumed.recoverStage(localBinding)).toMatchObject({ status: "RECOVERED" });
      expect(externalCommitCount).toBe(1);
      // Simulate the second crash boundary on another exact attempt: artifact
      // append succeeded, but queue completion/observation never ran.
      const artifactOnlyBinding = { ...localBinding, attempt: 2 } as const;
      await resumed.prepareContext(artifactOnlyBinding);
      await resumed.commitStarted(artifactOnlyBinding);
      if (capturedDescriptor === null) throw new Error("expected prepared commit descriptor");
      const artifactOnlyReceipt = await baseCommit.execute({
        binding: artifactOnlyBinding,
        descriptor: capturedDescriptor,
      });
      await new EngineeringControlPlaneRepository(runtime).appendArtifactRevision(db, lease!, {
        operationId: capturedDescriptor.operation_id,
        artifactKey: "local_commit:2",
        artifact: artifactOnlyReceipt,
      });
      const artifactOnly = createPostgresEngineeringRuntimePort(options);
      await artifactOnly.open(runtimeIdentity());
      expect(await artifactOnly.recoverStage(artifactOnlyBinding)).toMatchObject({
        status: "RECOVERED",
      });
      expect(externalCommitCount).toBe(1);
      const repaired = await db.query<{ completions: string; observations: string }>(
        `SELECT
           (SELECT count(*)::text FROM job_completions c
             JOIN engineering_operations o ON o.intent_id=c.intent_id AND o.job_id=c.job_id
            WHERE o.stage='LOCAL_COMMIT' AND o.stage_attempt=2) AS completions,
           (SELECT count(*)::text FROM engineering_stage_events
            WHERE stage='LOCAL_COMMIT' AND stage_attempt=2
              AND event_type='COMPLETION_OBSERVED') AS observations`,
      );
      expect(repaired.rows[0]).toEqual({ completions: "1", observations: "1" });

      const tamperedBinding = { ...localBinding, attempt: 3 } as const;
      await artifactOnly.prepareContext(tamperedBinding);
      await artifactOnly.commitStarted(tamperedBinding);
      if (capturedDescriptor === null) throw new Error("expected tamper descriptor");
      const validReceipt = await baseCommit.execute({
        binding: tamperedBinding,
        descriptor: capturedDescriptor,
      });
      await new EngineeringControlPlaneRepository(runtime).appendArtifactRevision(db, lease!, {
        operationId: capturedDescriptor.operation_id,
        artifactKey: "local_commit:3",
        artifact: { ...validReceipt, review_digest: sha("f") },
      });
      const tamperedRecovery = createPostgresEngineeringRuntimePort(options);
      await tamperedRecovery.open(runtimeIdentity());
      await expect(tamperedRecovery.recoverStage(tamperedBinding)).rejects.toThrow(
        /receipt does not match durable descriptor/,
      );
    });

    it("requires an exact process escalation and durable scoped approval for high-risk write", async () => {
      const jobs = new JobStore(runtime);
      const approvalId = "approval-write-1";
      const proposalId = "proposal-write-1";
      const actionDigest = engineeringWriteAuthorizationScopeV2Digest(exactWriteScope());
      await db.withTransaction(async (tx) => {
        expect(
          await new ApprovalRepository().grant(tx, {
            approvalId,
            caseId: "case-1",
            grantedBy: "owner-1",
            actionDigest,
            checkpointRevision: 0,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).toMatchObject({ outcome: "GRANTED" });
      });
      const job = await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          reason: "engineering_approval",
          proposalId,
          approvalId,
          checkpointRevision: 0,
          repoId: WRITE_POLICY.repository_id,
        },
      });
      await materializeGrantedProposal(db, {
        proposalId,
        approvalId,
        jobId: job.job_id,
        actionDigest,
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const policy = {
        riskFacts: {
          authority: "SERVER_OWNED" as const,
          security_or_policy: false,
          migration: false,
          irreversible_side_effect: false,
          broad_public_contract_change: false,
          multi_module: false,
          new_architecture: false,
          deterministic_oracle: true,
          user_data: false,
          concurrency: false,
          external_side_effect: false,
        },
        ownerEscalation: {
          authority: "OWNER_DECISION" as const,
          decisionId: "owner-grant-1",
          checkpointRevision: 0,
          processClass: "LARGE_OR_HIGH_RISK" as const,
        },
      };
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const ungranted = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
        policy,
      });
      await expect(ungranted.open(runtimeIdentity())).rejects.toThrow(/exact durable answer/);

      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('foreign-case','owner-1','IMPLEMENTING',
                 '{"providers":["jira"],"connection_ids":["connection-1"]}'::jsonb,
                 'foreign-thread')`,
      );
      await db.query(
        `INSERT INTO decisions (
           decision_id, case_id, question, why_now, options, recommendation,
           blocked_scope, checkpoint_revision)
         VALUES
           ('foreign-case-grant','foreign-case','Authorize?','Before execution',
            '[{"id":"grant","label":"Grant","consequences":"Proceed"},{"id":"deny","label":"Deny","consequences":"Stop"}]'::jsonb,
            'grant','engineering workflow',0),
           ('foreign-revision-grant','case-1','Authorize?','Before execution',
            '[{"id":"grant","label":"Grant","consequences":"Proceed"},{"id":"deny","label":"Deny","consequences":"Stop"}]'::jsonb,
            'grant','engineering workflow',1)`,
      );
      await db.query(
        `INSERT INTO decision_answers (
           answer_id, decision_id, case_id, checkpoint_revision, selected_option_id,
           answered_by, answered_at)
         VALUES
           ('foreign-case-answer','foreign-case-grant','foreign-case',0,'grant','owner-1',now()),
           ('foreign-revision-answer','foreign-revision-grant','case-1',1,'grant','owner-1',now())`,
      );
      for (const authorizationId of ["foreign-case-grant", "foreign-revision-grant"]) {
        const foreign = createPostgresEngineeringRuntimePort({
          db,
          lease: lease!,
          jobs,
          readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
          executor,
          reviewExecutor: executor,
          executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
          policy: {
            ...policy,
            ownerEscalation: { ...policy.ownerEscalation, decisionId: authorizationId },
          },
        });
        await expect(foreign.open(runtimeIdentity())).rejects.toThrow(/exact durable answer/);
      }

      await db.query(
        `INSERT INTO decisions (
           decision_id, case_id, question, why_now, options, recommendation,
           blocked_scope, checkpoint_revision)
         VALUES ('owner-grant-1','case-1','Use high-risk process?','Before design',
                 '[{"id":"grant","label":"Grant","consequences":"Full design"},{"id":"deny","label":"Deny","consequences":"Stop"}]'::jsonb,
                 'grant','engineering workflow',0)`,
      );
      await db.query(
        `INSERT INTO decision_answers (
           answer_id, decision_id, case_id, checkpoint_revision, selected_option_id,
           answered_by, answered_at)
         VALUES ('answer-grant-1','owner-grant-1','case-1',0,'grant','owner-1',now())`,
      );
      const decisionOnly = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
        policy,
      });
      await expect(decisionOnly.open(runtimeIdentity())).rejects.toThrow(/durable write approval/);

      const staleLease = { ...lease!, fencingToken: lease!.fencingToken + 1 };
      const staleHolder = createPostgresEngineeringRuntimePort({
        db,
        lease: staleLease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
        policy,
        approvalCandidate: engineeringApprovalCandidateFromLease(staleLease),
      });
      await expect(staleHolder.open(runtimeIdentity())).rejects.toThrow(/stale|lease/i);
      expect(
        (
          await db.query<{ consumed: boolean }>(
            "SELECT consumed FROM approvals WHERE approval_id=$1",
            [approvalId],
          )
        ).rows[0]?.consumed,
      ).toBe(false);

      const granted = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
        policy,
        approvalCandidate: engineeringApprovalCandidateFromLease(lease!),
      });
      expect(await granted.open(runtimeIdentity())).toMatchObject({
        plan: { processClass: "LARGE_OR_HIGH_RISK", ownerDecisionId: "owner-grant-1" },
      });
      const identity = runtimeIdentity();
      await expect(
        granted.open({
          ...identity,
          unit: {
            ...identity.unit,
            workUnit: { ...identity.unit.workUnit, case_id: "foreign-case" },
          },
        }),
      ).rejects.toThrow(/lease\/run binding mismatch/);
      await expect(
        granted.prepareContext({
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_PLANNING,
          attempt: 1,
        }),
      ).rejects.toThrow(/outside the opened runtime session/);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rowCount).toBe(0);
    });

    it("rejects a foreign V2 proposal materialization before recording an intent", async () => {
      const jobs = new JobStore(runtime);
      const proposalId = "foreign-materialization-proposal";
      const approvalId = "foreign-materialization-approval";
      const foreignScope = exactWriteScope({
        authoritative_scope: {
          connection_ids: ["connection-1"],
          repo_allowlist: [WRITE_POLICY.repository_id],
          can_write_workspace: true,
        },
      });
      const actionDigest = engineeringWriteAuthorizationScopeV2Digest(foreignScope);
      await db.withTransaction(async (tx) => {
        expect(
          await new ApprovalRepository().grant(tx, {
            approvalId,
            caseId: "case-1",
            grantedBy: "owner-1",
            actionDigest,
            checkpointRevision: 0,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).toMatchObject({ outcome: "GRANTED" });
      });
      const job = await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: {
          reason: "engineering_approval",
          caseId: "case-1",
          proposalId,
          approvalId,
          checkpointRevision: 0,
          workUnitId: "unit-1",
          runId: "run-1",
          repoId: WRITE_POLICY.repository_id,
        },
      });
      await materializeGrantedProposal(db, {
        proposalId,
        approvalId,
        jobId: job.job_id,
        actionDigest,
        scope: foreignScope,
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected implementer lease");
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        policy: { riskFacts: { ...smallRiskFacts, security_or_policy: true } },
        approvalCandidate: engineeringApprovalCandidateFromLease(lease),
      });
      await expect(port.open(runtimeIdentity())).rejects.toThrow(/exact worker materialization/);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rowCount).toBe(0);
    });

    it("rejects ALREADY_CONSUMED approval recovery after the case revision advances", async () => {
      const jobs = new JobStore(runtime);
      const approvalId = "approval-restart-stale";
      const proposalId = "proposal-restart-stale";
      const actionDigest = engineeringWriteAuthorizationScopeV2Digest(exactWriteScope());
      await db.withTransaction(async (tx) => {
        expect(
          await new ApprovalRepository().grant(tx, {
            approvalId,
            caseId: "case-1",
            grantedBy: "owner-1",
            actionDigest,
            checkpointRevision: 0,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).toMatchObject({ outcome: "GRANTED" });
      });
      const job = await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          reason: "engineering_approval",
          proposalId,
          approvalId,
          checkpointRevision: 0,
          repoId: WRITE_POLICY.repository_id,
        },
      });
      await materializeGrantedProposal(db, {
        proposalId,
        approvalId,
        jobId: job.job_id,
        actionDigest,
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected implementer lease");
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const makePort = () =>
        createPostgresEngineeringRuntimePort({
          db,
          lease,
          jobs,
          readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
          executor,
          policy: { riskFacts: { ...smallRiskFacts, security_or_policy: true } },
          approvalCandidate: engineeringApprovalCandidateFromLease(lease),
        });
      await makePort().open(runtimeIdentity());
      await db.query(
        `INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint)
         VALUES ('case-1','owner-1',1,$1::jsonb)`,
        [JSON.stringify(makeCheckpoint("case-1", 1))],
      );
      await db.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id='case-1'");
      await expect(makePort().open(runtimeIdentity())).rejects.toThrow(/restart proof/);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rowCount).toBe(0);
    });

    it("rejects a cross-stage compiled ContextManifest before binding an intent", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected implementer lease");
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease,
        jobs,
        readContext: async () => manifest(EngineeringStage.DISCOVERY),
        executor,
        policy: { riskFacts: smallRiskFacts },
      });
      await port.open(runtimeIdentity());
      await expect(
        port.prepareContext({
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_PLANNING,
          attempt: 1,
        }),
      ).rejects.toThrow(/compiled ContextManifest does not match/);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rowCount).toBe(0);
    });

    it("invalidates the complete prior session before a failed re-open on the same port", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected implementer lease");
      await db.query(
        `INSERT INTO decisions (
           decision_id, case_id, question, why_now, options, recommendation,
           blocked_scope, checkpoint_revision)
         VALUES ('session-grant','case-1','Authorize?','Before execution',
                 '[{"id":"grant","label":"Grant","consequences":"Proceed"},{"id":"deny","label":"Deny","consequences":"Stop"}]'::jsonb,
                 'grant','engineering workflow',0)`,
      );
      await db.query(
        `INSERT INTO decision_answers (
           answer_id, decision_id, case_id, checkpoint_revision, selected_option_id,
           answered_by, answered_at)
         VALUES ('session-answer','session-grant','case-1',0,'grant','owner-1',now())`,
      );
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        policy: { riskFacts: smallRiskFacts },
      });
      const identity = runtimeIdentity();
      await port.open(identity);
      await expect(
        port.open({
          ...identity,
          unit: {
            ...identity.unit,
            workUnit: { ...identity.unit.workUnit, case_id: "foreign-case" },
          },
        }),
      ).rejects.toThrow(/lease\/run binding mismatch/);

      await expect(
        port.prepareContext({
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_PLANNING,
          attempt: 1,
        }),
      ).rejects.toThrow(/outside the opened runtime session/);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rowCount).toBe(0);
    });

    it("rejects an arbitrary DesignDecision digest before artifact append", async () => {
      const jobs = new JobStore(runtime);
      const approvalId = "design-digest-approval";
      const proposalId = "design-digest-proposal";
      const actionDigest = engineeringWriteAuthorizationScopeV2Digest(exactWriteScope());
      await db.withTransaction(async (tx) => {
        expect(
          await new ApprovalRepository().grant(tx, {
            approvalId,
            caseId: "case-1",
            grantedBy: "owner-1",
            actionDigest,
            checkpointRevision: 0,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).toMatchObject({ outcome: "GRANTED" });
      });
      const job = await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          reason: "engineering_approval",
          proposalId,
          approvalId,
          checkpointRevision: 0,
          repoId: WRITE_POLICY.repository_id,
        },
      });
      await materializeGrantedProposal(db, {
        proposalId,
        approvalId,
        jobId: job.job_id,
        actionDigest,
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      if (lease === null) throw new Error("expected implementer lease");
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const port = createPostgresEngineeringRuntimePort({
        db,
        lease,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        policy: { riskFacts: { ...smallRiskFacts, security_or_policy: true } },
        approvalCandidate: engineeringApprovalCandidateFromLease(lease),
      });
      await port.open(runtimeIdentity());
      const invoke = async (stage: EngineeringStage) => {
        const binding = {
          caseId: "case-1",
          workUnitId: "unit-1",
          runId: "run-1",
          checkpointRevision: 0,
          stage,
          attempt: 1,
        } as const;
        const prepared = await port.prepareContext(binding);
        await port.commitStarted(binding);
        return port.invokeAndRecord({
          binding,
          context: prepared,
          definition: {
            role: "ARCHITECT",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        });
      };
      await invoke(EngineeringStage.PROGRAM_DESIGN);
      await expect(invoke(EngineeringStage.DESIGN_APPROVAL)).rejects.toThrow(
        /exact durable ProgramDesign/,
      );
      expect(
        (
          await db.query(
            "SELECT 1 FROM engineering_artifact_revisions WHERE artifact_kind='DesignDecision'",
          )
        ).rowCount,
      ).toBe(0);
    });
  },
  available,
);

it("binds a structured stage to its server-owned provider-neutral schema", async () => {
  const config = createRuntimeConfig({
    model: { provider: "qualification_fake", model_id: "test-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 2 },
  });
  const artifact = modelArtifact(EngineeringStage.SLICE_PLANNING);
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: artifact }] },
  ]);
  const executor = createStructuredEngineeringStageExecutor({
    transport,
    config,
    slicePlanningConstraints: SLICE_PLANNING_CONSTRAINTS,
  });
  const result = await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.SLICE_PLANNING,
      attempt: 1,
    },
    objective: "bounded slice",
    context: manifest(EngineeringStage.SLICE_PLANNING),
    orderedArtifacts: [],
    processClass: "SMALL",
  });
  expect(result).toEqual({ kind: "ARTIFACT", artifact, modelCalls: 1 });
  expect(transport.requests).toHaveLength(1);
  expect(executor.schemaDigest(EngineeringStage.SLICE_PLANNING)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(
    transport.requests[0]!.messages.flatMap((message) => message.content)
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n"),
  ).toContain("Execute only engineering stage SLICE_PLANNING");
});

it.each([
  ["MEDIUM", 1, 2],
  ["LARGE_OR_HIGH_RISK", 2, 3],
] as const)(
  "requires the code-owned minimum blueprint count for %s",
  (processClass, count, minimum) => {
    const design = currentProgramDesignArtifact({ count });
    if (design.artifact_kind !== "ProgramDesign" || design.schema_version !== 2) {
      throw new Error("current ProgramDesign fixture mismatch");
    }
    expect(() =>
      assertEngineeringProgramDesignBlueprints({
        design,
        processClass,
        constraints: SLICE_PLANNING_CONSTRAINTS,
      }),
    ).toThrow(`requires at least ${minimum} blueprints`);
  },
);

it("rejects a blueprint that exceeds the code-owned per-slice write-root limit", () => {
  const design = currentProgramDesignArtifact({ count: 2 });
  if (design.artifact_kind !== "ProgramDesign" || design.schema_version !== 2) {
    throw new Error("current ProgramDesign fixture mismatch");
  }
  const broad = engineeringArtifact.parse({
    ...design,
    slice_blueprints: design.slice_blueprints.map((blueprint, index) =>
      index === 0
        ? {
            ...blueprint,
            allowed_paths: [
              "apps/agent-worker/src/a",
              "apps/agent-worker/src/b",
              "apps/agent-worker/src/c",
              "apps/agent-worker/src/d",
              "apps/agent-worker/src/e",
            ],
            test_paths: ["apps/agent-worker/src/a"],
          }
        : blueprint,
    ),
  });
  if (broad.artifact_kind !== "ProgramDesign" || broad.schema_version !== 2) {
    throw new Error("broad ProgramDesign fixture mismatch");
  }
  expect(() =>
    assertEngineeringProgramDesignBlueprints({
      design: broad,
      processClass: "MEDIUM",
      constraints: SLICE_PLANNING_CONSTRAINTS,
    }),
  ).toThrow("exceeds the 4-root write limit");
});

it("binds FIRST/EACH/LAST gates to the exact code-owned blueprint positions", () => {
  const constraints = {
    allowedPaths: WRITE_POLICY.write_path_allowlist,
    allowedTestPaths: WRITE_POLICY.write_path_allowlist,
    requiredGateIds: ["first", "each", "last"],
    requiredGateSchedules: {
      first: "FIRST_SLICE" as const,
      each: "EACH_SLICE" as const,
      last: "LAST_SLICE" as const,
    },
  };
  const scheduled = currentProgramDesignArtifact({
    count: 3,
    gateIdsByIndex: [["first", "each"], ["each"], ["each", "last"]],
  });
  if (scheduled.artifact_kind !== "ProgramDesign" || scheduled.schema_version !== 2) {
    throw new Error("scheduled ProgramDesign fixture mismatch");
  }
  expect(() =>
    assertEngineeringProgramDesignBlueprints({
      design: scheduled,
      processClass: "LARGE_OR_HIGH_RISK",
      constraints,
    }),
  ).not.toThrow();

  expect(() =>
    assertEngineeringProgramDesignBlueprints({
      design: {
        ...scheduled,
        slice_blueprints: scheduled.slice_blueprints.map((blueprint) => ({
          ...blueprint,
          gate_ids: ["first", "each", "last"],
        })),
      },
      processClass: "LARGE_OR_HIGH_RISK",
      constraints,
    }),
  ).toThrow(/exact scheduled required gates/);
});

it("replaces model-authored blueprint gate IDs with the exact code-owned schedule", async () => {
  const constraints = {
    allowedPaths: WRITE_POLICY.write_path_allowlist,
    allowedTestPaths: WRITE_POLICY.write_path_allowlist,
    requiredGateIds: ["first", "each", "last"],
    requiredGateSchedules: {
      first: "FIRST_SLICE" as const,
      each: "EACH_SLICE" as const,
      last: "LAST_SLICE" as const,
    },
  };
  const modelDesign = currentProgramDesignArtifact({
    count: 3,
    gateIdsByIndex: [
      ["first", "each", "last"],
      ["first", "each", "last"],
      ["first", "each", "last"],
    ],
  });
  const config = createRuntimeConfig({
    model: { provider: "qualification_fake", model_id: "test-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 2 },
  });
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: modelDesign }] },
  ]);
  const executor = createStructuredEngineeringStageExecutor({
    transport,
    config,
    slicePlanningConstraints: constraints,
  });
  const result = await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.PROGRAM_DESIGN,
      attempt: 1,
    },
    objective: "scheduled slices",
    context: manifest(EngineeringStage.PROGRAM_DESIGN),
    orderedArtifacts: [],
    processClass: "LARGE_OR_HIGH_RISK",
  });
  expect(result.kind).toBe("ARTIFACT");
  if (result.kind !== "ARTIFACT" || result.artifact.artifact_kind !== "ProgramDesign") {
    throw new Error("expected ProgramDesign artifact");
  }
  expect(result.artifact.slice_blueprints.map((blueprint) => blueprint.gate_ids)).toEqual([
    ["first", "each"],
    ["each"],
    ["each", "last"],
  ]);
});

it("creates a fresh tools-disabled provider-neutral pre-commit session", async () => {
  const config = createRuntimeConfig({
    model: { provider: "qualification_fake", model_id: "test-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 2 },
  });
  const captured: unknown[] = [];
  const transport = {
    converse: async (request: unknown) => {
      captured.push(request);
      return {
        model: config.model,
        content: [
          {
            type: "json" as const,
            value: { schema_version: 1, findings: [], lines_examined: 4 },
          },
        ],
      };
    },
  };
  const factory = createStructuredPreCommitReviewSessionFactory({ transport, config });
  const first = await factory.createSession();
  const second = await factory.createSession();
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(first.toolNames).toEqual([]);
  const result = await first.review({
    binding: {
      case_id: "case-1",
      run_id: "run-1",
      checkpoint_revision: 0,
      slice_id: "slice-1",
      attempt: 1,
    },
    task_brief: "review exact patch",
    patch: "+safe change\n",
    raw_patch_digest: sha("1"),
    actual_diff_digest: sha("2"),
    tree_digest: sha("3"),
    evidence_bundle: systemArtifact(EngineeringStage.GATE_EXECUTION) as never,
    evidence_bundle_digest: sha("4"),
  });
  expect(result.modelCalls).toBe(1);
  expect(factory.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(factory.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ tools: [] });
  expect(JSON.stringify(captured[0])).toContain("one contiguous verbatim quote");
});
