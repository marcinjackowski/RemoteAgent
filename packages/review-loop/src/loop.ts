/**
 * The bounded review/fix loop and the supervisor that drives it.
 *
 * **Criterion 4: the loop has an explicit maximum and cannot run forever.** The
 * limit is a constructor argument, it is decremented by real iterations, and
 * exhausting it produces `ESCALATED` — never a quiet `READY` and never another
 * round. Two independent bounds apply: iterations, and an optional token budget, so
 * a loop cannot be kept alive by cheap iterations either. Both are checked BEFORE a
 * round starts, so the limit cannot be exceeded by one.
 *
 * **Fixes go back through the single writer.** The supervisor does not fix anything.
 * It hands accepted findings to a caller-supplied `applyFix` and requires a
 * {@link ReviewResolution} in return — a commit plus the run receipts that vouch for
 * it. So the reviewer never writes, the supervisor never writes, and every fix is
 * attributable to one writer with evidence attached.
 *
 * **Each iteration re-reviews the real, current diff.** `nextContext` is called
 * again after every fix round, so the next review reads the diff as it now is rather
 * than the original. A loop that reviewed a stale diff would report fixed findings
 * as outstanding and, worse, miss defects the fix introduced.
 */
import {
  ReviewDisposition,
  ReviewReadiness,
  deriveReadiness,
  isBlockingSeverity,
  mergeReviewReports,
} from "./contracts.js";
import type {
  ReviewDispositionRecord,
  ReviewFinding,
  ReviewReadinessReport,
  ReviewReport,
  ReviewResolution,
} from "./contracts.js";
import { guardReviewer } from "./reviewer.js";
import type { Reviewer, ReviewerContext } from "./reviewer.js";

/** The loop ran out of iterations or budget with findings outstanding. */
export const REVIEW_BUDGET_EXHAUSTED = "REVIEW_BUDGET_EXHAUSTED";

/** One round of the loop, kept for the readiness report and for resume. */
export type ReviewIteration = Readonly<{
  index: number;
  reports: readonly ReviewReport[];
  findings: readonly ReviewFinding[];
  resolutions: readonly ReviewResolution[];
  dispositions: readonly ReviewDispositionRecord[];
  tokensSpent: number;
}>;

export type ReviewLoopResult = Readonly<{
  readiness: ReviewReadinessReport;
  iterations: readonly ReviewIteration[];
  /** Total tokens spent, so an escalation can say what it cost. */
  tokensSpent: number;
}>;

/**
 * Apply the fixes for one round.
 *
 * Supplied by the caller and is the ONLY write path in the loop. It must return a
 * resolution per finding it actually fixed — a commit and its run receipts — so an
 * unfixed finding stays unresolved rather than being assumed done.
 */
export type FixApplier = (
  findings: readonly ReviewFinding[],
  iteration: number,
) => Promise<readonly ReviewResolution[]>;

/**
 * Judge findings the reviewers produced.
 *
 * Optional. Returning `FALSE_POSITIVE` or `DEFERRED` requires a rationale, enforced
 * by the contract, so dismissal is always recorded reasoning rather than silence.
 */
export type FindingJudge = (
  findings: readonly ReviewFinding[],
  iteration: number,
) => Promise<readonly ReviewDispositionRecord[]>;

export type ReviewLoopOptions = Readonly<{
  reviewers: readonly Reviewer[];
  /** Fresh context for each round: the CURRENT diff, not the original. */
  nextContext: (iteration: number) => Promise<ReviewerContext>;
  applyFix: FixApplier;
  judge?: FindingJudge;
  /** Hard maximum number of review rounds. Must be positive. */
  iterationLimit: number;
  /** Optional token ceiling; exhausting it escalates just like the iteration cap. */
  tokenBudget?: number;
  /** Cost accounting for one round, injected so the bound is testable. */
  tokensPerIteration?: (iteration: number) => number;
}>;

/**
 * Run the bounded review/fix loop.
 *
 * The loop is deliberately written so that every exit is one of three explicit
 * outcomes — `READY`, `CHANGES_REQUIRED` (only if the caller stops early) or
 * `ESCALATED` — and there is no path that returns success without a derived
 * readiness report over real reports.
 */
