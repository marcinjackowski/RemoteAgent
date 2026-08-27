/**
 * Server-owned execution boundary for one accepted vertical slice.
 *
 * This is deliberately not an orchestrator: SupervisorRuntime chooses the
 * stage, slice and attempt. This boundary only materializes/recover the one
 * case workspace and hands an injected implementer a capability object whose
 * shape cannot express command execution, scope selection or operation ids.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  canonicalDigest,
  assertEngineeringPathsWithinWriteAllowlist,
  engineeringLocalCommitReceipt,
  engineeringReviewDecision,
  engineeringSliceImplementationReceipt,
  engineeringSliceContract,
  relativeRepositoryPath,
  type EngineeringEvidenceBundle,
  type EngineeringLocalCommitReceipt,
  type EngineeringReviewDecision,
  type EngineeringSliceImplementationReceipt,
  type EngineeringSliceContract,
} from "@remoteagent/contracts";
import {
  Database,
  JobStore,
  WorkspaceRepository,
  type JobLease,
  type Queryable,
} from "@remoteagent/database";
import {
  GIT_DIRTY_FOREIGN,
  GitLifecycle,
  GitWorkingTreeState,
  gitEvidenceBoundCommitDescriptor,
  type GitEvidenceBoundCommitDescriptor,
} from "@remoteagent/git-lifecycle";
import {
  OperationLedgerRepository,
  ToolKind,
  ToolOutcome,
  createBoundedImplementationToolset,
  type BoundedImplementationToolName,
  type BoundedImplementationToolset,
  type ImplementationToolResult,
} from "@remoteagent/implementation-tools";
import {
  executeFreshPreCommitReview,
  type FreshPreCommitReviewResult,
  type PreCommitReviewSessionFactory,
} from "@remoteagent/review-loop";
import {
  BaselineWorkspaceStore,
  CodeOwnedGeneratorCatalog,
  VerificationGateCatalog,
  VerificationGateStatus,
  deriveBaselineTreeDelta,
  executeCodeOwnedGenerators,
  executeVerificationGateBatch,
  type ArtifactStore,
  type BaselineWorkspaceBinding,
  type BaselineWorkspaceReference,
  type VerificationGateAggregate,
  type VerificationGateReceipt,
  type VerificationGatePlatformAdapter,
} from "@remoteagent/test-evidence";
import {
  LocalWorkspaceAdapter,
  WorkspaceFencingError,
  adaptWorkspaceRepository,
  bindWorkspaceFence,
  computeTreeDigest,
  type DurableWorkspaceFence,
  type WorkspaceFence,
  type WorkspaceIdentity,
} from "@remoteagent/workspace-runner";

import {
  recordEngineeringDebugGateBoundaryError,
  recordEngineeringDebugGateProgress,
  recordEngineeringDebugToolResult,
} from "./engineering-debug-journal.js";

import type { WorkspaceConfig } from "./workspace-config.js";

export type VerticalSliceWriterFence = DurableWorkspaceFence<Queryable>;

export type VerticalSliceImplementerContext = Readonly<{
  caseId: string;
  runId: string;
  checkpointRevision: number;
  workspaceId: string;
  slice: EngineeringSliceContract;
  attempt: number;
}>;

export type VerticalSliceImplementerReport = Readonly<{ changed_files: readonly string[] }>;

function parseImplementerReport(input: unknown): VerticalSliceImplementerReport {
  if (
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).length !== 1 ||
    !("changed_files" in input) ||
    !Array.isArray(input.changed_files) ||
    input.changed_files.length > 512 ||
    input.changed_files.some((path) => !relativeRepositoryPath.safeParse(path).success) ||
    new Set(input.changed_files).size !== input.changed_files.length
  ) {
    throw new Error("implementer report must contain only canonical unique changed_files");
  }
  return Object.freeze({ changed_files: Object.freeze([...input.changed_files] as string[]) });
}

function normalizeImplementerReport(input: {
  report: VerticalSliceImplementerReport;
  operationResults: readonly ImplementationToolResult[];
  actualChangedPaths: readonly string[];
}): VerticalSliceImplementerReport {
  const receiptPaths = new Set(
    input.operationResults
      .filter(
        (result) =>
          result.outcome === ToolOutcome.SUCCEEDED &&
          (result.kind === ToolKind.WRITE_FILE || result.kind === ToolKind.APPLY_PATCH),
      )
      .flatMap((result) => result.changed_files),
  );
  const reportedPaths = new Set(input.report.changed_files);
  const actualPaths = new Set(input.actualChangedPaths);

  if (
    input.report.changed_files.some((path) => !actualPaths.has(path)) ||
    input.actualChangedPaths.some((path) => !receiptPaths.has(path) && !reportedPaths.has(path))
  ) {
    throw new Error(
      "implementer changed_files claim does not match actual slice delta before generators",
    );
  }

  return Object.freeze({
    changed_files: Object.freeze([...input.actualChangedPaths].sort()),
  });
}

export type VerticalSliceImplementer = (
  tools: BoundedImplementationToolset,
  context: VerticalSliceImplementerContext,
) => Promise<VerticalSliceImplementerReport>;

export type ExecuteVerticalSliceInput = Readonly<{
  db: Database;
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  baseSha: string;
  caseId: string;
  runId: string;
  checkpointRevision: number;
  writer: VerticalSliceWriterFence;
  slice: EngineeringSliceContract;
  writePathAllowlist: readonly string[];
  attempt: number;
  implement: VerticalSliceImplementer;
  /** Code-owned prefetch budget; omitted callers retain the default model discovery ceiling. */
  discoveryCallLimit?: number;
  /** Prior server-observed agent paths, never model supplied. */
  priorAgentPaths?: readonly string[];
  baselineStore?: BaselineWorkspaceStore;
  generatorCatalog?: CodeOwnedGeneratorCatalog;
  generatorArtifactRoot?: string;
}>;

export type VerticalSliceActualEvidence = Readonly<{
  changedFiles: readonly string[];
  cumulativeAgentPaths: readonly string[];
  treeDigest: string;
  diffDigest: string;
  patch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}>;

export type EngineeringDiffPolicy = Readonly<{
  schema_version: 1;
  max_files_changed: number;
  max_total_changes: number;
  max_deletions: number;
  destructive_deletion_ratio: number;
  destructive_min_deletions: number;
}>;

/** Code-owned ceiling applied to the exact staged Git diff before it becomes evidence. */
export const ENGINEERING_DIFF_POLICY: EngineeringDiffPolicy = Object.freeze({
  schema_version: 1,
  max_files_changed: 16,
  max_total_changes: 2_000,
  max_deletions: 800,
  destructive_deletion_ratio: 0.8,
  destructive_min_deletions: 20,
});

