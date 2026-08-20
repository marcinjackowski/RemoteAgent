import { describe, expect, it } from "vitest";
import {
  PlanningAmbiguityClass,
  PlanningDecisionError,
  createPlanningDecision,
  validatePlanningDecisionAnswer,
  type PlanningDecisionAuthority,
} from "../src/ambiguity.js";

const authority: PlanningDecisionAuthority = {
  caseId: "case-1",
  checkpointRevision: 7,
  profileId: "profile-1",
  profileDigest: `sha256:${"a".repeat(64)}`,
  requirementId: "req-1",
};

const proposal = {
  class: PlanningAmbiguityClass.REQUIREMENT_CONFLICT,
  question: "Which requirement should govern?",
  whyNow: "The requirements conflict before planning can continue.",
  options: [
    { id: "prefer-a", label: "Prefer A", consequences: "A is authoritative." },
    { id: "prefer-b", label: "Prefer B", consequences: "B is authoritative." },
  ],
  recommendation: "prefer-a",
  blockedScope: "Implementation plan for req-1",
};

function answer(decision: ReturnType<typeof createPlanningDecision>, selected = "prefer-a") {
  return {
    schema_version: 1,
    decision_id: decision.request.decision_id,
    case_id: authority.caseId,
    checkpoint_revision: authority.checkpointRevision,
    selected_option_id: selected,
    answered_by: "owner-1",
    answered_at: "2026-08-20T10:00:00.000Z",
  };
}

describe("material planning ambiguity boundary", () => {
  it("injects exact authority and creates a stable request", () => {
    const first = createPlanningDecision(authority, proposal);
    const second = createPlanningDecision(authority, {
      ...proposal,
      options: [...proposal.options].reverse(),
    });
    expect(first.request.case_id).toBe(authority.caseId);
    expect(first.request.checkpoint_revision).toBe(authority.checkpointRevision);
    expect(first.request.recommendation).toBe("prefer-a");
    expect(first.request.decision_id).toBe(second.request.decision_id);
    expect(first.binding).toEqual(second.binding);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.request.options)).toBe(true);
    expect(Object.isFrozen(first.binding)).toBe(true);
  });

  it("supports every material class and rejects unknown or injected authority", () => {
    for (const ambiguityClass of Object.values(PlanningAmbiguityClass)) {
      expect(() =>
        createPlanningDecision(authority, { ...proposal, class: ambiguityClass }),
      ).not.toThrow();
    }
    expect(() =>
      createPlanningDecision(authority, { ...proposal, class: "MODEL_DECIDES" }),
    ).toThrowError(new PlanningDecisionError("UNKNOWN_CLASS", "Unknown material ambiguity class"));
    expect(() =>
      createPlanningDecision(authority, { ...proposal, ownerId: "owner-1" }),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      createPlanningDecision(authority, { ...proposal, policy: "AUTO_ALLOW" }),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      createPlanningDecision(authority, {
        ...proposal,
        question: "Use token=secret-value to decide",
      }),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      createPlanningDecision(authority, {
        ...proposal,
        blockedScope: "Read /Users/private/repository",
      }),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      createPlanningDecision(authority, {
        ...proposal,
        options: [proposal.options[0]!, proposal.options[0]!],
      }),
    ).toThrowError(PlanningDecisionError);
    for (const malformed of [null, 7, "authority", []]) {
      expect(() => createPlanningDecision(malformed as never, proposal)).toThrowError(
        PlanningDecisionError,
      );
    }
    expect(() =>
      createPlanningDecision({ ...authority, injected: true } as never, proposal),
    ).toThrowError(PlanningDecisionError);
  });

  it("validates exact answer binding and rejects stale or foreign answers", () => {
    const decision = createPlanningDecision(authority, proposal);
    const selected = validatePlanningDecisionAnswer(
      decision.request,
      decision.binding,
      answer(decision),
      authority,
    );
    expect(selected).toEqual({
      decisionId: decision.request.decision_id,
      selectedOptionId: "prefer-a",
      bindingDigest: decision.binding.bindingDigest,
    });
    expect(() =>
      validatePlanningDecisionAnswer(decision.request, decision.binding, answer(decision), {
        ...authority,
        checkpointRevision: 8,
      }),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        decision.binding,
        { ...answer(decision), case_id: "foreign" },
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        { ...decision.request, schema_version: undefined } as never,
        decision.binding,
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        { ...decision.request, injected: true } as never,
        decision.binding,
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        { ...decision.binding, ambiguityClass: "MODEL_DECIDES" } as never,
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        { ...decision.binding, injected: true } as never,
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        { ...decision.request, question: "Tampered question" },
        decision.binding,
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        {
          ...decision.request,
          options: decision.request.options.map((option) =>
            option.id === "prefer-a" ? { ...option, label: "Tampered" } : option,
          ),
        },
        decision.binding,
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        { ...decision.binding, ambiguityClass: PlanningAmbiguityClass.SCOPE_UNCLEAR },
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        { ...decision.binding, profileId: "profile-foreign" },
        answer(decision),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        decision.binding,
        answer(decision, "missing-option"),
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
    expect(() =>
      validatePlanningDecisionAnswer(
        decision.request,
        decision.binding,
        { ...answer(decision), note: "Bearer abcdefghijklmnop" },
        authority,
      ),
    ).toThrowError(PlanningDecisionError);
  });
});
