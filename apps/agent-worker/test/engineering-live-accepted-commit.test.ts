import { describe, expect, it } from "vitest";

import {
  canonicalDigest,
  engineeringArtifact,
  engineeringArtifactDigest,
  engineeringContextManifest,
  EngineeringStage,
  TrustLevel,
  type EngineeringArtifact,
} from "@remoteagent/contracts";
import type {
  EngineeringControlArtifactRevisionRow,
  EngineeringControlOperationCompletion,
  EngineeringControlOperationRow,
} from "@remoteagent/database";
import { gitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";

import { localCommitIntentDescriptor, localCommitProvenance } from "../src/engineering-workflow.js";
import {
  projectAcceptedLocalCommit,
  selectLocalCommitOperationId,
} from "./engineering-live-accepted-commit.js";

const digest = (label: string): string => canonicalDigest({ fixture: label });
const common = { schema_version: 1, case_id: "case-1", run_id: "run-1", revision: 0 };
const scope = { caseId: "case-1", runId: "run-1", jobId: "job-1" } as const;

const artifact = (input: Record<string, unknown>): EngineeringArtifact =>
  engineeringArtifact.parse({ ...common, ...input });

function makeFixture(): {
  rows: readonly EngineeringControlArtifactRevisionRow[];
  completion: EngineeringControlOperationCompletion;
} {
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
  const evidence = (label: string, receipts: readonly string[]): EngineeringArtifact =>
    artifact({
      artifact_kind: "EvidenceBundle",
      authority: "SERVER_OWNED",
      tree_digest: digest(`tree-${label}`),
      config_digests: [digest("config")],
      command_receipts: receipts,
      diff_digest: digest(`diff-${label}`),
      review_findings: [],
      decisions: [],
      items: [
        {
          kind: "gate-1",
          digest: digest(`item-${label}`),
          summary: "gate evidence",
          trust: TrustLevel.TRUSTED,
        },
      ],
      context_digest: digest(`context-${label}`),
      test_first_evidence:
        label === "accepted"
          ? [
              {
                gate_id: "gate-1",
                baseline_tree_digest: digest("baseline-tree"),
                current_tree_digest: digest(`tree-${label}`),
                baseline_outcome: "FAILED",
                current_outcome: "PASSED",
                receipt_ids: ["baseline-failed", "current-passed"],
              },
            ]
          : [],
    });
  const review = (label: string, decision: "PASS" | "CHANGES_REQUIRED"): EngineeringArtifact =>
    artifact({
      artifact_kind: "ReviewDecision",
      decision_id: `review-${label}`,
      rationale: decision === "PASS" ? "accepted" : "correction required",
      decision,
      findings: decision === "PASS" ? [] : ["correction"],
      reviewed_digest: digest(`reviewed-${label}`),
    });
  const verification = artifact({
    artifact_kind: "VerificationDecision",
    decision_id: "verification-1",
    rationale: "verified",
    decision: "VERIFIED",
    criterion_outcomes: [
      { criterion_id: "criterion-1", status: "PASSED", evidence_digest: digest("criterion") },
    ],
    evidence_digest: digest("verification-evidence"),
  });
  const rowsFor = [
    {
      payload: slice("slice-1"),
      stage: EngineeringStage.SLICE_PLANNING,
      attempt: 1,
      operationId: "op-slice-1",
    },
    {
      payload: evidence("old", ["old-completion"]),
      stage: EngineeringStage.GATE_EXECUTION,
      attempt: 1,
      operationId: "op-gate-old",
    },
    {
      payload: review("old", "CHANGES_REQUIRED"),
      stage: EngineeringStage.SLICE_REVIEW,
      attempt: 1,
      operationId: "op-review-old",
    },
    {
      payload: slice("slice-1"),
      stage: EngineeringStage.SLICE_PLANNING,
      attempt: 2,
      operationId: "op-slice-2",
    },
    {
      payload: evidence("accepted", ["baseline-failed", "current-passed"]),
      stage: EngineeringStage.GATE_EXECUTION,
      attempt: 2,
      operationId: "op-gate-accepted",
    },
    {
      payload: review("accepted", "PASS"),
      stage: EngineeringStage.SLICE_REVIEW,
      attempt: 2,
      operationId: "op-review-accepted",
    },
    {
      payload: verification,
      stage: EngineeringStage.FINAL_VERIFICATION,
      attempt: 1,
      operationId: "op-verification",
    },
  ];
  let rows: EngineeringControlArtifactRevisionRow[] = rowsFor.map((item, index) => ({
    artifact_revision_id: `artifact-${index + 1}`,
    artifact_key: `${item.stage.toLowerCase()}:${item.attempt}`,
    revision: 0,
    artifact_kind: item.payload.artifact_kind,
    payload: item.payload,
    payload_digest: engineeringArtifactDigest(item.payload),
    operation_id: item.operationId,
    intent_id: `intent-${index + 1}`,
    job_id: "job-1",
    case_id: "case-1",
    owner_id: "owner-1",
    run_id: "run-1",
    stage: item.stage,
    stage_attempt: item.attempt,
    checkpoint_revision: 0,
    recorded_at: new Date(`2026-01-01T00:00:${String(index + 1).padStart(2, "0")}Z`),
  }));
  const provenance = localCommitProvenance(rows);
  const contextManifest = engineeringContextManifest.parse({
    schema_version: 1,
    artifact_kind: "ContextManifest",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    authority: "SERVER_OWNED",
    sources: [
      {
        source_id: "source-1",
        kind: "RAW_EVIDENCE",
        ref: "source-1",
        revision: 0,
        observed_at: "2026-01-01T00:00:00.000Z",
        digest: digest("source"),
        trust: TrustLevel.UNTRUSTED_DATA,
        freshness: "pinned",
        inclusion_reason: "test fixture",
        byte_budget: 64,
        full_artifact_ref: "source-1",
      },
    ],
    total_byte_budget: 128,
  });
  const operationId = "op-commit";
  const accepted = provenance.accepted.map((pair) => ({
    slice_id: pair.sliceId,
    attempt: pair.attempt,
    evidence_digest: pair.evidenceDigest,
    review_digest: pair.reviewDigest,
  }));
  const commit = gitEvidenceBoundCommitDescriptor.parse({
    schema_version: 1,
    operation_id: operationId,
    case_id: "case-1",
    work_unit_id: "work-unit-1",
    workspace_id: "workspace-1",
    repository_id: "repository-1",
    run_id: "run-1",
    checkpoint_revision: 0,
    branch_name: "engineering/case-1",
    expected_parent_sha: "0".repeat(40),
    exact_paths: ["apps/agent-worker/src/engineering-workflow.ts"],
    message: "accepted\n\n[remoteagent-operation:op-commit]",
    operation_marker: "[remoteagent-operation:op-commit]",
    tree_digest: provenance.finalTreeDigest,
    actual_diff_digest: provenance.finalActualDiffDigest,
    raw_patch_digest: provenance.finalRawPatchDigest,
    accepted,
    evidence_digest: canonicalDigest(accepted.map((pair) => pair.evidence_digest)),
    review_digest: canonicalDigest(accepted.map((pair) => pair.review_digest)),
    final_verification_digest: provenance.finalVerificationDigest,
  });
  const descriptor = localCommitIntentDescriptor.parse({
    case_id: "case-1",
    work_unit_id: "work-unit-1",
    run_id: "run-1",
    checkpoint_revision: 0,
    stage: EngineeringStage.LOCAL_COMMIT,
    attempt: 1,
    process_class: "SMALL",
    context_snapshot_digest: digest("snapshot"),
    context_manifest: contextManifest,
    context_manifest_digest: engineeringArtifactDigest(contextManifest),
    context_packet_digest: digest("packet"),
    commit,
  });
  const commitPayload = artifact({
    artifact_kind: "LocalCommitReceipt",
    authority: "SERVER_OWNED",
    receipt_id: "commit-receipt-1",
    branch: commit.branch_name,
    commit_sha: "1".repeat(40),
    parent_sha: commit.expected_parent_sha,
    tree_digest: commit.tree_digest,
    diff_digest: commit.actual_diff_digest,
    evidence_digest: commit.evidence_digest,
    review_digest: commit.review_digest,
    verification_decision_digest: commit.final_verification_digest,
  });
  rows = [
    ...rows,
    {
      artifact_revision_id: "artifact-commit",
      artifact_key: "local_commit:1",
      revision: 0,
      artifact_kind: commitPayload.artifact_kind,
      payload: commitPayload,
      payload_digest: engineeringArtifactDigest(commitPayload),
      operation_id: operationId,
      intent_id: "intent-commit",
      job_id: "job-1",
      case_id: "case-1",
      owner_id: "owner-1",
      run_id: "run-1",
      stage: EngineeringStage.LOCAL_COMMIT,
      stage_attempt: 1,
      checkpoint_revision: 0,
      recorded_at: new Date("2026-01-01T00:01:00.000Z"),
    },
  ];
  const operation: EngineeringControlOperationRow = {
    operation_id: operationId,
    intent_id: "intent-commit",
    idempotency_key: "idempotency-commit",
    job_id: "job-1",
    case_id: "case-1",
    owner_id: "owner-1",
    run_id: "run-1",
    stage: EngineeringStage.LOCAL_COMMIT,
    stage_attempt: 1,
    checkpoint_revision: 0,
    operation_kind: "engineering.local-commit",
    effect_class: "MUTATING_SIDE_EFFECT",
    integration_scope_digest: digest("scope"),
    input_digest: canonicalDigest(descriptor),
    config_digest: digest("config"),
    schema_digest: digest("schema"),
    deadline_at: new Date("2026-01-01T00:10:00.000Z"),
    recorded_at: new Date("2026-01-01T00:01:00.000Z"),
  };
  return {
    rows,
    completion: {
      operation,
      descriptor,
      started: true,
      completion: {
        completion_id: "completion-commit",
        outcome: "SUCCEEDED",
        receipt: {
          artifact_revision_id: "artifact-commit",
          artifact_digest: engineeringArtifactDigest(commitPayload),
        },
      },
      completion_observed: true,
    },
  };
}

describe("accepted local commit projection", () => {
  it("selects the durable commit operation and exact corrected evidence pair", () => {
    const fixture = makeFixture();
    expect(selectLocalCommitOperationId(fixture.rows, scope)).toBe("op-commit");
    const projection = projectAcceptedLocalCommit({ ...fixture, scope });
    expect(projection.completionId).toBe("completion-commit");
    expect(projection.accepted).toHaveLength(1);
    expect(projection.accepted[0]!.attempt).toBe(2);
    expect(projection.commandReceiptIds).toEqual(["baseline-failed", "current-passed"]);
  });

  it.each([
    ["missing completion", () => null],
    [
      "unobserved completion",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.completion,
        completion_observed: false,
      }),
    ],
    [
      "failed completion",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.completion,
        completion: { ...fixture.completion.completion!, outcome: "FAILED" as const },
      }),
    ],
    [
      "ambiguous completion",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture.completion,
        completion: { ...fixture.completion.completion!, outcome: "AMBIGUOUS" as const },
      }),
    ],
  ] as const)("rejects %s", (_label, override) => {
    const fixture = makeFixture();
    const completion = override(fixture);
    expect(() => projectAcceptedLocalCommit({ rows: fixture.rows, completion, scope })).toThrow();
  });

  it("rejects an unstarted operation and stale artifact receipt", () => {
    const fixture = makeFixture();
    expect(() =>
      projectAcceptedLocalCommit({
        rows: fixture.rows,
        completion: { ...fixture.completion, started: false },
        scope,
      }),
    ).toThrow();
    expect(() =>
      projectAcceptedLocalCommit({
        rows: fixture.rows,
        completion: { ...fixture.completion, completion: null },
        scope,
      }),
    ).toThrow();
    expect(() =>
      projectAcceptedLocalCommit({
        rows: fixture.rows,
        completion: {
          ...fixture.completion,
          completion: {
            ...fixture.completion.completion!,
            receipt: {
              artifact_revision_id: "artifact-other",
              artifact_digest: digest("stale-artifact"),
            },
          },
        },
        scope,
      }),
    ).toThrow();
  });

  it.each([
    ["case", { case_id: "case-other" }],
    ["work unit", { work_unit_id: "work-unit-other" }],
    ["run", { run_id: "run-other" }],
    ["checkpoint", { checkpoint_revision: 1 }],
    ["attempt", { attempt: 2 }],
  ] as const)("rejects outer intent %s drift", (_label, change) => {
    const fixture = makeFixture();
    const descriptor = { ...fixture.completion.descriptor, ...change };
    expect(() =>
      projectAcceptedLocalCommit({
        rows: fixture.rows,
        completion: {
          ...fixture.completion,
          descriptor,
          operation: {
            ...fixture.completion.operation,
            input_digest: canonicalDigest(descriptor),
          },
        },
        scope,
      }),
    ).toThrow();
  });

  it("rejects a schema-valid descriptor with a stale operation digest", () => {
    const fixture = makeFixture();
    const descriptor = {
      ...fixture.completion.descriptor,
      context_packet_digest: digest("tampered-packet"),
    };
    expect(() =>
      projectAcceptedLocalCommit({
        rows: fixture.rows,
        completion: { ...fixture.completion, descriptor },
        scope,
      }),
    ).toThrow();
  });

  it.each([
    [
      "duplicate commit",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture,
        rows: [...fixture.rows, fixture.rows.at(-1)!],
      }),
    ],
    [
      "duplicate evidence",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture,
        rows: [...fixture.rows, fixture.rows[4]!],
      }),
    ],
    [
      "foreign scope",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture,
        rows: fixture.rows.map((row) =>
          row.artifact_revision_id === "artifact-commit" ? { ...row, job_id: "job-other" } : row,
        ),
      }),
    ],
    [
      "missing accepted evidence",
      (fixture: ReturnType<typeof makeFixture>) => ({
        ...fixture,
        rows: fixture.rows.filter((row) => row.artifact_revision_id !== "artifact-5"),
      }),
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const fixture = makeFixture();
    expect(() => projectAcceptedLocalCommit({ ...mutate(fixture), scope })).toThrow();
  });

  it("rejects operation intent drift", () => {
    const fixture = makeFixture();
    const completion = {
      ...fixture.completion,
      operation: { ...fixture.completion.operation, intent_id: "intent-other" },
    };
    expect(() => projectAcceptedLocalCommit({ rows: fixture.rows, completion, scope })).toThrow();
  });

  it.each([
    ["owner", { owner_id: "owner-other" }],
    ["stage", { stage: EngineeringStage.GATE_EXECUTION }],
  ] as const)("rejects operation %s drift", (_label, change) => {
    const fixture = makeFixture();
    const completion = {
      ...fixture.completion,
      operation: { ...fixture.completion.operation, ...change },
    };
    expect(() => projectAcceptedLocalCommit({ rows: fixture.rows, completion, scope })).toThrow();
  });
});
