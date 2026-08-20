/**
 * The model-facing `mkdir` tool: create a directory inside the workspace scope.
 *
 * This is the capability `./patch.ts` deliberately does not have. A write there
 * refuses a missing parent with a clean pre-flight
 * `FAILED` / `PARENT_NOT_A_DIRECTORY` rather than silently materialising the
 * tree, so the model has no way to create the directory it needs. This module
 * supplies exactly that and nothing more; `patch.ts` behaviour is unchanged.
 *
 * Path confinement is not re-derived here. `WorkspacePathPolicy`
 * (`@remoteagent/workspace-runner`) already resolves the target against the
 * verified root, rejects `..` escapes, absolute paths and a symlink at *any* path
 * component, and its `validateCreateTarget` is the same primitive `patch.ts`
 * uses for write targets. This module calls it and adds only the model-facing
 * envelope and the ledger integration.
 *
 * Three properties are structural rather than conventional.
 *
 * 1. **Creation is confined to the scope.** `validateCreateTarget` runs before
 *    any `mkdir` syscall, and the syscall itself is issued against the
 *    *validated* absolute path, never against the caller's string. Traversal, an
 *    absolute path and a symlinked component are therefore refused before the
 *    filesystem is touched, which makes the refusal provably non-mutating.
 *
 * 2. **The operation is idempotent.** `mkdir` on an existing directory is a
 *    success, not an error, and it changes no state: the tree digest before and
 *    after are equal, and `changed_files` is empty because nothing was created.
 *    `EEXIST` is inspected rather than trusted — an existing *file* (or a symlink
 *    to one) at the target is a `FAILED` / `TARGET_NOT_A_DIRECTORY`, because
 *    reporting success there would tell the model a directory exists where it
 *    cannot write.
 *
 * 3. **Diagnostics never carry host paths.** Only stable codes travel: policy
 *    codes from `WorkspacePathPolicyError`, and bare `errno` names mapped to
 *    `FS_<ERRNO>`. `errno` messages and policy messages both embed the absolute
 *    host path, and this output is read by a model, so the message is dropped and
 *    the payload carries counts and codes. `test/mkdir.integration.test.ts`
 *    asserts this with a canary over the entire rendered envelope.
 *
 * Recursive creation is supported because the alternative is worse: without it a
 * model must issue one call per ancestor, and each intermediate call is a
 * separately-claimed side effect whose partial completion is invisible. One
 * operation with a recorded intent is the honest unit. Every created ancestor is
 * reported in `changed_files`, so the write surface is never understated.
 *
 * As in `./patch.ts` and `./command.ts`, the model-facing outcome is derived from
 * the **durable ledger row**, so a replay of the same `operation_id` reports the
 * recorded outcome and creates nothing.
 *
 * `ToolKind` has no `MKDIR` member and does not gain one: the closed kind set is
 * an accepted contract from `WU-01`, consumed by the ledger's own enum and by
 * migration `027`'s CHECK constraint. Extending it would widen an accepted
 * boundary for a cosmetic gain. Directory creation is a workspace mutation, so
 * its effect class is `WRITE_FILE`; the tool name in the payload keeps it
 * distinguishable from a file write.
 */
import { lstat, mkdir as fsMkdir } from "node:fs/promises";

import { TrustLevel, canonicalJsonStringify } from "@remoteagent/contracts";
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
  MAX_TOOL_OUTPUT_BYTES,
  ToolKind,
  ToolOutcome,
  implementationToolResult,
  workspaceRelativePath,
} from "./contracts.js";
import type { ImplementationToolResult, ToolIdentity, ToolOutput } from "./contracts.js";
import { runExactlyOnce } from "./ledger.js";
import type { OperationLedgerRepository, OperationReceipt, OperationRecord } from "./ledger.js";
import { OperationStatus } from "./ledger.js";

/** The request violated the path contract; no filesystem was touched. */
export const INVALID_MKDIR_REQUEST = "INVALID_REQUEST";

/** Something exists at the target that is not a directory. */
export const MKDIR_TARGET_NOT_A_DIRECTORY = "TARGET_NOT_A_DIRECTORY";

/** An ancestor of the target exists and is not a directory. */
export const MKDIR_PARENT_NOT_A_DIRECTORY = "PARENT_NOT_A_DIRECTORY";

