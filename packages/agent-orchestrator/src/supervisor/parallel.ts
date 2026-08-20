import {
  agentCompletion,
  type AgentCompletion,
  workUnit,
  type WorkUnit,
} from "@remoteagent/contracts";

import { mergeReadOnlyResults, type ReadOnlyMerge } from "./merge.js";

export interface ReadOnlyBinding {
  readonly workUnitId: string;
  readonly caseId: string;
  readonly runId: string;
  readonly role: Exclude<WorkUnit["role"], "IMPLEMENTER">;
}

export interface BoundReadOnlyCompletion {
  readonly workUnit: unknown;
  readonly completion: unknown;
}

export class ParallelValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ParallelValidationError";
  }
}

export class ParallelBindingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ParallelBindingError";
  }
}

export class ParallelCompletionConflictError extends Error {
  public constructor(public readonly workUnitId: string) {
    super(`conflicting completion for work unit ${workUnitId}`);
    this.name = "ParallelCompletionConflictError";
  }
}

export class ParallelIncompleteError extends Error {
  public constructor(public readonly workUnitIds: readonly string[]) {
    super(`parallel merge is missing completions for ${workUnitIds.join(", ")}`);
    this.name = "ParallelIncompleteError";
  }
}

export class ParallelEmptyError extends Error {
  public constructor() {
    super("parallel merge requires at least one read-only completion");
    this.name = "ParallelEmptyError";
  }
}

interface Entry {
  readonly workUnit: WorkUnit;
  readonly binding: ReadOnlyBinding;
  completion: AgentCompletion | null;
}

/** Collects read-only results while enforcing immutable run identity. */
export class ReadOnlyParallelCollector {
  readonly #entries = new Map<string, Entry>();
  #caseId: string | null = null;

  public start(rawWorkUnit: unknown): ReadOnlyBinding {
    const unit = parseReadOnlyWorkUnit(rawWorkUnit);
    const binding = bindingOf(unit);
    if (this.#caseId !== null && this.#caseId !== binding.caseId) {
      throw new ParallelBindingError("parallel results must belong to one case");
    }
    this.#caseId = binding.caseId;

    const existing = this.#entries.get(binding.workUnitId);
    if (existing) {
      if (!sameBinding(existing.binding, binding)) {
        throw new ParallelBindingError(`work unit ${binding.workUnitId} binding conflict`);
      }
      return existing.binding;
    }
    this.#entries.set(binding.workUnitId, { workUnit: unit, binding, completion: null });
    return binding;
  }

  /** Record one completion; an exact replay is a no-op. */
  public record(input: BoundReadOnlyCompletion): boolean {
    const unit = parseReadOnlyWorkUnit(input.workUnit);
    const binding = bindingOf(unit);
    const entry = this.#entries.get(binding.workUnitId);
    if (!entry) throw new ParallelBindingError(`work unit ${binding.workUnitId} was not started`);
    if (!sameBinding(entry.binding, binding)) {
      throw new ParallelBindingError(`work unit ${binding.workUnitId} binding mismatch`);
    }

    const completion = parseCompletion(input.completion);
    if (completion.case_id !== binding.caseId || completion.run_id !== binding.runId) {
      throw new ParallelBindingError(`completion ${binding.workUnitId} case/run mismatch`);
    }
    if (entry.completion === null) {
      entry.completion = completion;
      return true;
    }
    if (sameValue(entry.completion, completion)) return false;
    throw new ParallelCompletionConflictError(binding.workUnitId);
  }

  public merge(): ReadOnlyMerge {
    if (this.#entries.size === 0) throw new ParallelEmptyError();
    const incomplete = [...this.#entries.values()]
      .filter((entry) => entry.completion === null)
      .map((entry) => entry.binding.workUnitId)
      .sort();
    if (incomplete.length > 0) throw new ParallelIncompleteError(incomplete);
    return mergeReadOnlyResults(
      [...this.#entries.values()].map((entry) => ({
        binding: entry.binding,
        completion: entry.completion!,
      })),
    );
  }
}

/** Validate and merge a complete batch of read-only role results. */
export function mergeReadOnlyCompletions(
  inputs: readonly BoundReadOnlyCompletion[],
): ReadOnlyMerge {
  const collector = new ReadOnlyParallelCollector();
  for (const input of inputs) {
    collector.start(input.workUnit);
    collector.record(input);
  }
  return collector.merge();
}

function parseReadOnlyWorkUnit(raw: unknown): WorkUnit {
  const parsed = workUnit.safeParse(raw);
  if (!parsed.success) throw new ParallelValidationError("invalid work unit");
  if (
    parsed.data.role === "IMPLEMENTER" ||
    parsed.data.authoritative_scope.can_write_workspace !== false
  ) {
    throw new ParallelValidationError("write-enabled work unit cannot run in parallel");
  }
  if (parsed.data.status !== "RUNNING" || parsed.data.run_id === null) {
    throw new ParallelBindingError("read-only work unit must be RUNNING with a run binding");
  }
  return parsed.data;
}

function parseCompletion(raw: unknown): AgentCompletion {
  const parsed = agentCompletion.safeParse(raw);
  if (!parsed.success) throw new ParallelValidationError("invalid agent completion");
  return parsed.data;
}

function bindingOf(unit: WorkUnit): ReadOnlyBinding {
  if (unit.run_id === null)
    throw new ParallelBindingError("read-only work unit must have a run binding");
  return {
    workUnitId: unit.work_unit_id,
    caseId: unit.case_id,
    runId: unit.run_id,
    role: unit.role as ReadOnlyBinding["role"],
  };
}

function sameBinding(a: ReadOnlyBinding, b: ReadOnlyBinding): boolean {
  return (
    a.workUnitId === b.workUnitId &&
    a.caseId === b.caseId &&
    a.runId === b.runId &&
    a.role === b.role
  );
}

function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
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
