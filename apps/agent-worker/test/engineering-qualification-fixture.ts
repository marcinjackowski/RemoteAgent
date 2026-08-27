import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalDigest,
  engineeringWriteAuthorizationScopeV2Digest,
  engineeringWriteDeploymentPolicyV1Digest,
  type EngineeringProcessClass,
} from "@remoteagent/contracts";
import {
  createRuntimeConfig,
  type RuntimeConfig,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeTransport,
} from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  ApprovalRepository,
  JobStore,
  OutboxRepository,
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
import { createEngineeringRoleContextReader, type RoleContextReader } from "../src/context.js";
import {
  createBedrockPreCommitReviewSessionFactory,
  type EngineeringWorkflowPolicyOptions,
} from "../src/engineering-workflow.js";
import {
  createConfiguredEngineeringStageExecutor,
  createProductionEngineeringRuntimePort,
  type EngineeringExecutionConfig,
} from "../src/engineering-execution.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";

const run = promisify(execFile);
export const qualificationRuntime = productionRuntime();
export const qualificationModel = { provider: "bedrock", model_id: "qualification-model" } as const;
const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;

/** Scripted provider boundary shared by qualification and cross-app production E2E tests. */
export class EngineeringQualificationTransport implements RuntimeTransport {
  public readonly requests: RuntimeRequest[] = [];
  readonly #caseId: string;
  readonly #runId: string;
  readonly #sliceIds: readonly string[];
  readonly #implementationPaths: readonly string[];
  readonly #processClass: "SMALL" | "MEDIUM" | "LARGE_OR_HIGH_RISK";
  #planning = 0;
  #implementation = 0;
  #awaitingImplementationReport = false;
  #memory = 0;

  public constructor(input: {
    caseId: string;
    runId: string;
    sliceIds: readonly string[];
    implementationPaths: readonly string[];
    processClass: "SMALL" | "MEDIUM" | "LARGE_OR_HIGH_RISK";
  }) {
    this.#caseId = input.caseId;
    this.#runId = input.runId;
    this.#sliceIds = input.sliceIds;
    this.#implementationPaths = input.implementationPaths;
    this.#processClass = input.processClass;
  }