/**
 * A path component is a symlink. Re-exported from the workspace path policy's
 * code set rather than redefined, so the two cannot drift: this is the code
 * `validateCreateTarget` raises, and asserting it in tests is what pins the
 * refusal to the policy layer instead of to this module's own `lstat` check.
 * The distinction matters for a symlink pointing at a real directory, which an
 * `isDirectory()` test would accept.
 */
export const MKDIR_SYMLINK_NOT_ALLOWED = "SYMLINK_NOT_ALLOWED";

/** Unclassified fault; a real code was not recoverable. */
export const MKDIR_TOOL_FAILED = "MKDIR_TOOL_FAILED";

/** Raised for faults this module classifies itself. */
export class ImplementationMkdirError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(code);
    this.name = "ImplementationMkdirError";
    this.code = code;
  }
}

/**
 * The whole model-facing surface. Strict: an unrecognized key is a parse error,
 * so there is no field through which scope, root or identity could be supplied.
 * `recursive` is the only option and it cannot widen the scope — every ancestor
 * it creates is still inside the validated target's path.
 */
export const implementationMkdirRequest = z.strictObject({
  operation_id: z.string().trim().min(1).max(512),
  relative_path: workspaceRelativePath,
  recursive: z.boolean().optional(),
});

export type ImplementationMkdirRequest = z.infer<typeof implementationMkdirRequest>;

export type ImplementationMkdirToolOptions = Readonly<{
  /** Workspace root; validated by the workspace-runner path policy. */
  root: string;
  identity: ToolIdentity;
  ledger: OperationLedgerRepository;
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
}>;

export type ImplementationMkdirInput = Readonly<{
  operation_id: string;
  relative_path: string;
  recursive?: boolean;
}>;

export type ImplementationMkdirTool = Readonly<{
  run(input: ImplementationMkdirInput): Promise<ImplementationToolResult>;
}>;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Bare `errno` name (`ENOTDIR`, `EACCES`, ...) — a code, never a path. */
function errnoOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" && /^E[A-Z]{1,15}$/.test(code) ? code : null;
}

/**
 * Map a thrown fault onto a stable code. Only codes travel: policy messages and
 * `errno` messages embed absolute host paths, and this output is model-visible.
 */
function failureCode(error: unknown): string {
  if (error instanceof ImplementationMkdirError) return error.code;
  if (error instanceof WorkspacePathPolicyError) return error.code;
  const errno = errnoOf(error);
  return errno === null ? MKDIR_TOOL_FAILED : `FS_${errno}`;
}

/**
 * The paths, in creation order, that do not yet exist and therefore would be
 * created by a recursive `mkdir`.
 *
 * Computed BEFORE the syscall so the declared write surface can be recorded in
 * the ledger intent, and returned in the same order the kernel would create
 * them. A component that exists but is not a directory is refused here rather
 * than surfacing as a bare `ENOTDIR` after a partial creation.
 */
async function missingAncestors(
  policy: WorkspacePathPolicy,
  relativePath: string,
): Promise<{ readonly target: VerifiedWorkspacePath; readonly missing: readonly string[] }> {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  const missing: string[] = [];
  let target: VerifiedWorkspacePath | null = null;

  for (let index = 0; index < segments.length; index += 1) {
    const partial = segments.slice(0, index + 1).join("/");
    // `validateCreateTarget` already walks every component of the path it is
    // given, so validating the leaf alone would also reject a symlinked
    // ancestor. Each prefix is validated anyway because this loop needs each
    // prefix's own resolved path to `lstat` it, and reusing the policy's return
    // value keeps a single source of truth for the resolution.
    const resolved = await policy.validateCreateTarget(partial);
    const existing = await lstat(resolved).catch(() => null);
    if (existing === null) {
      missing.push(partial);
    } else if (!existing.isDirectory()) {
      // A file or a symlink sits where a directory must be. Distinguish leaf
      // from ancestor: the leaf is what the caller asked for, an ancestor is a
      // structural obstacle.
      throw new ImplementationMkdirError(
        index === segments.length - 1 ? MKDIR_TARGET_NOT_A_DIRECTORY : MKDIR_PARENT_NOT_A_DIRECTORY,
      );
    }
    if (index === segments.length - 1) {
      target = resolved;
    }
  }

  if (target === null) {
    // `workspaceRelativePath` rejects an empty path, so this is unreachable via
    // the public surface; fail closed rather than create the root itself.
    throw new ImplementationMkdirError(INVALID_MKDIR_REQUEST);
  }
  return { target, missing };
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
 * replay arriving while the effect is unresolved can never report success.
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
      failureCode: record.failureCode ?? MKDIR_TOOL_FAILED,
    };
  }
  return {
    outcome: ToolOutcome.AMBIGUOUS,
    afterDigest: record.afterDigest,
    changedFiles: record.changedFiles,
    ambiguityReason: record.ambiguityReason ?? AmbiguityReason.INTERRUPTED,
  };
}

