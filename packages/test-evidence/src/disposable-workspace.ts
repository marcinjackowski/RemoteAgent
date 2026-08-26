import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdtemp, open, readlink, realpath, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { relativeRepositoryPath } from "@remoteagent/contracts";
import {
  computeTreeDigest,
  createWorkspacePathPolicy,
  validateWorkspaceRoot,
} from "@remoteagent/workspace-runner";

export const DisposableWorkspaceErrorCode = {
  INVALID_MUTABLE_OUTPUT: "INVALID_MUTABLE_OUTPUT",
  UNSAFE_TREE_SYMLINK: "UNSAFE_TREE_SYMLINK",
  COPY_MISMATCH: "COPY_MISMATCH",
  AUTHORITATIVE_TREE_CHANGED: "AUTHORITATIVE_TREE_CHANGED",
  PROTECTED_TREE_CHANGED: "PROTECTED_TREE_CHANGED",
  CLEANUP_FAILED: "CLEANUP_FAILED",
} as const;

export type DisposableWorkspaceErrorCode =
  (typeof DisposableWorkspaceErrorCode)[keyof typeof DisposableWorkspaceErrorCode];

export class DisposableWorkspaceError extends Error {
  public constructor(
    public readonly code: DisposableWorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DisposableWorkspaceError";
  }
}

export type DisposableWorkspaceOptions = Readonly<{
  authoritativeRoot: string;
  mutableOutputs: readonly string[];
}>;

export type DisposableWorkspaceEvidence = Readonly<{
  authoritativeTreeDigestBefore: string;
  authoritativeTreeDigestAfter: string;
  disposableTreeDigestBefore: string;
  disposableTreeDigestAfter: string;
  protectedTreeDigestBefore: string;
  protectedTreeDigestAfter: string;
}>;

export type DisposableWorkspaceRunResult<T> = Readonly<{
  value: T;
  evidence: DisposableWorkspaceEvidence;
}>;

type InventoryEntry = Readonly<{
  path: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  content: string;
}>;

const CLEANUP_TIMEOUT_MS = 5_000;

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function slash(path: string): string {
  return path.split(sep).join("/");
}

/** Internal copy-boundary primitive shared by durable pre-slice baselines. */
export async function assertSafeVerificationTree(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git") {
      if (current === root) continue;
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.UNSAFE_TREE_SYMLINK,
        `Nested repository control edge is forbidden: ${slash(relative(root, join(current, entry.name)))}`,
      );
    }
    const entryPath = join(current, entry.name);
    const stat = await lstat(entryPath);
    if (stat.isSymbolicLink()) {
      const rawTarget = await readlink(entryPath);
      const linkTarget = resolve(dirname(entryPath), rawTarget);
      const canonicalTarget = await realpath(entryPath).catch(() => undefined);
      if (
        isAbsolute(rawTarget) ||
        (linkTarget !== root && !contained(root, linkTarget)) ||
        canonicalTarget === undefined ||
        (canonicalTarget !== root && !contained(root, canonicalTarget))
      ) {
        throw new DisposableWorkspaceError(
          DisposableWorkspaceErrorCode.UNSAFE_TREE_SYMLINK,
          `Tree symlink escapes or has an unreadable target: ${slash(relative(root, entryPath))}`,
        );
      }
    } else if (stat.isDirectory()) {
      await assertSafeVerificationTree(root, entryPath);
    }
  }
}

/** A verification copy is data only; repository control edges never cross the boundary. */
export async function assertVerificationTreeHasNoGitEdges(
  root: string,
  current = root,
): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === ".git") {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.COPY_MISMATCH,
        `Disposable copy retained a .git edge: ${slash(relative(root, join(current, entry.name)))}`,
      );
    }
    if (entry.isDirectory())
      await assertVerificationTreeHasNoGitEdges(root, join(current, entry.name));
  }
}

function isMutablePath(path: string, mutableRoots: ReadonlySet<string>): boolean {
  for (const root of mutableRoots) {
    if (path === root || path.startsWith(`${root}/`)) return true;
    if (root.startsWith(`${path}/`)) return true;
  }
  return false;
}

