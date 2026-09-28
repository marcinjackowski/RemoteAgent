/**
 * The four read-only, model-facing tools: `read`, `search`, `tree`, `config`.
 *
 * This module is a *composition* layer, not a second implementation of bounded
 * reading. Every filesystem decision — canonical relative paths, symlink
 * rejection at every path component, the `.git` / `.env` / key-material
 * denylist, the file-byte, total-scan-byte, entry, depth and result limits, and
 * the shared `ScanBudget` accumulator — already lives in
 * `@remoteagent/repository-planner`'s discovery policy and is exercised by its
 * own suite. Re-deriving any of it here would create a second, divergent
 * boundary, so the only filesystem access in this file goes through
 * `createPlannerReadPort`.
 *
 * Two primitives are used directly:
 *
 * - `validateWorkspaceRoot` (`@remoteagent/workspace-runner` path policy) turns
 *   a raw string root into the branded `VerifiedWorkspacePath` the discovery
 *   layer demands, and refuses a root that is a symlink, has a symlinked
 *   component, or is too broad (`/`, `$HOME`, the temp dir);
 * - `createPlannerReadPort` (`@remoteagent/repository-planner`) supplies the
 *   bounded `read` / `search` / `tree` / `config` primitives, including the
 *   server-owned config allowlist and the scan budget shared across the files
 *   visited by one `search`.
 *
 * The write-oriented validators of `WorkspacePathPolicy`
 * (`validateCreateTarget`, `validateDestructiveTarget`, `validateCommandCwd`)
 * are deliberately not used: this layer has no write and no execute path at all,
 * which the delegated capability manifest states as data
 * (`can_write_workspace: false`, `can_execute_commands: false`).
 *
 * What this layer adds is the model-facing envelope:
 *
 * 1. every call returns an `ImplementationToolResult`, parsed before it is
 *    handed back, so a malformed envelope cannot leave this module;
 * 2. `before_digest` is `null` — a read pins no pre-state — and `after_digest`
 *    is the digest of the *complete* observation, computed before any output
 *    clipping, so re-reading unchanged state yields a byte-identical digest
 *    while the carried payload stays bounded;
 * 3. `changed_files` is always empty and `AMBIGUOUS` is never produced: a read
 *    performs no side effect, so there is no post-state that could fail to be
 *    established;
 * 4. output is bounded to `MAX_TOOL_OUTPUT_BYTES`. Clipping is never silent —
 *    whole items are dropped (or content is cut at a code-point boundary), the
 *    envelope sets `truncated: true` carrying the pre-clip
 *    `original_byte_length`, and the payload itself declares `complete: false`
 *    plus, for a listing, how many items were `dropped`.
 *
 * Refusals are returned, not thrown: a denied path is a `FAILED` envelope whose
 * `failure_code` is the policy code (`SYMLINK_NOT_ALLOWED`, `FILE_NOT_ALLOWED`,
 * `OVERSIZE`, ...). Error *messages* are deliberately dropped, because policy
 * messages embed absolute host paths and this output is read by a model.
 *
 * Request validation runs *before* the port is touched, against the very same
 * request schemas the port uses. That is what makes the two schema-failure modes
 * distinguishable: a rejected request is `INVALID_REQUEST` and reaches no
 * filesystem at all, whereas a schema failure after that point can only come
 * from the port's bounded content schema refusing to carry the observation
 * (`plannerReadResult`'s `text` caps content at 65_536 characters), which is
 * reported as `OUTPUT_TOO_LARGE`. Neither is ever a partial read.
 */
import { TrustLevel, canonicalDigest, canonicalJsonStringify } from "@remoteagent/contracts";
import {
  DiscoveryPolicyError,
  createPlannerReadPort,
  plannerConfigRequest,
  plannerReadRequest,
  plannerReadExcerptRequest,
  plannerSearchRequest,
  plannerTreeRequest,
} from "@remoteagent/repository-planner";
import type { PlannerCapabilityManifest, PlannerReadPort } from "@remoteagent/repository-planner";
import { WorkspacePathPolicyError, validateWorkspaceRoot } from "@remoteagent/workspace-runner";
import * as z from "zod";

