/**
 * The two mutating, model-facing tools: `write` (one file) and `patch` (many).
 *
 * A filesystem gives no transaction. N files cannot be made to land atomically,
 * so an interrupted multi-file write leaves a state that is neither the
 * pre-state nor the post-state. The entire design of this module follows from
 * that single fact: the interesting property is not "write the files", it is that
 * **no code path leads from a partial write to `SUCCEEDED`**.
 *
 * Three mechanisms make that structural rather than conventional.
 *
 * 1. **Journal before the side effect.** The operation is split into a
 *    non-mutating pre-flight (tree pre-digest + path policy validation of every
 *    target) and a mutating phase. The intent — the full declared write surface
 *    plus that pre-digest — is committed to the durable ledger from
 *    `./ledger.js` *between* the two, so the first `open(2)` for writing cannot
 *    happen before an `INTENT_RECORDED` row is visible to every other process.
 *    The pre-digest is read from disk before the claim because it *is* part of
 *    the intent; reading is not a side effect, and `test/patch.integration.test.ts`
 *    asserts from a separate connection that the tree is still byte-identical to
 *    the pre-digest at the moment the first write is about to happen.
 *
 * 2. **`changed_files` is accumulated pessimistically.** A path is appended to
 *    the touched list *immediately before* its `open`, never after the write
 *    returns. So the list means "may have been changed": every file already
 *    written, plus the one in flight (which may have been created or truncated
 *    even though its write never completed). Files that were never opened are
 *    provably unchanged and stay out of the list. An empty list therefore proves
 *    that no mutation was even attempted, which is the *only* condition under
 *    which the mutating phase may report `FAILED` — the contract's
 *    `changed_files: max(0)` on `FAILED` makes a mutating failure unrepresentable,
 *    and this module honours that by reporting `AMBIGUOUS` instead.
 *
 * 3. **The model-facing envelope is derived from the durable ledger row**, never
 *    from in-memory belief about how the write went. `SUCCEEDED` is emitted only
 *    when the ledger says `SUCCEEDED`, which migration 027's CHECK constraints
 *    make impossible without a verified `after_digest`, and which
 *    `OperationLedgerRepository.settle`'s fence makes impossible to reach from an
 *    already-settled `AMBIGUOUS`. A replay — including one from a brand-new
 *    process over the same database — therefore reports the *recorded* outcome
 *    and performs no second effect.
 *
 * The one `SUCCEEDED` receipt in this file is guarded by two independent
 * observations, both of which happen after every write returned: each target is
 * re-read and compared byte-for-byte with the content that was requested, and
 * the workspace tree digest is recomputed. If either cannot be established the
 * outcome is `AMBIGUOUS` / `UNVERIFIED_POST_STATE` — a post-state can only be
 * observed, never assumed.
 *
 * Deliberately out of scope: creating directories (a missing parent is a clean
 * pre-flight `FAILED`, and `mkdir` is its own unit), running commands, and Git.
 * Failure *messages* never travel: policy messages embed absolute host paths and
 * this output is model-visible, so only stable codes (and bare `errno` names)
 * are carried.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

import {
  TrustLevel,
  canonicalDigest,
  canonicalJsonStringify,
  idString,
  sha256Digest,
  text,
} from "@remoteagent/contracts";
import type { Transaction } from "@remoteagent/database";
import {
  WorkspacePathPolicyError,
  computeTreeDigest,
  createWorkspacePathPolicy,
} from "@remoteagent/workspace-runner";
import type { VerifiedWorkspacePath, WorkspacePathPolicy } from "@remoteagent/workspace-runner";
import * as z from "zod";

import {
  AmbiguityReason,
  MAX_CHANGED_FILES,
  MAX_TOOL_OUTPUT_BYTES,
  ToolKind,
  ToolOutcome,
  implementationToolResult,
  workspaceRelativePath,
} from "./contracts.js";
import type { ImplementationToolResult, ToolIdentity, ToolOutput } from "./contracts.js";
import { OperationStatus, runExactlyOnce } from "./ledger.js";
import type { OperationLedgerRepository, OperationReceipt, OperationRecord } from "./ledger.js";

/** Upper bound on one written file, in UTF-8 bytes. */
export const MAX_WRITE_FILE_BYTES = 65_536;

