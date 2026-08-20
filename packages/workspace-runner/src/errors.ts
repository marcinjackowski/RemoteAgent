export type WorkspaceRunnerErrorCode =
  | "INVALID_IDENTITY"
  | "INVALID_FENCE"
  | "STALE_FENCE"
  | "INVALID_LIFECYCLE"
  | "INVALID_DESTRUCTIVE_TARGET"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_CONFLICT";

export class WorkspaceRunnerError extends Error {
  public constructor(
    public readonly code: WorkspaceRunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRunnerError";
  }
}

export class WorkspaceIdentityError extends WorkspaceRunnerError {
  public constructor(message = "Invalid workspace identity") {
    super("INVALID_IDENTITY", message);
    this.name = "WorkspaceIdentityError";
  }
}

export class WorkspaceFenceError extends WorkspaceRunnerError {
  public constructor(code: "INVALID_FENCE" | "STALE_FENCE", message: string) {
    super(code, message);
    this.name = "WorkspaceFenceError";
  }
}

export class WorkspaceLifecycleError extends WorkspaceRunnerError {
  public constructor(
    code: "INVALID_LIFECYCLE" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_CONFLICT",
    message: string,
  ) {
    super(code, message);
    this.name = "WorkspaceLifecycleError";
  }
}

export class WorkspaceDestructiveTargetError extends WorkspaceRunnerError {
  public constructor(message = "Destructive operations require a verified workspace target") {
    super("INVALID_DESTRUCTIVE_TARGET", message);
    this.name = "WorkspaceDestructiveTargetError";
  }
}