import {
  MAX_TOOL_OUTPUT_BYTES,
  ToolKind,
  ToolOutcome,
  implementationToolResult,
} from "./contracts.js";
import type { ImplementationToolResult, ToolIdentity, ToolOutput } from "./contracts.js";

/** The four read-only tools exposed to the model. */
export type ImplementationReadToolName = "read" | "search" | "tree" | "config";

/**
 * Mapping from tool to the closed `ToolKind` set.
 *
 * `config` has no dedicated kind and does not get one: it is a file read whose
 * only difference from `read` is that the path must be on the server-owned
 * configuration allowlist. Its effect class is therefore `READ_FILE`. Mapping it
 * to `LIST_FILES` would describe the payload as a directory listing, which it is
 * not — the payload is one file's bytes. The tool name is carried inside the
 * payload, so the two are still distinguishable by a consumer.
 */
export const IMPLEMENTATION_READ_TOOL_KINDS: Readonly<
  Record<ImplementationReadToolName, ToolKind>
> = Object.freeze({
  read: ToolKind.READ_FILE,
  search: ToolKind.SEARCH_TEXT,
  tree: ToolKind.LIST_FILES,
  config: ToolKind.READ_FILE,
});

/** The observation exceeded a payload bound and no honest clipping exists. */
export const OUTPUT_TOO_LARGE = "OUTPUT_TOO_LARGE";

/** The request violated the path/query contract; no filesystem was touched. */
export const INVALID_READ_REQUEST = "INVALID_REQUEST";

const READ_TOOL_FAILED = "READ_TOOL_FAILED";

/** Raised by request pre-validation, so it cannot be confused with a result. */
class InvalidReadRequestError extends Error {
  public constructor() {
    super(INVALID_READ_REQUEST);
    this.name = "InvalidReadRequestError";
  }
}

export type ImplementationReadToolsOptions = Readonly<{
  /** Workspace root; validated by the workspace-runner path policy. */
  root: string;
  identity: ToolIdentity;
}>;

export type ImplementationReadToolsInput = Readonly<{ operation_id: string }>;

export type ImplementationReadTools = Readonly<{
  /** Delegated, read-only capability manifest; no write or execute capability. */
  readonly manifest: PlannerCapabilityManifest;
  read(
    input: ImplementationReadToolsInput & { readonly relative_path: string },
  ): Promise<ImplementationToolResult>;
  /** Server-only diagnostic range read; never included in model tool definitions. */
  readExcerpt(
    input: ImplementationReadToolsInput & {
      readonly relative_path: string;
      readonly start_line: number;
      readonly end_line: number;
    },
  ): Promise<ImplementationToolResult>;
  search(
    input: ImplementationReadToolsInput & {
      readonly query: string;
      readonly relative_path?: string;
    },
  ): Promise<ImplementationToolResult>;
  tree(
    input: ImplementationReadToolsInput & { readonly relative_path?: string },
  ): Promise<ImplementationToolResult>;
  config(
    input: ImplementationReadToolsInput & { readonly relative_path: string },
  ): Promise<ImplementationToolResult>;
}>;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** Pre-validate a request with the port's own schema; never touches the disk. */
function request<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidReadRequestError();
  return parsed.data;
}

/**
 * Largest `n` in `[0, hi]` whose rendered payload fits the output bound.
 *
 * `render` is monotonic in `n` (more items, or more characters, never shrink the
 * rendering), so a binary search is exact and costs `log2(hi)` renderings
 * instead of `hi`.
 */
function largestFitting(hi: number, render: (n: number) => string): number {
  let low = 0;
  let high = hi;
  let best = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(render(mid)) <= MAX_TOOL_OUTPUT_BYTES) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // Not even the empty rendering fits, so there is nothing honest to return.
  if (best < 0) throw new DiscoveryPolicyError("OVERSIZE", OUTPUT_TOO_LARGE);
  return best;
}

