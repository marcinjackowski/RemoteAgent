import { describe, expect, it } from "vitest";

import {
  canonicalDigest,
  engineeringArtifact,
  EngineeringStage,
  type EngineeringArtifact,
} from "@remoteagent/contracts";
import { gitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";
import type { EngineeringStageBinding } from "@remoteagent/agent-orchestrator";

import {
  assertLocalCommitReceiptBinding,
  assertPreparedCommitDescriptor,
  localCommitProvenance,
} from "../src/engineering-workflow.js";
import type { EngineeringControlArtifactRevisionRow } from "@remoteagent/database";

const digest = (label: string): string => canonicalDigest({ fixture: label });
const commitSha = (digit: string): string => digit.repeat(40);
const common = { schema_version: 1, case_id: "case-1", run_id: "run-1", revision: 0 };

const artifact = (input: Record<string, unknown>): EngineeringArtifact =>
  engineeringArtifact.parse({ ...common, ...input });

const row = (input: {
  readonly artifact: EngineeringArtifact;
  readonly stage: EngineeringStage;
  readonly attempt: number;
  readonly digest: string;
  readonly revision: number;
}): EngineeringControlArtifactRevisionRow => ({
  artifact_revision_id: `artifact-${input.revision}`,
  artifact_key: `${input.stage.toLowerCase()}:${input.attempt}`,
  revision: input.revision,
  artifact_kind: input.artifact.artifact_kind,
  payload: input.artifact,
  payload_digest: input.digest,
  operation_id: `operation-${input.revision}`,
  intent_id: `intent-${input.revision}`,
  job_id: `job-${input.revision}`,
  case_id: "case-1",
  owner_id: "owner-1",
  run_id: "run-1",
  stage: input.stage,
  stage_attempt: input.attempt,
  checkpoint_revision: 0,
  recorded_at: new Date(`2026-01-01T00:00:${String(input.revision).padStart(2, "0")}Z`),
});

const slice = (sliceId: string): EngineeringArtifact =>
  artifact({
    schema_version: 2,
    artifact_kind: "SliceContract",
    slice_id: sliceId,
    objective: `objective-${sliceId}`,
    observable_result: `result-${sliceId}`,
    allowed_paths: ["apps/agent-worker/src"],
    test_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
    gate_ids: ["gate-1"],
    inspection_method: "inspect durable artifacts",
    stop_condition: "receipt is durable",
  });

const evidence = (tree: string, diff: string): EngineeringArtifact =>
  artifact({
    artifact_kind: "EvidenceBundle",
    authority: "SERVER_OWNED",
    tree_digest: digest(tree),
    config_digests: [digest("c")],
    command_receipts: ["completion-baseline-failed", "completion-current-passed"],
    diff_digest: digest(diff),
    review_findings: [],
    decisions: [],
    items: [
      {
        kind: "gate-1",
        digest: digest("e"),
        summary: "durable gate evidence",
        trust: "TRUSTED",
      },
    ],
    context_digest: digest("x"),
    test_first_evidence: [
      {
        gate_id: "gate-1",
        baseline_tree_digest: digest("b"),
        current_tree_digest: digest(tree),
        baseline_outcome: "FAILED",
        current_outcome: "PASSED",
        receipt_ids: ["completion-baseline-failed", "completion-current-passed"],
      },
    ],
  });

const review = (
  reviewedDigest: string,
  decision: "PASS" | "CHANGES_REQUIRED",
): EngineeringArtifact =>
  artifact({
    artifact_kind: "ReviewDecision",
    decision_id: `review-${reviewedDigest}`,
    rationale: decision === "PASS" ? "evidence is sufficient" : "correction is required",
    decision,
    findings: decision === "PASS" ? [] : ["needs correction"],
    reviewed_digest: digest(reviewedDigest),
  });

const verification = (decision: "VERIFIED" | "FAILED" = "VERIFIED"): EngineeringArtifact =>
  artifact({
    artifact_kind: "VerificationDecision",
    decision_id: "verification-1",
    rationale: "all criteria passed",
    decision,
    criterion_outcomes: [
      {
        criterion_id: "criterion-1",
        status: decision === "VERIFIED" ? "PASSED" : "FAILED",
        evidence_digest: digest("v"),
      },
    ],
    evidence_digest: digest("v"),
  });

const acceptedRows = (): readonly EngineeringControlArtifactRevisionRow[] => [
  row({
    artifact: slice("slice-1"),
    stage: EngineeringStage.SLICE_PLANNING,
    attempt: 1,
    digest: digest("1"),
    revision: 1,
  }),
  row({
    artifact: evidence("a", "d"),
    stage: EngineeringStage.GATE_EXECUTION,
    attempt: 1,
    digest: digest("2"),
    revision: 2,
  }),
  row({
    artifact: review("3", "CHANGES_REQUIRED"),
    stage: EngineeringStage.SLICE_REVIEW,
    attempt: 1,
    digest: digest("3"),
    revision: 3,
  }),
  row({
    artifact: slice("slice-1"),
    stage: EngineeringStage.SLICE_PLANNING,
    attempt: 2,
    digest: digest("4"),
    revision: 4,
  }),
  row({
    artifact: evidence("f", "g"),
    stage: EngineeringStage.GATE_EXECUTION,
    attempt: 2,
    digest: digest("5"),
    revision: 5,
  }),
  row({
    artifact: review("8", "PASS"),
    stage: EngineeringStage.SLICE_REVIEW,
    attempt: 2,
    digest: digest("6"),
    revision: 6,
  }),
  row({
    artifact: slice("slice-2"),
    stage: EngineeringStage.SLICE_PLANNING,
    attempt: 1,
    digest: digest("7"),
    revision: 7,
  }),
  row({
    artifact: evidence("h", "i"),
    stage: EngineeringStage.GATE_EXECUTION,
    attempt: 1,
    digest: digest("8"),
    revision: 8,
  }),
  row({
    artifact: review("9", "PASS"),
    stage: EngineeringStage.SLICE_REVIEW,
    attempt: 1,
    digest: digest("9"),
    revision: 9,
  }),
  row({
    artifact: verification(),
    stage: EngineeringStage.FINAL_VERIFICATION,
    attempt: 1,
    digest: digest("a"),
    revision: 10,
  }),
];

const binding: EngineeringStageBinding = {
  caseId: "case-1",
  workUnitId: "work-unit-1",
  runId: "run-1",
  checkpointRevision: 0,
  stage: EngineeringStage.LOCAL_COMMIT,
  attempt: 1,
};

const descriptorFor = (provenance: ReturnType<typeof localCommitProvenance>) =>
  gitEvidenceBoundCommitDescriptor.parse({
    schema_version: 1,
    operation_id: "operation-commit",
    case_id: "case-1",
    work_unit_id: "work-unit-1",
    workspace_id: "workspace-1",
    repository_id: "repository-1",
    run_id: "run-1",
    checkpoint_revision: 0,
    branch_name: "engineering/case-1",
    expected_parent_sha: commitSha("0"),
    exact_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
    message: "commit accepted evidence\n\n[remoteagent-operation:operation-commit]",
    operation_marker: "[remoteagent-operation:operation-commit]",
    tree_digest: provenance.finalTreeDigest,
    actual_diff_digest: provenance.finalActualDiffDigest,
    raw_patch_digest: provenance.finalRawPatchDigest,
    accepted: provenance.accepted.map((pair) => ({
      slice_id: pair.sliceId,
      attempt: pair.attempt,
      evidence_digest: pair.evidenceDigest,
      review_digest: pair.reviewDigest,
    })),
    evidence_digest: canonicalDigest(provenance.accepted.map((pair) => pair.evidenceDigest)),
    review_digest: canonicalDigest(provenance.accepted.map((pair) => pair.reviewDigest)),
    final_verification_digest: provenance.finalVerificationDigest,
  });

describe("local commit provenance", () => {
  it("derives only exact accepted pairs across failed correction and multiple slices", () => {
    const rows = acceptedRows();
    const snapshot = structuredClone(rows);
    const provenance = localCommitProvenance(rows);
    expect(rows).toEqual(snapshot);

    expect(provenance.accepted).toEqual([
      { sliceId: "slice-1", attempt: 2, evidenceDigest: digest("5"), reviewDigest: digest("6") },
      { sliceId: "slice-2", attempt: 1, evidenceDigest: digest("8"), reviewDigest: digest("9") },
    ]);
    expect(provenance.finalTreeDigest).toBe(digest("h"));
    expect(provenance.finalActualDiffDigest).toBe(digest("i"));
    expect(provenance.finalRawPatchDigest).toBe(digest("9"));
    expect(provenance.finalVerificationDigest).toBe(digest("a"));

    const evidenceRows = rows.filter(
      (candidate) => candidate.payload.artifact_kind === "EvidenceBundle",
    );
    expect(
      evidenceRows.every(
        (candidate) =>
          candidate.payload.artifact_kind === "EvidenceBundle" &&
          candidate.payload.command_receipts.includes("completion-baseline-failed") &&
          candidate.payload.command_receipts.includes("completion-current-passed"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "no accepted review",
      acceptedRows().filter(
        (candidate) =>
          candidate.payload.artifact_kind !== "ReviewDecision" ||
          candidate.payload.decision !== "PASS",
      ),
    ],
    ["missing evidence", acceptedRows().filter((candidate) => candidate.revision !== 8)],
    ["missing final verification", acceptedRows().filter((candidate) => candidate.revision !== 10)],
    [
      "non-VERIFIED final verification",
      acceptedRows().map((candidate) =>
        candidate.revision === 10 ? { ...candidate, payload: verification("FAILED") } : candidate,
      ),
    ],
    [
      "review attempt mismatch",
      acceptedRows().map((candidate) =>
        candidate.revision === 6 ? { ...candidate, stage_attempt: 99 } : candidate,
      ),
    ],
  ] as const)("rejects %s", (_label, rows) => {
    expect(() => localCommitProvenance(rows)).toThrow();
  });

  it("validates descriptor rollups and exact local commit receipt binding", () => {
    const provenance = localCommitProvenance(acceptedRows());
    const descriptor = descriptorFor(provenance);
    expect(
      assertPreparedCommitDescriptor({
        descriptor,
        binding,
        operationId: "operation-commit",
        provenance,
      }),
    ).toEqual(descriptor);

    const receiptFor = (overrides: Record<string, unknown> = {}): EngineeringArtifact =>
      engineeringArtifact.parse({
        ...common,
        artifact_kind: "LocalCommitReceipt",
        authority: "SERVER_OWNED",
        receipt_id: "receipt-1",
        branch: descriptor.branch_name,
        commit_sha: commitSha("1"),
        parent_sha: descriptor.expected_parent_sha,
        tree_digest: descriptor.tree_digest,
        diff_digest: descriptor.actual_diff_digest,
        evidence_digest: descriptor.evidence_digest,
        review_digest: descriptor.review_digest,
        verification_decision_digest: descriptor.final_verification_digest,
        ...overrides,
      });
    const receipt = receiptFor();
    expect(() =>
      assertLocalCommitReceiptBinding({ artifact: receipt, binding, descriptor }),
    ).not.toThrow();

    const descriptorMismatches = [
      ["tree", { tree_digest: digest("descriptor-tree") }],
      ["actual diff", { actual_diff_digest: digest("descriptor-diff") }],
      ["raw patch", { raw_patch_digest: digest("descriptor-patch") }],
      ["verification", { final_verification_digest: digest("descriptor-verification") }],
      [
        "operation",
        {
          operation_id: "operation-other",
          operation_marker: "[remoteagent-operation:operation-other]",
          message: "commit accepted evidence\n\n[remoteagent-operation:operation-other]",
        },
      ],
      ["case", { case_id: "case-other" }],
      ["work unit", { work_unit_id: "work-unit-other" }],
      ["run", { run_id: "run-other" }],
      ["checkpoint", { checkpoint_revision: 1 }],
    ] as const;
    for (const [label, mismatch] of descriptorMismatches) {
      expect(
        () =>
          assertPreparedCommitDescriptor({
            descriptor: { ...descriptor, ...mismatch },
            binding,
            operationId: "operation-commit",
            provenance,
          }),
        label,
      ).toThrow("LOCAL_COMMIT descriptor does not match durable accepted provenance");
    }

    const alteredAccepted = descriptor.accepted.map((pair, index) =>
      index === 0 ? { ...pair, evidence_digest: digest("accepted-evidence") } : pair,
    );
    const descriptorWithAcceptedMismatch = gitEvidenceBoundCommitDescriptor.parse({
      ...descriptor,
      accepted: alteredAccepted,
      evidence_digest: canonicalDigest(alteredAccepted.map((pair) => pair.evidence_digest)),
    });
    expect(() =>
      assertPreparedCommitDescriptor({
        descriptor: descriptorWithAcceptedMismatch,
        binding,
        operationId: "operation-commit",
        provenance,
      }),
    ).toThrow("LOCAL_COMMIT descriptor does not match durable accepted provenance");

    const alteredReview = descriptor.accepted.map((pair, index) =>
      index === 0 ? { ...pair, review_digest: digest("accepted-review") } : pair,
    );
    const descriptorWithReviewMismatch = gitEvidenceBoundCommitDescriptor.parse({
      ...descriptor,
      accepted: alteredReview,
      review_digest: canonicalDigest(alteredReview.map((pair) => pair.review_digest)),
    });
    expect(() =>
      assertPreparedCommitDescriptor({
        descriptor: descriptorWithReviewMismatch,
        binding,
        operationId: "operation-commit",
        provenance,
      }),
    ).toThrow("LOCAL_COMMIT descriptor does not match durable accepted provenance");

    const receiptMismatches = [
      ["case", { case_id: "case-other" }],
      ["run", { run_id: "run-other" }],
      ["revision", { revision: 1 }],
      ["branch", { branch: "engineering/other" }],
      ["parent", { parent_sha: commitSha("2") }],
      ["tree", { tree_digest: digest("receipt-tree") }],
      ["diff", { diff_digest: digest("receipt-diff") }],
      ["evidence", { evidence_digest: digest("receipt-evidence") }],
      ["review", { review_digest: digest("receipt-review") }],
      ["verification", { verification_decision_digest: digest("receipt-verification") }],
    ] as const;
    for (const [label, mismatch] of receiptMismatches) {
      expect(
        () =>
          assertLocalCommitReceiptBinding({
            artifact: receiptFor(mismatch),
            binding,
            descriptor,
          }),
        label,
      ).toThrow("LOCAL_COMMIT receipt does not match durable descriptor");
    }
  });
});
