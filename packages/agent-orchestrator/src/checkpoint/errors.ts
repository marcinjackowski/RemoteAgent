export const CheckpointPatchErrorCode = {
  INVALID_CURRENT: "INVALID_CURRENT",
  INVALID_PATCH: "INVALID_PATCH",
  INVALID_FINAL_RESULT: "INVALID_FINAL_RESULT",
} as const;

export type CheckpointPatchErrorCode =
  (typeof CheckpointPatchErrorCode)[keyof typeof CheckpointPatchErrorCode];

export class CheckpointPatchError extends Error {
  constructor(
    message: string,
    readonly code: CheckpointPatchErrorCode,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CheckpointPatchError";
  }
}