/** Upper bound on one operation's total payload, in UTF-8 bytes. */
export const MAX_WRITE_TOTAL_BYTES = 1_048_576;

/** The request violated the write contract; no filesystem state was touched. */
export const INVALID_WRITE_REQUEST = "INVALID_REQUEST";

/** The workspace is not the pre-state the caller pinned; nothing was written. */
export const WRITE_PRE_STATE_MISMATCH = "PRE_STATE_MISMATCH";

/** The target exists and is not a regular file (directory, socket, device). */
export const WRITE_TARGET_NOT_A_FILE = "TARGET_NOT_A_FILE";

/** The target's parent directory does not exist; this tool never creates one. */
export const WRITE_PARENT_NOT_A_DIRECTORY = "PARENT_NOT_A_DIRECTORY";

/** An exact text replacement did not occur exactly once; nothing was written. */
export const WRITE_REPLACEMENT_MISMATCH = "REPLACEMENT_MISMATCH";

/** The requested post-state is byte-identical to the current file; nothing was written. */
export const WRITE_NO_CHANGE = "NO_CHANGE";

/** Last-resort code for a fault with no stable classification. */
export const WRITE_TOOL_FAILED = "WRITE_TOOL_FAILED";

/** The two mutating tools. */
export type ImplementationWriteToolName = "write" | "patch";

/**
 * Raised by the non-mutating pre-flight. The message is the code itself, so a
 * host path can never reach a model-visible envelope through it.
 */
export class ImplementationWriteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly repairContext: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(code);
    this.name = "ImplementationWriteError";
  }
}

const encoder = new TextEncoder();
const MAX_REPAIR_EXCERPT_BYTES = 8_192;

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function boundedUtf8Prefix(value: string, maximumBytes: number): string {
  if (byteLength(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = value.slice(0, mid);
    if (byteLength(candidate) <= maximumBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function replacementRepairContext(
  relativePath: string,
  content: string,
  oldContent: string,
  replacementIndex: number,
): Readonly<Record<string, unknown>> {
  const anchor = oldContent
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length >= 4 && content.includes(line));
  const anchorOffset = anchor === undefined ? 0 : Math.max(0, content.indexOf(anchor) - 512);
  const remainingContent = content.slice(anchorOffset);
  const excerpt = boundedUtf8Prefix(remainingContent, MAX_REPAIR_EXCERPT_BYTES);
  return Object.freeze({
    relative_path: relativePath,
    replacement_index: replacementIndex,
    expected_old_content_digest: canonicalDigest(oldContent),
    current_excerpt: excerpt,
    current_excerpt_digest: canonicalDigest(excerpt),
    current_excerpt_complete: anchorOffset === 0 && excerpt === content,
  });
}

type PlannedReplacement = Readonly<{
  start: number;
  end: number;
  newContent: string;
}>;

/**
 * Plan every exact replacement against the same immutable file snapshot.
 *
 * Applying hunks sequentially makes an earlier hunk capable of creating a second occurrence of a
 * later hunk's `old_content`, even though every requested anchor was unique in the bytes the model
 * actually inspected. Planning first and applying from the end preserves exact-match semantics,
 * keeps offsets stable, and still refuses genuinely overlapping edits before the first write.
 */
function applySnapshotReplacements(
  relativePath: string,
  currentContent: string,
  replacements: readonly Readonly<{ old_content: string; new_content: string }>[],
): string {
  const planned = replacements.map((replacement, replacementIndex): PlannedReplacement => {
    const start = currentContent.indexOf(replacement.old_content);
    const lastStart = currentContent.lastIndexOf(replacement.old_content);
    if (start < 0 || start !== lastStart) {
      throw new ImplementationWriteError(
        WRITE_REPLACEMENT_MISMATCH,
        replacementRepairContext(
          relativePath,
          currentContent,
          replacement.old_content,
          replacementIndex,
        ),
      );
    }
    return Object.freeze({
      start,
      end: start + replacement.old_content.length,
      newContent: replacement.new_content,
    });
  });
  const ascending = [...planned].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ascending.length; index += 1) {
    if (ascending[index]!.start < ascending[index - 1]!.end) {
      throw new ImplementationWriteError(INVALID_WRITE_REQUEST);
    }
  }
  return [...ascending]
    .reverse()
    .reduce(
      (content, replacement) =>
        `${content.slice(0, replacement.start)}${replacement.newContent}${content.slice(replacement.end)}`,
      currentContent,
    );
}

const requestedFile = z.strictObject({
  relative_path: workspaceRelativePath,
  content: text,
});

const requestedReplacementFile = z.strictObject({
  relative_path: workspaceRelativePath,
  replacements: z
    .array(
      z.strictObject({
        old_content: z.string().min(1),
        new_content: z.string(),
      }),
    )
    .min(1)
    .max(128),
});

function uniquePaths(
  values: readonly Readonly<{ relative_path: string }>[],
  field: "files" | "replacement_files",
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.relative_path)) {
      ctx.addIssue({ code: "custom", message: "paths must be unique", path: [field] });
    }
    seen.add(value.relative_path);
  }
}

