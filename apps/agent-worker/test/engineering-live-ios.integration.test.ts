import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
  engineeringImplementationContext,
} from "../src/engineering-execution.js";
import {
  assertEngineeringLiveQualificationAuthority,
  ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
  ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS,
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
const runExecutable = promisify(execFile);

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
      const liveGateSchedules = new Map(
        config.catalog.definitions.map((definition) => [
          definition.gate_id,
          definition.gate_schedule,
        ]),
      );
      if (liveGateSchedules.get("mobl-2023-safety-alert-contract") !== "LAST_SLICE") {
        throw new Error("live task-wide safety-alert contract must run only on the last slice");
      }
      const incrementalSafetyContract = config.catalog.get(
        "mobl-2023-safety-alert-contract-incremental",
      );
      const finalSafetyContract = config.catalog.get("mobl-2023-safety-alert-contract");
      const incrementalSafetyCommand = incrementalSafetyContract?.argv.join("\n") ?? "";
      const incrementalSafetyContext = incrementalSafetyContract?.implementation_context ?? [];
      const incrementalSafetyQueries = incrementalSafetyContext.flatMap((entry) =>
        entry.kind === "SEARCH" ? [entry.query] : [],
      );
      const incrementalSafetyPaths = incrementalSafetyContext.map((entry) => entry.relative_path);
      if (
        incrementalSafetyContract?.gate_schedule !== "EACH_SLICE" ||
        incrementalSafetyContract.gate_tier !== "FAST" ||
        incrementalSafetyContract.execution_order !== 20 ||
        incrementalSafetyContract.required_test_paths.join("\n") !==
          "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift" ||
        incrementalSafetyContract.required_mutation_paths.join("\n") !==
          [
            "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
            "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
          ].join("\n") ||
        incrementalSafetyContract.implementation_guidance === undefined ||
        !incrementalSafetyContract.implementation_guidance.includes(
          "Comparing only String(localized:) to the same production localization key is vacuous",
        ) ||
        incrementalSafetyContract.implementation_context === undefined ||
        !incrementalSafetyCommand.includes("Tests/SharedTests/AgentAI/SafetyAlertTests.swift") ||
        !incrementalSafetyCommand.includes(
          "SafetyAlertTests must assert the exact UI copy: This message was shared for safety reasons",
        ) ||
        !incrementalSafetyCommand.includes(
          "production emergency-resources action model in SafetyAlert.swift",
        ) ||
        !incrementalSafetyCommand.includes(
          "SafetyAlertTests must invoke both ButtonModel tapAction closures",
        ) ||
        !incrementalSafetyCommand.includes(
          "SafetyAlertTests must assert application URL and analytics",
        ) ||
        !incrementalSafetyCommand.includes("(?:openURLCalls|openUrlCalls)") ||
        !incrementalSafetyContract.implementation_guidance.includes(
          "same claiming slice must wire the production SafetyAlert.swift",
        ) ||
        !incrementalSafetyContract.implementation_guidance.includes(
          "invoke both ButtonModel tapAction() closures",
        ) ||
        !incrementalSafetyQueries.includes("final class TestApplication") ||
        !incrementalSafetyPaths.includes(
          "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
        ) ||
        finalSafetyContract?.gate_schedule !== "LAST_SLICE" ||
        finalSafetyContract.gate_tier !== "FAST" ||
        finalSafetyContract.execution_order !== 25 ||
        finalSafetyContract.implementation_guidance !== undefined ||
        finalSafetyContract.implementation_context !== undefined
      ) {
        throw new Error(
          "live safety-alert ownership must fail the claiming slice and retain independent final evidence",
        );
      }
      if (liveGateSchedules.get("mobl-2023-flow-integration") !== "LAST_SLICE") {
        throw new Error("live task-wide flow integration must run only on the last slice");
      }
      const flowIntegration = config.catalog.get("mobl-2023-flow-integration");
      const flowCommand = flowIntegration?.argv.join("\n") ?? "";
      const flowContextQueries = (flowIntegration?.implementation_context ?? []).flatMap((entry) =>
        entry.kind === "SEARCH" ? [entry.query] : [],
      );
      const flowContextSearches = (flowIntegration?.implementation_context ?? []).flatMap(
        (entry) => (entry.kind === "SEARCH" ? [`${entry.relative_path}:${entry.query}`] : []),
      );
      if (
        flowIntegration?.implementation_guidance === undefined ||
        !flowIntegration.implementation_guidance.includes(
          "touching the four paths is not completion",
        ) ||
        !flowCommand.includes("single-agent typed safety state/router") ||
        !flowCommand.includes("single-agent emergencyResources event route") ||
        !flowCommand.includes("multi-agent typed safety state/router") ||
        !flowCommand.includes("multi-agent emergencyResources event route") ||
        flowContextQueries.filter(
          (query) => query === "private var emergencyResources: EmergencyResources?",
        ).length !== 2 ||
        !flowContextSearches.includes(
          "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift:emergencyResources",
        ) ||
        !flowContextSearches.includes(
          "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift:emergencyResources",
        )
      ) {
        throw new Error(
          "live flow correction must prefetch exact declaration, session routing, and session-test boundaries",
        );
      }
      const lastSliceGateIds = config.catalog.definitions
        .filter(
          (definition) =>
            definition.required &&
            (definition.gate_schedule === "EACH_SLICE" ||
              definition.gate_schedule === "LAST_SLICE"),
        )
        .map((definition) => definition.gate_id);
      const lastSliceContext = engineeringImplementationContext(config.catalog, lastSliceGateIds);
      if (lastSliceContext.length > 18) {
        throw new Error(
          `live last-slice speculative context exceeds the bounded budget: ${lastSliceContext.length}`,
        );
      }
      const expectedTestPaths = [
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentFlowTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentSessionTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/AgentAIStreamingEngineTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
      ] as const;
      if (config.testPathAllowlist.join("\n") !== expectedTestPaths.join("\n")) {
        throw new Error("live test path authority must remain exact and file-bounded");
      }
      const requiredSelectorTestPaths = [
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
        "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
      ] as const;
      const selectorGate = config.catalog.get("mobl-2023-non-vacuous-xcode-selectors");
      const selectorCommand = selectorGate?.argv.join("\n") ?? "";
      const selectorContextReads = (selectorGate?.implementation_context ?? []).flatMap((entry) =>
        entry.kind === "READ" ? [entry.relative_path] : [],
      );
      if (
        selectorGate?.required_test_paths.join("\n") !== requiredSelectorTestPaths.join("\n") ||
        selectorGate.implementation_guidance === undefined ||
        !selectorGate.implementation_guidance.includes(
          "Carry the exact EmergencyResources event into the full-screen alert",
        ) ||
        !selectorGate.implementation_guidance.includes("execute tapAction()") ||
        !selectorGate.implementation_guidance.includes(
          "Patch the existing AgentAIFlowTests.swift and AIMultiAgentChatViewModelTests.swift",
        ) ||
        !selectorGate.implementation_guidance.includes(
          "`let forwardedEvent = event` is an identity assertion",
        ) ||
        !selectorContextReads.includes(
          "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
        ) ||
        !selectorCommand.includes("production emergency-resources action model") ||
        !selectorCommand.includes("production Text 988/Emergency resources action invocation") ||
        !selectorCommand.includes("exact emergencyResources event forwarding") ||
        !selectorCommand.includes("production action execution assertions") ||
        !selectorCommand.includes("not assign event to itself") ||
        !selectorCommand.includes("not a private test-only adapter") ||
        !selectorCommand.includes(
          "existing AgentAIFlowTests.swift and AIMultiAgentChatViewModelTests.swift must observe emergency-resources routing into safetyAlert",
        ) ||
        !selectorCommand.includes('error?.code==="ENOENT"') ||
        !selectorCommand.includes(
          "inline-card prevention assertion in AgentAIFlowTests.swift, AIMultiAgentChatViewModelTests.swift, or EmergencyResourcesTextFlowAdapterTests.swift",
        )
      ) {
        throw new Error(
          "live selector gate must bind exact task-owned tests to production action execution",
        );
      }
      const targetedFast = config.catalog.definitions.find(
        (definition) => definition.gate_id === "ios-safety-alert-tests",
      );
      const targetedFull = config.catalog.definitions.find(
        (definition) => definition.gate_id === "ios-safety-alert-tests-final",
      );
      const compilePreflight = config.catalog.get("mobl-2023-ios-compile");
      if (
        targetedFast !== undefined ||
        compilePreflight !== undefined ||
        targetedFull?.gate_schedule !== "LAST_SLICE" ||
        targetedFull.gate_tier !== "FULL" ||
        targetedFull.execution_order !== 100 ||
        targetedFull.argv.includes("-quiet") ||
        targetedFull.argv.filter((argument) => argument === "ENABLE_TESTABILITY=YES").length !== 1
      ) {
        throw new Error(
          "live targeted iOS tests must have one exact verbose LAST_SLICE FULL gate without redundant compile",
        );
      }
      const assetGenerator = config.generatorCatalog?.definitions.find(
        (definition) => definition.generator_id === "mobl-2023-shared-assets",
      );
      if (
        assetGenerator === undefined ||
        assetGenerator.trigger_paths.join("\n") !==
          "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI" ||
        assetGenerator.output_paths.join("\n") !==
          "SonderClient/SonderClientLibrary/Sources/Shared/Resources/Assets+Generated.swift"
      ) {
        throw new Error("live shared asset accessor must use the exact code-owned generator");
      }
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
          compiler_diagnostics: compilerDiagnostics,
          test_diagnostics: testDiagnostics,
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
  ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS,
);