/** Cut at a code-point boundary so clipping cannot split a surrogate pair. */
function clip(content: string, units: number): string {
  const code = units > 0 && units < content.length ? content.charCodeAt(units - 1) : 0;
  const end = code >= 0xd800 && code <= 0xdbff ? units - 1 : units;
  return content.slice(0, end);
}

type Presented = Readonly<{ output: ToolOutput; digest: string }>;

/**
 * Render an observation into a bounded `ToolOutput`.
 *
 * The digest is always taken over the *complete* observation, never over the
 * clipped rendering, so truncation does not perturb it and a repeated read of
 * unchanged state stays byte-identical.
 */
function present(complete: unknown, render: (kept: number) => string, hi: number): Presented {
  const completeJson = canonicalJsonStringify(complete);
  const original = byteLength(completeJson);
  const digest = canonicalDigest(complete);
  if (original <= MAX_TOOL_OUTPUT_BYTES) {
    return {
      digest,
      output: {
        trust: TrustLevel.UNTRUSTED_DATA,
        value: completeJson,
        truncated: false,
        original_byte_length: original,
      },
    };
  }
  return {
    digest,
    output: {
      trust: TrustLevel.UNTRUSTED_DATA,
      value: render(largestFitting(hi, render)),
      truncated: true,
      original_byte_length: original,
    },
  };
}

type FileObservation = Readonly<{ relativePath: string; digest: string; content: string }>;

function presentFile(tool: ImplementationReadToolName, file: FileObservation): Presented {
  const payload = (complete: boolean, content: string) => ({
    tool,
    refused: false,
    complete,
    relative_path: file.relativePath,
    digest: file.digest,
    content,
  });
  return present(
    payload(true, file.content),
    (kept) => canonicalJsonStringify(payload(false, clip(file.content, kept))),
    file.content.length,
  );
}

type ListItem = Readonly<Record<string, string | number>>;

function presentList(tool: ImplementationReadToolName, items: readonly ListItem[]): Presented {
  const payload = (kept: number, complete: boolean) => ({
    tool,
    refused: false,
    complete,
    dropped: items.length - kept,
    items: items.slice(0, kept),
  });
  return present(
    payload(items.length, true),
    (kept) => canonicalJsonStringify(payload(kept, false)),
    items.length,
  );
}

/**
 * Map a thrown boundary error onto a stable `failure_code`.
 *
 * Only the code travels. Policy error messages contain absolute host paths, and
 * this output is model-visible.
 */
function failureCode(error: unknown): string {
  if (error instanceof InvalidReadRequestError) return INVALID_READ_REQUEST;
  if (error instanceof DiscoveryPolicyError) {
    return error.message === OUTPUT_TOO_LARGE ? OUTPUT_TOO_LARGE : error.code;
  }
  if (error instanceof WorkspacePathPolicyError) return error.code;
  // The request already validated, so the only remaining schema failure is the
  // port's bounded content schema refusing to carry the observation.
  if (error instanceof z.ZodError) return OUTPUT_TOO_LARGE;
  return READ_TOOL_FAILED;
}

function refuse(
  tool: ImplementationReadToolName,
  identity: ToolIdentity,
  operationId: string,
  error: unknown,
): ImplementationToolResult {
  const code = failureCode(error);
  const value = canonicalJsonStringify({
    tool,
    refused: true,
    failure_code: code,
    ...(code === "DISCOVERY_FAILED" || code === "FILE_NOT_FOUND"
      ? { next_action: "Use search with a filename fragment before another read." }
      : {}),
  });
  return implementationToolResult.parse({
    schema_version: 1,
    operation_id: operationId,
    identity,
    kind: IMPLEMENTATION_READ_TOOL_KINDS[tool],
    outcome: ToolOutcome.FAILED,
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: code,
    output: {
      trust: TrustLevel.UNTRUSTED_DATA,
      value,
      truncated: false,
      original_byte_length: byteLength(value),
    },
  });
}

