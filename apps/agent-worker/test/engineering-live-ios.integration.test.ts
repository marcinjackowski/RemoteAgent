import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CaseMessageRepository,
  CaseRepository,
  ConnectionRepository,
  DiscordBindingRepository,
  EngineeringControlPlaneRepository,
  EngineeringApprovalIngressRepository,
  JobStore,
  OwnerRepository,
  WorkspaceRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { MetricRegistry, StructuredLogger } from "@remoteagent/observability";
import { expect, it } from "vitest";

import { createEngineeringRoleContextReader } from "../src/context.js";
import {
  createEngineeringDebugTransport,
  EngineeringDebugJournal,
  closeExportAndDropEngineeringRun,
  exportEngineeringEvidence,
  engineeringCompilerDiagnosticJournalRows,
  engineeringXcodeTestDiagnosticJournalRows,
  engineeringDebugErrorCode,
  engineeringDebugErrorDetailCode,
  engineeringDebugErrorDigest,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";
import {
  createEngineeringRoleModelComposition,
  loadEngineeringExecutionConfig,
  createProductionEngineeringRuntimePort,
  engineeringExecutionConfigWithGateFailureMapping,
} from "../src/engineering-execution.js";
import {
  ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
  ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS,
  createAfterEngineeringLivePreflight,
  type EngineeringLiveQualificationAuthority,
  engineeringLiveBenchmarkPathsFromEnv,
  engineeringLiveQualificationSelectionFromEnv,
  projectEngineeringLiveTerminal,
} from "../src/engineering-live-qualification.js";
import { engineeringModelRoutingFromEnv } from "../src/engineering-model-routing.js";
import { createWorkerHandlers } from "../src/handlers.js";
import type { RuntimePumpResult } from "@remoteagent/agent-orchestrator";
import { WorkerPersistence } from "../src/persistence.js";
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";
import {
  createXcodeVerificationGatePlatformAdapter,
  xcodeDestinationFromGateCatalog,
} from "../src/xcode-gate-adapter.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { observeEngineeringLiveCommit } from "./engineering-live-commit-observation.js";
import {
  projectAcceptedLocalCommit,
  selectLocalCommitOperationId,
  type AcceptedLocalCommitProjection,
} from "./engineering-live-accepted-commit.js";
import { projectAcceptedSliceGates } from "./engineering-live-accepted-slice-gates.js";
import { createAfterMobl2023LiveProfileContract } from "./engineering-live-full-flow-profile-contract.js";

const enabled = process.env.RA_RUN_LIVE_IOS_ENGINEERING === "1";
const live = enabled ? it : it.skip;
const runExecutable = promisify(execFile);

function runtimePumpResult(value: unknown): RuntimePumpResult | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const terminalReasonCodes = new Set([
    "COMPLETED",
    "CANCELLED",
    "DEADLINE_EXCEEDED",
    "STAGE_LIMIT_EXHAUSTED",
    "CALL_LIMIT_EXHAUSTED",
    "NO_PROGRESS",
    "OSCILLATION",
    "APPROVAL_BLOCKED",
    "SLICE_BLOCKED",
    "GATE_CORRECTION_LIMIT_EXHAUSTED",
  ]);
  return typeof candidate.progressed !== "number" ||
    !Array.isArray(candidate.ambiguous) ||
    !candidate.ambiguous.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.blocked) ||
    !candidate.blocked.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.waiting) ||
    !candidate.waiting.every((entry) => typeof entry === "string") ||
    !Array.isArray(candidate.merges) ||
    (candidate.terminalReasonCode !== undefined &&
      (typeof candidate.terminalReasonCode !== "string" ||
        !terminalReasonCodes.has(candidate.terminalReasonCode)))
    ? null
    : (value as RuntimePumpResult);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required for live iOS smoke`);
  return value;
}

live(
  "runs direct production Engineering against sondermind-ios and creates one local commit",
  async () => {
    const objective = required("RA_LIVE_ENGINEERING_OBJECTIVE");
    const configPath = required("RA_ENGINEERING_CONFIG_PATH");
    const xcodebuildPath = await realpath(required("RA_XCODEBUILD_PATH"));
    const developerDir = await realpath(required("DEVELOPER_DIR"));
    const liveSelection = engineeringLiveQualificationSelectionFromEnv();
    if (liveSelection === null) throw new Error("live Engineering selection is unavailable");
    const created = await createTestDatabase();
    const db = created.db as unknown as Database;
    const runtime = productionRuntime();
    const suffix = runtime.ids.next("ra045");
    const ids = {
      ownerId: `${suffix}-owner`,
      connectionId: `${suffix}-connection`,
      caseId: `${suffix}-case`,
      threadId: `${suffix}-thread`,
      channelId: `${suffix}-channel`,
      messageId: `${suffix}-task`,
      proposeInteractionId: `${suffix}-propose`,
      grantInteractionId: `${suffix}-grant`,
    } as const;
    let debugJournal: EngineeringDebugJournal | undefined;
    let evidenceRoot: string | undefined;
    let evidenceRunId: string | undefined;
    let evidenceJobId: string | undefined;
    let liveAuthority: EngineeringLiveQualificationAuthority | undefined;

    try {
      const config = await loadEngineeringExecutionConfig(configPath);
      const sourceRepository = config.workspaceConfig.repositories[config.repositoryId];
      if (sourceRepository === undefined) throw new Error("configured repository is unavailable");
      const generator = config.generatorCatalog?.definitions.find(
        (entry) => entry.generator_id === "mobl-2023-shared-assets",
      );
      if (generator === undefined)
        throw new Error("configured shared-assets generator is unavailable");
      const nodeExecutable = await realpath(process.execPath);
      const swiftgenExecutable = await realpath(
        join(sourceRepository.sourcePath, "swiftgen/bin/swiftgen"),
      );
      const modelRouting = await engineeringModelRoutingFromEnv();
      if (modelRouting === null) {
        throw new Error("RA_ENGINEERING_MODEL_CONFIG_PATH is required for live iOS smoke");
      }
      const benchmarkPaths = engineeringLiveBenchmarkPathsFromEnv();
      if (benchmarkPaths === null) {
        throw new Error("live Engineering benchmark manifest and overlay paths are required");
      }
      let mappedConfig = config;
      const preflightResult = await createAfterEngineeringLivePreflight(
        {
          paths: benchmarkPaths,
          executionConfigPath: configPath,
          selection: liveSelection,
          executionConfig: config,
          routing: modelRouting,
          hostProbes: {
            xcodebuildPath,
            rootPath: config.artifactRoot,
            probePostgres: async () => {
              const result = await db.query<{ value: number }>("SELECT 1 AS value");
              return result.rows[0]?.value;
            },
          },
          requireHostEvidence: true,
        },
        (preflight) => {
          mappedConfig = engineeringExecutionConfigWithGateFailureMapping(
            config,
            preflight.mapping,
          );
          return createAfterMobl2023LiveProfileContract(
            {
              manifest: preflight.resolved.manifest.manifest,
              executionConfig: mappedConfig,
              nodeExecutable,
              swiftgenExecutable,
              xcodebuildPath,
            },
            () =>
              createEngineeringRoleModelComposition({
                routing: modelRouting,
                executionConfig: mappedConfig,
                decorateTransport: (binding) =>
                  createEngineeringDebugTransport(binding.transport, {
                    role: binding.role,
                    invocation: binding.invocation,
                  }),
              }),
          );
        },
      );
      const profileContract = preflightResult.value.contract;
      const incrementalSafetyContract = profileContract.positiveSourceProbe;
      const finalSafetyContract = profileContract.negativeSourceProbe;
      liveAuthority = preflightResult.preflight.authority;
      process.stdout.write(
        `RA045_PREFLIGHT=${JSON.stringify(preflightResult.preflight.evidence ?? null)}\n`,
      );
      const roleModels = preflightResult.value.value;
      expect(mappedConfig.gateFailureMapping).toEqual(preflightResult.preflight.mapping);
      expect(mappedConfig.gateFailureMapping?.mapping_digest).toBe(
        preflightResult.preflight.mapping.mapping_digest,
      );
      const destination = xcodeDestinationFromGateCatalog(
        config.catalog.definitions,
        xcodebuildPath,
      );
      debugJournal = await EngineeringDebugJournal.create({
        artifactRoot: config.artifactRoot,
        invocationId: liveAuthority.invocation_id,
      });
      process.stdout.write(
        `RA045_DEBUG_LOG=${JSON.stringify({ file_name: debugJournal.fileName })}\n`,
      );
      evidenceRoot = config.artifactRoot;
      await runExecutable(
        incrementalSafetyContract.executable,
        [...incrementalSafetyContract.argv],
        {
          cwd: join(sourceRepository.sourcePath, incrementalSafetyContract.relative_cwd),
        },
      );
      await expect(
        runExecutable(finalSafetyContract.executable, [...finalSafetyContract.argv], {
          cwd: join(sourceRepository.sourcePath, finalSafetyContract.relative_cwd),
        }),
      ).rejects.toMatchObject({ code: 1 });
      const sourceHead = await import("node:child_process").then(({ execFileSync }) =>
        execFileSync("git", ["-C", sourceRepository.sourcePath, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      );

      await new OwnerRepository().insert(db, { ownerId: ids.ownerId, displayName: "RA-045 owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: ids.connectionId,
        ownerId: ids.ownerId,
        provider: "jira",
        displayName: "RA-045 direct task source",
      });
      await new CaseRepository().insert(db, {
        caseId: ids.caseId,
        ownerId: ids.ownerId,
        status: "IMPLEMENTING",
        integrationScope: { providers: ["jira"], connection_ids: [ids.connectionId] },
        discordThreadId: ids.threadId,
      });
      const bindings = new DiscordBindingRepository();
      await bindings.ensure(db, {
        caseId: ids.caseId,
        ownerId: ids.ownerId,
        channelId: ids.channelId,
      });
      await db.withTransaction((tx) =>
        bindings.setThread(tx, ids.caseId, {
          threadId: ids.threadId,
          rootMessageId: `${suffix}-root`,
        }),
      );
      await db.withTransaction((tx) =>
        new CaseMessageRepository().append(tx, {
          messageId: ids.messageId,
          caseId: ids.caseId,
          role: "OWNER",
          trust: "UNTRUSTED_DATA",
          body: objective,
        }),
      );
      const persistence = new WorkerPersistence(db, runtime);
      await persistence.ensureBaselineCheckpoint(ids.caseId);

      const ingress = new EngineeringApprovalIngressRepository({
        runtime,
        deploymentPolicy: config.writeDeploymentPolicy,
        proposalTtlMs: 60 * 60_000,
      });
      const proposed = await ingress.propose(db, {
        caseId: ids.caseId,
        actorId: ids.ownerId,
        interactionId: ids.proposeInteractionId,
      });
      if (proposed.status !== "created") {
        throw new Error(`direct engineering proposal was not created: ${proposed.status}`);
      }
      const granted = await ingress.respond(db, {
        caseId: ids.caseId,
        actorId: ids.ownerId,
        interactionId: ids.grantInteractionId,
        proposalId: proposed.proposal.proposal_id,
        checkpointRevision: proposed.proposal.authorization_scope.checkpoint_revision,
        choice: "grant",
      });
      if (granted.status !== "granted") {
        throw new Error(`direct engineering proposal was not granted: ${granted.status}`);
      }
      evidenceRunId = granted.runId;
      evidenceJobId = granted.jobId;

      const jobs = new JobStore(runtime);
      const lease = await jobs.claim(db, {
        owner: `${suffix}-worker`,
        leaseMs: ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
      });
      if (lease === null || lease.jobId !== granted.jobId) {
        throw new Error("direct engineering job was not the exact claimed lease");
      }
      await debugJournal.append({
        event: "RUN_STARTED",
        case_id: ids.caseId,
        run_id: granted.runId,
        model: "role-routed-subscription",
        base_sha: sourceHead,
        config_digest: config.configDigest,
      });
      const knownSecrets: string[] = [];
      const metrics = new MetricRegistry(knownSecrets);
      const readContext = createEngineeringRoleContextReader({
        db,
        metrics,
        knownSecrets,
        beforeRead: (caseId) => persistence.ensureBaselineCheckpoint(caseId).then(() => undefined),
      });
      const platformAdapter = await createXcodeVerificationGatePlatformAdapter({
        xcodebuildPath,
        developerDir,
        destination,
        knownSecrets,
      });
      const makePort = () => {
        const port = createProductionEngineeringRuntimePort({
          db,
          jobs,
          lease,
          config: mappedConfig,
          transport: roleModels.implementation.transport,
          modelConfig: roleModels.implementation.config,
          readContext,
          stageExecutor: roleModels.stageExecutor,
          reviewSessionFactory: roleModels.reviewSessionFactory.createSession,
          implementationModelInvocation: roleModels.implementation.invocation,
          reviewModelInvocation: roleModels.reviewer.invocation,
          modelPreflight: roleModels.modelPreflight,
          platformAdapter,
          workflowDeadlineMs: ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
          metrics,
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
        return new Proxy(port, {
          get(target, property, receiver) {
            if (property === "invokeAndRecord") {
              return async (input: Parameters<typeof target.invokeAndRecord>[0]) => {
                try {
                  return await target.invokeAndRecord(input);
                } catch (error) {
                  await debugJournal?.append({
                    event: "STAGE_ERROR",
                    stage: input.binding.stage,
                    error_name: error instanceof Error ? error.name : "UnknownError",
                    error_code: engineeringDebugErrorCode(error),
                    error_detail_code: engineeringDebugErrorDetailCode(error),
                    error_digest: engineeringDebugErrorDigest(error),
                  });
                  throw error;
                }
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const pumpResultHolder: { value: unknown } = { value: null };
      const handlers = createWorkerHandlers({
        persistence,
        roles: {},
        logger: new StructuredLogger({ knownSecrets, sink: { log: () => undefined } }),
        db,
        jobs,
        heartbeatIntervalMs: 60_000,
        engineering: makePort,
        engineeringInvocation: {
          async run(_lease, work) {
            const result = await work();
            pumpResultHolder.value = result;
            return result;
          },
        },
      });
      const recordDiagnostic = async (error: unknown | null): Promise<string[]> => {
        const diagnosticArtifacts = await db.query<{
          artifact_kind: string;
          stage: string;
          stage_attempt: number;
          payload: unknown;
          reason: string | null;
          detail: string | null;
          review_decision: string | null;
          verification_decision: string | null;
        }>(
          `SELECT artifact_kind,stage,stage_attempt,payload,
                  CASE WHEN artifact_kind='TerminalReason' THEN payload->>'reason' ELSE NULL END AS reason,
                  CASE WHEN artifact_kind='TerminalReason' THEN payload->>'detail' ELSE NULL END AS detail,
                  CASE WHEN artifact_kind='ReviewDecision' THEN payload->>'decision' ELSE NULL END AS review_decision,
                  CASE WHEN artifact_kind='VerificationDecision' THEN payload->>'decision' ELSE NULL END AS verification_decision
             FROM engineering_artifact_revisions
            WHERE run_id=$1 ORDER BY revision`,
          [granted.runId],
        );
        const diagnosticOperations = await db.query<{
          stage: string;
          stage_attempt: number;
          effect_class: string;
          started: boolean;
          completed: boolean;
        }>(
          `SELECT o.stage,o.stage_attempt,o.effect_class,
                  EXISTS (
                    SELECT 1 FROM engineering_stage_events e
                     WHERE e.operation_id=o.operation_id AND e.event_type='STARTED'
                  ) AS started,
                  EXISTS (SELECT 1 FROM job_completions c WHERE c.intent_id=o.intent_id) AS completed
             FROM engineering_operations o
            WHERE o.run_id=$1 ORDER BY o.recorded_at,o.operation_id`,
          [granted.runId],
        );
        const diagnosticGates = await db.query<{
          gate_id: string;
          target: string;
          outcome: string;
          exit_code: number | null;
          duration_ms: number;
          tree_digest: string;
          config_digest: string;
          command_digest: string;
          log_digest: string | null;
        }>(
          `SELECT c.receipt->>'gate_id' AS gate_id,
                  c.receipt->>'target' AS target,
                  c.receipt->>'outcome' AS outcome,
                  (c.receipt->>'exit_code')::integer AS exit_code,
                  (c.receipt->>'duration_ms')::integer AS duration_ms,
                  c.receipt->>'tree_digest' AS tree_digest,
                  c.receipt->>'config_digest' AS config_digest,
                  c.receipt->>'command_digest' AS command_digest,
                  c.receipt->>'log_digest' AS log_digest
             FROM job_completions c
             JOIN job_intents i ON i.intent_id=c.intent_id
            WHERE i.job_id=$1
              AND i.kind='engineering.verification.gate'
            ORDER BY c.recorded_at,c.completion_id`,
          [lease.jobId],
        );
        const compilerDiagnostics = engineeringCompilerDiagnosticJournalRows(
          diagnosticArtifacts.rows
            .filter((artifact) => artifact.artifact_kind === "GateFailure")
            .map((artifact) => ({
              stage_attempt: artifact.stage_attempt,
              payload: artifact.payload,
            })),
        );
        const testDiagnostics = engineeringXcodeTestDiagnosticJournalRows(
          diagnosticArtifacts.rows
            .filter((artifact) => artifact.artifact_kind === "GateFailure")
            .map((artifact) => ({
              stage_attempt: artifact.stage_attempt,
              payload: artifact.payload,
            })),
        );
        process.stdout.write(
          `RA045_DIAGNOSTIC=${JSON.stringify({
            error_digest: error === null ? null : engineeringDebugErrorDigest(error),
            artifacts: diagnosticArtifacts.rows.map((artifact) => ({
              artifact_kind: artifact.artifact_kind,
              stage: artifact.stage,
              stage_attempt: artifact.stage_attempt,
              reason: artifact.reason,
              review_decision: artifact.review_decision,
              verification_decision: artifact.verification_decision,
              detail_digest:
                artifact.detail === null
                  ? null
                  : engineeringDebugErrorDigest(new Error(artifact.detail)),
            })),
            operations: diagnosticOperations.rows,
            gate_receipts: diagnosticGates.rows,
          })}\n`,
        );
        await debugJournal?.append({
          event: "RUN_DIAGNOSTIC",
          artifacts: diagnosticArtifacts.rows.map((artifact) => ({
            artifact_kind: artifact.artifact_kind,
            stage: artifact.stage,
            stage_attempt: artifact.stage_attempt,
            review_decision:
              artifact.review_decision === "PASS" ||
              artifact.review_decision === "CHANGES_REQUIRED" ||
              artifact.review_decision === "BLOCKED"
                ? artifact.review_decision
                : null,
            verification_decision:
              artifact.verification_decision === "VERIFIED" ||
              artifact.verification_decision === "FAILED" ||
              artifact.verification_decision === "INCONCLUSIVE"
                ? artifact.verification_decision
                : null,
          })),
          compiler_diagnostics: [...compilerDiagnostics],
          test_diagnostics: [...testDiagnostics],
          operations: diagnosticOperations.rows,
          gate_receipts: diagnosticGates.rows,
          error_digest: error === null ? null : engineeringDebugErrorDigest(error),
        });
        return diagnosticArtifacts.rows.map((artifact) => artifact.artifact_kind);
      };
      try {
        await runWithEngineeringDebugJournal(debugJournal, async () => {
          await handlers["agent.implementer"]!(lease, async () => undefined);
          return pumpResultHolder.value;
        });
      } catch (error) {
        const artifactKinds = await recordDiagnostic(error);
        await debugJournal?.append({
          event: "RUN_COMPLETED",
          schema_version: 2,
          status: "FAILED",
          commit_sha: null,
          artifact_kinds: artifactKinds,
          handler_outcome: "FAILED",
          engineering_outcome: "FAILED",
          diagnostic_completeness: "COMPLETE",
          terminal_reason_code: "FAILED",
          next_safe_step: "INVESTIGATE",
          reconciliation_required: false,
          elapsed_ms: debugJournal?.elapsedMs() ?? 0,
          last_event_at: debugJournal?.clockNow().toISOString() ?? new Date().toISOString(),
        });
        throw error;
      }

      const artifacts = await db.query<{ artifact_kind: string; payload: Record<string, unknown> }>(
        `SELECT artifact_kind,payload FROM engineering_artifact_revisions
          WHERE run_id=$1 ORDER BY revision`,
        [granted.runId],
      );
      const commitRows = artifacts.rows.filter((row) => row.artifact_kind === "LocalCommitReceipt");
      const evidenceRows = artifacts.rows.filter((row) => row.artifact_kind === "EvidenceBundle");
      if (commitRows.length !== 1 || evidenceRows.length === 0) {
        const error = new Error("live Engineering ended without exact commit/evidence artifacts");
        const pumpResult = runtimePumpResult(pumpResultHolder.value);
        const terminalCode = pumpResult?.terminalReasonCode;
        const terminalProjection = projectEngineeringLiveTerminal({
          ...(terminalCode === undefined ? {} : { terminalReasonCode: terminalCode }),
          hasDurableCommit: false,
          hasDurableEvidence: evidenceRows.length > 0,
        });
        await recordDiagnostic(error);
        await debugJournal.append({
          event: "RUN_COMPLETED",
          schema_version: 2,
          status: "FAILED",
          commit_sha: null,
          artifact_kinds: artifacts.rows.map((row) => row.artifact_kind),
          handler_outcome: "SUCCEEDED",
          engineering_outcome: terminalProjection.engineering_outcome,
          diagnostic_completeness: "COMPLETE",
          terminal_reason_code: terminalProjection.terminal_reason_code,
          next_safe_step: terminalProjection.next_safe_step,
          reconciliation_required: terminalProjection.reconciliation_required,
          elapsed_ms: debugJournal?.elapsedMs() ?? 0,
          last_event_at: debugJournal?.clockNow().toISOString() ?? new Date().toISOString(),
        });
        throw error;
      }
      const commit = commitRows[0]!.payload;
      const workspace = await new WorkspaceRepository().find(
        db,
        verticalSliceWorkspaceId(ids.caseId),
      );
      expect(workspace).not.toBeNull();
      const finalSourceHead = await import("node:child_process").then(({ execFileSync }) =>
        execFileSync("git", ["-C", sourceRepository.sourcePath, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      );
      expect(finalSourceHead).toBe(sourceHead);
      if (workspace === null) throw new Error("engineering workspace mapping disappeared");
      const control = new EngineeringControlPlaneRepository(runtime);
      let acceptedCommit: AcceptedLocalCommitProjection | null = null;
      let acceptedSliceGates: Awaited<ReturnType<typeof projectAcceptedSliceGates>> | null = null;
      try {
        await observeEngineeringLiveCommit(
          join(config.workspaceConfig.workspaceRoot, workspace.case_id, workspace.workspace_id),
          sourceHead,
          commit,
        );
        const durableArtifacts = await control.listRunArtifactRevisions(db, {
          runId: granted.runId,
        });
        const operationId = selectLocalCommitOperationId(durableArtifacts, {
          caseId: ids.caseId,
          runId: granted.runId,
          jobId: lease.jobId,
        });
        const completion = await control.readOperationCompletion(db, { operationId });
        acceptedCommit = projectAcceptedLocalCommit({
          rows: durableArtifacts,
          completion,
          scope: { caseId: ids.caseId, runId: granted.runId, jobId: lease.jobId },
        });
        acceptedSliceGates = await projectAcceptedSliceGates({
          rows: durableArtifacts,
          acceptedCommit,
          catalog: config.catalog,
          scope: {
            caseId: ids.caseId,
            runId: granted.runId,
            jobId: lease.jobId,
            workspaceId: workspace.workspace_id,
            repositoryId: config.repositoryId,
          },
          readOperationCompletion: (operationId) =>
            control.readOperationCompletion(db, { operationId }),
        });
      } catch (error) {
        try {
          const artifactKinds = await recordDiagnostic(error);
          await debugJournal.append({
            event: "RUN_COMPLETED",
            schema_version: 2,
            status: "FAILED",
            commit_sha: typeof commit.commit_sha === "string" ? commit.commit_sha : null,
            artifact_kinds: artifactKinds,
            handler_outcome: "SUCCEEDED",
            engineering_outcome: "INCOMPLETE",
            diagnostic_completeness: "COMPLETE",
            terminal_reason_code: "INCOMPLETE",
            next_safe_step: "RECONCILE",
            reconciliation_required: true,
            elapsed_ms: debugJournal?.elapsedMs() ?? 0,
            last_event_at: debugJournal?.clockNow().toISOString() ?? new Date().toISOString(),
          });
        } finally {
          throw error;
        }
      }
      if (acceptedCommit === null) throw new Error("accepted local commit projection is missing");
      if (acceptedSliceGates === null || acceptedSliceGates.length === 0) {
        throw new Error("accepted slice gate projection is missing");
      }
      const gateRows = await db.query<{ receipt: Record<string, unknown> }>(
        `SELECT c.receipt
           FROM job_completions c
           JOIN job_intents i ON i.intent_id=c.intent_id
          WHERE i.job_id=$1 AND i.kind='engineering.verification.gate'
          ORDER BY c.recorded_at`,
        [lease.jobId],
      );
      expect(gateRows.rowCount).toBeGreaterThan(0);
      const result = {
        preflight: preflightResult.preflight.evidence ?? null,
        invocation_id: liveAuthority.invocation_id,
        implementer_invocation_digest: liveAuthority.implementer_invocation_digest,
        reviewer_invocation_digest: liveAuthority.reviewer_invocation_digest,
        external_writes: liveAuthority.external_writes,
        case_id: ids.caseId,
        run_id: granted.runId,
        proposal_id: proposed.proposal.proposal_id,
        base_sha: sourceHead,
        config_digest: config.configDigest,
        commit_sha: commit.commit_sha,
        parent_sha: commit.parent_sha,
        branch: commit.branch,
        accepted_local_commit: {
          operation_id: acceptedCommit.operationId,
          completion_id: acceptedCommit.completionId,
          command_receipt_ids: acceptedCommit.commandReceiptIds,
          accepted: acceptedCommit.accepted.map((pair) => ({
            slice_id: pair.sliceId,
            attempt: pair.attempt,
            evidence_digest: pair.evidenceDigest,
            review_digest: pair.reviewDigest,
            command_receipt_ids: pair.commandReceiptIds,
          })),
        },
        accepted_gate_projections: acceptedSliceGates.map((projection) => ({
          slice_id: projection.sliceId,
          attempt: projection.attempt,
          evidence_digest: projection.evidenceDigest,
          implementation_receipt_digest: projection.implementationReceiptDigest,
          command_receipt_ids: projection.commandReceiptIds,
          aggregate: {
            status: projection.gates.aggregate.status,
            config_digest: projection.gates.aggregate.config_digest,
            current_tree_digest: projection.gates.aggregate.current_tree_digest,
            baseline_tree_digest: projection.gates.aggregate.baseline_tree_digest,
            receipt_ids: projection.gates.aggregate.receipt_ids,
            blocking_gate_ids: projection.gates.aggregate.blocking_gate_ids,
          },
          operation_bindings: projection.gates.operationBindings,
          completion_ids: projection.gates.completionIds,
          test_first_completion_ids: projection.gates.testFirstCompletionIds,
        })),
        artifact_kinds: artifacts.rows.map((row) => row.artifact_kind),
        gate_receipts: gateRows.rows.map(({ receipt }) => ({
          gate_id: receipt.gate_id,
          outcome: receipt.outcome,
          exit_code: receipt.exit_code,
          duration_ms: receipt.duration_ms,
          log_digest: receipt.log_digest,
        })),
      };
      await recordDiagnostic(null);
      await debugJournal.append({
        event: "RUN_COMPLETED",
        schema_version: 2,
        status: "SUCCEEDED",
        commit_sha: typeof commit.commit_sha === "string" ? commit.commit_sha : null,
        artifact_kinds: artifacts.rows.map((row) => row.artifact_kind),
        handler_outcome: "SUCCEEDED",
        engineering_outcome: "COMPLETED",
        diagnostic_completeness: "COMPLETE",
        terminal_reason_code: "COMPLETED",
        next_safe_step: "STOP",
        reconciliation_required: false,
        elapsed_ms: debugJournal?.elapsedMs() ?? 0,
        last_event_at: debugJournal?.clockNow().toISOString() ?? new Date().toISOString(),
      });
      process.stdout.write(`RA045_RESULT=${JSON.stringify(result)}\n`);
    } finally {
      await closeExportAndDropEngineeringRun({
        close: async () => {
          await debugJournal?.close();
        },
        export: async () => {
          if (
            debugJournal !== undefined &&
            evidenceRoot !== undefined &&
            evidenceRunId !== undefined &&
            evidenceJobId !== undefined &&
            liveAuthority !== undefined
          )
            await exportEngineeringEvidence({
              artifactRoot: evidenceRoot,
              caseId: ids.caseId,
              runId: evidenceRunId,
              jobId: evidenceJobId,
              invocationId: liveAuthority.invocation_id,
              db,
            });
        },
        drop: async () => {
          await created.drop();
        },
      });
    }
  },
  ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS,
);
