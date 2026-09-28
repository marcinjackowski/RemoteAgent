import {
  canonicalDigest,
  EngineeringStage,
  engineeringLocalCommitReceipt,
  type EngineeringArtifact,
  type EngineeringLocalCommitReceipt,
} from "@remoteagent/contracts";
import type {
  EngineeringControlArtifactRevisionRow,
  EngineeringControlOperationCompletion,
} from "@remoteagent/database";
import type { EngineeringStageBinding } from "@remoteagent/agent-orchestrator";
import {
  assertLocalCommitReceiptBinding,
  assertPreparedCommitDescriptor,
  localCommitIntentDescriptor,
  localCommitProvenance,
} from "./engineering-workflow.js";
import type { GitEvidenceBoundCommitDescriptor } from "@remoteagent/git-lifecycle";

export type AcceptedLocalCommitProjection = Readonly<{
  operationId: string;
  completionId: string;
  binding: EngineeringStageBinding;
  descriptor: GitEvidenceBoundCommitDescriptor;
  commitReceipt: EngineeringLocalCommitReceipt;
  accepted: readonly Readonly<{
    sliceId: string;
    attempt: number;
    evidenceDigest: string;
    reviewDigest: string;
    commandReceiptIds: readonly string[];
  }>[];
  commandReceiptIds: readonly string[];
}>;

type CommitScope = Readonly<{
  caseId: string;
  runId: string;
  jobId: string;
}>;

function commitRow(rows: readonly EngineeringControlArtifactRevisionRow[], scope: CommitScope) {
  const matches = rows.filter(
    (row) =>
      row.payload.artifact_kind === "LocalCommitReceipt" &&
      row.case_id === scope.caseId &&
      row.run_id === scope.runId &&
      row.job_id === scope.jobId,
  );
  if (matches.length !== 1) {
    throw new Error("accepted LOCAL_COMMIT requires exactly one scoped receipt artifact");
  }
  return matches[0]!;
}

export function selectLocalCommitOperationId(
  rows: readonly EngineeringControlArtifactRevisionRow[],
  scope: CommitScope,
): string {
  return commitRow(rows, scope).operation_id;
}

function assertCompletionReceipt(
  completion: NonNullable<EngineeringControlOperationCompletion["completion"]>,
  row: EngineeringControlArtifactRevisionRow,
): void {
  if (
    typeof completion.receipt !== "object" ||
    completion.receipt === null ||
    Array.isArray(completion.receipt)
  ) {
    throw new Error("accepted LOCAL_COMMIT completion receipt is missing");
  }
  const receipt = completion.receipt as Record<string, unknown>;
  if (
    Object.keys(receipt).length !== 2 ||
    receipt.artifact_revision_id !== row.artifact_revision_id ||
    receipt.artifact_digest !== row.payload_digest
  ) {
    throw new Error("accepted LOCAL_COMMIT completion receipt does not bind its artifact");
  }
}

function exactArtifact<T extends EngineeringArtifact["artifact_kind"]>(input: {
  rows: readonly EngineeringControlArtifactRevisionRow[];
  kind: T;
  digest: string;
  attempt: number;
  scope: CommitScope;
}): Extract<EngineeringArtifact, { artifact_kind: T }> {
  const matches = input.rows.filter(
    (row) =>
      row.payload.artifact_kind === input.kind &&
      row.payload_digest === input.digest &&
      row.stage_attempt === input.attempt &&
      row.case_id === input.scope.caseId &&
      row.run_id === input.scope.runId,
  );
  if (matches.length !== 1) {
    throw new Error(`accepted LOCAL_COMMIT requires exactly one ${input.kind} provenance row`);
  }
  return matches[0]!.payload as Extract<EngineeringArtifact, { artifact_kind: T }>;
}

