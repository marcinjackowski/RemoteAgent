/**
 * Tests for the independent review/fix loop.
 *
 * The fixtures the task requires are all here as real data: a diff containing a
 * genuine defect, a false-positive finding, and two reviewers disagreeing about the
 * same line. Role capability is checked mechanically rather than asserted, and the
 * bounded loop is driven to exhaustion.
 *
 * What each block proves:
 *
 *   1. **AC1 — the reviewer cannot write.** The context is inspected for functions
 *      and for known write-capability names, and the package's own dependency
 *      surface is checked, because a read-only role holding a write handle is
 *      read-only only by convention;
 *   2. **AC2 — PASS requires no unresolved BLOCKER/HIGH/MEDIUM.** Each blocking
 *      severity is driven separately, and LOW/NIT are shown not to block;
 *   3. **AC3 — a finding with no location or evidence cannot block.** Attempted as
 *      a schema violation AND through the guard, which downgrades a fabricated
 *      quote instead of trusting it;
 *   4. **AC4 — the loop is bounded.** Iteration exhaustion, token exhaustion and a
 *      no-progress round each escalate rather than spin;
 *   5. **AC5 — a resolved finding names its fix evidence.** A resolution without a
 *      commit or without receipts is unrepresentable;
 *   6. **AC6 — the reviewer does not trust the implementer's description.** A
 *      report about a different diff is refused, and a lying summary does not change
 *      the digest the report must match.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  MIN_EVIDENCE_LENGTH,
  REVIEW_DIFF_MISMATCH,
  ReviewContractError,
  ReviewDisposition,
  ReviewReadiness,
  ReviewSeverity,
  assertReviewedRealDiff,
  createReviewerContext,
  deriveReadiness,
  findUnsupportedFindings,
  guardReviewer,
  isBlockingSeverity,
  mergeReviewReports,
  reviewDisposition,
  reviewFinding,
  reviewReport,
  reviewResolution,
  reviewerCapabilityNames,
  runReviewLoop,
} from "../src/index.js";
import type { ReviewFinding, ReviewReport, Reviewer, ReviewerContext } from "../src/index.js";

const TREE = `sha256:${"c".repeat(64)}`;
const RECEIPT = `sha256:${"d".repeat(64)}`;
const COMMIT = "a".repeat(40);
/** Digest of the diff AFTER a fix; must differ from the reviewed diff. */
const FIXED_DIFF = `sha256:${"f".repeat(64)}`;

/**
 * A diff with a REAL defect: the comparison uses `==` where the surrounding code
 * relies on strict equality, and the guard is inverted.
 */
const DIFF_WITH_BUG = `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,7 +10,7 @@
 export function isAuthorized(role: string, required: string): boolean {
-  return role === required;
+  return role == required || true;
 }
`;

function context(overrides: Partial<Parameters<typeof createReviewerContext>[0]> = {}) {
  return createReviewerContext({
    diff: DIFF_WITH_BUG,
    treeDigest: TREE,
    taskBrief: "Harden authorization checks.",
    runReceipts: [RECEIPT],
    ...overrides,
  });
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return reviewFinding.parse({
    schema_version: 1,
    finding_id: "f1",
    severity: ReviewSeverity.BLOCKER,
    summary: "The guard always returns true, so every role is authorized.",
    location: { relative_path: "src/auth.ts", line: 12 },
    // Verbatim from the diff, which is what the guard requires.
    evidence: "return role == required || true;",
    required_fix: "Restore strict equality and remove the `|| true` short circuit.",
    ...overrides,
  });
}

function report(findings: readonly ReviewFinding[], overrides: Partial<ReviewReport> = {}) {
  return reviewReport.parse({
    schema_version: 1,
    report_id: "r1",
    reviewer_id: "reviewer-a",
    diff_digest: canonicalDigest(DIFF_WITH_BUG),
    tree_digest: TREE,
    findings: [...findings],
    lines_examined: 6,
    ...overrides,
  });
}