/** Largest `n` in `[0, hi]` whose rendering fits the model-facing bound. */
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
 * Render the model-facing payload.
 *
 * `created` is a count and `existed` a boolean, so the common idempotent case is
 * legible without reading the path list. Clipping is never silent: whole paths
 * are dropped, the dropped count is stated and `complete` goes false.
 */
function render(decision: Decision, existed: boolean, errorCode: string | null): ToolOutput {
  const paths = decision.outcome === ToolOutcome.FAILED ? [] : decision.changedFiles;
  const body = (kept: number, complete: boolean): Record<string, unknown> => ({
    tool: "mkdir",
    outcome: decision.outcome,
    complete,
    existed,
    created: paths.length,
    requires_reconciliation: decision.outcome === ToolOutcome.AMBIGUOUS,
    ambiguity_reason: decision.outcome === ToolOutcome.AMBIGUOUS ? decision.ambiguityReason : null,
    failure_code: decision.outcome === ToolOutcome.FAILED ? decision.failureCode : null,
    error_code: errorCode,
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
  identity: ToolIdentity,
  operationId: string,
  beforeDigest: string | null,
  decision: Decision,
  existed: boolean,
  errorCode: string | null,
): ImplementationToolResult {
  const base = {
    schema_version: 1,
    operation_id: operationId,
    identity,
    // See the module note: the closed `ToolKind` set is an accepted contract and
    // directory creation is a workspace mutation.
    kind: ToolKind.WRITE_FILE,
    before_digest: beforeDigest,
    output: render(decision, existed, errorCode),
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
 * Create the directories, then verify. A returned `mkdir` is not proof: the
 * target is re-stated and must be a directory, otherwise the post-state is
 * unverified rather than successful.
 *
 * Exits, exhaustively:
 *
 * - nothing was missing -> `SUCCEEDED` with an empty `changed_files`. Idempotent
 *   and provably non-mutating, so the pre-digest is reused as the post-digest;
 * - created and re-stat confirms a directory -> `SUCCEEDED` with the created
 *   ancestors;
 * - a fault with nothing created yet -> `FAILED`;
 * - a fault after something was created, or a post-state that cannot be
 *   confirmed -> `AMBIGUOUS`. There is no `catch` that yields a success.
 */
async function performMkdir(
  root: VerifiedWorkspacePath,
  target: VerifiedWorkspacePath,
  missing: readonly string[],
  recursive: boolean,
  beforeDigest: string,
  diagnostics: { errorCode: string | null },
): Promise<OperationReceipt> {
  if (missing.length === 0) {
    // Already present. Nothing is written, so the pre-state IS the post-state
    // and re-computing the digest would only add a chance to observe unrelated
    // concurrent churn.
    return { outcome: ToolOutcome.SUCCEEDED, afterDigest: beforeDigest, changedFiles: [] };
  }

  try {
    await fsMkdir(target, { recursive, mode: 0o700 });
  } catch (error) {
    diagnostics.errorCode = failureCode(error);
    // `recursive: true` can fail having created some ancestors, so the touched
    // set is what the intent declared, not an empty list.
    const created = await Promise.all(
      missing.map(async (path) => ({
        path,
        exists: await lstat(`${root}/${path}`)
          .then((stat) => stat.isDirectory())
          .catch(() => false),
      })),
    );
    const landed = created.filter((entry) => entry.exists).map((entry) => entry.path);
    if (landed.length === 0) {
      return { outcome: ToolOutcome.FAILED, failureCode: diagnostics.errorCode };
    }
    return {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: AmbiguityReason.PARTIAL_WRITE,
      afterDigest: await computeTreeDigest(root).catch(() => null),
      changedFiles: landed,
    };
  }

  try {
    const created = await lstat(target);
    if (!created.isDirectory()) {
      diagnostics.errorCode = MKDIR_TARGET_NOT_A_DIRECTORY;
      return {
        outcome: ToolOutcome.AMBIGUOUS,
        ambiguityReason: AmbiguityReason.UNVERIFIED_POST_STATE,
        afterDigest: await computeTreeDigest(root).catch(() => null),
        changedFiles: missing,
      };
    }
    return {
      outcome: ToolOutcome.SUCCEEDED,
      afterDigest: await computeTreeDigest(root),
      changedFiles: missing,
    };
  } catch (error) {
    diagnostics.errorCode = failureCode(error);
    return {
      outcome: ToolOutcome.AMBIGUOUS,
      ambiguityReason: AmbiguityReason.UNVERIFIED_POST_STATE,
      afterDigest: null,
      changedFiles: missing,
    };
  }
}

/**
 * Build the `mkdir` tool over a workspace root.
 *
 * Root validation happens once, here, and throws rather than returning an
 * envelope: an unusable root is a deterministic server-side configuration fault,
 * not a model-visible tool outcome.
 */
export async function createImplementationMkdirTool(
  options: ImplementationMkdirToolOptions,
): Promise<ImplementationMkdirTool> {
  const policy = await createWorkspacePathPolicy(options.root);
  const root = policy.root;
  const { identity, ledger, runTransaction } = options;

  const run = async (input: ImplementationMkdirInput): Promise<ImplementationToolResult> => {
    const diagnostics: { errorCode: string | null } = { errorCode: null };

    // Phase A: pure validation. Touches nothing, mints no ledger row. Spreading
    // the input (rather than rebuilding it field by field) is what makes the
    // strict schema load-bearing: an unrecognized key reaches the parse and is
    // refused, instead of being dropped before validation ever sees it.
    const parsed = implementationMkdirRequest.safeParse({ ...input });
    if (!parsed.success) {
      return envelope(
        identity,
        input.operation_id,
        null,
        {
          outcome: ToolOutcome.FAILED,
          afterDigest: null,
          failureCode: INVALID_MKDIR_REQUEST,
        },
        false,
        INVALID_MKDIR_REQUEST,
      );
    }
    const request = parsed.data;
    const recursive = request.recursive ?? false;

    // Phase B: read-only pre-flight — path policy and the missing-ancestor scan.
    // Its refusals are provably non-mutating, so they are a clean FAILED and are
    // not worth claiming an `operation_id` for.
    let beforeDigest: string;
    let target: VerifiedWorkspacePath;
    let missing: readonly string[];
    try {
      beforeDigest = await computeTreeDigest(root);
      const scan = await missingAncestors(policy, request.relative_path);
      target = scan.target;
      missing = scan.missing;
      if (!recursive && missing.length > 1) {
        // A non-recursive request whose parent is absent. Refuse before the
        // syscall so the code is specific rather than a bare `FS_ENOENT`.
        throw new ImplementationMkdirError(MKDIR_PARENT_NOT_A_DIRECTORY);
      }
    } catch (error) {
      const code = failureCode(error);
      return envelope(
        identity,
        request.operation_id,
        null,
        { outcome: ToolOutcome.FAILED, afterDigest: null, failureCode: code },
        false,
        code,
      );
    }

    const existed = missing.length === 0;

    // Phase C + D: the intent is committed, and only then may anything be
    // created. The envelope is built from the row that came BACK from the
    // ledger, not from what this process believes it did.
    const outcome = await runExactlyOnce(
      runTransaction,
      ledger,
      {
        operationId: request.operation_id,
        identity,
        kind: ToolKind.WRITE_FILE,
        beforeDigest,
        changedFiles: missing,
      },
      async () => performMkdir(root, target, missing, recursive, beforeDigest, diagnostics),
    );
    return envelope(
      identity,
      outcome.record.operationId,
      outcome.record.beforeDigest,
      decide(outcome.record),
      existed,
      diagnostics.errorCode,
    );
  };

  return Object.freeze({ run });
}
