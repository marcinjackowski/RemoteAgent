export type BudgetKind = "ITERATION" | "FIX";

export interface BudgetLimits {
  readonly maxIterations: number;
  readonly maxFixes: number;
}

export interface BudgetCounts {
  readonly iterations: number;
  readonly fixes: number;
}

export interface BudgetConsumption {
  readonly kind: BudgetKind;
  readonly counts: BudgetCounts;
  readonly exhausted: boolean;
}

export class InvalidBudgetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidBudgetError";
  }
}

/** Server-owned positive integer counters; completion data cannot change limits. */
export class BudgetLedger {
  readonly #limits: BudgetLimits;
  #counts: BudgetCounts = Object.freeze({ iterations: 0, fixes: 0 });

  public constructor(limits: BudgetLimits) {
    validateLimit(limits.maxIterations, "maxIterations");
    validateLimit(limits.maxFixes, "maxFixes");
    this.#limits = Object.freeze({ ...limits });
  }

  public get limits(): BudgetLimits {
    return this.#limits;
  }

  public get counts(): BudgetCounts {
    return this.#counts;
  }

  public consume(kind: BudgetKind): BudgetConsumption {
    validateKind(kind);
    const key = kind === "ITERATION" ? "iterations" : "fixes";
    const limit = kind === "ITERATION" ? this.#limits.maxIterations : this.#limits.maxFixes;
    if (this.#counts[key] >= limit) {
      return { kind, counts: this.#counts, exhausted: true };
    }
    this.#counts = Object.freeze({ ...this.#counts, [key]: this.#counts[key] + 1 });
    return { kind, counts: this.#counts, exhausted: this.#counts[key] >= limit };
  }

  public rollback(kind: BudgetKind): void {
    validateKind(kind);
    const key = kind === "ITERATION" ? "iterations" : "fixes";
    if (this.#counts[key] === 0) throw new InvalidBudgetError("cannot rollback an empty budget");
    this.#counts = Object.freeze({ ...this.#counts, [key]: this.#counts[key] - 1 });
  }
}

function validateKind(kind: BudgetKind): void {
  if (kind !== "ITERATION" && kind !== "FIX") throw new InvalidBudgetError("unknown budget kind");
}

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new InvalidBudgetError(`${name} must be a positive safe integer`);
  }
}
