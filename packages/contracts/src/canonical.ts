/**
 * Canonical JSON serialization and stable content digests.
 *
 * The canonical form is deterministic: object keys are emitted in sorted (UTF-16
 * code-unit) order at every depth, so two logically equal payloads always
 * produce byte-identical output and therefore an identical digest regardless of
 * the key order in which they were constructed (RA-002 acceptance criterion 4).
 *
 * `undefined` object properties are omitted (they are not valid JSON), while an
 * explicit `null` is preserved. Non-finite numbers, functions, symbols and
 * `bigint` are rejected: a contract that needs large integers must model them as
 * strings so the canonical form stays lossless and portable.
 */
import { createHash } from "node:crypto";

/** Value shapes that can appear in a canonical JSON document. */
export type CanonicalJsonValue =
  string | number | boolean | null | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

/** Raised when a value cannot be represented in canonical JSON. */
export class CanonicalJsonError extends Error {
  public readonly path: string;

  public constructor(message: string, path: string) {
    super(`${message} (at ${path === "" ? "<root>" : path})`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

function encode(value: unknown, path: string): string {
  if (value === null) {
    return "null";
  }

  const valueType = typeof value;

  if (valueType === "string") {
    return JSON.stringify(value);
  }

  if (valueType === "boolean") {
    return value ? "true" : "false";
  }

  if (valueType === "number") {
    if (!Number.isFinite(value as number)) {
      throw new CanonicalJsonError("Non-finite numbers cannot be serialized", path);
    }
    // JSON.stringify yields the shortest round-trippable form for finite numbers.
    return JSON.stringify(value);
  }

  if (valueType === "bigint") {
    throw new CanonicalJsonError("bigint is not supported; model large integers as strings", path);
  }

  if (valueType === "undefined" || valueType === "function" || valueType === "symbol") {
    throw new CanonicalJsonError(`${valueType} cannot be serialized`, path);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      // `undefined` array holes serialize to null in JSON; forbid them so the
      // canonical form never silently rewrites data.
      if (item === undefined) {
        throw new CanonicalJsonError(
          "undefined array element cannot be serialized",
          `${path}[${index}]`,
        );
      }
      return encode(item, `${path}[${index}]`);
    });
    return `[${items.join(",")}]`;
  }

  // Plain object. Reject exotic objects (Date, Map, class instances) so callers
  // must pass already-normalized data.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalJsonError("Only plain objects, arrays and primitives are supported", path);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const childValue = record[key];
    if (childValue === undefined) {
      // Omit undefined properties rather than emitting invalid JSON.
      continue;
    }
    const childPath = path === "" ? key : `${path}.${key}`;
    parts.push(`${JSON.stringify(key)}:${encode(childValue, childPath)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Serialize a value to its canonical JSON string form. */
export function canonicalJsonStringify(value: unknown): string {
  return encode(value, "");
}

/**
 * Compute a stable digest of a value.
 *
 * The digest is `sha256:<hex>` over the UTF-8 bytes of the canonical JSON form,
 * making it suitable as an `action_digest` or any contract identity that must be
 * reproducible across processes and key orderings.
 */
export function canonicalDigest(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hash}`;
}
