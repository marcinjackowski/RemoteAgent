/**
 * The reviewer role: read the real diff, produce findings, write nothing.
 *
 * **Criterion 1: the reviewer cannot modify code or checkpoint authority fields.**
 * That is enforced by construction, not by policy. {@link ReviewerContext} is built
 * by {@link createReviewerContext} from a diff and its evidence, and the object it
 * returns is frozen and contains no function that writes: no patch, no mkdir, no
 * command, no ledger, no checkpoint. The reviewer literally has no handle through
 * which a write could be issued.
 *
 * The package does not merely avoid importing the write-capable packages
 * (`implementation-tools`, `git-lifecycle`, `database`, `workspace-runner`) — it does
 * not DEPEND on them at all, so there is nothing to accidentally import later. A
 * read-only role that holds a write capability is read-only only by convention, and
 * convention is what this package exists to replace.
 * `test/review.integration.test.ts` asserts the manifest and the module surface
 * mechanically, because a comment saying "we don't write" is not a guarantee.
 *
 * **Criterion 6: the reviewer does not trust the implementer's description.**
 * The context carries `diff` and `diff_digest`, and the digest is computed HERE from
 * the diff text — never accepted as a parameter. An implementer-supplied summary is
 * accepted only as `claimed_summary`, is explicitly marked `UNTRUSTED_DATA`, and
 * {@link assertReviewedRealDiff} refuses a report whose digest does not match the
 * diff the context was built from. So a review of a description rather than of the
 * change cannot pass validation.
 */
import { TrustLevel, canonicalDigest } from "@remoteagent/contracts";
import * as z from "zod";

import { ReviewContractError, reviewReport } from "./contracts.js";
import type { ReviewFinding, ReviewReport } from "./contracts.js";

/** The reviewer was given a report about a different diff than it read. */
export const REVIEW_DIFF_MISMATCH = "REVIEW_DIFF_MISMATCH";

/**
 * Everything a reviewer may see, and nothing more.
 *
 * Read-only by construction: every field is data, and the object is frozen. Note
 * what is absent — no store handle, no runner, no lifecycle, no checkpoint writer.
 */
export type ReviewerContext = Readonly<{
  /** The actual unified diff under review. */
  readonly diff: string;
  /** Digest of `diff`, computed here. Binds a report to what was really read. */
  readonly diff_digest: string;
  readonly tree_digest: string;
  /** Task description, decisions and repository instructions. */
  readonly task_brief: string;
  /** Test evidence receipt digests, so the reviewer can check what was verified. */
  readonly run_receipts: readonly string[];
  /**
   * The implementer's own account of the change.
   *
   * Pinned to `UNTRUSTED_DATA` by a literal and named `claimed_` on purpose: it is
   * an input to judgement, never a substitute for reading the diff. Criterion 6.
   */
  readonly claimed_summary: Readonly<{ trust: typeof TrustLevel.UNTRUSTED_DATA; value: string }>;
}>;

export type ReviewerContextInput = Readonly<{
  diff: string;
  treeDigest: string;
  taskBrief: string;
  runReceipts?: readonly string[];
  claimedSummary?: string;
}>;

/**
 * Build the reviewer's context.
 *
 * The digest is derived from the diff text rather than accepted from the caller. If
 * it were a parameter, an implementer could hand over a digest that matches their
 * description while the diff says something else, and every downstream binding would
 * agree with the lie.
 */
export function createReviewerContext(input: ReviewerContextInput): ReviewerContext {
  return Object.freeze({
    diff: input.diff,
    diff_digest: canonicalDigest(input.diff),
    tree_digest: input.treeDigest,
    task_brief: input.taskBrief,
    run_receipts: Object.freeze([...(input.runReceipts ?? [])]),
    claimed_summary: Object.freeze({
      trust: TrustLevel.UNTRUSTED_DATA,
      value: input.claimedSummary ?? "",
    }),
  });
}

/**
 * Refuse a report that does not describe the diff the reviewer was given.
 *
 * Criterion 6 as an executable check. Two failures are caught: a stale report (the
 * diff moved on since it was written) and a report produced without reading the
 * diff at all. Both would otherwise be indistinguishable from a real review.
 */
export function assertReviewedRealDiff(context: ReviewerContext, report: ReviewReport): void {
  if (report.diff_digest !== context.diff_digest) {
    throw new ReviewContractError(REVIEW_DIFF_MISMATCH);
  }
  if (report.tree_digest !== context.tree_digest) {
    throw new ReviewContractError(REVIEW_DIFF_MISMATCH);
  }
}

/**
 * Verify that every blocking finding quotes text that is actually in the diff.
 *
 * This is the anti-fabrication check, and it is stronger than requiring evidence to
 * be non-empty: a reviewer could satisfy that by inventing a plausible-looking line.
 * Requiring the quote to appear VERBATIM in the diff means a blocking finding must
 * be anchored in the real change. Returns the finding ids whose evidence could not
 * be located, so the caller can downgrade rather than trust them.
 */
export function findUnsupportedFindings(
  context: ReviewerContext,
  findings: readonly ReviewFinding[],
): readonly string[] {
  const normalized = context.diff.replace(/\s+/gu, " ");
  return Object.freeze(
    findings
      .filter((finding) => {
        const quote = finding.evidence.trim().replace(/\s+/gu, " ");
        if (quote.length === 0) return false;
        return !normalized.includes(quote);
      })
      .map((finding) => finding.finding_id)
      .sort(),
  );
}

/** Shape a reviewer implementation must satisfy. Read-only: it returns a report. */
export type Reviewer = Readonly<{
  readonly reviewer_id: string;
  review(context: ReviewerContext): Promise<ReviewReport>;
}>;

/**
 * Wrap a reviewer so its output is validated before anyone acts on it.
 *
 * Every report is re-parsed against the schema and checked against the context, so
 * a reviewer cannot return a malformed report, a report about another diff, or a
 * blocking finding whose evidence is not in the change. Unsupported blocking
 * findings are DOWNGRADED to `LOW` rather than dropped: the observation may still be
 * worth reading, but it must not block work it cannot substantiate (criterion 3).
 */
export function guardReviewer(reviewer: Reviewer): Reviewer {
  return Object.freeze({
    reviewer_id: reviewer.reviewer_id,
    review: async (context: ReviewerContext): Promise<ReviewReport> => {
      const produced = reviewReport.parse(await reviewer.review(context));
      assertReviewedRealDiff(context, produced);

      const unsupported = new Set(findUnsupportedFindings(context, produced.findings));
      if (unsupported.size === 0) return produced;

      return reviewReport.parse({
        ...produced,
        findings: produced.findings.map((finding) =>
          unsupported.has(finding.finding_id)
            ? {
                ...finding,
                // Downgraded, not deleted: an unsubstantiated remark can still be
                // read, but it cannot stop the work.
                severity: "LOW",
                summary: `${finding.summary} [evidence not found in diff; downgraded]`,
              }
            : finding,
        ),
      });
    },
  });
}

/** Assert at runtime that a reviewer context exposes no write capability. */
export function reviewerCapabilityNames(context: ReviewerContext): readonly string[] {
  // Every value must be data. A function on the context would be a capability, and
  // a capability is how a read-only role stops being read-only.
  return Object.freeze(
    Object.entries(context)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort(),
  );
}

/** Schema for the untrusted summary, exported so consumers cannot re-trust it. */
export const claimedSummary = z.strictObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: z.string().max(8192),
});
