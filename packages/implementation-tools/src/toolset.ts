/**
 * The composed model-facing toolset: one object, one scope, one policy.
 *
 * The four modules below it are each correct in isolation, but the model does not
 * call them in isolation — it calls a *set*. Composition is where the guarantees
 * either hold jointly or leak, so this module exists to make three things true of
 * the set rather than of any one tool.
 *
 * 1. **Scope is injected, never accepted.** `case_id` and `workspace_id` are
 *    supplied once, here, by the server, and the per-call surfaces below carry no
 *    field for them. Every tool receives the *same* `identity` value from this
 *    closure, so there is no argument on any tool through which a model could
 *    address another case's workspace or another case's ledger rows. This is
 *    stronger than validating a supplied scope: a value that is never accepted
 *    cannot be validated wrongly. `test/toolset.integration.test.ts` proves it
 *    adversarially, passing a foreign scope to every tool.
 *
 * 2. **Protected paths are refused by the set, not by each tool.** Repository
 *    instructions (`AGENTS.md`, `CLAUDE.md` and variants), credential material
 *    (`.env`, key files) and VCS internals (`.git`) are denied on every path-taking
 *    tool through one shared predicate. Putting the list in each tool would let the
 *    next tool added forget it; putting it here means a new tool must route through
 *    {@link guardPath} to get a path at all.
 *
 *    Two independent layers already refuse *some* of this: the discovery policy's
 *    `isForbiddenPath` covers `.git`/`.env` on the read side, and the workspace
 *    path policy refuses symlink escapes everywhere. This layer is additive and
 *    covers what neither does — instruction files are perfectly ordinary paths to
 *    both, yet a model that can rewrite `AGENTS.md` can rewrite the instructions
 *    it is later given.
 *
 * 3. **No tool can be reached without its ledger.** Every mutating tool is
 *    constructed with the same ledger and transaction boundary, so an operation's
 *    intent is recorded in one place and a replayed `operation_id` is resolved from
 *    one authority regardless of which tool issued it.
 *
 * What this module deliberately does NOT do is re-implement or relax anything
 * beneath it. It adds a refusal layer and forwards; it never reaches past a lower
 * policy, never widens a limit, and never converts a lower refusal into a success.
 * The read tools stay read-only, `patch.ts` keeps refusing a missing parent,
 * `command.ts` keeps its server-owned catalogue, and `mkdir.ts` keeps its
 * idempotency.
 */
import { TrustLevel, canonicalJsonStringify } from "@remoteagent/contracts";
import type { Transaction } from "@remoteagent/database";
import type { NetworkMode } from "@remoteagent/workspace-runner";

import { ToolKind, ToolOutcome, implementationToolResult } from "./contracts.js";
import type { ImplementationToolResult, ToolIdentity } from "./contracts.js";
import { createImplementationCommandTool } from "./command.js";
import type {
  CommandCatalogueEntry,
  CommandLogRecord,
  ImplementationCommandTool,
} from "./command.js";
import { createImplementationMkdirTool } from "./mkdir.js";
import type { ImplementationMkdirTool } from "./mkdir.js";
import { createImplementationWriteTools } from "./patch.js";
import type { ImplementationWriteTools } from "./patch.js";
import { createImplementationReadTools } from "./read-tools.js";
import type { ImplementationReadTools } from "./read-tools.js";
import type { OperationLedgerRepository } from "./ledger.js";
import * as z from "zod";
import { workspaceRelativePath } from "./contracts.js";

/** The path is protected by toolset policy; no lower layer was consulted. */
export const TOOLSET_PATH_PROTECTED = "PATH_PROTECTED";
/** The requested mutation is outside the server-owned SliceContract roots. */
export const TOOLSET_PATH_OUTSIDE_ALLOWED = "PATH_OUTSIDE_ALLOWED";

/**
 * Path segments that are protected wherever they appear in the tree.
 *
 * Matched per segment, case-insensitively, against every component of the
 * requested path — not as a prefix. `.git` must be refused at `vendor/dep/.git`
 * exactly as at the root, and a nested `.env` is no less a credential file for
 * being nested.
 */
const PROTECTED_SEGMENTS: readonly string[] = Object.freeze([
  ".git",
  ".env",
  ".ssh",
  ".aws",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "secrets",
]);

