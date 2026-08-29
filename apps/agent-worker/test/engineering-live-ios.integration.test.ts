import { realpath } from "node:fs/promises";

import {
  CaseMessageRepository,
  CaseRepository,
  ConnectionRepository,
  DiscordBindingRepository,
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
  engineeringDebugErrorDigest,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";
import {
  createEngineeringRoleModelComposition,
  loadEngineeringExecutionConfig,
  createProductionEngineeringRuntimePort,
} from "../src/engineering-execution.js";
import {
  assertEngineeringLiveQualificationAuthority,
  engineeringLiveQualificationSelectionFromEnv,
} from "../src/engineering-live-qualification.js";
import { engineeringModelRoutingFromEnv } from "../src/engineering-model-routing.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";
import {
  createXcodeVerificationGatePlatformAdapter,
  xcodeDestinationFromGateCatalog,
} from "../src/xcode-gate-adapter.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";

const enabled = process.env.RA_RUN_LIVE_IOS_ENGINEERING === "1";
const live = enabled ? it : it.skip;

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

    try {
      const config = await loadEngineeringExecutionConfig(configPath);
      const modelRouting = await engineeringModelRoutingFromEnv();
      if (modelRouting === null) {
        throw new Error("RA_ENGINEERING_MODEL_CONFIG_PATH is required for live iOS smoke");
      }
      const liveAuthority = assertEngineeringLiveQualificationAuthority({
        selection: liveSelection,
        routing: modelRouting,
        executionConfig: config,
      });
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
      const sourceRepository = config.workspaceConfig.repositories[config.repositoryId];
      if (sourceRepository === undefined) throw new Error("configured repository is unavailable");
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

      const jobs = new JobStore(runtime);
      const lease = await jobs.claim(db, {
        owner: `${suffix}-worker`,
        leaseMs: 2 * 60 * 60_000,
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
      const roleModels = createEngineeringRoleModelComposition({
        routing: modelRouting,
        executionConfig: config,
        decorateTransport: (binding) =>
          createEngineeringDebugTransport(binding.transport, {
            role: binding.role,
            invocation: binding.invocation,
          }),
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
          config,
          transport: roleModels.implementation.transport,
          modelConfig: roleModels.implementation.config,
          readContext,
          stageExecutor: roleModels.stageExecutor,
          reviewSessionFactory: roleModels.reviewSessionFactory.createSession,
          implementationModelInvocation: roleModels.implementation.invocation,
          reviewModelInvocation: roleModels.reviewer.invocation,
          modelPreflight: roleModels.modelPreflight,
          platformAdapter,
          workflowDeadlineMs: 2 * 60 * 60_000,
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
      const handler = createWorkerHandlers({
        persistence,
        roles: {},
        logger: new StructuredLogger({ knownSecrets, sink: { log: () => undefined } }),
        db,
        jobs,
        heartbeatIntervalMs: 60_000,
        engineering: makePort,
      })["agent.implementer"]!;
      const recordDiagnostic = async (error: unknown | null): Promise<string[]> => {
        const diagnosticArtifacts = await db.query<{
          artifact_kind: string;
          stage: string;
          stage_attempt: number;
          reason: string | null;
          detail: string | null;
        }>(
          `SELECT artifact_kind,stage,stage_attempt,
                  CASE WHEN artifact_kind='TerminalReason' THEN payload->>'reason' ELSE NULL END AS reason,
                  CASE WHEN artifact_kind='TerminalReason' THEN payload->>'detail' ELSE NULL END AS detail
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
        process.stdout.write(
          `RA045_DIAGNOSTIC=${JSON.stringify({
            error_digest: error === null ? null : engineeringDebugErrorDigest(error),
            artifacts: diagnosticArtifacts.rows.map((artifact) => ({
              artifact_kind: artifact.artifact_kind,
              stage: artifact.stage,
              stage_attempt: artifact.stage_attempt,
              reason: artifact.reason,
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
          })),
          operations: diagnosticOperations.rows,
          gate_receipts: diagnosticGates.rows,
          error_digest: error === null ? null : engineeringDebugErrorDigest(error),
        });
        return diagnosticArtifacts.rows.map((artifact) => artifact.artifact_kind);
      };
      try {
        await runWithEngineeringDebugJournal(debugJournal, () =>
          handler(lease, async () => undefined),
        );
      } catch (error) {
        const artifactKinds = await recordDiagnostic(error);
        await debugJournal?.append({
          event: "RUN_COMPLETED",
          status: "FAILED",
          commit_sha: null,
          artifact_kinds: artifactKinds,
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
        await recordDiagnostic(error);
        await debugJournal.append({
          event: "RUN_COMPLETED",
          status: "FAILED",
          commit_sha: null,
          artifact_kinds: artifacts.rows.map((row) => row.artifact_kind),
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
        status: "SUCCEEDED",
        commit_sha: typeof commit.commit_sha === "string" ? commit.commit_sha : null,
        artifact_kinds: artifacts.rows.map((row) => row.artifact_kind),
      });
      process.stdout.write(`RA045_RESULT=${JSON.stringify(result)}\n`);
    } finally {
      await debugJournal?.close();
      await created.drop();
    }
  },
  2 * 60 * 60_000,
);
