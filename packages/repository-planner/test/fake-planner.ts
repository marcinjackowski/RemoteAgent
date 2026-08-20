import type { PlannerDraftPort } from "../src/planner.js";

export const planDraft = {
  kind: "PLAN" as const,
  draft: {
    steps: [
      {
        step_id: "inspect",
        requirement_ids: ["req-read"],
        objective: "Inspect the bounded repository evidence.",
        file_areas: ["packages/repository-planner"],
        depends_on: [],
        evidence: [{ kind: "test", reference: "planner-proof" }],
        risks: ["Evidence may be stale."],
        definition_of_done: ["Evidence is recorded."],
      },
    ],
    decisions: [],
  },
};

export const decisionDraft = {
  kind: "DECISION" as const,
  proposal: {
    class: "SCOPE_UNCLEAR" as const,
    question: "Should the nested package be included?",
    whyNow: "The bounded instruction set conflicts on scope.",
    options: [
      { id: "include", label: "Include it", consequences: "The package is inspected." },
      { id: "exclude", label: "Exclude it", consequences: "The package is deferred." },
    ],
    recommendation: "include",
    blockedScope: "nested package inspection",
  },
};

export function fakePlanner(response: unknown): PlannerDraftPort {
  return { propose: async () => structuredClone(response) };
}

export const mutatingPlanner: PlannerDraftPort = {
  propose: async (input) => {
    (input.requirements as Array<{ summary: string }>)[0]!.summary = "forged";
    return planDraft;
  },
};
