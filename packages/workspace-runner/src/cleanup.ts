import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { inspectWorkspace } from "./digest.js";
import type { OperationRecord } from "./operation-log.js";
import { createWorkspacePathPolicy } from "./path-policy.js";
import type { WorkspaceRegistry } from "./recovery.js";
import type { WorkspaceFenceValidator } from "./fencing.js";
import type { WorkspaceDestroyInput, WorkspaceDestroyResult } from "./types.js";

const runGit = promisify(execFile);
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

export class WorkspaceCleanupError extends Error {
  public constructor(
    public readonly code: "AMBIGUOUS" | "DIRTY" | "INVALID_TARGET" | "INVALID_FENCE" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceCleanupError";
  }
}

export type CleanupConfig = Readonly<{
  workspaceRoot: string;
  metadataRoot: string;
  repositories: Readonly<Record<string, { mirrorPath: string }>>;
  registry: WorkspaceRegistry;
  fenceValidator: WorkspaceFenceValidator;
  allowDirty?: boolean;
  allowAmbiguous?: boolean;
}>;

type CleanupTestSeam = Readonly<{
  gitRunner?: (args: readonly string[]) => Promise<void>;
  beforeLedgerAppend?: () => Promise<void>;
}>;

function exactIdentity(record: OperationRecord, input: WorkspaceDestroyInput): boolean {
  return (
    record.identity.caseId === input.identity.caseId &&
    record.identity.workspaceId === input.identity.workspaceId
  );
}

function cleanupOperationId(input: WorkspaceDestroyInput): string {
  return `cleanup-${input.identity.caseId}-${input.identity.workspaceId}`;
}

type LedgerRead = Readonly<{ records: OperationRecord[]; dev: number; ino: number }>;

async function readReceipts(metadataRoot: string): Promise<LedgerRead> {
  const parent = dirname(metadataRoot);
  const parentStat = await lstat(parent).catch(() => null);
  const rootStat = await lstat(metadataRoot).catch(() => null);
  const canonicalRoot = await realpath(metadataRoot).catch(() => "");
  if (
    !parentStat ||
    parentStat.isSymbolicLink() ||
    !rootStat ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    canonicalRoot !== join(await realpath(parent), basename(metadataRoot))
  )
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger root is not canonical");
  const path = join(canonicalRoot, "operations.jsonl");
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES)
        throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger is oversized or invalid");
      const content = await handle.readFile("utf8");
      if (Buffer.byteLength(content) > MAX_RECEIPT_BYTES)
        throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger is oversized");
      const records = content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      if (records.length === 0)
        throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger is empty");
      for (const record of records) {
        if (!isOperationRecord(record))
          throw new WorkspaceCleanupError(
            "AMBIGUOUS",
            "Operation ledger contains an invalid record",
          );
      }
      return { records: records as OperationRecord[], dev: stat.dev, ino: stat.ino };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof WorkspaceCleanupError) throw error;
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger is missing or corrupt");
  }
}

function isOperationRecord(value: unknown): value is OperationRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "afterDigest,beforeDigest,identity,kind,operationId,outcome,version"
  )
    return false;
  const identity = record.identity;
  return (
    record.version === 1 &&
    typeof record.operationId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(record.operationId) &&
    typeof record.kind === "string" &&
    /^[A-Z_]{1,64}$/.test(record.kind) &&
    (record.outcome === "SUCCEEDED" || record.outcome === "FAILED") &&
    (record.beforeDigest === null ||
      (typeof record.beforeDigest === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(record.beforeDigest))) &&
    (record.afterDigest === null ||
      (typeof record.afterDigest === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(record.afterDigest))) &&
    typeof identity === "object" &&
    identity !== null &&
    Object.keys(identity).sort().join(",") === "caseId,workspaceId" &&
    typeof (identity as Record<string, unknown>).caseId === "string" &&
    /^[A-Za-z0-9._-]{1,128}$/.test((identity as Record<string, unknown>).caseId as string) &&
    typeof (identity as Record<string, unknown>).workspaceId === "string" &&
    /^[A-Za-z0-9._-]{1,128}$/.test((identity as Record<string, unknown>).workspaceId as string)
  );
}

export async function cleanupWorkspace(
  config: CleanupConfig,
  input: WorkspaceDestroyInput,
): Promise<WorkspaceDestroyResult> {
  return cleanupWorkspaceInternal(config, input, {});
}