export const ENGINEERING_DIFF_POLICY_REFUSED = "ENGINEERING_DIFF_POLICY_REFUSED";

function refuseEngineeringDiff(reason: string): never {
  const error = new Error(`engineering diff refused by code-owned policy: ${reason}`);
  Reflect.set(error, "code", ENGINEERING_DIFF_POLICY_REFUSED);
  Reflect.set(error, "reason", reason);
  throw error;
}

export function assertEngineeringDiffWithinPolicy(
  diff: Readonly<{
    filesChanged: number;
    insertions: number;
    deletions: number;
  }>,
): void {
  const policy = ENGINEERING_DIFF_POLICY;
  if (diff.filesChanged > policy.max_files_changed) refuseEngineeringDiff("TOO_MANY_FILES");
  if (diff.insertions + diff.deletions > policy.max_total_changes) {
    refuseEngineeringDiff("TOO_MANY_TOTAL_CHANGES");
  }
  if (diff.deletions > policy.max_deletions) refuseEngineeringDiff("TOO_MANY_DELETIONS");
  const total = diff.insertions + diff.deletions;
  if (
    diff.deletions >= policy.destructive_min_deletions &&
    total > 0 &&
    diff.deletions / total > policy.destructive_deletion_ratio
  ) {
    refuseEngineeringDiff("DESTRUCTIVE_DELETION_RATIO");
  }
}

export type VerticalSliceExecutionResult = Readonly<{
  caseId: string;
  workspaceId: string;
  workspacePath: string;
  lifecycle: "CREATED" | "RESUMED";
  sliceId: string;
  attempt: number;
  operationResults: readonly ImplementationToolResult[];
  baseline: BaselineWorkspaceReference;
  actual: VerticalSliceActualEvidence;
  /** Model-authored and therefore never evidence. */
  implementerReport: VerticalSliceImplementerReport;
}>;

/** Convert actual server observations into the sole durable implementation handoff. */
export function buildSliceImplementationReceipt(input: {
  result: VerticalSliceExecutionResult;
  runId: string;
  workUnitId: string;
  repositoryId: string;
  baseSha: string;
  branchName: string;
  checkpointRevision: number;
}): EngineeringSliceImplementationReceipt {
  const result = input.result;
  const toolReceiptDigests = result.operationResults
    .map((receipt) => canonicalDigest(receipt))
    .sort();
  return engineeringSliceImplementationReceipt.parse({
    schema_version: 1,
    artifact_kind: "SliceImplementationReceipt",
    case_id: result.caseId,
    run_id: input.runId,
    revision: input.checkpointRevision,
    authority: "SERVER_OWNED",
    receipt_id: `slice-implementation-${canonicalDigest({
      case_id: result.caseId,
      work_unit_id: input.workUnitId,
      slice_id: result.sliceId,
      attempt: result.attempt,
      tree_digest: result.actual.treeDigest,
      diff_digest: result.actual.diffDigest,
      tool_receipt_digests: toolReceiptDigests,
    }).slice(7, 39)}`,
    work_unit_id: input.workUnitId,
    slice_id: result.sliceId,
    attempt: result.attempt,
    workspace_id: result.workspaceId,
    repository_id: input.repositoryId,
    base_sha: input.baseSha.toLowerCase(),
    branch: input.branchName,
    baseline: result.baseline,
    tree_digest: result.actual.treeDigest,
    diff_digest: result.actual.diffDigest,
    raw_patch_digest: canonicalDigest(result.actual.patch),
    changed_paths: [...result.actual.changedFiles].sort(),
    cumulative_paths: [...result.actual.cumulativeAgentPaths].sort(),
    files_changed: result.actual.filesChanged,
    insertions: result.actual.insertions,
    deletions: result.actual.deletions,
    tool_receipt_digests: toolReceiptDigests,
  });
}

export type ExecuteVerticalSliceGateInput = Readonly<{
  db: Database;
  jobs: JobStore;
  lease: JobLease;
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  caseId: string;
  runId: string;
  workUnitId: string;
  checkpointRevision: number;
  writer: VerticalSliceWriterFence;
  slice: EngineeringSliceContract;
  expectedGateIds?: readonly string[];
  writePathAllowlist: readonly string[];
  attempt: number;
  baseline: BaselineWorkspaceReference;
  actual: VerticalSliceActualEvidence;
  catalog: VerificationGateCatalog;
  store: ArtifactStore;
  deadlineAt: string;
  contextDigest: string;
  reviewFindings?: readonly string[];
  decisions?: readonly string[];
  baselineStore?: BaselineWorkspaceStore;
  platformAdapter?: VerificationGatePlatformAdapter;
  recoveryObserveCompletion?: (input: {
    operationId: string;
    completionId: string;
  }) => Promise<void>;
  recoveryOnly?: boolean;
  signal?: AbortSignal;
}>;

export type VerticalSliceGateResult =
  | Readonly<{
      status: "PASS";
      aggregate: VerificationGateAggregate;
      bundle: EngineeringEvidenceBundle;
      bundleDigest: string;
      actual: VerticalSliceActualEvidence;
    }>
  | Readonly<{
      status: "BLOCKED";
      aggregate: VerificationGateAggregate | null;
      bundle: null;
      reason: string;
      blockingGateIds: readonly string[];
      receipts: readonly VerificationGateReceipt[];
      actual: VerticalSliceActualEvidence;
    }>;

export type ExecuteVerticalSliceReviewInput = Readonly<{
  db: Database;
  lease: JobLease;
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  caseId: string;
  runId: string;
  workUnitId: string;
  checkpointRevision: number;
  writer: VerticalSliceWriterFence;
  slice: EngineeringSliceContract;
  writePathAllowlist: readonly string[];
  attempt: number;
  baseline: BaselineWorkspaceReference;
  actual: VerticalSliceActualEvidence;
  evidenceBundle: EngineeringEvidenceBundle;
  evidenceBundleDigest: string;
  /** Present only for a runtime-owned correction, derived from prior durable review evidence. */
  previousBlockingRawPatchDigest?: string;
  taskBrief: string;
  createReviewerSession: PreCommitReviewSessionFactory;
  baselineStore?: BaselineWorkspaceStore;
}>;

export type VerticalSliceReviewResult = Readonly<{
  review: FreshPreCommitReviewResult;
  decision: EngineeringReviewDecision;
}>;

export type LocalCommitAcceptedPair = Readonly<{
  sliceId: string;
  attempt: number;
  evidenceDigest: string;
  reviewDigest: string;
}>;