/**
 * A multi-file write request.
 *
 * Two paths cannot repeat inside one operation: the ledger records a single
 * declared write surface per `operation_id`, and two edits to one path would make
 * the surviving content depend on iteration order — an ordering the caller cannot
 * observe and reconciliation could not reproduce.
 */
const completePatchRequest = z
  .strictObject({
    operation_id: idString,
    files: z.array(requestedFile).min(1).max(MAX_CHANGED_FILES),
    /** Optimistic pre-state pin; a mismatch is refused before any mutation. */
    expected_before_digest: sha256Digest.nullish(),
  })
  .superRefine((request, ctx) => {
    uniquePaths(request.files, "files", ctx);
    let total = 0;
    for (const file of request.files) {
      const bytes = byteLength(file.content);
      total += bytes;
      if (bytes > MAX_WRITE_FILE_BYTES) {
        ctx.addIssue({
          code: "custom",
          message: `file content must not exceed ${String(MAX_WRITE_FILE_BYTES)} bytes`,
          path: ["files"],
        });
      }
    }
    if (total > MAX_WRITE_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `total content must not exceed ${String(MAX_WRITE_TOTAL_BYTES)} bytes`,
        path: ["files"],
      });
    }
  });

const replacementPatchRequest = z
  .strictObject({
    operation_id: idString,
    replacement_files: z.array(requestedReplacementFile).min(1).max(MAX_CHANGED_FILES),
    expected_before_digest: sha256Digest.nullish(),
  })
  .superRefine((request, ctx) => {
    uniquePaths(request.replacement_files, "replacement_files", ctx);
    let total = 0;
    for (const [fileIndex, file] of request.replacement_files.entries()) {
      const seen = new Set<string>();
      for (const [replacementIndex, replacement] of file.replacements.entries()) {
        if (seen.has(replacement.old_content)) {
          ctx.addIssue({
            code: "custom",
            message: "old_content values must be unique per file",
            path: ["replacement_files", fileIndex, "replacements", replacementIndex],
          });
        }
        seen.add(replacement.old_content);
        const bytes = byteLength(replacement.old_content) + byteLength(replacement.new_content);
        total += bytes;
        if (bytes > MAX_WRITE_FILE_BYTES) {
          ctx.addIssue({
            code: "custom",
            message: `one replacement must not exceed ${String(MAX_WRITE_FILE_BYTES)} bytes`,
            path: ["replacement_files", fileIndex, "replacements", replacementIndex],
          });
        }
      }
    }
    if (total > MAX_WRITE_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `total replacement text must not exceed ${String(MAX_WRITE_TOTAL_BYTES)} bytes`,
        path: ["replacement_files"],
      });
    }
  });

export const implementationPatchRequest = z.union([completePatchRequest, replacementPatchRequest]);

export type ImplementationPatchRequest = z.infer<typeof implementationPatchRequest>;

/** One step of the mutating phase, in the deterministic (sorted) write order. */
export type ImplementationWriteProgress = Readonly<{
  /** 0-based position in the write order. */
  index: number;
  total: number;
  relative_path: string;
}>;

