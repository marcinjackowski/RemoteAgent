import {
  EngineeringStage,
  canonicalDigest,
  engineeringArtifactDigest,
} from "@remoteagent/contracts";
import {
  EngineeringControlPlaneRepository,
  EngineeringRecoveryRepository,
  productionRuntime,
} from "@remoteagent/database";
import { gitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";
import type {
  RuntimeConfig,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeTransport,
} from "@remoteagent/bedrock-runtime";
import { afterEach, expect, it } from "vitest";

import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import {
  createBedrockEngineeringStageExecutor,
  createPostgresEngineeringRuntimePort,
  localCommitIntentDescriptor,
  type EngineeringGateStageExecutor,
  type EngineeringLocalCommitStageExecutor,
  type EngineeringSliceImplementationStageExecutor,
} from "../src/engineering-workflow.js";
import { engineeringContextPacketDigest } from "../src/context.js";
import { classifyEngineeringRecovery } from "../src/engineering-recovery.js";
import {
  createEngineeringQualificationFixture,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const available = await ensurePostgres();
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

class NoCallTransport implements RuntimeTransport {
  public calls = 0;
  public async converse(
    _request: RuntimeRequest,
    _config: RuntimeConfig,
  ): Promise<RuntimeResponse> {
    this.calls += 1;
    throw new Error("stage-aware classification must not call the model");
  }
}

function identity(fixture: EngineeringQualificationFixture) {
  return {
    unit: {
      workUnit: {
        schema_version: 1 as const,
        work_unit_id: fixture.ids.workUnitId,
        case_id: fixture.ids.caseId,
        role: "IMPLEMENTER" as const,
        status: "DISPATCHED" as const,
        objective: "stage-aware recovery fixture",
        authoritative_scope: {
          connection_ids: [],
          repo_allowlist: [fixture.ids.repositoryId],
          can_write_workspace: true,
        },
        run_id: fixture.ids.runId,
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
    },
    run: { runId: fixture.ids.runId, checkpointRevision: 0 },
  };
}

const fixtures: EngineeringQualificationFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.drop()));
});

