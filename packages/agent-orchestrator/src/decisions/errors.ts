export const DecisionPreparationErrorCode = {
  INVALID_COMPLETION: "INVALID_COMPLETION",
  INVALID_CHECKPOINT: "INVALID_CHECKPOINT",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_SELECTION: "INVALID_SELECTION",
  INVALID_SYSTEM: "INVALID_SYSTEM",
  NOT_WAITING: "NOT_WAITING",
  MISMATCH: "MISMATCH",
  STALE_REVISION: "STALE_REVISION",
  UNKNOWN_OPTION: "UNKNOWN_OPTION",
  EXPIRED: "EXPIRED",
  INVALID_RESULT: "INVALID_RESULT",
} as const;

export type DecisionPreparationErrorCode =
  (typeof DecisionPreparationErrorCode)[keyof typeof DecisionPreparationErrorCode];

export class DecisionPreparationError extends Error {
  public constructor(
    message: string,
    public readonly code: DecisionPreparationErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DecisionPreparationError";
  }
}
