/**
 * Model-facing toolset contracts (`ImplementationToolIntent` /
 * `ImplementationToolResult`).
 *
 * This module is contracts only: no tool logic, no filesystem, database or
 * process access. It is the model-facing layer that will sit above
 * `@remoteagent/workspace-runner` (path policy, process runner, digests), and it
 * is deliberately self-contained — nothing here imports the runner, so the wire
 * shape can be validated without pulling in any executor.
 *
 * Names are prefixed `implementationTool*` / `ImplementationTool*` on purpose.
 * `@remoteagent/contracts` already owns `toolIntent`/`toolResult` for the MCP
 * broker envelope, and those are a different shape entirely. Two `export *`
 * barrels supplying one name do not collide loudly — ESM silently omits the
 * ambiguous name, so the schema would resolve to `undefined` at the import site
 * and "validation" would validate nothing. The prefix keeps the intersection
 * with `@remoteagent/contracts` empty, which `test/contracts.test.ts` asserts.
 *
 * Three invariants are enforced by the schemas themselves rather than by
 * convention:
 *
 * 1. every boundary object is strict and versioned, so an unknown field is a
 *    parse error instead of a silently dropped one;
 * 2. the outcome set is closed and `AMBIGUOUS` is a first-class variant — a
 *    filesystem gives no real transaction, so a partially applied patch must be
 *    representable and must not be expressible as `SUCCEEDED`;
 * 3. tool output is pinned to `UNTRUSTED_DATA` by a literal, is byte-bounded and
 *    declares truncation explicitly.
 */
import {
  TrustLevel,
  idString,
  relativeRepositoryPath,
  sha256Digest,
  text,
  valueObject,
  versionedContract,
} from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on a single tool's normalized output, in UTF-8 bytes. */
export const MAX_TOOL_OUTPUT_BYTES = 65_536;

/** Upper bound on the number of paths a single operation may report. */
export const MAX_CHANGED_FILES = 256;

/**
 * Workspace-relative path. Reuses the repository path primitive from
 * `@remoteagent/contracts`, which already rejects absolute paths, `..`
 * traversal, backslashes and URIs — so an absolute host path can never enter a
 * `changed_files` list.
 */
export const workspaceRelativePath = relativeRepositoryPath;

export type WorkspaceRelativePath = z.infer<typeof workspaceRelativePath>;

const changedFiles = z.array(workspaceRelativePath).max(MAX_CHANGED_FILES);

/** Closed set of model-facing tool kinds. */
export const ToolKind = {
  READ_FILE: "READ_FILE",
  LIST_FILES: "LIST_FILES",
  SEARCH_TEXT: "SEARCH_TEXT",
  WRITE_FILE: "WRITE_FILE",
  APPLY_PATCH: "APPLY_PATCH",
  RUN_COMMAND: "RUN_COMMAND",
} as const;

export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

export const toolKind = z.enum([
  ToolKind.READ_FILE,
  ToolKind.LIST_FILES,
  ToolKind.SEARCH_TEXT,
  ToolKind.WRITE_FILE,
  ToolKind.APPLY_PATCH,
  ToolKind.RUN_COMMAND,
]);

/**
 * Deterministic, server-owned identity of the operation's writer. Kept as a
 * nested value object so it travels as one unit between intent, result and the
 * operation ledger.
 */
export const toolIdentity = valueObject({
  case_id: idString,
  workspace_id: idString,
});

export type ToolIdentity = z.infer<typeof toolIdentity>;

/**
 * Normalized tool output.
 *
 * `trust` is a literal, not an enum: a tool result cannot relabel its own output
 * as `TRUSTED`, and no payload content can raise its own trust level. Trust is
 * assigned by the boundary, never chosen by the sender.
 *
 * The pair (`truncated`, `original_byte_length`) makes clipping explicit: when
 * `truncated` is false the carried bytes must equal the original length, so a
 * silently clipped payload cannot claim to be complete.
 */
export const toolOutput = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  value: text,
  truncated: z.boolean(),
  original_byte_length: z.int().nonnegative(),
}).superRefine((output, ctx) => {
  const carried = new TextEncoder().encode(output.value).length;
  if (carried > MAX_TOOL_OUTPUT_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `output must not exceed ${String(MAX_TOOL_OUTPUT_BYTES)} bytes`,
      path: ["value"],
    });
  }
  if (carried > output.original_byte_length) {
    ctx.addIssue({
      code: "custom",
      message: "carried output cannot be larger than the original output",
      path: ["original_byte_length"],
    });
  }
  if (!output.truncated && carried !== output.original_byte_length) {
    ctx.addIssue({
      code: "custom",
      message: "output must be marked truncated when bytes were dropped",
      path: ["truncated"],
    });
  }
});

