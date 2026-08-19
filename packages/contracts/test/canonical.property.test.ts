import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  canonicalDigest,
  canonicalJsonStringify,
  type CanonicalJsonValue,
} from "../src/canonical.js";

/**
 * Property-based tests: the canonical form and its digest must be invariant
 * under object key reordering at every depth (RA-002 acceptance criterion 4).
 *
 * We generate arbitrary JSON-like values, then independently generate a
 * *permutation* of every object's key order, and assert both the canonical
 * string and the digest are byte-identical between the two constructions.
 */

/** Arbitrary finite JSON value (no undefined, no non-finite numbers). */
const jsonArb: fc.Arbitrary<CanonicalJsonValue> = fc.letrec<{
  value: CanonicalJsonValue;
}>((tie) => ({
  value: fc.oneof(
    { maxDepth: 4 },
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 6 }),
    fc.dictionary(fc.string(), tie("value"), { maxKeys: 6 }),
  ),
})).value;

/**
 * Deep-clone a value while shuffling the property order of every plain object,
 * driven by the fast-check random source so orderings are exercised broadly.
 */
function reorderKeys(value: CanonicalJsonValue, rng: () => number): CanonicalJsonValue {
  if (Array.isArray(value)) {
    // Array element order is significant and must be preserved.
    return value.map((item) => reorderKeys(item, rng));
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    // Fisher–Yates using the provided pseudo-random source.
    for (let i = keys.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const ki = keys[i] as string;
      const kj = keys[j] as string;
      keys[i] = kj;
      keys[j] = ki;
    }
    const out: Record<string, CanonicalJsonValue> = {};
    for (const key of keys) {
      // Assignment to the legacy `__proto__` setter mutates the prototype and
      // silently drops that own JSON key. Define every property explicitly so
      // the permutation remains semantically identical for the full JSON key
      // space exercised by fast-check.
      Object.defineProperty(out, key, {
        value: reorderKeys(value[key] as CanonicalJsonValue, rng),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value;
}

describe("canonical JSON — property-based key-order invariance", () => {
  it("canonical string is identical for any key permutation", () => {
    fc.assert(
      fc.property(jsonArb, fc.integer(), (value, seed) => {
        let state = seed | 0;
        const rng = (): number => {
          // Deterministic LCG so failures are reproducible from the seed.
          state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
          return ((state >>> 0) % 1_000_000) / 1_000_000;
        };
        const reordered = reorderKeys(value, rng);
        expect(canonicalJsonStringify(reordered)).toBe(canonicalJsonStringify(value));
      }),
      { numRuns: 500 },
    );
  });

  it("digest is identical for any key permutation", () => {
    fc.assert(
      fc.property(jsonArb, fc.integer(), (value, seed) => {
        let state = (seed ^ 0x9e37_79b9) | 0;
        const rng = (): number => {
          state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
          return ((state >>> 0) % 1_000_000) / 1_000_000;
        };
        const reordered = reorderKeys(value, rng);
        expect(canonicalDigest(reordered)).toBe(canonicalDigest(value));
      }),
      { numRuns: 500 },
    );
  });

  it("distinct content yields distinct digests (collision sanity)", () => {
    fc.assert(
      fc.property(jsonArb, jsonArb, (a, b) => {
        // If the canonical forms differ, the digests must differ too.
        fc.pre(canonicalJsonStringify(a) !== canonicalJsonStringify(b));
        expect(canonicalDigest(a)).not.toBe(canonicalDigest(b));
      }),
      { numRuns: 500 },
    );
  });
});