  public async converse(request: RuntimeRequest, _config: RuntimeConfig): Promise<RuntimeResponse> {
    this.requests.push(request);
    const name = request.outputSchema?.name;
    const json = (value: unknown): RuntimeResponse => ({
      model: qualificationModel,
      content: [{ type: "json", value: value as never }],
    });
    const common = {
      schema_version: 1,
      case_id: this.#caseId,
      run_id: this.#runId,
      revision: 0,
    };
    if (name === "EngineeringOutcomeContract_v1") {
      return json({
        ...common,
        artifact_kind: "OutcomeContract",
        problem: "qualify the production engineering path",
        outcome: "durable reviewed implementation",
        non_goals: [],
        objective: "execute bounded slices",
        success_criteria: ["required gates pass"],
        constraints: ["one server-owned repository"],
        process_class: this.#processClass,
        source_digest: sha("1"),
      });
    }
    if (name === "EngineeringSystemDesign_v1") {
      return json({
        ...common,
        artifact_kind: "SystemDesign",
        boundaries: ["worker", "PostgreSQL", "Git"],
        data: ["immutable engineering artifacts"],
        api: ["production runtime port"],
        integrations: ["PostgreSQL", "Git", "process gates"],
        invariants: ["single writer", "exact durable evidence"],
        architecture: "durable production engineering loop",
        components: ["SupervisorRuntime", "PostgresEngineeringRuntimePort"],
        interfaces: ["stage intent", "artifact", "completion"],
        data_flow: "context to slice to gates to review",
        risks: [],
        source_digest: sha("2"),
      });
    }
    if (name === "EngineeringProgramDesign_v2") {
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "ProgramDesign",
        call_flow: [...this.#sliceIds],
        file_tree_delta: [...this.#implementationPaths],
        key_types_and_signatures: ["bounded qualification files"],
        uncertainty_review: ["review every slice"],
        expected_tests: ["qualification"],
        slice_order: [...this.#sliceIds],
        slice_blueprints: this.#sliceIds.map((sliceId) => ({
          slice_id: sliceId,
          objective: `implement ${sliceId}`,
          observable_result: `${sliceId} is present in Git evidence`,
          allowed_paths: ["src"],
          test_paths: ["src"],
          gate_ids: ["qualification"],
          inspection_method: "inspect exact durable evidence",
          stop_condition: "fresh pre-commit review passes",
        })),
        source_digest: sha("3"),
      });
    }
    if (name === "EngineeringDesignDecision_v1") {
      const prompt = request.messages
        .flatMap((message) => message.content)
        .map((content) => (content.type === "text" ? content.text : ""))
        .join("\n");
      const reviewedDigest = /exact durable digest (sha256:[0-9a-f]{64})/u.exec(prompt)?.[1];
      if (reviewedDigest === undefined) throw new Error("reviewed ProgramDesign digest absent");
      return json({
        ...common,
        artifact_kind: "DesignDecision",
        decision_id: "design-approved",
        rationale: "the exact durable program design is approved",
        decision: "APPROVE",
        artifact_digest: reviewedDigest,
        findings: [],
        required_changes: [],
      });
    }
    if (name === "EngineeringSliceContract_v2") {
      const sliceId = this.#sliceIds[this.#planning++];
      if (sliceId === undefined) throw new Error("unexpected extra slice planning call");
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "SliceContract",
        slice_id: sliceId,
        objective: `implement ${sliceId}`,
        observable_result: `${sliceId} is present in Git evidence`,
        allowed_paths: ["src"],
        test_paths: ["src"],
        gate_ids: ["qualification"],
        inspection_method: "inspect exact durable evidence",
        stop_condition: "fresh pre-commit review passes",
      });
    }
    if (name === "SliceImplementationReport_v1") {
      const index = this.#implementation;
      const path = this.#implementationPaths[index];
      if (path === undefined) throw new Error("unexpected extra implementation call");
      if (!this.#awaitingImplementationReport) {
        this.#awaitingImplementationReport = true;
        return {
          model: qualificationModel,
          content: [
            {
              type: "tool-use",
              id: `write-${String(index)}`,
              name: "write",
              input: {
                relative_path: path,
                content:
                  path === "src/qualified.ts"
                    ? "export const qualification = 'qualified-green';\n"
                    : `export const slice${String(index + 1)} = true;\n`,
              },
            },
          ],
        };
      }
      this.#awaitingImplementationReport = false;
      this.#implementation += 1;
      return json({ schema_version: 1, changed_files: [path] });
    }
    if (name === "PreCommitReviewOutput_v1") {
      return json({ schema_version: 1, findings: [], lines_examined: 20 });
    }
    if (name === "EngineeringMemoryUpdate_v1") {
      this.#memory += 1;
      return json({
        ...common,
        artifact_kind: "MemoryUpdate",
        source_watermark: sha("4"),
        evidence_digests: [sha("5")],
        trust: "UNTRUSTED_DATA",
        authority: "MODEL_PROJECTION",
        completed_requirements: [`slice-${String(this.#memory)}`],
        open_issues: [],
      });
    }
    if (name === "EngineeringVerificationDecision_v1") {
      return json({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "qualification-verified",
        rationale: "all exact gate and review evidence is durable",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "all-slices", status: "PASSED", evidence_digest: sha("6") },
        ],
        evidence_digest: sha("6"),
      });
    }
    throw new Error(`unexpected qualification schema ${String(name)}`);
  }
}

export interface EngineeringQualificationFixtureOptions {
  readonly id: string;
  /** Cross-app ingress tests let the dedicated GRANT producer allocate the writer/run. */
  readonly preallocateWriter?: boolean;
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
  readonly readContext: RoleContextReader;
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
  // The shared harness imports database source while application packages resolve its built
  // declaration. Both objects are the same runtime implementation; bridge only that test seam.
  const db = created.db as unknown as Database;
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
  if (options.preallocateWriter !== false) {
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
  }

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
        gate_tier: "FAST",
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
    testPathAllowlist: Object.freeze(["src"]),
    writeDeploymentPolicy: Object.freeze({
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
      repository_id: ids.repositoryId,
      write_path_allowlist: Object.freeze(["src"]),
    }),
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
  const approvalScopes = new Map<
    string,
    Readonly<{ digest: string; scope: Record<string, unknown> }>
  >();