export function buildEvidenceBoundCommitDescriptor(input: {
  operationId: string;
  caseId: string;
  workUnitId: string;
  workspaceId: string;
  repositoryId: string;
  runId: string;
  checkpointRevision: number;
  branchName: string;
  expectedParentSha: string;
  actual: VerticalSliceActualEvidence;
  accepted: readonly LocalCommitAcceptedPair[];
  finalVerificationDigest: string;
  summary: string;
  /** Durable receipt digest used after the per-attempt baseline has been cleaned. */
  rawPatchDigest?: string;
}): GitEvidenceBoundCommitDescriptor {
  const operationMarker = `[remoteagent-operation:${input.operationId}]`;
  const accepted = input.accepted.map((pair) => ({
    slice_id: pair.sliceId,
    attempt: pair.attempt,
    evidence_digest: pair.evidenceDigest,
    review_digest: pair.reviewDigest,
  }));
  const exactPaths = [...new Set(input.actual.cumulativeAgentPaths)].sort();
  const messageSummary = input.summary.trim().replace(/\s+/gu, " ").slice(0, 512);
  return gitEvidenceBoundCommitDescriptor.parse({
    schema_version: 1,
    operation_id: input.operationId,
    case_id: input.caseId,
    work_unit_id: input.workUnitId,
    workspace_id: input.workspaceId,
    repository_id: input.repositoryId,
    run_id: input.runId,
    checkpoint_revision: input.checkpointRevision,
    branch_name: input.branchName,
    expected_parent_sha: input.expectedParentSha,
    exact_paths: exactPaths,
    message: `${messageSummary || "RemoteAgent engineering change"}\n\n${operationMarker}`,
    operation_marker: operationMarker,
    tree_digest: input.actual.treeDigest,
    actual_diff_digest: input.actual.diffDigest,
    raw_patch_digest: input.rawPatchDigest ?? canonicalDigest(input.actual.patch),
    accepted,
    evidence_digest: canonicalDigest(accepted.map((pair) => pair.evidence_digest)),
    review_digest: canonicalDigest(accepted.map((pair) => pair.review_digest)),
    final_verification_digest: input.finalVerificationDigest,
  });
}

function assertLocalCommitBinding(input: {
  descriptor: GitEvidenceBoundCommitDescriptor;
  repositoryId: string;
  caseId: string;
  runId: string;
  workUnitId: string;
  checkpointRevision: number;
}): GitEvidenceBoundCommitDescriptor {
  const descriptor = gitEvidenceBoundCommitDescriptor.parse(input.descriptor);
  const expectedWorkspace = verticalSliceWorkspaceId(input.caseId);
  if (
    descriptor.case_id !== input.caseId ||
    descriptor.run_id !== input.runId ||
    descriptor.work_unit_id !== input.workUnitId ||
    descriptor.checkpoint_revision !== input.checkpointRevision ||
    descriptor.workspace_id !== expectedWorkspace ||
    descriptor.repository_id !== input.repositoryId ||
    descriptor.branch_name !== verticalSliceBranchName(expectedWorkspace)
  ) {
    throw new Error("local commit descriptor crosses its server-owned binding");
  }
  return descriptor;
}

async function localCommitLifecycle(input: {
  db: Database;
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  caseId: string;
  descriptor: GitEvidenceBoundCommitDescriptor;
}): Promise<GitLifecycle> {
  const repository = input.workspaceConfig.repositories[input.repositoryId];
  if (repository === undefined) throw new Error("repository is not on the server allowlist");
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const mapping = await registry.find(input.descriptor.workspace_id);
  if (
    mapping === null ||
    mapping.caseId !== input.caseId ||
    mapping.repo !== input.repositoryId ||
    mapping.branchName !== input.descriptor.branch_name
  ) {
    throw new Error("local commit requires the exact durable workspace mapping");
  }
  return new GitLifecycle({
    worktreePath: mapping.target,
    mirrorPath: join(input.workspaceConfig.workspaceRoot, ".git-mirrors", input.repositoryId),
    scope: { case_id: input.caseId, workspace_id: input.descriptor.workspace_id },
    repositoryId: input.repositoryId,
    declaredPaths: input.descriptor.exact_paths,
  });
}

/** Execute the one LOCAL_COMMIT mutation after its descriptor is durable. */
export async function executeEvidenceBoundLocalCommit(input: {
  db: Database;
  writer: VerticalSliceWriterFence;
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  caseId: string;
  runId: string;
  workUnitId: string;
  checkpointRevision: number;
  descriptor: GitEvidenceBoundCommitDescriptor;
}): Promise<EngineeringLocalCommitReceipt> {
  validateWriter(input.writer, input.caseId);
  const descriptor = assertLocalCommitBinding(input);
  const lifecycle = await localCommitLifecycle({ ...input, descriptor });
  const receipt = await lifecycle.commitEvidenceBound({
    descriptor,
    beforeStage: async () => input.writer.assertCurrent(input.db),
    beforeCommit: async () => input.writer.assertCurrent(input.db),
  });
  return engineeringLocalCommitReceipt.parse({
    schema_version: 1,
    artifact_kind: "LocalCommitReceipt",
    case_id: input.caseId,
    run_id: input.runId,
    revision: input.checkpointRevision,
    authority: "SERVER_OWNED",
    receipt_id: `local-commit-${canonicalDigest(receipt).slice(7, 39)}`,
    branch: receipt.branch_name,
    commit_sha: receipt.commit_sha,
    parent_sha: receipt.parent_sha,
    tree_digest: descriptor.tree_digest,
    diff_digest: descriptor.actual_diff_digest,
    evidence_digest: descriptor.evidence_digest,
    review_digest: descriptor.review_digest,
    verification_decision_digest: descriptor.final_verification_digest,
  });
}

