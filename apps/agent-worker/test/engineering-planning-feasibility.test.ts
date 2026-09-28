import { describe, expect, it } from "vitest";

import {
  assertEngineeringSlicePlanningConstraintsFeasible,
  type EngineeringSlicePlanningConstraints,
} from "../src/engineering-workflow.js";

const gateId = "gate-a";
const sliceId = "slice-medium";
const testPath = "Tests/Flow.swift";
const generatorOutput = "Sources/Generated.swift";

function exactMediumPaths(): readonly string[] {
  return [
    ...Array.from(
      { length: 18 },
      (_, index) => `Sources/Feature-${String(index + 1).padStart(2, "0")}.swift`,
    ),
    testPath,
    generatorOutput,
  ];
}

function feasible(
  overrides: Partial<EngineeringSlicePlanningConstraints> = {},
): EngineeringSlicePlanningConstraints {
  const allowedPaths = exactMediumPaths();
  return {
    allowedPaths,
    allowedTestPaths: [testPath],
    requiredGateIds: [gateId],
    requiredGateSchedules: { [gateId]: "EACH_SLICE" },
    requiredGateTestPaths: { [gateId]: [testPath] },
    requiredGateMutationPaths: { [gateId]: ["Sources/Feature-01.swift"] },
    generatorBindings: [
      { triggerPaths: ["Sources/Feature-01.swift"], outputPaths: [generatorOutput] },
    ],
    benchmarkSliceIds: [sliceId],
    sliceAllowedPaths: { [sliceId]: allowedPaths },
    sliceAllowedTestPaths: { [sliceId]: [testPath] },
    ...overrides,
  };
}

