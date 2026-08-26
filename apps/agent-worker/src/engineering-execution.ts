/** Production composition for the durable engineering loop. */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import {
  canonicalDigest,
  engineeringArtifact,
  engineeringArtifactDigest,
  engineeringSliceContract,
  engineeringSliceImplementationReceipt,
  assertEngineeringPathsWithinWriteAllowlist,
  normalizeEngineeringWritePathAllowlist,
  relativeRepositoryPath,
  EngineeringStage,
  type EngineeringArtifact,
  type EngineeringEvidenceBundle,
  type EngineeringSliceContract,
  type EngineeringSliceImplementationReceipt,
} from "@remoteagent/contracts";
import {
  defineStructuredContract,
  runStructuredContract,
  type RuntimeConfig,
  type RuntimeJsonValue,
  type RuntimeToolDefinition,
  type RuntimeTransport,
} from "@remoteagent/bedrock-runtime";
import {
  WorkspaceRepository,
  EngineeringControlPlaneRepository,
  productionRuntime,
  type Database,
  type EngineeringControlArtifactRevisionRow,
  type JobLease,
  type JobStore,
} from "@remoteagent/database";
import type { BoundedImplementationToolset } from "@remoteagent/implementation-tools";
import type { MetricRegistry } from "@remoteagent/observability";
import { PRE_COMMIT_REVIEW_NO_CHANGE, ReviewContractError } from "@remoteagent/review-loop";
import {
  BaselineWorkspaceStore,
  LocalArtifactStore,
  VerificationGateCatalog,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { resolveBaseBranch } from "@remoteagent/workspace-runner";
import * as z from "zod";

import type { RoleContextReader } from "./context.js";
import {
  createPostgresEngineeringRuntimePort,
  engineeringApprovalCandidateFromLease,
  type EngineeringLocalCommitStageExecutor,
  type EngineeringReviewStageExecutor,
  type EngineeringSliceImplementationStageExecutor,
  type EngineeringStageExecutor,
  type EngineeringGateStageExecutor,
  type EngineeringWorkflowPolicyOptions,
} from "./engineering-workflow.js";
import {
  buildEvidenceBoundCommitDescriptor,
  buildSliceImplementationReceipt,
  cleanupSliceImplementationBaseline,
  executeEvidenceBoundLocalCommit,
  executeVerticalSlice,
  executeVerticalSliceGates,
  executeVerticalSliceReview,
  observeSliceImplementationReceipt,
  observeSliceImplementationForCommit,
  recoverEvidenceBoundLocalCommit,
  verticalSliceBranchName,
  verticalSliceWorkspaceId,
  type VerticalSliceWriterFence,
} from "./vertical-slice-executor.js";
import type { WorkspaceConfig } from "./workspace-config.js";

const REPOSITORY_ID = /^[A-Za-z0-9._-]+$/u;
const IMPLEMENTATION_PROMPT_VERSION = "ra043-slice-implementation-v1";

const implementationReport = z
  .object({
    schema_version: z.literal(1),
    changed_files: z.array(relativeRepositoryPath).max(512),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (new Set(report.changed_files).size !== report.changed_files.length) {
      ctx.addIssue({ code: "custom", path: ["changed_files"], message: "must be unique" });
    }
  });

const implementationDefinition = defineStructuredContract({
  name: "SliceImplementationReport_v1",
  version: 1,
  schema: implementationReport,
});

export type EngineeringExecutionConfig = Readonly<{
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  baselineRoot: string;
  artifactRoot: string;
  writePathAllowlist: readonly string[];
  catalog: VerificationGateCatalog;
  configDigest: string;
}>;

type Env = Record<string, string | undefined>;

function exactRecord(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
  return record;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${label} is required`);
  return value;
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function canonicalDirectory(value: unknown, label: string): Promise<string> {
  const path = nonEmptyString(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute deployment path`);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must be canonical`);
  return canonical;
}

/** Load a single immutable deployment document; no per-job env can widen it. */
export async function loadEngineeringExecutionConfig(
  path: string,
): Promise<EngineeringExecutionConfig> {
  if (!isAbsolute(path)) throw new Error("RA_ENGINEERING_CONFIG_PATH must be absolute");
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) throw new Error("RA_ENGINEERING_CONFIG_PATH must be canonical");
  const decoded: unknown = JSON.parse(await readFile(canonicalPath, "utf8"));
  const root = exactRecord(
    decoded,
    [
      "schema_version",
      "workspace_root",
      "baseline_root",
      "artifact_root",
      "repository",
      "gates",
      "executable_allowlist",
    ],
    "engineering execution config",
  );
  if (root.schema_version !== 2)
    throw new Error("engineering execution config version is unsupported");
  const repository = exactRecord(
    root.repository,
    ["repository_id", "source_path", "base_branch", "write_path_allowlist"],
    "engineering repository config",
  );
  const repositoryId = nonEmptyString(repository.repository_id, "repository_id");
  if (!REPOSITORY_ID.test(repositoryId)) throw new Error("repository_id is not canonical");
  const workspaceRoot = await canonicalDirectory(root.workspace_root, "workspace_root");
  const baselineRoot = await canonicalDirectory(root.baseline_root, "baseline_root");
  const artifactRoot = await canonicalDirectory(root.artifact_root, "artifact_root");
  const sourcePath = await canonicalDirectory(repository.source_path, "source_path");
  const roots = [workspaceRoot, baselineRoot, artifactRoot, sourcePath];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (contained(roots[left]!, roots[right]!) || contained(roots[right]!, roots[left]!)) {
        throw new Error(
          "repository source, workspace, baseline and artifact roots must be pairwise disjoint",
        );
      }
    }
  }
  if (!Array.isArray(root.gates) || !Array.isArray(root.executable_allowlist)) {
    throw new Error("gates and executable_allowlist must be arrays");
  }
  const definitions = root.gates.map((gate) => VerificationGateDefinition.parse(gate));
  if (definitions.some((gate) => !gate.required)) {
    throw new Error("production engineering config may contain only required gates");
  }
  const executableAllowlist = root.executable_allowlist.map((entry) =>
    nonEmptyString(entry, "executable_allowlist entry"),
  );
  const catalog = await VerificationGateCatalog.create({
    definitions,
    executable_allowlist: executableAllowlist,
  });
  const baseBranch = nonEmptyString(repository.base_branch, "base_branch");
  const writePathAllowlist = normalizeEngineeringWritePathAllowlist(
    repository.write_path_allowlist,
  );
  const workspaceConfig: WorkspaceConfig = Object.freeze({
    workspaceRoot,
    repositories: Object.freeze({
      [repositoryId]: Object.freeze({ sourcePath, baseBranch }),
    }),
  });
  return Object.freeze({
    workspaceConfig,
    repositoryId,
    baselineRoot,
    artifactRoot,
    writePathAllowlist,
    catalog,
    configDigest: canonicalDigest({
      schema_version: 2,
      workspace_root: workspaceRoot,
      baseline_root: baselineRoot,
      artifact_root: artifactRoot,
      repository: {
        repository_id: repositoryId,
        source_path: sourcePath,
        base_branch: baseBranch,
        write_path_allowlist: writePathAllowlist,
      },
      gate_config_digest: catalog.config_digest,
    }),
  });
}

export async function engineeringExecutionConfigFromEnv(
  env: Env = process.env,
): Promise<EngineeringExecutionConfig | null> {
  const path = env.RA_ENGINEERING_CONFIG_PATH?.trim();
  if (path === undefined || path === "") return null;
  return loadEngineeringExecutionConfig(path);
}

const toolDefinitions: readonly RuntimeToolDefinition[] = Object.freeze([
  {
    name: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["relative_path"],
      properties: { relative_path: { type: "string" } },
    },
  },
  {
    name: "search",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
    },
  },
  {
    name: "tree",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { relative_path: { type: "string" } },
    },
  },
  {
    name: "config",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["relative_path"],
      properties: { relative_path: { type: "string" } },
    },
  },
  {
    name: "write",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["relative_path", "content"],
      properties: {
        relative_path: { type: "string" },
        content: { type: "string" },
        expected_before_digest: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
  {
    name: "patch",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["relative_path", "content"],
            properties: { relative_path: { type: "string" }, content: { type: "string" } },
          },
        },
        expected_before_digest: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
  {
    name: "mkdir",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["relative_path"],
      properties: { relative_path: { type: "string" }, recursive: { type: "boolean" } },
    },
  },
]);

function runtimeJson(value: unknown): RuntimeJsonValue {
  return JSON.parse(JSON.stringify(value)) as RuntimeJsonValue;
}

async function executeBoundedTool(
  tools: BoundedImplementationToolset,
  name: string,
  input: RuntimeJsonValue,
): Promise<RuntimeJsonValue> {
  if (!toolDefinitions.some((tool) => tool.name === name) || name === "command") {
    throw new Error("model requested a tool outside the seven-tool implementation surface");
  }
  const callable = tools[name as keyof BoundedImplementationToolset] as (
    input: never,
  ) => Promise<unknown>;
  return runtimeJson(await callable(input as never));
}

function sliceContract(
  rows: readonly EngineeringControlArtifactRevisionRow[],
  binding: { caseId: string; runId: string; checkpointRevision: number },
  writePathAllowlist: readonly string[],
): EngineeringSliceContract {
  const row = [...rows]
    .reverse()
    .find((candidate) => candidate.payload.artifact_kind === "SliceContract");
  if (row?.payload.artifact_kind !== "SliceContract")
    throw new Error("stage lacks a durable SliceContract");
  const slice = engineeringSliceContract.parse(row.payload);
  if (
    slice.case_id !== binding.caseId ||
    slice.run_id !== binding.runId ||
    slice.revision !== binding.checkpointRevision
  ) {
    throw new Error("durable SliceContract crosses the runtime binding");
  }
  assertEngineeringPathsWithinWriteAllowlist(slice.allowed_paths, writePathAllowlist);
  return slice;
}

function implementationReceipt(
  rows: readonly EngineeringControlArtifactRevisionRow[],
  binding: {
    caseId: string;
    workUnitId: string;
    runId: string;
    checkpointRevision: number;
    attempt: number;
  },
): EngineeringSliceImplementationReceipt {
  const row = [...rows]
    .reverse()
    .find(
      (candidate) =>
        candidate.payload.artifact_kind === "SliceImplementationReceipt" &&
        candidate.stage_attempt === binding.attempt,
    );
  if (row?.payload.artifact_kind !== "SliceImplementationReceipt")
    throw new Error("stage lacks an exact durable implementation receipt");
  const receipt = engineeringSliceImplementationReceipt.parse(row.payload);
  if (
    receipt.case_id !== binding.caseId ||
    receipt.work_unit_id !== binding.workUnitId ||
    receipt.run_id !== binding.runId ||
    receipt.revision !== binding.checkpointRevision ||
    receipt.attempt !== binding.attempt
  )
    throw new Error("implementation receipt crosses the runtime binding");
  return receipt;
}

function evidenceBundle(
  rows: readonly EngineeringControlArtifactRevisionRow[],
  attempt: number,
): { bundle: EngineeringEvidenceBundle; digest: string } {
  const row = [...rows]
    .reverse()
    .find(
      (candidate) =>
        candidate.payload.artifact_kind === "EvidenceBundle" && candidate.stage_attempt === attempt,
    );
  if (row?.payload.artifact_kind !== "EvidenceBundle")
    throw new Error("review lacks an exact durable EvidenceBundle");
  return { bundle: row.payload, digest: row.payload_digest };
}

function previousCorrectionRawPatchDigest(
  rows: readonly EngineeringControlArtifactRevisionRow[],
  binding: { caseId: string; runId: string; checkpointRevision: number; attempt: number },
  slice: EngineeringSliceContract,
): string | undefined {
  let activeSliceIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const artifact = rows[index]!.payload;
    if (
      artifact.artifact_kind === "SliceContract" &&
      artifact.slice_id === slice.slice_id &&
      artifact.case_id === binding.caseId &&
      artifact.run_id === binding.runId &&
      artifact.revision === binding.checkpointRevision
    ) {
      activeSliceIndex = index;
      break;
    }
  }
  if (activeSliceIndex < 0 || binding.attempt < 2) return undefined;
  const previous = rows
    .slice(activeSliceIndex + 1)
    .filter((row) => row.payload.artifact_kind === "ReviewDecision")
    .at(-1);
  if (
    previous?.payload.artifact_kind !== "ReviewDecision" ||
    previous.payload.decision !== "CHANGES_REQUIRED" ||
    previous.stage_attempt !== binding.attempt - 1
  ) {
    return undefined;
  }
  return previous.payload.reviewed_digest;
}

function writerFence(db: Database, jobs: JobStore, lease: JobLease): VerticalSliceWriterFence {
  if (lease.caseId === null || lease.jobType !== "agent.implementer")
    throw new Error("engineering execution requires a case-bound implementer lease");
  return Object.freeze({
    caseId: lease.caseId,
    leaseOwner: lease.leaseOwner,
    fencingToken: lease.fencingToken,
    assertCurrent: () => jobs.assertCurrentLease(db, lease),
  });
}

async function baseShaForAttempt(input: {
  db: Database;
  writer: VerticalSliceWriterFence;
  config: EngineeringExecutionConfig;
  caseId: string;
}): Promise<string> {
  const workspaceId = verticalSliceWorkspaceId(input.caseId);
  const current = await new WorkspaceRepository().find(input.db, workspaceId);
  if (current !== null) {
    if (
      current.case_id !== input.caseId ||
      current.repo !== input.config.repositoryId ||
      current.base_sha === null ||
      current.branch_name !== verticalSliceBranchName(workspaceId)
    )
      throw new Error("durable workspace mapping conflicts with deployment configuration");
    return current.base_sha;
  }
  await input.writer.assertCurrent(input.db);
  const repository = input.config.workspaceConfig.repositories[input.config.repositoryId]!;
  return resolveBaseBranch(
    {
      sourcePath: repository.sourcePath,
      mirrorPath: join(
        input.config.workspaceConfig.workspaceRoot,
        ".git-mirrors",
        input.config.repositoryId,
      ),
    },
    repository.baseBranch,
  );
}

export function createEngineeringExecution(input: {
  db: Database;
  jobs: JobStore;
  lease: JobLease;
  config: EngineeringExecutionConfig;
  transport: RuntimeTransport;
  modelConfig: RuntimeConfig;
  taskBrief: string;
  createReviewerSession: import("@remoteagent/review-loop").PreCommitReviewSessionFactory;
}) {
  const writer = writerFence(input.db, input.jobs, input.lease);
  const baselines = new BaselineWorkspaceStore({ root: input.config.baselineRoot });
  const artifacts = new LocalArtifactStore({ root: input.config.artifactRoot });
  const implementationExecutor: EngineeringSliceImplementationStageExecutor = {
    configDigest: canonicalDigest({
      deployment: input.config.configDigest,
      prompt: IMPLEMENTATION_PROMPT_VERSION,
      model: input.modelConfig.model,
    }),
    schemaDigest: implementationDefinition.schemaDigest,
    execute: async ({ binding, objective, context, orderedArtifacts }) => {
      const slice = sliceContract(orderedArtifacts, binding, input.config.writePathAllowlist);
      const prior = [...orderedArtifacts]
        .reverse()
        .find((row) => row.payload.artifact_kind === "SliceImplementationReceipt");
      const priorPaths =
        prior?.payload.artifact_kind === "SliceImplementationReceipt"
          ? prior.payload.cumulative_paths
          : [];
      const baseSha = await baseShaForAttempt({
        db: input.db,
        writer,
        config: input.config,
        caseId: binding.caseId,
      });
      let modelCalls = 0;
      const result = await executeVerticalSlice({
        db: input.db,
        workspaceConfig: input.config.workspaceConfig,
        repositoryId: input.config.repositoryId,
        baseSha,
        caseId: binding.caseId,
        runId: binding.runId,
        checkpointRevision: binding.checkpointRevision,
        writer,
        slice,
        writePathAllowlist: input.config.writePathAllowlist,
        attempt: binding.attempt,
        priorAgentPaths: priorPaths,
        baselineStore: baselines,
        implement: async (tools) => {
          const completion = await runStructuredContract(input.transport, input.modelConfig, {
            definition: implementationDefinition,
            expectedSchemaDigest: implementationDefinition.schemaDigest,
            promptVersion: IMPLEMENTATION_PROMPT_VERSION,
            stage: EngineeringStage.SLICE_IMPLEMENTATION,
            tools: toolDefinitions,
            execute: (name, value) => executeBoundedTool(tools, name, value),
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `Implement exactly this server-selected slice using only the seven supplied tools. Do not execute commands. Return only changed_files actually modified.\nObjective: ${objective}\nSlice: ${JSON.stringify(slice)}\nContext: ${context.packet}`,
                  },
                ],
              },
            ],
          });
          modelCalls = completion.modelCompletions.length;
          return { changed_files: completion.value.changed_files };
        },
      });
      const receipt = buildSliceImplementationReceipt({
        result,
        runId: binding.runId,
        workUnitId: binding.workUnitId,
        repositoryId: input.config.repositoryId,
        baseSha,
        branchName: verticalSliceBranchName(result.workspaceId),
        checkpointRevision: binding.checkpointRevision,
      });
      return { kind: "ARTIFACT", artifact: receipt, modelCalls };
    },
    afterDurableArtifact: async ({ binding, orderedArtifacts }) => {
      const receipt = implementationReceipt(orderedArtifacts, binding);
      await cleanupSliceImplementationBaseline({
        db: input.db,
        writer,
        workspaceConfig: input.config.workspaceConfig,
        receipt,
        baselineStore: baselines,
      });
    },
  };

  const executeGates = async ({
    binding,
    contextManifestDigest,
    orderedArtifacts,
    decisionIds,
    deadlineAt,
  }: {
    binding: import("@remoteagent/agent-orchestrator").EngineeringStageBinding;
    contextManifestDigest: string;
    orderedArtifacts: readonly EngineeringControlArtifactRevisionRow[];
    decisionIds: readonly string[];
    deadlineAt: string;
  }) => {
    if (binding.stage !== EngineeringStage.GATE_EXECUTION)
      throw new Error("generic system executor is gate-only");
    const slice = sliceContract(orderedArtifacts, binding, input.config.writePathAllowlist);
    const receipt = implementationReceipt(orderedArtifacts, binding);
    const observed = await observeSliceImplementationReceipt({
      db: input.db,
      writer,
      workspaceConfig: input.config.workspaceConfig,
      receipt,
      slice,
      writePathAllowlist: input.config.writePathAllowlist,
      baselineStore: baselines,
    });
    const result = await executeVerticalSliceGates({
      db: input.db,
      jobs: input.jobs,
      lease: input.lease,
      workspaceConfig: input.config.workspaceConfig,
      repositoryId: input.config.repositoryId,
      caseId: binding.caseId,
      runId: binding.runId,
      workUnitId: binding.workUnitId,
      checkpointRevision: binding.checkpointRevision,
      writer,
      slice,
      writePathAllowlist: input.config.writePathAllowlist,
      attempt: binding.attempt,
      baseline: observed.baseline,
      actual: observed.actual,
      catalog: input.config.catalog,
      store: artifacts,
      deadlineAt,
      contextDigest: contextManifestDigest,
      decisions: decisionIds,
      baselineStore: baselines,
    });
    return result;
  };

  const blockedGateArtifact = (
    binding: import("@remoteagent/agent-orchestrator").EngineeringStageBinding,
    reason: string,
  ): EngineeringArtifact =>
    engineeringArtifact.parse({
      schema_version: 1,
      artifact_kind: "TerminalReason",
      case_id: binding.caseId,
      run_id: binding.runId,
      revision: binding.checkpointRevision,
      reason: "BLOCKED",
      detail: `required gates did not pass: ${reason}`,
    });

  const gateExecutor: EngineeringGateStageExecutor = {
    configDigest: canonicalDigest({
      deployment: input.config.configDigest,
      route: "GATE_EXECUTION",
    }),
    schemaDigest: canonicalDigest({
      contract: "EngineeringEvidenceBundleOrTerminalReason",
      version: 1,
    }),
    execute: async ({ binding, context, orderedArtifacts, decisionIds, deadlineAt }) => {
      const result = await executeGates({
        binding,
        contextManifestDigest: engineeringArtifactDigest(context.compiled.manifest),
        orderedArtifacts,
        decisionIds,
        deadlineAt,
      });
      if (result.status === "BLOCKED" && result.reason === "AMBIGUOUS") {
        throw new Error("inner verification gate STARTED without a durable completion receipt");
      }
      return result.status === "PASS" ? result.bundle : blockedGateArtifact(binding, result.reason);
    },
    recover: async ({
      binding,
      contextManifestDigest,
      orderedArtifacts,
      decisionIds,
      deadlineAt,
    }) => {
      const result = await executeGates({
        binding,
        contextManifestDigest,
        orderedArtifacts,
        decisionIds,
        deadlineAt,
      });
      if (result.status === "BLOCKED" && result.reason === "AMBIGUOUS") {
        return Object.freeze({
          status: "AMBIGUOUS" as const,
          detail: "inner verification gate STARTED without a durable completion receipt",
        });
      }
      return Object.freeze({
        status: "RECOVERED" as const,
        artifact:
          result.status === "PASS" ? result.bundle : blockedGateArtifact(binding, result.reason),
      });
    },
  };

  const reviewExecutor: EngineeringReviewStageExecutor = {
    configDigest: canonicalDigest({
      deployment: input.config.configDigest,
      route: "PRE_COMMIT_REVIEW",
    }),
    schemaDigest: () => canonicalDigest({ contract: "PreCommitReviewOutput", version: 1 }),
    execute: async ({ binding, orderedArtifacts }) => {
      const slice = sliceContract(orderedArtifacts, binding, input.config.writePathAllowlist);
      const receipt = implementationReceipt(orderedArtifacts, binding);
      const evidence = evidenceBundle(orderedArtifacts, binding.attempt);
      const observed = await observeSliceImplementationReceipt({
        db: input.db,
        writer,
        workspaceConfig: input.config.workspaceConfig,
        receipt,
        slice,
        writePathAllowlist: input.config.writePathAllowlist,
        baselineStore: baselines,
      });
      const previousRawPatchDigest = previousCorrectionRawPatchDigest(
        orderedArtifacts,
        binding,
        slice,
      );
      try {
        const result = await executeVerticalSliceReview({
          db: input.db,
          lease: input.lease,
          workspaceConfig: input.config.workspaceConfig,
          repositoryId: input.config.repositoryId,
          caseId: binding.caseId,
          runId: binding.runId,
          workUnitId: binding.workUnitId,
          checkpointRevision: binding.checkpointRevision,
          writer,
          slice,
          writePathAllowlist: input.config.writePathAllowlist,
          attempt: binding.attempt,
          baseline: observed.baseline,
          actual: observed.actual,
          evidenceBundle: evidence.bundle,
          evidenceBundleDigest: evidence.digest,
          ...(previousRawPatchDigest === undefined
            ? {}
            : { previousBlockingRawPatchDigest: previousRawPatchDigest }),
          taskBrief: input.taskBrief,
          createReviewerSession: input.createReviewerSession,
          baselineStore: baselines,
        });
        return {
          kind: "ARTIFACT",
          artifact: result.decision,
          modelCalls: result.review.modelCalls,
        };
      } catch (error) {
        if (
          !(error instanceof ReviewContractError) ||
          error.message !== PRE_COMMIT_REVIEW_NO_CHANGE
        ) {
          throw error;
        }
        return {
          kind: "ARTIFACT",
          artifact: engineeringArtifact.parse({
            schema_version: 1,
            artifact_kind: "TerminalReason",
            case_id: binding.caseId,
            run_id: binding.runId,
            revision: binding.checkpointRevision,
            reason: "EXHAUSTED",
            detail: "NO_PROGRESS: corrected attempt produced no change from the rejected patch",
          }),
          modelCalls: 0,
        };
      }
    },
  };

  const localCommitExecutor: EngineeringLocalCommitStageExecutor = {
    configDigest: canonicalDigest({ deployment: input.config.configDigest, route: "LOCAL_COMMIT" }),
    schemaDigest: canonicalDigest({ contract: "LocalCommitReceipt", version: 1 }),
    prepare: async ({ binding, operationId, provenance }) => {
      const accepted = provenance.accepted.at(-1);
      if (accepted === undefined) throw new Error("local commit has no accepted slice");
      const rows = await new EngineeringControlPlaneRepository(
        productionRuntime(),
      ).listRunArtifactRevisions(input.db, { runId: binding.runId });
      const row = [...rows]
        .reverse()
        .find(
          (candidate) =>
            candidate.payload.artifact_kind === "SliceImplementationReceipt" &&
            candidate.payload.slice_id === accepted.sliceId &&
            candidate.payload.attempt === accepted.attempt,
        );
      if (row?.payload.artifact_kind !== "SliceImplementationReceipt") {
        throw new Error("local commit lacks the accepted durable implementation receipt");
      }
      const receipt = engineeringSliceImplementationReceipt.parse(row.payload);
      const actual = await observeSliceImplementationForCommit({
        db: input.db,
        writer,
        workspaceConfig: input.config.workspaceConfig,
        receipt,
        writePathAllowlist: input.config.writePathAllowlist,
      });
      return buildEvidenceBoundCommitDescriptor({
        operationId,
        caseId: binding.caseId,
        workUnitId: binding.workUnitId,
        workspaceId: receipt.workspace_id,
        repositoryId: receipt.repository_id,
        runId: binding.runId,
        checkpointRevision: binding.checkpointRevision,
        branchName: receipt.branch,
        expectedParentSha: receipt.base_sha,
        actual,
        accepted: provenance.accepted,
        finalVerificationDigest: provenance.finalVerificationDigest,
        summary: input.taskBrief,
        rawPatchDigest: receipt.raw_patch_digest,
      });
    },
    execute: ({ binding, descriptor }) =>
      executeEvidenceBoundLocalCommit({
        db: input.db,
        writer,
        workspaceConfig: input.config.workspaceConfig,
        repositoryId: input.config.repositoryId,
        caseId: binding.caseId,
        runId: binding.runId,
        workUnitId: binding.workUnitId,
        checkpointRevision: binding.checkpointRevision,
        descriptor,
      }),
    recover: ({ binding, descriptor }) =>
      recoverEvidenceBoundLocalCommit({
        db: input.db,
        workspaceConfig: input.config.workspaceConfig,
        repositoryId: input.config.repositoryId,
        caseId: binding.caseId,
        runId: binding.runId,
        workUnitId: binding.workUnitId,
        checkpointRevision: binding.checkpointRevision,
        descriptor,
      }),
  };
  return Object.freeze({
    implementationExecutor,
    gateExecutor,
    reviewExecutor,
    localCommitExecutor,
    writer,
    baselines,
  });
}

export function createProductionEngineeringRuntimePort(input: {
  db: Database;
  jobs: JobStore;
  lease: JobLease;
  config: EngineeringExecutionConfig;
  transport: RuntimeTransport;
  modelConfig: RuntimeConfig;
  readContext: RoleContextReader;
  stageExecutor: EngineeringStageExecutor;
  reviewSessionFactory: import("@remoteagent/review-loop").PreCommitReviewSessionFactory;
  policy: EngineeringWorkflowPolicyOptions;
  workflowDeadlineMs?: number;
  controlPlane?: EngineeringControlPlaneRepository;
  metrics?: MetricRegistry;
}) {
  const approvalCandidate = engineeringApprovalCandidateFromLease(input.lease);
  const execution = createEngineeringExecution({
    db: input.db,
    jobs: input.jobs,
    lease: input.lease,
    config: input.config,
    transport: input.transport,
    modelConfig: input.modelConfig,
    taskBrief: "Review the exact engineering work unit against its durable slice contract.",
    createReviewerSession: input.reviewSessionFactory,
  });
  return createPostgresEngineeringRuntimePort({
    db: input.db,
    lease: input.lease,
    jobs: input.jobs,
    readContext: input.readContext,
    executor: input.stageExecutor,
    implementationExecutor: execution.implementationExecutor,
    gateExecutor: execution.gateExecutor,
    reviewExecutor: execution.reviewExecutor,
    localCommitExecutor: execution.localCommitExecutor,
    requiredRepositoryId: input.config.repositoryId,
    writePathAllowlist: input.config.writePathAllowlist,
    policy: input.policy,
    ...(input.controlPlane === undefined ? {} : { controlPlane: input.controlPlane }),
    ...(input.workflowDeadlineMs === undefined
      ? {}
      : { workflowDeadlineMs: input.workflowDeadlineMs }),
    ...(approvalCandidate === undefined ? {} : { approvalCandidate }),
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
  });
}
