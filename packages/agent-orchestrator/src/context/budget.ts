export function utf8ByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

export function assertPositiveBudget(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidContextBudgetError(value);
  }
}

export class InvalidContextBudgetError extends Error {
  readonly code = "INVALID_CONTEXT_BUDGET" as const;
  constructor(public readonly budget: unknown) {
    super(`Context budget must be a positive safe integer: ${String(budget)}`);
    this.name = "InvalidContextBudgetError";
  }
}
