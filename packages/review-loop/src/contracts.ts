/**
 * Review contracts: findings, reports, dispositions and the readiness verdict.
 *
 * Contracts only — no filesystem, no process, no write tools of any kind. That
 * absence is the point: the reviewer's read-only nature is a property of what this
 * package can express, not a rule it promises to follow.
 *
 * Names are prefixed `review*` / `Review*` or are otherwise unique. Two `export *`
 * barrels supplying one name do not collide loudly — ESM silently omits the
 * ambiguous name — and RA-014 showed the sharper version of that hazard: two
 * definitions of one name with DIFFERENT validation rules silently swap the
 * stricter for the laxer. The export-intersection test guards against both.
 *
 * Three properties are structural.
 *
 * **Criterion 3: a finding with no location or evidence cannot block.**
 * {@link reviewFinding} requires a location and an evidence quote for any severity
 * that blocks, and {@link isBlockingSeverity} is the only definition of "blocks".
 * A reviewer that asserts "this is probably wrong somewhere" produces an
 * unblockable finding by construction rather than by a later filter.
 *
 * **Criterion 2: PASS requires no unresolved BLOCKER/HIGH/MEDIUM.**
 * {@link deriveReadiness} computes the verdict; there is no settable field. It is
 * the same shape as RA-013's `deriveVerdict` for the same reason — a verdict that a
 * caller can assign is an assertion, not a conclusion.
 *
 * **Criterion 5: a resolved finding names the evidence for its fix.**
 * {@link reviewResolution} requires both the commit that fixed it and the run
 * receipts that vouch for that commit. "Fixed, trust me" is unrepresentable.
 */
import { idString, sha256Digest, valueObject, versionedContract } from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on findings one report may carry. */
export const MAX_FINDINGS = 256;

/** Shortest evidence quote that can be considered substantive. */
export const MIN_EVIDENCE_LENGTH = 12;

/** Longest exact diff quote that can cross the review boundary. */
export const MAX_EVIDENCE_LENGTH = 4096;

/**
 * Severity of a review finding.
 *
 * `NIT` and `LOW` exist so a reviewer has somewhere to put a real-but-minor
 * observation instead of inflating it to MEDIUM to make it visible. Severity
 * inflation is the mirror image of rubber-stamping and just as corrosive: if every
 * remark blocks, the blocking signal stops meaning anything.
 */
export const ReviewSeverity = {
  /** Correctness, security or data-loss defect. Must block. */
  BLOCKER: "BLOCKER",
  /** Serious defect or a violated accepted contract. Must block. */
  HIGH: "HIGH",
  /** Real problem that should not ship. Must block. */
  MEDIUM: "MEDIUM",
  /** Worth fixing, does not block. */
  LOW: "LOW",
  /** Style or preference. Never blocks. */
  NIT: "NIT",
} as const;

export type ReviewSeverity = (typeof ReviewSeverity)[keyof typeof ReviewSeverity];

export const reviewSeverity = z.enum([
  ReviewSeverity.BLOCKER,
  ReviewSeverity.HIGH,
  ReviewSeverity.MEDIUM,
  ReviewSeverity.LOW,
  ReviewSeverity.NIT,
]);

/** Severities that block a `READY` verdict. The single definition of "blocks". */
const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = Object.freeze([
  ReviewSeverity.BLOCKER,
  ReviewSeverity.HIGH,
  ReviewSeverity.MEDIUM,
]);

export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return BLOCKING_SEVERITIES.includes(severity);
}

/**
 * What the supervisor decided about a finding.
 *
 * `FALSE_POSITIVE` requires a rationale (see {@link reviewDisposition}) because
 * dismissing a finding is exactly where rubber-stamping hides: an unexplained
 * dismissal is indistinguishable from not having read it.
 */
export const ReviewDisposition = {
  /** Accepted as real and requiring a fix. */
  ACCEPTED: "ACCEPTED",
  /** Judged not to be a defect. Requires a rationale. */
  FALSE_POSITIVE: "FALSE_POSITIVE",
  /** Real, but deliberately deferred. Requires a rationale. */
  DEFERRED: "DEFERRED",
} as const;

export type ReviewDisposition = (typeof ReviewDisposition)[keyof typeof ReviewDisposition];

/** Precise location of a finding. A finding without one cannot block. */
export const reviewLocation = valueObject({
  /** Workspace-relative path; never an absolute host path. */
  relative_path: z.string().min(1).max(1024),
  /** 1-indexed line in the reviewed diff. */
  line: z.int().positive(),
});

export type ReviewLocation = z.infer<typeof reviewLocation>;

