import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { WorkspaceIdentityError, WorkspaceLifecycleError, WorkspaceRunnerError } from "./errors.js";
import {
  addWorktree,
  ensureMirror,
  verifyCommit,
  worktreeHead,
  type GitRepository,
} from "./git.js";
import { createWorkspacePathPolicy, type VerifiedWorkspacePath } from "./path-policy.js";
import type {
  WorkspaceCreateInput,
  WorkspaceCreateResult,
  WorkspaceDestroyInput,
  WorkspaceDestroyResult,
  WorkspaceResumeInput,
  WorkspaceResumeResult,
  WorkspaceRunner,
  WorkspaceSnapshotInput,
  WorkspaceSnapshotResult,
} from "./index.js";

export type LocalRepositoryConfig = Readonly<{ sourcePath: string; mirrorPath?: string }>;
export type LocalWorkspaceAdapterConfig = Readonly<{
  workspaceRoot: string;
  repositories: Readonly<Record<string, LocalRepositoryConfig>>;
}>;

type CreatedWorkspace = Readonly<{
  path: VerifiedWorkspacePath;
  baseSha: string;
  branchName: string;
}>;

function validPart(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

/** Local-only adapter. Repository paths are server configuration, never public input. */
export class LocalWorkspaceAdapter implements WorkspaceRunner {
  private readonly workspaces = new Map<string, CreatedWorkspace>();
  private readonly rootPolicyPromise;

  public constructor(private readonly config: LocalWorkspaceAdapterConfig) {
    this.rootPolicyPromise = createWorkspacePathPolicy(config.workspaceRoot);
  }

  public async create(input: WorkspaceCreateInput): Promise<WorkspaceCreateResult> {
    this.validateIdentity(input.identity);
    if (!validPart(input.repositoryId))
      throw new WorkspaceIdentityError("Invalid repository identity");
    const repositoryConfig = this.config.repositories[input.repositoryId];
    if (!repositoryConfig) {
      throw new WorkspaceRunnerError(
        "WORKSPACE_CONFLICT",
        "Repository is not on the server allowlist",
      );
    }
    if (this.workspaces.has(this.key(input.identity))) {
      throw new WorkspaceLifecycleError("WORKSPACE_CONFLICT", "Workspace already exists");
    }
    const policy = await this.rootPolicyPromise;
    const relativeRoot = join(input.identity.caseId, input.identity.workspaceId);
    const target = await policy.validateCreateTarget(relativeRoot);
    await mkdir(join(policy.root, input.identity.caseId), { recursive: true });
    const mirrorPath =
      repositoryConfig.mirrorPath ?? join(policy.root, ".git-mirrors", input.repositoryId);
    const repository: GitRepository = { sourcePath: repositoryConfig.sourcePath, mirrorPath };
    try {
      await ensureMirror(repository);
      const exactBaseSha = await verifyCommit(repository, input.baseSha);
      await addWorktree(repository, target, input.branchName, exactBaseSha);
      const head = await worktreeHead(target);
      if (head.toLowerCase() !== exactBaseSha.toLowerCase())
        throw new Error("Worktree was not created at base SHA");
    } catch (error) {
      throw new WorkspaceLifecycleError(
        "INVALID_LIFECYCLE",
        `Unable to create worktree: ${error instanceof Error ? error.message : "git failure"}`,
      );
    }
    this.workspaces.set(this.key(input.identity), {
      path: target,
      baseSha: input.baseSha,
      branchName: input.branchName,
    });
    return {
      operationId: randomUUID(),
      identity: input.identity,
      lifecycle: "CREATED",
      baseSha: input.baseSha,
      branchName: input.branchName,
    };
  }

  public async resume(input: WorkspaceResumeInput): Promise<WorkspaceResumeResult> {
    void input;
    throw new WorkspaceLifecycleError(
      "INVALID_LIFECYCLE",
      "Resume is outside the local adapter worktree unit",
    );
  }

  public async snapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    void input;
    throw new WorkspaceLifecycleError(
      "INVALID_LIFECYCLE",
      "Snapshot is outside the local adapter worktree unit",
    );
  }

  public async destroy(input: WorkspaceDestroyInput): Promise<WorkspaceDestroyResult> {
    void input;
    throw new WorkspaceLifecycleError(
      "INVALID_LIFECYCLE",
      "Destroy is outside the local adapter worktree unit",
    );
  }

  private key(identity: { caseId: string; workspaceId: string }): string {
    return `${identity.caseId}\0${identity.workspaceId}`;
  }

  private validateIdentity(identity: { caseId: string; workspaceId: string }): void {
    if (!validPart(identity.caseId) || !validPart(identity.workspaceId))
      throw new WorkspaceIdentityError();
  }
}
