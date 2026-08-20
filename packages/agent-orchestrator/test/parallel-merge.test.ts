import { describe, expect, it } from "vitest";

import {
  ParallelBindingError,
  ParallelCompletionConflictError,
  ParallelEmptyError,
  ParallelValidationError,
  ReadOnlyParallelCollector,
  mergeReadOnlyCompletions,
} from "../src/index.js";
import { workUnit as workUnitSchema, type WorkUnit } from "@remoteagent/contracts";

const makeWorkUnit = (
  workUnitId: string,
  role: Exclude<WorkUnit["role"], "IMPLEMENTER"> = "REVIEWER",
  runId = `run-${workUnitId}`,
  caseId = "case-1",
): WorkUnit =>
  workUnitSchema.parse({
    schema_version: 1,
    work_unit_id: workUnitId,
    case_id: caseId,
    role,
    status: "RUNNING",
    objective: `objective-${workUnitId}`,
    run_id: runId,
    authoritative_scope: { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

const makeCompletion = (
  unit: WorkUnit,
  summary = `summary-${unit.work_unit_id}`,
  evidence = [{ kind: "test", reference: `evidence-${unit.work_unit_id}` }],
) => ({
  schema_version: 1,
  status: "COMPLETED" as const,
  run_id: unit.run_id!,
  case_id: unit.case_id,
  summary,
  completed_steps: [{ description: `step-${unit.work_unit_id}`, reference: unit.work_unit_id }],
  evidence,
  checkpoint_patch: {},
  next_actions: [],
});

const input = (workUnit: WorkUnit) => ({
  workUnit,
  completion: makeCompletion(workUnit),
});

describe("read-only parallel merge", () => {
  it("produces the same canonical merge for every completion permutation", () => {
    const units = [
      makeWorkUnit("unit-c", "SPECIALIST"),
      makeWorkUnit("unit-a", "REVIEWER"),
      makeWorkUnit("unit-b", "VERIFICATION"),
    ];
    const permutations = [
      [units[0]!, units[1]!, units[2]!],
      [units[0]!, units[2]!, units[1]!],
      [units[1]!, units[0]!, units[2]!],
      [units[1]!, units[2]!, units[0]!],
      [units[2]!, units[0]!, units[1]!],
      [units[2]!, units[1]!, units[0]!],
    ];
    const outputs = permutations.map((order) => mergeReadOnlyCompletions(order.map(input)));

    for (const output of outputs) expect(output).toEqual(outputs[0]);
    expect(outputs[0]!.results.map((result) => result.provenance.workUnitId)).toEqual([
      "unit-a",
      "unit-b",
      "unit-c",
    ]);
    expect(outputs[0]!.evidence.map((item) => item.provenance.workUnitId)).toEqual([
      "unit-a",
      "unit-b",
      "unit-c",
    ]);
  });

  it("rejects implementers and any write-enabled scope before start", () => {
    const collector = new ReadOnlyParallelCollector();
    const implementer = workUnitSchema.parse({
      ...makeWorkUnit("writer", "REVIEWER"),
      role: "IMPLEMENTER",
      authoritative_scope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
    });
    expect(() => collector.start(implementer)).toThrow(ParallelValidationError);
    expect(() =>
      collector.start({
        ...makeWorkUnit("bad-scope"),
        authoritative_scope: { connection_ids: [], repo_allowlist: [], can_write_workspace: true },
      }),
    ).toThrow(ParallelValidationError);
    expect(() => collector.start({ ...makeWorkUnit("dispatched"), status: "DISPATCHED" })).toThrow(
      ParallelBindingError,
    );
    expect(() =>
      collector.start({ ...makeWorkUnit("pending"), status: "PENDING", run_id: null }),
    ).toThrow(ParallelBindingError);
  });

  it("requires exact case and run binding", () => {
    const unit = makeWorkUnit("unit-a");
    const collector = new ReadOnlyParallelCollector();
    collector.start(unit);

    expect(() =>
      collector.record({
        workUnit: unit,
        completion: { ...makeCompletion(unit), run_id: "other-run" },
      }),
    ).toThrow(ParallelBindingError);
    expect(() =>
      collector.record({
        workUnit: { ...unit, case_id: "case-2" },
        completion: makeCompletion(unit),
      }),
    ).toThrow(ParallelBindingError);
  });

  it("makes an exact duplicate idempotent and conflicting duplicate explicit", () => {
    const unit = makeWorkUnit("unit-a");
    const collector = new ReadOnlyParallelCollector();
    collector.start(unit);
    expect(collector.record(input(unit))).toBe(true);
    expect(collector.record(input(unit))).toBe(false);
    expect(() =>
      collector.record({
        workUnit: unit,
        completion: makeCompletion(unit, "different summary"),
      }),
    ).toThrow(ParallelCompletionConflictError);
    expect(collector.merge().results).toHaveLength(1);
  });

  it("retains public evidence and provenance without exposing private completion fields", () => {
    const unit = makeWorkUnit("unit-a");
    const result = mergeReadOnlyCompletions([input(unit)]);
    expect(result.results[0]).toMatchObject({
      provenance: {
        workUnitId: "unit-a",
        caseId: "case-1",
        runId: "run-unit-a",
        role: "REVIEWER",
      },
      evidence: [{ kind: "test", reference: "evidence-unit-a" }],
    });
    expect(result.results[0]).not.toHaveProperty("checkpoint_patch");
    expect(result.results[0]).not.toHaveProperty("next_actions");
  });

  it("rejects an empty merge explicitly", () => {
    expect(() => mergeReadOnlyCompletions([])).toThrow(ParallelEmptyError);
  });
});
