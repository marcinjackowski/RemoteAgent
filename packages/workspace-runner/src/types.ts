/** Stable identity and lifecycle contracts for an isolated coding workspace. */

export type WorkspaceIdentity = Readonly<{
  caseId: string;
  workspaceId: string;
}>;

/** The only authority a mutating operation may present to the runner. */
export type WorkspaceFence = Readonly<{
  leaseOwner: string;
  fencingToken: number;
}>;

export type WorkspaceOperationContext = Readonly<{
  identity: WorkspaceIdentity;
  fence: WorkspaceFence;
}>;

export type WorkspaceCreateInput = WorkspaceOperationContext &
  Readonly<{
    repositoryId: string;
    baseSha: string;
    branchName: string;
  }>;

export type WorkspaceResumeInput = WorkspaceOperationContext;
export type WorkspaceSnapshotInput = Readonly<{ identity: WorkspaceIdentity }>;
export type WorkspaceDestroyInput = WorkspaceOperationContext;

export type WorkspaceLifecycle = "CREATED" | "RESUMED" | "SNAPSHOTTED" | "DESTROYED";
export type WorkspaceDirtyState = "CLEAN" | "DIRTY" | "AMBIGUOUS";

export type WorkspaceLifecycleResult = Readonly<{
  operationId: string;
  identity: WorkspaceIdentity;
  lifecycle: WorkspaceLifecycle;
}>;

export type WorkspaceCreateResult = WorkspaceLifecycleResult &
  Readonly<{
    lifecycle: "CREATED";
    baseSha: string;
    branchName: string;
  }>;

export type WorkspaceResumeResult = WorkspaceLifecycleResult &
  Readonly<{
    lifecycle: "RESUMED";
    dirtyState: WorkspaceDirtyState;
  }>;

export type WorkspaceSnapshotResult = WorkspaceLifecycleResult &
  Readonly<{
    lifecycle: "SNAPSHOTTED";
    treeDigest: string;
    dirtyState: WorkspaceDirtyState;
  }>;

export type WorkspaceDestroyResult = WorkspaceLifecycleResult &
  Readonly<{
    lifecycle: "DESTROYED";
  }>;
