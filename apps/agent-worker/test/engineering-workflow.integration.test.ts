import { afterEach, beforeEach, expect, it } from "vitest";

import {
  engineeringArtifact,
  engineeringContextManifest,
  EngineeringStage,
  TrustLevel,
  canonicalDigest,
  type EngineeringArtifact,
  type WorkUnit,
} from "@remoteagent/contracts";
import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  EngineeringControlPlaneRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { MetricName, MetricRegistry, StructuredLogger } from "@remoteagent/observability";
import { gitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";

import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import type { CompiledRoleContext } from "../src/context.js";
import {
  createBedrockEngineeringStageExecutor,
  createBedrockPreCommitReviewSessionFactory,
  createPostgresEngineeringRuntimePort,
  engineeringAuthorizationFromLease,
  type EngineeringStageExecutor,
  type EngineeringSliceImplementationStageExecutor,
  type EngineeringLocalCommitStageExecutor,
} from "../src/engineering-workflow.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";

const available = await ensurePostgres();
const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
const runtime = productionRuntime();

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
        artifact_kind: "SliceContract",
        slice_id: "slice-1",
        objective: "bounded slice",
        observable_result: "one observable result",
        allowed_paths: ["apps/agent-worker/src"],
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

it("derives an owner grant only from an exact causal decision-answer lease", () => {
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
  expect(engineeringAuthorizationFromLease(baseLease)).toBeUndefined();
  expect(
    engineeringAuthorizationFromLease({
      ...baseLease,
      payload: {
        ...baseLease.payload,
        reason: "decision_answer",
        decisionId: "decision-1",
        checkpointRevision: 4,
      },
    }),
  ).toEqual({
    authority: "OWNER_DECISION",
    authorizationId: "decision-1",
    checkpointRevision: 4,
  });
  expect(() =>
    engineeringAuthorizationFromLease({
      ...baseLease,
      payload: { ...baseLease.payload, reason: "decision_answer", checkpointRevision: 4 },
    }),
  ).toThrow(/authorization binding/);
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
      expect(recoveredSession.fingerprints).toHaveLength(1);
      expect(contextReads).toBe(1);
      expect(executorCalls).toBe(0);
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

    it("reconstructs correction identity, attempts and fingerprint history from ordered artifacts", async () => {
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
      expect(session.fingerprints).toHaveLength(4);
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

    it("derives NEXT_SLICE only from exact ProgramDesign.slice_order", async () => {
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
          let artifact = modelArtifact(binding.stage);
          if (binding.stage === EngineeringStage.PROGRAM_DESIGN)
            artifact = engineeringArtifact.parse({
              ...artifact,
              slice_order: ["slice-1", "slice-2"],
            });
          if (binding.stage === EngineeringStage.SLICE_PLANNING && binding.attempt === 2)
            artifact = engineeringArtifact.parse({ ...artifact, slice_id: "slice-2" });
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
      await invoke(EngineeringStage.SLICE_PLANNING, 1);
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
        evidence: {
          slice: {
            activeSliceId: "slice-2",
            expectedSliceId: "slice-2",
            completedSliceIds: ["slice-1"],
            directive: "CONTINUE",
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
          operation_id: expect.any(String),
          accepted: [expect.objectContaining({ slice_id: "slice-1", attempt: 2 })],
          final_verification_digest: expect.stringMatching(/^sha256:/),
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

    it("requires an exact answered owner decision before a high-risk design can implement", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
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
        authorization: {
          authority: "OWNER_DECISION" as const,
          authorizationId: "owner-grant-1",
          checkpointRevision: 0,
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
      const granted = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        reviewExecutor: executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage, binding.attempt),
        policy,
      });
      expect(await granted.open(runtimeIdentity())).toMatchObject({
        plan: { processClass: "LARGE_OR_HIGH_RISK", ownerDecisionId: "owner-grant-1" },
      });
    });
  },
  available,
);

it("binds a structured stage to its server-owned Bedrock schema", async () => {
  const config = createRuntimeConfig({
    model: { provider: "bedrock", model_id: "test-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 2 },
  });
  const artifact = modelArtifact(EngineeringStage.SLICE_PLANNING);
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: artifact }] },
  ]);
  const executor = createBedrockEngineeringStageExecutor({ transport, config });
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

it("creates a fresh tools-disabled Bedrock pre-commit session", async () => {
  const config = createRuntimeConfig({
    model: { provider: "bedrock", model_id: "test-model" },
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
  const factory = createBedrockPreCommitReviewSessionFactory({ transport, config });
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
});