function expectPlanningRejection(input: EngineeringSlicePlanningConstraints): void {
  let thrown: unknown;
  try {
    assertEngineeringSlicePlanningConstraintsFeasible(input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
}

describe("server-owned slice planning feasibility", () => {
  it("accepts an exact 20-path non-overlapping scope", () => {
    expect(() => assertEngineeringSlicePlanningConstraintsFeasible(feasible())).not.toThrow();
  });

  it("retains the generic four-root constraint shape when no per-slice map is supplied", () => {
    const paths = [
      "Sources/One.swift",
      "Sources/Two.swift",
      "Tests/Flow.swift",
      "Sources/Generated.swift",
    ];
    expect(() =>
      assertEngineeringSlicePlanningConstraintsFeasible({
        allowedPaths: paths,
        allowedTestPaths: ["Tests/Flow.swift"],
        requiredGateIds: [gateId],
        requiredGateSchedules: { [gateId]: "EACH_SLICE" },
        benchmarkSliceIds: [sliceId],
      }),
    ).not.toThrow();
  });

  it("rejects a missing or empty paired test scope", () => {
    const withoutTestScope = { ...feasible() };
    delete (
      withoutTestScope as {
        sliceAllowedTestPaths?: EngineeringSlicePlanningConstraints["sliceAllowedTestPaths"];
      }
    ).sliceAllowedTestPaths;
    expectPlanningRejection(withoutTestScope);
    expectPlanningRejection(feasible({ sliceAllowedTestPaths: { [sliceId]: [] } }));
  });

  it("rejects unpaired per-slice maps and missing benchmark IDs", () => {
    const withoutWriteScope = { ...feasible() };
    delete (
      withoutWriteScope as {
        sliceAllowedPaths?: EngineeringSlicePlanningConstraints["sliceAllowedPaths"];
      }
    ).sliceAllowedPaths;
    expectPlanningRejection(withoutWriteScope);
    const withoutBenchmarkIds = { ...feasible() };
    delete (withoutBenchmarkIds as { benchmarkSliceIds?: readonly string[] }).benchmarkSliceIds;
    expectPlanningRejection(withoutBenchmarkIds);
  });

  it("rejects duplicate and oversized benchmark slice ID lists", () => {
    expectPlanningRejection(feasible({ benchmarkSliceIds: [sliceId, sliceId] }));
    const ids = Array.from({ length: 33 }, (_, index) => `slice-${index}`);
    expectPlanningRejection(
      feasible({
        benchmarkSliceIds: ids,
        sliceAllowedPaths: Object.fromEntries(ids.map((id) => [id, exactMediumPaths()])),
        sliceAllowedTestPaths: Object.fromEntries(ids.map((id) => [id, [testPath]])),
      }),
    );
  });

  it("rejects a per-slice scope above 256 paths", () => {
    const paths = [
      testPath,
      ...Array.from({ length: 256 }, (_, index) => `Sources/Path-${index}.swift`),
    ];
    expectPlanningRejection(
      feasible({
        allowedPaths: paths,
        requiredGateMutationPaths: {},
        generatorBindings: [],
        sliceAllowedPaths: { [sliceId]: paths },
      }),
    );
  });

  it("rejects a mandatory gate test union above 16 paths", () => {
    const firstGateTests = Array.from({ length: 9 }, (_, index) => `Tests/Gate-${index}.swift`);
    const secondGateTests = Array.from({ length: 8 }, (_, index) => `Tests/Other-${index}.swift`);
    const tests = [...firstGateTests, ...secondGateTests];
    const allowedPaths = [...tests, "Sources/Implementation.swift"];
    expectPlanningRejection(
      feasible({
        allowedPaths,
        allowedTestPaths: tests,
        requiredGateIds: [gateId, "gate-b"],
        requiredGateSchedules: { [gateId]: "EACH_SLICE", "gate-b": "EACH_SLICE" },
        requiredGateTestPaths: { [gateId]: firstGateTests, "gate-b": secondGateTests },
        requiredGateMutationPaths: {
          [gateId]: ["Sources/Implementation.swift"],
          "gate-b": ["Sources/Implementation.swift"],
        },
        sliceAllowedPaths: { [sliceId]: allowedPaths },
        sliceAllowedTestPaths: { [sliceId]: tests },
        generatorBindings: [],
      }),
    );
  });

  it("rejects a selected generator whose output is absent from the slice", () => {
    const output = "Sources/Generated.swift";
    const allowedPaths = exactMediumPaths().filter((path) => path !== output);
    expectPlanningRejection(
      feasible({
        allowedPaths: [...allowedPaths, output],
        sliceAllowedPaths: { [sliceId]: allowedPaths },
      }),
    );
  });

  it("rejects parent, global-cap, and test-scope violations", () => {
    const validPaths = exactMediumPaths();
    expectPlanningRejection(
      feasible({
        sliceAllowedPaths: {
          [sliceId]: [...validPaths, "Sources/Feature-01.swift/Child.swift"],
        },
      }),
    );
    expectPlanningRejection(
      feasible({ sliceAllowedPaths: { [sliceId]: [...exactMediumPaths(), "Outside.swift"] } }),
    );
    expectPlanningRejection(
      feasible({
        allowedPaths: [...validPaths, "Tests/Outside.swift"],
        allowedTestPaths: [testPath, "Tests/Outside.swift"],
        requiredGateTestPaths: {},
        sliceAllowedPaths: { [sliceId]: validPaths },
        sliceAllowedTestPaths: { [sliceId]: ["Tests/Outside.swift"] },
      }),
    );
  });

  it("rejects a foreign or incomplete per-slice scope", () => {
    expectPlanningRejection(
      feasible({
        sliceAllowedPaths: { [sliceId]: exactMediumPaths(), foreign: exactMediumPaths() },
        sliceAllowedTestPaths: { [sliceId]: [testPath], foreign: [testPath] },
      }),
    );
    expectPlanningRejection(
      feasible({
        sliceAllowedPaths: { foreign: exactMediumPaths() },
        sliceAllowedTestPaths: { foreign: [testPath] },
      }),
    );
  });

  it("rejects overlapping adjacent and nested target roots", () => {
    const paths = ["src", "src-extra", "src/file.swift", testPath];
    expectPlanningRejection(
      feasible({
        allowedPaths: paths,
        allowedTestPaths: [testPath],
        requiredGateTestPaths: { [gateId]: [testPath] },
        requiredGateMutationPaths: {},
        generatorBindings: [],
        sliceAllowedPaths: { [sliceId]: paths },
        sliceAllowedTestPaths: { [sliceId]: [testPath] },
      }),
    );
  });
});