/**
 * Repository instruction files. Protected because they are the agent's own
 * operating contract: a model that rewrites them edits the instructions a later
 * run is given, which is privilege escalation by way of an ordinary file write.
 *
 * Matched on the file name only, and only for exact matches — `AGENTS.md` is
 * protected, `docs/agents-guide.md` is not.
 */
const PROTECTED_FILE_NAMES: readonly string[] = Object.freeze([
  "agents.md",
  "claude.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
]);

/** Extensions that carry private key material regardless of their name. */
const PROTECTED_EXTENSIONS: readonly string[] = Object.freeze([".pem", ".key", ".p12", ".pfx"]);

/**
 * Segment PREFIXES that are protected together with any suffix.
 *
 * `.env` alone was an exact-match segment, so `.env` was protected and
 * `.env.local` was NOT — found by the RA-024-WU-03 adversarial suite, not by any
 * existing test. `.env.local`, `.env.production` and `.env.development` are the
 * conventional names for the file that actually holds the credentials, so the
 * protected name was the least interesting member of the family.
 *
 * `packages/repository-planner/src/discovery-policy.ts` already had this right
 * (`name === ".env" || name.startsWith(".env.")`), which makes this the same class
 * of divergence as `CTF-006`: two boundaries with two ideas of the same rule, and
 * the model-facing one weaker. Kept as a separate list from
 * {@link PROTECTED_SEGMENTS} because prefix matching is a strictly stronger claim
 * and must be opted into per entry — a prefix rule over `credentials` would also
 * swallow `credentials-guide.md`.
 */
const PROTECTED_SEGMENT_PREFIXES: readonly string[] = Object.freeze([".env."]);

/**
 * True when toolset policy protects this workspace-relative path.
 *
 * Deliberately syntactic and applied BEFORE any filesystem access: the decision
 * must not depend on whether the path currently exists, or a file could be
 * protected only once created. Path separators are normalized first so
 * `a//.git/b` and `a/.git/b` cannot differ.
 */
