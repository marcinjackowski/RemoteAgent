import {
  canonicalDigest,
  engineeringEvidenceBundle,
  type EngineeringEvidenceBundle,
} from "@remoteagent/contracts";

import {
  ReviewContractError,
  ReviewReadiness,
  ReviewSeverity,
  isBlockingSeverity,
  preCommitReviewOutput,
  reviewFinding,
  reviewReport,
  type PreCommitReviewOutput,
  type ReviewFinding,
  type ReviewReport,
} from "./contracts.js";

export const PRE_COMMIT_REVIEW_STALE = "PRE_COMMIT_REVIEW_STALE";
export const PRE_COMMIT_REVIEW_TOOLS_EXPOSED = "PRE_COMMIT_REVIEW_TOOLS_EXPOSED";
export const PRE_COMMIT_REVIEW_SESSION_REUSED = "PRE_COMMIT_REVIEW_SESSION_REUSED";
export const PRE_COMMIT_REVIEW_NOT_EXECUTED = "PRE_COMMIT_REVIEW_NOT_EXECUTED";
export const PRE_COMMIT_REVIEW_NO_CHANGE = "PRE_COMMIT_REVIEW_NO_CHANGE";

export type PreCommitReviewBinding = Readonly<{
  caseId: string;
  runId: string;
  checkpointRevision: number;
  sliceId: string;
  attempt: number;
}>;

export type PreCommitActualObservation = Readonly<{
  patch: string;
  diffDigest: string;
  treeDigest: string;
}>;

/** Data-only request. No tool/store/workspace handle can cross this boundary. */
export type PreCommitReviewRequest = Readonly<{
  binding: Readonly<{
    case_id: string;
    run_id: string;
    checkpoint_revision: number;
    slice_id: string;
    attempt: number;
  }>;
  task_brief: string;
  patch: string;
  raw_patch_digest: string;
  actual_diff_digest: string;
  tree_digest: string;
  evidence_bundle: EngineeringEvidenceBundle;
  evidence_bundle_digest: string;
}>;

export type PreCommitReviewSessionResult = Readonly<{
  output: PreCommitReviewOutput;
  /** Actual model completions, including a structured-output repair call. */
  modelCalls: number;
}>;

export type PreCommitReviewSession = Readonly<{
  sessionId: string;
  /** Must be empty. Review is tools-disabled, not merely "read-only by prompt". */
  toolNames: readonly string[];
  review(request: PreCommitReviewRequest): Promise<PreCommitReviewSessionResult>;
}>;

export type PreCommitReviewSessionFactory = () => Promise<PreCommitReviewSession>;

export type FreshPreCommitReviewResult = Readonly<{
  readiness: typeof ReviewReadiness.READY | typeof ReviewReadiness.CHANGES_REQUIRED;
  report: ReviewReport;
  findings: readonly ReviewFinding[];
  blockingFindingIds: readonly string[];
  rawPatchDigest: string;
  actualDiffDigest: string;
  treeDigest: string;
  evidenceBundleDigest: string;
  sessionId: string;
  modelCalls: number;
}>;

const consumedSessions = new WeakSet<object>();
const consumedSessionIds = new Set<string>();

function assertBinding(binding: PreCommitReviewBinding): void {
  if (
    binding.caseId.trim().length === 0 ||
    binding.runId.trim().length === 0 ||
    binding.sliceId.trim().length === 0 ||
    !Number.isSafeInteger(binding.checkpointRevision) ||
    binding.checkpointRevision < 0 ||
    !Number.isSafeInteger(binding.attempt) ||
    binding.attempt < 1
  ) {
    throw new ReviewContractError("invalid pre-commit review binding");
  }
}

function assertExactObservation(
  expected: PreCommitActualObservation,
  observed: PreCommitActualObservation,
): void {
  if (
    observed.patch !== expected.patch ||
    observed.diffDigest !== expected.diffDigest ||
    observed.treeDigest !== expected.treeDigest
  ) {
    throw new ReviewContractError(PRE_COMMIT_REVIEW_STALE);
  }
}

function severityRank(severity: ReviewSeverity): number {
  return { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3, NIT: 4 }[severity];
}

function serverFindings(output: PreCommitReviewOutput, patch: string): readonly ReviewFinding[] {
  const normalizedPatch = patch.replace(/\s+/gu, " ");
  const byLocation = new Map<string, PreCommitReviewOutput["findings"][number]>();
  for (const candidate of output.findings) {
    const quote = candidate.evidence.trim().replace(/\s+/gu, " ");
    const supported = quote.length === 0 || normalizedPatch.includes(quote);
    const effective =
      supported || !isBlockingSeverity(candidate.severity)
        ? candidate
        : {
            ...candidate,
            severity: ReviewSeverity.LOW,
            summary: "Reviewer finding was not anchored in the actual patch.",
            required_fix: "",
          };
    const location = `${candidate.location.relative_path}:${String(candidate.location.line)}`;
    const current = byLocation.get(location);
    if (
      current === undefined ||
      severityRank(effective.severity) < severityRank(current.severity)
    ) {
      byLocation.set(location, effective);
    }
  }
  return Object.freeze(
    [...byLocation.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([location, candidate]) =>
        reviewFinding.parse({
          schema_version: 1,
          finding_id: `precommit-${canonicalDigest({ location }).slice(7, 39)}`,
          ...candidate,
        }),
      ),
  );
}

