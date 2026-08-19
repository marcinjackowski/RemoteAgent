import { TrustLevel } from "@remoteagent/contracts";
import { assertPositiveBudget, utf8ByteLength } from "./budget.js";
import type {
  BuiltContext,
  ContextBuildInput,
  ContextFragment,
  ContextFragmentKind,
} from "./types.js";

const priority: Record<ContextFragmentKind, number> = {
  task: 0,
  checkpoint: 1,
  plan: 2,
  receipt: 3,
  repo_state: 4,
  entity: 5,
  thread_excerpt: 6,
  tool: 7,
};

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

function scopeError(message: string): never {
  throw new ContextScopeViolationError(message);
}

function validateFragment(fragment: ContextFragment, input: ContextBuildInput): void {
  const { scope } = input;
  if (fragment.provenance.origin !== "system" && fragment.trust !== TrustLevel.UNTRUSTED_DATA) {
    scopeError(`${fragment.provenance.origin} content cannot be TRUSTED`);
  }
  if (["entity", "thread_excerpt", "receipt"].includes(fragment.kind)) {
    if (!fragment.scope) scopeError(`${fragment.kind} requires scope metadata`);
    if (fragment.scope.caseId !== scope.caseId || fragment.scope.ownerId !== scope.ownerId) {
      scopeError(`${fragment.kind} is outside case/owner scope`);
    }
    if (
      !scope.connections.some(
        (binding) =>
          binding.provider === fragment.scope?.provider &&
          binding.connectionId === fragment.scope?.connectionId,
      )
    ) {
      scopeError(`${fragment.kind} is outside provider/connection scope`);
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
  const ordered = [...input.fragments].sort((a, b) => {
    const byKind = priority[a.kind] - priority[b.kind];
    if (byKind !== 0) return byKind;
    return a.provenance.reference < b.provenance.reference
      ? -1
      : a.provenance.reference > b.provenance.reference
        ? 1
        : 0;
  });
  const fragments = [] as BuiltContext["fragments"];
  const omitted = [] as BuiltContext["omitted"];
  let usedBytes = 0;
  for (const fragment of ordered) {
    const bytes = utf8ByteLength(fragment.content);
    if (
      (fragment.kind === "task" || fragment.kind === "checkpoint") &&
      usedBytes + bytes > input.budgetBytes
    ) {
      throw new MandatoryContextFragmentError(`Budget is too small for mandatory ${fragment.kind}`);
    }
    if (usedBytes + bytes <= input.budgetBytes) {
      fragments.push({ fragment, bytes });
      usedBytes += bytes;
    } else omitted.push({ fragment, bytes, reason: "budget" });
  }
  return { fragments, omitted, usedBytes, budgetBytes: input.budgetBytes };
}
