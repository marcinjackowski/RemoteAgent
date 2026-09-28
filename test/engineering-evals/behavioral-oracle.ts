const criterionIds = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"] as const;
export type BehavioralTrace = {
  schema_version: 1;
  provenance: { origin: "EVALUATOR"; trace_id: string };
  observations: Array<{
    observation_id: string;
    criterion_id: (typeof criterionIds)[number];
    facts: string[];
    effects: string[];
    scenario?: { preference?: "SHARING" | "NONSHARING"; session?: "ACTIVE" | "STALE" };
    diagnostics?: { openURLCalls?: number; urlCalls?: number };
  }>;
  assertions: Array<{
    assertion_id: string;
    observation_id: string;
    source: "EXECUTED_ASSERTION";
    substantive: true;
  }>;
};
export type BehavioralOracleResult = Readonly<{
  overall: "PASS" | "FAIL";
  criteria: Readonly<
    Record<(typeof criterionIds)[number], Readonly<{ observed: boolean; evidence_count: number }>>
  >;
}>;

const required: Record<
  (typeof criterionIds)[number],
  { facts: readonly string[]; effects: readonly string[] }
> = {
  C1: { facts: ["production_route", "safety_event"], effects: ["fullscreen_alert_opened"] },
  C2: {
    facts: ["production_route", "active_session"],
    effects: ["fullscreen_alert_opened", "stale_event_rejected"],
  },
  C3: {
    facts: [
      "fullscreen_interruption",
      "legacy_inline_absent",
      "session_interrupted",
      "input_interrupted",
    ],
    effects: ["fullscreen_alert_opened"],
  },
  C4: { facts: ["nonsharing_variant"], effects: ["nonsharing_alert_presented"] },
  C5: {
    facts: ["sharing_preference_true"],
    effects: ["sharing_variant_selected"],
  },
  C6: { facts: ["text_988_action"], effects: ["sms_url_exact", "analytics_text_988"] },
  C7: {
    facts: ["resources_action"],
    effects: ["resources_presented", "resources_url_exact", "analytics_resources"],
  },
  C8: { facts: ["close_action"], effects: ["alert_dismissed", "no_external_side_effect"] },
  C9: {
    facts: ["lifecycle_dismiss", "lifecycle_reopen", "session_boundary"],
    effects: ["single_open_per_session", "no_duplicate_effects"],
  },
  C10: {
    facts: [
      "help_pdf_nonempty",
      "both_variants",
      "accessibility_label",
      "dynamic_type",
      "gradient",
    ],
    effects: ["bounded_ui_observation"],
  },
};

const known = new Set([
  ...Object.values(required).flatMap((entry) => [...entry.facts, ...entry.effects]),
  "sharing_preference_false",
]);
const canonicalId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const boundedTokens = (values: unknown): values is string[] =>
  Array.isArray(values) &&
  values.length <= 64 &&
  values.every(
    (value) =>
      typeof value === "string" && value.length > 0 && value.length <= 96 && known.has(value),
  ) &&
  new Set(values).size === values.length;

