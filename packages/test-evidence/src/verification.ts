/**
 * The Verification role: run a manifest, collect receipts, derive a verdict.
 *
 * This is the composition layer, and its whole design question is *what the role
 * is allowed to do*. The task requires a role that "interprets results without
 * being able to falsify them", which means the interesting part is the absence of
 * capability rather than the presence of logic:
 *
 * - {@link VerificationSession.verify} returns a {@link VerificationReport} whose
 *   verdict comes from `deriveVerdict` over the receipts it just collected. The
 *   session has no method that takes a verdict, no override, no `force`, and no way
 *   to add a receipt it did not obtain from the runner;
 * - receipts are minted only by `./runner.ts` from an observed process result, so
 *   the session cannot fabricate one to feed the derivation;
 * - the report carries `runs`, so a reader can re-run `deriveVerdict` over the same
 *   receipts and must get the same answer. A verdict that cannot be reproduced from
 *   its inputs is an assertion, not evidence;
 * - {@link VerificationSession.attachSnapshotAcceptance} takes only an acceptance
 *   produced by `acceptSnapshotChange`, which already refuses without a
 *   substantive justification bound to the accepted bytes. The session cannot
 *   approve a snapshot itself.
 *
 * The one thing the role *does* decide is presentation: which failures to surface
 * and in what order. That is deliberately kept separate from the verdict, so a
 * change to the summary can never change the outcome.
 *
 * Unapproved snapshot changes block. A changed snapshot with no justification is
 * exactly the rubber-stamping case, so it makes the report `INCONCLUSIVE` rather
 * than being reported alongside a `PASSED` verdict — but it is never reported as
 * `FAILED`, because an unreviewed snapshot is a missing decision, not a regression.
 */
import { EvidenceVerdict, TestOutcome, deriveVerdict, isNonAssertionOutcome } from "./contracts.js";
import type { EvidenceScope, EvidenceVerdictRecord, TestRun } from "./contracts.js";
import { SnapshotStatus } from "./snapshot.js";
import type { SnapshotAcceptance, SnapshotComparison } from "./snapshot.js";
import type { TestRunner } from "./runner.js";

/** A snapshot change that nobody justified. Blocks, but is not a regression. */
export type UnapprovedSnapshot = Readonly<{
  snapshot_id: string;
  status: SnapshotStatus;
  changed_lines: number;
}>;

/**
 * The complete evidence for one verification pass.
 *
 * `verdict` is derived; `runs` are the inputs it was derived from. Both are present
 * so the conclusion is checkable rather than merely stated.
 */
export type VerificationReport = Readonly<{
  scope: EvidenceScope;
  verdict: EvidenceVerdictRecord;
  runs: readonly TestRun[];
  /** Snapshot comparisons observed in this pass, classified from bytes. */
  snapshots: readonly SnapshotComparison[];
  /** Changed snapshots with no accepted justification. */
  unapproved: readonly UnapprovedSnapshot[];
  /** Ordered, human-readable reasons the verdict is not `PASSED`. Never an input. */
  summary: readonly string[];
}>;

export type VerificationSessionOptions = Readonly<{
  scope: EvidenceScope;
  runner: TestRunner;
}>;

/**
 * A single verification pass.
 *
 * Stateful only in the sense that it accumulates the receipts and comparisons it
 * observed. Everything it accumulates is either produced by the runner or by
 * `classifySnapshot`/`acceptSnapshotChange`, so there is no channel through which
 * a caller can inject a favourable result.
 */
export class VerificationSession {
  readonly #scope: EvidenceScope;
  readonly #runner: TestRunner;
  readonly #runs: TestRun[] = [];
  readonly #snapshots: SnapshotComparison[] = [];
  readonly #acceptances = new Map<string, SnapshotAcceptance>();

  public constructor(options: VerificationSessionOptions) {
    this.#scope = options.scope;
    this.#runner = options.runner;
  }

  /**
   * Execute every required manifest entry, plus any optional ones named.
   *
   * Runs sequentially and does NOT stop at the first failure: the evidence set is
   * more useful complete, and a later phase's result is not invalidated by an
   * earlier failure. A command that throws (unknown name, unreadable pre-state)
   * produces no receipt at all rather than a fabricated one.
   */
  public async runAll(commandNames?: readonly string[]): Promise<readonly TestRun[]> {
    const names = commandNames ?? this.#runner.commands;
    const produced: TestRun[] = [];
    for (const name of names) {
      const run = await this.#runner.run({ command_name: name });
      this.#runs.push(run);
      produced.push(run);
    }
    return produced;
  }

  /** Record a snapshot comparison classified from real bytes. */
  public recordSnapshot(comparison: SnapshotComparison): void {
    this.#snapshots.push(comparison);
  }

  /**
   * Attach a justified acceptance for a snapshot change.
   *
   * Takes a {@link SnapshotAcceptance}, which `acceptSnapshotChange` only issues
   * against a substantive justification and the exact accepted digest. This method
   * therefore cannot be used to approve anything; it can only carry an approval
   * that was already earned.
   */
  public attachSnapshotAcceptance(acceptance: SnapshotAcceptance): void {
    this.#acceptances.set(acceptance.comparison.snapshot_id, acceptance);
  }

  /**
   * Derive the report. The verdict is computed here and nowhere else.
   *
   * Ordering mirrors `deriveVerdict`: a non-assertion outcome or an unapproved
   * snapshot yields `INCONCLUSIVE`, and only a genuine assertion failure yields
   * `FAILED`. So a timed-out run or a missing snapshot decision never reads as
   * "the code is broken".
   */
  public verify(): VerificationReport {
    // Throws for an empty evidence set — "nothing ran" must never render as PASSED.
    const derived = deriveVerdict(this.#runs, this.#runner.requiredCommands);

    const unapproved: UnapprovedSnapshot[] = this.#snapshots
      .filter((comparison) => {
        if (comparison.status === SnapshotStatus.UNCHANGED) return false;
        const acceptance = this.#acceptances.get(comparison.snapshot_id);
        // An acceptance for different bytes does not count as approval.
        return (
          acceptance === undefined || acceptance.accepted_digest !== comparison.candidate_digest
        );
      })
      .map((comparison) => ({
        snapshot_id: comparison.snapshot_id,
        status: comparison.status,
        changed_lines: comparison.diff.changed_lines,
      }));

    // An unreviewed snapshot cannot upgrade a FAILED verdict, and cannot be
    // reported as a regression either; it can only withhold a PASSED.
    const verdict: EvidenceVerdictRecord =
      unapproved.length > 0 && derived.verdict === EvidenceVerdict.PASSED
        ? { ...derived, verdict: EvidenceVerdict.INCONCLUSIVE }
        : derived;

    const summary: string[] = [];
    for (const run of this.#runs) {
      if (run.outcome === TestOutcome.PASSED) continue;
      summary.push(
        isNonAssertionOutcome(run.outcome)
          ? `${run.command_name}: ${run.outcome} (run-level, not a code regression)`
          : `${run.command_name}: ${run.outcome} (exit ${String(run.exit_code)})`,
      );
    }
    for (const snapshot of unapproved) {
      summary.push(`${snapshot.snapshot_id}: ${snapshot.status} without an accepted justification`);
    }

    return Object.freeze({
      scope: this.#scope,
      verdict,
      runs: Object.freeze([...this.#runs]),
      snapshots: Object.freeze([...this.#snapshots]),
      unapproved: Object.freeze(unapproved),
      summary: Object.freeze(summary),
    });
  }
}