export function projectAcceptedLocalCommit(input: {
  rows: readonly EngineeringControlArtifactRevisionRow[];
  completion: EngineeringControlOperationCompletion | null;
  scope: CommitScope;
}): AcceptedLocalCommitProjection {
  const row = commitRow(input.rows, input.scope);
  if (input.completion === null) {
    throw new Error("accepted LOCAL_COMMIT operation completion is missing");
  }
  const { completion } = input;
  if (!completion.started) throw new Error("accepted LOCAL_COMMIT operation was not started");
  if (
    completion.operation.operation_id !== row.operation_id ||
    completion.operation.intent_id !== row.intent_id ||
    completion.operation.case_id !== row.case_id ||
    completion.operation.run_id !== row.run_id ||
    completion.operation.job_id !== row.job_id ||
    completion.operation.owner_id !== row.owner_id ||
    row.stage !== EngineeringStage.LOCAL_COMMIT ||
    completion.operation.stage !== EngineeringStage.LOCAL_COMMIT ||
    completion.operation.stage_attempt !== row.stage_attempt ||
    completion.operation.checkpoint_revision !== row.checkpoint_revision
  ) {
    throw new Error("accepted LOCAL_COMMIT operation identity does not match artifact");
  }
  if (completion.completion === null) {
    throw new Error("accepted LOCAL_COMMIT completion is missing");
  }
  if (completion.completion.outcome !== "SUCCEEDED") {
    throw new Error("accepted LOCAL_COMMIT completion is not successful");
  }
  if (!completion.completion_observed) {
    throw new Error("accepted LOCAL_COMMIT completion was not observed");
  }
  assertCompletionReceipt(completion.completion, row);

  const intent = localCommitIntentDescriptor.parse(completion.descriptor);
  if (canonicalDigest(intent) !== completion.operation.input_digest) {
    throw new Error("accepted LOCAL_COMMIT descriptor digest does not match operation");
  }
  const descriptor = intent.commit;
  if (
    intent.case_id !== row.case_id ||
    intent.work_unit_id !== descriptor.work_unit_id ||
    intent.run_id !== row.run_id ||
    intent.checkpoint_revision !== row.checkpoint_revision ||
    intent.stage !== EngineeringStage.LOCAL_COMMIT ||
    intent.attempt !== row.stage_attempt
  ) {
    throw new Error("accepted LOCAL_COMMIT intent does not match artifact binding");
  }
  const binding: EngineeringStageBinding = {
    caseId: row.case_id,
    workUnitId: descriptor.work_unit_id,
    runId: row.run_id,
    checkpointRevision: row.checkpoint_revision,
    stage: EngineeringStage.LOCAL_COMMIT,
    attempt: row.stage_attempt,
  };
  const provenance = localCommitProvenance(input.rows);
  const exactDescriptor = assertPreparedCommitDescriptor({
    descriptor,
    binding,
    operationId: row.operation_id,
    provenance,
  });
  const commitReceipt = engineeringLocalCommitReceipt.parse(row.payload);
  assertLocalCommitReceiptBinding({
    artifact: commitReceipt,
    binding,
    descriptor: exactDescriptor,
  });

  const accepted = provenance.accepted.map((pair) => {
    const evidence = exactArtifact({
      rows: input.rows,
      kind: "EvidenceBundle",
      digest: pair.evidenceDigest,
      attempt: pair.attempt,
      scope: input.scope,
    });
    exactArtifact({
      rows: input.rows,
      kind: "ReviewDecision",
      digest: pair.reviewDigest,
      attempt: pair.attempt,
      scope: input.scope,
    });
    return Object.freeze({
      sliceId: pair.sliceId,
      attempt: pair.attempt,
      evidenceDigest: pair.evidenceDigest,
      reviewDigest: pair.reviewDigest,
      commandReceiptIds: Object.freeze([...evidence.command_receipts]),
    });
  });
  const verificationRows = input.rows.filter(
    (candidate) =>
      candidate.payload.artifact_kind === "VerificationDecision" &&
      candidate.payload_digest === provenance.finalVerificationDigest &&
      candidate.case_id === input.scope.caseId &&
      candidate.run_id === input.scope.runId,
  );
  if (
    verificationRows.length !== 1 ||
    verificationRows[0]!.payload.artifact_kind !== "VerificationDecision" ||
    verificationRows[0]!.payload.decision !== "VERIFIED"
  ) {
    throw new Error("accepted LOCAL_COMMIT requires exactly one VERIFIED final decision");
  }
  const commandReceiptIds = Object.freeze([
    ...new Set(accepted.flatMap((pair) => pair.commandReceiptIds)),
  ]);
  return Object.freeze({
    operationId: row.operation_id,
    completionId: completion.completion.completion_id,
    binding,
    descriptor: exactDescriptor,
    commitReceipt,
    accepted: Object.freeze(accepted),
    commandReceiptIds,
  });
}