/**
 * One review finding.
 *
 * The refinement below is criterion 3. A blocking severity REQUIRES a location and
 * a substantive evidence quote taken from the diff; without them the finding is
 * only expressible as `LOW` or `NIT`. This is deliberately stricter than "the
 * reviewer should cite evidence": a vague objection cannot be *represented* as a
 * blocker, so it cannot stop work regardless of how it is worded.
 */
export const reviewFinding = versionedContract({
  finding_id: idString,
  severity: reviewSeverity,
  /** What is wrong. Prose, for a human or a supervisor to act on. */
  summary: z.string().min(8).max(2048),
  location: reviewLocation.nullable(),
  /**
   * Verbatim excerpt from the reviewed diff that demonstrates the problem.
   * Quoting the diff is what ties a finding to the real change rather than to a
   * description of it (criterion 6).
   */
  evidence: z.string().max(MAX_EVIDENCE_LENGTH),
  /** The change required to resolve it. Empty for NIT. */
  required_fix: z.string().max(2048),
}).superRefine((finding, ctx) => {
  if (!isBlockingSeverity(finding.severity)) return;
  if (finding.location === null) {
    ctx.addIssue({
      code: "custom",
      message: "a blocking finding must name a location",
      path: ["location"],
    });
  }
  if (finding.evidence.trim().length < MIN_EVIDENCE_LENGTH) {
    ctx.addIssue({
      code: "custom",
      message: "a blocking finding must quote evidence from the diff",
      path: ["evidence"],
    });
  }
  if (finding.required_fix.trim().length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "a blocking finding must state the required fix",
      path: ["required_fix"],
    });
  }
});

export type ReviewFinding = z.infer<typeof reviewFinding>;

/**
 * A supervisor's decision about a finding.
 *
 * A discriminated union so that dismissing or deferring cannot be done silently:
 * both require a rationale of real length, while accepting needs none because the
 * fix itself becomes the record.
 */
export const reviewDisposition = z.discriminatedUnion("disposition", [
  z.strictObject({
    finding_id: idString,
    disposition: z.literal(ReviewDisposition.ACCEPTED),
  }),
  z.strictObject({
    finding_id: idString,
    disposition: z.literal(ReviewDisposition.FALSE_POSITIVE),
    /** Why the finding is not a defect. Never blank. */
    rationale: z.string().min(20).max(2048),
  }),
  z.strictObject({
    finding_id: idString,
    disposition: z.literal(ReviewDisposition.DEFERRED),
    rationale: z.string().min(20).max(2048),
  }),
]);

export type ReviewDispositionRecord = z.infer<typeof reviewDisposition>;

/**
 * Evidence that a finding was actually fixed.
 *
 * Criterion 5. Both a commit and the run receipts backing it are required, so
 * "resolved" always points at a diff and at a passing verification of that diff.
 * There is no variant meaning "resolved without evidence".
 */
export const reviewResolution = valueObject({
  finding_id: idString,
  /** Commit that carries the fix. */
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/iu),
  /** `receipt_digest` of the `TestRun`s that vouch for that commit. */
  run_receipts: z.array(sha256Digest).min(1).max(128),
  /**
   * Digest of the diff the fix produced — i.e. the state AFTER the fix.
   *
   * Required because a resolution is otherwise self-certifying: an audit probe
   * cleared a BLOCKER with an arbitrary 40-hex commit and an arbitrary receipt
   * digest, neither of which had anything to do with the finding. Recording the
   * resulting diff digest lets {@link deriveReadiness} refuse a resolution that
   * claims to fix the very diff still under review — the shape a rubber-stamp takes
   * when the code never actually changed.
   */
  fixed_diff_digest: sha256Digest,
});

export type ReviewResolution = z.infer<typeof reviewResolution>;

/**
 * One reviewer's structured report on one diff.
 *
 * `diff_digest` binds the report to the exact change reviewed. That is criterion 6
 * made checkable: a report whose digest does not match the diff under
 * consideration is stale, and {@link mergeReviewReports} refuses to combine
 * reports from different diffs.
 */
export const reviewReport = versionedContract({
  report_id: idString,
  reviewer_id: idString,
  /** Digest of the diff actually read. NOT of the implementer's description. */
  diff_digest: sha256Digest,
  /** Tree digest the review was performed against. */
  tree_digest: sha256Digest,
  findings: z.array(reviewFinding).max(MAX_FINDINGS),
  /**
   * How many diff lines the reviewer examined.
   *
   * Required because an empty finding list is ambiguous: it means either "I read
   * this and found nothing" or "I did not read it". An audit probe showed the second
   * rendering as `READY`, which is rubber-stamping by omission — the easiest kind to
   * miss, because a clean report looks like good news. A reviewer claiming zero
   * findings must state a non-zero examination, and {@link deriveReadiness} refuses
   * a report that reviewed nothing.
   */
  lines_examined: z.int().nonnegative(),
});

