import { lstat, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { WorkspacePathPolicyError, type WorkspacePathErrorCode } from "./errors.js";

declare const verifiedPath: unique symbol;

/** A path which has passed the filesystem confinement boundary. */
export type VerifiedWorkspacePath = string & { readonly [verifiedPath]: true };

export type WorkspacePathPolicy = Readonly<{
  root: VerifiedWorkspacePath;
  validateCreateTarget(path: string): Promise<VerifiedWorkspacePath>;
  validateCommandCwd(path?: string): Promise<VerifiedWorkspacePath>;
  validateDestructiveTarget(path: string): Promise<VerifiedWorkspacePath>;
}>;

export type WorkspacePathPolicyOptions = Readonly<{
  /** Explicit host boundaries that are never valid workspace roots. */
  protectedRoots?: readonly string[];
}>;

function fail(code: WorkspacePathErrorCode, message: string): never {
  throw new WorkspacePathPolicyError(code, message);
}

function ensureString(path: string): void {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    fail("INVALID_PATH", "Workspace paths must be non-empty strings without NUL bytes");
  }
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function rejectSymlinkComponents(path: string, allowMissing: boolean): Promise<void> {
  const absolute = resolve(path);
  const parts = absolute.split(sep);
  let current = parts.shift() === "" ? sep : (parts[0] ?? sep);
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        fail("SYMLINK_NOT_ALLOWED", `Symlink component is not allowed: ${current}`);
      }
    } catch (error) {
      if (error instanceof WorkspacePathPolicyError) throw error;
      if (!allowMissing) fail("INVALID_PATH", `Path does not exist: ${current}`);
      // Once a component is absent, later components cannot be symlinks on disk.
      return;
    }
  }
}

/** Validate and canonicalize a dedicated, already-created workspace root. */
export async function validateWorkspaceRoot(
  root: string,
  options: WorkspacePathPolicyOptions = {},
): Promise<VerifiedWorkspacePath> {
  ensureString(root);
  const requested = resolve(root);
  const requestedStat = await lstat(requested).catch(() => undefined);
  if (!requestedStat) fail("INVALID_PATH", `Workspace root does not exist: ${requested}`);
  if (requestedStat.isSymbolicLink())
    fail("SYMLINK_NOT_ALLOWED", "Workspace root must not be a symlink");
  const canonical = await realpath(requested).catch(() =>
    fail("INVALID_PATH", `Workspace root does not exist: ${requested}`),
  );
  const canonicalHome = await realpath(homedir()).catch(() => resolve(homedir()));
  const canonicalTemp = await realpath(tmpdir()).catch(() => resolve(tmpdir()));
  const protectedRoots = await Promise.all(
    (options.protectedRoots ?? []).map(async (protectedRoot) =>
      realpath(resolve(protectedRoot)).catch(() => resolve(protectedRoot)),
    ),
  );
  if (
    canonical === dirname(canonical) ||
    canonical === canonicalHome ||
    canonical === canonicalTemp ||
    protectedRoots.includes(canonical)
  ) {
    fail("BROAD_WORKSPACE_ROOT", "Workspace root is too broad");
  }
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) fail("INVALID_PATH", "Workspace root must be a directory");
  await rejectSymlinkComponents(canonical, false);
  return canonical as VerifiedWorkspacePath;
}

export async function createWorkspacePathPolicy(
  root: string,
  options: WorkspacePathPolicyOptions = {},
): Promise<WorkspacePathPolicy> {
  const verifiedRoot = await validateWorkspaceRoot(root, options);

  const validate = async (
    candidate: string,
    allowMissing: boolean,
    allowRoot = false,
  ): Promise<VerifiedWorkspacePath> => {
    ensureString(candidate);
    if (isAbsolute(candidate)) fail("PATH_ESCAPE", "Workspace paths must be relative to the root");
    const target = resolve(verifiedRoot, candidate);
    if (target !== verifiedRoot && !contained(verifiedRoot, target))
      fail("PATH_ESCAPE", "Path escapes the workspace root");
    if (target === verifiedRoot && !allowRoot)
      fail("INVALID_PATH", "Workspace root is not an operation target");
    await rejectSymlinkComponents(target, allowMissing);
    const canonicalTarget = await realpath(target).catch(() => target);
    if (canonicalTarget !== verifiedRoot && !contained(verifiedRoot, canonicalTarget))
      fail("PATH_ESCAPE", "Path escapes the workspace root");
    if (canonicalTarget !== target) fail("SYMLINK_NOT_ALLOWED", "Symlink targets are not allowed");
    return target as VerifiedWorkspacePath;
  };

  return {
    root: verifiedRoot,
    validateCreateTarget: (path) => validate(path, true),
    validateCommandCwd: (path = ".") => validate(path, false, true),
    validateDestructiveTarget: (path) => validate(path, false),
  };
}
