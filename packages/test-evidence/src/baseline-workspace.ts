import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalDigest, idString, sha256Digest } from "@remoteagent/contracts";
import { computeTreeDigest, validateWorkspaceRoot } from "@remoteagent/workspace-runner";
import * as z from "zod";

import {
  assertSafeVerificationTree,
  assertVerificationTreeHasNoGitEdges,
  cleanupVerificationTree,
} from "./disposable-workspace.js";

export const BaselineWorkspaceErrorCode = {
  INVALID_BINDING: "INVALID_BINDING",
  UNSAFE_LOCATION: "UNSAFE_LOCATION",
  SNAPSHOT_MISMATCH: "SNAPSHOT_MISMATCH",
  BASELINE_MISSING: "BASELINE_MISSING",
  BASELINE_CHANGED: "BASELINE_CHANGED",
  MANIFEST_MISMATCH: "MANIFEST_MISMATCH",
} as const;

export type BaselineWorkspaceErrorCode =
  (typeof BaselineWorkspaceErrorCode)[keyof typeof BaselineWorkspaceErrorCode];

export class BaselineWorkspaceError extends Error {
  public constructor(
    public readonly code: BaselineWorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BaselineWorkspaceError";
  }
}

export const BaselineWorkspaceBinding = z
  .object({
    case_id: idString,
    workspace_id: idString,
    run_id: idString,
    checkpoint_revision: z.int().nonnegative(),
    slice_id: idString,
    attempt: z.int().positive(),
  })
  .strict();
export type BaselineWorkspaceBinding = z.infer<typeof BaselineWorkspaceBinding>;

export const BaselineWorkspaceReference = z
  .object({
    baseline_id: z.string().regex(/^slice-baseline-[0-9a-f]{64}$/u),
    tree_digest: sha256Digest,
  })
  .strict();
export type BaselineWorkspaceReference = z.infer<typeof BaselineWorkspaceReference>;

const manifestSchema = z
  .object({
    schema_version: z.literal(1),
    baseline_id: z.string().regex(/^slice-baseline-[0-9a-f]{64}$/u),
    binding_digest: sha256Digest,
    authority_path_digest: sha256Digest,
    tree_digest: sha256Digest,
  })
  .strict();

type BaselineManifest = z.infer<typeof manifestSchema>;

type LeafEntry = Readonly<{ kind: "file" | "symlink"; mode: number; content: string }>;

type ExpectedBaseline = Readonly<{
  binding: BaselineWorkspaceBinding;
  authority: string;
  store: string;
  id: string;
  bindingDigest: string;
  authorityPathDigest: string;
}>;

function contained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}

async function leafInventory(
  root: string,
  current = root,
  output = new Map<string, LeafEntry>(),
): Promise<Map<string, LeafEntry>> {
  for (const name of (await readdir(current)).sort()) {
    if (name === ".git") {
      if (current === root) continue;
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.BASELINE_CHANGED,
        `nested repository control edge is forbidden: ${relative(root, join(current, name)).split(sep).join("/")}`,
      );
    }
    const absolute = join(current, name);
    const path = relative(root, absolute).split(sep).join("/");
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      await leafInventory(root, absolute, output);
    } else if (stat.isSymbolicLink()) {
      output.set(path, {
        kind: "symlink",
        mode: stat.mode & 0o7777,
        content: await readlink(absolute),
      });
    } else if (stat.isFile()) {
      const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
      const handle = await open(absolute, constants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) {
          throw new BaselineWorkspaceError(
            BaselineWorkspaceErrorCode.BASELINE_CHANGED,
            `tree leaf changed while being read: ${path}`,
          );
        }
        output.set(path, {
          kind: "file",
          mode: opened.mode & 0o7777,
          content: createHash("sha256")
            .update(await handle.readFile())
            .digest("hex"),
        });
      } finally {
        await handle.close();
      }
    } else {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.BASELINE_CHANGED,
        `unsupported tree leaf: ${path}`,
      );
    }
  }
  return output;
}

export type BaselineTreeDelta = Readonly<{
  baseline_tree_digest: string;
  current_tree_digest: string;
  changed_paths: readonly string[];
}>;

