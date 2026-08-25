/**
 * Worker workspace configuration (RA-034 WU-02).
 *
 * The IMPLEMENTER writes code in an isolated per-case worktree provisioned by
 * `LocalWorkspaceAdapter`, which needs server-owned config: a `workspaceRoot` and a repository
 * ALLOWLIST mapping a repo id → local source path. That config is a deployment decision and a host
 * path, so it comes from the environment, parsed here with NO database, git, or network — a
 * composition test can prove the contract without any of them.
 *
 * FAIL-CLOSED, TWO WAYS, matching `jiraReconcileConfigFromEnv` / `workerConfigFromEnv`:
 *   - ABSENT (`RA_WORKSPACE_ROOT` unset) → returns `null`: workspace provisioning is not configured,
 *     so an IMPLEMENTER job fails closed rather than writing to an unconfigured location.
 *   - PRESENT-BUT-INVALID (root set, but a path is relative or a repo id is malformed) → THROWS,
 *     never silently drops a repo. A half-configured allowlist is a deployment that looks wired and
 *     is not.
 *
 * The repo id charset matches the workspace-runner's own `validPart` (`[A-Za-z0-9._-]`), so a value
 * accepted here cannot later be rejected by `LocalWorkspaceAdapter.create`.
 */
import { isAbsolute } from "node:path";

/** Repo-id charset accepted by the workspace-runner path policy (`local-adapter.ts` validPart). */
const REPO_ID = /^[A-Za-z0-9._-]+$/;

export interface WorkspaceRepoConfig {
  /** Absolute path to the source clone the worktree mirrors from (read-only source). */
  readonly sourcePath: string;
  /** Branch the case branch forks from; resolved to an exact SHA at provisioning (WU-04). */
  readonly baseBranch: string;
}

export interface WorkspaceConfig {
  readonly workspaceRoot: string;
  /** Server-owned allowlist: only these repo ids may be opened. */
  readonly repositories: Readonly<Record<string, WorkspaceRepoConfig>>;
}

type Env = Record<string, string | undefined>;

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Parse the worker's workspace config. Single-owner: one repo via discrete `RA_WORKSPACE_REPO_*`
 * vars (a multi-repo allowlist can generalize this later without changing the return shape).
 */
export function workspaceConfigFromEnv(env: Env = process.env): WorkspaceConfig | null {
  const workspaceRoot = trimmed(env, "RA_WORKSPACE_ROOT");
  if (workspaceRoot === undefined) return null;
  if (!isAbsolute(workspaceRoot))
    throw new Error("RA_WORKSPACE_ROOT must be an absolute path");

  const repoId = trimmed(env, "RA_WORKSPACE_REPO_ID");
  const sourcePath = trimmed(env, "RA_WORKSPACE_REPO_PATH");
  if (repoId === undefined || sourcePath === undefined) {
    // Root without a repo is a misconfiguration, not "no repos": provisioning would always fail
    // closed at create() with "not on the allowlist", which reads as a bug rather than a config gap.
    throw new Error("RA_WORKSPACE_ROOT is set but RA_WORKSPACE_REPO_ID/RA_WORKSPACE_REPO_PATH are not");
  }
  if (!REPO_ID.test(repoId))
    throw new Error(`RA_WORKSPACE_REPO_ID must match ${REPO_ID.source}, got ${repoId}`);
  if (!isAbsolute(sourcePath))
    throw new Error("RA_WORKSPACE_REPO_PATH must be an absolute path");
  const baseBranch = trimmed(env, "RA_WORKSPACE_BASE_BRANCH") ?? "main";

  return {
    workspaceRoot,
    repositories: { [repoId]: { sourcePath, baseBranch } },
  };
}
