import {
  agentCompletion,
  ROLE_CAN_WRITE_WORKSPACE,
  type AgentCompletion,
} from "@remoteagent/contracts";

import type { ReadOnlyBinding } from "./parallel.js";

export type ReadOnlyProvenance = ReadOnlyBinding;

export interface ReadOnlyMergedResult {
  readonly provenance: ReadOnlyProvenance;
  readonly status: AgentCompletion["status"];
  readonly summary: string;
  readonly completed_steps: readonly AgentCompletion["completed_steps"][number][];
  readonly evidence: readonly AgentCompletion["evidence"][number][];
}

export interface ReadOnlyMergedEvidence {
  readonly kind: string;
  readonly reference: string;
  readonly provenance: ReadOnlyProvenance;
}

export interface ReadOnlyMerge {
  readonly caseId: string | null;
  readonly results: readonly ReadOnlyMergedResult[];
  readonly evidence: readonly ReadOnlyMergedEvidence[];
}

export interface BoundReadOnlyResult {
  readonly binding: ReadOnlyBinding;
  readonly completion: AgentCompletion;
}

export class ReadOnlyMergeValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReadOnlyMergeValidationError";
  }
}

/** Canonically order bound read-only results and retain only public evidence. */
export function mergeReadOnlyResults(inputs: readonly BoundReadOnlyResult[]): ReadOnlyMerge {
  if (inputs.length === 0) {
    throw new ReadOnlyMergeValidationError("parallel merge requires at least one result");
  }
  const unique = new Map<string, BoundReadOnlyResult>();
  let caseId: string | null = null;
  for (const input of inputs) {
    const writable =
      (ROLE_CAN_WRITE_WORKSPACE as Readonly<Record<string, boolean>>)[input.binding.role] !== false;
    if (writable) throw new ReadOnlyMergeValidationError("write-enabled result cannot be merged");
    const parsed = agentCompletion.safeParse(input.completion);
    if (!parsed.success) throw new ReadOnlyMergeValidationError("invalid agent completion");
    if (
      parsed.data.case_id !== input.binding.caseId ||
      parsed.data.run_id !== input.binding.runId
    ) {
      throw new ReadOnlyMergeValidationError("completion case/run binding mismatch");
    }
    if (caseId === null) caseId = input.binding.caseId;
    if (caseId !== input.binding.caseId) {
      throw new ReadOnlyMergeValidationError("parallel merge cannot combine cases");
    }
    const existing = unique.get(input.binding.workUnitId);
    if (existing) {
      if (!sameBinding(existing.binding, input.binding)) {
        throw new ReadOnlyMergeValidationError("work-unit binding conflict");
      }
      if (canonicalJson(existing.completion) !== canonicalJson(parsed.data)) {
        throw new ReadOnlyMergeValidationError("conflicting completion for work unit");
      }
      continue;
    }
    unique.set(input.binding.workUnitId, {
      binding: input.binding,
      completion: parsed.data,
    });
  }
  const sorted = [...unique.values()].sort(compareBinding);
  const results = sorted.map(({ binding, completion }) => {
    const provenance = Object.freeze({ ...binding });
    return Object.freeze({
      provenance,
      status: completion.status,
      summary: completion.summary,
      completed_steps: Object.freeze(
        completion.completed_steps.map((step) => Object.freeze({ ...step })),
      ),
      evidence: Object.freeze(completion.evidence.map((item) => Object.freeze({ ...item }))),
    });
  });
  const evidence = results.flatMap((result) =>
    result.evidence.map((item) => Object.freeze({ ...item, provenance: result.provenance })),
  );
  return Object.freeze({
    caseId,
    results: Object.freeze(results),
    evidence: Object.freeze(evidence),
  });
}

function sameBinding(a: ReadOnlyBinding, b: ReadOnlyBinding): boolean {
  return (
    a.workUnitId === b.workUnitId &&
    a.caseId === b.caseId &&
    a.runId === b.runId &&
    a.role === b.role
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function compareBinding(a: BoundReadOnlyResult, b: BoundReadOnlyResult): number {
  return (
    compareText(a.binding.workUnitId, b.binding.workUnitId) ||
    compareText(a.binding.runId, b.binding.runId) ||
    compareText(a.binding.caseId, b.binding.caseId) ||
    compareText(a.binding.role, b.binding.role)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
