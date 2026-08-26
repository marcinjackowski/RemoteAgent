import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalDigest,
  engineeringWriteAuthorizationScopeDigest,
  type EngineeringProcessClass,
} from "@remoteagent/contracts";
import { createRuntimeConfig, type RuntimeTransport } from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  ApprovalRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
  type EngineeringControlPlaneRepository,
  type JobLease,
} from "@remoteagent/database";
import { StructuredLogger, type MetricRegistry } from "@remoteagent/observability";
import {
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import type { EngineeringRuntimePort } from "@remoteagent/agent-orchestrator";

import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { createEngineeringRoleContextReader } from "../src/context.js";
import {
  createBedrockEngineeringStageExecutor,
  createBedrockPreCommitReviewSessionFactory,
  type EngineeringWorkflowPolicyOptions,
} from "../src/engineering-workflow.js";
import {
  createProductionEngineeringRuntimePort,
  type EngineeringExecutionConfig,
} from "../src/engineering-execution.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";

const run = promisify(execFile);
export const qualificationRuntime = productionRuntime();
export const qualificationModel = { provider: "bedrock", model_id: "qualification-model" } as const;

export interface EngineeringQualificationFixtureOptions {
  readonly id: string;
  readonly testFirst?: boolean;
  /** Deliberately vacuous baseline used to prove test-first fail-closed behavior. */
  readonly baselineQualified?: boolean;
  /** Deterministic required-gate failure used by qualification boundary scenarios. */
  readonly gateFails?: boolean;
}

export interface EngineeringQualificationFixture {
  readonly db: Database;
  readonly jobs: JobStore;
  readonly ids: Readonly<{
    ownerId: string;
    connectionId: string;
    caseId: string;
    workUnitId: string;
    runId: string;
    repositoryId: string;
  }>;
  readonly config: EngineeringExecutionConfig;
  readonly modelConfig: ReturnType<typeof createRuntimeConfig>;
  readonly sourcePath: string;
  readonly baseSha: string;
  readonly claimImplementer: (payload?: Readonly<Record<string, unknown>>) => Promise<JobLease>;
  readonly implementerHandler: (
    engineering: (lease: JobLease) => EngineeringRuntimePort,
  ) => NonNullable<ReturnType<typeof createWorkerHandlers>["agent.implementer"]>;
  readonly seedAnsweredDecision: (
    decisionId: string,
    selectedOptionId?: "grant" | "deny",
  ) => Promise<void>;
  readonly grantWriteApproval: (input: {
    readonly approvalId: string;
    readonly processClass: EngineeringProcessClass;
    readonly scopePatch?: Readonly<{
      caseId?: string;
      ownerId?: string;
      checkpointRevision?: number;
      workUnitId?: string;
      runId?: string;
      connectionIds?: readonly string[];
      repoAllowlist?: readonly string[];
    }>;
  }) => Promise<string>;
  readonly makeProduction: (
    lease: JobLease,
    input: {
      readonly transport: RuntimeTransport;
      readonly policy: EngineeringWorkflowPolicyOptions;
      readonly workflowDeadlineMs?: number;
      readonly controlPlane?: EngineeringControlPlaneRepository;
      readonly metrics?: MetricRegistry;
      /** Test-only restart input; production still resolves one immutable deployment config. */
      readonly executionConfig?: EngineeringExecutionConfig;
    },
  ) => Readonly<{
    port: ReturnType<typeof createProductionEngineeringRuntimePort>;
    handler: NonNullable<ReturnType<typeof createWorkerHandlers>["agent.implementer"]>;
  }>;
  readonly drop: () => Promise<void>;
}

/**
 * Shared RA-044 production-composition fixture. PostgreSQL, context compilation, Git workspaces,
 * process gates and pre-commit review are the real adapters. Only the external model transport is
 * scripted by a scenario, exactly like a provider test double at the network boundary.
 */
export async function createEngineeringQualificationFixture(
  options: EngineeringQualificationFixtureOptions,
): Promise<EngineeringQualificationFixture> {
  const created = await createTestDatabase();
  const { db } = created;
  const prefix = `qualification-${options.id}`;
  const ids = Object.freeze({
    ownerId: `${prefix}-owner`,
    connectionId: `${prefix}-connection`,
    caseId: `${prefix}-case`,
    workUnitId: `${prefix}-unit`,
    runId: `${prefix}-run`,
    repositoryId: `${prefix}-repo`,
  });
  const parent = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const sourcePath = join(parent, "source");
  const workspaceRoot = join(parent, "workspaces");
  const baselineRoot = join(parent, "baselines");
  const artifactRoot = join(parent, "artifacts");
  await Promise.all(
    [sourcePath, workspaceRoot, baselineRoot, artifactRoot].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await run("git", ["init", "--quiet", "--initial-branch=main", sourcePath]);
  await run("git", ["-C", sourcePath, "config", "user.email", "qualification@example.test"]);
  await run("git", ["-C", sourcePath, "config", "user.name", "Qualification"]);
  await mkdir(join(sourcePath, "src"));
  await writeFile(join(sourcePath, "src", "base.ts"), "export const base = true;\n");
  if (options.baselineQualified === true) {
    await writeFile(join(sourcePath, "src", "qualified.ts"), "qualified-green\n");
  }
  await run("git", ["-C", sourcePath, "add", "src"]);
  await run("git", ["-C", sourcePath, "commit", "--quiet", "-m", "qualification base"]);
  const baseSha = (await run("git", ["-C", sourcePath, "rev-parse", "HEAD"])).stdout.trim();

  await new OwnerRepository().insert(db, { ownerId: ids.ownerId, displayName: options.id });
  await new ConnectionRepository().insert(db, {
    connectionId: ids.connectionId,
    ownerId: ids.ownerId,
    provider: "jira",
    displayName: `${options.id} jira`,
  });
  await new CaseRepository().insert(db, {
    caseId: ids.caseId,
    ownerId: ids.ownerId,
    status: "IMPLEMENTING",
    integrationScope: { providers: ["jira"], connection_ids: [ids.connectionId] },
    discordThreadId: `${prefix}-thread`,
  });
  await db.query(
    `INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint)
     VALUES ($1,$2,0,$3::jsonb)`,
    [ids.caseId, ids.ownerId, JSON.stringify(makeCheckpoint(ids.caseId, 0))],
  );
  const units = new WorkUnitRepository();
  await units.insert(db, {
    workUnitId: ids.workUnitId,
    caseId: ids.caseId,
    role: "IMPLEMENTER",
    objective: `${options.id} bounded engineering qualification`,
    authoritativeScope: {
      connection_ids: [],
      repo_allowlist: [ids.repositoryId],
      can_write_workspace: true,
    },
  });
  await units.claim(db, {
    workUnitId: ids.workUnitId,
    runId: ids.runId,
    checkpointRevision: 0,
  });

  const executable = await realpath(process.execPath);
  const gateScript = options.testFirst
    ? "const fs=require('fs');let s='';try{s=fs.readFileSync('qualified.ts','utf8')}catch{};process.exit(s.includes('qualified-green')?0:1)"
    : options.gateFails === true
      ? "process.exit(1)"
      : "process.exit(0)";
  const catalog = await VerificationGateCatalog.create({
    definitions: [
      VerificationGateDefinition.parse({
        schema_version: 1,
        gate_id: "qualification",
        gate_class: VerificationGateClass.TEST,
        executable,
        argv: ["-e", gateScript],
        relative_cwd: "src",
        required: true,
        baseline: options.testFirst === true,
        test_first: options.testFirst === true,
        timeout_ms: 10_000,
        environment_profile: "HERMETIC",
        network_profile: "DENY",
        mutable_outputs: [],
      }),
    ],
    executable_allowlist: [executable],
  });
  const config: EngineeringExecutionConfig = Object.freeze({
    workspaceConfig: {
      workspaceRoot,
      repositories: {
        [ids.repositoryId]: { sourcePath, baseBranch: "main" },
      },
    },
    repositoryId: ids.repositoryId,
    baselineRoot,
    artifactRoot,
    writePathAllowlist: Object.freeze(["src"]),
    catalog,
    configDigest: canonicalDigest({
      repository_id: ids.repositoryId,
      catalog: catalog.config_digest,
    }),
  });
  const modelConfig = createRuntimeConfig({
    model: qualificationModel,
    timeoutMs: 30_000,
    toolLimits: { maxIterations: 8, maxCalls: 16 },
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0 },
  });
  const jobs = new JobStore(qualificationRuntime);
  const readContext = createEngineeringRoleContextReader({ db });

  return {
    db,
    jobs,
    ids,
    config,
    modelConfig,
    sourcePath,
    baseSha,
    claimImplementer: async (payload = {}) => {
      await jobs.enqueue(db, {
        caseId: ids.caseId,
        jobType: "agent.implementer",
        payload: {
          caseId: ids.caseId,
          workUnitId: ids.workUnitId,
          runId: ids.runId,
          ...payload,
        },
      });
      const lease = await jobs.claim(db, { owner: `${prefix}-writer`, leaseMs: 300_000 });
      if (lease === null) throw new Error("expected engineering qualification lease");
      return lease;
    },
    implementerHandler: (engineering) =>
      createWorkerHandlers({
        persistence: new WorkerPersistence(db, qualificationRuntime),
        roles: {},
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
        db,
        jobs,
        heartbeatIntervalMs: 60_000,
        engineering,
      })["agent.implementer"]!,
    seedAnsweredDecision: async (decisionId, selectedOptionId = "grant") => {
      await db.query(
        `INSERT INTO decisions (
           decision_id, case_id, question, why_now, options, recommendation,
           blocked_scope, checkpoint_revision)
         VALUES ($1,$2,'Authorize qualification?','Before implementation',
                 '[{"id":"grant","label":"Grant","consequences":"Proceed"},{"id":"deny","label":"Deny","consequences":"Stop"}]'::jsonb,
                 $3,'engineering workflow',0)`,
        [decisionId, ids.caseId, selectedOptionId],
      );
      await db.query(
        `INSERT INTO decision_answers (
           answer_id, decision_id, case_id, checkpoint_revision, selected_option_id,
           answered_by, answered_at)
         VALUES ($1,$2,$3,0,$4,$5,now())`,
        [`answer-${decisionId}`, decisionId, ids.caseId, selectedOptionId, ids.ownerId],
      );
    },
    grantWriteApproval: async ({ approvalId, processClass, scopePatch = {} }) => {
      const caseId = scopePatch.caseId ?? ids.caseId;
      const checkpointRevision = scopePatch.checkpointRevision ?? 0;
      const digest = engineeringWriteAuthorizationScopeDigest({
        schema_version: 1,
        purpose: "ENGINEERING_WORKFLOW_WRITE",
        case_id: caseId,
        owner_id: scopePatch.ownerId ?? ids.ownerId,
        checkpoint_revision: checkpointRevision,
        work_unit_id: scopePatch.workUnitId ?? ids.workUnitId,
        run_id: scopePatch.runId ?? ids.runId,
        process_class: processClass,
        authoritative_scope: {
          connection_ids: scopePatch.connectionIds ?? [],
          repo_allowlist: scopePatch.repoAllowlist ?? [ids.repositoryId],
          can_write_workspace: true,
        },
      });
      const outcome = await db.withTransaction((tx) =>
        new ApprovalRepository().grant(tx, {
          approvalId,
          caseId,
          grantedBy: ids.ownerId,
          actionDigest: digest,
          checkpointRevision,
          expiresAt: new Date(Date.now() + 300_000),
        }),
      );
      if (outcome.outcome !== "GRANTED" && outcome.outcome !== "ALREADY_GRANTED") {
        throw new Error(`qualification approval grant refused: ${outcome.outcome}`);
      }
      return digest;
    },
    makeProduction: (lease, input) => {
      const executionConfig = input.executionConfig ?? config;
      const stageExecutor = createBedrockEngineeringStageExecutor({
        transport: input.transport,
        config: modelConfig,
      });
      const reviewer = createBedrockPreCommitReviewSessionFactory({
        transport: input.transport,
        config: modelConfig,
      });
      const makePort = () =>
        createProductionEngineeringRuntimePort({
          db,
          jobs,
          lease,
          config: executionConfig,
          transport: input.transport,
          modelConfig,
          readContext,
          stageExecutor,
          reviewSessionFactory: reviewer.createSession,
          policy: input.policy,
          ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
          ...(input.controlPlane === undefined ? {} : { controlPlane: input.controlPlane }),
          ...(input.workflowDeadlineMs === undefined
            ? {}
            : { workflowDeadlineMs: input.workflowDeadlineMs }),
        });
      return Object.freeze({
        port: makePort(),
        handler: createWorkerHandlers({
          persistence: new WorkerPersistence(db, qualificationRuntime),
          roles: {},
          logger: new StructuredLogger({ sink: { log: () => undefined } }),
          db,
          jobs,
          heartbeatIntervalMs: 60_000,
          engineering: makePort,
        })["agent.implementer"]!,
      });
    },
    drop: async () => {
      await created.drop();
      await rm(parent, { recursive: true, force: true });
    },
  };
}
