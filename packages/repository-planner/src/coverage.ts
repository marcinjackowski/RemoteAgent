import type { DecisionReference, PlanRequirement, PlanStep } from "@remoteagent/contracts";
import { planFail } from "./plan-errors.js";

export type CoverageInput = Readonly<{
  requirements: readonly PlanRequirement[];
  steps: readonly PlanStep[];
  decisions: readonly DecisionReference[];
}>;

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) planFail("DUPLICATE_ID", `Duplicate ${label}`);
}

export function validatePlanCoverage(input: CoverageInput): void {
  const requirementIds = input.requirements.map((value) => value.requirement_id);
  unique(requirementIds, "requirement ID");
  const requirementSet = new Set(requirementIds);
  const stepIds = input.steps.map((value) => value.step_id);
  unique(stepIds, "step ID");
  const stepSet = new Set(stepIds);
  const covered = new Set<string>();

  for (const step of input.steps) {
    unique(step.requirement_ids, `requirement reference in ${step.step_id}`);
    unique(step.depends_on, `dependency in ${step.step_id}`);
    unique(step.file_areas, `file area in ${step.step_id}`);
    unique(
      step.evidence.map((value) => `${value.kind}\u0000${value.reference}`),
      `evidence in ${step.step_id}`,
    );
    if (
      step.evidence.length === 0 ||
      step.risks.length === 0 ||
      step.definition_of_done.length === 0
    )
      planFail("COVERAGE_MISSING", `Step ${step.step_id} lacks evidence, risks or DoD`);
    for (const requirementId of step.requirement_ids) {
      if (!requirementSet.has(requirementId))
        planFail("INVALID_INPUT", `Unknown requirement reference ${requirementId}`);
      covered.add(requirementId);
    }
    for (const dependency of step.depends_on) {
      if (dependency === step.step_id || !stepSet.has(dependency))
        planFail("INVALID_DEPENDENCY", `Invalid dependency ${dependency}`);
    }
  }
  for (const requirementId of requirementIds) {
    if (!covered.has(requirementId))
      planFail("COVERAGE_MISSING", `Requirement ${requirementId} has no step`);
  }
  unique(
    input.decisions.map((value) => value.decision_id),
    "decision ID",
  );
  for (const decision of input.decisions) {
    if (!requirementSet.has(decision.requirement_id))
      planFail(
        "INVALID_INPUT",
        `Decision references unknown requirement ${decision.requirement_id}`,
      );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(input.steps.map((step) => [step.step_id, step]));
  const visit = (stepId: string): void => {
    if (visiting.has(stepId)) planFail("DEPENDENCY_CYCLE", "Plan dependencies contain a cycle");
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of byId.get(stepId)!.depends_on) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const stepId of stepIds) visit(stepId);
}