/** @internal Test-only source entry; deliberately not re-exported from package index. */
export async function cleanupWorkspaceWithTestSeam(
  config: CleanupConfig,
  input: WorkspaceDestroyInput,
  seam: CleanupTestSeam,
): Promise<WorkspaceDestroyResult> {
  return cleanupWorkspaceInternal(config, input, seam);
}

async function cleanupWorkspaceInternal(
  config: CleanupConfig,
  input: WorkspaceDestroyInput,
  seam: CleanupTestSeam,
): Promise<WorkspaceDestroyResult> {
  const mapping = await config.registry.find(input.identity.workspaceId);
  if (!mapping || mapping.caseId !== input.identity.caseId)
    throw new WorkspaceCleanupError("CONFLICT", "Exact workspace mapping is required");
  const policy = await createWorkspacePathPolicy(config.workspaceRoot).catch(() => {
    throw new WorkspaceCleanupError("INVALID_TARGET", "Workspace root is invalid");
  });
  const expected = join(policy.root, input.identity.caseId, input.identity.workspaceId);
  const target = mapping.target;
  const targetRelative = relative(policy.root, target);
  if (
    !targetRelative ||
    targetRelative === ".." ||
    targetRelative.startsWith(`..${sep}`) ||
    resolve(target) !== expected
  )
    throw new WorkspaceCleanupError(
      "INVALID_TARGET",
      "Workspace target is not the exact verified child",
    );
  const repository = config.repositories[mapping.repo];
  if (!repository) throw new WorkspaceCleanupError("CONFLICT", "Repository is not configured");
  const ledgerRead = await readReceipts(config.metadataRoot);
  const receipts = ledgerRead.records;
  const operationId = cleanupOperationId(input);
  const cleanupReceipts = receipts.filter(
    (record) => exactIdentity(record, input) && record.kind === "CLEANUP_WORKTREE",
  );
  if (
    cleanupReceipts.some((record) => record.operationId !== operationId) ||
    cleanupReceipts.filter((record) => record.operationId === operationId).length > 1
  )
    throw new WorkspaceCleanupError("AMBIGUOUS", "Conflicting cleanup receipts exist");
  const priorSuccess =
    cleanupReceipts.length === 1 &&
    cleanupReceipts[0]?.operationId === operationId &&
    cleanupReceipts[0].outcome === "SUCCEEDED" &&
    cleanupReceipts[0].beforeDigest === mapping.treeDigest &&
    cleanupReceipts[0].afterDigest === null;
  const targetStat = await lstat(target).catch(() => null);
  if (!targetStat) {
    if (priorSuccess)
      return { operationId: operationId, identity: input.identity, lifecycle: "DESTROYED" };
    throw new WorkspaceCleanupError(
      "AMBIGUOUS",
      "Missing target has no successful cleanup receipt",
    );
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory())
    throw new WorkspaceCleanupError("INVALID_TARGET", "Workspace target must be a real directory");
  const canonicalTarget = await realpath(target).catch(() => "");
  if (canonicalTarget !== target)
    throw new WorkspaceCleanupError("INVALID_TARGET", "Workspace target is not canonical");
  const destructive = await policy.validateDestructiveTarget(targetRelative).catch(() => {
    throw new WorkspaceCleanupError(
      "INVALID_TARGET",
      "Workspace target is outside the verified root",
    );
  });
  if (destructive !== target)
    throw new WorkspaceCleanupError("INVALID_TARGET", "Workspace target changed during validation");
  const snapshot = await inspectWorkspace(target).catch(() => {
    throw new WorkspaceCleanupError("AMBIGUOUS", "Workspace inspection failed");
  });
  if (snapshot.dirtyState === "DIRTY" && !config.allowDirty)
    throw new WorkspaceCleanupError("DIRTY", "Dirty workspace requires explicit cleanup policy");
  if (mapping.treeDigest === null && !config.allowAmbiguous)
    throw new WorkspaceCleanupError(
      "AMBIGUOUS",
      "Unfinalized workspace requires explicit cleanup policy",
    );
  await validateLedgerDestination(config.metadataRoot);
  const ledgerHandle = await openPinnedLedger(config.metadataRoot, ledgerRead);
  try {
    await config.fenceValidator.assertCurrent({ identity: input.identity, fence: input.fence });
    const finalStat = await lstat(target).catch(() => null);
    const finalCanonical = await realpath(target).catch(() => "");
    if (
      !finalStat ||
      finalStat.isSymbolicLink() ||
      !finalStat.isDirectory() ||
      finalCanonical !== target
    )
      throw new WorkspaceCleanupError("AMBIGUOUS", "Workspace target changed before removal");
    const finalDestructive = await policy.validateDestructiveTarget(targetRelative).catch(() => {
      throw new WorkspaceCleanupError("AMBIGUOUS", "Workspace target changed before removal");
    });
    if (finalDestructive !== target)
      throw new WorkspaceCleanupError("AMBIGUOUS", "Workspace target changed before removal");
    const executeGit =
      seam.gitRunner ??
      (async (args: readonly string[]) => {
        await runGit("git", args, { maxBuffer: 1024 * 1024 });
      });
    try {
      await executeGit([
        "--git-dir",
        repository.mirrorPath,
        "worktree",
        "remove",
        "--force",
        target,
      ]);
      await config.fenceValidator.assertCurrent({ identity: input.identity, fence: input.fence });
      await executeGit(["--git-dir", repository.mirrorPath, "worktree", "prune"]);
    } catch (error) {
      throw new WorkspaceCleanupError(
        "AMBIGUOUS",
        `Cleanup Git outcome is ambiguous: ${error instanceof Error ? error.message : "unknown failure"}`,
      );
    }
    await config.fenceValidator.assertCurrent({ identity: input.identity, fence: input.fence });
    await validateLedgerDestination(config.metadataRoot);
    await seam.beforeLedgerAppend?.();
    await validateLedgerDestination(config.metadataRoot);
    await assertLedgerIdentity(config.metadataRoot, ledgerHandle, ledgerRead);
    const record = {
      version: 1 as const,
      operationId,
      identity: input.identity,
      kind: "CLEANUP_WORKTREE",
      beforeDigest: mapping.treeDigest,
      afterDigest: null,
      outcome: "SUCCEEDED" as const,
    } satisfies OperationRecord;
    const line = `${JSON.stringify(record)}\n`;
    const currentSize = (await ledgerHandle.stat()).size;
    if (currentSize + Buffer.byteLength(line) > MAX_RECEIPT_BYTES)
      throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger exceeds bounded size");
    await ledgerHandle.write(line, undefined, "utf8");
    return {
      operationId,
      identity: input.identity,
      lifecycle: "DESTROYED",
    };
  } finally {
    await ledgerHandle.close();
  }
}

