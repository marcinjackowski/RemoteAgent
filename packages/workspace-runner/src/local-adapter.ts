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
import { computeTreeDigest, inspectWorkspace } from "./digest.js";
import { OperationLedger } from "./operation-log.js";
import { WorkspaceFencingError, type WorkspaceFenceValidator } from "./fencing.js";
import {
  recoverWorkspace,
  WorkspaceRecoveryError,
  type WorkspaceMapping,
  type WorkspaceRegistry,
} from "./recovery.js";
import { cleanupWorkspace, WorkspaceCleanupError } from "./cleanup.js";
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
  fenceValidator?: WorkspaceFenceValidator;
  workspaceRegistry?: WorkspaceRegistry;
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
  private readonly registry: WorkspaceRegistry | undefined;

  public constructor(private readonly config: LocalWorkspaceAdapterConfig) {
    this.rootPolicyPromise = createWorkspacePathPolicy(config.workspaceRoot);
    void this.rootPolicyPromise.catch(() => undefined);
    this.metadataRoot = resolve(
      config.ledgerRoot ??
        join(
          dirname(config.workspaceRoot),
          `.workspace-runner-metadata-${basename(config.workspaceRoot)}`,
        ),
    );
    this.ledger = new OperationLedger(this.metadataRoot);
    this.registry = config.workspaceRegistry;
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
    if (!this.config.fenceValidator)
      throw new WorkspaceFencingError("Writer fence validator is required");
    await this.config.fenceValidator.assertCurrent({
      identity: input.identity,
      fence: input.fence,
    });
    if (!this.config.workspaceRegistry)
      throw new WorkspaceRecoveryError("CONFLICT", "Server-owned workspace registry is required");
    const registry = this.registry;
    if (!registry)
      throw new WorkspaceRecoveryError("CONFLICT", "Server-owned workspace registry is required");
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
    const relativeRoot = join(input.identity.caseId, input.identity.workspaceId);
    const target = await policy.validateCreateTarget(relativeRoot);
    const mapping = await registry.recordIntent({
      workspaceId: input.identity.workspaceId,
      caseId: input.identity.caseId,
      repo: input.repositoryId,
      baseSha: input.baseSha,
      branchName: input.branchName,
      target,
    });
    await this.config.fenceValidator.assertCurrent({
      identity: input.identity,
      fence: input.fence,
    });
    await mkdir(canonicalMetadataRoot, { recursive: true });
    await validateWorkspaceRoot(canonicalMetadataRoot);
    const operationId = randomUUID();
    await this.config.fenceValidator.assertCurrent({
      identity: input.identity,
      fence: input.fence,
    });
    await mkdir(join(policy.root, input.identity.caseId), { recursive: true });
    const mirrorPath =
      repositoryConfig.mirrorPath ?? join(policy.root, ".git-mirrors", input.repositoryId);
    const repository: GitRepository = { sourcePath: repositoryConfig.sourcePath, mirrorPath };
    try {
      await this.config.fenceValidator.assertCurrent({
        identity: input.identity,
        fence: input.fence,
      });
      await ensureMirror(repository);
      const exactBaseSha = await verifyCommit(repository, input.baseSha);
      await this.config.fenceValidator.assertCurrent({
        identity: input.identity,
        fence: input.fence,
      });
      await addWorktree(repository, target, input.branchName, exactBaseSha);
      const head = await worktreeHead(target);
      if (head.toLowerCase() !== exactBaseSha.toLowerCase())
        throw new Error("Worktree was not created at base SHA");
      try {
        const afterDigest = await computeTreeDigest(target);
        await this.config.fenceValidator.assertCurrent({
          identity: input.identity,
          fence: input.fence,
        });
        await this.ledger.append({
          version: 1,
          operationId,
          identity: input.identity,
          kind: "CREATE_WORKTREE",
          beforeDigest: null,
          afterDigest,
          outcome: "SUCCEEDED",
        });
        if (!(await registry.finalize(mapping, afterDigest)))
          throw new WorkspaceLifecycleError(
            "INVALID_LIFECYCLE",
            "Workspace mapping finalize conflict",
          );
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
    this.validateIdentity(input.identity);
    if (!this.registry)
      throw new WorkspaceRecoveryError("CONFLICT", "Server-owned workspace registry is required");
    const recovered = await recoverWorkspace(
      this.registry,
      input.identity.workspaceId,
      this.metadataRoot,
    );
    if (recovered.mapping.caseId !== input.identity.caseId)
      throw new WorkspaceRecoveryError("CONFLICT", "Workspace mapping case binding mismatch");
    this.workspaces.set(this.key(input.identity), {
      path: recovered.mapping.target as VerifiedWorkspacePath,
      baseSha: recovered.mapping.baseSha,
      branchName: recovered.mapping.branchName,
    });
    return {
      operationId: randomUUID(),
      identity: input.identity,
      lifecycle: "RESUMED",
      dirtyState: recovered.state,
    };
  }

  public async snapshot(input: WorkspaceSnapshotInput): Promise<WorkspaceSnapshotResult> {
    this.validateIdentity(input.identity);
    const registry = this.config.workspaceRegistry;
    if (!registry)
      throw new WorkspaceRecoveryError("CONFLICT", "Server-owned workspace registry is required");
    let mapping: WorkspaceMapping | null;
    try {
      mapping = await registry.find(input.identity.workspaceId);
    } catch {
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace mapping target is not canonical");
    }
    if (!mapping)
      throw new WorkspaceRecoveryError("MISSING_MAPPING", "Workspace mapping is required");
    if (
      mapping.caseId !== input.identity.caseId ||
      mapping.workspaceId !== input.identity.workspaceId
    )
      throw new WorkspaceRecoveryError("CONFLICT", "Workspace mapping identity mismatch");
    const policy = await this.rootPolicyPromise;
    const target = resolve(mapping.target);
    const targetRelative = relative(policy.root, target);
    if (
      !targetRelative ||
      targetRelative === ".." ||
      targetRelative.startsWith(`..${sep}`) ||
      isAbsolute(targetRelative)
    ) {
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace mapping target is outside the root");
    }
    let verifiedTarget: VerifiedWorkspacePath;
    try {
      verifiedTarget = await policy.validateDestructiveTarget(targetRelative);
    } catch {
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace target is not canonical");
    }
    if (verifiedTarget !== mapping.target)
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace mapping target changed");
    let snapshot;
    try {
      snapshot = await inspectWorkspace(verifiedTarget);
    } catch {
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace inspection failed");
    }
    return {
      operationId: `snapshot:${input.identity.caseId}:${input.identity.workspaceId}`,
      identity: input.identity,
      lifecycle: "SNAPSHOTTED",
      treeDigest: snapshot.treeDigest,
      dirtyState: snapshot.dirtyState,
    };
  }

  public async destroy(input: WorkspaceDestroyInput): Promise<WorkspaceDestroyResult> {
    this.validateIdentity(input.identity);
    if (!this.config.fenceValidator)
      throw new WorkspaceFencingError("Writer fence validator is required");
    if (!this.registry)
      throw new WorkspaceRecoveryError("CONFLICT", "Server-owned workspace registry is required");
    try {
      return await cleanupWorkspace(
        {
          workspaceRoot: this.config.workspaceRoot,
          metadataRoot: this.metadataRoot,
          repositories: Object.fromEntries(
            Object.entries(this.config.repositories).map(([id, repository]) => [
              id,
              {
                mirrorPath:
                  repository.mirrorPath ?? join(this.config.workspaceRoot, ".git-mirrors", id),
              },
            ]),
          ),
          registry: this.registry,
          fenceValidator: this.config.fenceValidator,
        },
        input,
      );
    } catch (error) {
      if (error instanceof WorkspaceFencingError) throw error;
      if (error instanceof WorkspaceCleanupError) throw error;
      throw new WorkspaceLifecycleError(
        "INVALID_LIFECYCLE",
        `Unable to cleanup workspace: ${error instanceof Error ? error.message : "cleanup failure"}`,
      );
    }
  }

  private key(identity: { caseId: string; workspaceId: string }): string {
    return `${identity.caseId}\0${identity.workspaceId}`;
  }

  private validateIdentity(identity: { caseId: string; workspaceId: string }): void {
    if (!validPart(identity.caseId) || !validPart(identity.workspaceId))
      throw new WorkspaceIdentityError();
  }
}
