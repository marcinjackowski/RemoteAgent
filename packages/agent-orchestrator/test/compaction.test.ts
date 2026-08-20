import { describe, expect, it } from "vitest";
import { TrustLevel } from "@remoteagent/contracts";
import {
  compactContextFragments,
  ContextCompactionBudgetError,
  DuplicateContextCompactionProvenanceError,
  ProtectedContextCompactionError,
} from "../src/index.js";
import { InvalidContextBudgetError, utf8ByteLength } from "../src/context/budget.js";

const make = (
  kind: "entity" | "receipt" | "thread_excerpt" | "plan",
  reference: string,
  content: string,
) => ({
  kind,
  content,
  provenance: { origin: "provider" as const, reference },
  trust: TrustLevel.UNTRUSTED_DATA,
});

const sources = [
  make("entity", "entity:2", "second"),
  make("receipt", "receipt:exact/full/ref", "receipt access_token=top-secret"),
  make("thread_excerpt", "thread:1", "first"),
];

describe("compactContextFragments", () => {
  it("produces a complete deterministic parsable manifest", () => {
    const result = compactContextFragments({ fragments: sources, maxBytes: 10000 });
    const parsed = JSON.parse(result.fragment.content);
    expect(parsed.sources).toEqual([
      {
        kind: "thread_excerpt",
        origin: "provider",
        reference: "thread:1",
        trust: "UNTRUSTED_DATA",
        bytes: 5,
      },
      {
        kind: "receipt",
        origin: "provider",
        reference: "receipt:exact/full/ref",
        trust: "UNTRUSTED_DATA",
        bytes: 31,
      },
      {
        kind: "entity",
        origin: "provider",
        reference: "entity:2",
        trust: "UNTRUSTED_DATA",
        bytes: 6,
      },
    ]);
    expect(result.fragment.kind).toBe("plan");
    expect(result.fragment.provenance.origin).toBe("system");
    expect(result.fragment.trust).toBe(TrustLevel.UNTRUSTED_DATA);
    expect(result.fragment.sourceReferences).toEqual(
      parsed.sources.map((source: { reference: string }) => source.reference),
    );
    expect(result.fragment.sourceByteMetrics).toEqual(
      parsed.sources.map((source: { reference: string; bytes: number }) => ({
        reference: source.reference,
        bytes: source.bytes,
      })),
    );
    expect(result.bytes).toBe(utf8ByteLength(result.fragment.content));
  });

  it("is invariant to input order and identity changes with content or reference", () => {
    const first = compactContextFragments({ fragments: sources, maxBytes: 10000 }).fragment;
    const reversed = compactContextFragments({
      fragments: [...sources].reverse(),
      maxBytes: 10000,
    }).fragment;
    expect(reversed).toEqual(first);
    expect(
      compactContextFragments({
        fragments: [make("entity", "entity:2", "changed")],
        maxBytes: 10000,
      }).fragment.provenance.reference,
    ).not.toBe(first.provenance.reference);
    expect(
      compactContextFragments({
        fragments: [make("entity", "entity:3", "second")],
        maxBytes: 10000,
      }).fragment.provenance.reference,
    ).not.toBe(first.provenance.reference);
  });

  it("keeps receipt references exact and redacts excerpts", () => {
    const result = compactContextFragments({ fragments: sources, maxBytes: 10000 });
    expect(result.fragment.content).toContain("receipt:exact/full/ref");
    expect(result.fragment.content).not.toContain("top-secret");
  });

  it("rejects protected, duplicate, invalid and insufficient inputs", () => {
    for (const kind of ["task", "checkpoint", "decision"] as const) {
      expect(() =>
        compactContextFragments({
          fragments: [{ ...make("plan", kind, "x"), kind }],
          maxBytes: 1000,
        }),
      ).toThrow(ProtectedContextCompactionError);
    }
    expect(() =>
      compactContextFragments({ fragments: [sources[0], { ...sources[0] }], maxBytes: 1000 }),
    ).toThrow(DuplicateContextCompactionProvenanceError);
    expect(() => compactContextFragments({ fragments: sources, maxBytes: 0 })).toThrow(
      InvalidContextBudgetError,
    );
    expect(() => compactContextFragments({ fragments: sources, maxBytes: 1 })).toThrow(
      ContextCompactionBudgetError,
    );
  });

  it("honours Unicode byte boundaries without replacement characters", () => {
    const input = [make("entity", "unicode", "😀😀😀")];
    const full = compactContextFragments({ fragments: input, maxBytes: 10000 });
    const base = compactContextFragments({
      fragments: [{ ...input[0], content: "" }],
      maxBytes: 10000,
    });
    const result = compactContextFragments({ fragments: input, maxBytes: base.bytes + 2 });
    expect(result.bytes).toBeLessThanOrEqual(base.bytes + 2);
    expect(result.fragment.content).not.toContain("�");
    expect(() => JSON.parse(result.fragment.content)).not.toThrow();
    expect(full.fragment.content).toContain("😀😀😀");
  });

  it("does not mutate frozen input and handles large content efficiently", () => {
    const input = Object.freeze([
      Object.freeze(make("entity", "large", "x".repeat(65_000))),
    ]) as typeof sources;
    const before = input[0].content;
    const result = compactContextFragments({ fragments: input, maxBytes: 1000 });
    expect(input[0].content).toBe(before);
    expect(result.bytes).toBeLessThanOrEqual(1000);
  });
});
