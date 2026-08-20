/**
 * Artifact store: a port with a local filesystem adapter.
 *
 * Two acceptance criteria live here and both are about what survives.
 *
 * **Criterion 5 — secrets are redacted in excerpts AND in the full stored logs.**
 * Redaction happens on the way IN, once, before any byte reaches the disk. There
 * is no "store raw, redact on read" path, because the raw file would then be the
 * leak. The store cannot be handed unredacted bytes and asked to keep them.
 *
 * The redactor is `redactCommandOutput` from `@remoteagent/implementation-tools`,
 * NOT `SecretRedactor` from `@remoteagent/observability`. This looks like the
 * wrong choice — observability is the package that owns redaction — and it needs
 * justifying: `CTF-006` established by probe that `SecretRedactor` passes through
 * absolute host paths, `glpat-`, `AKIA`, private key blocks and JWTs, which is
 * precisely the content test output is full of. Using it alone would satisfy
 * "redaction is enabled" while failing criterion 5. `redactCommandOutput` already
 * carries the complete pattern set, was accepted in RA-012, and reusing it avoids
 * creating a *fourth* independent pattern table for RA-024 to unify. When RA-024
 * moves the patterns into `observability`, both packages consume one source.
 *
 * **Criterion 6 — retention and size limits must not erase audit metadata.** A
 * size limit truncates the stored BYTES; it never deletes the
 * {@link ArtifactReference}. The reference keeps `digest` (over what was actually
 * stored, so integrity is verifiable), `byte_length`, `original_byte_length` and
 * `complete: false`. So "this log was 40 MB, we kept the first 1 MB, here is the
 * digest of what we kept" remains a checkable statement. Pruning is symmetric:
 * {@link LocalArtifactStore.prune} removes payload files and reports what it
 * removed, and a reference whose payload is gone reads back as absent rather than
 * as corrupt — the caller learns the bytes are unavailable, not that the run never
 * happened.
 *
 * Scope isolation is structural: every artifact is stored under
 * `<case_id>/<workspace_id>/`, both path components are validated as single safe
 * segments, and a read is scoped, so one case cannot address another's artifacts
 * even knowing the id.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { redactCommandOutput } from "@remoteagent/implementation-tools";
import * as z from "zod";

import { artifactReference } from "./contracts.js";
import type { ArtifactReference, EvidenceScope } from "./contracts.js";

/** Default ceiling on the bytes one artifact may occupy on disk. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 4_194_304;

/** The request was not storable; nothing was written. */
export const ARTIFACT_INVALID_REQUEST = "INVALID_REQUEST";

/** The stored payload is missing or does not match its recorded digest. */
export const ARTIFACT_INTEGRITY_FAILED = "INTEGRITY_FAILED";

/** Raised for faults this module classifies itself. */
export class ArtifactStoreError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

/**
 * One path segment: no separators, no traversal, no NUL, no absolute form.
 *
 * Applied to `case_id` and `workspace_id` before they become directory names.
 * They are server-minted today, but a store that is only safe because its caller
 * is well-behaved is not a boundary.
 */
const safeSegment = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value !== "." &&
      value !== "..",
    { message: "identifier must be a single safe path segment" },
  );

const putRequest = z.strictObject({
  artifact_id: safeSegment,
  scope: z.strictObject({ case_id: safeSegment, workspace_id: safeSegment }),
  content: z.string(),
});

export type ArtifactPutRequest = Readonly<{
  artifact_id: string;
  scope: EvidenceScope;
  /** Raw output. Redacted by this module before it is written. */
  content: string;
}>;

export type ArtifactStoreOptions = Readonly<{
  /** Directory that holds every artifact. Must be outside any workspace root. */
  root: string;
  maxArtifactBytes?: number;
  /**
   * Literal secrets the server already knows. Substituted before the pattern
   * table runs, so a value known to be sensitive is removed even in a shape the
   * patterns do not recognize.
   */
  knownSecrets?: readonly string[];
}>;

/**
 * The port. RA-025 adds an S3 adapter behind this same interface, which is why
 * `put` takes and returns plain data and exposes no filesystem concepts.
 */
export type ArtifactStore = Readonly<{
  put(request: ArtifactPutRequest): Promise<ArtifactReference>;
  /** Read back the stored bytes, verifying the digest. */
  get(reference: ArtifactReference): Promise<string>;
  /** Whether the payload is still present, without reading it. */
  has(reference: ArtifactReference): Promise<boolean>;
}>;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Cut at a code-point boundary so clipping cannot split a surrogate pair. */
function clipToBytes(value: string, limit: number): string {
  if (byteLength(value) <= limit) return value;
  // Byte-length is not proportional to code-unit count under UTF-8, so search for
  // the largest prefix that fits rather than assuming a ratio.
  let low = 0;
  let high = value.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (byteLength(value.slice(0, mid)) <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const code = best > 0 ? value.charCodeAt(best - 1) : 0;
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? best - 1 : best);
}

