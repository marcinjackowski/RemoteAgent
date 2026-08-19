export const CompletionPreparationErrorCode = {
  INVALID_COMPLETION: "INVALID_COMPLETION",
  INVALID_SYSTEM_AUTHORITY: "INVALID_SYSTEM_AUTHORITY",
  MISMATCH: "MISMATCH",
  CHECKPOINT_APPLICATION: "CHECKPOINT_APPLICATION",
  INVALID_FINAL_RESULT: "INVALID_FINAL_RESULT",
} as const;

export type CompletionPreparationErrorCode =
  (typeof CompletionPreparationErrorCode)[keyof typeof CompletionPreparationErrorCode];

export class CompletionPreparationError extends Error {
  constructor(
    message: string,
    readonly code: CompletionPreparationErrorCode,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CompletionPreparationError";
  }
}
