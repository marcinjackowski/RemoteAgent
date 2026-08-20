import { createHash } from "node:crypto";
import { SecretRedactor } from "@remoteagent/observability";
import { TrustLevel } from "@remoteagent/contracts";
import { assertPositiveBudget, utf8ByteLength } from "./budget.js";
import type { ContextFragment } from "./types.js";

export class ContextCompactionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ContextCompactionError";
  }
}

export class ContextCompactionBudgetError extends ContextCompactionError {
  constructor(message = "Context budget cannot contain the complete source index") {
    super(message, "CONTEXT_COMPACTION_BUDGET");
    this.name = "ContextCompactionBudgetError";
  }
}

export class ProtectedContextCompactionError extends ContextCompactionError {
  constructor(kind: string) {
    super(
      `Protected context fragment cannot be compacted: ${kind}`,
      "PROTECTED_CONTEXT_COMPACTION",
    );
    this.name = "ProtectedContextCompactionError";
  }
}

export class DuplicateContextCompactionProvenanceError extends ContextCompactionError {
  constructor(reference: string) {
    super(`Duplicate provenance reference: ${reference}`, "DUPLICATE_COMPACTION_PROVENANCE");
    this.name = "DuplicateContextCompactionProvenanceError";
  }
}

export interface CompactContextFragmentsInput {
  readonly fragments: readonly ContextFragment[];
  readonly maxBytes: number;
}

export interface CompactContextFragmentsResult {
  readonly fragment: ContextFragment;
  readonly bytes: number;
}

type Source = ContextFragment & { bytes: number };

function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function sourceSemantics(fragment: ContextFragment): unknown {
  return {
    kind: fragment.kind,
    content: fragment.content,
    provenance: fragment.provenance,
    trust: fragment.trust,
    scope: fragment.scope,
    toolName: fragment.toolName,
    sourceReferences: fragment.sourceReferences,
    sourceByteMetrics: fragment.sourceByteMetrics,
  };
}

function manifest(
  sources: readonly Source[],
  excerpts: readonly { reference: string; content: string }[],
) {
  return JSON.stringify({
    version: 1,
    sources: sources.map((source) => ({
      kind: source.kind,
      origin: source.provenance.origin,
      reference: source.provenance.reference,
      trust: source.trust,
      bytes: source.bytes,
    })),
    excerpts,
  });
}

function fitExcerpt(
  value: string,
  maxBytes: number,
  sources: readonly Source[],
  excerpts: readonly { reference: string; content: string }[],
  reference: string,
): string {
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    const candidateBytes = utf8ByteLength(candidate);
    if (
      candidateBytes <= maxBytes &&
      utf8ByteLength(manifest(sources, [...excerpts, { reference, content: candidate }])) <=
        maxBytes
    ) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

export function compactContextFragments({
  fragments,
  maxBytes,
}: CompactContextFragmentsInput): CompactContextFragmentsResult {
  assertPositiveBudget(maxBytes);
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (["task", "checkpoint", "decision"].includes(fragment.kind)) {
      throw new ProtectedContextCompactionError(fragment.kind);
    }
    if (seen.has(fragment.provenance.reference)) {
      throw new DuplicateContextCompactionProvenanceError(fragment.provenance.reference);
    }
    seen.add(fragment.provenance.reference);
  }

  const sources = [...fragments]
    .map((fragment) => ({ ...fragment, bytes: utf8ByteLength(fragment.content) }))
    .sort((a, b) => {
      const left = stable(sourceSemantics(a));
      const right = stable(sourceSemantics(b));
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const identity = createHash("sha256")
    .update(sources.map((source) => stable(sourceSemantics(source))).join("\n"), "utf8")
    .digest("hex");
  const base = manifest(sources, []);
  if (utf8ByteLength(base) > maxBytes) throw new ContextCompactionBudgetError();

  const redactor = new SecretRedactor();
  const excerpts: { reference: string; content: string }[] = [];
  for (const source of sources) {
    const safe = redactor.redactString(source.content);
    const remaining = maxBytes - utf8ByteLength(manifest(sources, excerpts));
    if (remaining <= 0) break;
    const excerpt = fitExcerpt(safe, remaining, sources, excerpts, source.provenance.reference);
    if (excerpt) excerpts.push({ reference: source.provenance.reference, content: excerpt });
  }
  const content = manifest(sources, excerpts);
  return {
    fragment: {
      kind: "plan",
      content,
      provenance: { origin: "system", reference: `derived:compaction:sha256:${identity}` },
      trust: TrustLevel.UNTRUSTED_DATA,
      sourceReferences: sources.map((source) => source.provenance.reference),
      sourceByteMetrics: sources.map((source) => ({
        reference: source.provenance.reference,
        bytes: source.bytes,
      })),
    },
    bytes: utf8ByteLength(content),
  };
}