/** A reviewer that returns a fixed report; stands in for a model call. */
function stubReviewer(id: string, findings: readonly ReviewFinding[]): Reviewer {
  return {
    reviewer_id: id,
    review: async (ctx: ReviewerContext) =>
      reviewReport.parse({
        schema_version: 1,
        report_id: `report-${id}`,
        reviewer_id: id,
        diff_digest: ctx.diff_digest,
        tree_digest: ctx.tree_digest,
        findings: [...findings],
        lines_examined: 6,
      }),
  };
}

describe("independent review loop", () => {
  describe("AC1: the reviewer cannot modify code or authority fields", () => {
    it("exposes no callable capability at all", () => {
      // A function on the context would BE a write capability. There are none.
      expect(reviewerCapabilityNames(context())).toEqual([]);
    });

    it("exposes no write-shaped field under any known name", () => {
      const ctx = context() as unknown as Record<string, unknown>;
      for (const forbidden of [
        "write",
        "patch",
        "mkdir",
        "command",
        "stage",
        "commit",
        "rebase",
        "ledger",
        "store",
        "checkpoint",
        "runTransaction",
        "apply",
      ]) {
        expect(ctx[forbidden], forbidden).toBeUndefined();
      }
    });

    it("is frozen, so a caller cannot graft a capability onto it", () => {
      const ctx = context();
      expect(Object.isFrozen(ctx)).toBe(true);
      expect(() => {
        (ctx as unknown as Record<string, unknown>)["write"] = () => undefined;
      }).toThrow();
      expect((ctx as unknown as Record<string, unknown>)["write"]).toBeUndefined();
    });

    it("exposes no write capability from the reviewer module's own surface", async () => {
      // The context check above proves one object is clean. This checks the whole
      // module: if `reviewer.ts` re-exported a write helper, a caller could reach it
      // without going through the context at all.
      const surface = await import("../src/reviewer.js");
      const exported = Object.keys(surface);
      for (const forbidden of [
        "createImplementationWriteTools",
        "createImplementationMkdirTool",
        "createImplementationCommandTool",
        "createImplementationToolset",
        "GitLifecycle",
        "LocalArtifactStore",
        "createTestRunner",
      ]) {
        expect(exported, forbidden).not.toContain(forbidden);
      }
      // And nothing named like a mutation escaped under another name.
      expect(
        exported.filter((name) =>
          /^(write|patch|commit|stage|rebase|apply|mkdir|run)[A-Z]/u.test(name),
        ),
      ).toEqual([]);
    });

    it("declares no dependency it could write through", async () => {
      // Holding a write-capable dependency is how "read-only" quietly ends, so the
      // manifest is asserted mechanically rather than trusted.
      const manifest = JSON.parse(
        await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      const deps = Object.keys(manifest.dependencies ?? {});
      expect(deps).toContain("@remoteagent/test-evidence");
      // Write-capable packages must not be reachable at all from this one.
      expect(deps).not.toContain("@remoteagent/implementation-tools");
      expect(deps).not.toContain("@remoteagent/git-lifecycle");
      expect(deps).not.toContain("@remoteagent/database");
      expect(deps).not.toContain("@remoteagent/workspace-runner");
    });
  });

  describe("AC2: READY requires no unresolved BLOCKER/HIGH/MEDIUM", () => {
    it("blocks on each blocking severity and passes on the others", () => {
      for (const severity of [ReviewSeverity.BLOCKER, ReviewSeverity.HIGH, ReviewSeverity.MEDIUM]) {
        const readiness = deriveReadiness({
          reports: [report([finding({ severity })])],
          dispositions: [],
          resolutions: [],
          iterationsUsed: 1,
          iterationLimit: 3,
        });
        expect(readiness.readiness, severity).toBe(ReviewReadiness.CHANGES_REQUIRED);
        expect(readiness.unresolved).toEqual(["f1"]);
      }

      for (const severity of [ReviewSeverity.LOW, ReviewSeverity.NIT]) {
        const readiness = deriveReadiness({
          reports: [report([finding({ severity, evidence: "", required_fix: "" })])],
          dispositions: [],
          resolutions: [],
          iterationsUsed: 1,
          iterationLimit: 3,
        });
        expect(readiness.readiness, severity).toBe(ReviewReadiness.READY);
        expect(readiness.unresolved).toEqual([]);
      }
    });

    it("refuses a report from a reviewer that examined nothing", () => {
      // Found by an audit probe: an empty finding list rendered as READY, so a
      // reviewer that never read the diff passed the change. An empty list is
      // ambiguous — "read it, found nothing" vs "did not read it" — and only the
      // examination count distinguishes them. Rubber-stamping by omission is the
      // easiest kind to miss, because a clean report looks like good news.
      expect(() =>
        deriveReadiness({
          reports: [report([], { lines_examined: 0 })],
          dispositions: [],
          resolutions: [],
          iterationsUsed: 1,
          iterationLimit: 3,
        }),
      ).toThrow(ReviewContractError);

      // A reviewer that did read it and found nothing is a legitimate READY.
      expect(
        deriveReadiness({
          reports: [report([], { lines_examined: 6 })],
          dispositions: [],
          resolutions: [],
          iterationsUsed: 1,
          iterationLimit: 3,
        }).readiness,
      ).toBe(ReviewReadiness.READY);
    });

    it("refuses a resolution that claims to fix the diff still under review", () => {
      // Found by an audit probe: any 40-hex commit plus any receipt digest cleared a
      // BLOCKER, because nothing tied the resolution to an actual change. A
      // resolution whose resulting diff equals the reviewed diff is claiming to have
      // fixed the code without changing it.
      const reviewed = canonicalDigest(DIFF_WITH_BUG);
      const selfCertifying = reviewResolution.parse({
        finding_id: "f1",
        commit_sha: COMMIT,
        run_receipts: [RECEIPT],
        fixed_diff_digest: reviewed,
      });

      expect(
        deriveReadiness({
          reports: [report([finding()])],
          dispositions: [],
          resolutions: [selfCertifying],
          iterationsUsed: 1,
          iterationLimit: 3,
        }).readiness,
      ).toBe(ReviewReadiness.CHANGES_REQUIRED);

      // A resolution that produced a genuinely different diff does clear it.
      expect(
        deriveReadiness({
          reports: [report([finding()])],
          dispositions: [],
          resolutions: [
            reviewResolution.parse({
              finding_id: "f1",
              commit_sha: COMMIT,
              run_receipts: [RECEIPT],
              fixed_diff_digest: FIXED_DIFF,
            }),
          ],
          iterationsUsed: 1,
          iterationLimit: 3,
        }).readiness,
      ).toBe(ReviewReadiness.READY);
    });

    it("caps a reviewer's claimed examination at the real diff size", async () => {
      // A reviewer must not be able to overstate how much it read.
      const boastful = guardReviewer({
        reviewer_id: "boastful",
        review: async (ctx) =>
          reviewReport.parse({
            schema_version: 1,
            report_id: "r-boast",
            reviewer_id: "boastful",
            diff_digest: ctx.diff_digest,
            tree_digest: ctx.tree_digest,
            findings: [],
            lines_examined: 100_000,
          }),
      });

      const produced = await boastful.review(context());
      expect(produced.lines_examined).toBeLessThanOrEqual(
        DIFF_WITH_BUG.split("\n").filter((line) => line.length > 0).length,
      );
    });

    it("refuses to derive readiness with no reports at all", () => {
      // "Nobody reviewed" must never render as READY.
      expect(() =>
        deriveReadiness({
          reports: [],
          dispositions: [],
          resolutions: [],
          iterationsUsed: 0,
          iterationLimit: 3,
        }),
      ).toThrow(ReviewContractError);
    });

    it("clears a blocker only via a rationale or real fix evidence", () => {
      const base = {
        reports: [report([finding()])],
        iterationsUsed: 1,
        iterationLimit: 3,
      };

      // A dismissal carrying a rationale.
      expect(
        deriveReadiness({
          ...base,
          dispositions: [
            {
              finding_id: "f1",
              disposition: ReviewDisposition.FALSE_POSITIVE,
              rationale: "The `|| true` branch is unreachable because callers pre-validate roles.",
            },
          ],
          resolutions: [],
        }).readiness,
      ).toBe(ReviewReadiness.READY);

      // Or a resolution with a commit and receipts.
      expect(
        deriveReadiness({
          ...base,
          dispositions: [],
          resolutions: [
            reviewResolution.parse({
              finding_id: "f1",
              commit_sha: COMMIT,
              run_receipts: [RECEIPT],
              fixed_diff_digest: FIXED_DIFF,
            }),
          ],
        }).readiness,
      ).toBe(ReviewReadiness.READY);
    });

    it("requires a substantive rationale to dismiss a finding", () => {
      // An unexplained dismissal is indistinguishable from not having read the
      // finding, so the record itself must be unconstructible without reasoning.
      for (const candidate of [
        { finding_id: "f1", disposition: ReviewDisposition.FALSE_POSITIVE },
        { finding_id: "f1", disposition: ReviewDisposition.FALSE_POSITIVE, rationale: "nope" },
        { finding_id: "f1", disposition: ReviewDisposition.DEFERRED },
        { finding_id: "f1", disposition: ReviewDisposition.DEFERRED, rationale: "later" },
      ]) {
        expect(reviewDisposition.safeParse(candidate).success, JSON.stringify(candidate)).toBe(
          false,
        );
      }
      // Accepting needs no rationale: the fix itself becomes the record.
      expect(
        reviewDisposition.safeParse({
          finding_id: "f1",
          disposition: ReviewDisposition.ACCEPTED,
        }).success,
      ).toBe(true);
    });
  });

  describe("AC3: a finding without location or evidence cannot block", () => {
    it("refuses a blocking finding with no location", () => {
      expect(() => finding({ location: null })).toThrow();
    });

    it("refuses a blocking finding with no substantive evidence", () => {
      expect(() => finding({ evidence: "" })).toThrow();
      expect(() => finding({ evidence: "x".repeat(MIN_EVIDENCE_LENGTH - 1) })).toThrow();
    });

    it("refuses a blocking finding with no required fix", () => {
      expect(() => finding({ required_fix: "  " })).toThrow();
    });

    it("permits an unlocated LOW or NIT, which cannot block anyway", () => {
      expect(() =>
        finding({ severity: ReviewSeverity.NIT, location: null, evidence: "", required_fix: "" }),
      ).not.toThrow();
      expect(isBlockingSeverity(ReviewSeverity.NIT)).toBe(false);
    });

    it("downgrades a blocker whose evidence is NOT in the diff", async () => {
      // The false-positive fixture: a plausible-looking quote the reviewer invented.
      const fabricated = finding({
        finding_id: "f-fake",
        evidence: "return role === required && isAdmin(role);",
      });
      const ctx = context();
      expect(findUnsupportedFindings(ctx, [fabricated])).toEqual(["f-fake"]);

      const guarded = guardReviewer(stubReviewer("reviewer-fake", [fabricated]));
      const produced = await guarded.review(ctx);

      // Downgraded rather than dropped: still readable, but it cannot block.
      expect(produced.findings[0]?.severity).toBe(ReviewSeverity.LOW);
      expect(produced.findings[0]?.summary).toContain("downgraded");
      expect(
        deriveReadiness({
          reports: [produced],
          dispositions: [],
          resolutions: [],
          iterationsUsed: 1,
          iterationLimit: 3,
        }).readiness,
      ).toBe(ReviewReadiness.READY);
    });

    it("keeps a blocker whose evidence IS in the diff", async () => {
      const guarded = guardReviewer(stubReviewer("reviewer-real", [finding()]));
      const produced = await guarded.review(context());
      expect(produced.findings[0]?.severity).toBe(ReviewSeverity.BLOCKER);
    });
  });

  describe("AC5: a resolved finding names its fix evidence", () => {
    it("requires a commit and at least one run receipt", () => {
      expect(() =>
        reviewResolution.parse({ finding_id: "f1", commit_sha: COMMIT, run_receipts: [] }),
      ).toThrow();
      expect(() => reviewResolution.parse({ finding_id: "f1", run_receipts: [RECEIPT] })).toThrow();
      expect(() =>
        reviewResolution.parse({ finding_id: "f1", commit_sha: "abc", run_receipts: [RECEIPT] }),
      ).toThrow();
    });
  });

  describe("AC6: the reviewer reads the diff, not the description", () => {
    it("refuses a report about a different diff", () => {
      const stale = report([finding()], { diff_digest: canonicalDigest("something else") });
      expect(() => assertReviewedRealDiff(context(), stale)).toThrow(ReviewContractError);
      try {
        assertReviewedRealDiff(context(), stale);
      } catch (error) {
        expect((error as Error).message).toBe(REVIEW_DIFF_MISMATCH);
      }
    });

    it("refuses a report against a different tree", () => {
      const stale = report([finding()], { tree_digest: `sha256:${"9".repeat(64)}` });
      expect(() => assertReviewedRealDiff(context(), stale)).toThrow(ReviewContractError);
    });

    it("marks the implementer's summary untrusted and excludes it from the digest", () => {
      const honest = context({ claimedSummary: "Tightened the role comparison." });
      const lying = context({ claimedSummary: "No functional change; comment only." });

      expect(honest.claimed_summary.trust).toBe("UNTRUSTED_DATA");
      // The digest is computed from the DIFF, so a different story about the same
      // change cannot make a report validate against it.
      expect(lying.diff_digest).toBe(honest.diff_digest);
    });
  });

  describe("conflicting reviews merge deterministically", () => {
    it("keeps the HIGHER severity when two reviewers disagree on one line", () => {
      const strict = report(
        [finding({ finding_id: "f-strict", severity: ReviewSeverity.BLOCKER })],
        {
          report_id: "r-strict",
          reviewer_id: "strict",
        },
      );
      const lenient = report([finding({ finding_id: "f-lenient", severity: ReviewSeverity.NIT })], {
        report_id: "r-lenient",
        reviewer_id: "lenient",
      });

      // Same file and line, so one observation. A lenient reviewer must not be able
      // to silence a stricter one.
      for (const order of [
        [strict, lenient],
        [lenient, strict],
      ]) {
        const merged = mergeReviewReports(order);
        expect(merged).toHaveLength(1);
        expect(merged[0]?.severity).toBe(ReviewSeverity.BLOCKER);
      }
    });

    it("deduplicates exact finding projections but keeps different fixes on one line", () => {
      const first = finding({ finding_id: "f-first" });
      const exactDuplicate = finding({ finding_id: "f-duplicate" });
      const independent = finding({
        finding_id: "f-independent",
        required_fix: "Emit the audit event before returning from this branch.",
      });
      const merged = mergeReviewReports([
        report([first, independent], { report_id: "r-first" }),
        report([exactDuplicate], { report_id: "r-duplicate" }),
      ]);
      const reversed = mergeReviewReports([
        report([exactDuplicate], { report_id: "r-duplicate" }),
        report([first, independent], { report_id: "r-first" }),
      ]);
      expect(merged).toHaveLength(2);
      expect(reversed.map((item) => item.finding_id)).toEqual(
        merged.map((item) => item.finding_id),
      );
      expect(merged.map((item) => item.required_fix)).toEqual(
        expect.arrayContaining([first.required_fix, independent.required_fix]),
      );
    });

    it("is order-independent for parallel reviewers", () => {
      const a = report(
        [finding({ finding_id: "fa", location: { relative_path: "a.ts", line: 1 } })],
        {
          report_id: "ra",
        },
      );
      const b = report(
        [finding({ finding_id: "fb", location: { relative_path: "b.ts", line: 2 } })],
        {
          report_id: "rb",
        },
      );
      expect(mergeReviewReports([a, b]).map((f) => f.finding_id)).toEqual(
        mergeReviewReports([b, a]).map((f) => f.finding_id),
      );
    });

    it("refuses to merge reports about different diffs", () => {
      const other = report([finding()], {
        report_id: "r-other",
        diff_digest: canonicalDigest("other diff"),
      });
      expect(() => mergeReviewReports([report([finding()]), other])).toThrow(ReviewContractError);
    });
  });

  describe("AC4: the fix loop is bounded and escalates", () => {
    const ctxFactory = async () => context();

    it("reaches READY when a fix resolves the blocker", async () => {
      let fixed = false;
      const result = await runReviewLoop({
        reviewers: [
          {
            reviewer_id: "r",
            review: async (ctx) =>
              reviewReport.parse({
                schema_version: 1,
                report_id: "r1",
                reviewer_id: "r",
                diff_digest: ctx.diff_digest,
                tree_digest: ctx.tree_digest,
                findings: fixed ? [] : [finding()],
                lines_examined: 6,
              }),
          },
        ],
        nextContext: ctxFactory,
        applyFix: async (findings) => {
          fixed = true;
          return findings.map((f) =>
            reviewResolution.parse({
              finding_id: f.finding_id,
              commit_sha: COMMIT,
              run_receipts: [RECEIPT],
              fixed_diff_digest: FIXED_DIFF,
            }),
          );
        },
        iterationLimit: 3,
      });

      expect(result.readiness.readiness).toBe(ReviewReadiness.READY);
      expect(result.iterations.length).toBeGreaterThanOrEqual(1);
    });

    it("ESCALATES when the iteration limit is reached with work outstanding", async () => {
      let calls = 0;
      const result = await runReviewLoop({
        reviewers: [stubReviewer("r", [finding()])],
        nextContext: ctxFactory,
        applyFix: async (findings) => {
          calls += 1;
          // Claims a fix each round, but the reviewer keeps finding it.
          return findings.map((f) =>
            reviewResolution.parse({
              finding_id: `${f.finding_id}-attempt-${String(calls)}`,
              commit_sha: COMMIT,
              run_receipts: [RECEIPT],
              fixed_diff_digest: FIXED_DIFF,
            }),
          );
        },
        iterationLimit: 2,
      });

      expect(result.readiness.readiness).toBe(ReviewReadiness.ESCALATED);
      expect(result.readiness.iterations_used).toBe(2);
      expect(result.readiness.iteration_limit).toBe(2);
      // Bounded: exactly the limit, never more.
      expect(calls).toBe(2);
    });

    it("stops immediately when a round makes no progress", async () => {
      let calls = 0;
      const result = await runReviewLoop({
        reviewers: [stubReviewer("r", [finding()])],
        nextContext: ctxFactory,
        applyFix: async () => {
          calls += 1;
          return []; // fixed nothing
        },
        iterationLimit: 5,
      });

      // A round that fixed nothing will not fix anything next round either, so the
      // remaining budget is not burned.
      expect(result.readiness.readiness).toBe(ReviewReadiness.ESCALATED);
      expect(calls).toBe(1);

      // An early exit must NOT report CHANGES_REQUIRED. That would tell the caller
      // another round is coming when the loop has stopped — the "silently
      // continues" failure in the shape of a misleading verdict. `iterations_used`
      // therefore means "no further rounds will happen", while the real count stays
      // available on `iterations`.
      expect(result.readiness.iterations_used).toBe(result.readiness.iteration_limit);
      expect(result.iterations).toHaveLength(1);
    });

    it("ESCALATES when the token budget is exhausted", async () => {
      const result = await runReviewLoop({
        reviewers: [stubReviewer("r", [finding()])],
        nextContext: ctxFactory,
        applyFix: async (findings) =>
          findings.map((f) =>
            reviewResolution.parse({
              finding_id: `${f.finding_id}-x`,
              commit_sha: COMMIT,
              run_receipts: [RECEIPT],
              fixed_diff_digest: FIXED_DIFF,
            }),
          ),
        iterationLimit: 10,
        tokenBudget: 250,
        tokensPerIteration: () => 100,
      });

      expect(result.readiness.readiness).toBe(ReviewReadiness.ESCALATED);
      // Two full rounds fit in 250; the third is refused BEFORE it runs.
      expect(result.tokensSpent).toBe(200);
    });

    it("throws rather than passing when the budget cannot fund one round", async () => {
      await expect(
        runReviewLoop({
          reviewers: [stubReviewer("r", [finding()])],
          nextContext: ctxFactory,
          applyFix: async () => [],
          iterationLimit: 3,
          tokenBudget: 10,
          tokensPerIteration: () => 100,
        }),
      ).rejects.toThrow();
    });

    it("rejects a non-positive iteration limit", async () => {
      for (const limit of [0, -1, 1.5]) {
        await expect(
          runReviewLoop({
            reviewers: [stubReviewer("r", [])],
            nextContext: ctxFactory,
            applyFix: async () => [],
            iterationLimit: limit,
          }),
        ).rejects.toThrow(RangeError);
      }
    });

    it("re-reviews the CURRENT diff each round, not the original", async () => {
      const seen: string[] = [];
      await runReviewLoop({
        reviewers: [stubReviewer("r", [finding()])],
        nextContext: async (iteration) => {
          const diff = `${DIFF_WITH_BUG}\n// round ${String(iteration)}`;
          seen.push(diff);
          return createReviewerContext({ diff, treeDigest: TREE, taskBrief: "brief" });
        },
        applyFix: async (findings) =>
          findings.map((f) =>
            reviewResolution.parse({
              finding_id: `${f.finding_id}-r`,
              commit_sha: COMMIT,
              run_receipts: [RECEIPT],
              fixed_diff_digest: FIXED_DIFF,
            }),
          ),
        iterationLimit: 2,
      });

      // Each round got a distinct, freshly-built context.
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(2);
    });

    it("does not hand dismissed findings to the writer", async () => {
      const handed: string[] = [];
      const result = await runReviewLoop({
        reviewers: [stubReviewer("r", [finding()])],
        nextContext: ctxFactory,
        judge: async (findings) =>
          findings.map((f) => ({
            finding_id: f.finding_id,
            disposition: ReviewDisposition.FALSE_POSITIVE,
            rationale: "Callers pre-validate the role, so the branch is unreachable in practice.",
          })),
        applyFix: async (findings) => {
          handed.push(...findings.map((f) => f.finding_id));
          return [];
        },
        iterationLimit: 3,
      });

      expect(handed).toEqual([]);
      expect(result.readiness.readiness).toBe(ReviewReadiness.READY);
    });
  });

  describe("export surface", () => {
    it("shares no exported name with the packages it builds on", async () => {
      const [own, contracts, evidence] = await Promise.all([
        import("../src/index.js"),
        import("@remoteagent/contracts"),
        import("@remoteagent/test-evidence"),
      ]);
      const foreign = new Set([...Object.keys(contracts), ...Object.keys(evidence)]);
      expect(Object.keys(own).filter((name) => foreign.has(name))).toEqual([]);
    });
  });
});
