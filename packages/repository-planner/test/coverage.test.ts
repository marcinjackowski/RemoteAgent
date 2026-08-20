import { describe, expect, it } from "vitest";
import { validatePlanCoverage } from "../src/coverage.js";
import { PlanCompilationError } from "../src/plan-errors.js";

const requirement = (requirement_id: string) => ({
  requirement_id,
  summary: "A server requirement",
  authority: "SERVER_OWNED" as const,
});
const step = (step_id: string, requirement_ids: string[], depends_on: string[] = []) => ({
  step_id,
  requirement_ids,
  objective: "Do the bounded work.",
  file_areas: ["packages/contracts"],
  depends_on,
  evidence: [{ kind: "test", reference: `${step_id}-evidence` }],
  risks: ["A bounded risk."],
  definition_of_done: ["Evidence is recorded."],
});

describe("plan requirement coverage", () => {
  it("accepts complete mapping and rejects missing/duplicate references", () => {
    expect(() =>
      validatePlanCoverage({
        requirements: [requirement("req-1"), requirement("req-2")],
        steps: [step("step-1", ["req-1", "req-2"])],
        decisions: [],
      }),
    ).not.toThrow();
    expect(() =>
      validatePlanCoverage({
        requirements: [requirement("req-1")],
        steps: [step("step-1", [])],
        decisions: [],
      }),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      validatePlanCoverage({
        requirements: [requirement("req-1")],
        steps: [step("step-1", ["req-1", "req-1"])],
        decisions: [],
      }),
    ).toThrowError(PlanCompilationError);
  });

  it("rejects unknown, cyclic and self dependencies", () => {
    expect(() =>
      validatePlanCoverage({
        requirements: [requirement("req-1")],
        steps: [step("step-1", ["req-1"], ["step-2"]), step("step-2", ["req-1"], ["step-1"])],
        decisions: [],
      }),
    ).toThrowError(PlanCompilationError);
    expect(() =>
      validatePlanCoverage({
        requirements: [requirement("req-1")],
        steps: [step("step-1", ["req-1"], ["missing"])],
        decisions: [],
      }),
    ).toThrowError(PlanCompilationError);
  });
});