  return {
    db,
    jobs,
    ids,
    config,
    modelConfig,
    readContext,
    sourcePath,
    baseSha,
    claimImplementer: async (payload = {}) => {
      const approvalId =
        payload.reason === "engineering_approval" && typeof payload.approvalId === "string"
          ? payload.approvalId
          : null;
      const proposalId = approvalId === null ? null : `${prefix}-proposal-${approvalId}`;
      const exactPayload =
        approvalId === null || proposalId === null
          ? {
              caseId: ids.caseId,
              workUnitId: ids.workUnitId,
              runId: ids.runId,
              ...payload,
            }
          : {
              reason: "engineering_approval",
              caseId: ids.caseId,
              proposalId,
              approvalId,
              checkpointRevision: 0,
              workUnitId: ids.workUnitId,
              runId: ids.runId,
              repoId: ids.repositoryId,
            };
      const job = await jobs.enqueue(db, {
        caseId: ids.caseId,
        jobType: "agent.implementer",
        payload: exactPayload,
      });
      if (approvalId !== null && proposalId !== null) {
        const authorized = approvalScopes.get(approvalId);
        if (authorized !== undefined) {
          const approval = await db.query<{ expires_at: Date; granted_by: string }>(
            `SELECT expires_at, granted_by FROM approvals WHERE approval_id=$1`,
            [approvalId],
          );
          const approvalRow = approval.rows[0];
          if (approvalRow === undefined) throw new Error("qualification approval row is absent");
          await db.withTransaction(async (tx) => {
            const outbox = await new OutboxRepository(qualificationRuntime).enqueue(tx, {
              aggregate: "discord_case",
              aggregateId: ids.caseId,
              eventType: "discord.thread_message",
              payload: { case_id: ids.caseId, seq: 1, body: "qualification fixture" },
            });
            const triggerId = `${proposalId}:propose`;
            const grantId = `${proposalId}:grant`;
            await tx.query(
              `INSERT INTO engineering_ingress_interactions (
               interaction_id,case_id,owner_id,proposal_id,checkpoint_revision,interaction_kind)
             VALUES ($1,$3,$4,$2,0,'PROPOSE'),($5,$3,$4,$2,0,'GRANT')`,
              [triggerId, proposalId, ids.caseId, ids.ownerId, grantId],
            );
            const scope = authorized.scope as {
              process_class: string;
              repository_id: string;
              write_path_allowlist: readonly string[];
              authoritative_scope: Record<string, unknown>;
              deployment_policy_digest: string;
            };
            await tx.query(
              `INSERT INTO engineering_write_proposals (
               proposal_id,trigger_interaction_id,case_id,owner_id,checkpoint_revision,
               work_unit_id,run_id,process_class,objective,repository_id,write_path_allowlist,
               authoritative_scope,deployment_policy_digest,action_digest,expires_at,status,
               terminal_interaction_id,terminal_choice,terminal_actor_id,approval_id,job_id,
               discord_outbox_id,discord_seq,terminal_at)
             VALUES ($1,$2,$3,$4,0,$5,$6,$7,'qualification',$8,$9::jsonb,$10::jsonb,$11,$12,$13,
                     'GRANTED',$14,'GRANT',$15,$16,$17,$18,1,now())`,
              [
                proposalId,
                triggerId,
                ids.caseId,
                ids.ownerId,
                ids.workUnitId,
                ids.runId,
                scope.process_class,
                scope.repository_id,
                JSON.stringify(scope.write_path_allowlist),
                JSON.stringify(scope.authoritative_scope),
                scope.deployment_policy_digest,
                authorized.digest,
                approvalRow.expires_at.toISOString(),
                grantId,
                approvalRow.granted_by,
                approvalId,
                job.job_id,
                outbox.outbox_id,
              ],
            );
          });
        }
      }
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
      const deploymentPolicyDigest = engineeringWriteDeploymentPolicyV1Digest(
        config.writeDeploymentPolicy,
      );
      const scope = {
        schema_version: 2,
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
        repository_id: ids.repositoryId,
        write_path_allowlist: config.writeDeploymentPolicy.write_path_allowlist,
        deployment_policy_digest: deploymentPolicyDigest,
      } as const;
      const digest = engineeringWriteAuthorizationScopeV2Digest(scope);
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
      approvalScopes.set(approvalId, Object.freeze({ digest, scope }));
      return digest;
    },
    makeProduction: (lease, input) => {
      const executionConfig = input.executionConfig ?? config;
      const stageExecutor = createConfiguredEngineeringStageExecutor({
        transport: input.transport,
        modelConfig,
        executionConfig,
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