/**
 * Fault-injection and progress seam for the mutating phase.
 *
 * This exists so an interruption can be made to happen for real — a throw from
 * `afterFile` aborts the sequence with part of the batch already on disk, and a
 * concurrent mutation performed from `beforeFile` reproduces a genuine
 * `open(2)` failure mid-batch. Whatever an observer does, it cannot influence how
 * the outcome is classified: once a path has been appended to the touched list,
 * every remaining exit is `AMBIGUOUS`.
 */
export type ImplementationWriteObserver = Readonly<{
  beforeFile?: (event: ImplementationWriteProgress) => Promise<void> | void;
  afterFile?: (event: ImplementationWriteProgress) => Promise<void> | void;
}>;

export type ImplementationWriteToolsOptions = Readonly<{
  /** Workspace root; validated by the workspace-runner path policy. */
  root: string;
  identity: ToolIdentity;
  ledger: OperationLedgerRepository;
  /**
   * Transaction boundary for ledger writes only. Injected (rather than a
   * `Database`) for the same reason the ledger does it: the side effect must not
   * run while a pooled connection is held open.
   */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  /**
   * Server-owned writer fence, re-checked after all preflight/observer work and
   * immediately before every filesystem mutation. A rejection before the first
   * syscall is a clean FAILED; a rejection between files is AMBIGUOUS.
   */
  beforeMutation?: (event: ImplementationWriteProgress) => Promise<void>;
  observer?: ImplementationWriteObserver;
  /**
   * Optional code-owned content policy evaluated over the complete bytes that would be written.
   * It runs during read-only preflight, before an operation intent or filesystem syscall exists.
   * Returning a stable code refuses the whole batch without consuming the operation id.
   */
  contentPolicy?: (file: Readonly<{ relative_path: string; content: string }>) => string | null;
}>;

export type ImplementationWriteInput = Readonly<{
  operation_id: string;
  relative_path: string;
  content: string;
  expected_before_digest?: string | null;
}>;

export type ImplementationPatchInput =
  | Readonly<{
      operation_id: string;
      files: readonly Readonly<{ relative_path: string; content: string }>[];
      expected_before_digest?: string | null;
    }>
  | Readonly<{
      operation_id: string;
      replacement_files: readonly Readonly<{
        relative_path: string;
        replacements: readonly Readonly<{ old_content: string; new_content: string }>[];
      }>[];
      expected_before_digest?: string | null;
    }>;

export type ImplementationWriteTools = Readonly<{
  write(input: ImplementationWriteInput): Promise<ImplementationToolResult>;
  patch(input: ImplementationPatchInput): Promise<ImplementationToolResult>;
}>;

/** Re-checks at the syscall what the path policy checked at validation time. */
const NOFOLLOW = constants.O_NOFOLLOW;

type PlannedFile = Readonly<{
  relativePath: string;
  target: VerifiedWorkspacePath;
  content: Buffer;
}>;

type WritePlan = Readonly<{
  operationId: string;
  beforeDigest: string;
  files: readonly PlannedFile[];
  /** The declared write surface, in write order. */
  paths: readonly string[];
}>;

/** Diagnostic carried out of the mutating phase; `null` for a replay. */
interface Diagnostics {
  errorCode: string | null;
}

/**
 * Map a thrown fault onto a stable code. Only codes travel: policy messages and
 * `errno` messages embed absolute host paths, and this output is model-visible.
 */
function failureCode(error: unknown): string {
  if (error instanceof ImplementationWriteError) return error.code;
  if (error instanceof WorkspacePathPolicyError) return error.code;
  const errno = errnoOf(error);
  return errno === null ? WRITE_TOOL_FAILED : `FS_${errno}`;
}

/** Bare `errno` name (`EISDIR`, `EACCES`, ...) — a code, never a path. */
function errnoOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && /^E[A-Z]{1,15}$/.test(code) ? code : null;
}

/**
 * Non-mutating pre-flight: everything that can be refused *without* touching
 * workspace state happens here, so a refusal is a clean `FAILED` with an empty
 * `changed_files` and no ledger row at all.
 *
 * The write order is the byte order of the target paths, not the caller's array
 * order, so the set of files already on disk after an interruption at step `k` is
 * reproducible from the request alone.
 */