async function openPinnedLedger(metadataRoot: string, expected: LedgerRead) {
  const root = resolve(metadataRoot);
  const parent = dirname(root);
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger root is unavailable");
  const parentHandle = await open(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger parent cannot be pinned");
  });
  const handle = await open(
    join(root, "operations.jsonl"),
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  ).catch(async () => {
    await parentHandle.close();
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger cannot be pinned");
  });
  await parentHandle.close();
  try {
    const stat = await handle.stat();
    if (
      stat.isFile() &&
      stat.size <= MAX_RECEIPT_BYTES &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino
    )
      return handle;
  } catch {
    await handle.close();
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger cannot be inspected");
  }
  await handle.close();
  throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger is invalid or oversized");
}

async function assertLedgerIdentity(
  metadataRoot: string,
  handle: Awaited<ReturnType<typeof open>>,
  expected: LedgerRead,
): Promise<void> {
  const path = join(resolve(metadataRoot), "operations.jsonl");
  const pathStat = await lstat(path).catch(() => null);
  const handleStat = await handle.stat().catch(() => null);
  if (
    !pathStat?.isFile() ||
    !handleStat ||
    pathStat.dev !== expected.dev ||
    pathStat.ino !== expected.ino ||
    handleStat.dev !== expected.dev ||
    handleStat.ino !== expected.ino
  )
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger inode changed");
}

async function validateLedgerDestination(metadataRoot: string): Promise<void> {
  const parent = dirname(metadataRoot);
  const parentStat = await lstat(parent).catch(() => null);
  const rootStat = await lstat(metadataRoot).catch(() => null);
  const canonicalParent = await realpath(parent).catch(() => "");
  const canonicalRoot = await realpath(metadataRoot).catch(() => "");
  if (
    !parentStat ||
    parentStat.isSymbolicLink() ||
    !rootStat ||
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    canonicalRoot !== join(canonicalParent, basename(metadataRoot))
  )
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger destination changed");
  const operations = join(canonicalRoot, "operations.jsonl");
  const operationsStat = await lstat(operations).catch(() => null);
  if (operationsStat?.isSymbolicLink())
    throw new WorkspaceCleanupError("AMBIGUOUS", "Operation ledger file changed");
}
