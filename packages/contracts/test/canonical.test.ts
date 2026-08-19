import { describe, expect, it } from "vitest";

import { canonicalDigest, canonicalJsonStringify, CanonicalJsonError } from "../src/canonical.js";

describe("canonical JSON", () => {
  it("is independent of key insertion order", () => {
    const a = { b: 1, a: 2, nested: { y: 1, x: 2 } };
    const b = { nested: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it("produces a sha256-prefixed digest", () => {
    expect(canonicalDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("distinguishes different content", () => {
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
  });

  it("omits undefined properties but preserves null", () => {
    expect(canonicalJsonStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it("rejects non-finite numbers, bigint and exotic objects", () => {
    expect(() => canonicalJsonStringify(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJsonStringify([undefined])).toThrow(CanonicalJsonError);
  });
});
