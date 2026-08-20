import { describe, expect, it } from "vitest";
import {
  WorkspaceDestructiveTargetError,
  WorkspaceFenceError,
  WorkspaceIdentityError,
  WorkspaceLifecycleError,
  WorkspaceRunnerError,
  type WorkspaceRunner,
  type WorkspaceSnapshotResult,
} from "../src/index.js";

describe("workspace runner contracts", () => {
  it("defines a model-neutral lifecycle with case/workspace identity", async () => {
    const runner: WorkspaceRunner = {
      async create(input) {
        return {
          operationId: "op-1",
          identity: input.identity,
          lifecycle: "CREATED",
          baseSha: input.baseSha,
          branchName: input.branchName,
        };
      },
      async resume(input) {
        return {
          operationId: "op-2",
          identity: input.identity,
          lifecycle: "RESUMED",
          dirtyState: "CLEAN",
        };
      },
      async snapshot(input): Promise<WorkspaceSnapshotResult> {
        return {
          operationId: "op-3",
          identity: input.identity,
          lifecycle: "SNAPSHOTTED",
          treeDigest: "sha256:digest",
          dirtyState: "CLEAN",
        };
      },
      async destroy(input) {
        return { operationId: "op-4", identity: input.identity, lifecycle: "DESTROYED" };
      },
    };
    const identity = { caseId: "case-1", workspaceId: "workspace-1" };
    const fence = { leaseOwner: "worker-1", fencingToken: 4 };
    expect(
      (
        await runner.create({
          identity,
          fence,
          repositoryId: "repo-1",
          baseSha: "sha-1",
          branchName: "case-1",
        })
      ).identity,
    ).toEqual(identity);
    expect((await runner.resume({ identity, fence })).lifecycle).toBe("RESUMED");
    expect((await runner.snapshot({ identity })).dirtyState).toBe("CLEAN");
    expect((await runner.destroy({ identity, fence })).lifecycle).toBe("DESTROYED");
  });

  it("keeps lifecycle results typed and fencing explicit for mutations", () => {
    const identity = { caseId: "case-1", workspaceId: "workspace-1" };
    const result: WorkspaceSnapshotResult = {
      operationId: "op-1",
      identity,
      lifecycle: "SNAPSHOTTED",
      treeDigest: "sha256:digest",
      dirtyState: "AMBIGUOUS",
    };
    expect(result.identity).toEqual(identity);
    expect(result.dirtyState).toBe("AMBIGUOUS");
  });

  it("provides typed fail-closed errors", () => {
    const errors: WorkspaceRunnerError[] = [
      new WorkspaceIdentityError(),
      new WorkspaceFenceError("STALE_FENCE", "lease was lost"),
      new WorkspaceLifecycleError("WORKSPACE_CONFLICT", "already exists"),
      new WorkspaceDestructiveTargetError(),
    ];
    expect(errors.map((error) => error.code)).toEqual([
      "INVALID_IDENTITY",
      "STALE_FENCE",
      "WORKSPACE_CONFLICT",
      "INVALID_DESTRUCTIVE_TARGET",
    ]);
    expect(errors.every((error) => error instanceof WorkspaceRunnerError)).toBe(true);
  });
});