export type ToolOutput = z.infer<typeof toolOutput>;

/**
 * A tool call as requested by deterministic code on behalf of the model.
 *
 * `before_digest` is the workspace state the caller believes it is acting on and
 * is nullable, because a read-only or first-touch operation has nothing to pin.
 * There is no `after_digest`: a post-state cannot be requested, only observed.
 * `changed_files` here is the *declared* write surface of the call and is empty
 * for read-only kinds.
 */
export const implementationToolIntent = versionedContract({
  operation_id: idString,
  identity: toolIdentity,
  kind: toolKind,
  before_digest: sha256Digest.nullable(),
  changed_files: changedFiles,
});

export type ImplementationToolIntent = z.infer<typeof implementationToolIntent>;

/** Closed outcome set. `AMBIGUOUS` is a peer of `SUCCEEDED` and `FAILED`. */
export const ToolOutcome = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  /** The post-state could not be established; reconciliation is required. */
  AMBIGUOUS: "AMBIGUOUS",
} as const;

export type ToolOutcome = (typeof ToolOutcome)[keyof typeof ToolOutcome];

/** Why an operation ended in a state that cannot be classified. */
export const AmbiguityReason = {
  /** Some writes landed, some did not; the filesystem gave no transaction. */
  PARTIAL_WRITE: "PARTIAL_WRITE",
  /** The command was interrupted with an unknown amount of work applied. */
  INTERRUPTED: "INTERRUPTED",
  /** The post-state digest could not be computed or verified. */
  UNVERIFIED_POST_STATE: "UNVERIFIED_POST_STATE",
} as const;

export type AmbiguityReason = (typeof AmbiguityReason)[keyof typeof AmbiguityReason];

const resultBase = {
  operation_id: idString,
  identity: toolIdentity,
  kind: toolKind,
  before_digest: sha256Digest.nullable(),
  output: toolOutput,
} as const;

/**
 * A completed operation with a verified post-state. `after_digest` is
 * non-nullable here: if the post-state could not be observed the result is not
 * representable as `SUCCEEDED` at all, it is `AMBIGUOUS`.
 */
export const succeededImplementationToolResult = versionedContract({
  ...resultBase,
  outcome: z.literal(ToolOutcome.SUCCEEDED),
  after_digest: sha256Digest,
  changed_files: changedFiles,
});

/**
 * A clean failure: the operation left no observable mutation, which is why
 * `changed_files` must be empty. A failure that did change files is by
 * definition not clean and must be reported as `AMBIGUOUS`.
 */
export const failedImplementationToolResult = versionedContract({
  ...resultBase,
  outcome: z.literal(ToolOutcome.FAILED),
  after_digest: sha256Digest.nullable(),
  changed_files: z.array(workspaceRelativePath).max(0),
  failure_code: idString,
});

/**
 * An operation whose effect is not classifiable. `requires_reconciliation` is a
 * literal `true` so this variant can never be downgraded to a quiet success, and
 * `changed_files` carries every path that may have been touched.
 */
export const ambiguousImplementationToolResult = versionedContract({
  ...resultBase,
  outcome: z.literal(ToolOutcome.AMBIGUOUS),
  after_digest: sha256Digest.nullable(),
  changed_files: changedFiles,
  ambiguity_reason: z.enum([
    AmbiguityReason.PARTIAL_WRITE,
    AmbiguityReason.INTERRUPTED,
    AmbiguityReason.UNVERIFIED_POST_STATE,
  ]),
  requires_reconciliation: z.literal(true),
});

/**
 * The result envelope. A discriminated union rather than one object with an
 * outcome field: because every variant is strict, `SUCCEEDED` rejects
 * `ambiguity_reason` and `requires_reconciliation` outright, so ambiguity
 * metadata cannot be smuggled onto a success, and `SUCCEEDED` cannot omit its
 * verified `after_digest`.
 */
export const implementationToolResult = z.discriminatedUnion("outcome", [
  succeededImplementationToolResult,
  failedImplementationToolResult,
  ambiguousImplementationToolResult,
]);

export type SucceededImplementationToolResult = z.infer<typeof succeededImplementationToolResult>;
export type FailedImplementationToolResult = z.infer<typeof failedImplementationToolResult>;
export type AmbiguousImplementationToolResult = z.infer<typeof ambiguousImplementationToolResult>;
export type ImplementationToolResult = z.infer<typeof implementationToolResult>;