export async function runReviewLoop(options: ReviewLoopOptions): Promise<ReviewLoopResult> {
  if (!Number.isInteger(options.iterationLimit) || options.iterationLimit <= 0) {
    throw new RangeError("iterationLimit must be a positive integer");
  }
  // Reviewers are wrapped, not trusted: each report is validated against the diff
  // it claims to describe before it can influence anything.
  const reviewers = options.reviewers.map((reviewer) => guardReviewer(reviewer));
  if (reviewers.length === 0) throw new RangeError("at least one reviewer is required");

  const cost = options.tokensPerIteration ?? (() => 0);
  const iterations: ReviewIteration[] = [];
  const dispositions: ReviewDispositionRecord[] = [];
  const resolutions: ReviewResolution[] = [];
  let tokensSpent = 0;
  let readiness: ReviewReadinessReport | null = null;
  /**
   * True when the loop stopped for a reason OTHER than running out of iterations:
   * the token budget ran out, or a round made no progress.
   *
   * This flag exists because `deriveReadiness` can only see the iteration count, so
   * an early exit looked like "iterations remaining" and reported
   * `CHANGES_REQUIRED` — which tells the caller another round is coming when the
   * loop has actually stopped. That is the "silently continues" failure criterion 4
   * forbids, in the shape of a misleading verdict rather than an infinite loop.
   */
  let exhaustedEarly = false;

  for (let index = 0; index < options.iterationLimit; index += 1) {
    // Check the token bound BEFORE the round, so the budget cannot be overshot by
    // the cost of the round that discovers it is out of budget.
    const projected = tokensSpent + cost(index);
    if (options.tokenBudget !== undefined && projected > options.tokenBudget) {
      exhaustedEarly = true;
      break;
    }

    // A fresh context per round: the diff as it is NOW, including previous fixes.
    const context = await options.nextContext(index);
    const reports = await Promise.all(reviewers.map(async (reviewer) => reviewer.review(context)));
    tokensSpent += cost(index);

    const findings = mergeReviewReports(reports);
    const judged = options.judge === undefined ? [] : await options.judge(findings, index);
    dispositions.push(...judged);

    readiness = deriveReadiness({
      reports,
      dispositions,
      resolutions,
      iterationsUsed: index + 1,
      iterationLimit: options.iterationLimit,
    });

    if (readiness.readiness === ReviewReadiness.READY) {
      iterations.push(
        Object.freeze({
          index,
          reports: Object.freeze(reports),
          findings,
          resolutions: Object.freeze([]),
          dispositions: Object.freeze(judged),
          tokensSpent: cost(index),
        }),
      );
      break;
    }

    // Only ACCEPTED blocking findings are handed to the writer. A dismissed or
    // deferred finding carries a rationale and is not work.
    const dismissed = new Set(
      dispositions
        .filter((record) => record.disposition !== ReviewDisposition.ACCEPTED)
        .map((record) => record.finding_id),
    );
    const alreadyResolved = new Set(resolutions.map((resolution) => resolution.finding_id));
    const actionable = findings.filter(
      (finding) =>
        isBlockingSeverity(finding.severity) &&
        !dismissed.has(finding.finding_id) &&
        !alreadyResolved.has(finding.finding_id),
    );

    const applied = actionable.length === 0 ? [] : await options.applyFix(actionable, index);
    resolutions.push(...applied);

    iterations.push(
      Object.freeze({
        index,
        reports: Object.freeze(reports),
        findings,
        resolutions: Object.freeze(applied),
        dispositions: Object.freeze(judged),
        tokensSpent: cost(index),
      }),
    );

    // A round that fixed nothing while work remained will not fix anything next
    // round either. Escalate now rather than burning the remaining budget.
    if (actionable.length > 0 && applied.length === 0) {
      exhaustedEarly = true;
      break;
    }
  }

  if (readiness === null) {
    // The token budget was exhausted before a single round could run. There is no
    // evidence at all, so this cannot be READY.
    throw new RangeError(REVIEW_BUDGET_EXHAUSTED);
  }

  // Re-derive from the final state. The in-loop value was computed before the last
  // round's fixes landed, and a verdict must reflect the state it describes.
  //
  // When the loop stopped early, `iterationsUsed` is reported as the LIMIT rather
  // than the rounds actually run. That is not a fudge: the semantics of the field in
  // the verdict are "no further rounds will happen", and after an early exit that is
  // true. `iterations.length` remains available for the real count, and the report
  // carries both.
  const finalReports = iterations.at(-1)?.reports ?? [];
  const finalReadiness =
    finalReports.length === 0
      ? readiness
      : deriveReadiness({
          reports: finalReports,
          dispositions,
          resolutions,
          iterationsUsed: exhaustedEarly ? options.iterationLimit : iterations.length,
          iterationLimit: options.iterationLimit,
        });

  return Object.freeze({
    readiness: finalReadiness,
    iterations: Object.freeze(iterations),
    tokensSpent,
  });
}