function succeed(
  tool: ImplementationReadToolName,
  identity: ToolIdentity,
  operationId: string,
  presented: Presented,
): ImplementationToolResult {
  return implementationToolResult.parse({
    schema_version: 1,
    operation_id: operationId,
    identity,
    kind: IMPLEMENTATION_READ_TOOL_KINDS[tool],
    outcome: ToolOutcome.SUCCEEDED,
    before_digest: null,
    // A read mutates nothing, so the observed post-state *is* the state read.
    after_digest: presented.digest,
    changed_files: [],
    output: presented.output,
  });
}

async function run(
  tool: ImplementationReadToolName,
  identity: ToolIdentity,
  operationId: string,
  observe: () => Promise<Presented>,
): Promise<ImplementationToolResult> {
  try {
    return succeed(tool, identity, operationId, await observe());
  } catch (error) {
    return refuse(tool, identity, operationId, error);
  }
}

/**
 * Build the four read-only tools over a workspace root.
 *
 * Root validation happens once, here, and throws rather than returning an
 * envelope: an unusable root is a deterministic server-side configuration fault,
 * not a model-visible tool outcome.
 */
export async function createImplementationReadTools(
  options: ImplementationReadToolsOptions,
): Promise<ImplementationReadTools> {
  const root = await validateWorkspaceRoot(options.root);
  const port: PlannerReadPort = await createPlannerReadPort(root);
  const { identity } = options;
  return Object.freeze({
    manifest: port.manifest,
    read: (input) =>
      run("read", identity, input.operation_id, async () => {
        const parsed = request(plannerReadRequest, { relative_path: input.relative_path });
        const result = await port.read(parsed);
        return presentFile("read", {
          relativePath: result.relative_path,
          digest: result.digest,
          content: result.content.value,
        });
      }),
    readExcerpt: (input) =>
      run("read" as ImplementationReadToolName, identity, input.operation_id, async () => {
        const parsed = request(plannerReadExcerptRequest, {
          relative_path: input.relative_path,
          start_line: input.start_line,
          end_line: input.end_line,
        });
        const result = await port.readExcerpt(parsed);
        return present(
          {
            tool: "read_excerpt",
            refused: false,
            complete: false,
            relative_path: result.relative_path,
            start_line: result.start_line,
            end_line: result.end_line,
            full_file_digest: result.full_file_digest,
            end_of_file: result.end_of_file,
            content: result.content.value,
          },
          (kept) =>
            canonicalJsonStringify({
              tool: "read_excerpt",
              refused: false,
              complete: false,
              relative_path: result.relative_path,
              start_line: result.start_line,
              end_line: result.end_line,
              full_file_digest: result.full_file_digest,
              end_of_file: result.end_of_file,
              content: clip(result.content.value, kept),
            }),
          result.content.value.length,
        );
      }),
    config: (input) =>
      run("config", identity, input.operation_id, async () => {
        const parsed = request(plannerConfigRequest, { relative_path: input.relative_path });
        const result = await port.config(parsed);
        const [entry] = result.entries;
        if (entry === undefined)
          throw new DiscoveryPolicyError("FILE_NOT_ALLOWED", "Config produced no entry");
        return presentFile("config", {
          relativePath: entry.provenance.relative_path,
          digest: entry.provenance.digest,
          content: entry.content.value,
        });
      }),
    search: (input) =>
      run("search", identity, input.operation_id, async () => {
        const parsed = request(plannerSearchRequest, {
          query: input.query,
          ...(input.relative_path === undefined ? {} : { relative_path: input.relative_path }),
        });
        const result = await port.search(parsed);
        return presentList(
          "search",
          result.matches.map((match) => ({
            relative_path: match.provenance.relative_path,
            digest: match.provenance.digest,
            line: match.line,
            content: match.content.value,
          })),
        );
      }),
    tree: (input) =>
      run("tree", identity, input.operation_id, async () => {
        const parsed = request(
          plannerTreeRequest,
          input.relative_path === undefined ? {} : { relative_path: input.relative_path },
        );
        const result = await port.tree(parsed);
        return presentList(
          "tree",
          result.entries.map((entry) => ({
            relative_path: entry.provenance.relative_path,
            kind: entry.kind,
            digest: entry.provenance.digest,
          })),
        );
      }),
  });
}