async function collectProtectedInventory(
  root: string,
  mutableRoots: ReadonlySet<string>,
  current = root,
  output: InventoryEntry[] = [],
): Promise<InventoryEntry[]> {
  const children = (await readdir(current)).sort();
  for (const name of children) {
    const entryPath = join(current, name);
    const relativePath = slash(relative(root, entryPath));
    const stat = await lstat(entryPath);
    const mutable = isMutablePath(relativePath, mutableRoots);
    if (stat.isSymbolicLink()) {
      if (!mutable) {
        output.push({
          path: relativePath,
          kind: "symlink",
          mode: stat.mode & 0o7777,
          content: await readlink(entryPath),
        });
      }
    } else if (stat.isDirectory()) {
      if (!mutable) {
        output.push({
          path: relativePath,
          kind: "directory",
          mode: stat.mode & 0o7777,
          content: "",
        });
      }
      if (![...mutableRoots].some((mutableRoot) => relativePath === mutableRoot)) {
        await collectProtectedInventory(root, mutableRoots, entryPath, output);
      }
    } else if (stat.isFile()) {
      if (!mutable) {
        const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
        const handle = await open(entryPath, constants.O_RDONLY | noFollow);
        try {
          const opened = await handle.stat();
          if (!opened.isFile()) {
            throw new DisposableWorkspaceError(
              DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
              `Protected file changed while being inventoried: ${relativePath}`,
            );
          }
          output.push({
            path: relativePath,
            kind: "file",
            mode: opened.mode & 0o7777,
            content: createHash("sha256")
              .update(await handle.readFile())
              .digest("hex"),
          });
        } finally {
          await handle.close();
        }
      }
    } else {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
        `Unsupported protected tree entry: ${relativePath}`,
      );
    }
  }
  return output;
}

async function protectedTreeDigest(
  root: string,
  mutableRoots: ReadonlySet<string>,
): Promise<string> {
  const inventory = await collectProtectedInventory(root, mutableRoots);
  const hash = createHash("sha256");
  for (const entry of inventory.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)))) {
    const frame = Buffer.from(JSON.stringify([entry.kind, entry.mode, entry.path, entry.content]));
    hash.update(Buffer.from(`${frame.length}:`));
    hash.update(frame);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

async function validateMutableOutputs(
  root: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const policy = await createWorkspacePathPolicy(root);
  const canonical = new Set<string>();
  for (const candidate of paths) {
    if (
      !relativeRepositoryPath.safeParse(candidate).success ||
      candidate.split("/").includes(".git")
    ) {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.INVALID_MUTABLE_OUTPUT,
        `Mutable output must be a canonical relative path: ${String(candidate)}`,
      );
    }
    const target = await policy.validateCreateTarget(candidate).catch((error: unknown) => {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.INVALID_MUTABLE_OUTPUT,
        error instanceof Error ? error.message : "Mutable output path is invalid",
      );
    });
    const normalized = slash(relative(root, target));
    if (normalized !== candidate || canonical.has(normalized)) {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.INVALID_MUTABLE_OUTPUT,
        `Mutable output is duplicate or non-canonical: ${candidate}`,
      );
    }
    canonical.add(normalized);
  }
  return canonical;
}

async function assertMutableBoundary(
  root: string,
  mutableRoots: ReadonlySet<string>,
): Promise<void> {
  for (const mutableRoot of mutableRoots) {
    const segments = mutableRoot.split("/");
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const stat = await lstat(current).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      });
      // A missing component proves all deeper components are absent at this
      // observation point. Creating the declared output later remains allowed.
      if (stat === undefined) break;
      if (stat.isSymbolicLink()) {
        throw new DisposableWorkspaceError(
          DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
          `Mutable output component became a symlink: ${slash(relative(root, current))}`,
        );
      }
      const isRoot = index === segments.length - 1;
      if ((!isRoot && !stat.isDirectory()) || (isRoot && !stat.isDirectory() && !stat.isFile())) {
        throw new DisposableWorkspaceError(
          DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
          `Mutable output component has an unsafe type: ${slash(relative(root, current))}`,
        );
      }
      const canonical = await realpath(current).catch(() => undefined);
      if (canonical === undefined || !contained(root, canonical)) {
        throw new DisposableWorkspaceError(
          DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
          `Mutable output component escapes the disposable root: ${slash(relative(root, current))}`,
        );
      }
    }
  }
}

