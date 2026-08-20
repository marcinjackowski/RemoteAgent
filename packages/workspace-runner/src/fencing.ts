import type { WorkspaceFence, WorkspaceIdentity } from "./types.js";

export class WorkspaceFencingError extends Error {
  public readonly code = "INVALID_FENCE" as const;
  public constructor(message = "Workspace writer fence is not current") {
    super(message);
    this.name = "WorkspaceFencingError";
  }
}

export interface DurableWorkspaceFence<TQuery> {
  readonly caseId: string | null;
  readonly leaseOwner: string;
  readonly fencingToken: number;
  assertCurrent(query: TQuery): Promise<void>;
}

/** Server-owned authority; implementations must call durable RA-009 assertCurrent. */
export interface WorkspaceFenceValidator {
  assertCurrent(
    input: Readonly<{ identity: WorkspaceIdentity; fence: WorkspaceFence }>,
  ): Promise<void>;
}

export function bindWorkspaceFence<TQuery>(
  identity: WorkspaceIdentity,
  query: TQuery,
  fence: DurableWorkspaceFence<TQuery>,
): WorkspaceFenceValidator {
  return {
    async assertCurrent(input) {
      if (
        input.identity.caseId !== identity.caseId ||
        input.fence.leaseOwner !== fence.leaseOwner ||
        input.fence.fencingToken !== fence.fencingToken ||
        fence.caseId !== identity.caseId
      ) {
        throw new WorkspaceFencingError();
      }
      try {
        await fence.assertCurrent(query);
      } catch {
        throw new WorkspaceFencingError();
      }
    },
  };
}
