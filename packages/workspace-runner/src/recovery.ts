/* eslint-disable @typescript-eslint/no-explicit-any */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { inspectWorkspace } from "./digest.js";
import { createWorkspacePathPolicy } from "./path-policy.js";

export type WorkspaceMapping = Readonly<{
  workspaceId: string;
  caseId: string;
  repo: string;
  baseSha: string;
  branchName: string;
  target: string;
  treeDigest: string | null;
}>;

export interface WorkspaceMappingStore {
  find(workspaceId: string): Promise<WorkspaceMapping | null>;
  finalize(mapping: WorkspaceMapping, digest: string): Promise<boolean>;
}
export interface WorkspaceRegistry extends WorkspaceMappingStore {
  recordIntent(input: Omit<WorkspaceMapping, "treeDigest">): Promise<WorkspaceMapping>;
}

export function adaptWorkspaceRepository<
  T extends {
    find(q: unknown, id: string): Promise<any>;
    finalizeDigest(
      q: unknown,
      mapping: Omit<WorkspaceMapping, "target" | "treeDigest">,
      digest: string,
    ): Promise<boolean>;
    recordIntent(q: unknown, input: any): Promise<any>;
  },
>(repository: T, query: unknown, workspaceRoot: string): WorkspaceRegistry {
  return {
    async find(id) {
      const row = await repository.find(query, id);
      if (!row) return null;
      const policy = await createWorkspacePathPolicy(workspaceRoot);
      const target = await policy.validateCreateTarget(join(row.case_id, row.workspace_id));
      return {
        workspaceId: row.workspace_id,
        caseId: row.case_id,
        repo: row.repo,
        baseSha: row.base_sha ?? "",
        branchName: row.branch_name ?? "",
        target,
        treeDigest: row.tree_digest,
      };
    },
    async recordIntent(input) {
      const row = await repository.recordIntent(query, {
        workspaceId: input.workspaceId,
        caseId: input.caseId,
        repo: input.repo,
        baseSha: input.baseSha,
        branchName: input.branchName,
      });
      return { ...input, treeDigest: row.tree_digest };
    },
    async finalize(mapping, digest) {
      return repository.finalizeDigest(
        query,
        {
          workspaceId: mapping.workspaceId,
          caseId: mapping.caseId,
          repo: mapping.repo,
          baseSha: mapping.baseSha,
          branchName: mapping.branchName,
        },
        digest,
      );
    },
  };
}
export class InMemoryWorkspaceRegistry implements WorkspaceRegistry {
  private readonly rows = new Map<string, WorkspaceMapping>();
  public async find(id: string): Promise<WorkspaceMapping | null> {
    return this.rows.get(id) ?? null;
  }
  public async recordIntent(
    input: Omit<WorkspaceMapping, "treeDigest">,
  ): Promise<WorkspaceMapping> {
    const old = this.rows.get(input.workspaceId);
    if (old) {
      if (
        old.caseId !== input.caseId ||
        old.repo !== input.repo ||
        old.baseSha !== input.baseSha ||
        old.branchName !== input.branchName ||
        old.target !== input.target
      )
        throw new WorkspaceRecoveryError("CONFLICT", "Workspace intent conflict");
      return old;
    }
    const row = { ...input, treeDigest: null };
    this.rows.set(input.workspaceId, row);
    return row;
  }
  public async finalize(mapping: WorkspaceMapping, digest: string): Promise<boolean> {
    const old = this.rows.get(mapping.workspaceId);
    if (
      !old ||
      old.caseId !== mapping.caseId ||
      old.repo !== mapping.repo ||
      old.baseSha !== mapping.baseSha ||
      old.branchName !== mapping.branchName ||
      old.target !== mapping.target
    )
      return false;
    if (!old || old.treeDigest !== null) return false;
    this.rows.set(mapping.workspaceId, { ...old, treeDigest: digest });
    return true;
  }
}

export type RecoveryState = "CLEAN" | "DIRTY" | "AMBIGUOUS";
export type RecoveryResult = Readonly<{
  workspaceId: string;
  state: RecoveryState;
  mapping: WorkspaceMapping;
}>;

export class WorkspaceRecoveryError extends Error {
  public constructor(
    public readonly code: "MISSING_MAPPING" | "AMBIGUOUS" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRecoveryError";
  }
}

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