export type ReviewReport = z.infer<typeof reviewReport>;

/**
 * Model-authored finding used only at the pre-commit boundary.
 *
 * There is intentionally no `finding_id`: identity is derived by the server from
 * the stable location after validation, never accepted from model prose.
 */
export const preCommitModelFinding = valueObject({
  severity: reviewSeverity,
  summary: z.string().min(8).max(2048),
  location: reviewLocation,
  evidence: z.string().max(MAX_EVIDENCE_LENGTH),
  required_fix: z.string().max(2048),
}).superRefine((finding, ctx) => {
  if (!isBlockingSeverity(finding.severity)) return;
  if (finding.evidence.trim().length < MIN_EVIDENCE_LENGTH) {
    ctx.addIssue({
      code: "custom",
      message: "a blocking pre-commit finding must quote evidence from the diff",
      path: ["evidence"],
    });
  }
  if (finding.required_fix.trim().length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "a blocking pre-commit finding must state the required fix",
      path: ["required_fix"],
    });
  }
});

export type PreCommitModelFinding = z.infer<typeof preCommitModelFinding>;

/** Strict structured output of one fresh, tools-disabled pre-commit reviewer. */
export const preCommitReviewOutput = versionedContract({
  findings: z.array(preCommitModelFinding).max(MAX_FINDINGS),
  lines_examined: z.int().nonnegative(),
});

export type PreCommitReviewOutput = z.infer<typeof preCommitReviewOutput>;

/** Whether the change is ready to publish. */
export const ReviewReadiness = {
  READY: "READY",
  CHANGES_REQUIRED: "CHANGES_REQUIRED",
  /** The loop hit its limit with findings outstanding. Needs a human. */
  ESCALATED: "ESCALATED",
} as const;

export type ReviewReadiness = (typeof ReviewReadiness)[keyof typeof ReviewReadiness];

export const reviewReadinessValue = z.enum([
  ReviewReadiness.READY,
  ReviewReadiness.CHANGES_REQUIRED,
  ReviewReadiness.ESCALATED,
]);

/**
 * The derived readiness verdict.
 *
 * Obtainable only from {@link deriveReadiness}. `derived_from` lists the report ids
 * it was computed over and `unresolved` names every finding still blocking, so a
 * reader can recompute the same answer from the same inputs.
 */
export const reviewReadinessReport = versionedContract({
  readiness: reviewReadinessValue,
  derived_from: z.array(idString).min(1).max(64),
  /** Finding ids that still block, sorted. Empty exactly when `READY`. */
  unresolved: z.array(idString).max(MAX_FINDINGS),
  iterations_used: z.int().nonnegative(),
  iteration_limit: z.int().positive(),
  diff_digest: sha256Digest,
});

export type ReviewReadinessReport = z.infer<typeof reviewReadinessReport>;

/** Raised when review evidence cannot be interpreted deterministically. */
export class ReviewContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReviewContractError";
  }
}

/**
 * Merge several reviewers' reports on ONE diff into a deduplicated finding list.
 *
 * Deterministic, which matters because reviewers may run in parallel: the result
 * must not depend on completion order. Findings are sorted by severity, then path,
 * then line, then id.
 *
 * Two reviewers reporting the same location keep the HIGHER severity. That is the
 * safe direction — downgrading on disagreement would let one lenient reviewer
 * silence a stricter one, which is the "conflicting reviews" case the task calls
 * out. Reports on different diffs are refused rather than merged, since a finding
 * about one change cannot vouch for another.
 */