/** Compare leaf bytes/types/modes; unlike `git status`, this isolates one slice from prior slices. */
export async function deriveBaselineTreeDelta(
  baselineRoot: string,
  currentRoot: string,
): Promise<BaselineTreeDelta> {
  const [baseline, current] = await Promise.all([
    validateWorkspaceRoot(baselineRoot),
    validateWorkspaceRoot(currentRoot),
  ]);
  if (baseline === current) {
    throw new BaselineWorkspaceError(
      BaselineWorkspaceErrorCode.UNSAFE_LOCATION,
      "baseline and current roots must be distinct",
    );
  }
  await Promise.all([assertSafeVerificationTree(baseline), assertSafeVerificationTree(current)]);
  const [baselineDigest, currentDigest, baselineLeaves, currentLeaves] = await Promise.all([
    computeTreeDigest(baseline),
    computeTreeDigest(current),
    leafInventory(baseline),
    leafInventory(current),
  ]);
  const paths = new Set([...baselineLeaves.keys(), ...currentLeaves.keys()]);
  const changed = [...paths].filter((path) => {
    const before = baselineLeaves.get(path);
    const after = currentLeaves.get(path);
    return (
      before === undefined ||
      after === undefined ||
      before.kind !== after.kind ||
      before.mode !== after.mode ||
      before.content !== after.content
    );
  });
  return Object.freeze({
    baseline_tree_digest: baselineDigest,
    current_tree_digest: currentDigest,
    changed_paths: Object.freeze(changed.sort()),
  });
}

function baselineIdentity(
  binding: BaselineWorkspaceBinding,
  authorityPathDigest: string,
): { id: string; bindingDigest: string } {
  const bindingDigest = canonicalDigest(binding);
  return {
    id: `slice-baseline-${canonicalDigest({ binding_digest: bindingDigest, authority_path_digest: authorityPathDigest }).slice("sha256:".length)}`,
    bindingDigest,
  };
}

export type BaselineWorkspaceStoreOptions = Readonly<{
  /** Server-owned root outside every authoritative worktree. */
  root: string;
}>;

/**
 * Durable, opaque pre-slice snapshots. The filesystem path is never part of the
 * reference and therefore cannot be selected by a model or persisted as an
 * engineering artifact. A fresh store instance can recover the same reference.
 */
export class BaselineWorkspaceStore {
  readonly #configuredRoot: string;

  public constructor(options: BaselineWorkspaceStoreOptions) {
    this.#configuredRoot = resolve(options.root);
  }

