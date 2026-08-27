import {
  TrustLevel,
  canonicalDigest,
  engineeringEvidenceBundle,
  type EngineeringEvidenceBundle,
} from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  PRE_COMMIT_REVIEW_NOT_EXECUTED,
  PRE_COMMIT_REVIEW_NO_CHANGE,
  PRE_COMMIT_REVIEW_SESSION_REUSED,
  PRE_COMMIT_REVIEW_STALE,
  PRE_COMMIT_REVIEW_TOOLS_EXPOSED,
  ReviewReadiness,
  ReviewSeverity,
  executeFreshPreCommitReview,
  preCommitReviewOutput,
  type PreCommitActualObservation,
  type PreCommitReviewSession,
} from "../src/index.js";

const PATCH = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-export const allowed = false;
+export const allowed = true;
`;
const TREE = `sha256:${"a".repeat(64)}`;
const ACTUAL_DIFF = canonicalDigest({ patch: PATCH, files_changed: 1 });
const binding = {
  caseId: "case-review",
  runId: "run-review",
  checkpointRevision: 3,
  sliceId: "slice-auth",
  attempt: 2,
} as const;

function observation(
  overrides: Partial<PreCommitActualObservation> = {},
): PreCommitActualObservation {
  return { patch: PATCH, diffDigest: ACTUAL_DIFF, treeDigest: TREE, ...overrides };
}

function bundle(overrides: Partial<EngineeringEvidenceBundle> = {}): EngineeringEvidenceBundle {
  return engineeringEvidenceBundle.parse({
    schema_version: 1,
    artifact_kind: "EvidenceBundle",
    case_id: binding.caseId,
    run_id: binding.runId,
    revision: binding.checkpointRevision,
    authority: "SERVER_OWNED",
    tree_digest: TREE,
    config_digests: [`sha256:${"b".repeat(64)}`],
    command_receipts: ["receipt-review"],
    diff_digest: ACTUAL_DIFF,
    review_findings: [],
    decisions: [],
    items: [
      {
        kind: "unit",
        digest: `sha256:${"c".repeat(64)}`,
        summary: "the exact gate passed",
        trust: TrustLevel.TRUSTED,
      },
    ],
    context_digest: `sha256:${"d".repeat(64)}`,
    test_first_evidence: [],
    ...overrides,
  });
}

function session(
  input: {
    id?: string;
    severity?: ReviewSeverity | null;
    modelCalls?: number;
    tools?: readonly string[];
    linesExamined?: number;
    summary?: string;
    evidence?: string;
  } = {},
): PreCommitReviewSession {
  return Object.freeze({
    sessionId: input.id ?? `session-${Math.random().toString(16).slice(2)}`,
    toolNames: Object.freeze([...(input.tools ?? [])]),
    review: async (request) => {
      expect(Object.values(request).some((value) => typeof value === "function")).toBe(false);
      for (const forbidden of ["write", "mkdir", "command", "store", "commit"]) {
        expect(forbidden in request).toBe(false);
      }
      expect(typeof request.patch).toBe("string");
      expect(request.raw_patch_digest).toBe(canonicalDigest(request.patch));
      expect(request.raw_patch_digest).not.toBe(request.actual_diff_digest);
      return {
        output: preCommitReviewOutput.parse({
          schema_version: 1,
          findings:
            input.severity === undefined || input.severity === null
              ? []
              : [
                  {
                    severity: input.severity,
                    summary: input.summary ?? "Authorization was widened by this exact line.",
                    location: { relative_path: "src/auth.ts", line: 1 },
                    evidence: input.evidence ?? "export const allowed = true;",
                    required_fix: "Restore the denied authorization default.",
                  },
                ],
          lines_examined: input.linesExamined ?? 6,
        }),
        modelCalls: input.modelCalls ?? 1,
      };
    },
  });
}

async function execute(
  options: {
    reviewer?: PreCommitReviewSession;
    observed?: () => Promise<PreCommitActualObservation>;
    evidence?: EngineeringEvidenceBundle;
    expectedEvidenceDigest?: string;
    previousBlockingRawPatchDigest?: string;
  } = {},
) {
  const reviewer = options.reviewer ?? session();
  return executeFreshPreCommitReview({
    binding,
    taskBrief: "Keep authorization closed by default.",
    actual: observation(),
    evidenceBundle: options.evidence ?? bundle(),
    expectedEvidenceBundleDigest:
      options.expectedEvidenceDigest ?? canonicalDigest(options.evidence ?? bundle()),
    ...(options.previousBlockingRawPatchDigest === undefined
      ? {}
      : { previousBlockingRawPatchDigest: options.previousBlockingRawPatchDigest }),
    observeActual: options.observed ?? (async () => observation()),
    createSession: async () => reviewer,
  });
}

describe("fresh pre-commit review boundary", () => {
  it("binds raw patch, actual diff, tree and EvidenceBundle while passing LOW/NIT", async () => {
    for (const severity of [null, ReviewSeverity.LOW, ReviewSeverity.NIT] as const) {
      const result = await execute({ reviewer: session({ severity }) });
      expect(result.readiness).toBe(ReviewReadiness.READY);
      expect(result.blockingFindingIds).toEqual([]);
      expect(result.rawPatchDigest).toBe(canonicalDigest(PATCH));
      expect(result.actualDiffDigest).toBe(ACTUAL_DIFF);
      expect(result.evidenceBundleDigest).toBe(canonicalDigest(bundle()));
      expect(result.modelCalls).toBe(1);
    }
  });

  it("blocks BLOCKER, HIGH and MEDIUM with server-derived stable location ids", async () => {
    let stableId = "";
    for (const severity of [ReviewSeverity.BLOCKER, ReviewSeverity.HIGH, ReviewSeverity.MEDIUM]) {
      const result = await execute({
        reviewer: session({ severity, summary: `Finding ${severity} is real.` }),
      });
      expect(result.readiness).toBe(ReviewReadiness.CHANGES_REQUIRED);
      expect(result.blockingFindingIds).toHaveLength(1);
      stableId ||= result.blockingFindingIds[0]!;
      expect(result.blockingFindingIds[0]).toBe(stableId);
      expect(result.blockingFindingIds[0]).not.toMatch(/blocker|high|medium|real/iu);
    }
  });

  it("downgrades a blocking finding whose model evidence is absent from the actual patch", async () => {
    const result = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        evidence: "a paraphrase that is not present in the patch",
      }),
    });

    expect(result.readiness).toBe(ReviewReadiness.READY);
    expect(result.blockingFindingIds).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: ReviewSeverity.LOW,
        summary: "Reviewer finding was not anchored in the actual patch.",
      }),
    ]);
  });

  it("fails closed for exposed tools, reused sessions, zero calls and zero examination", async () => {
    await expect(execute({ reviewer: session({ tools: ["write"] }) })).rejects.toThrow(
      PRE_COMMIT_REVIEW_TOOLS_EXPOSED,
    );
    const hiddenWrite = { ...session(), write: () => undefined } as never;
    await expect(execute({ reviewer: hiddenWrite })).rejects.toThrow(
      PRE_COMMIT_REVIEW_TOOLS_EXPOSED,
    );
    await expect(execute({ reviewer: session({ modelCalls: 0 }) })).rejects.toThrow(
      PRE_COMMIT_REVIEW_NOT_EXECUTED,
    );
    await expect(execute({ reviewer: session({ linesExamined: 0 }) })).rejects.toThrow(
      /examined zero lines/,
    );

    const reused = session({ id: "same-session" });
    await expect(execute({ reviewer: reused })).resolves.toMatchObject({ readiness: "READY" });
    await expect(execute({ reviewer: reused })).rejects.toThrow(PRE_COMMIT_REVIEW_SESSION_REUSED);

    await expect(
      execute({ reviewer: session({ id: "same-provider-session" }) }),
    ).resolves.toMatchObject({ readiness: "READY" });
    await expect(execute({ reviewer: session({ id: "same-provider-session" }) })).rejects.toThrow(
      PRE_COMMIT_REVIEW_SESSION_REUSED,
    );
  });

  it("rejects stale pre/post observations and tampered evidence bindings", async () => {
    await expect(
      execute({ observed: async () => observation({ treeDigest: `sha256:${"e".repeat(64)}` }) }),
    ).rejects.toThrow(PRE_COMMIT_REVIEW_STALE);

    let reads = 0;
    await expect(
      execute({
        observed: async () => {
          reads += 1;
          return reads === 1
            ? observation()
            : observation({ diffDigest: `sha256:${"f".repeat(64)}` });
        },
      }),
    ).rejects.toThrow(PRE_COMMIT_REVIEW_STALE);
    expect(reads).toBe(2);

    await expect(
      execute({ evidence: bundle({ diff_digest: `sha256:${"0".repeat(64)}` }) }),
    ).rejects.toThrow(/EvidenceBundle binding mismatch/);
    await expect(
      execute({
        evidence: bundle({
          items: [
            {
              kind: "unit",
              digest: `sha256:${"c".repeat(64)}`,
              summary: "tampered gate summary",
              trust: TrustLevel.TRUSTED,
            },
          ],
        }),
        expectedEvidenceDigest: canonicalDigest(bundle()),
      }),
    ).rejects.toThrow(/EvidenceBundle binding mismatch/);
  });

  it("clears a finding only through a fresh review of changed evidence", async () => {
    const first = await execute({ reviewer: session({ severity: ReviewSeverity.MEDIUM }) });
    expect(first.readiness).toBe(ReviewReadiness.CHANGES_REQUIRED);
    await expect(
      execute({
        reviewer: session({ severity: null }),
        previousBlockingRawPatchDigest: first.rawPatchDigest,
      }),
    ).rejects.toThrow(PRE_COMMIT_REVIEW_NO_CHANGE);

    const fixedPatch = PATCH.replace("true", "false");
    const fixedActual = {
      patch: fixedPatch,
      diffDigest: canonicalDigest({ patch: fixedPatch, files_changed: 1 }),
      treeDigest: `sha256:${"9".repeat(64)}`,
    };
    const second = await executeFreshPreCommitReview({
      binding: { ...binding, attempt: 3 },
      taskBrief: "Keep authorization closed by default.",
      actual: fixedActual,
      evidenceBundle: bundle({
        tree_digest: fixedActual.treeDigest,
        diff_digest: fixedActual.diffDigest,
      }),
      expectedEvidenceBundleDigest: canonicalDigest(
        bundle({ tree_digest: fixedActual.treeDigest, diff_digest: fixedActual.diffDigest }),
      ),
      previousBlockingRawPatchDigest: first.rawPatchDigest,
      observeActual: async () => fixedActual,
      createSession: async () => session({ severity: null }),
    });
    expect(second.readiness).toBe(ReviewReadiness.READY);
    expect(second.rawPatchDigest).not.toBe(first.rawPatchDigest);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});
