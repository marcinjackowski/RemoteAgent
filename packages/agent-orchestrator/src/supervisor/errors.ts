import type { SupervisorStatus } from "./state.js";

export class SupervisorTransitionError extends Error {
  public constructor(
    public readonly from: SupervisorStatus,
    public readonly event: string,
    public readonly allowed: readonly SupervisorStatus[],
    message = `Illegal supervisor transition from ${from} via ${event}`,
  ) {
    super(message);
    this.name = "SupervisorTransitionError";
  }
}

export class SupervisorInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SupervisorInvariantError";
  }
}