export function isProtectedPath(relativePath: string): boolean {
  const segments = relativePath
    .split(/[/\\]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  const leaf = segments[segments.length - 1] ?? "";
  return (
    segments.some((segment) => PROTECTED_SEGMENTS.includes(segment)) ||
    segments.some((segment) =>
      PROTECTED_SEGMENT_PREFIXES.some((prefix) => segment.startsWith(prefix)),
    ) ||
    PROTECTED_FILE_NAMES.includes(leaf) ||
    PROTECTED_EXTENSIONS.some((extension) => leaf.endsWith(extension))
  );
}

export type ImplementationToolsetOptions = Readonly<{
  /** Workspace root; validated once by the workspace-runner path policy. */
  root: string;
  /**
   * The ONE scope for every tool in the set. Server-supplied and never taken
   * from a tool argument — see the module note, property 1.
   */
  identity: ToolIdentity;
  ledger: OperationLedgerRepository;
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** Server-owned command catalogue; the model may only name its keys. */
  catalogue: Readonly<Record<string, CommandCatalogueEntry>>;
  network?: NetworkMode;
  artifactRoot: string;
  knownSecrets?: readonly string[];
  log?: (record: CommandLogRecord) => void;
}>;

/**
 * The model-facing surface.
 *
 * Every input type here is `operation_id` plus the tool's own arguments. None of
 * them has an `identity`, `case_id`, `workspace_id`, `root` or `cwd` field, which
 * is what makes property 1 structural rather than enforced.
 */
export type ImplementationToolset = Readonly<{
  readonly identity: ToolIdentity;
  /** Command names the model may use, for prompt construction. */
  readonly commands: readonly string[];
  read(
    input: Readonly<{ operation_id: string; relative_path: string }>,
  ): Promise<ImplementationToolResult>;
  search(
    input: Readonly<{ operation_id: string; query: string }>,
  ): Promise<ImplementationToolResult>;
  tree(
    input: Readonly<{ operation_id: string; relative_path?: string }>,
  ): Promise<ImplementationToolResult>;
  config(
    input: Readonly<{ operation_id: string; relative_path: string }>,
  ): Promise<ImplementationToolResult>;
  write(
    input: Readonly<{
      operation_id: string;
      relative_path: string;
      content: string;
      expected_before_digest?: string | null;
    }>,
  ): Promise<ImplementationToolResult>;
  patch(
    input: Readonly<{
      operation_id: string;
      files: readonly Readonly<{ relative_path: string; content: string }>[];
      expected_before_digest?: string | null;
    }>,
  ): Promise<ImplementationToolResult>;
  mkdir(
    input: Readonly<{ operation_id: string; relative_path: string; recursive?: boolean }>,
  ): Promise<ImplementationToolResult>;
  command(
    input: Readonly<{ operation_id: string; command: string; signal?: AbortSignal }>,
  ): Promise<ImplementationToolResult>;
}>;

const encoder = new TextEncoder();

/**
 * A refusal envelope for a toolset-level denial.
 *
 * Built and returned here rather than thrown, matching every lower tool: a denied
 * path is a `FAILED` outcome the model can read, not an exception. `changed_files`
 * is empty and no ledger row is minted, because the refusal happens before any
 * tool is entered and is therefore provably non-mutating.
 */
function refuseProtected(
  tool: string,
  kind: ToolKind,
  identity: ToolIdentity,
  operationId: string,
): ImplementationToolResult {
  // The offending path is deliberately NOT echoed: it is model-supplied and
  // would round-trip unvalidated content into the payload.
  const value = canonicalJsonStringify({
    tool,
    refused: true,
    failure_code: TOOLSET_PATH_PROTECTED,
  });
  return implementationToolResult.parse({
    schema_version: 1,
    operation_id: operationId,
    identity,
    kind,
    outcome: ToolOutcome.FAILED,
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: TOOLSET_PATH_PROTECTED,
    output: {
      trust: TrustLevel.UNTRUSTED_DATA,
      value,
      truncated: false,
      original_byte_length: encoder.encode(value).length,
    },
  });
}

/**
 * Remove protected entries from a listing-shaped payload.
 *
 * `search` and a root `tree` accept no path, so they cannot be gated on the way
 * in — a protected file is reachable only as a RESULT. This rewrites the payload
 * to drop those results and re-renders the envelope.
 *
 * Removal is accounted for rather than silent: dropped items are added to the
 * payload's own `dropped` counter and `complete` goes false, which is the same
 * vocabulary `read-tools.ts` already uses for byte-clipping. A caller therefore
 * cannot mistake a filtered listing for an exhaustive one.
 *
 * The digest is deliberately left untouched. It is taken over the *observed*
 * state, and filtering changes what is reported, not what was observed; recomputing
 * it here would make two identical observations produce different digests
 * depending on this policy.
 */
function filterResultPaths(result: ImplementationToolResult): ImplementationToolResult {
  if (result.outcome !== ToolOutcome.SUCCEEDED) return result;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.output.value) as Record<string, unknown>;
  } catch {
    // Not a payload this layer understands. Fail closed: a listing that cannot be
    // inspected cannot be certified as free of protected paths.
    return refuseProtected("filter", result.kind, result.identity, result.operation_id);
  }
  const items = payload["items"];
  if (!Array.isArray(items)) return result;

  const kept = items.filter((item) => {
    const path = (item as { relative_path?: unknown }).relative_path;
    return typeof path !== "string" || !isProtectedPath(path);
  });
  if (kept.length === items.length) return result;

  const previouslyDropped = typeof payload["dropped"] === "number" ? payload["dropped"] : 0;
  const value = canonicalJsonStringify({
    ...payload,
    complete: false,
    dropped: previouslyDropped + (items.length - kept.length),
    items: kept,
  });
  return implementationToolResult.parse({
    schema_version: 1,
    operation_id: result.operation_id,
    identity: result.identity,
    kind: result.kind,
    outcome: ToolOutcome.SUCCEEDED,
    before_digest: result.before_digest,
    after_digest: result.after_digest,
    changed_files: [...result.changed_files],
    output: {
      trust: TrustLevel.UNTRUSTED_DATA,
      value,
      // The carried bytes shrank relative to the observation, which is exactly
      // what `truncated` means in this contract.
      truncated: true,
      original_byte_length: result.output.original_byte_length,
    },
  });
}

/**
 * Compose the full toolset over one workspace and one scope.
 *
 * Construction is where every server-owned decision is fixed: the root, the
 * scope, the ledger, the command catalogue, the network mode and the artifact
 * directory. After this returns, none of them is reachable from a tool argument.
 */