export function mergeReviewReports(reports: readonly ReviewReport[]): readonly ReviewFinding[] {
  if (reports.length === 0) {
    throw new ReviewContractError("cannot merge zero reports");
  }
  const [first] = reports;
  if (first === undefined) throw new ReviewContractError("cannot merge zero reports");
  for (const report of reports) {
    if (report.diff_digest !== first.diff_digest) {
      throw new ReviewContractError("cannot merge reports about different diffs");
    }
  }

  const order: Record<ReviewSeverity, number> = {
    BLOCKER: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    NIT: 4,
  };

  /** Same file and line is the same observation, whoever reported it. */
  const keyOf = (finding: ReviewFinding): string =>
    finding.location === null
      ? `unlocated:${finding.finding_id}`
      : `${finding.location.relative_path}:${String(finding.location.line)}`;

  const bySite = new Map<string, ReviewFinding>();
  for (const report of reports) {
    for (const finding of report.findings) {
      const key = keyOf(finding);
      const existing = bySite.get(key);
      // Keep the higher severity on disagreement: a lenient reviewer must not be
      // able to overwrite a stricter one's blocker.
      if (existing === undefined || order[finding.severity] < order[existing.severity]) {
        bySite.set(key, finding);
      }
    }
  }

  return Object.freeze(
    [...bySite.values()].sort((left, right) => {
      const bySeverity = order[left.severity] - order[right.severity];
      if (bySeverity !== 0) return bySeverity;
      const leftPath = left.location?.relative_path ?? "";
      const rightPath = right.location?.relative_path ?? "";
      if (leftPath !== rightPath) return leftPath < rightPath ? -1 : 1;
      const byLine = (left.location?.line ?? 0) - (right.location?.line ?? 0);
      if (byLine !== 0) return byLine;
      return left.finding_id < right.finding_id ? -1 : 1;
    }),
  );
}

/**
 * Derive readiness. The ONLY way to obtain a {@link ReviewReadinessReport}.
 *
 * Rules, each fail-closed:
 *
 * 1. no reports -> throws. "Nobody reviewed" must never render as `READY`;
 * 2. a blocking finding counts as unresolved unless it was dispositioned
 *    `FALSE_POSITIVE`/`DEFERRED` (each of which required a rationale) or has a
 *    {@link ReviewResolution} carrying a commit and passing receipts;
 * 3. any unresolved blocking finding with iterations remaining ->
 *    `CHANGES_REQUIRED`;
 * 4. any unresolved blocking finding with the limit reached -> `ESCALATED`. The
 *    loop cannot silently continue and cannot silently pass (criterion 4);
 * 5. otherwise `READY`.
 *
 * Non-blocking findings never affect readiness, which is why severity inflation is
 * the failure mode `ReviewSeverity` is shaped to discourage.
 */
export function deriveReadiness(input: {
  readonly reports: readonly ReviewReport[];
  readonly dispositions: readonly ReviewDispositionRecord[];
  readonly resolutions: readonly ReviewResolution[];
  readonly iterationsUsed: number;
  readonly iterationLimit: number;
}): ReviewReadinessReport {
  const { reports, iterationsUsed, iterationLimit } = input;
  if (reports.length === 0) {
    throw new ReviewContractError("readiness cannot be derived from zero reports");
  }
  if (iterationLimit <= 0) {
    throw new ReviewContractError("the iteration limit must be positive");
  }
  // A reviewer that examined nothing produced no evidence, so its silence cannot
  // vouch for the change. Refused rather than treated as a clean report.
  if (reports.every((report) => report.lines_examined === 0)) {
    throw new ReviewContractError("no reviewer examined the diff");
  }

  const merged = mergeReviewReports(reports);
  const dismissed = new Set(
    input.dispositions
      .filter((record) => record.disposition !== ReviewDisposition.ACCEPTED)
      .map((record) => record.finding_id),
  );
  const [firstReport] = reports;
  const reviewedDigest = firstReport?.diff_digest;

  // A resolution counts ONLY if it produced a diff different from the one being
  // reviewed. A resolution whose `fixed_diff_digest` equals the reviewed digest is
  // claiming to have fixed the code without changing it, which is precisely the
  // rubber-stamp an audit probe demonstrated: any 40-hex commit plus any receipt
  // digest used to clear a BLOCKER outright.
  const resolved = new Set(
    input.resolutions
      .filter((resolution) => resolution.fixed_diff_digest !== reviewedDigest)
      .map((resolution) => resolution.finding_id),
  );

  const unresolved = merged
    .filter(
      (finding) =>
        isBlockingSeverity(finding.severity) &&
        !dismissed.has(finding.finding_id) &&
        !resolved.has(finding.finding_id),
    )
    .map((finding) => finding.finding_id)
    .sort();

  const readiness =
    unresolved.length === 0
      ? ReviewReadiness.READY
      : // Out of budget with work outstanding: a human decides, and the loop
        // neither spins nor quietly declares success.
        iterationsUsed >= iterationLimit
        ? ReviewReadiness.ESCALATED
        : ReviewReadiness.CHANGES_REQUIRED;

  const [first] = reports;
  return reviewReadinessReport.parse({
    schema_version: 1,
    readiness,
    derived_from: reports.map((report) => report.report_id).sort(),
    unresolved,
    iterations_used: iterationsUsed,
    iteration_limit: iterationLimit,
    diff_digest: first?.diff_digest,
  });
}
