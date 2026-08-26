import {
  canonicalJsonStringify,
  checkpointPatch,
  engineeringMemoryUpdate,
  idString,
  sha256Digest,
  TrustLevel,
  type CheckpointPatch,
} from "@remoteagent/contracts";
import { ContextOutputBoundary } from "./redaction.js";

export interface PrepareMemoryProjectionInput {
  readonly rawUpdate: unknown;
  readonly expectedCaseId: string;
  readonly expectedRunId: string;
  readonly targetCheckpointRevision: number;
  readonly expectedSourceWatermark: string;
  readonly allowedEvidenceDigests: readonly string[];
  readonly memoryArtifactRef: string;
  readonly knownSecrets: readonly string[];
}

export const MemoryProjectionErrorCode = Object.freeze({
  INVALID_INPUT: "MEMORY_PROJECTION_INVALID_INPUT",
  INVALID_UPDATE: "MEMORY_PROJECTION_INVALID_UPDATE",
  BINDING_MISMATCH: "MEMORY_PROJECTION_BINDING_MISMATCH",
  REVISION_MISMATCH: "MEMORY_PROJECTION_REVISION_MISMATCH",
  WATERMARK_MISMATCH: "MEMORY_PROJECTION_WATERMARK_MISMATCH",
  EVIDENCE_NOT_ALLOWED: "MEMORY_PROJECTION_EVIDENCE_NOT_ALLOWED",
  UNSAFE_ARTIFACT_REF: "MEMORY_PROJECTION_UNSAFE_ARTIFACT_REF",
  INVALID_OUTPUT: "MEMORY_PROJECTION_INVALID_OUTPUT",
} as const);

export type MemoryProjectionErrorCode =
  (typeof MemoryProjectionErrorCode)[keyof typeof MemoryProjectionErrorCode];

export class MemoryProjectionError extends Error {
  public constructor(
    message: string,
    public readonly code: MemoryProjectionErrorCode,
  ) {
    super(message);
    this.name = "MemoryProjectionError";
  }
}

const inputKeys = Object.freeze([
  "rawUpdate",
  "expectedCaseId",
  "expectedRunId",
  "targetCheckpointRevision",
  "expectedSourceWatermark",
  "allowedEvidenceDigests",
  "memoryArtifactRef",
  "knownSecrets",
] as const);

function parseInput(rawInput: unknown): PrepareMemoryProjectionInput | null {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return null;
  const keys = Object.keys(rawInput);
  if (keys.length !== inputKeys.length || keys.some((key) => !inputKeys.includes(key as never))) {
    return null;
  }
  const value = rawInput as Record<string, unknown>;
  const expectedCaseId = idString.safeParse(value.expectedCaseId);
  const expectedRunId = idString.safeParse(value.expectedRunId);
  const expectedSourceWatermark = sha256Digest.safeParse(value.expectedSourceWatermark);
  const memoryArtifactRef = idString.safeParse(value.memoryArtifactRef);
  if (
    !expectedCaseId.success ||
    !expectedRunId.success ||
    !expectedSourceWatermark.success ||
    !memoryArtifactRef.success ||
    expectedCaseId.data !== value.expectedCaseId ||
    expectedRunId.data !== value.expectedRunId ||
    memoryArtifactRef.data !== value.memoryArtifactRef ||
    typeof value.targetCheckpointRevision !== "number" ||
    !Number.isSafeInteger(value.targetCheckpointRevision) ||
    value.targetCheckpointRevision < 0 ||
    !Array.isArray(value.allowedEvidenceDigests) ||
    value.allowedEvidenceDigests.length > 512 ||
    value.allowedEvidenceDigests.some((digest) => !sha256Digest.safeParse(digest).success) ||
    !Array.isArray(value.knownSecrets) ||
    value.knownSecrets.length > 256 ||
    value.knownSecrets.some(
      (secret) => typeof secret !== "string" || secret.length === 0 || secret.length > 65_536,
    )
  ) {
    return null;
  }
  return {
    rawUpdate: value.rawUpdate,
    expectedCaseId: expectedCaseId.data,
    expectedRunId: expectedRunId.data,
    targetCheckpointRevision: value.targetCheckpointRevision,
    expectedSourceWatermark: expectedSourceWatermark.data,
    allowedEvidenceDigests: value.allowedEvidenceDigests as string[],
    memoryArtifactRef: memoryArtifactRef.data,
    knownSecrets: value.knownSecrets as string[],
  };
}