export async function createImplementationToolset(
  options: ImplementationToolsetOptions,
): Promise<ImplementationToolset> {
  const { identity, ledger, runTransaction, root } = options;

  const reads: ImplementationReadTools = await createImplementationReadTools({ root, identity });
  const writes: ImplementationWriteTools = await createImplementationWriteTools({
    root,
    identity,
    ledger,
    runTransaction,
  });
  const mkdirTool: ImplementationMkdirTool = await createImplementationMkdirTool({
    root,
    identity,
    ledger,
    runTransaction,
  });
  const commandTool: ImplementationCommandTool = await createImplementationCommandTool({
    root,
    identity,
    ledger,
    runTransaction,
    catalogue: options.catalogue,
    artifactRoot: options.artifactRoot,
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.knownSecrets === undefined ? {} : { knownSecrets: options.knownSecrets }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  /**
   * Gate a path-taking call. Returns the refusal envelope, or `null` to proceed.
   * Every path-taking tool below routes through this, so the protected list
   * cannot be forgotten by one of them.
   */
  const guardPath = (
    tool: string,
    kind: ToolKind,
    operationId: string,
    paths: readonly string[],
  ): ImplementationToolResult | null =>
    paths.some((path) => isProtectedPath(path))
      ? refuseProtected(tool, kind, identity, operationId)
      : null;

  return Object.freeze({
    identity,
    commands: commandTool.commands,

    read: async (input) =>
      guardPath("read", ToolKind.READ_FILE, input.operation_id, [input.relative_path]) ??
      reads.read({ operation_id: input.operation_id, relative_path: input.relative_path }),

    config: async (input) =>
      guardPath("config", ToolKind.READ_FILE, input.operation_id, [input.relative_path]) ??
      reads.config({ operation_id: input.operation_id, relative_path: input.relative_path }),

    tree: async (input) =>
      guardPath(
        "tree",
        ToolKind.LIST_FILES,
        input.operation_id,
        input.relative_path === undefined ? [] : [input.relative_path],
      ) ??
      filterResultPaths(
        await reads.tree(
          input.relative_path === undefined
            ? { operation_id: input.operation_id }
            : { operation_id: input.operation_id, relative_path: input.relative_path },
        ),
      ),

    // `search` and a root `tree` take no path to gate, so they are filtered on
    // the way OUT instead. This is not belt-and-braces: the discovery policy's
    // `isForbiddenPath` covers `.git` and credential material but NOT repository
    // instructions, so without this filter a query matching `AGENTS.md` returns
    // its contents and a root listing enumerates it — reaching by search exactly
    // what `read` refuses by path. Verified by probe, not assumed.
    search: async (input) =>
      filterResultPaths(
        await reads.search({ operation_id: input.operation_id, query: input.query }),
      ),

    write: async (input) =>
      guardPath("write", ToolKind.WRITE_FILE, input.operation_id, [input.relative_path]) ??
      writes.write({
        operation_id: input.operation_id,
        relative_path: input.relative_path,
        content: input.content,
        expected_before_digest: input.expected_before_digest ?? null,
      }),

    patch: async (input) =>
      guardPath(
        "patch",
        ToolKind.APPLY_PATCH,
        input.operation_id,
        input.files.map((file) => file.relative_path),
      ) ??
      writes.patch({
        operation_id: input.operation_id,
        files: input.files,
        expected_before_digest: input.expected_before_digest ?? null,
      }),

    mkdir: async (input) =>
      guardPath("mkdir", ToolKind.WRITE_FILE, input.operation_id, [input.relative_path]) ??
      mkdirTool.run(
        input.recursive === undefined
          ? { operation_id: input.operation_id, relative_path: input.relative_path }
          : {
              operation_id: input.operation_id,
              relative_path: input.relative_path,
              recursive: input.recursive,
            },
      ),

    // No path to gate: the model names a catalogue key and the server owns the
    // cwd, so there is no path argument that could reach a protected file.
    command: async (input) =>
      commandTool.run(
        input.signal === undefined
          ? { operation_id: input.operation_id, command: input.command }
          : { operation_id: input.operation_id, command: input.command, signal: input.signal },
      ),
  });
}

/** Model-visible implementation surface for one accepted vertical slice. */
export type BoundedImplementationToolset = Readonly<{
  read(input: Readonly<{ relative_path: string }>): Promise<ImplementationToolResult>;
  search(input: Readonly<{ query: string }>): Promise<ImplementationToolResult>;
  tree(input: Readonly<{ relative_path?: string }>): Promise<ImplementationToolResult>;
  config(input: Readonly<{ relative_path: string }>): Promise<ImplementationToolResult>;
  write(
    input: Readonly<{
      relative_path: string;
      content: string;
      expected_before_digest?: string | null;
    }>,
  ): Promise<ImplementationToolResult>;
  patch(
    input: Readonly<{
      files: readonly Readonly<{ relative_path: string; content: string }>[];
      expected_before_digest?: string | null;
    }>,
  ): Promise<ImplementationToolResult>;
  mkdir(
    input: Readonly<{ relative_path: string; recursive?: boolean }>,
  ): Promise<ImplementationToolResult>;
}>;

export type BoundedImplementationToolName =
  "read" | "search" | "tree" | "config" | "write" | "patch" | "mkdir";

export type BoundedImplementationToolsetOptions = Omit<
  ImplementationToolsetOptions,
  "artifactRoot" | "catalogue" | "knownSecrets" | "log" | "network"
> &
  Readonly<{
    allowedPaths: readonly string[];
    /** Required server authority, awaited immediately before every mutation syscall. */
    beforeMutation(): Promise<void>;
    operationIdFor(tool: BoundedImplementationToolName, sequence: number): string;
    onResult?: (result: ImplementationToolResult) => void;
  }>;

const boundedRead = z.strictObject({ relative_path: workspaceRelativePath });
const boundedSearch = z.strictObject({ query: z.string().max(4096) });
const boundedTree = z.strictObject({ relative_path: workspaceRelativePath.optional() });
const boundedWrite = z.strictObject({
  relative_path: workspaceRelativePath,
  content: z.string(),
  expected_before_digest: z.string().nullable().optional(),
});
const boundedPatch = z.strictObject({
  files: z
    .array(z.strictObject({ relative_path: workspaceRelativePath, content: z.string() }))
    .min(1),
  expected_before_digest: z.string().nullable().optional(),
});
const boundedMkdir = z.strictObject({
  relative_path: workspaceRelativePath,
  recursive: z.boolean().optional(),
});

/**
 * Narrow the general implementation toolset to one SliceContract. The caller
 * never supplies an operation id, scope, root, command name or fence. Mutation
 * paths match an allowed root exactly or as its slash-delimited descendant.
 */
export async function createBoundedImplementationToolset(
  options: BoundedImplementationToolsetOptions,
): Promise<BoundedImplementationToolset> {
  const allowed = Object.freeze(
    [...new Set(options.allowedPaths.map((path) => workspaceRelativePath.parse(path)))].sort(),
  );
  if (allowed.length === 0) throw new Error("at least one server-owned allowed path is required");

  const reads = await createImplementationReadTools({
    root: options.root,
    identity: options.identity,
  });
  const writes = await createImplementationWriteTools({
    root: options.root,
    identity: options.identity,
    ledger: options.ledger,
    runTransaction: options.runTransaction,
    beforeMutation: async () => options.beforeMutation(),
  });
  const mkdir = await createImplementationMkdirTool({
    root: options.root,
    identity: options.identity,
    ledger: options.ledger,
    runTransaction: options.runTransaction,
    beforeMutation: options.beforeMutation,
  });
  let sequence = 0;
  let ambiguous = false;

  const nextId = (tool: BoundedImplementationToolName): string => {
    if (ambiguous) throw new Error("AMBIGUOUS implementation operation requires reconciliation");
    const id = options.operationIdFor(tool, sequence);
    sequence += 1;
    if (typeof id !== "string" || id.trim().length === 0 || id.length > 512) {
      throw new Error("server-owned operation id is invalid");
    }
    return id;
  };
  const observe = (result: ImplementationToolResult): ImplementationToolResult => {
    options.onResult?.(result);
    if (result.outcome === ToolOutcome.AMBIGUOUS) ambiguous = true;
    return result;
  };
  const isAllowed = (path: string): boolean =>
    allowed.some((root) => path === root || path.startsWith(`${root}/`));
  const protectedResult = (
    tool: string,
    kind: ToolKind,
    operationId: string,
    paths: readonly string[],
  ): ImplementationToolResult | null =>
    paths.some((path) => isProtectedPath(path))
      ? refuseProtected(tool, kind, options.identity, operationId)
      : null;
  const refuseOutside = (
    tool: string,
    kind: ToolKind,
    operationId: string,
  ): ImplementationToolResult => {
    const value = canonicalJsonStringify({
      tool,
      refused: true,
      failure_code: TOOLSET_PATH_OUTSIDE_ALLOWED,
    });
    return implementationToolResult.parse({
      schema_version: 1,
      operation_id: operationId,
      identity: options.identity,
      kind,
      outcome: ToolOutcome.FAILED,
      before_digest: null,
      after_digest: null,
      changed_files: [],
      failure_code: TOOLSET_PATH_OUTSIDE_ALLOWED,
      output: {
        trust: TrustLevel.UNTRUSTED_DATA,
        value,
        truncated: false,
        original_byte_length: encoder.encode(value).length,
      },
    });
  };

  return Object.freeze({
    read: async (raw) => {
      const input = boundedRead.parse(raw);
      const operationId = nextId("read");
      return observe(
        protectedResult("read", ToolKind.READ_FILE, operationId, [input.relative_path]) ??
          (await reads.read({ operation_id: operationId, relative_path: input.relative_path })),
      );
    },
    search: async (raw) => {
      const input = boundedSearch.parse(raw);
      return observe(
        filterResultPaths(
          await reads.search({ operation_id: nextId("search"), query: input.query }),
        ),
      );
    },
    tree: async (raw) => {
      const input = boundedTree.parse(raw);
      const operation_id = nextId("tree");
      const denied = protectedResult(
        "tree",
        ToolKind.LIST_FILES,
        operation_id,
        input.relative_path === undefined ? [] : [input.relative_path],
      );
      if (denied !== null) return observe(denied);
      return observe(
        filterResultPaths(
          await reads.tree(
            input.relative_path === undefined
              ? { operation_id }
              : { operation_id, relative_path: input.relative_path },
          ),
        ),
      );
    },
    config: async (raw) => {
      const input = boundedRead.parse(raw);
      const operationId = nextId("config");
      return observe(
        protectedResult("config", ToolKind.READ_FILE, operationId, [input.relative_path]) ??
          (await reads.config({ operation_id: operationId, relative_path: input.relative_path })),
      );
    },
    write: async (raw) => {
      const input = boundedWrite.parse(raw);
      const operationId = nextId("write");
      if (!isAllowed(input.relative_path)) {
        return observe(refuseOutside("write", ToolKind.WRITE_FILE, operationId));
      }
      const denied = protectedResult("write", ToolKind.WRITE_FILE, operationId, [
        input.relative_path,
      ]);
      if (denied !== null) return observe(denied);
      return observe(
        await writes.write(
          input.expected_before_digest === undefined
            ? {
                operation_id: operationId,
                relative_path: input.relative_path,
                content: input.content,
              }
            : {
                operation_id: operationId,
                relative_path: input.relative_path,
                content: input.content,
                expected_before_digest: input.expected_before_digest,
              },
        ),
      );
    },
    patch: async (raw) => {
      const input = boundedPatch.parse(raw);
      const operationId = nextId("patch");
      if (input.files.some((file) => !isAllowed(file.relative_path))) {
        return observe(refuseOutside("patch", ToolKind.APPLY_PATCH, operationId));
      }
      const denied = protectedResult(
        "patch",
        ToolKind.APPLY_PATCH,
        operationId,
        input.files.map((file) => file.relative_path),
      );
      if (denied !== null) return observe(denied);
      return observe(
        await writes.patch(
          input.expected_before_digest === undefined
            ? { operation_id: operationId, files: input.files }
            : {
                operation_id: operationId,
                files: input.files,
                expected_before_digest: input.expected_before_digest,
              },
        ),
      );
    },
    mkdir: async (raw) => {
      const input = boundedMkdir.parse(raw);
      const operationId = nextId("mkdir");
      if (!isAllowed(input.relative_path)) {
        return observe(refuseOutside("mkdir", ToolKind.WRITE_FILE, operationId));
      }
      const denied = protectedResult("mkdir", ToolKind.WRITE_FILE, operationId, [
        input.relative_path,
      ]);
      if (denied !== null) return observe(denied);
      return observe(
        await mkdir.run(
          input.recursive === undefined
            ? { operation_id: operationId, relative_path: input.relative_path }
            : {
                operation_id: operationId,
                relative_path: input.relative_path,
                recursive: input.recursive,
              },
        ),
      );
    },
  });
}