async function preflight(
  policy: WorkspacePathPolicy,
  root: VerifiedWorkspacePath,
  request: ImplementationPatchRequest,
  contentPolicy?: ImplementationWriteToolsOptions["contentPolicy"],
  allowNoChange = false,
): Promise<WritePlan> {
  const beforeDigest = await computeTreeDigest(root);
  const pinned = request.expected_before_digest;
  if (pinned !== undefined && pinned !== null && pinned !== beforeDigest) {
    throw new ImplementationWriteError(
      WRITE_PRE_STATE_MISMATCH,
      Object.freeze({ observed_before_digest: beforeDigest }),
    );
  }
  const requested =
    "files" in request
      ? request.files
      : await Promise.all(
          request.replacement_files.map(async (file) => {
            const target = await policy.validateCreateTarget(file.relative_path);
            const existing = await lstat(target).catch(() => null);
            if (existing === null || !existing.isFile()) {
              throw new ImplementationWriteError(WRITE_TARGET_NOT_A_FILE);
            }
            const handle = await open(target, constants.O_RDONLY | NOFOLLOW).catch(() => {
              throw new ImplementationWriteError(WRITE_TOOL_FAILED);
            });
            let content: string;
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > MAX_WRITE_TOTAL_BYTES) {
                throw new ImplementationWriteError(WRITE_TARGET_NOT_A_FILE);
              }
              const bytes = await handle.readFile();
              content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch (error) {
              if (error instanceof ImplementationWriteError) throw error;
              throw new ImplementationWriteError(WRITE_TOOL_FAILED);
            } finally {
              await handle.close();
            }
            const currentContent = content;
            content = applySnapshotReplacements(file.relative_path, content, file.replacements);
            if (!allowNoChange && content === currentContent) {
              throw new ImplementationWriteError(WRITE_NO_CHANGE);
            }
            if (byteLength(content) > MAX_WRITE_TOTAL_BYTES) {
              throw new ImplementationWriteError(INVALID_WRITE_REQUEST);
            }
            return { relative_path: file.relative_path, content };
          }),
        );
  const ordered = [...requested].sort((left, right) =>
    left.relative_path < right.relative_path
      ? -1
      : left.relative_path > right.relative_path
        ? 1
        : 0,
  );
  for (const file of ordered) {
    const refusal = contentPolicy?.({
      relative_path: file.relative_path,
      content: file.content,
    });
    if (refusal !== undefined && refusal !== null) {
      throw new ImplementationWriteError(refusal);
    }
  }
  const files: PlannedFile[] = [];
  for (const file of ordered) {
    const target = await policy.validateCreateTarget(file.relative_path);
    const existing = await lstat(target).catch(() => null);
    if (existing !== null && !existing.isFile()) {
      throw new ImplementationWriteError(WRITE_TARGET_NOT_A_FILE);
    }
    if ("files" in request && existing !== null) {
      const handle = await open(target, constants.O_RDONLY | NOFOLLOW).catch(() => {
        throw new ImplementationWriteError(WRITE_TOOL_FAILED);
      });
      try {
        const current = await handle.readFile();
        if (!allowNoChange && current.equals(Buffer.from(file.content))) {
          throw new ImplementationWriteError(WRITE_NO_CHANGE);
        }
      } catch (error) {
        if (error instanceof ImplementationWriteError) throw error;
        throw new ImplementationWriteError(WRITE_TOOL_FAILED);
      } finally {
        await handle.close();
      }
    }
    const parent = await lstat(dirname(target)).catch(() => null);
    if (parent === null || !parent.isDirectory()) {
      throw new ImplementationWriteError(WRITE_PARENT_NOT_A_DIRECTORY);
    }
    files.push({ relativePath: file.relative_path, target, content: Buffer.from(file.content) });
  }
  return {
    operationId: request.operation_id,
    beforeDigest,
    files,
    paths: files.map((file) => file.relativePath),
  };
}

/**
 * Write one file. `O_NOFOLLOW` re-checks at the syscall what the path policy
 * checked earlier, so a target swapped for a symlink between validation and write
 * fails loudly instead of writing through the link.
 */