describeIntegration(
  "stage-aware cross-fence engineering recovery",
  () => {
    it("binds a conservative retry plan without replaying a STARTED model call", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-model" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-model-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const control = new EngineeringControlPlaneRepository(productionRuntime(), fixture.jobs);
      const transport = new NoCallTransport();
      const stageExecutor = createBedrockEngineeringStageExecutor({
        transport,
        config: fixture.modelConfig,
      });
      const port = createPostgresEngineeringRuntimePort({
        db: fixture.db,
        lease,
        jobs: fixture.jobs,
        readContext: fixture.readContext,
        executor: stageExecutor,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        policy: { riskFacts: smallRiskFacts, proposedProcessClass: "SMALL" },
        controlPlane: control,
      });
      await port.open(identity(fixture));
      const stage = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_PLANNING,
        attempt: 1,
      } as const;
      await port.prepareContext(stage);
      await port.commitStarted(stage);
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      expect(
        await fixture.db.query(
          `SELECT j.status,j.job_type,j.payload->>'reason' AS reason,
                  j.lease_expires_at <= now() AS expired,p.status AS proposal_status,
                  o.operation_kind
             FROM jobs j
             LEFT JOIN engineering_write_proposals p ON p.job_id=j.job_id
             LEFT JOIN engineering_operations o ON o.job_id=j.job_id
            WHERE j.job_id=$1`,
          [lease.jobId],
        ),
      ).toMatchObject({
        rows: [
          {
            status: "LEASED",
            job_type: "agent.implementer",
            reason: "engineering_approval",
            expired: true,
            proposal_status: "GRANTED",
            operation_kind: "engineering.stage.slice_planning",
          },
        ],
      });
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      const materialized = await recoveries.materializeExpired(fixture.db, {
        workflowDeadlineMs: 900_000,
      });
      expect(materialized.recoveries).toHaveLength(1);
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-model",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("model recovery was not claimed");
      const result = await classifyEngineeringRecovery({
        db: fixture.db,
        lease: recoveryLease,
        readContext: fixture.readContext,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        stageConfigDigest: () => stageExecutor.configDigest,
        stageSchemaDigest: (value) => stageExecutor.schemaDigest(value),
        controlPlane: control,
        recoveries,
      });
      expect(result.status).toBe("RETRY_READY");
      expect(result.plan).toMatchObject({
        classification: "RETRY_MODEL",
        budget_reservation: { stage_attempts: 1, model_calls: 2 },
      });
      expect(result.plan.operation?.context_packet_digest).toBe(
        canonicalDigest({
          packet: result.status === "RETRY_READY" ? result.context.packet : "",
          packet_bytes: result.status === "RETRY_READY" ? result.context.packetBytes : 0,
        }),
      );
      expect(transport.calls).toBe(0);
      expect(
        await fixture.db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM engineering_artifact_revisions WHERE run_id=$1",
          [fixture.ids.runId],
        ),
      ).toMatchObject({ rows: [{ count: "0" }] });
    });

    it("refuses a model retry when the rebuilt context packet changed across the fence", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-context" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-context-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const control = new EngineeringControlPlaneRepository(productionRuntime(), fixture.jobs);
      const transport = new NoCallTransport();
      const stageExecutor = createBedrockEngineeringStageExecutor({
        transport,
        config: fixture.modelConfig,
      });
      const port = createPostgresEngineeringRuntimePort({
        db: fixture.db,
        lease,
        jobs: fixture.jobs,
        readContext: fixture.readContext,
        executor: stageExecutor,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        policy: { riskFacts: smallRiskFacts, proposedProcessClass: "SMALL" },
        controlPlane: control,
      });
      await port.open(identity(fixture));
      const stage = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_PLANNING,
        attempt: 1,
      } as const;
      await port.prepareContext(stage);
      await port.commitStarted(stage);
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      await recoveries.materializeExpired(fixture.db, { workflowDeadlineMs: 900_000 });
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-context",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("context recovery was not claimed");

      await expect(
        classifyEngineeringRecovery({
          db: fixture.db,
          lease: recoveryLease,
          readContext: fixture.readContext,
          writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
          stageConfigDigest: () => canonicalDigest({ stale: "config" }),
          stageSchemaDigest: (value) => stageExecutor.schemaDigest(value),
          controlPlane: control,
          recoveries,
        }),
      ).rejects.toThrow(/config, schema, or deadline changed/);
      expect(
        await fixture.db.query<{ plan: unknown }>(
          "SELECT plan FROM engineering_recoveries WHERE recovery_id=$1",
          [recoveryLease.recovery.recovery_id],
        ),
      ).toMatchObject({ rows: [{ plan: null }] });

      await expect(
        classifyEngineeringRecovery({
          db: fixture.db,
          lease: recoveryLease,
          readContext: async (input) => {
            const current = await fixture.readContext(input);
            const packet = `${current.packet}\nchanged-after-fence`;
            return { ...current, packet, packetBytes: Buffer.byteLength(packet, "utf8") };
          },
          writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
          stageConfigDigest: () => stageExecutor.configDigest,
          stageSchemaDigest: (value) => stageExecutor.schemaDigest(value),
          controlPlane: control,
          recoveries,
        }),
      ).rejects.toThrow(/context packet changed across the fence/);
      expect(transport.calls).toBe(0);
      expect(
        await fixture.db.query<{ plan: unknown }>(
          "SELECT plan FROM engineering_recoveries WHERE recovery_id=$1",
          [recoveryLease.recovery.recovery_id],
        ),
      ).toMatchObject({ rows: [{ plan: null }] });
    });

    it("terminalizes a clean between-stage recovery after durable cancellation", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-cancel" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-cancel-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      await fixture.db.query("UPDATE cases SET status='CANCELLED' WHERE case_id=$1", [
        fixture.ids.caseId,
      ]);
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      await recoveries.materializeExpired(fixture.db, { workflowDeadlineMs: 900_000 });
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-cancel",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("cancel recovery was not claimed");
      const result = await classifyEngineeringRecovery({
        db: fixture.db,
        lease: recoveryLease,
        readContext: fixture.readContext,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        stageConfigDigest: () => canonicalDigest({ unused: "config" }),
        stageSchemaDigest: () => canonicalDigest({ unused: "schema" }),
        recoveries,
      });
      expect(result).toMatchObject({
        status: "TERMINAL",
        terminal: "CANCELLED",
        plan: { classification: "CANCELLED" },
      });
      expect(
        await fixture.db.query<{ status: string }>(
          "SELECT status FROM engineering_recoveries WHERE recovery_id=$1",
          [recoveryLease.recovery.recovery_id],
        ),
      ).toMatchObject({ rows: [{ status: "CANCELLED" }] });
    });

    it("refuses deployment path-policy drift before publishing continuation", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-policy" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-policy-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      await recoveries.materializeExpired(fixture.db, { workflowDeadlineMs: 900_000 });
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-policy",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("policy recovery was not claimed");
      await expect(
        classifyEngineeringRecovery({
          db: fixture.db,
          lease: recoveryLease,
          readContext: fixture.readContext,
          writeDeploymentPolicy: {
            ...fixture.config.writeDeploymentPolicy,
            write_path_allowlist: ["docs"],
          },
          stageConfigDigest: () => canonicalDigest({ unused: "config" }),
          stageSchemaDigest: () => canonicalDigest({ unused: "schema" }),
          recoveries,
        }),
      ).rejects.toThrow(/deployment policy changed/);
      expect(
        await fixture.db.query<{ plan: unknown }>(
          "SELECT plan FROM engineering_recoveries WHERE recovery_id=$1",
          [recoveryLease.recovery.recovery_id],
        ),
      ).toMatchObject({ rows: [{ plan: null }] });
    });

    it("keeps an unproven mutating implementation effect AMBIGUOUS", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-mutating" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-mutating-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const control = new EngineeringControlPlaneRepository(productionRuntime(), fixture.jobs);
      const stageExecutor = createBedrockEngineeringStageExecutor({
        transport: new NoCallTransport(),
        config: fixture.modelConfig,
      });
      let implementationCalls = 0;
      const implementationExecutor: EngineeringSliceImplementationStageExecutor = {
        configDigest: canonicalDigest({ implementation: "config" }),
        schemaDigest: canonicalDigest({ implementation: "schema" }),
        execute: async () => {
          implementationCalls += 1;
          throw new Error("unknown cross-fence mutation must not execute");
        },
      };
      const port = createPostgresEngineeringRuntimePort({
        db: fixture.db,
        lease,
        jobs: fixture.jobs,
        readContext: fixture.readContext,
        executor: stageExecutor,
        implementationExecutor,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        policy: { riskFacts: smallRiskFacts, proposedProcessClass: "SMALL" },
        controlPlane: control,
      });
      await port.open(identity(fixture));
      const stage = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_IMPLEMENTATION,
        attempt: 1,
      } as const;
      await port.prepareContext(stage);
      await port.commitStarted(stage);
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      await recoveries.materializeExpired(fixture.db, { workflowDeadlineMs: 900_000 });
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-mutating",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("mutating recovery was not claimed");
      const result = await classifyEngineeringRecovery({
        db: fixture.db,
        lease: recoveryLease,
        readContext: fixture.readContext,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        stageConfigDigest: () => implementationExecutor.configDigest,
        stageSchemaDigest: () => implementationExecutor.schemaDigest,
        controlPlane: control,
        recoveries,
      });
      expect(result).toMatchObject({
        status: "TERMINAL",
        terminal: "AMBIGUOUS",
        plan: { classification: "AMBIGUOUS" },
      });
      expect(implementationCalls).toBe(0);
    });

    it("selects the outer GATE operation and repairs it only from receipt recovery", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-gate" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-gate-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const control = new EngineeringControlPlaneRepository(productionRuntime(), fixture.jobs);
      const stageExecutor = createBedrockEngineeringStageExecutor({
        transport: new NoCallTransport(),
        config: fixture.modelConfig,
      });
      let executeCalls = 0;
      let recoverCalls = 0;
      let innerOperationId: string | null = null;
      let innerCompletionId: string | null = null;
      const gateExecutor: EngineeringGateStageExecutor = {
        configDigest: canonicalDigest({ gate: "cross-fence" }),
        schemaDigest: canonicalDigest({ schema: "cross-fence-gate" }),
        execute: async () => {
          executeCalls += 1;
          throw new Error("gate command must not execute during recovery");
        },
        recover: async ({ binding, recoveryOnly, recoveryObserveCompletion }) => {
          recoverCalls += 1;
          expect(recoveryOnly).toBe(true);
          if (
            recoveryObserveCompletion === undefined ||
            innerOperationId === null ||
            innerCompletionId === null
          ) {
            throw new Error("exact inner gate completion recovery was not bound");
          }
          await recoveryObserveCompletion({
            operationId: innerOperationId,
            completionId: innerCompletionId,
          });
          return {
            status: "RECOVERED",
            artifact: {
              schema_version: 1,
              artifact_kind: "TerminalReason",
              case_id: binding.caseId,
              run_id: binding.runId,
              revision: binding.checkpointRevision,
              reason: "BLOCKED",
              detail: "receipt-only qualification artifact",
            },
          };
        },
      };
      const port = createPostgresEngineeringRuntimePort({
        db: fixture.db,
        lease,
        jobs: fixture.jobs,
        readContext: fixture.readContext,
        executor: stageExecutor,
        gateExecutor,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        policy: { riskFacts: smallRiskFacts, proposedProcessClass: "SMALL" },
        controlPlane: control,
      });
      await port.open(identity(fixture));
      const stage = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.GATE_EXECUTION,
        attempt: 1,
      } as const;
      await port.prepareContext(stage);
      await port.commitStarted(stage);

      const inner = await control.bindOperationIntent(fixture.db, lease, {
        operationId: "inner-gate-newer-than-outer",
        runId: fixture.ids.runId,
        stage: EngineeringStage.GATE_EXECUTION,
        stageAttempt: 1,
        operationKind: "engineering.verification.gate",
        effectClass: "COMMAND",
        descriptor: { exact: "inner receipt" },
        configDigest: canonicalDigest({ inner: "config" }),
        schemaDigest: canonicalDigest({ inner: "schema" }),
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      innerOperationId = inner.operation_id;
      await control.commitOperationStarted(fixture.db, lease, { operationId: inner.operation_id });
      innerCompletionId = await fixture.jobs.recordCompletion(fixture.db, {
        intentId: inner.intent_id,
        jobId: lease.jobId,
        outcome: "SUCCEEDED",
        receipt: { exact: true },
        lease,
      });
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      expect(
        await fixture.db.query(
          `SELECT j.status,j.job_type,j.payload->>'reason' AS reason,
                  j.lease_expires_at <= now() AS expired,p.status AS proposal_status,
                  array_agg(o.operation_kind ORDER BY o.recorded_at) AS operation_kinds
             FROM jobs j
             LEFT JOIN engineering_write_proposals p ON p.job_id=j.job_id
             LEFT JOIN engineering_operations o ON o.job_id=j.job_id
            WHERE j.job_id=$1
            GROUP BY j.status,j.job_type,j.payload,j.lease_expires_at,p.status`,
          [lease.jobId],
        ),
      ).toMatchObject({
        rows: [
          {
            status: "LEASED",
            job_type: "agent.implementer",
            reason: "engineering_approval",
            expired: true,
            proposal_status: "GRANTED",
            operation_kinds: ["engineering.stage.gate_execution", "engineering.verification.gate"],
          },
        ],
      });
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      const materialized = await recoveries.materializeExpired(fixture.db, {
        workflowDeadlineMs: 900_000,
      });
      expect(materialized.recoveries).toHaveLength(1);
      expect(materialized.recoveries[0]?.source_operation_id).not.toBe(inner.operation_id);
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-gate",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("gate recovery was not claimed");
      const result = await classifyEngineeringRecovery({
        db: fixture.db,
        lease: recoveryLease,
        readContext: fixture.readContext,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        stageConfigDigest: () => stageExecutor.configDigest,
        stageSchemaDigest: (value) => stageExecutor.schemaDigest(value),
        gateExecutor,
        controlPlane: control,
        recoveries,
      });
      expect(result.status).toBe("CONTINUATION_READY");
      expect(result.plan.classification).toBe("RECOVER_GATE_RECEIPTS");
      expect(executeCalls).toBe(0);
      expect(recoverCalls).toBe(1);
      expect(
        await control.readOperationCompletion(fixture.db, {
          operationId: inner.operation_id,
        }),
      ).toMatchObject({ completion_observed: true });
      expect(
        await control.readOperationCompletion(fixture.db, {
          operationId: materialized.recoveries[0]!.source_operation_id!,
        }),
      ).toMatchObject({ completion_observed: true });
    });

    it("observes LOCAL_COMMIT without executing a second commit across the fence", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "cross-fence-commit" });
      fixtures.push(fixture);
      const approvalId = "cross-fence-commit-approval";
      await fixture.grantWriteApproval({ approvalId, processClass: "SMALL" });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const control = new EngineeringControlPlaneRepository(productionRuntime(), fixture.jobs);
      const exactBinding = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.LOCAL_COMMIT,
        attempt: 1,
      } as const;
      const context = await fixture.readContext({
        caseId: exactBinding.caseId,
        workUnitId: exactBinding.workUnitId,
        runId: exactBinding.runId,
        stage: exactBinding.stage,
      });
      const operationId = "cross-fence-local-commit-operation";
      const accepted = [
        {
          slice_id: "slice-1",
          attempt: 1,
          evidence_digest: canonicalDigest({ evidence: "accepted" }),
          review_digest: canonicalDigest({ review: "accepted" }),
        },
      ];
      const commit = gitEvidenceBoundCommitDescriptor.parse({
        schema_version: 1,
        operation_id: operationId,
        case_id: exactBinding.caseId,
        work_unit_id: exactBinding.workUnitId,
        workspace_id: "cross-fence-workspace",
        repository_id: fixture.ids.repositoryId,
        run_id: exactBinding.runId,
        checkpoint_revision: exactBinding.checkpointRevision,
        branch_name: `remoteagent/${exactBinding.caseId}`,
        expected_parent_sha: "b".repeat(40),
        exact_paths: ["src/qualified.ts"],
        message: `qualified local commit\n\n[remoteagent-operation:${operationId}]`,
        operation_marker: `[remoteagent-operation:${operationId}]`,
        tree_digest: canonicalDigest({ tree: "qualified" }),
        actual_diff_digest: canonicalDigest({ diff: "actual" }),
        raw_patch_digest: canonicalDigest({ patch: "raw" }),
        accepted,
        evidence_digest: canonicalDigest(accepted.map((pair) => pair.evidence_digest)),
        review_digest: canonicalDigest(accepted.map((pair) => pair.review_digest)),
        final_verification_digest: canonicalDigest({ verification: "verified" }),
      });
      const descriptor = localCommitIntentDescriptor.parse({
        case_id: exactBinding.caseId,
        work_unit_id: exactBinding.workUnitId,
        run_id: exactBinding.runId,
        checkpoint_revision: exactBinding.checkpointRevision,
        stage: exactBinding.stage,
        attempt: exactBinding.attempt,
        process_class: "SMALL",
        context_snapshot_digest: context.snapshotDigest,
        context_manifest: context.compiled.manifest,
        context_manifest_digest: engineeringArtifactDigest(context.compiled.manifest),
        context_packet_digest: engineeringContextPacketDigest(context),
        commit,
      });
      const localConfigDigest = canonicalDigest({ local: "commit-config" });
      const localSchemaDigest = canonicalDigest({ local: "commit-schema" });
      const operation = await control.bindOperationIntent(fixture.db, lease, {
        operationId,
        runId: exactBinding.runId,
        stage: exactBinding.stage,
        stageAttempt: exactBinding.attempt,
        operationKind: "engineering.stage.local_commit",
        effectClass: "MUTATING_SIDE_EFFECT",
        descriptor,
        configDigest: localConfigDigest,
        schemaDigest: localSchemaDigest,
        deadlineAt: new Date(Date.now() + 600_000).toISOString(),
      });
      await control.commitOperationStarted(fixture.db, lease, {
        operationId: operation.operation_id,
      });
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      const recoveries = new EngineeringRecoveryRepository(productionRuntime());
      expect(
        (await recoveries.materializeExpired(fixture.db, { workflowDeadlineMs: 900_000 }))
          .recoveries,
      ).toHaveLength(1);
      const recoveryLease = await recoveries.claimRecovery(fixture.db, {
        owner: "stage-recovery-commit",
        leaseMs: 30_000,
      });
      if (recoveryLease === null) throw new Error("commit recovery was not claimed");
      let executeCalls = 0;
      let recoverCalls = 0;
      const localCommitExecutor: EngineeringLocalCommitStageExecutor = {
        configDigest: localConfigDigest,
        schemaDigest: localSchemaDigest,
        prepare: async () => commit,
        execute: async () => {
          executeCalls += 1;
          throw new Error("cross-fence recovery must never create a second commit");
        },
        recover: async ({ descriptor: durable }) => {
          recoverCalls += 1;
          expect(durable).toEqual(commit);
          return {
            schema_version: 1,
            artifact_kind: "LocalCommitReceipt",
            case_id: exactBinding.caseId,
            run_id: exactBinding.runId,
            revision: 0,
            authority: "SERVER_OWNED",
            receipt_id: "cross-fence-local-commit-receipt",
            branch: durable.branch_name,
            commit_sha: "a".repeat(40),
            parent_sha: durable.expected_parent_sha,
            tree_digest: durable.tree_digest,
            diff_digest: durable.actual_diff_digest,
            evidence_digest: durable.evidence_digest,
            review_digest: durable.review_digest,
            verification_decision_digest: durable.final_verification_digest,
          };
        },
      };
      const result = await classifyEngineeringRecovery({
        db: fixture.db,
        lease: recoveryLease,
        readContext: fixture.readContext,
        writeDeploymentPolicy: fixture.config.writeDeploymentPolicy,
        stageConfigDigest: () => canonicalDigest({ unused: "config" }),
        stageSchemaDigest: () => canonicalDigest({ unused: "schema" }),
        localCommitExecutor,
        controlPlane: control,
        recoveries,
      });
      expect(result.status).toBe("CONTINUATION_READY");
      expect(result.plan.classification).toBe("OBSERVE_LOCAL_COMMIT");
      expect(executeCalls).toBe(0);
      expect(recoverCalls).toBe(1);
      expect(await control.readOperationCompletion(fixture.db, { operationId })).toMatchObject({
        completion_observed: true,
      });
    });
  },
  available,
);