/**
 * Local filesystem artifact store.
 *
 * Layout: `<root>/<case_id>/<workspace_id>/<artifact_id>.log`. The reference's
 * `relative_path` is store-relative and never absolute, so a reference can be
 * persisted, logged and shown to a model without leaking host topology.
 */
export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #knownSecrets: readonly string[];

  public constructor(options: ArtifactStoreOptions) {
    this.#root = resolve(options.root);
    this.#maxBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new ArtifactStoreError(ARTIFACT_INVALID_REQUEST, "maxArtifactBytes must be positive");
    }
    this.#knownSecrets = [...(options.knownSecrets ?? [])].filter((item) => item.length > 0);
  }

  /** Absolute path for a reference, re-validated against the store root. */
  #absolute(relativePath: string): string {
    const target = resolve(this.#root, relativePath);
    // Defence in depth: `relative_path` is built by this class, but a reference
    // read back from storage is data and must not be able to escape the root.
    if (target !== this.#root && !target.startsWith(this.#root + sep)) {
      throw new ArtifactStoreError(ARTIFACT_INVALID_REQUEST, "artifact path escapes the store");
    }
    return target;
  }

  /**
   * Redact, bound, hash and write — in that order.
   *
   * The order is the guarantee. Redaction precedes both the size bound and the
   * hash, so the digest covers redacted bytes and there is no window in which
   * unredacted content exists on disk. Truncation is recorded, never silent.
   */
  public async put(request: ArtifactPutRequest): Promise<ArtifactReference> {
    const parsed = putRequest.safeParse(request);
    if (!parsed.success) {
      throw new ArtifactStoreError(ARTIFACT_INVALID_REQUEST, "artifact request is not storable");
    }
    const { artifact_id: artifactId, scope, content } = parsed.data;

    const redacted = redactCommandOutput(content, this.#knownSecrets);
    const originalByteLength = byteLength(redacted);
    const stored = clipToBytes(redacted, this.#maxBytes);
    const storedByteLength = byteLength(stored);

    const relativeDirectory = `${scope.case_id}/${scope.workspace_id}`;
    const relativePath = `${relativeDirectory}/${artifactId}.log`;
    const absolute = this.#absolute(relativePath);
    await mkdir(join(this.#root, scope.case_id, scope.workspace_id), { recursive: true });
    await writeFile(absolute, stored, { encoding: "utf8", mode: 0o600 });

    return artifactReference.parse({
      artifact_id: artifactId,
      scope,
      relative_path: relativePath,
      // Over the STORED bytes, so integrity is verifiable against the file.
      digest: sha256(stored),
      byte_length: storedByteLength,
      complete: storedByteLength === originalByteLength,
      original_byte_length: originalByteLength,
    });
  }

  /**
   * Read the payload and verify it against the reference.
   *
   * A digest mismatch is an explicit `INTEGRITY_FAILED`, never a silently
   * returned body: an artifact that does not match its receipt is not evidence,
   * and returning it would let tampered output masquerade as verified.
   */
  public async get(reference: ArtifactReference): Promise<string> {
    const absolute = this.#absolute(reference.relative_path);
    const content = await readFile(absolute, "utf8").catch(() => {
      throw new ArtifactStoreError(ARTIFACT_INTEGRITY_FAILED, "artifact payload is unavailable");
    });
    if (sha256(content) !== reference.digest) {
      throw new ArtifactStoreError(ARTIFACT_INTEGRITY_FAILED, "artifact digest does not match");
    }
    return content;
  }

  public async has(reference: ArtifactReference): Promise<boolean> {
    try {
      const target = await stat(this.#absolute(reference.relative_path));
      return target.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Delete payloads for a scope, keeping the audit trail intact.
   *
   * This is the retention mechanism and it is deliberately narrow: it removes
   * BYTES and returns the count removed. It cannot touch an
   * {@link ArtifactReference} or a `TestRun`, because those live in the caller's
   * records — which is exactly criterion 6. After pruning, a reader still knows a
   * run happened, what its outcome was, how large its output had been and what the
   * digest of the kept bytes was; only the bytes themselves are gone, and
   * {@link has} reports that honestly.
   */
  public async prune(scope: EvidenceScope): Promise<number> {
    const parsedScope = z
      .strictObject({ case_id: safeSegment, workspace_id: safeSegment })
      .safeParse(scope);
    if (!parsedScope.success) {
      throw new ArtifactStoreError(ARTIFACT_INVALID_REQUEST, "scope is not a safe path");
    }
    const directory = join(this.#root, parsedScope.data.case_id, parsedScope.data.workspace_id);
    const entries = await readdir(directory).catch(() => null);
    if (entries === null) return 0;
    let removed = 0;
    for (const entry of entries) {
      // `readdir` output is data; re-validate before it becomes a path.
      if (!safeSegment.safeParse(entry).success) continue;
      await rm(join(directory, entry), { force: true });
      removed += 1;
    }
    return removed;
  }
}
