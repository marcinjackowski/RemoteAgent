import { TrustLevel } from "@remoteagent/contracts";
import { assertPositiveBudget, utf8ByteLength } from "./budget.js";
import { compactContextFragments, ContextCompactionBudgetError } from "./compaction.js";
import type {
  BuiltContext,
  ContextBuildInput,
  ContextFragment,
  ContextFragmentKind,
} from "./types.js";

const priority: Record<ContextFragmentKind, number> = {
  task: 0,
  checkpoint: 1,
  decision: 2,
  plan: 3,
  receipt: 4,
  repo_state: 5,
  entity: 6,
  thread_excerpt: 7,
  tool: 8,
};

const selectionPriority = {
  MANDATORY: 0,
  LATEST_OWNER: 1,
  LEXICAL_RELEVANCE: 2,
  PRIORITY: 3,
  RECENCY: 4,
} as const;

export class ContextBuilderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ContextBuilderError";
  }
}
export class MandatoryContextFragmentError extends ContextBuilderError {
  constructor(message: string) {
    super(message, "MANDATORY_CONTEXT_FRAGMENT");
  }
}
export class DuplicateProvenanceError extends ContextBuilderError {
  constructor(reference: string) {
    super(`Duplicate provenance reference: ${reference}`, "DUPLICATE_PROVENANCE");
  }
}
export class ContextScopeViolationError extends ContextBuilderError {
  constructor(message: string) {
    super(message, "CONTEXT_SCOPE_VIOLATION");
  }
}
export class InvalidContextCompactionOptionError extends ContextBuilderError {
  constructor(value: unknown) {
    super(
      `Compaction maxDerivedBytes must be a positive safe integer: ${String(value)}`,
      "INVALID_CONTEXT_COMPACTION_OPTION",
    );
  }
}

function scopeError(message: string): never {
  throw new ContextScopeViolationError(message);
}

function validateFragment(fragment: ContextFragment, input: ContextBuildInput): void {
  const { scope } = input;
  if (fragment.sourceReferences !== undefined || fragment.sourceByteMetrics !== undefined) {
    scopeError("Derived context fragments cannot be supplied as original input");
  }
  if (fragment.provenance.origin !== "system" && fragment.trust !== TrustLevel.UNTRUSTED_DATA) {
    scopeError(`${fragment.provenance.origin} content cannot be TRUSTED`);
  }
  if (["entity", "thread_excerpt", "receipt"].includes(fragment.kind)) {
    if (!fragment.scope) scopeError(`${fragment.kind} requires scope metadata`);
    if (fragment.scope.caseId !== scope.caseId || fragment.scope.ownerId !== scope.ownerId) {
      scopeError(`${fragment.kind} is outside case/owner scope`);
    }
    const hasProvider = fragment.scope.provider !== undefined;
    const hasConnection = fragment.scope.connectionId !== undefined;
    if (fragment.kind !== "thread_excerpt" && (!hasProvider || !hasConnection)) {
      scopeError(`${fragment.kind} requires provider/connection scope`);
    }
    if (hasProvider !== hasConnection) {
      scopeError(`${fragment.kind} has an incomplete provider/connection scope`);
    }
    if (hasProvider && hasConnection) {
      const permitted = scope.connections.some(
        (binding) =>
          binding.provider === fragment.scope?.provider &&
          binding.connectionId === fragment.scope?.connectionId,
      );
      if (!permitted) scopeError(`${fragment.kind} is outside provider/connection scope`);
    }
  }
  if (fragment.kind === "tool") {
    if (fragment.provenance.origin !== "system")
      scopeError("Tool content must originate from the system");
    if (!fragment.toolName || !scope.toolNames.includes(fragment.toolName)) {
      scopeError(`Tool is not on the authoritative allowlist: ${fragment.toolName ?? ""}`);
    }
    if (fragment.scope !== undefined) scopeError("Tool scope must be injected by the system");
  }
  if (
    (fragment.kind === "entity" || fragment.kind === "thread_excerpt") &&
    fragment.trust !== TrustLevel.UNTRUSTED_DATA
  ) {
    scopeError(`${fragment.kind} content must be UNTRUSTED_DATA`);
  }
}

