import {
  canonicalDigest,
  EngineeringStage,
  engineeringEvidenceBundle,
  engineeringReviewDecision,
  engineeringSliceContract,
  engineeringSliceImplementationReceipt,
} from "@remoteagent/contracts";
import type {
  EngineeringControlArtifactRevisionRow,
  EngineeringControlOperationCompletion,
} from "@remoteagent/database";
import {
  VerificationGateCatalog,
  type VerificationGateCatalogInput,
} from "@remoteagent/test-evidence";

import {
  deriveExpectedVerificationGateDescriptors,
  projectAcceptedVerificationGates,
  type AcceptedGateProjection,
} from "./engineering-live-accepted-gates.js";
import type { AcceptedLocalCommitProjection } from "./engineering-live-accepted-commit.js";

export type AcceptedSliceGateScope = Readonly<{
  caseId: string;
  runId: string;
  jobId: string;
  workspaceId: string;
  repositoryId: string;
}>;

export type AcceptedSliceGateProjection = Readonly<{
  sliceId: string;
  attempt: number;
  evidenceDigest: string;
  implementationReceiptDigest: string;
  commandReceiptIds: readonly string[];
  gates: AcceptedGateProjection;
}>;

function exactRow(
  rows: readonly EngineeringControlArtifactRevisionRow[],
  predicate: (row: EngineeringControlArtifactRevisionRow) => boolean,
  message: string,
): EngineeringControlArtifactRevisionRow {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error(message);
  return matches[0]!;
}

function scopedArtifactRow(
  row: EngineeringControlArtifactRevisionRow,
  scope: AcceptedSliceGateScope,
  attempt: number,
): boolean {
  return (
    row.case_id === scope.caseId &&
    row.run_id === scope.runId &&
    row.job_id === scope.jobId &&
    row.stage_attempt === attempt
  );
}

async function selectedCatalog(
  catalog: VerificationGateCatalog,
  gateIds: readonly string[],
): Promise<VerificationGateCatalog> {
  if (gateIds.length === 0 || new Set(gateIds).size !== gateIds.length) {
    throw new Error("accepted slice contract gate IDs must be unique and non-empty");
  }
  const definitions = gateIds.map((gateId) => {
    const definition = catalog.get(gateId);
    if (definition === undefined || !definition.required) {
      throw new Error("accepted slice contract references an unknown or non-required gate");
    }
    return definition;
  });
  const input: VerificationGateCatalogInput = {
    definitions,
    executable_allowlist: catalog.executable_allowlist,
  };
  return VerificationGateCatalog.create(input);
}