/** Observe only; a non-matching HEAD remains ambiguous and is never retried. */
export async function recoverEvidenceBoundLocalCommit(input: {
  db: Database;
  workspaceConfig: WorkspaceConfig;
  repositoryId: string;
  caseId: string;
  runId: string;
  workUnitId: string;
  checkpointRevision: number;
  descriptor: GitEvidenceBoundCommitDescriptor;
}): Promise<EngineeringLocalCommitReceipt | null> {
  const descriptor = assertLocalCommitBinding(input);
  const lifecycle = await localCommitLifecycle({ ...input, descriptor });
  const receipt = await lifecycle.observeEvidenceBoundCommit(descriptor);
  if (receipt === null) return null;
  return engineeringLocalCommitReceipt.parse({
    schema_version: 1,
    artifact_kind: "LocalCommitReceipt",
    case_id: input.caseId,
    run_id: input.runId,
    revision: input.checkpointRevision,
    authority: "SERVER_OWNED",
    receipt_id: `local-commit-${canonicalDigest(receipt).slice(7, 39)}`,
    branch: receipt.branch_name,
    commit_sha: receipt.commit_sha,
    parent_sha: receipt.parent_sha,
    tree_digest: descriptor.tree_digest,
    diff_digest: descriptor.actual_diff_digest,
    evidence_digest: descriptor.evidence_digest,
    review_digest: descriptor.review_digest,
    verification_decision_digest: descriptor.final_verification_digest,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable, path-policy-safe identity. The DB's unique case mapping remains the collision fence. */
export function verticalSliceWorkspaceId(caseId: string): string {
  return `engineering-${digest(caseId).slice(0, 32)}`;
}

export function verticalSliceBranchName(workspaceId: string): string {
  return `remoteagent/${workspaceId}`;
}

function operationIdFactory(input: {
  caseId: string;
  workspaceId: string;
  runId: string;
  checkpointRevision: number;
  sliceId: string;
  attempt: number;
}): (tool: BoundedImplementationToolName, sequence: number) => string {
  return (tool, sequence) =>
    `vs:${digest(
      `${input.caseId}\0${input.workspaceId}\0${input.runId}\0${String(input.checkpointRevision)}\0${input.sliceId}\0${String(input.attempt)}\0${tool}\0${String(sequence)}`,
    )}`;
}

function generatorOperationIdFactory(input: {
  caseId: string;
  workspaceId: string;
  runId: string;
  checkpointRevision: number;
  sliceId: string;
  attempt: number;
}): (generatorId: string, phase: "command" | "materialize") => string {
  return (generatorId, phase) =>
    `vsg:${digest(
      `${input.caseId}\0${input.workspaceId}\0${input.runId}\0${String(input.checkpointRevision)}\0${input.sliceId}\0${String(input.attempt)}\0${generatorId}\0${phase}`,
    )}`;
}

function validateWriter(writer: VerticalSliceWriterFence | undefined, caseId: string): void {
  if (
    writer === undefined ||
    writer.caseId !== caseId ||
    writer.leaseOwner.trim().length === 0 ||
    !Number.isSafeInteger(writer.fencingToken) ||
    writer.fencingToken < 1 ||
    typeof writer.assertCurrent !== "function"
  ) {
    throw new WorkspaceFencingError("A current, case-bound writer fence is required");
  }
}

function baselineBinding(input: {
  caseId: string;
  workspaceId: string;
  runId: string;
  checkpointRevision: number;
  sliceId: string;
  attempt: number;
}): BaselineWorkspaceBinding {
  return {
    case_id: input.caseId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    checkpoint_revision: input.checkpointRevision,
    slice_id: input.sliceId,
    attempt: input.attempt,
  };
}

function baselineStore(input: {
  workspaceConfig: WorkspaceConfig;
  baselineStore?: BaselineWorkspaceStore;
}): BaselineWorkspaceStore {
  return (
    input.baselineStore ??
    new BaselineWorkspaceStore({
      root: join(input.workspaceConfig.workspaceRoot, ".engineering-baselines"),
    })
  );
}

function pathAllowed(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

async function actualEvidence(input: {
  store: BaselineWorkspaceStore;
  binding: BaselineWorkspaceBinding;
  baseline: BaselineWorkspaceReference;
  workspacePath: string;
  repositoryId: string;
  mirrorPath: string;
  caseId: string;
  workspaceId: string;
  allowedPaths: readonly string[];
  priorAgentPaths: readonly string[];
  claimedChangedFiles?: readonly string[];
  assertCurrent: () => Promise<void>;
}): Promise<VerticalSliceActualEvidence> {
  return input.store.inspect(input.binding, input.workspacePath, input.baseline, async (root) => {
    const delta = await deriveBaselineTreeDelta(root, input.workspacePath);
    if (delta.changed_paths.some((path) => !pathAllowed(path, input.allowedPaths))) {
      throw new Error("actual slice delta escaped server-owned allowed_paths");
    }
    if (
      input.claimedChangedFiles !== undefined &&
      !samePaths(input.claimedChangedFiles, delta.changed_paths)
    ) {
      throw new Error("implementer changed_files claim does not match actual slice delta");
    }
    const cumulative = [...new Set([...input.priorAgentPaths, ...delta.changed_paths])].sort();
    const git = new GitLifecycle({
      worktreePath: input.workspacePath,
      mirrorPath: input.mirrorPath,
      scope: { case_id: input.caseId, workspace_id: input.workspaceId },
      repositoryId: input.repositoryId,
      declaredPaths: cumulative,
    });
    const before = await git.status();
    if (before.state === GitWorkingTreeState.DIRTY_FOREIGN) {
      const error = new Error("actual Git status contains foreign paths");
      Reflect.set(error, "code", GIT_DIRTY_FOREIGN);
      throw error;
    }
    await input.assertCurrent();
    await git.stage(delta.changed_paths);
    const after = await git.status();
    if (after.state === GitWorkingTreeState.DIRTY_FOREIGN) {
      throw new Error("staging produced a foreign Git state");
    }
    const diff = await git.diff();
    if (diff.truncated) throw new Error("actual diff is truncated and cannot become evidence");
    assertEngineeringDiffWithinPolicy(diff);
    const diffDigest = canonicalDigest({
      patch: diff.patch,
      files_changed: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      slice_changed_files: delta.changed_paths,
    });
    return Object.freeze({
      changedFiles: Object.freeze([...delta.changed_paths]),
      cumulativeAgentPaths: Object.freeze(cumulative),
      treeDigest: delta.current_tree_digest,
      diffDigest,
      patch: diff.patch,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
    });
  });
}

/** Execute exactly one runtime-selected slice attempt. */
export async function executeVerticalSlice(
  input: ExecuteVerticalSliceInput,
): Promise<VerticalSliceExecutionResult> {
  const slice = engineeringSliceContract.parse(input.slice);
  assertEngineeringPathsWithinWriteAllowlist(slice.allowed_paths, input.writePathAllowlist);
  if (
    slice.case_id !== input.caseId ||
    slice.run_id !== input.runId ||
    slice.revision !== input.checkpointRevision
  ) {
    throw new Error("SliceContract does not match the server-owned runtime binding");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("slice attempt must be a positive safe integer");
  }
  validateWriter(input.writer, input.caseId);

  const repository = input.workspaceConfig.repositories[input.repositoryId];
  if (repository === undefined) throw new Error("repository is not on the server allowlist");

  const workspaceId = verticalSliceWorkspaceId(input.caseId);
  const identity: WorkspaceIdentity = { caseId: input.caseId, workspaceId };
  const fence: WorkspaceFence = {
    leaseOwner: input.writer.leaseOwner,
    fencingToken: input.writer.fencingToken,
  };
  const boundFence = bindWorkspaceFence(identity, input.db, input.writer);
  const assertCurrent = async (): Promise<void> => {
    await boundFence.assertCurrent({ identity, fence });
  };

  // Resume itself is read-heavy, but it authorizes access to a live writer
  // workspace. Check before both branches; create also repeats the check at each
  // of its own mutating boundaries.
  await assertCurrent();
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const adapter = new LocalWorkspaceAdapter({
    workspaceRoot: input.workspaceConfig.workspaceRoot,
    repositories: Object.fromEntries(
      Object.entries(input.workspaceConfig.repositories).map(([id, config]) => [
        id,
        { sourcePath: config.sourcePath },
      ]),
    ),
    workspaceRegistry: registry,
    fenceValidator: boundFence,
  });
  const expectedBranch = verticalSliceBranchName(workspaceId);
  const existing = await registry.find(workspaceId);
  let lifecycle: "CREATED" | "RESUMED";
  if (existing === null) {
    await adapter.create({
      identity,
      fence,
      repositoryId: input.repositoryId,
      baseSha: input.baseSha,
      branchName: expectedBranch,
    });
    lifecycle = "CREATED";
  } else {
    if (
      existing.caseId !== input.caseId ||
      existing.repo !== input.repositoryId ||
      existing.baseSha !== input.baseSha ||
      existing.branchName !== expectedBranch
    ) {
      throw new Error("workspace mapping conflicts with the server-owned execution binding");
    }
    await assertCurrent();
    await adapter.resume({ identity, fence });
    lifecycle = "RESUMED";
  }

  const mapping = await registry.find(workspaceId);
  if (mapping === null) throw new Error("workspace mapping was not durable after materialization");

  const durableBaselineStore = baselineStore(input);
  const binding = baselineBinding({
    caseId: input.caseId,
    workspaceId,
    runId: input.runId,
    checkpointRevision: input.checkpointRevision,
    sliceId: slice.slice_id,
    attempt: input.attempt,
  });
  // This is intentionally before constructing or handing out the first write
  // capability. Exact replay verifies the already captured bytes and binding.
  const baseline = await durableBaselineStore.prepare(binding, mapping.target);

  const operationResults: ImplementationToolResult[] = [];
  const tools = await createBoundedImplementationToolset({
    root: mapping.target,
    identity: { case_id: input.caseId, workspace_id: workspaceId },
    ledger: new OperationLedgerRepository(),
    runTransaction: (fn) => input.db.withTransaction(fn),
    allowedPaths: slice.allowed_paths,
    firstMutationPaths: slice.test_paths,
    ...(input.discoveryCallLimit === undefined
      ? {}
      : { maxDiscoveryCalls: input.discoveryCallLimit }),
    beforeMutation: assertCurrent,
    operationIdFor: operationIdFactory({
      caseId: input.caseId,
      workspaceId,
      runId: slice.run_id,
      checkpointRevision: slice.revision,
      sliceId: slice.slice_id,
      attempt: input.attempt,
    }),
    onResult: (result) => {
      operationResults.push(result);
      recordEngineeringDebugToolResult(result);
    },
  });
  const implementerReport = await input.implement(tools, {
    caseId: input.caseId,
    runId: input.runId,
    checkpointRevision: input.checkpointRevision,
    workspaceId,
    slice,
    attempt: input.attempt,
  });
  const report = parseImplementerReport(implementerReport);
  if (operationResults.some((result) => result.outcome === "AMBIGUOUS")) {
    throw new Error("ambiguous implementation operation cannot produce slice evidence");
  }
  const implementationDelta = await durableBaselineStore.inspect(
    binding,
    mapping.target,
    baseline,
    (root) => deriveBaselineTreeDelta(root, mapping.target),
  );
  if (implementationDelta.changed_paths.some((path) => !pathAllowed(path, slice.allowed_paths))) {
    throw new Error("actual implementation delta escaped server-owned allowed_paths");
  }
  const normalizedReport = normalizeImplementerReport({
    report,
    operationResults,
    actualChangedPaths: implementationDelta.changed_paths,
  });
  let generatedPaths: readonly string[] = [];
  if (input.generatorCatalog !== undefined && input.generatorCatalog.definitions.length > 0) {
    if (input.generatorArtifactRoot === undefined) {
      throw new Error("generator artifact root is required for a non-empty generator catalog");
    }
    const generated = await executeCodeOwnedGenerators({
      authoritativeRoot: mapping.target,
      artifactRoot: input.generatorArtifactRoot,
      identity: { case_id: input.caseId, workspace_id: workspaceId },
      ledger: new OperationLedgerRepository(),
      runTransaction: (fn) => input.db.withTransaction(fn),
      catalog: input.generatorCatalog,
      implementationChangedPaths: implementationDelta.changed_paths,
      allowedPaths: slice.allowed_paths,
      beforeMutation: assertCurrent,
      operationIdFor: generatorOperationIdFactory({
        caseId: input.caseId,
        workspaceId,
        runId: slice.run_id,
        checkpointRevision: slice.revision,
        sliceId: slice.slice_id,
        attempt: input.attempt,
      }),
    });
    generatedPaths = generated.changedFiles;
    for (const result of generated.operationResults) {
      operationResults.push(result);
      recordEngineeringDebugToolResult(result);
    }
  }
  const actual = await actualEvidence({
    store: durableBaselineStore,
    binding,
    baseline,
    workspacePath: mapping.target,
    repositoryId: input.repositoryId,
    mirrorPath: join(input.workspaceConfig.workspaceRoot, ".git-mirrors", input.repositoryId),
    caseId: input.caseId,
    workspaceId,
    allowedPaths: slice.allowed_paths,
    priorAgentPaths: input.priorAgentPaths ?? [],
    claimedChangedFiles: [
      ...new Set([...normalizedReport.changed_files, ...generatedPaths]),
    ].sort(),
    assertCurrent,
  });
  // A first attempt with no cumulative patch made no progress. A correction may legitimately
  // produce no new leaf delta while the rejected patch is still present; the fresh review
  // boundary compares that cumulative raw patch and terminalizes exact no-change safely.
  if (actual.changedFiles.length === 0 && actual.cumulativeAgentPaths.length === 0) {
    throw new Error("NO_PROGRESS: slice implementation produced no actual file change");
  }
  return Object.freeze({
    caseId: input.caseId,
    workspaceId,
    workspacePath: mapping.target,
    lifecycle,
    sliceId: slice.slice_id,
    attempt: input.attempt,
    operationResults: Object.freeze([...operationResults]),
    baseline,
    actual,
    implementerReport: normalizedReport,
  });
}

/** Rebuild transient patch/evidence bytes exclusively from a durable receipt and the worktree. */
export async function observeSliceImplementationReceipt(input: {
  db: Database;
  writer: VerticalSliceWriterFence;
  workspaceConfig: WorkspaceConfig;
  receipt: EngineeringSliceImplementationReceipt;
  slice: EngineeringSliceContract;
  writePathAllowlist: readonly string[];
  baselineStore?: BaselineWorkspaceStore;
}): Promise<{
  baseline: BaselineWorkspaceReference;
  actual: VerticalSliceActualEvidence;
  workspacePath: string;
}> {
  const receipt = engineeringSliceImplementationReceipt.parse(input.receipt);
  const slice = engineeringSliceContract.parse(input.slice);
  const writePathAllowlist = input.writePathAllowlist;
  assertEngineeringPathsWithinWriteAllowlist(slice.allowed_paths, writePathAllowlist);
  assertEngineeringPathsWithinWriteAllowlist(receipt.cumulative_paths, writePathAllowlist);
  validateWriter(input.writer, receipt.case_id);
  if (
    slice.case_id !== receipt.case_id ||
    slice.run_id !== receipt.run_id ||
    slice.revision !== receipt.revision ||
    slice.slice_id !== receipt.slice_id
  ) {
    throw new Error("implementation receipt does not match its durable SliceContract");
  }
  const repository = input.workspaceConfig.repositories[receipt.repository_id];
  if (repository === undefined)
    throw new Error("receipt repository is not on the server allowlist");
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const mapping = await registry.find(receipt.workspace_id);
  if (
    mapping === null ||
    mapping.caseId !== receipt.case_id ||
    mapping.repo !== receipt.repository_id ||
    mapping.baseSha.toLowerCase() !== receipt.base_sha ||
    mapping.branchName !== receipt.branch
  ) {
    throw new Error("implementation receipt does not match the durable workspace mapping");
  }
  await input.writer.assertCurrent(input.db);
  const store = baselineStore({
    workspaceConfig: input.workspaceConfig,
    ...(input.baselineStore === undefined ? {} : { baselineStore: input.baselineStore }),
  });
  const binding = baselineBinding({
    caseId: receipt.case_id,
    workspaceId: receipt.workspace_id,
    runId: receipt.run_id,
    checkpointRevision: receipt.revision,
    sliceId: receipt.slice_id,
    attempt: receipt.attempt,
  });
  const changed = new Set(receipt.changed_paths);
  const actual = await actualEvidence({
    store,
    binding,
    baseline: receipt.baseline,
    workspacePath: mapping.target,
    repositoryId: receipt.repository_id,
    mirrorPath: join(input.workspaceConfig.workspaceRoot, ".git-mirrors", receipt.repository_id),
    caseId: receipt.case_id,
    workspaceId: receipt.workspace_id,
    allowedPaths: slice.allowed_paths,
    priorAgentPaths: receipt.cumulative_paths.filter((path) => !changed.has(path)),
    assertCurrent: () => input.writer.assertCurrent(input.db),
  });
  if (
    actual.treeDigest !== receipt.tree_digest ||
    actual.diffDigest !== receipt.diff_digest ||
    canonicalDigest(actual.patch) !== receipt.raw_patch_digest ||
    !samePaths(actual.changedFiles, receipt.changed_paths) ||
    !samePaths(actual.cumulativeAgentPaths, receipt.cumulative_paths) ||
    actual.filesChanged !== receipt.files_changed ||
    actual.insertions !== receipt.insertions ||
    actual.deletions !== receipt.deletions
  ) {
    throw new Error("current repository observation does not match durable implementation receipt");
  }
  return Object.freeze({ baseline: receipt.baseline, actual, workspacePath: mapping.target });
}

/** Idempotent post-artifact cleanup; the manifest remains as an exact-binding tombstone. */
export async function cleanupSliceImplementationBaseline(input: {
  db: Database;
  writer: VerticalSliceWriterFence;
  workspaceConfig: WorkspaceConfig;
  receipt: EngineeringSliceImplementationReceipt;
  baselineStore?: BaselineWorkspaceStore;
}): Promise<"CLEANED" | "ALREADY_CLEANED"> {
  const receipt = engineeringSliceImplementationReceipt.parse(input.receipt);
  validateWriter(input.writer, receipt.case_id);
  await input.writer.assertCurrent(input.db);
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const mapping = await registry.find(receipt.workspace_id);
  if (
    mapping === null ||
    mapping.caseId !== receipt.case_id ||
    mapping.repo !== receipt.repository_id ||
    mapping.baseSha.toLowerCase() !== receipt.base_sha ||
    mapping.branchName !== receipt.branch
  ) {
    throw new Error("baseline cleanup receipt does not match the durable workspace mapping");
  }
  const store = baselineStore({
    workspaceConfig: input.workspaceConfig,
    ...(input.baselineStore === undefined ? {} : { baselineStore: input.baselineStore }),
  });
  return store.cleanup(
    baselineBinding({
      caseId: receipt.case_id,
      workspaceId: receipt.workspace_id,
      runId: receipt.run_id,
      checkpointRevision: receipt.revision,
      sliceId: receipt.slice_id,
      attempt: receipt.attempt,
    }),
    mapping.target,
    receipt.baseline,
  );
}

/** Fresh read-only observation used after PASS cleanup and before LOCAL_COMMIT intent. */
export async function observeSliceImplementationForCommit(input: {
  db: Database;
  writer: VerticalSliceWriterFence;
  workspaceConfig: WorkspaceConfig;
  receipt: EngineeringSliceImplementationReceipt;
  writePathAllowlist: readonly string[];
}): Promise<VerticalSliceActualEvidence> {
  const receipt = engineeringSliceImplementationReceipt.parse(input.receipt);
  assertEngineeringPathsWithinWriteAllowlist(receipt.cumulative_paths, input.writePathAllowlist);
  validateWriter(input.writer, receipt.case_id);
  const repository = input.workspaceConfig.repositories[receipt.repository_id];
  if (repository === undefined)
    throw new Error("receipt repository is not on the server allowlist");
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const mapping = await registry.find(receipt.workspace_id);
  if (
    mapping === null ||
    mapping.caseId !== receipt.case_id ||
    mapping.repo !== receipt.repository_id ||
    mapping.baseSha.toLowerCase() !== receipt.base_sha ||
    mapping.branchName !== receipt.branch
  ) {
    throw new Error("commit observation does not match the durable workspace mapping");
  }
  await input.writer.assertCurrent(input.db);
  const git = new GitLifecycle({
    worktreePath: mapping.target,
    mirrorPath: join(input.workspaceConfig.workspaceRoot, ".git-mirrors", receipt.repository_id),
    scope: { case_id: receipt.case_id, workspace_id: receipt.workspace_id },
    repositoryId: receipt.repository_id,
    declaredPaths: receipt.cumulative_paths,
  });
  const status = await git.status();
  if (status.state === GitWorkingTreeState.DIRTY_FOREIGN) {
    throw new Error("commit observation found foreign Git paths");
  }
  const [treeDigest, diff] = await Promise.all([computeTreeDigest(mapping.target), git.diff()]);
  await input.writer.assertCurrent(input.db);
  if (diff.truncated) throw new Error("commit observation diff is truncated");
  const actual: VerticalSliceActualEvidence = Object.freeze({
    changedFiles: receipt.changed_paths,
    cumulativeAgentPaths: receipt.cumulative_paths,
    treeDigest,
    diffDigest: canonicalDigest({
      patch: diff.patch,
      files_changed: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      slice_changed_files: receipt.changed_paths,
    }),
    patch: diff.patch,
    filesChanged: diff.filesChanged,
    insertions: diff.insertions,
    deletions: diff.deletions,
  });
  if (
    actual.treeDigest !== receipt.tree_digest ||
    actual.diffDigest !== receipt.diff_digest ||
    canonicalDigest(actual.patch) !== receipt.raw_patch_digest ||
    actual.filesChanged !== receipt.files_changed ||
    actual.insertions !== receipt.insertions ||
    actual.deletions !== receipt.deletions
  ) {
    throw new Error("current repository no longer matches the durable implementation receipt");
  }
  return actual;
}

/** Execute only the runtime-selected gate stage for a previously implemented slice. */
export async function executeVerticalSliceGates(
  input: ExecuteVerticalSliceGateInput,
): Promise<VerticalSliceGateResult> {
  const slice = engineeringSliceContract.parse(input.slice);
  const writePathAllowlist = input.writePathAllowlist;
  assertEngineeringPathsWithinWriteAllowlist(slice.allowed_paths, writePathAllowlist);
  assertEngineeringPathsWithinWriteAllowlist(input.actual.cumulativeAgentPaths, writePathAllowlist);
  if (
    slice.case_id !== input.caseId ||
    slice.run_id !== input.runId ||
    slice.revision !== input.checkpointRevision
  ) {
    throw new Error("SliceContract does not match the server-owned runtime binding");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("slice attempt must be a positive safe integer");
  }
  validateWriter(input.writer, input.caseId);
  if (
    input.lease.caseId !== input.caseId ||
    input.lease.leaseOwner !== input.writer.leaseOwner ||
    input.lease.fencingToken !== input.writer.fencingToken ||
    input.lease.payload.caseId !== input.caseId ||
    input.lease.payload.workUnitId !== input.workUnitId ||
    input.lease.payload.runId !== input.runId
  ) {
    throw new WorkspaceFencingError("gate lease does not match the exact writer/work binding");
  }
  const assertCurrent = async (): Promise<void> => input.writer.assertCurrent(input.db);
  await assertCurrent();

  const repository = input.workspaceConfig.repositories[input.repositoryId];
  if (repository === undefined) throw new Error("repository is not on the server allowlist");
  const workspaceId = verticalSliceWorkspaceId(input.caseId);
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const mapping = await registry.find(workspaceId);
  if (
    mapping === null ||
    mapping.caseId !== input.caseId ||
    mapping.repo !== input.repositoryId ||
    mapping.baseSha.length === 0
  ) {
    throw new Error("gate stage requires the active server-owned workspace mapping");
  }

  const gateIds = slice.gate_ids;
  if (new Set(gateIds).size !== gateIds.length) {
    throw new Error("SliceContract gate_ids must be unique");
  }
  const requiredGateIds = input.catalog.definitions
    .filter((definition) => definition.required)
    .map((definition) => definition.gate_id)
    .sort();
  const expectedGateIds = input.expectedGateIds ?? requiredGateIds;
  if (!samePaths(gateIds, expectedGateIds)) {
    throw new Error("SliceContract gate_ids must equal every server-required gate scheduled here");
  }
  const selected = gateIds.map((gateId) => {
    const definition = input.catalog.get(gateId);
    if (definition === undefined || !definition.required) {
      throw new Error("SliceContract references an unknown or non-required server gate");
    }
    return definition;
  });
  const selectedCatalog = await VerificationGateCatalog.create({
    definitions: selected,
    executable_allowlist: input.catalog.executable_allowlist,
  });

  const durableBaselineStore = baselineStore(input);
  const binding = baselineBinding({
    caseId: input.caseId,
    workspaceId,
    runId: input.runId,
    checkpointRevision: input.checkpointRevision,
    sliceId: slice.slice_id,
    attempt: input.attempt,
  });
  // Keep the baseline until the caller has durably appended the returned gate
  // artifact. A crash after receipts but before artifact persistence can then
  // replay this exact stage and recover those receipts without dispatching.
  const result = await durableBaselineStore.inspect(
    binding,
    mapping.target,
    input.baseline,
    async (baselineRoot) => {
      const observed = await actualEvidence({
        store: durableBaselineStore,
        binding,
        baseline: input.baseline,
        workspacePath: mapping.target,
        repositoryId: input.repositoryId,
        mirrorPath: join(input.workspaceConfig.workspaceRoot, ".git-mirrors", input.repositoryId),
        caseId: input.caseId,
        workspaceId,
        allowedPaths: slice.allowed_paths,
        priorAgentPaths: input.actual.cumulativeAgentPaths,
        assertCurrent,
      });
      if (canonicalDigest(observed) !== canonicalDigest(input.actual)) {
        throw new Error("current slice evidence changed before gate execution");
      }
      await assertCurrent();
      const requiresBaseline = selectedCatalog.definitions.some(
        (definition) => definition.required && definition.baseline,
      );
      return executeVerificationGateBatch({
        db: input.db,
        jobs: input.jobs,
        lease: input.lease,
        catalog: selectedCatalog,
        metadata: {
          case_id: input.caseId,
          workspace_id: workspaceId,
          run_id: input.runId,
          revision: input.checkpointRevision,
          current_tree_digest: observed.treeDigest,
          diff_digest: observed.diffDigest,
          context_digest: input.contextDigest,
          review_findings: [...(input.reviewFindings ?? [])],
          decisions: [...(input.decisions ?? [])],
        },
        current_root: mapping.target,
        ...(requiresBaseline ? { baseline_root: baselineRoot } : {}),
        stage_attempt: input.attempt,
        deadline_at: input.deadlineAt,
        store: input.store,
        ...(input.platformAdapter === undefined ? {} : { platform_adapter: input.platformAdapter }),
        boundary_error_observer: recordEngineeringDebugGateBoundaryError,
        ...(input.recoveryObserveCompletion === undefined
          ? {}
          : { recovery_observe_completion: input.recoveryObserveCompletion }),
        ...(input.recoveryOnly === undefined ? {} : { recovery_only: input.recoveryOnly }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  );
  if (result.status !== "COMPLETE") {
    void recordEngineeringDebugGateProgress({ tier: "FAST", status: "BLOCKED" });
    return {
      status: "BLOCKED",
      aggregate: null,
      bundle: null,
      reason: result.reason,
      blockingGateIds: result.blocking_gate_ids,
      receipts: result.receipts,
      actual: input.actual,
    };
  }
  if (
    result.aggregate.status !== VerificationGateStatus.PASSED ||
    result.bundle === null ||
    result.bundle.tree_digest !== input.actual.treeDigest ||
    result.bundle.diff_digest !== input.actual.diffDigest
  ) {
    const blockedFast = selectedCatalog.definitions.some(
      (definition) =>
        definition.gate_tier === "FAST" &&
        result.aggregate.blocking_gate_ids.includes(definition.gate_id),
    );
    void recordEngineeringDebugGateProgress({
      tier: blockedFast ? "FAST" : "FULL",
      status: "BLOCKED",
    });
    return {
      status: "BLOCKED",
      aggregate: result.aggregate,
      bundle: null,
      reason:
        result.aggregate.status === VerificationGateStatus.PASSED
          ? "PASS_WITHOUT_BOUND_EVIDENCE_BUNDLE"
          : result.aggregate.status,
      blockingGateIds: result.aggregate.blocking_gate_ids,
      receipts: result.receipts,
      actual: input.actual,
    };
  }
  void recordEngineeringDebugGateProgress({ tier: "FAST", status: "PASSED" });
  void recordEngineeringDebugGateProgress({ tier: "FULL", status: "PASSED" });
  return {
    status: "PASS",
    aggregate: result.aggregate,
    bundle: result.bundle,
    bundleDigest: canonicalDigest(result.bundle),
    actual: input.actual,
  };
}

/** Execute one fresh, tools-disabled review round for the runtime-selected attempt. */
export async function executeVerticalSliceReview(
  input: ExecuteVerticalSliceReviewInput,
): Promise<VerticalSliceReviewResult> {
  const slice = engineeringSliceContract.parse(input.slice);
  const writePathAllowlist = input.writePathAllowlist;
  assertEngineeringPathsWithinWriteAllowlist(slice.allowed_paths, writePathAllowlist);
  assertEngineeringPathsWithinWriteAllowlist(input.actual.cumulativeAgentPaths, writePathAllowlist);
  if (
    slice.case_id !== input.caseId ||
    slice.run_id !== input.runId ||
    slice.revision !== input.checkpointRevision
  ) {
    throw new Error("SliceContract does not match the server-owned runtime binding");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("slice attempt must be a positive safe integer");
  }
  validateWriter(input.writer, input.caseId);
  if (
    input.lease.caseId !== input.caseId ||
    input.lease.leaseOwner !== input.writer.leaseOwner ||
    input.lease.fencingToken !== input.writer.fencingToken ||
    input.lease.payload.caseId !== input.caseId ||
    input.lease.payload.workUnitId !== input.workUnitId ||
    input.lease.payload.runId !== input.runId
  ) {
    throw new WorkspaceFencingError("review lease does not match the exact writer/work binding");
  }

  const repository = input.workspaceConfig.repositories[input.repositoryId];
  if (repository === undefined) throw new Error("repository is not on the server allowlist");
  const workspaceId = verticalSliceWorkspaceId(input.caseId);
  const registry = adaptWorkspaceRepository(
    new WorkspaceRepository(),
    input.db,
    input.workspaceConfig.workspaceRoot,
  );
  const mapping = await registry.find(workspaceId);
  if (
    mapping === null ||
    mapping.caseId !== input.caseId ||
    mapping.repo !== input.repositoryId ||
    mapping.baseSha.length === 0
  ) {
    throw new Error("review stage requires the active server-owned workspace mapping");
  }
  const durableBaselineStore = baselineStore(input);
  const binding = baselineBinding({
    caseId: input.caseId,
    workspaceId,
    runId: input.runId,
    checkpointRevision: input.checkpointRevision,
    sliceId: slice.slice_id,
    attempt: input.attempt,
  });
  const assertCurrent = async (): Promise<void> => input.writer.assertCurrent(input.db);
  const observeActual = async () => {
    await assertCurrent();
    const observed = await actualEvidence({
      store: durableBaselineStore,
      binding,
      baseline: input.baseline,
      workspacePath: mapping.target,
      repositoryId: input.repositoryId,
      mirrorPath: join(input.workspaceConfig.workspaceRoot, ".git-mirrors", input.repositoryId),
      caseId: input.caseId,
      workspaceId,
      allowedPaths: slice.allowed_paths,
      priorAgentPaths: input.actual.cumulativeAgentPaths,
      assertCurrent,
    });
    await assertCurrent();
    return {
      patch: observed.patch,
      diffDigest: observed.diffDigest,
      treeDigest: observed.treeDigest,
    };
  };
  const review = await executeFreshPreCommitReview({
    binding: {
      caseId: input.caseId,
      runId: input.runId,
      checkpointRevision: input.checkpointRevision,
      sliceId: slice.slice_id,
      attempt: input.attempt,
    },
    taskBrief: input.taskBrief,
    actual: {
      patch: input.actual.patch,
      diffDigest: input.actual.diffDigest,
      treeDigest: input.actual.treeDigest,
    },
    evidenceBundle: input.evidenceBundle,
    expectedEvidenceBundleDigest: input.evidenceBundleDigest,
    ...(input.previousBlockingRawPatchDigest === undefined
      ? {}
      : { previousBlockingRawPatchDigest: input.previousBlockingRawPatchDigest }),
    observeActual,
    createSession: input.createReviewerSession,
  });
  const reviewedDigest = canonicalDigest({
    raw_patch_digest: review.rawPatchDigest,
    actual_diff_digest: review.actualDiffDigest,
    tree_digest: review.treeDigest,
    evidence_bundle_digest: review.evidenceBundleDigest,
  });
  const decision = engineeringReviewDecision.parse({
    schema_version: 1,
    artifact_kind: "ReviewDecision",
    case_id: input.caseId,
    run_id: input.runId,
    revision: input.checkpointRevision,
    decision_id: `precommit-${reviewedDigest.slice(7, 39)}`,
    rationale:
      review.readiness === "READY"
        ? "Fresh pre-commit review found no blocking findings."
        : "Fresh pre-commit review found blocking findings requiring a correction attempt.",
    decision: review.readiness === "READY" ? "PASS" : "CHANGES_REQUIRED",
    findings: review.findings
      .filter((finding) => review.blockingFindingIds.includes(finding.finding_id))
      .map(
        (finding) =>
          `[${finding.finding_id}] ${finding.severity} ${finding.location?.relative_path ?? "unknown"}:${String(finding.location?.line ?? 0)} — ${finding.summary} Required: ${finding.required_fix}`,
      ),
    // This field is intentionally the exact reviewed patch bytes digest. The
    // composite digest remains the decision identity and binds tree/gates too.
    reviewed_digest: review.rawPatchDigest,
  });
  return Object.freeze({ review, decision });
}
