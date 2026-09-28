import {
  canonicalDigest,
  engineeringEvidenceBundle,
  type EngineeringEvidenceBundle,
} from "@remoteagent/contracts";

import {
  ReviewContractError,
  ReviewReadiness,
  ReviewSeverity,
  MAX_EVIDENCE_LENGTH,
  MIN_EVIDENCE_LENGTH,
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

/** Versioned server-owned projection used to identify validated findings. */
const FINDING_IDENTITY_PROJECTION_VERSION = 1;

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

export type PreCommitReviewSliceScope = Readonly<{
  slice_id: string;
  objective: string;
  observable_result: string;
  allowed_paths: readonly string[];
  test_paths: readonly string[];
  /** Exact files materialized by a server-owned generator, never by the implementer model. */
  code_owned_generator_paths: readonly string[];
  inspection_method: string;
  stop_condition: string;
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
  /** Exact durable current-slice acceptance scope; it cannot widen repository authority. */
  slice_scope: PreCommitReviewSliceScope;
  /**
   * Compact server-parsed coordinates for every editable added line in `patch`.
   * The reviewer chooses an anchor from these ranges; the server still re-parses and verifies it.
   */
  changed_line_ranges: readonly Readonly<{
    relative_path: string;
    start_line: number;
    end_line: number;
  }>[];
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
  /** Server-validated union of exact files named by blocking findings. */
  requiredMutationPaths: readonly string[];
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

type ChangedLineEvidence = Readonly<{
  relativePath: string;
  line: number;
  evidence: string;
}>;

type ChangedLineRange = PreCommitReviewRequest["changed_line_ranges"][number];

function changedLineEvidence(patch: string): readonly ChangedLineEvidence[] {
  const evidence: ChangedLineEvidence[] = [];
  let relativePath: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      relativePath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4);
      relativePath =
        candidate === "/dev/null" || !candidate.startsWith("b/") ? null : candidate.slice(2);
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = /\+(\d+)(?:,\d+)?/u.exec(line);
      if (relativePath === null || match?.[1] === undefined) {
        inHunk = false;
        continue;
      }
      newLine = Number.parseInt(match[1], 10);
      inHunk = Number.isSafeInteger(newLine) && newLine >= 0;
      continue;
    }
    if (!inHunk || relativePath === null || line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    if (line.startsWith("+")) {
      evidence.push(Object.freeze({ relativePath, line: newLine, evidence: line }));
    }
    newLine += 1;
  }

  return Object.freeze(evidence);
}

/** Collapse exact added-line coordinates without duplicating the raw patch in the model request. */
function changedLineRanges(
  patch: string,
  codeOwnedGeneratorPaths: readonly string[],
  sliceAllowedPaths: readonly string[],
): readonly ChangedLineRange[] {
  const generatorPaths = new Set(codeOwnedGeneratorPaths);
  const byPath = new Map<string, Set<number>>();
  for (const entry of changedLineEvidence(patch)) {
    if (
      generatorPaths.has(entry.relativePath) ||
      !sliceAllowedPaths.some(
        (root) => entry.relativePath === root || entry.relativePath.startsWith(`${root}/`),
      )
    ) {
      continue;
    }
    const lines = byPath.get(entry.relativePath) ?? new Set<number>();
    lines.add(entry.line);
    byPath.set(entry.relativePath, lines);
  }

  const ranges: ChangedLineRange[] = [];
  for (const relativePath of [...byPath.keys()].sort()) {
    const lines = [...byPath.get(relativePath)!].sort((left, right) => left - right);
    let start = lines[0];
    let end = lines[0];
    for (const line of lines.slice(1)) {
      if (line === end! + 1) {
        end = line;
        continue;
      }
      ranges.push(
        Object.freeze({ relative_path: relativePath, start_line: start!, end_line: end! }),
      );
      start = line;
      end = line;
    }
    if (start !== undefined && end !== undefined) {
      ranges.push(Object.freeze({ relative_path: relativePath, start_line: start, end_line: end }));
    }
  }
  return Object.freeze(ranges);
}