export async function projectAcceptedSliceGates(input: {
  rows: readonly EngineeringControlArtifactRevisionRow[];
  acceptedCommit: AcceptedLocalCommitProjection;
  catalog: VerificationGateCatalog;
  scope: AcceptedSliceGateScope;
  readOperationCompletion: (
    operationId: string,
  ) => Promise<EngineeringControlOperationCompletion | null>;
}): Promise<readonly AcceptedSliceGateProjection[]> {
  if (input.acceptedCommit.accepted.length === 0) {
    throw new Error("accepted LOCAL_COMMIT contains no accepted slice pairs");
  }
  const pairKeys = input.acceptedCommit.accepted.map((pair) => `${pair.sliceId}:${pair.attempt}`);
  if (new Set(pairKeys).size !== pairKeys.length) {
    throw new Error("accepted LOCAL_COMMIT contains duplicate slice pairs");
  }
  if (
    input.acceptedCommit.binding.caseId !== input.scope.caseId ||
    input.acceptedCommit.binding.runId !== input.scope.runId ||
    input.acceptedCommit.commitReceipt.branch !== input.acceptedCommit.descriptor.branch_name ||
    input.acceptedCommit.commitReceipt.parent_sha !==
      input.acceptedCommit.descriptor.expected_parent_sha
  ) {
    throw new Error("accepted LOCAL_COMMIT binding does not match slice gate scope");
  }
  const results: AcceptedSliceGateProjection[] = [];
  for (const pair of input.acceptedCommit.accepted) {
    const evidenceRow = exactRow(
      input.rows,
      (row) =>
        row.payload.artifact_kind === "EvidenceBundle" &&
        row.payload_digest === canonicalDigest(row.payload) &&
        row.payload_digest === pair.evidenceDigest &&
        scopedArtifactRow(row, input.scope, pair.attempt) &&
        row.stage === EngineeringStage.GATE_EXECUTION,
      "accepted slice requires exactly one scoped evidence bundle",
    );
    const evidenceIndex = input.rows.indexOf(evidenceRow);
    const implementationRow = exactRow(
      input.rows,
      (row) => {
        if (
          row.payload.artifact_kind !== "SliceImplementationReceipt" ||
          !scopedArtifactRow(row, input.scope, pair.attempt)
        )
          return false;
        const receipt = engineeringSliceImplementationReceipt.parse(row.payload);
        return (
          receipt.case_id === row.case_id &&
          receipt.run_id === row.run_id &&
          receipt.revision === row.checkpoint_revision &&
          row.payload_digest === canonicalDigest(row.payload) &&
          receipt.slice_id === pair.sliceId &&
          receipt.attempt === pair.attempt &&
          receipt.workspace_id === input.scope.workspaceId &&
          receipt.repository_id === input.scope.repositoryId &&
          receipt.work_unit_id === input.acceptedCommit.binding.workUnitId &&
          receipt.base_sha === input.acceptedCommit.commitReceipt.parent_sha &&
          receipt.branch === input.acceptedCommit.commitReceipt.branch &&
          row.stage === EngineeringStage.SLICE_IMPLEMENTATION
        );
      },
      "accepted slice requires exactly one scoped implementation receipt",
    );
    const implementationIndex = input.rows.indexOf(implementationRow);
    if (implementationIndex >= evidenceIndex) {
      throw new Error("accepted slice implementation must precede evidence");
    }
    const implementation = engineeringSliceImplementationReceipt.parse(implementationRow.payload);
    if (evidenceRow.checkpoint_revision !== implementationRow.checkpoint_revision) {
      throw new Error("accepted slice evidence checkpoint does not match implementation");
    }
    const contractRow = input.rows
      .slice(0, implementationIndex)
      .filter(
        (row) =>
          row.payload.artifact_kind === "SliceContract" &&
          row.case_id === input.scope.caseId &&
          row.run_id === input.scope.runId &&
          row.job_id === input.scope.jobId &&
          row.stage === EngineeringStage.SLICE_PLANNING,
      )
      .at(-1);
    if (contractRow === undefined) {
      throw new Error("accepted slice requires exactly one active preceding slice contract");
    }
    const contract = engineeringSliceContract.parse(contractRow.payload);
    if (
      contractRow.payload_digest !== canonicalDigest(contractRow.payload) ||
      contract.case_id !== contractRow.case_id ||
      contract.run_id !== contractRow.run_id ||
      contract.slice_id !== pair.sliceId ||
      contract.revision !== contractRow.checkpoint_revision ||
      contract.revision !== implementationRow.checkpoint_revision
    ) {
      throw new Error("accepted slice contract payload binding mismatch");
    }
    const catalog = await selectedCatalog(input.catalog, contract.gate_ids);
    const evidence = engineeringEvidenceBundle.parse(evidenceRow.payload);
    if (
      evidence.case_id !== evidenceRow.case_id ||
      evidence.run_id !== evidenceRow.run_id ||
      evidence.revision !== evidenceRow.checkpoint_revision ||
      evidence.revision !== implementationRow.checkpoint_revision
    ) {
      throw new Error("accepted slice evidence payload binding mismatch");
    }
    const reviewRow = exactRow(
      input.rows,
      (row) =>
        row.payload.artifact_kind === "ReviewDecision" &&
        row.payload_digest === canonicalDigest(row.payload) &&
        row.payload_digest === pair.reviewDigest &&
        scopedArtifactRow(row, input.scope, pair.attempt) &&
        row.stage === EngineeringStage.SLICE_REVIEW &&
        row.checkpoint_revision === evidenceRow.checkpoint_revision &&
        row.payload.case_id === evidence.case_id &&
        row.payload.run_id === evidence.run_id &&
        row.payload.revision === evidence.revision &&
        input.rows.indexOf(row) > evidenceIndex,
      "accepted slice requires exactly one following scoped review decision",
    );
    const review = engineeringReviewDecision.parse(reviewRow.payload);
    if (review.decision !== "PASS" || review.reviewed_digest !== implementation.raw_patch_digest) {
      throw new Error("accepted slice review does not bind implementation raw patch");
    }
    if (
      evidence.tree_digest !== implementation.tree_digest ||
      evidence.diff_digest !== implementation.diff_digest ||
      evidence.config_digests.length !== 1 ||
      evidence.config_digests[0] !== catalog.config_digest ||
      evidence.command_receipts.length !== pair.commandReceiptIds.length ||
      evidence.command_receipts.some((id, index) => id !== pair.commandReceiptIds[index])
    ) {
      throw new Error("accepted slice evidence does not bind implementation or gate receipts");
    }
    const expected = deriveExpectedVerificationGateDescriptors({
      catalog,
      scope: {
        caseId: input.scope.caseId,
        workspaceId: input.scope.workspaceId,
        runId: input.scope.runId,
        jobId: input.scope.jobId,
      },
      stageAttempt: pair.attempt,
      currentTreeDigest: implementation.tree_digest,
      baselineTreeDigest: implementation.baseline.tree_digest,
    });
    const completions: EngineeringControlOperationCompletion[] = [];
    for (const entry of expected) {
      const completion = await input.readOperationCompletion(entry.operationId);
      if (completion === null) {
        throw new Error("accepted slice gate operation completion is missing");
      }
      completions.push(completion);
    }
    const gates = projectAcceptedVerificationGates({
      catalog,
      scope: {
        caseId: input.scope.caseId,
        workspaceId: input.scope.workspaceId,
        runId: input.scope.runId,
        jobId: input.scope.jobId,
      },
      stageAttempt: pair.attempt,
      currentTreeDigest: implementation.tree_digest,
      baselineTreeDigest: implementation.baseline.tree_digest,
      acceptedCompletionIds: pair.commandReceiptIds,
      completions,
    });
    results.push({
      sliceId: pair.sliceId,
      attempt: pair.attempt,
      evidenceDigest: pair.evidenceDigest,
      implementationReceiptDigest: implementationRow.payload_digest,
      commandReceiptIds: pair.commandReceiptIds,
      gates,
    });
  }
  return results;
}
