import { realpath } from "node:fs/promises";

import {
  canonicalDigest,
  engineeringArtifact,
  engineeringEvidenceBundle,
  engineeringLocalCommitReceipt,
  engineeringReviewDecision,
  engineeringSliceContract,
  engineeringSliceImplementationReceipt,
  EngineeringStage,
} from "@remoteagent/contracts";
import type {
  EngineeringControlArtifactRevisionRow,
  EngineeringControlOperationCompletion,
} from "@remoteagent/database";
import type { EngineeringStageBinding } from "@remoteagent/agent-orchestrator";
import {
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
  VerificationGateReceipt,
  verificationGateReceiptId,
  VERIFICATION_GATE_SCHEMA_DIGEST,
  testEvidence,
} from "@remoteagent/test-evidence";
import { gitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";
import { describe, expect, it } from "vitest";

import type { AcceptedLocalCommitProjection } from "./engineering-live-accepted-commit.js";
import { projectAcceptedSliceGates } from "./engineering-live-accepted-slice-gates.js";
import { deriveExpectedVerificationGateDescriptors } from "./engineering-live-accepted-gates.js";

const digest = (label: string) => canonicalDigest({ fixture: label });
function rehashRow(
  row: EngineeringControlArtifactRevisionRow,
  payload: EngineeringControlArtifactRevisionRow["payload"],
): EngineeringControlArtifactRevisionRow {
  return { ...row, payload, payload_digest: canonicalDigest(payload) };
}
const scope = {
  caseId: "case-slice-gates",
  runId: "run-slice-gates",
  jobId: "job-slice-gates",
  workspaceId: "workspace-slice-gates",
  repositoryId: "repo-slice-gates",
} as const;

async function fixture() {
  const executable = await realpath(process.execPath);
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "gate-1",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: ["-e", "process.exit(0)"],
    relative_cwd: "Tests",
    required: true,
    baseline: true,
    test_first: true,
    timeout_ms: 10_000,
    environment_profile: "HERMETIC",
    network_profile: "DENY",
    mutable_outputs: [],
  });
  const catalog = await VerificationGateCatalog.create({
    definitions: [definition],
    executable_allowlist: [executable],
  });
  const rows: EngineeringControlArtifactRevisionRow[] = [];
  const accepted: AcceptedLocalCommitProjection["accepted"] = [];
  const completionMap = new Map<string, EngineeringControlOperationCompletion>();
  for (const [index, sliceId] of ["slice-a", "slice-b"].entries()) {
    const attempt = index + 2;
    const tree = digest(`tree-${sliceId}`);
    const baseline = digest(`baseline-${sliceId}`);
    const diff = digest(`diff-${sliceId}`);
    const expected = deriveExpectedVerificationGateDescriptors({
      catalog,
      scope,
      stageAttempt: attempt,
      currentTreeDigest: tree,
      baselineTreeDigest: baseline,
    });
    const commandReceiptIds = expected.map(
      (entry) => `completion-${sliceId}-${entry.target.toLowerCase()}`,
    );
    const evidenceLabel = digest(`evidence-${sliceId}`);
    const contract = engineeringSliceContract.parse({
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: scope.caseId,
      run_id: scope.runId,
      revision: 4,
      slice_id: sliceId,
      objective: "objective",
      observable_result: "result",
      allowed_paths: ["Sources/A.swift", "Tests/A.swift"],
      test_paths: ["Tests/A.swift"],
      gate_ids: ["gate-1"],
      inspection_method: "durable evidence",
      stop_condition: "verified",
    });
    const implementation = engineeringSliceImplementationReceipt.parse({
      schema_version: 1,
      artifact_kind: "SliceImplementationReceipt",
      case_id: scope.caseId,
      run_id: scope.runId,
      revision: 4,
      authority: "SERVER_OWNED",
      receipt_id: `implementation-receipt-${sliceId}`,
      work_unit_id: "work-unit-slice-gates",
      slice_id: sliceId,
      attempt,
      workspace_id: scope.workspaceId,
      repository_id: scope.repositoryId,
      base_sha: "a".repeat(40),
      branch: "main",
      baseline: { baseline_id: `slice-baseline-${"b".repeat(64)}`, tree_digest: baseline },
      tree_digest: tree,
      diff_digest: diff,
      raw_patch_digest: digest(`patch-${sliceId}`),
      changed_paths: ["Sources/A.swift"],
      cumulative_paths: ["Sources/A.swift"],
      files_changed: 1,
      insertions: 1,
      deletions: 0,
      tool_receipt_digests: [digest(`tool-${sliceId}`)],
    });
    const failedImplementation = engineeringSliceImplementationReceipt.parse({
      ...implementation,
      receipt_id: `failed-implementation-receipt-${sliceId}`,
      attempt: 1,
      tree_digest: digest(`failed-tree-${sliceId}`),
      diff_digest: digest(`failed-diff-${sliceId}`),
    });
    const evidence = engineeringEvidenceBundle.parse({
      schema_version: 1,
      artifact_kind: "EvidenceBundle",
      case_id: scope.caseId,
      run_id: scope.runId,
      revision: 4,
      authority: "SERVER_OWNED",
      tree_digest: tree,
      config_digests: [catalog.config_digest],
      command_receipts: commandReceiptIds,
      diff_digest: diff,
      review_findings: [],
      decisions: [],
      items: [
        {
          kind: "gate-1",
          digest: evidenceLabel,
          summary: "gate evidence",
          trust: "TRUSTED",
        },
      ],
      context_digest: digest(`context-${sliceId}`),
      test_first_evidence: [],
    });
    const evidenceDigest = canonicalDigest(evidence);
    const review = engineeringReviewDecision.parse({
      schema_version: 1,
      artifact_kind: "ReviewDecision",
      case_id: scope.caseId,
      run_id: scope.runId,
      revision: 4,
      decision_id: `review-${sliceId}`,
      rationale: "reviewed",
      decision: "PASS",
      findings: [],
      required_mutation_paths: [],
      reviewed_digest: implementation.raw_patch_digest,
    });
    const reviewDigest = canonicalDigest(review);
    const row = (
      payload: ReturnType<typeof engineeringArtifact.parse>,
      stage: EngineeringStage,
      stageAttempt = attempt,
    ): EngineeringControlArtifactRevisionRow => ({
      artifact_revision_id: `artifact-${sliceId}-${stage}-${stageAttempt}`,
      artifact_key: `${sliceId}-${stage}-${stageAttempt}`,
      revision: 4,
      artifact_kind: payload.artifact_kind,
      payload,
      payload_digest: canonicalDigest(payload),
      operation_id: `operation-${sliceId}-${stage}-${stageAttempt}`,
      intent_id: `intent-${sliceId}`,
      job_id: scope.jobId,
      case_id: scope.caseId,
      owner_id: "owner",
      run_id: scope.runId,
      stage,
      stage_attempt: stageAttempt,
      checkpoint_revision: 4,
      recorded_at: new Date(0),
    });
    rows.push(
      row(contract, EngineeringStage.SLICE_PLANNING, 1),
      row(failedImplementation, EngineeringStage.SLICE_IMPLEMENTATION, 1),
      row(implementation, EngineeringStage.SLICE_IMPLEMENTATION),
      row(evidence, EngineeringStage.GATE_EXECUTION),
      row(review, EngineeringStage.SLICE_REVIEW),
    );
    accepted.push({
      sliceId,
      attempt,
      evidenceDigest,
      reviewDigest,
      commandReceiptIds,
    });
    for (const entry of expected) {
      const targetTree = entry.target === "CURRENT" ? tree : baseline;
      const outcome = entry.target === "CURRENT" ? "PASSED" : "FAILED";
      const receiptFields = {
        case_id: scope.caseId,
        workspace_id: scope.workspaceId,
        run_id: scope.runId,
        operation_id: entry.operationId,
        gate_id: entry.gateId,
        target: entry.target,
        tree_digest: targetTree,
        config_digest: catalog.config_digest,
        command_digest: catalog.commandDigest(entry.gateId),
        outcome: outcome as "PASSED" | "FAILED",
        exit_code: outcome === "PASSED" ? 0 : 1,
        signal: null,
        duration_ms: 1,
        log_artifact: {
          artifact_id: `log-${sliceId}`,
          scope: { case_id: scope.caseId, workspace_id: scope.workspaceId },
          relative_path: `logs/${sliceId}.log`,
          digest: digest(`log-${sliceId}`),
          byte_length: 0,
          complete: true,
          original_byte_length: 0,
        },
        log_digest: digest(`log-${sliceId}`),
        ...(outcome === "FAILED"
          ? {
              test_evidence: testEvidence.parse({
                kind: "XCODE_TEST_RESULT_V1",
                tool: "xcresulttool",
                schema_version: "0.1.0",
                executed_test_ids: ["Probe/Suite/testSafety"],
                executed_count: 1,
                failed_test_ids: ["Probe/Suite/testSafety"],
                expected_suite_ids: ["Probe/Suite"],
                observed_suite_ids: ["Probe/Suite"],
                result_digest: digest(`result-${sliceId}`),
              }),
            }
          : {}),
      };
      const receipt = VerificationGateReceipt.parse({
        schema_version: 1,
        ...receiptFields,
        receipt_id: verificationGateReceiptId(receiptFields),
      });
      completionMap.set(entry.operationId, {
        operation: {
          operation_id: entry.operationId,
          intent_id: `intent-gate-${sliceId}`,
          idempotency_key: `idempotency-${entry.operationId}`,
          job_id: scope.jobId,
          case_id: scope.caseId,
          owner_id: "owner",
          run_id: scope.runId,
          stage: EngineeringStage.GATE_EXECUTION,
          stage_attempt: attempt,
          checkpoint_revision: 4,
          operation_kind: "engineering.verification.gate",
          effect_class: "COMMAND",
          integration_scope_digest: digest("scope"),
          input_digest: canonicalDigest(entry.descriptor),
          config_digest: catalog.config_digest,
          schema_digest: VERIFICATION_GATE_SCHEMA_DIGEST,
          deadline_at: new Date(0),
          recorded_at: new Date(0),
        },
        descriptor: entry.descriptor,
        started: true,
        completion_observed: true,
        completion: {
          completion_id: `completion-${sliceId}-${entry.target.toLowerCase()}`,
          outcome: "SUCCEEDED",
          receipt,
        },
      });
    }
  }
  const binding: EngineeringStageBinding = {
    caseId: scope.caseId,
    workUnitId: "work-unit-slice-gates",
    runId: scope.runId,
    checkpointRevision: 4,
    stage: EngineeringStage.LOCAL_COMMIT,
    attempt: 4,
  };
  const descriptor = gitEvidenceBoundCommitDescriptor.parse({
    schema_version: 1,
    operation_id: "commit-operation",
    case_id: scope.caseId,
    work_unit_id: binding.workUnitId,
    workspace_id: scope.workspaceId,
    repository_id: scope.repositoryId,
    run_id: scope.runId,
    checkpoint_revision: 4,
    branch_name: "main",
    expected_parent_sha: "a".repeat(40),
    exact_paths: ["Sources/A.swift"],
    message: "commit\n\n[remoteagent-operation:commit-operation]",
    operation_marker: "[remoteagent-operation:commit-operation]",
    tree_digest: digest("commit-tree"),
    actual_diff_digest: digest("commit-diff"),
    raw_patch_digest: digest("commit-patch"),
    accepted: accepted.map((pair) => ({
      slice_id: pair.sliceId,
      attempt: pair.attempt,
      evidence_digest: pair.evidenceDigest,
      review_digest: pair.reviewDigest,
    })),
    evidence_digest: canonicalDigest(accepted.map((pair) => pair.evidenceDigest)),
    review_digest: canonicalDigest(accepted.map((pair) => pair.reviewDigest)),
    final_verification_digest: digest("verification"),
  });
  const commitReceipt = engineeringLocalCommitReceipt.parse({
    schema_version: 1,
    artifact_kind: "LocalCommitReceipt",
    case_id: scope.caseId,
    run_id: scope.runId,
    revision: 4,
    authority: "SERVER_OWNED",
    receipt_id: "commit-receipt",
    branch: "main",
    commit_sha: "b".repeat(40),
    parent_sha: "a".repeat(40),
    tree_digest: descriptor.tree_digest,
    diff_digest: descriptor.actual_diff_digest,
    evidence_digest: descriptor.evidence_digest,
    review_digest: descriptor.review_digest,
    verification_decision_digest: descriptor.final_verification_digest,
  });
  const acceptedCommit: AcceptedLocalCommitProjection = {
    operationId: "commit-operation",
    completionId: "commit-completion",
    binding,
    descriptor,
    commitReceipt,
    accepted,
    commandReceiptIds: accepted.flatMap((pair) => pair.commandReceiptIds),
  };
  return { rows, catalog, acceptedCommit, completionMap };
}

