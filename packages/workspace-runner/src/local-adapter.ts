import { lstat, mkdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceIdentityError, WorkspaceLifecycleError, WorkspaceRunnerError } from "./errors.js";
import {
  addWorktree,
  ensureMirror,
  verifyCommit,
  worktreeHead,
  type GitRepository,
} from "./git.js";
import {
  createWorkspacePathPolicy,
  validateWorkspaceRoot,
  type VerifiedWorkspacePath,
} from "./path-policy.js";
import { computeTreeDigest } from "./digest.js";
import { OperationLedger } from "./operation-log.js";
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
  ledgerRoot?: string;
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
  private readonly ledger: OperationLedger;
  private readonly metadataRoot: string;

  public constructor(private readonly config: LocalWorkspaceAdapterConfig) {
    this.rootPolicyPromise = createWorkspacePathPolicy(config.workspaceRoot);
    this.metadataRoot = resolve(
      config.ledgerRoot ??
        join(
          dirname(config.workspaceRoot),
          `.workspace-runner-metadata-${basename(config.workspaceRoot)}`,
        ),
    );
    this.ledger = new OperationLedger(this.metadataRoot);
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
    const metadataParent = dirname(this.metadataRoot);
    const canonicalParent = await realpath(metadataParent).catch(() => {
      throw new WorkspaceLifecycleError("INVALID_LIFECYCLE", "Ledger parent must already exist");
    });
    const canonicalMetadataRoot = join(canonicalParent, basename(this.metadataRoot));
    const existingMetadata = await lstat(this.metadataRoot).catch(() => undefined);
    if (existingMetadata?.isSymbolicLink()) {
      throw new WorkspaceLifecycleError("INVALID_LIFECYCLE", "Ledger root must not be a symlink");
    }
    if (existingMetadata) {
      const existingCanonical = await realpath(this.metadataRoot).catch(() => "");
      if (existingCanonical !== canonicalMetadataRoot) {
        throw new WorkspaceLifecycleError(
          "INVALID_LIFECYCLE",
          "Ledger root canonicalization mismatch",
        );
      }
    }
    if (canonicalMetadataRoot === policy.root) {
      throw new WorkspaceLifecycleError(
        "INVALID_LIFECYCLE",
        "Ledger root must be canonical and dedicated",
      );
    }
    const metadataRelative = relative(policy.root, canonicalMetadataRoot);
    const workspaceRelative = relative(canonicalMetadataRoot, policy.root);
    if (
      !metadataRelative ||
      !workspaceRelative ||
      (!metadataRelative.startsWith(`..${sep}`) && !isAbsolute(metadataRelative)) ||
      (!workspaceRelative.startsWith(`..${sep}`) && !isAbsolute(workspaceRelative))
    ) {
      throw new WorkspaceLifecycleError(
        "INVALID_LIFECYCLE",
        "Ledger root must be outside the command workspace",
      );
    }
    await mkdir(canonicalMetadataRoot, { recursive: true });
    await validateWorkspaceRoot(canonicalMetadataRoot);
    const operationId = randomUUID();
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
      try {
        await this.ledger.append({
          version: 1,
          operationId,
          identity: input.identity,
          kind: "CREATE_WORKTREE",
          beforeDigest: null,
          afterDigest: await computeTreeDigest(target),
          outcome: "SUCCEEDED",
        });
      } catch (error) {
        throw new WorkspaceLifecycleError(
          "INVALID_LIFECYCLE",
          `Ledger outcome is ambiguous: ${error instanceof Error ? error.message : "write failure"}`,
        );
      }
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
      operationId,
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