/** Remove an ephemeral verification tree without an unbounded shutdown wait. */
export async function cleanupVerificationTree(parent: string): Promise<void> {
  const deletion = rm(parent, { recursive: true, force: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new DisposableWorkspaceError(
            DisposableWorkspaceErrorCode.CLEANUP_FAILED,
            "Disposable workspace cleanup exceeded its bounded deadline",
          ),
        ),
      CLEANUP_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([deletion, timeout]);
  } catch (error) {
    if (error instanceof DisposableWorkspaceError) throw error;
    throw new DisposableWorkspaceError(
      DisposableWorkspaceErrorCode.CLEANUP_FAILED,
      error instanceof Error ? error.message : "Disposable workspace cleanup failed",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run work against a one-shot exact tree copy and prove both write boundaries
 * before returning. The callback never receives the authoritative path.
 */
export async function runInDisposableWorkspace<T>(
  options: DisposableWorkspaceOptions,
  run: (disposableRoot: string) => Promise<T>,
): Promise<DisposableWorkspaceRunResult<T>> {
  const authoritativeRoot = await validateWorkspaceRoot(options.authoritativeRoot);
  await assertSafeVerificationTree(authoritativeRoot);
  const authoritativeTreeDigestBefore = await computeTreeDigest(authoritativeRoot);
  const parent = await mkdtemp(join(tmpdir(), "remoteagent-verification-"));
  const disposableRoot = join(parent, "workspace");
  let operationError: unknown;
  let operationFailed = false;

  try {
    await cp(authoritativeRoot, disposableRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (source) => basename(source) !== ".git",
    });
    const verifiedDisposableRoot = await validateWorkspaceRoot(disposableRoot);
    // Re-check both sides after copying. A symlink swapped after the initial
    // preflight must not become a trusted edge merely because its link text was
    // copied byte-for-byte and therefore produced a matching tree digest.
    await assertSafeVerificationTree(authoritativeRoot);
    await assertVerificationTreeHasNoGitEdges(verifiedDisposableRoot);
    await assertSafeVerificationTree(verifiedDisposableRoot);
    const disposableTreeDigestBefore = await computeTreeDigest(verifiedDisposableRoot);
    const authorityAfterCopy = await computeTreeDigest(authoritativeRoot);
    if (
      disposableTreeDigestBefore !== authoritativeTreeDigestBefore ||
      authorityAfterCopy !== authoritativeTreeDigestBefore
    ) {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.COPY_MISMATCH,
        "Disposable copy is not an exact snapshot of the authoritative tree",
      );
    }

    const mutableRoots = await validateMutableOutputs(
      verifiedDisposableRoot,
      options.mutableOutputs,
    );
    await assertMutableBoundary(verifiedDisposableRoot, mutableRoots);
    const protectedTreeDigestBefore = await protectedTreeDigest(
      verifiedDisposableRoot,
      mutableRoots,
    );
    let value: T;
    try {
      value = await run(verifiedDisposableRoot);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      value = undefined as T;
    }

    // Mutable roots are excluded from protected inventory, so their own path
    // components need an independent post-run confinement proof. Without it a
    // gate could replace an allowed root or ancestor with an outside symlink and
    // make the inventory deliberately look away from the escape edge.
    await assertMutableBoundary(verifiedDisposableRoot, mutableRoots);
    const authoritativeTreeDigestAfter = await computeTreeDigest(authoritativeRoot);
    const disposableTreeDigestAfter = await computeTreeDigest(verifiedDisposableRoot);
    const protectedTreeDigestAfter = await protectedTreeDigest(
      verifiedDisposableRoot,
      mutableRoots,
    );
    if (authoritativeTreeDigestAfter !== authoritativeTreeDigestBefore) {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.AUTHORITATIVE_TREE_CHANGED,
        "Authoritative tree changed during disposable verification",
      );
    }
    if (protectedTreeDigestAfter !== protectedTreeDigestBefore) {
      throw new DisposableWorkspaceError(
        DisposableWorkspaceErrorCode.PROTECTED_TREE_CHANGED,
        "Disposable tree changed outside canonical mutable outputs",
      );
    }
    if (operationFailed) throw operationError;

    return {
      value,
      evidence: {
        authoritativeTreeDigestBefore,
        authoritativeTreeDigestAfter,
        disposableTreeDigestBefore,
        disposableTreeDigestAfter,
        protectedTreeDigestBefore,
        protectedTreeDigestAfter,
      },
    };
  } finally {
    await cleanupVerificationTree(parent);
  }
}