describe("accepted slice gate projection", () => {
  it("projects two accepted slices independently from implementation trees", async () => {
    const input = await fixture();
    const result = await projectAcceptedSliceGates({
      ...input,
      scope,
      readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
    });
    expect(result.map((slice) => slice.sliceId)).toEqual(["slice-a", "slice-b"]);
    expect(result.every((slice) => slice.gates.aggregate.status === "PASSED")).toBe(true);
  });

  it.each([
    [
      "missing completion",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({ ...input, scope, readOperationCompletion: async () => null }),
      "completion is missing",
    ],
    [
      "foreign evidence",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          rows: input.rows.map((row) =>
            row.payload.artifact_kind === "EvidenceBundle"
              ? { ...row, payload_digest: digest("foreign") }
              : row,
          ),
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "exactly one scoped evidence",
    ],
    [
      "stale accepted IDs",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          acceptedCommit: {
            ...input.acceptedCommit,
            accepted: input.acceptedCommit.accepted.map((pair) => ({
              ...pair,
              commandReceiptIds: ["stale"],
            })),
          },
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "evidence does not bind",
    ],
    [
      "foreign implementation workspace",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          rows: input.rows.map((row) =>
            row.payload.artifact_kind === "SliceImplementationReceipt"
              ? {
                  ...rehashRow(
                    row,
                    engineeringSliceImplementationReceipt.parse({
                      ...row.payload,
                      workspace_id: "foreign-workspace",
                    }),
                  ),
                }
              : row,
          ),
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "scoped implementation",
    ],
    [
      "implementation tree mismatch",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          rows: input.rows.map((row) =>
            row.payload.artifact_kind === "SliceImplementationReceipt"
              ? {
                  ...rehashRow(
                    row,
                    engineeringSliceImplementationReceipt.parse({
                      ...row.payload,
                      tree_digest: digest("foreign-tree"),
                    }),
                  ),
                }
              : row,
          ),
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "evidence does not bind",
    ],
    [
      "unknown persisted gate",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          rows: input.rows.map((row) =>
            row.payload.artifact_kind === "SliceContract"
              ? {
                  ...row,
                  payload: engineeringSliceContract.parse({
                    ...row.payload,
                    gate_ids: ["unknown-gate"],
                  }),
                  payload_digest: canonicalDigest(
                    engineeringSliceContract.parse({ ...row.payload, gate_ids: ["unknown-gate"] }),
                  ),
                }
              : row,
          ),
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "unknown or non-required gate",
    ],
    [
      "evidence before implementation",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          rows: (() => {
            const evidence = input.rows.find(
              (row) => row.payload.artifact_kind === "EvidenceBundle",
            )!;
            return [evidence, ...input.rows.filter((row) => row !== evidence)];
          })(),
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "implementation must precede evidence",
    ],
    [
      "implementation payload revision drift",
      async (input: Awaited<ReturnType<typeof fixture>>) =>
        projectAcceptedSliceGates({
          ...input,
          rows: input.rows.map((row) =>
            row.payload.artifact_kind === "SliceImplementationReceipt"
              ? {
                  ...rehashRow(
                    row,
                    engineeringSliceImplementationReceipt.parse({
                      ...row.payload,
                      revision: 99,
                    }),
                  ),
                }
              : row,
          ),
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      "scoped implementation",
    ],
  ] as const)("rejects %s", async (_label, run, message) =>
    expect(run(await fixture())).rejects.toThrow(message),
  );

  it("rejects a latest active contract for a foreign slice even when an earlier contract matches", async () => {
    const input = await fixture();
    const contractIndex = input.rows.findIndex(
      (row) => row.payload.artifact_kind === "SliceContract" && row.payload.slice_id === "slice-a",
    );
    const implementationIndex = input.rows.findIndex(
      (row) =>
        row.payload.artifact_kind === "SliceImplementationReceipt" &&
        row.payload.slice_id === "slice-a" &&
        row.payload.attempt === 2,
    );
    const original = input.rows[contractIndex]!;
    const foreignPayload = engineeringSliceContract.parse({
      ...original.payload,
      slice_id: "foreign-slice",
    });
    const foreign = rehashRow(
      { ...original, artifact_revision_id: "foreign-contract" },
      foreignPayload,
    );
    const rows = [...input.rows];
    rows.splice(implementationIndex, 0, foreign);
    await expect(
      projectAcceptedSliceGates({
        ...input,
        rows,
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("contract payload binding mismatch");
  });

  it("rejects a corrupt latest active contract instead of falling back to an earlier valid one", async () => {
    const input = await fixture();
    const contractIndex = input.rows.findIndex(
      (row) => row.payload.artifact_kind === "SliceContract" && row.payload.slice_id === "slice-a",
    );
    const implementationIndex = input.rows.findIndex(
      (row) =>
        row.payload.artifact_kind === "SliceImplementationReceipt" &&
        row.payload.slice_id === "slice-a" &&
        row.payload.attempt === 2,
    );
    const original = input.rows[contractIndex]!;
    const corrupt = {
      ...original,
      artifact_revision_id: "corrupt-contract",
      payload_digest: digest("corrupt-contract"),
    };
    const rows = [...input.rows];
    rows.splice(implementationIndex, 0, corrupt);
    await expect(
      projectAcceptedSliceGates({
        ...input,
        rows,
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("contract payload binding mismatch");
  });

  it("rejects a review that precedes its evidence bundle", async () => {
    const input = await fixture();
    const reviewIndex = input.rows.findIndex(
      (row) => row.payload_digest === input.acceptedCommit.accepted[0]!.reviewDigest,
    );
    const evidenceIndex = input.rows.findIndex(
      (row) => row.payload_digest === input.acceptedCommit.accepted[0]!.evidenceDigest,
    );
    const rows = [...input.rows];
    const [review] = rows.splice(reviewIndex, 1);
    rows.splice(evidenceIndex, 0, review!);
    await expect(
      projectAcceptedSliceGates({
        ...input,
        rows,
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("following scoped review");
  });

  it.each(["duplicate", "missing"] as const)(
    "rejects a %s accepted implementation receipt",
    async (mode) => {
      const input = await fixture();
      const index = input.rows.findIndex(
        (row) =>
          row.payload.artifact_kind === "SliceImplementationReceipt" &&
          row.payload.slice_id === "slice-a" &&
          row.payload.attempt === 2,
      );
      const rows = [...input.rows];
      if (mode === "duplicate") {
        rows.splice(index + 1, 0, {
          ...rows[index]!,
          artifact_revision_id: "duplicate-implementation",
        });
      } else {
        rows.splice(index, 1);
      }
      await expect(
        projectAcceptedSliceGates({
          ...input,
          rows,
          scope,
          readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
        }),
      ).rejects.toThrow("scoped implementation");
    },
  );

  it("rejects a reidentified evidence bundle with a foreign catalog digest", async () => {
    const input = await fixture();
    const pair = input.acceptedCommit.accepted[0]!;
    const evidenceIndex = input.rows.findIndex((row) => row.payload_digest === pair.evidenceDigest);
    const row = input.rows[evidenceIndex]!;
    const evidence = engineeringEvidenceBundle.parse({
      ...row.payload,
      config_digests: [digest("foreign-catalog")],
    });
    const evidenceDigest = canonicalDigest(evidence);
    const rows = [...input.rows];
    rows[evidenceIndex] = rehashRow(row, evidence);
    const acceptedCommit = {
      ...input.acceptedCommit,
      accepted: input.acceptedCommit.accepted.map((candidate) =>
        candidate === pair ? { ...candidate, evidenceDigest } : candidate,
      ),
    };
    await expect(
      projectAcceptedSliceGates({
        ...input,
        rows,
        acceptedCommit,
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("evidence does not bind");
  });

  it("rejects a reidentified PASS review with a foreign raw patch digest", async () => {
    const input = await fixture();
    const pair = input.acceptedCommit.accepted[0]!;
    const reviewIndex = input.rows.findIndex((row) => row.payload_digest === pair.reviewDigest);
    const row = input.rows[reviewIndex]!;
    const review = engineeringReviewDecision.parse({
      ...row.payload,
      reviewed_digest: digest("foreign-raw-patch"),
    });
    const reviewDigest = canonicalDigest(review);
    const rows = [...input.rows];
    rows[reviewIndex] = rehashRow(row, review);
    const acceptedCommit = {
      ...input.acceptedCommit,
      accepted: input.acceptedCommit.accepted.map((candidate) =>
        candidate === pair ? { ...candidate, reviewDigest } : candidate,
      ),
    };
    await expect(
      projectAcceptedSliceGates({
        ...input,
        rows,
        acceptedCommit,
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("review does not bind implementation raw patch");
  });

  it("rejects empty and duplicate accepted slice pairs", async () => {
    const input = await fixture();
    await expect(
      projectAcceptedSliceGates({
        ...input,
        acceptedCommit: { ...input.acceptedCommit, accepted: [] },
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("no accepted slice pairs");
    const first = input.acceptedCommit.accepted[0]!;
    await expect(
      projectAcceptedSliceGates({
        ...input,
        acceptedCommit: { ...input.acceptedCommit, accepted: [first, first] },
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("duplicate slice pairs");
  });

  it("rejects a foreign commit scope or branch", async () => {
    const input = await fixture();
    await expect(
      projectAcceptedSliceGates({
        ...input,
        acceptedCommit: {
          ...input.acceptedCommit,
          binding: { ...input.acceptedCommit.binding, caseId: "foreign-case" },
        },
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("binding does not match slice gate scope");
    await expect(
      projectAcceptedSliceGates({
        ...input,
        acceptedCommit: {
          ...input.acceptedCommit,
          commitReceipt: { ...input.acceptedCommit.commitReceipt, branch: "foreign" },
        },
        scope,
        readOperationCompletion: async (id) => input.completionMap.get(id) ?? null,
      }),
    ).rejects.toThrow("binding does not match slice gate scope");
  });
});
