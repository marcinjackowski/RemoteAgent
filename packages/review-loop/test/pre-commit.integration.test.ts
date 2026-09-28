import {
  TrustLevel,
  canonicalDigest,
  engineeringEvidenceBundle,
  type EngineeringEvidenceBundle,
} from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";
import * as z from "zod";

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
    extraSummary?: string;
    extraRequiredFix?: string;
    extraRequiredFixPaths?: readonly string[];
    extraFirst?: boolean;
    relativePath?: string;
    line?: number;
    requiredFixPaths?: readonly string[];
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
      expect(Array.isArray(request.changed_line_ranges)).toBe(true);
      if (
        request.patch === PATCH &&
        request.slice_scope.allowed_paths.some(
          (root) => root === "src/auth.ts" || "src/auth.ts".startsWith(`${root}/`),
        )
      ) {
        expect(request.changed_line_ranges).toEqual([
          { relative_path: "src/auth.ts", start_line: 1, end_line: 1 },
        ]);
      }
      const primaryFinding = {
        severity: input.severity,
        summary: input.summary ?? "Authorization was widened by this exact line.",
        location: {
          relative_path: input.relativePath ?? "src/auth.ts",
          line: input.line ?? 1,
        },
        evidence: input.evidence ?? "export const allowed = true;",
        required_fix: "Restore the denied authorization default.",
        required_fix_paths: input.requiredFixPaths ?? [input.relativePath ?? "src/auth.ts"],
      };
      const extraFinding =
        input.extraSummary === undefined
          ? undefined
          : {
              severity: input.severity,
              summary: input.extraSummary,
              location: {
                relative_path: input.relativePath ?? "src/auth.ts",
                line: input.line ?? 1,
              },
              evidence: input.evidence ?? "export const allowed = true;",
              required_fix: input.extraRequiredFix ?? "Apply the independent authorization fix.",
              required_fix_paths: input.extraRequiredFixPaths ??
                input.requiredFixPaths ?? [input.relativePath ?? "src/auth.ts"],
            };
      return {
        output: preCommitReviewOutput.parse({
          schema_version: 1,
          findings:
            input.severity === undefined || input.severity === null
              ? []
              : input.extraFirst && extraFinding !== undefined
                ? [extraFinding, primaryFinding]
                : [primaryFinding, ...(extraFinding === undefined ? [] : [extraFinding])],
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
    actual?: PreCommitActualObservation;
    observed?: () => Promise<PreCommitActualObservation>;
    evidence?: EngineeringEvidenceBundle;
    expectedEvidenceDigest?: string;
    previousBlockingRawPatchDigest?: string;
    sliceAllowedPaths?: readonly string[];
    generatorPaths?: readonly string[];
  } = {},
) {
  const reviewer = options.reviewer ?? session();
  const actual = options.actual ?? observation();
  const evidence =
    options.evidence ?? bundle({ tree_digest: actual.treeDigest, diff_digest: actual.diffDigest });
  return executeFreshPreCommitReview({
    binding,
    taskBrief: "Keep authorization closed by default.",
    sliceScope: {
      slice_id: binding.sliceId,
      objective: "keep the current authorization helper closed by default",
      observable_result: "the focused denial test passes",
      allowed_paths: options.sliceAllowedPaths ?? ["src/auth.test.ts", "src/auth.ts"],
      test_paths: ["src/auth.test.ts"],
      code_owned_generator_paths: options.generatorPaths ?? [],
      inspection_method: "focused test",
      stop_condition: "review finds no current-slice defect",
    },
    actual,
    evidenceBundle: evidence,
    expectedEvidenceBundleDigest: options.expectedEvidenceDigest ?? canonicalDigest(evidence),
    ...(options.previousBlockingRawPatchDigest === undefined
      ? {}
      : { previousBlockingRawPatchDigest: options.previousBlockingRawPatchDigest }),
    observeActual: options.observed ?? (async () => actual),
    createSession: async () => reviewer,
  });
}

describe("fresh pre-commit review boundary", () => {
  it("requires typed correction paths in the provider schema without a default", () => {
    const schema = z.toJSONSchema(preCommitReviewOutput, { io: "input" }) as unknown as {
      properties: {
        findings: { items: { properties: Record<string, unknown>; required: string[] } };
      };
    };
    expect(schema.properties.findings.items.required).toContain("required_fix_paths");
    expect(schema.properties.findings.items.properties.required_fix_paths).not.toHaveProperty(
      "default",
    );
  });

  it("does not turn a code-owned generator output into model correction authority", async () => {
    const patch = `diff --git a/src/generated.ts b/src/generated.ts
--- a/src/generated.ts
+++ b/src/generated.ts
@@ -1 +1,2 @@
 export const generated = true;
+export const help = "help";
`;
    const actual = {
      patch,
      diffDigest: canonicalDigest({ patch, files_changed: 1 }),
      treeDigest: TREE,
    };
    const evidence = bundle({
      tree_digest: actual.treeDigest,
      diff_digest: actual.diffDigest,
    });
    const result = await executeFreshPreCommitReview({
      binding,
      taskBrief: "consume exact generated output",
      sliceScope: {
        slice_id: binding.sliceId,
        objective: "consume the generated help accessor",
        observable_result: "the caller renders the generated asset",
        allowed_paths: ["src/generated.ts"],
        test_paths: [],
        code_owned_generator_paths: ["src/generated.ts"],
        inspection_method: "inspect caller and compile",
        stop_condition: "compile passes",
      },
      actual,
      evidenceBundle: evidence,
      expectedEvidenceBundleDigest: canonicalDigest(evidence),
      observeActual: async () => actual,
      createSession: async () =>
        session({
          severity: ReviewSeverity.BLOCKER,
          relativePath: "src/generated.ts",
          line: 2,
          evidence: 'export const help = "help";',
          summary: "Generated output was changed.",
        }),
    });

    expect(result.readiness).toBe(ReviewReadiness.READY);
    expect(result.blockingFindingIds).toEqual([]);
    expect(result.findings).toMatchObject([{ severity: ReviewSeverity.LOW, required_fix: "" }]);
  });

  it("groups code-owned exact changed-line coordinates and excludes context lines", async () => {
    const patch = `diff --git a/src/flow.swift b/src/flow.swift
--- a/src/flow.swift
+++ b/src/flow.swift
@@ -8,3 +8,7 @@
 context
+let first = true
+let second = true
 context
+let fourth = true
`;
    const actual = {
      patch,
      diffDigest: canonicalDigest({ patch, files_changed: 1 }),
      treeDigest: TREE,
    };
    const evidence = bundle({ tree_digest: actual.treeDigest, diff_digest: actual.diffDigest });
    let ranges: unknown;
    await executeFreshPreCommitReview({
      binding,
      taskBrief: "review exact flow wiring",
      sliceScope: {
        slice_id: binding.sliceId,
        objective: "wire the flow",
        observable_result: "the flow is reachable",
        allowed_paths: ["src"],
        test_paths: [],
        code_owned_generator_paths: [],
        inspection_method: "inspect",
        stop_condition: "pass",
      },
      actual,
      evidenceBundle: evidence,
      expectedEvidenceBundleDigest: canonicalDigest(evidence),
      observeActual: async () => actual,
      createSession: async () => ({
        ...session(),
        review: async (request) => {
          ranges = request.changed_line_ranges;
          return { output: { schema_version: 1, findings: [], lines_examined: 7 }, modelCalls: 1 };
        },
      }),
    });

    expect(ranges).toEqual([
      { relative_path: "src/flow.swift", start_line: 9, end_line: 10 },
      { relative_path: "src/flow.swift", start_line: 12, end_line: 12 },
    ]);
  });

  it("rejects foreign code-owned generator provenance before opening a reviewer session", async () => {
    let opened = 0;
    await expect(
      executeFreshPreCommitReview({
        binding,
        taskBrief: "review exact patch",
        sliceScope: {
          slice_id: binding.sliceId,
          objective: "bounded change",
          observable_result: "focused behavior",
          allowed_paths: ["src/auth.ts"],
          test_paths: [],
          code_owned_generator_paths: ["src/generated.ts"],
          inspection_method: "inspect",
          stop_condition: "pass",
        },
        actual: observation(),
        evidenceBundle: bundle(),
        expectedEvidenceBundleDigest: canonicalDigest(bundle()),
        observeActual: async () => observation(),
        createSession: async () => {
          opened += 1;
          return session();
        },
      }),
    ).rejects.toThrow(/generator paths.*within slice scope/);
    expect(opened).toBe(0);
  });

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
    const ids = new Set<string>();
    for (const severity of [ReviewSeverity.BLOCKER, ReviewSeverity.HIGH, ReviewSeverity.MEDIUM]) {
      const result = await execute({
        reviewer: session({ severity, summary: `Finding ${severity} is real.` }),
      });
      expect(result.readiness).toBe(ReviewReadiness.CHANGES_REQUIRED);
      expect(result.blockingFindingIds).toHaveLength(1);
      ids.add(result.blockingFindingIds[0]!);
      expect(result.blockingFindingIds[0]).not.toMatch(/blocker|high|medium|real/iu);
    }
    expect(ids).toHaveLength(3);
  });

  it("keeps independent same-line fixes separate and exact duplicates stable", async () => {
    const findings = {
      severity: ReviewSeverity.HIGH,
      summary: "The authorization default is too permissive.",
      extraSummary: "The changed branch skips the required audit event.",
      extraRequiredFix: "Restore the audit event on this branch.",
    } as const;
    const result = await execute({ reviewer: session(findings) });
    const reversed = await execute({ reviewer: session({ ...findings, extraFirst: true }) });
    expect(result.findings).toHaveLength(2);
    expect(new Set(result.findings.map((finding) => finding.finding_id))).toHaveLength(2);
    expect(reversed.findings.map((finding) => finding.finding_id)).toEqual(
      result.findings.map((finding) => finding.finding_id),
    );

    const duplicate = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        summary: "The authorization default is too permissive.",
        extraSummary: "The authorization default is too permissive.",
        extraRequiredFix: "Restore the denied authorization default.",
      }),
    });
    expect(duplicate.findings).toHaveLength(1);
  });

  it("server-anchors an absence finding to its exact changed line", async () => {
    const result = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        evidence: "a paraphrase that is not present in the patch",
      }),
    });

    expect(result.readiness).toBe(ReviewReadiness.CHANGES_REQUIRED);
    expect(result.blockingFindingIds).toHaveLength(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: ReviewSeverity.HIGH,
        evidence: "+export const allowed = true;",
      }),
    ]);
  });

  it("downgrades blocking findings outside server-observed changed lines", async () => {
    for (const location of [
      { relativePath: "src/auth.ts", line: 2 },
      { relativePath: "src/foreign.ts", line: 1 },
    ]) {
      const result = await execute({
        reviewer: session({
          severity: ReviewSeverity.HIGH,
          evidence: "export const allowed = true;",
          ...location,
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
    }
  });

  it("does not let an earlier slice path authorize a blocking correction", async () => {
    const result = await executeFreshPreCommitReview({
      binding,
      taskBrief: "finish the current release-note slice",
      sliceScope: {
        slice_id: binding.sliceId,
        objective: "add the release note",
        observable_result: "the note names the shipped behavior",
        allowed_paths: ["docs/release.md"],
        test_paths: [],
        code_owned_generator_paths: [],
        inspection_method: "inspect the current note",
        stop_condition: "the current-slice note is complete",
      },
      actual: observation(),
      evidenceBundle: bundle(),
      expectedEvidenceBundleDigest: canonicalDigest(bundle()),
      observeActual: async () => observation(),
      createSession: async () =>
        session({
          severity: ReviewSeverity.BLOCKER,
          relativePath: "src/auth.ts",
          line: 1,
          summary: "An earlier slice still needs unrelated production wiring.",
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

  it("reanchors a short changed-line location to the nearest substantive changed line", async () => {
    const patch = `diff --git a/src/view.swift b/src/view.swift
new file mode 100644
--- /dev/null
+++ b/src/view.swift
@@ -0,0 +1,2 @@
+let closeAction = dismissSafetyAlert
+}
`;
    const result = await execute({
      actual: {
        patch,
        diffDigest: canonicalDigest({ patch, files_changed: 1 }),
        treeDigest: TREE,
      },
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        relativePath: "src/view.swift",
        line: 2,
        evidence: "The closing brace omits the required action wiring.",
      }),
      sliceAllowedPaths: ["src/view.swift"],
    });

    expect(result.readiness).toBe(ReviewReadiness.CHANGES_REQUIRED);
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: ReviewSeverity.HIGH,
        location: { relative_path: "src/view.swift", line: 1 },
        evidence: "+let closeAction = dismissSafetyAlert",
      }),
    ]);
  });

  it("downgrades a blocking finding when its changed file has no substantive anchor", async () => {
    const patch = `diff --git a/src/empty.swift b/src/empty.swift
new file mode 100644
--- /dev/null
+++ b/src/empty.swift
@@ -0,0 +1,1 @@
+}
`;
    const result = await execute({
      actual: {
        patch,
        diffDigest: canonicalDigest({ patch, files_changed: 1 }),
        treeDigest: TREE,
      },
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        relativePath: "src/empty.swift",
        line: 1,
        evidence: "The file contains no usable implementation behavior.",
      }),
    });

    expect(result.readiness).toBe(ReviewReadiness.READY);
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
      sliceScope: {
        slice_id: binding.sliceId,
        objective: "keep the current authorization helper closed by default",
        observable_result: "the focused denial test passes",
        allowed_paths: ["src"],
        test_paths: ["src/auth.test.ts"],
        code_owned_generator_paths: [],
        inspection_method: "focused test",
        stop_condition: "review finds no current-slice defect",
      },
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

  it("returns only server-validated in-scope required mutation paths", async () => {
    const valid = await execute({
      reviewer: session({ severity: ReviewSeverity.HIGH, relativePath: "src/auth.ts" }),
      sliceAllowedPaths: ["src/auth.test.ts", "src/auth.ts"],
    });
    expect(valid.requiredMutationPaths).toEqual(["src/auth.ts"]);

    const merged = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        summary: "Same blocking finding summary.",
        extraSummary: "Same blocking finding summary.",
        evidence: "export const allowed = true;",
        extraRequiredFix: "Restore the denied authorization default.",
        requiredFixPaths: ["src/auth.ts"],
        extraRequiredFixPaths: ["src/auth.test.ts"],
      }),
    });
    expect(merged.requiredMutationPaths).toEqual(["src/auth.test.ts", "src/auth.ts"]);
  });

  it("downgrades a blocking finding with a foreign or generated target", async () => {
    const result = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        relativePath: "src/auth.ts",
        requiredFixPaths: ["src/generated.ts", "foreign.ts"],
      }),
      sliceAllowedPaths: ["foreign.ts", "src/generated.ts", "src/auth.ts"],
      generatorPaths: ["src/generated.ts"],
    });
    expect(result.readiness).toBe(ReviewReadiness.READY);
    expect(result.requiredMutationPaths).toEqual([]);
  });

  it("rejects directory targets while accepting exact unchanged leaf paths", async () => {
    const exact = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        requiredFixPaths: ["src/auth.ts", "src/auth.ts", "src/auth.test.ts"],
      }),
      sliceAllowedPaths: ["src/auth.test.ts", "src/auth.ts"],
    });
    expect(exact.requiredMutationPaths).toEqual(["src/auth.test.ts", "src/auth.ts"]);

    const directory = await execute({
      reviewer: session({ severity: ReviewSeverity.HIGH, requiredFixPaths: ["src"] }),
      sliceAllowedPaths: ["src", "src/auth.ts"],
    });
    expect(directory.readiness).toBe(ReviewReadiness.READY);
    expect(directory.requiredMutationPaths).toEqual([]);
  });

  it("downgrades a foreign target outside the slice allowlist", async () => {
    const result = await execute({
      reviewer: session({
        severity: ReviewSeverity.HIGH,
        requiredFixPaths: ["foreign/WhatToTest.txt"],
      }),
      sliceAllowedPaths: ["src/auth.ts"],
    });
    expect(result.readiness).toBe(ReviewReadiness.READY);
    expect(result.requiredMutationPaths).toEqual([]);
  });
});
