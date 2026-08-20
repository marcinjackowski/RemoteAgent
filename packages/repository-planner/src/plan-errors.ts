export type PlanCompilationErrorCode =
  | "INVALID_INPUT"
  | "PROFILE_MISMATCH"
  | "COVERAGE_MISSING"
  | "INCOMPLETE_PLAN"
  | "DUPLICATE_ID"
  | "INVALID_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "UNAUTHORIZED_FIELD";

export class PlanCompilationError extends Error {
  public constructor(
    public readonly code: PlanCompilationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanCompilationError";
  }
}

export function planFail(code: PlanCompilationErrorCode, message: string): never {
  throw new PlanCompilationError(code, message);
}
