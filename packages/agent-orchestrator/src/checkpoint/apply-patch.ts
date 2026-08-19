import {
  caseCheckpoint,
  checkpointPatch,
  type CaseCheckpoint,
  type CheckpointPatch,
} from "@remoteagent/contracts";
import { CheckpointPatchError, CheckpointPatchErrorCode } from "./errors.js";

export interface CheckpointPatchApplicationInput {
  readonly current: unknown;
  readonly patch: unknown;
  /** System-authored timestamp; it is never read from model patch data. */
  readonly updatedAt: unknown;
}

const appendFields = [
  ["completed_work_append", "completed_work"],
  ["assumptions_append", "assumptions"],
  ["evidence_append", "evidence"],
] as const;

export function applyCheckpointPatch(input: CheckpointPatchApplicationInput): CaseCheckpoint {
  const currentResult = caseCheckpoint.safeParse(input.current);
  if (!currentResult.success) {
    throw new CheckpointPatchError(
      "Current checkpoint does not satisfy the CaseCheckpoint contract",
      CheckpointPatchErrorCode.INVALID_CURRENT,
      currentResult.error,
    );
  }

  const patchResult = checkpointPatch.safeParse(input.patch);
  if (!patchResult.success) {
    throw new CheckpointPatchError(
      "Checkpoint patch does not satisfy the CheckpointPatch contract",
      CheckpointPatchErrorCode.INVALID_PATCH,
      patchResult.error,
    );
  }

  const current = currentResult.data;
  const patch = patchResult.data;
  const candidate: Record<string, unknown> = {
    ...current,
    revision: current.revision + 1,
    updated_at: input.updatedAt,
  };

  if (patch.summary !== undefined) candidate.summary = patch.summary;
  if (patch.current_phase !== undefined) candidate.current_phase = patch.current_phase;

  for (const [patchField, checkpointField] of appendFields) {
    const values = patch[patchField];
    if (values !== undefined) {
      const previous = current[checkpointField];
      candidate[checkpointField] = [...previous, ...values];
    }
  }

  for (const field of ["open_questions", "next_actions", "blockers"] as const) {
    if (patch[field] !== undefined) candidate[field] = patch[field];
  }

  // Validate the complete object, including the system timestamp and append limits.
  const finalResult = caseCheckpoint.safeParse(candidate);
  if (!finalResult.success) {
    throw new CheckpointPatchError(
      "Applied checkpoint patch does not satisfy the CaseCheckpoint contract",
      CheckpointPatchErrorCode.INVALID_FINAL_RESULT,
      finalResult.error,
    );
  }
  return finalResult.data;
}

export type { CaseCheckpoint, CheckpointPatch };
