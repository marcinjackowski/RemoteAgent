import { describe, expect, it } from "vitest";
import { evaluateBehavioralTrace, type BehavioralTrace } from "./behavioral-oracle.js";

type CriterionId = BehavioralTrace["observations"][number]["criterion_id"];
const rows: [CriterionId, string[], string[]][] = [
  ["C1", ["production_route", "safety_event"], ["fullscreen_alert_opened"]],
  ["C2", ["production_route", "active_session"], ["fullscreen_alert_opened"]],
  [
    "C3",
    ["fullscreen_interruption", "legacy_inline_absent", "session_interrupted", "input_interrupted"],
    ["fullscreen_alert_opened"],
  ],
  ["C4", ["nonsharing_variant"], ["nonsharing_alert_presented"]],
  ["C5", ["sharing_preference_true"], ["sharing_variant_selected"]],
  ["C6", ["text_988_action"], ["sms_url_exact", "analytics_text_988"]],
  [
    "C7",
    ["resources_action"],
    ["resources_presented", "resources_url_exact", "analytics_resources"],
  ],
  ["C8", ["close_action"], ["alert_dismissed", "no_external_side_effect"]],
  [
    "C9",
    ["lifecycle_dismiss", "lifecycle_reopen", "session_boundary"],
    ["single_open_per_session", "no_duplicate_effects"],
  ],
  [
    "C10",
    ["help_pdf_nonempty", "both_variants", "accessibility_label", "dynamic_type", "gradient"],
    ["bounded_ui_observation"],
  ],
];
const valid: BehavioralTrace = {
  schema_version: 1,
  provenance: { origin: "EVALUATOR", trace_id: "synthetic-1" },
  observations: rows.map(([criterion_id, facts, effects], index) => ({
    observation_id: `obs-${index}`,
    criterion_id,
    facts,
    effects,
    ...(criterion_id === "C2" ? { scenario: { session: "ACTIVE" as const } } : {}),
    ...(criterion_id === "C4"
      ? {
          scenario: { preference: "NONSHARING" as const },
          facts: [...facts, "sharing_preference_false"],
        }
      : {}),
    ...(criterion_id === "C5" ? { scenario: { preference: "SHARING" as const } } : {}),
  })),
  assertions: rows.map(([, ,], index) => ({
    assertion_id: `assert-${index}`,
    observation_id: `obs-${index}`,
    source: "EXECUTED_ASSERTION" as const,
    substantive: true as const,
  })),
};
valid.observations.push({
  observation_id: "obs-stale",
  criterion_id: "C2",
  facts: ["production_route"],
  effects: ["stale_event_rejected"],
  scenario: { session: "STALE" },
});
valid.assertions.push({
  assertion_id: "assert-stale",
  observation_id: "obs-stale",
  source: "EXECUTED_ASSERTION",
  substantive: true,
});

describe("offline behavioral oracle", () => {
  it("evaluates a complete structured trace", () => {
    expect(evaluateBehavioralTrace(valid).overall).toBe("PASS");
  });
  it("fails closed for unknown facts, duplicate IDs, and marker-only evidence", () => {
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        observations: [
          { ...valid.observations[0], facts: ["comment_marker"] },
          ...valid.observations.slice(1),
        ],
      }),
    ).toThrow();
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        observations: [...valid.observations, valid.observations[0]],
      }),
    ).toThrow();
    expect(
      evaluateBehavioralTrace({
        ...valid,
        assertions: valid.assertions,
        observations: valid.observations.map((item) => ({
          ...item,
          facts: ["production_route"],
          effects: [],
        })),
      }).overall,
    ).toBe("FAIL");
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        assertions: valid.assertions.map((assertion, index) =>
          index === 0 ? { ...assertion, source: "COMMENT" } : assertion,
        ),
      }),
    ).toThrow();
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        assertions: valid.assertions.map((assertion, index) =>
          index === 0 ? { ...assertion, substantive: false } : assertion,
        ),
      }),
    ).toThrow();
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        observations: valid.observations.map((item, index) =>
          index === 0 ? { ...item, scenario: { preference: "SHARING", injected: true } } : item,
        ),
      }),
    ).toThrow();
  });
  it("rejects malformed nested values, duplicate tokens, and empty IDs", () => {
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        provenance: [] as unknown as typeof valid.provenance,
      }),
    ).toThrow();
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        observations: valid.observations.map((item, index) =>
          index === 0 ? { ...item, observation_id: "" } : item,
        ),
      }),
    ).toThrow();
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        observations: valid.observations.map((item, index) =>
          index === 0 ? { ...item, facts: ["production_route", "production_route"] } : item,
        ),
      }),
    ).toThrow();
    expect(() =>
      evaluateBehavioralTrace({
        ...valid,
        observations: valid.observations.map((item, index) =>
          index === 0 ? { ...item, diagnostics: [] } : item,
        ),
      }),
    ).toThrow();
  });
  it("requires production route and rejects stale sessions", () => {
    const changed = structuredClone(valid) as typeof valid;
    changed.observations[0] = {
      observation_id: changed.observations[0]!.observation_id,
      criterion_id: changed.observations[0]!.criterion_id,
      facts: ["safety_event"],
      effects: changed.observations[0]!.effects,
    };
    expect(evaluateBehavioralTrace(changed).criteria.C1.observed).toBe(false);
    const stale = structuredClone(valid) as typeof valid;
    const staleIndex = stale.observations.findIndex((item) => item.scenario?.session === "STALE");
    stale.observations[staleIndex] = {
      ...stale.observations[staleIndex]!,
      effects: ["fullscreen_alert_opened"],
    };
    expect(evaluateBehavioralTrace(stale).criteria.C2.observed).toBe(false);
  });
  it("binds sharing variants to their actual preference", () => {
    const inverted = structuredClone(valid) as typeof valid;
    const c4 = inverted.observations.find((item) => item.criterion_id === "C4")!;
    c4.scenario = { preference: "SHARING" };
    c4.facts = ["nonsharing_variant", "sharing_preference_false"];
    expect(evaluateBehavioralTrace(inverted).criteria.C4.observed).toBe(false);
    const c5 = inverted.observations.find((item) => item.criterion_id === "C5")!;
    c5.scenario = { preference: "NONSHARING" };
    expect(evaluateBehavioralTrace(inverted).criteria.C5.observed).toBe(false);
  });
  it("rejects close-only mappings for safety actions", () => {
    const changed = structuredClone(valid) as typeof valid;
    for (const id of ["C6", "C7"] as const) {
      const item = changed.observations.find((entry) => entry.criterion_id === id)!;
      item.effects = ["alert_dismissed"];
    }
    expect(evaluateBehavioralTrace(changed).criteria.C6.observed).toBe(false);
    expect(evaluateBehavioralTrace(changed).criteria.C7.observed).toBe(false);
  });
  it("ignores nonsemantic diagnostics", () => {
    const a = evaluateBehavioralTrace({
      ...valid,
      observations: valid.observations.map((item) => ({
        ...item,
        diagnostics: { openURLCalls: 99 },
      })),
    });
    const b = evaluateBehavioralTrace({
      ...valid,
      observations: valid.observations.map((item) => ({
        ...item,
        diagnostics: { urlCalls: 99 },
      })),
    });
    expect(b).toEqual(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.criteria)).toBe(true);
  });
});