export function buildContext(input: ContextBuildInput): BuiltContext {
  assertPositiveBudget(input.budgetBytes);
  if (
    input.compaction !== undefined &&
    (!Number.isSafeInteger(input.compaction.maxDerivedBytes) ||
      input.compaction.maxDerivedBytes <= 0)
  ) {
    throw new InvalidContextCompactionOptionError(input.compaction.maxDerivedBytes);
  }
  const seen = new Set<string>();
  for (const fragment of input.fragments) {
    if (seen.has(fragment.provenance.reference))
      throw new DuplicateProvenanceError(fragment.provenance.reference);
    seen.add(fragment.provenance.reference);
    validateFragment(fragment, input);
  }
  const mandatory = input.fragments.filter((f) => f.kind === "task" || f.kind === "checkpoint");
  for (const kind of ["task", "checkpoint"] as const) {
    const count = mandatory.filter((f) => f.kind === kind).length;
    if (count !== 1)
      throw new MandatoryContextFragmentError(`${kind} must occur exactly once (got ${count})`);
  }
  const ordered = [...input.fragments].sort((a, b) =>
    compareFragments({ fragment: a }, { fragment: b }),
  );
  const fragments = [] as BuiltContext["fragments"];
  const omitted = [] as BuiltContext["omitted"];
  let usedBytes = 0;
  for (const fragment of ordered) {
    const bytes = utf8ByteLength(fragment.content);
    if (usedBytes + bytes > input.budgetBytes && isProtectedSelection(fragment)) {
      throw new MandatoryContextFragmentError(
        `Budget is too small for protected ${fragment.kind} context`,
      );
    }
    if (usedBytes + bytes <= input.budgetBytes) {
      fragments.push({ fragment, bytes });
      usedBytes += bytes;
    } else omitted.push({ fragment, bytes, reason: "budget" });
  }
  if (input.compaction !== undefined && omitted.length > 0) {
    const availableBytes = input.budgetBytes - usedBytes;
    const maxDerivedBytes = Math.min(availableBytes, input.compaction.maxDerivedBytes);
    if (maxDerivedBytes > 0) {
      try {
        const derived = compactContextFragments({
          fragments: omitted.map(({ fragment }) => fragment),
          maxBytes: maxDerivedBytes,
        });
        if (seen.has(derived.fragment.provenance.reference)) {
          throw new DuplicateProvenanceError(derived.fragment.provenance.reference);
        }
        fragments.push(derived);
        fragments.sort(compareFragments);
        usedBytes += derived.bytes;
      } catch (error) {
        if (!(error instanceof ContextCompactionBudgetError)) throw error;
      }
    }
  }
  return { fragments, omitted, usedBytes, budgetBytes: input.budgetBytes };
}

function compareFragments(
  a: { fragment: ContextFragment },
  b: { fragment: ContextFragment },
): number {
  if (a.fragment.selection !== undefined && b.fragment.selection !== undefined) {
    const bySelection =
      selectionPriority[a.fragment.selection.class] - selectionPriority[b.fragment.selection.class];
    if (bySelection !== 0) return bySelection;
    if (a.fragment.selection.class === "MANDATORY" || a.fragment.selection.class === "PRIORITY") {
      const bySelectedKind = priority[a.fragment.kind] - priority[b.fragment.kind];
      if (bySelectedKind !== 0) return bySelectedKind;
    }
    if (a.fragment.selection.observedAt !== b.fragment.selection.observedAt) {
      return a.fragment.selection.observedAt > b.fragment.selection.observedAt ? -1 : 1;
    }
    return compareReferences(a.fragment, b.fragment);
  }
  const byKind = priority[a.fragment.kind] - priority[b.fragment.kind];
  if (byKind !== 0) return byKind;
  return compareReferences(a.fragment, b.fragment);
}

function compareReferences(left: ContextFragment, right: ContextFragment): number {
  return left.provenance.reference < right.provenance.reference
    ? -1
    : left.provenance.reference > right.provenance.reference
      ? 1
      : 0;
}

function isProtectedSelection(fragment: ContextFragment): boolean {
  return (
    fragment.kind === "task" ||
    fragment.kind === "checkpoint" ||
    fragment.kind === "decision" ||
    fragment.selection?.class === "LATEST_OWNER"
  );
}
