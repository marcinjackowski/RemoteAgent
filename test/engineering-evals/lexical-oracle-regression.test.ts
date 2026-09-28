import { expect, it } from "vitest";

/**
 * Diagnostic-only model of the historical lexical qualification check. It is
 * deliberately not a Swift parser or semantic execution oracle.
 */
const historicalPredicate = (source: string): boolean =>
  source.includes("EmergencyResourcesViewModel(") ||
  (source.includes("SafetyAlert(") && source.includes(".emergencyResourcesViewModel"));

const corpus = {
  direct: "let subject = EmergencyResourcesViewModel()",
  safetyAlert: "let subject = SafetyAlert(); subject.emergencyResourcesViewModel",
  productionConfiguration:
    "let configuration = SafetyAlertConfiguration(factory: Application.self)\nlet model = configuration.resolve().emergencyResourcesViewModel\nmodel.primary.tapAction(); model.secondary.tapAction(); XCTAssertEqual(application.urls, expectedURLs); XCTAssertEqual(analytics.events, expectedEvents)",
  renamedLocal:
    "let configuration = SafetyAlertConfiguration(factory: Application.self)\nlet renamed = configuration.resolve().emergencyResourcesViewModel\nrenamed.primary.tapAction(); renamed.secondary.tapAction(); XCTAssertEqual(application.urls, expectedURLs); XCTAssertEqual(analytics.events, expectedEvents)",
  testOnlyDuplicate: "#if DEBUG\nlet duplicate = EmergencyResourcesViewModel()\n#endif",
  unusedHelper: "func unused() { _ = EmergencyResourcesViewModel() }",
  commentMarker: "// EmergencyResourcesViewModel()\nlet value = 1",
  stringMarker: 'let value = "SafetyAlert(); .emergencyResourcesViewModel"',
  omittedAction: "let subject = SafetyAlert(); subject.emergencyResourcesViewModel",
  missingAssertion:
    "let subject = SafetyAlert(); subject.emergencyResourcesViewModel.tapPrimary(); subject.emergencyResourcesViewModel.tapSecondary()",
  incorrectExpectation:
    "let subject = EmergencyResourcesViewModel(); subject.primary.tapAction(); XCTAssertEqual(application.urls, [])",
  disabledTest: "@available(*, unavailable)\nfunc testModel() { EmergencyResourcesViewModel() }",
  skippedTest:
    'func testModel() throws { throw XCTSkip("disabled"); _ = EmergencyResourcesViewModel() }',
  noTests: "struct ProductionFactory { let make = Application.self }",
} as const;

const expected = {
  direct: true,
  safetyAlert: true,
  productionConfiguration: false,
  renamedLocal: false,
  testOnlyDuplicate: true,
  unusedHelper: true,
  commentMarker: true,
  stringMarker: true,
  omittedAction: true,
  missingAssertion: true,
  incorrectExpectation: true,
  disabledTest: true,
  skippedTest: true,
  noTests: false,
} as const;

it.each(Object.entries(corpus))(
  "maps synthetic case %s to the historical lexical diagnostic",
  (name, source) => {
    expect(historicalPredicate(source)).toBe(expected[name as keyof typeof expected]);
  },
);

it("records lexical mismatches without claiming execution of the illustrative snippets", () => {
  const observed = Object.fromEntries(
    Object.entries(corpus).map(([name, source]) => [name, historicalPredicate(source)]),
  );
  // Neither snippets nor their expected classifications prove compilation or
  // behavior. They demonstrate why this predicate cannot decide either.
  expect(observed.productionConfiguration).toBe(false);
  expect(observed.noTests).toBe(false);
});