export async function recoverWorkspace(
  store: WorkspaceMappingStore,
  workspaceId: string,
  ledgerRoot?: string,
): Promise<RecoveryResult> {
  const mapping = await store.find(workspaceId);
  if (!mapping)
    throw new WorkspaceRecoveryError("MISSING_MAPPING", "Workspace mapping is required");
  const target = await realpath(mapping.target).catch(() => "");
  if (
    !target ||
    target !== mapping.target ||
    !(await lstat(target).catch(() => null))?.isDirectory()
  ) {
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace target is missing or non-canonical");
  }
  const policy = await createWorkspacePathPolicy(target);
  void policy;
  const configuredMetadataRoot = ledgerRoot ?? join(target, "..", ".workspace-runner-metadata");
  const canonicalParent = await realpath(dirname(configuredMetadataRoot)).catch(() => "");
  const parentStat = await lstat(dirname(configuredMetadataRoot)).catch(() => null);
  const metadataStat = await lstat(configuredMetadataRoot).catch(() => null);
  const canonicalMetadataRoot = await realpath(configuredMetadataRoot).catch(() => "");
  if (
    !metadataStat ||
    metadataStat.isSymbolicLink() ||
    !metadataStat.isDirectory() ||
    parentStat?.isSymbolicLink() ||
    canonicalMetadataRoot !== join(canonicalParent, basename(configuredMetadataRoot))
  )
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Operation metadata root is not canonical");
  const ledgerPath = join(canonicalMetadataRoot, "operations.jsonl");
  let ledger: string;
  try {
    const handle = await open(ledgerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const ledgerStat = await handle.stat();
      if (!ledgerStat.isFile() || ledgerStat.size > MAX_RECEIPT_BYTES)
        throw new Error("bounded read failed");
      ledger = await handle.readFile("utf8");
      if (!ledger || Buffer.byteLength(ledger) > MAX_RECEIPT_BYTES)
        throw new Error("bounded read failed");
    } finally {
      await handle.close();
    }
  } catch {
    throw new WorkspaceRecoveryError(
      "AMBIGUOUS",
      "Operation receipt is missing or bounded read failed",
    );
  }
  let receipt: Array<Record<string, unknown>>;
  try {
    receipt = ledger
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Operation receipt is corrupt");
  }
  const validReceipt = receipt.filter((item) => {
    const keys = Object.keys(item).sort().join(",");
    return (
      keys === "afterDigest,beforeDigest,identity,kind,operationId,outcome,version" &&
      item.version === 1 &&
      typeof item.kind === "string" &&
      /^[A-Z_]{1,64}$/.test(item.kind) &&
      (item.outcome === "SUCCEEDED" || item.outcome === "FAILED") &&
      (item.beforeDigest === null ||
        (typeof item.beforeDigest === "string" &&
          /^sha256:[0-9a-f]{64}$/.test(item.beforeDigest))) &&
      (item.afterDigest === null ||
        (typeof item.afterDigest === "string" && /^sha256:[0-9a-f]{64}$/.test(item.afterDigest))) &&
      typeof item.operationId === "string" &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(item.operationId) &&
      typeof item.identity === "object" &&
      item.identity !== null &&
      Object.keys(item.identity as object)
        .sort()
        .join(",") === "caseId,workspaceId" &&
      typeof (item.identity as any).caseId === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/.test((item.identity as any).caseId) &&
      typeof (item.identity as any).workspaceId === "string" &&
      /^[A-Za-z0-9._-]{1,128}$/.test((item.identity as any).workspaceId)
    );
  });
  if (validReceipt.length !== receipt.length)
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Matching operation receipt is required");
  const matchingReceipt = validReceipt.filter(
    (item) =>
      item.kind === "CREATE_WORKTREE" &&
      item.outcome === "SUCCEEDED" &&
      typeof item.afterDigest === "string" &&
      (item.identity as any).caseId === mapping.caseId &&
      (item.identity as any).workspaceId === workspaceId,
  );
  if (matchingReceipt.length !== 1)
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Matching operation receipt is required");
  let snapshot;
  try {
    snapshot = await inspectWorkspace(target);
  } catch {
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Workspace inspection failed");
  }
  const receiptDigest = matchingReceipt[0]?.afterDigest;
  if (mapping.treeDigest === null) {
    if (snapshot.dirtyState !== "CLEAN" || snapshot.treeDigest !== receiptDigest)
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Receipt and current workspace do not agree");
    if (!(await store.finalize(mapping, receiptDigest)))
      throw new WorkspaceRecoveryError("AMBIGUOUS", "Conditional recovery finalize failed");
    const finalized = await store.find(workspaceId);
    if (!finalized || finalized.treeDigest !== receiptDigest)
      throw new WorkspaceRecoveryError(
        "AMBIGUOUS",
        "Conditional recovery finalize was not durable",
      );
    return { workspaceId, state: "CLEAN", mapping: finalized };
  }
  if (receiptDigest !== mapping.treeDigest)
    throw new WorkspaceRecoveryError("AMBIGUOUS", "Receipt digest conflicts with mapping");
  const state: RecoveryState =
    snapshot.treeDigest === mapping.treeDigest && snapshot.dirtyState === "CLEAN"
      ? "CLEAN"
      : "DIRTY";
  return { workspaceId, state, mapping };
}

export async function finalizeWorkspace(
  store: WorkspaceMappingStore,
  mapping: WorkspaceMapping,
  digest: string,
): Promise<void> {
  if (!(await store.finalize(mapping, digest)))
    throw new WorkspaceRecoveryError("CONFLICT", "Workspace mapping changed during finalize");
}