function serverFindings(
  output: PreCommitReviewOutput,
  patch: string,
  codeOwnedGeneratorPaths: readonly string[],
  sliceAllowedPaths: readonly string[],
): Readonly<{ findings: readonly ReviewFinding[]; requiredMutationPaths: readonly string[] }> {
  const generatorPaths = new Set(codeOwnedGeneratorPaths);
  // A generator output remains in the exact patch/digests for verification and compile evidence,
  // but it cannot authorize a model-correction loop: the model has no write capability for it.
  // Reviewers must anchor a consumption defect in an editable caller instead.
  const changedLines = changedLineEvidence(patch).filter(
    (entry) =>
      !generatorPaths.has(entry.relativePath) &&
      sliceAllowedPaths.some(
        (root) => entry.relativePath === root || entry.relativePath.startsWith(`${root}/`),
      ),
  );
  const serverEvidenceByLocation = new Map(
    changedLines.map((entry) => [`${entry.relativePath}:${String(entry.line)}`, entry]),
  );
  const byIdentity = new Map<string, PreCommitReviewOutput["findings"][number]>();
  for (const candidate of output.findings) {
    const location = `${candidate.location.relative_path}:${String(candidate.location.line)}`;
    const directServerEvidence = serverEvidenceByLocation.get(location);
    const serverEvidence =
      directServerEvidence === undefined
        ? undefined
        : directServerEvidence.evidence.trim().length >= MIN_EVIDENCE_LENGTH &&
            directServerEvidence.evidence.length <= MAX_EVIDENCE_LENGTH
          ? directServerEvidence
          : changedLines
              .filter(
                (entry) =>
                  entry.relativePath === directServerEvidence.relativePath &&
                  entry.evidence.trim().length >= MIN_EVIDENCE_LENGTH &&
                  entry.evidence.length <= MAX_EVIDENCE_LENGTH,
              )
              .sort((left, right) => {
                const distance =
                  Math.abs(left.line - directServerEvidence.line) -
                  Math.abs(right.line - directServerEvidence.line);
                return distance === 0 ? left.line - right.line : distance;
              })[0];
    // Absence defects cannot quote code that does not exist. The authority anchor is therefore
    // the server-parsed new-file line in the actual unified diff. Model prose is never enough:
    // an unchanged line or a foreign path is downgraded even when its evidence resembles code.
    const blocking = isBlockingSeverity(candidate.severity);
    const targetPaths = [...new Set(candidate.required_fix_paths)].sort();
    const validTargets =
      targetPaths.length > 0 &&
      targetPaths.every(
        (path) =>
          !generatorPaths.has(path) &&
          sliceAllowedPaths.includes(path) &&
          !sliceAllowedPaths.some(
            (allowedPath) => allowedPath !== path && allowedPath.startsWith(`${path}/`),
          ),
      );
    const effective = blocking
      ? serverEvidence === undefined || !validTargets
        ? {
            ...candidate,
            severity: ReviewSeverity.LOW,
            summary:
              serverEvidence === undefined
                ? "Reviewer finding was not anchored in the actual patch."
                : "Reviewer finding named no valid in-scope correction target.",
            required_fix: "",
            required_fix_paths: [],
          }
        : {
            ...candidate,
            location: {
              relative_path: serverEvidence.relativePath,
              line: serverEvidence.line,
            },
            // Blocking authority is always the exact server-observed changed line. The model's
            // quote may be useful prose but never overrides or weakens this anchor.
            evidence: serverEvidence.evidence,
            required_fix_paths: targetPaths,
          }
      : candidate;
    const identity = canonicalDigest({
      projection_version: FINDING_IDENTITY_PROJECTION_VERSION,
      effective_anchor: effective.location,
      severity: effective.severity,
      summary: effective.summary,
      required_fix: effective.required_fix,
      required_fix_paths: effective.required_fix_paths,
      evidence_digest: canonicalDigest(effective.evidence),
    });
    if (!byIdentity.has(identity)) byIdentity.set(identity, effective);
  }
  const findings = Object.freeze(
    [...byIdentity.entries()]
      .sort(([, left], [, right]) => {
        const leftLocation = `${left.location.relative_path}:${String(left.location.line)}`;
        const rightLocation = `${right.location.relative_path}:${String(right.location.line)}`;
        return (
          leftLocation.localeCompare(rightLocation) ||
          left.summary.localeCompare(right.summary) ||
          left.required_fix.localeCompare(right.required_fix) ||
          canonicalDigest(left.evidence).localeCompare(canonicalDigest(right.evidence))
        );
      })
      .map(([identity, candidate]) =>
        reviewFinding.parse({
          schema_version: 1,
          finding_id: `precommit-${identity.slice(7, 39)}`,
          severity: candidate.severity,
          summary: candidate.summary,
          location: candidate.location,
          evidence: candidate.evidence,
          required_fix: candidate.required_fix,
        }),
      ),
  );
  const requiredMutationPaths = Object.freeze(
    [
      ...new Set(
        [...byIdentity.values()]
          .filter((finding) => isBlockingSeverity(finding.severity))
          .flatMap((finding) => finding.required_fix_paths),
      ),
    ].sort(),
  );
  return Object.freeze({ findings, requiredMutationPaths });
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
  sliceScope: PreCommitReviewSliceScope;
  actual: PreCommitActualObservation;
  evidenceBundle: EngineeringEvidenceBundle;
  expectedEvidenceBundleDigest: string;
  /** Required by the caller for a correction review, from prior durable review evidence. */
  previousBlockingRawPatchDigest?: string;
  observeActual: () => Promise<PreCommitActualObservation>;
  createSession: PreCommitReviewSessionFactory;
}): Promise<FreshPreCommitReviewResult> {
  assertBinding(input.binding);
  const codeOwnedGeneratorPaths = [...input.sliceScope.code_owned_generator_paths];
  if (
    new Set(codeOwnedGeneratorPaths).size !== codeOwnedGeneratorPaths.length ||
    codeOwnedGeneratorPaths.some(
      (path, index) => index > 0 && codeOwnedGeneratorPaths[index - 1]! >= path,
    ) ||
    codeOwnedGeneratorPaths.some((path) => !input.sliceScope.allowed_paths.includes(path))
  ) {
    throw new ReviewContractError(
      "pre-commit code-owned generator paths must be sorted, unique and within slice scope",
    );
  }
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
    slice_scope: Object.freeze({
      ...input.sliceScope,
      allowed_paths: Object.freeze([...input.sliceScope.allowed_paths]),
      test_paths: Object.freeze([...input.sliceScope.test_paths]),
      code_owned_generator_paths: Object.freeze(codeOwnedGeneratorPaths),
    }),
    changed_line_ranges: changedLineRanges(
      input.actual.patch,
      codeOwnedGeneratorPaths,
      input.sliceScope.allowed_paths,
    ),
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

  const validated = serverFindings(
    output,
    input.actual.patch,
    request.slice_scope.code_owned_generator_paths,
    request.slice_scope.allowed_paths,
  );
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
    findings: validated.findings,
    lines_examined: linesExamined,
  });
  const blockingFindingIds = validated.findings
    .filter((finding) => isBlockingSeverity(finding.severity))
    .map((finding) => finding.finding_id)
    .sort();
  return Object.freeze({
    readiness:
      blockingFindingIds.length === 0 ? ReviewReadiness.READY : ReviewReadiness.CHANGES_REQUIRED,
    report,
    findings: validated.findings,
    blockingFindingIds: Object.freeze(blockingFindingIds),
    rawPatchDigest,
    actualDiffDigest: input.actual.diffDigest,
    treeDigest: input.actual.treeDigest,
    evidenceBundleDigest,
    sessionId: session.sessionId,
    modelCalls: reviewed.modelCalls,
    requiredMutationPaths: validated.requiredMutationPaths,
  });
}