async function writeOne(file: PlannedFile): Promise<void> {
  const handle = await open(
    file.target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(file.content);
    // Make the (possibly partial) batch durable: a crash must leave evidence on
    // disk that matches what the ledger says may have changed.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Re-read every target and compare bytes. A write that returned is not proof. */
async function contentsMatch(files: readonly PlannedFile[]): Promise<boolean> {
  for (const file of files) {
    const handle = await open(file.target, constants.O_RDONLY | NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) return false;
      if (!(await handle.readFile()).equals(file.content)) return false;
    } finally {
      await handle.close();
    }
  }
  return true;
}

/** Best-effort post-state digest; `null` is an honest "could not observe". */
async function digestOrNull(root: VerifiedWorkspacePath): Promise<string | null> {
  return computeTreeDigest(root).catch(() => null);
}

/**
 * The mutating phase. Enumerating its exits is the point of this module:
 *
 * - a fault with an EMPTY touched list -> `FAILED`. Reachable only before the
 *   first `open`, so nothing can have changed;
 * - a fault with a NON-EMPTY touched list -> `AMBIGUOUS` / `PARTIAL_WRITE`;
 * - all writes returned but a re-read disagrees, or the post-state digest cannot
 *   be computed -> `AMBIGUOUS` / `UNVERIFIED_POST_STATE`;
 * - all writes returned, every re-read matches, and the tree digest was observed
 *   -> `SUCCEEDED`. This is the only success construction in the file.
 *
 * There is no `catch` that produces a success, and no exit that reports `FAILED`
 * after a path was appended to the touched list.
 */
async function performWrites(
  root: VerifiedWorkspacePath,
  plan: WritePlan,
  beforeMutation: ImplementationWriteToolsOptions["beforeMutation"],
  observer: ImplementationWriteObserver | undefined,
  diagnostics: Diagnostics,
): Promise<OperationReceipt> {
  const touched: string[] = [];
  try {
    for (const [index, file] of plan.files.entries()) {
      const event: ImplementationWriteProgress = {
        index,
        total: plan.files.length,
        relative_path: file.relativePath,
      };
      await observer?.beforeFile?.(event);
      await beforeMutation?.(event);
      // Pessimistic by construction: the path counts as possibly-changed BEFORE
      // the syscall that could change it, never after it returns.
      touched.push(file.relativePath);
      await writeOne(file);
      await observer?.afterFile?.(event);
    }
  } catch (error) {
    diagnostics.errorCode = failureCode(error);
    if (touched.length === 0) {
      // No `open` was attempted, so this failure is provably non-mutating and the
      // contract's empty `changed_files` on FAILED is honest.
      return { outcome: ToolOutcome.FAILED, failureCode: diagnostics.errorCode };
    }
    return {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: AmbiguityReason.PARTIAL_WRITE,
      afterDigest: await digestOrNull(root),
      changedFiles: touched,
    };
  }

  try {
    if (await contentsMatch(plan.files)) {
      return {
        outcome: ToolOutcome.SUCCEEDED,
        afterDigest: await computeTreeDigest(root),
        changedFiles: touched,
      };
    }
    diagnostics.errorCode = WRITE_TOOL_FAILED;
    return {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: AmbiguityReason.UNVERIFIED_POST_STATE,
      afterDigest: await digestOrNull(root),
      changedFiles: touched,
    };
  } catch (error) {
    diagnostics.errorCode = failureCode(error);
    return {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: AmbiguityReason.UNVERIFIED_POST_STATE,
      afterDigest: null,
      changedFiles: touched,
    };
  }
}

/** Envelope-ready shape, decided solely from the durable ledger row. */
type Decision =
  | Readonly<{
      outcome: typeof ToolOutcome.SUCCEEDED;
      afterDigest: string;
      changedFiles: readonly string[];
    }>
  | Readonly<{
      outcome: typeof ToolOutcome.FAILED;
      afterDigest: string | null;
      failureCode: string;
    }>
  | Readonly<{
      outcome: typeof ToolOutcome.AMBIGUOUS;
      afterDigest: string | null;
      changedFiles: readonly string[];
      ambiguityReason: AmbiguityReason;
    }>;

/**
 * Translate a ledger row into the outcome the model is told about.
 *
 * `SUCCEEDED` requires the row to BE `SUCCEEDED` *and* to carry a digest; an
 * `INTENT_RECORDED` row (a crashed or still-running attempt) is `AMBIGUOUS`, so a
 * replay that arrives while the effect is unresolved can never report success.
 */
function decide(record: OperationRecord): Decision {
  if (record.status === OperationStatus.SUCCEEDED && record.afterDigest !== null) {
    return {
      outcome: ToolOutcome.SUCCEEDED,
      afterDigest: record.afterDigest,
      changedFiles: record.changedFiles,
    };
  }
  if (record.status === OperationStatus.FAILED) {
    return {
      outcome: ToolOutcome.FAILED,
      afterDigest: record.afterDigest,
      failureCode: record.failureCode ?? WRITE_TOOL_FAILED,
    };
  }
  return {
    outcome: ToolOutcome.AMBIGUOUS,
    afterDigest: record.afterDigest,
    changedFiles: record.changedFiles,
    ambiguityReason: record.ambiguityReason ?? AmbiguityReason.INTERRUPTED,
  };
}

/** Largest `n` in `[0, hi]` whose rendering fits the output bound. */
function largestFitting(hi: number, render: (kept: number) => string): number {
  let low = 0;
  let high = hi;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(render(mid)) <= MAX_TOOL_OUTPUT_BYTES) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Render the model-facing payload. Clipping is never silent: whole paths are
 * dropped, the count of dropped paths is stated, `complete` goes false and the
 * envelope declares the pre-clip byte length.
 */
function render(
  tool: ImplementationWriteToolName,
  decision: Decision,
  errorCode: string | null,
  repairContext: Readonly<Record<string, unknown>> | null,
): ToolOutput {
  const paths = decision.outcome === ToolOutcome.FAILED ? [] : decision.changedFiles;
  const body = (kept: number, complete: boolean): Record<string, unknown> => ({
    tool,
    outcome: decision.outcome,
    complete,
    requires_reconciliation: decision.outcome === ToolOutcome.AMBIGUOUS,
    ambiguity_reason: decision.outcome === ToolOutcome.AMBIGUOUS ? decision.ambiguityReason : null,
    failure_code: decision.outcome === ToolOutcome.FAILED ? decision.failureCode : null,
    error_code: errorCode,
    repair_context: decision.outcome === ToolOutcome.FAILED ? repairContext : null,
    dropped: paths.length - kept,
    changed_files: paths.slice(0, kept),
  });
  const complete = canonicalJsonStringify(body(paths.length, true));
  const original = byteLength(complete);
  if (original <= MAX_TOOL_OUTPUT_BYTES) {
    return {
      trust: TrustLevel.UNTRUSTED_DATA,
      value: complete,
      truncated: false,
      original_byte_length: original,
    };
  }
  const kept = largestFitting(paths.length, (n) => canonicalJsonStringify(body(n, false)));
  return {
    trust: TrustLevel.UNTRUSTED_DATA,
    value: canonicalJsonStringify(body(kept, false)),
    truncated: true,
    original_byte_length: original,
  };
}

/** Build the result envelope and re-parse it, so nothing malformed can escape. */
function envelope(
  tool: ImplementationWriteToolName,
  kind: ToolKind,
  identity: ToolIdentity,
  operationId: string,
  beforeDigest: string | null,
  decision: Decision,
  errorCode: string | null,
  repairContext: Readonly<Record<string, unknown>> | null = null,
): ImplementationToolResult {
  const base = {
    schema_version: 1,
    operation_id: operationId,
    identity,
    kind,
    before_digest: beforeDigest,
    output: render(tool, decision, errorCode, repairContext),
  };
  if (decision.outcome === ToolOutcome.SUCCEEDED) {
    return implementationToolResult.parse({
      ...base,
      outcome: ToolOutcome.SUCCEEDED,
      after_digest: decision.afterDigest,
      changed_files: [...decision.changedFiles],
    });
  }
  if (decision.outcome === ToolOutcome.FAILED) {
    return implementationToolResult.parse({
      ...base,
      outcome: ToolOutcome.FAILED,
      after_digest: decision.afterDigest,
      changed_files: [],
      failure_code: decision.failureCode,
    });
  }
  return implementationToolResult.parse({
    ...base,
    outcome: ToolOutcome.AMBIGUOUS,
    after_digest: decision.afterDigest,
    changed_files: [...decision.changedFiles],
    ambiguity_reason: decision.ambiguityReason,
    requires_reconciliation: true,
  });
}

/**
 * Build the two mutating tools over a workspace root.
 *
 * Root validation happens once, here, and throws rather than returning an
 * envelope: an unusable root is a deterministic server-side configuration fault,
 * not a model-visible tool outcome. So is a foreign `operation_id`, which the
 * ledger rejects loudly (`OperationScopeError`) rather than treating as a fresh
 * operation.
 */
export async function createImplementationWriteTools(
  options: ImplementationWriteToolsOptions,
): Promise<ImplementationWriteTools> {
  const policy = await createWorkspacePathPolicy(options.root);
  const root = policy.root;
  const { identity, ledger, runTransaction, beforeMutation, observer, contentPolicy } = options;

  const apply = async (
    tool: ImplementationWriteToolName,
    kind: ToolKind,
    operationId: string,
    request: unknown,
  ): Promise<ImplementationToolResult> => {
    const diagnostics: Diagnostics = { errorCode: null };

    // Phase A: pure validation. Touches nothing, mints no ledger row.
    const parsed = implementationPatchRequest.safeParse(request);
    if (!parsed.success) {
      return envelope(
        tool,
        kind,
        identity,
        operationId,
        null,
        { outcome: ToolOutcome.FAILED, afterDigest: null, failureCode: INVALID_WRITE_REQUEST },
        INVALID_WRITE_REQUEST,
      );
    }

    // Phase B: read-only pre-flight. Its refusals are provably non-mutating, so
    // they are a clean FAILED and are not worth an `operation_id`'s claim.
    let plan: WritePlan;
    try {
      const existing = await runTransaction(async (tx) => ledger.find(tx, operationId, identity));
      plan = await preflight(policy, root, parsed.data, contentPolicy, existing !== null);
    } catch (error) {
      if (error instanceof ImplementationWriteError && error.code === WRITE_NO_CHANGE) {
        const raced = await runTransaction(async (tx) => ledger.find(tx, operationId, identity));
        if (raced !== null) {
          plan = await preflight(policy, root, parsed.data, contentPolicy, true);
        } else {
          const code = failureCode(error);
          return envelope(
            tool,
            kind,
            identity,
            operationId,
            null,
            { outcome: ToolOutcome.FAILED, afterDigest: null, failureCode: code },
            code,
            error.repairContext,
          );
        }
      } else {
        const code = failureCode(error);
        return envelope(
          tool,
          kind,
          identity,
          operationId,
          null,
          { outcome: ToolOutcome.FAILED, afterDigest: null, failureCode: code },
          code,
          error instanceof ImplementationWriteError ? error.repairContext : null,
        );
      }
    }

    // Phase C + D: the intent is committed, and only then may anything be
    // written. The envelope below is built from the row that came BACK from the
    // ledger, not from what this process believes it did.
    const outcome = await runExactlyOnce(
      runTransaction,
      ledger,
      {
        operationId: plan.operationId,
        identity,
        kind,
        beforeDigest: plan.beforeDigest,
        changedFiles: plan.paths,
      },
      async () => performWrites(root, plan, beforeMutation, observer, diagnostics),
    );
    return envelope(
      tool,
      kind,
      identity,
      outcome.record.operationId,
      outcome.record.beforeDigest,
      decide(outcome.record),
      diagnostics.errorCode,
    );
  };

  return Object.freeze({
    write: (input) =>
      apply("write", ToolKind.WRITE_FILE, input.operation_id, {
        operation_id: input.operation_id,
        files: [{ relative_path: input.relative_path, content: input.content }],
        expected_before_digest: input.expected_before_digest ?? null,
      }),
    patch: (input) =>
      apply(
        "patch",
        ToolKind.APPLY_PATCH,
        input.operation_id,
        "files" in input
          ? {
              operation_id: input.operation_id,
              files: input.files.map((file) => ({
                relative_path: file.relative_path,
                content: file.content,
              })),
              expected_before_digest: input.expected_before_digest ?? null,
            }
          : {
              operation_id: input.operation_id,
              replacement_files: input.replacement_files.map((file) => ({
                relative_path: file.relative_path,
                replacements: file.replacements.map((replacement) => ({ ...replacement })),
              })),
              expected_before_digest: input.expected_before_digest ?? null,
            },
      ),
  });
}