/**
 * Convert a model-authored MemoryUpdate into the only checkpoint fields it may
 * propose. Authority and freshness are checked against server-owned inputs;
 * content remains explicitly untrusted and cannot carry policy fields.
 */
export function prepareMemoryProjection(rawInput: unknown): CheckpointPatch {
  const parsedInput = parseInput(rawInput);
  if (parsedInput === null) {
    throw new MemoryProjectionError(
      "Invalid memory projection request",
      MemoryProjectionErrorCode.INVALID_INPUT,
    );
  }
  const input = parsedInput;
  const parsedUpdate = engineeringMemoryUpdate.safeParse(input.rawUpdate);
  if (!parsedUpdate.success) {
    throw new MemoryProjectionError(
      "Memory update does not satisfy its strict contract",
      MemoryProjectionErrorCode.INVALID_UPDATE,
    );
  }
  const update = parsedUpdate.data;
  if (update.case_id !== input.expectedCaseId || update.run_id !== input.expectedRunId) {
    throw new MemoryProjectionError(
      "Memory update is outside the expected run binding",
      MemoryProjectionErrorCode.BINDING_MISMATCH,
    );
  }
  if (update.revision !== input.targetCheckpointRevision) {
    throw new MemoryProjectionError(
      "Memory update targets an unexpected checkpoint revision",
      MemoryProjectionErrorCode.REVISION_MISMATCH,
    );
  }
  if (update.source_watermark !== input.expectedSourceWatermark) {
    throw new MemoryProjectionError(
      "Memory update source watermark does not match",
      MemoryProjectionErrorCode.WATERMARK_MISMATCH,
    );
  }
  const allowedEvidence = new Set(input.allowedEvidenceDigests);
  if (update.evidence_digests.some((digest) => !allowedEvidence.has(digest))) {
    throw new MemoryProjectionError(
      "Memory update references evidence outside the allowed snapshot",
      MemoryProjectionErrorCode.EVIDENCE_NOT_ALLOWED,
    );
  }

  const boundary = new ContextOutputBoundary(input.knownSecrets);
  try {
    boundary.assertOpaque(input.expectedCaseId, "caseId");
    boundary.assertOpaque(input.expectedRunId, "runId");
    boundary.assertOpaque(input.memoryArtifactRef, "memoryArtifactRef");
  } catch {
    throw new MemoryProjectionError(
      "Memory artifact reference must be a safe opaque identifier",
      MemoryProjectionErrorCode.UNSAFE_ARTIFACT_REF,
    );
  }
  const completedRequirements = update.completed_requirements.map((value) =>
    boundary.redactText(value),
  );
  const openIssues = update.open_issues.map((value) => boundary.redactText(value));
  const summary = canonicalJsonStringify({
    artifact_kind: "MemoryProjection",
    completed_requirements: completedRequirements,
    memory_artifact_ref: input.memoryArtifactRef,
    open_issues: openIssues,
    schema_version: 1,
    source_watermark: update.source_watermark,
  });
  const candidate = {
    summary: { trust: TrustLevel.UNTRUSTED_DATA, value: summary },
    completed_work_append: completedRequirements,
    open_questions: openIssues,
    evidence_append: [
      {
        kind: "MemoryUpdate",
        reference: input.memoryArtifactRef,
        summary: `source_watermark=${update.source_watermark}`,
      },
    ],
  };
  const patch = checkpointPatch.safeParse(candidate);
  if (!patch.success) {
    throw new MemoryProjectionError(
      "Prepared memory projection exceeds checkpoint contract limits",
      MemoryProjectionErrorCode.INVALID_OUTPUT,
    );
  }
  return patch.data;
}