/**
 * Execute exactly one pre-commit review round.
 *
 * The caller owns correction/retry policy. This function deliberately has no
 * loop, no fix callback and no workspace capability.
 */
export async function executeFreshPreCommitReview(input: {
  binding: PreCommitReviewBinding;
  taskBrief: string;
  actual: PreCommitActualObservation;
  evidenceBundle: EngineeringEvidenceBundle;
  expectedEvidenceBundleDigest: string;
  /** Required by the caller for a correction review, from prior durable review evidence. */
  previousBlockingRawPatchDigest?: string;
  observeActual: () => Promise<PreCommitActualObservation>;
  createSession: PreCommitReviewSessionFactory;
}): Promise<FreshPreCommitReviewResult> {
  assertBinding(input.binding);
  const evidence = engineeringEvidenceBundle.parse(input.evidenceBundle);
  const evidenceBundleDigest = canonicalDigest(evidence);
  if (
    evidence.case_id !== input.binding.caseId ||
    evidence.run_id !== input.binding.runId ||
    evidence.revision !== input.binding.checkpointRevision ||
    evidence.tree_digest !== input.actual.treeDigest ||
    evidence.diff_digest !== input.actual.diffDigest ||
    evidenceBundleDigest !== input.expectedEvidenceBundleDigest
  ) {
    throw new ReviewContractError("pre-commit EvidenceBundle binding mismatch");
  }
  if (input.previousBlockingRawPatchDigest === canonicalDigest(input.actual.patch)) {
    throw new ReviewContractError(PRE_COMMIT_REVIEW_NO_CHANGE);
  }

  assertExactObservation(input.actual, await input.observeActual());
  const rawPatchDigest = canonicalDigest(input.actual.patch);
  const request: PreCommitReviewRequest = Object.freeze({
    binding: Object.freeze({
      case_id: input.binding.caseId,
      run_id: input.binding.runId,
      checkpoint_revision: input.binding.checkpointRevision,
      slice_id: input.binding.sliceId,
      attempt: input.binding.attempt,
    }),
    task_brief: input.taskBrief,
    patch: input.actual.patch,
    raw_patch_digest: rawPatchDigest,
    actual_diff_digest: input.actual.diffDigest,
    tree_digest: input.actual.treeDigest,
    evidence_bundle: evidence,
    evidence_bundle_digest: evidenceBundleDigest,
  });

  const session = await input.createSession();
  if (
    typeof session !== "object" ||
    session === null ||
    consumedSessions.has(session) ||
    consumedSessionIds.has(session.sessionId)
  ) {
    throw new ReviewContractError(PRE_COMMIT_REVIEW_SESSION_REUSED);
  }
  consumedSessions.add(session);
  if (session.sessionId.trim().length === 0 || session.sessionId.length > 512) {
    throw new ReviewContractError("pre-commit reviewer session must have an identity");
  }
  consumedSessionIds.add(session.sessionId);
  if (
    Object.keys(session).sort().join(",") !== ["review", "sessionId", "toolNames"].sort().join(",")
  ) {
    throw new ReviewContractError(PRE_COMMIT_REVIEW_TOOLS_EXPOSED);
  }
  if (session.toolNames.length !== 0) {
    throw new ReviewContractError(PRE_COMMIT_REVIEW_TOOLS_EXPOSED);
  }

  const reviewed = await session.review(request);
  if (!Number.isSafeInteger(reviewed.modelCalls) || reviewed.modelCalls < 1) {
    throw new ReviewContractError(PRE_COMMIT_REVIEW_NOT_EXECUTED);
  }
  const output = preCommitReviewOutput.parse(reviewed.output);
  const actualLineCount = input.actual.patch.split("\n").filter((line) => line.length > 0).length;
  const linesExamined = Math.min(output.lines_examined, actualLineCount);
  if (linesExamined === 0) {
    throw new ReviewContractError("pre-commit reviewer examined zero lines");
  }
  assertExactObservation(input.actual, await input.observeActual());

  const findings = serverFindings(output, input.actual.patch);
  const report = reviewReport.parse({
    schema_version: 1,
    report_id: `precommit-report-${canonicalDigest({
      binding: request.binding,
      raw_patch_digest: rawPatchDigest,
      actual_diff_digest: input.actual.diffDigest,
      tree_digest: input.actual.treeDigest,
      evidence_bundle_digest: evidenceBundleDigest,
    }).slice(7, 39)}`,
    reviewer_id: `fresh-${canonicalDigest(session.sessionId).slice(7, 39)}`,
    // Existing ReviewReport names this `diff_digest`; for this boundary it is
    // explicitly the digest of raw patch bytes, not the richer actual-diff digest.
    diff_digest: rawPatchDigest,
    tree_digest: input.actual.treeDigest,
    findings,
    lines_examined: linesExamined,
  });
  const blockingFindingIds = findings
    .filter((finding) => isBlockingSeverity(finding.severity))
    .map((finding) => finding.finding_id)
    .sort();
  return Object.freeze({
    readiness:
      blockingFindingIds.length === 0 ? ReviewReadiness.READY : ReviewReadiness.CHANGES_REQUIRED,
    report,
    findings,
    blockingFindingIds: Object.freeze(blockingFindingIds),
    rawPatchDigest,
    actualDiffDigest: input.actual.diffDigest,
    treeDigest: input.actual.treeDigest,
    evidenceBundleDigest,
    sessionId: session.sessionId,
    modelCalls: reviewed.modelCalls,
  });
}