export function evaluateBehavioralTrace(input: unknown): BehavioralOracleResult {
  const trace = input as Partial<BehavioralTrace>;
  if (
    !trace ||
    trace.schema_version !== 1 ||
    !trace.provenance ||
    typeof trace.provenance !== "object" ||
    Array.isArray(trace.provenance) ||
    !canonicalId(trace.provenance.trace_id) ||
    trace.provenance?.origin !== "EVALUATOR" ||
    !Array.isArray(trace.observations) ||
    trace.observations.length < 10 ||
    trace.observations.length > 32 ||
    !Array.isArray(trace.assertions)
  )
    throw new Error("invalid behavioral trace");
  if (
    Object.keys(trace).some(
      (key) => !["schema_version", "provenance", "observations", "assertions"].includes(key),
    )
  )
    throw new Error("unknown trace field");
  if (Object.keys(trace.provenance).some((key) => !["origin", "trace_id"].includes(key)))
    throw new Error("unknown provenance field");
  const ids = new Set<string>();
  const assertionIds = new Set<string>();
  for (const item of trace.observations) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      !canonicalId(item.observation_id) ||
      typeof item.criterion_id !== "string" ||
      !Array.isArray(item.facts) ||
      !Array.isArray(item.effects)
    )
      throw new Error("invalid observation");
    if (
      Object.keys(item).some(
        (key) =>
          ![
            "observation_id",
            "criterion_id",
            "facts",
            "effects",
            "scenario",
            "diagnostics",
          ].includes(key),
      )
    )
      throw new Error("unknown observation field");
    if (ids.has(item.observation_id)) throw new Error("duplicate observation identity");
    ids.add(item.observation_id);
    if (
      !(criterionIds as readonly string[]).includes(item.criterion_id) ||
      !boundedTokens(item.facts) ||
      !boundedTokens(item.effects)
    )
      throw new Error("invalid observation bounds");
    if (item.scenario !== undefined) {
      if (
        !item.scenario ||
        typeof item.scenario !== "object" ||
        Array.isArray(item.scenario) ||
        Object.keys(item.scenario).some((key) => !["preference", "session"].includes(key)) ||
        (item.scenario.preference !== undefined &&
          !["SHARING", "NONSHARING"].includes(item.scenario.preference)) ||
        (item.scenario.session !== undefined &&
          !["ACTIVE", "STALE"].includes(item.scenario.session))
      )
        throw new Error("invalid scenario");
    }
    if (
      item.diagnostics !== undefined &&
      (!item.diagnostics ||
        typeof item.diagnostics !== "object" ||
        Array.isArray(item.diagnostics) ||
        Object.keys(item.diagnostics).some((key) => !["openURLCalls", "urlCalls"].includes(key)) ||
        Object.values(item.diagnostics).some(
          (value) =>
            typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000,
        ))
    )
      throw new Error("invalid diagnostics");
  }
  if (trace.assertions.length !== trace.observations.length || trace.assertions.length > 256)
    throw new Error("assertions must bind one-to-one");
  for (const assertion of trace.assertions) {
    if (
      !assertion ||
      typeof assertion !== "object" ||
      Object.keys(assertion).some(
        (key) => !["assertion_id", "observation_id", "source", "substantive"].includes(key),
      ) ||
      !canonicalId(assertion.assertion_id) ||
      !canonicalId(assertion.observation_id) ||
      assertionIds.has(assertion.assertion_id) ||
      assertion.source !== "EXECUTED_ASSERTION" ||
      assertion.substantive !== true ||
      !ids.has(assertion.observation_id)
    )
      throw new Error("invalid substantive assertion");
    assertionIds.add(assertion.assertion_id);
  }
  if (new Set(trace.assertions.map((item) => item.observation_id)).size !== ids.size)
    throw new Error("unproven observation");
  const observations = trace.observations;
  if (!observations) throw new Error("invalid behavioral trace");
  const criteria = Object.fromEntries(
    criterionIds.map((id) => {
      const entries = observations.filter((item) => item.criterion_id === id);
      const facts = new Set(entries.flatMap((item) => item.facts));
      const effects = new Set(entries.flatMap((item) => item.effects));
      const expected = required[id];
      const observed =
        expected.facts.every((value) => facts.has(value)) &&
        expected.effects.every((value) => effects.has(value));
      const scenarioBound =
        id === "C2"
          ? entries.some(
              (entry) =>
                entry.scenario?.session === "ACTIVE" &&
                entry.effects.includes("fullscreen_alert_opened") &&
                !entry.effects.includes("stale_event_rejected"),
            ) &&
            entries.some(
              (entry) =>
                entry.scenario?.session === "STALE" &&
                entry.effects.includes("stale_event_rejected") &&
                !entry.effects.includes("fullscreen_alert_opened"),
            )
          : id === "C4"
            ? entries.some(
                (entry) =>
                  entry.scenario?.preference === "NONSHARING" &&
                  entry.facts.includes("sharing_preference_false"),
              )
            : id === "C5"
              ? entries.some((entry) => entry.scenario?.preference === "SHARING")
              : true;
      return [
        id,
        Object.freeze({
          observed: observed && scenarioBound,
          evidence_count:
            observed && scenarioBound ? expected.facts.length + expected.effects.length : 0,
        }),
      ];
    }),
  ) as BehavioralOracleResult["criteria"];
  return Object.freeze({
    overall: criterionIds.every((id) => criteria[id].observed) ? "PASS" : "FAIL",
    criteria: Object.freeze(criteria),
  });
}