  async #roots(authoritativeRoot: string): Promise<{ store: string; authority: string }> {
    const authority = await validateWorkspaceRoot(authoritativeRoot);
    // Resolve the already-existing server-owned parent before the first write.
    // This proves confinement even when the configured leaf does not exist yet,
    // and prevents an unsafe "baseline root inside worktree" request from
    // changing the authoritative tree before it is refused.
    const canonicalParent = await realpath(dirname(this.#configuredRoot)).catch(() => {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.UNSAFE_LOCATION,
        "baseline storage requires an existing server-owned parent",
      );
    });
    const candidate = join(canonicalParent, basename(this.#configuredRoot));
    if (
      candidate === authority ||
      contained(candidate, authority) ||
      contained(authority, candidate)
    ) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.UNSAFE_LOCATION,
        "baseline storage and the authoritative worktree must be disjoint",
      );
    }
    await mkdir(candidate, { mode: 0o700 }).catch((error: unknown) => {
      if (errorCode(error) !== "EEXIST") throw error;
    });
    const store = await realpath(candidate);
    if (store !== candidate) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.UNSAFE_LOCATION,
        "baseline storage root must be a canonical server-owned directory",
      );
    }
    return { store, authority };
  }

  async #expected(
    bindingInput: BaselineWorkspaceBinding,
    authoritativeRoot: string,
  ): Promise<ExpectedBaseline> {
    const parsed = BaselineWorkspaceBinding.safeParse(bindingInput);
    if (!parsed.success) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.INVALID_BINDING,
        "baseline binding is invalid",
      );
    }
    const roots = await this.#roots(authoritativeRoot);
    const authorityPathDigest = canonicalDigest({ canonical_authoritative_root: roots.authority });
    const identity = baselineIdentity(parsed.data, authorityPathDigest);
    return {
      binding: parsed.data,
      authority: roots.authority,
      store: roots.store,
      id: identity.id,
      bindingDigest: identity.bindingDigest,
      authorityPathDigest,
    };
  }

  async #readAndVerify(
    expected: ExpectedBaseline,
    reference?: BaselineWorkspaceReference,
  ): Promise<{ root: string; manifest: BaselineManifest }> {
    const manifest = await this.#readManifest(expected, reference);
    const parent = join(expected.store, expected.id);
    const root = join(parent, "tree");
    const verifiedRoot = await validateWorkspaceRoot(root).catch(() => {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.BASELINE_MISSING,
        "pre-slice baseline tree is missing",
      );
    });
    await assertVerificationTreeHasNoGitEdges(verifiedRoot);
    await assertSafeVerificationTree(verifiedRoot);
    const actualDigest = await computeTreeDigest(verifiedRoot);
    if (actualDigest !== manifest.tree_digest) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.BASELINE_CHANGED,
        "pre-slice baseline changed after capture",
      );
    }
    return { root: verifiedRoot, manifest };
  }

  async #readManifest(
    expected: ExpectedBaseline,
    reference?: BaselineWorkspaceReference,
  ): Promise<BaselineManifest> {
    const parent = join(expected.store, expected.id);
    let raw: string;
    try {
      raw = await readFile(join(parent, "manifest.json"), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new BaselineWorkspaceError(
          BaselineWorkspaceErrorCode.BASELINE_MISSING,
          "pre-slice baseline is missing",
        );
      }
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      decoded = null;
    }
    const parsed = manifestSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.baseline_id !== expected.id ||
      parsed.data.binding_digest !== expected.bindingDigest ||
      parsed.data.authority_path_digest !== expected.authorityPathDigest ||
      (reference !== undefined &&
        (reference.baseline_id !== parsed.data.baseline_id ||
          reference.tree_digest !== parsed.data.tree_digest))
    ) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.MANIFEST_MISMATCH,
        "pre-slice baseline manifest does not match its server binding",
      );
    }
    return parsed.data;
  }

  /** Capture the exact current tree, or verify an exact idempotent replay. */
  public async prepare(
    binding: BaselineWorkspaceBinding,
    authoritativeRoot: string,
  ): Promise<BaselineWorkspaceReference> {
    const expected = await this.#expected(binding, authoritativeRoot);
    const parent = join(expected.store, expected.id);
    const existing = await this.#readAndVerify(expected).catch((error: unknown) => {
      if (error instanceof BaselineWorkspaceError && error.code === "BASELINE_MISSING") return null;
      throw error;
    });
    if (existing !== null) {
      return BaselineWorkspaceReference.parse({
        baseline_id: existing.manifest.baseline_id,
        tree_digest: existing.manifest.tree_digest,
      });
    }

    await assertSafeVerificationTree(expected.authority);
    const authorityDigestBefore = await computeTreeDigest(expected.authority);
    const temporary = await mkdtemp(join(expected.store, ".creating-"));
    const tree = join(temporary, "tree");
    try {
      await cp(expected.authority, tree, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        filter: (source) => basename(source) !== ".git",
      });
      const verifiedTree = await validateWorkspaceRoot(tree);
      await assertSafeVerificationTree(expected.authority);
      await assertVerificationTreeHasNoGitEdges(verifiedTree);
      await assertSafeVerificationTree(verifiedTree);
      const [authorityDigestAfter, baselineDigest] = await Promise.all([
        computeTreeDigest(expected.authority),
        computeTreeDigest(verifiedTree),
      ]);
      if (
        authorityDigestAfter !== authorityDigestBefore ||
        baselineDigest !== authorityDigestBefore
      ) {
        throw new BaselineWorkspaceError(
          BaselineWorkspaceErrorCode.SNAPSHOT_MISMATCH,
          "pre-slice snapshot was not an exact atomic observation",
        );
      }
      const manifest = manifestSchema.parse({
        schema_version: 1,
        baseline_id: expected.id,
        binding_digest: expected.bindingDigest,
        authority_path_digest: expected.authorityPathDigest,
        tree_digest: baselineDigest,
      });
      await writeFile(join(temporary, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        await rename(temporary, parent);
      } catch (error) {
        if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
      }
    } finally {
      await cleanupVerificationTree(temporary);
    }
    const recovered = await this.#readAndVerify(expected);
    return BaselineWorkspaceReference.parse({
      baseline_id: recovered.manifest.baseline_id,
      tree_digest: recovered.manifest.tree_digest,
    });
  }

  /**
   * Recover and use the opaque snapshot. Its digest is checked both before use
   * and immediately before bounded cleanup. Cleanup also runs on callback error.
   */
  public async consume<T>(
    binding: BaselineWorkspaceBinding,
    authoritativeRoot: string,
    referenceInput: BaselineWorkspaceReference,
    run: (baselineRoot: string) => Promise<T>,
  ): Promise<T> {
    const reference = BaselineWorkspaceReference.parse(referenceInput);
    const expected = await this.#expected(binding, authoritativeRoot);
    if (reference.baseline_id !== expected.id) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.MANIFEST_MISMATCH,
        "pre-slice baseline reference belongs to another binding",
      );
    }
    const before = await this.#readAndVerify(expected, reference);
    const parent = join(expected.store, expected.id);
    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await run(before.root);
    } catch (error) {
      operationError = error;
    }
    let verificationError: unknown;
    try {
      await this.#readAndVerify(expected, reference);
    } catch (error) {
      verificationError = error;
    } finally {
      await cleanupVerificationTree(parent);
    }
    if (verificationError !== undefined) throw verificationError;
    if (operationError !== undefined) throw operationError;
    return value as T;
  }

  /** Verify and inspect without consuming; used between implementation and its gate stage. */
  public async inspect<T>(
    binding: BaselineWorkspaceBinding,
    authoritativeRoot: string,
    referenceInput: BaselineWorkspaceReference,
    read: (baselineRoot: string) => Promise<T>,
  ): Promise<T> {
    const reference = BaselineWorkspaceReference.parse(referenceInput);
    const expected = await this.#expected(binding, authoritativeRoot);
    if (reference.baseline_id !== expected.id) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.MANIFEST_MISMATCH,
        "pre-slice baseline reference belongs to another binding",
      );
    }
    const before = await this.#readAndVerify(expected, reference);
    let value: T | undefined;
    let operationError: unknown;
    try {
      value = await read(before.root);
    } catch (error) {
      operationError = error;
    }
    await this.#readAndVerify(expected, reference);
    if (operationError !== undefined) throw operationError;
    return value as T;
  }

  /**
   * Remove only the large tree after its engineering artifact is durable. The
   * small exact-binding manifest remains as an idempotency tombstone so a second
   * cleanup can distinguish "already cleaned" from a foreign or invented ref.
   */
  public async cleanup(
    binding: BaselineWorkspaceBinding,
    authoritativeRoot: string,
    referenceInput: BaselineWorkspaceReference,
  ): Promise<"CLEANED" | "ALREADY_CLEANED"> {
    const reference = BaselineWorkspaceReference.parse(referenceInput);
    const expected = await this.#expected(binding, authoritativeRoot);
    if (reference.baseline_id !== expected.id) {
      throw new BaselineWorkspaceError(
        BaselineWorkspaceErrorCode.MANIFEST_MISMATCH,
        "pre-slice baseline reference belongs to another binding",
      );
    }
    // Validate the tombstone even when its large tree has already gone. A
    // missing manifest is not idempotent success because there is then no proof
    // that this binding ever owned the requested baseline.
    await this.#readManifest(expected, reference);
    let verified: { root: string; manifest: BaselineManifest };
    try {
      verified = await this.#readAndVerify(expected, reference);
    } catch (error) {
      if (error instanceof BaselineWorkspaceError && error.code === "BASELINE_MISSING") {
        return "ALREADY_CLEANED";
      }
      throw error;
    }
    await cleanupVerificationTree(verified.root);
    return "CLEANED";
  }
}
