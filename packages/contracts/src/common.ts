/**
 * Shared primitive schemas and versioning helpers for all RemoteAgent
 * contracts.
 *
 * Every boundary contract carries a `schema_version` (see {@link schemaVersion})
 * and every boundary object is a *strict* object so unknown fields are rejected
 * fail-closed (RA-002 acceptance criteria 1 and 2). Domain modules build on the
 * helpers here instead of re-deriving them, keeping the package a single source
 * of truth.
 */
import * as z from "zod";

/** Current schema version for every contract defined in this task (RA-002). */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * Contract schema version.
 *
 * Migration strategy: `schema_version` is a monotonically increasing positive
 * integer per contract. Boundary schemas in this package are *pinned* to the
 * exact {@link CURRENT_SCHEMA_VERSION} they were authored for: a parser accepts
 * only the version it understands and rejects everything else fail-closed. In
 * particular a *pure* future envelope (e.g. `schema_version: 2` with no extra
 * fields) is rejected rather than best-effort parsed, so forward-incompatible
 * data can never slip through unnoticed.
 *
 * A breaking change (removed/renamed field, narrowed type, changed semantics)
 * increments the version and ships a new schema revision plus a compatibility
 * fixture; additive optional fields keep the same version. When a new version is
 * introduced, this literal is bumped and the older revision is preserved
 * alongside it for explicit, versioned migration — never by widening the accepted
 * set to "any positive integer".
 */
export const schemaVersion = z.literal(CURRENT_SCHEMA_VERSION);

/** Non-empty, trimmed identifier string used for the many opaque IDs. */
export const idString = z.string().trim().min(1).max(512);

/** RFC 3339 / ISO-8601 timestamp string, validated as a real instant. */
export const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO-8601 timestamp",
});

/** A single, non-empty short label. */
export const label = z.string().trim().min(1).max(1024);

/** Free-form human text with an upper bound to avoid unbounded payloads. */
export const text = z.string().max(65_536);

/**
 * Build a strict boundary object schema that additionally requires a
 * `schema_version`. Using this for every externally-visible contract guarantees
 * consistent fail-closed behavior and a uniform version field.
 */
export function versionedContract<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject({
    schema_version: schemaVersion,
    ...shape,
  });
}

/** Convenience: a strict object with no version field (nested value objects). */
export function valueObject<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape);
}
