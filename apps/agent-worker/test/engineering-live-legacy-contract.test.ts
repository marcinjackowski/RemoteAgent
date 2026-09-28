import { describe, expect, it } from "vitest";

import { assertLegacyMobl2023GateContract } from "./engineering-live-legacy-contract.js";

const safetyMutationPaths = [
  "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
  "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
];
const safetyTests = [
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
];
const flowMutationPaths = [
  "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlow.swift",
  "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlowView.swift",
  "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatViewModel.swift",
  "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentFlowView.swift",
];
const flowTests = [
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
];
const selectorTests = [
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
];
const allTests = [
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentFlowTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentSessionTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
  ...safetyTests,
  "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/AgentAIStreamingEngineTests.swift",
  "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
];

const gate = (
  gate_id: string,
  gate_schedule: "EACH_SLICE" | "LAST_SLICE",
  execution_order: number,
  extra: Record<string, unknown> = {},
) => ({
  gate_id,
  gate_class: "TEST",
  gate_tier: "FAST",
  gate_schedule,
  execution_order,
  executable: "/usr/bin/true",
  relative_cwd: ".",
  required: true,
  baseline: false,
  test_first: false,
  timeout_ms: 1_000,
  environment_profile: "HERMETIC",
  network_profile: "DENY",
  mutable_outputs: [],
  required_mutation_paths: [],
  required_test_paths: [],
  argv: [],
  ...extra,
});

function fixture(withChangelog = false) {
  const definitions = [
    gate("mobl-2023-safety-alert-contract", "LAST_SLICE", 25),
    gate("mobl-2023-safety-alert-contract-incremental", "EACH_SLICE", 20, {
      required_mutation_paths: safetyMutationPaths,
      required_test_paths: safetyTests,
      implementation_guidance:
        "Comparing only String(localized:) to the same production localization key is vacuous. Something you wrote suggested you might not be safe right now. Caring, trained counselors are ready to listen, for free, 24/7. Messages that raise a safety concern are automatically shared with your provider at SonderMind. In the meantime, caring, trained counselors are ready to listen and support you right now, for free, 24/7. The same claiming slice must wire the production SafetyAlert.swift and invoke both ButtonModel tapAction() closures.",
      implementation_context: [
        {
          kind: "SEARCH",
          relative_path:
            "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
          query: "final class TestApplication",
        },
      ],
      argv: [
        "Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
        "SafetyAlertTests must assert the exact UI copy: This message was shared for safety reasons",
        "production emergency-resources action model in SafetyAlert.swift",
        "SafetyAlertTests must invoke both ButtonModel tapAction closures",
        'safetyTests.includes("SafetyAlert(") && safetyTests.includes(".emergencyResourcesViewModel")',
        "SafetyAlertTests must assert application URL and analytics",
        "(?:openURLCalls|openUrlCalls|openedURLs|openedUrls)",
      ],
    }),
    gate("mobl-2023-flow-integration", "LAST_SLICE", 30, {
      required_mutation_paths: flowMutationPaths,
      required_test_paths: flowTests,
      implementation_guidance: "touching the four paths is not completion",
      implementation_context: flowTests.flatMap((relative_path) => [
        {
          kind: "SEARCH" as const,
          relative_path,
          query: "private var emergencyResources: EmergencyResources?",
        },
        { kind: "SEARCH" as const, relative_path, query: "emergencyResources" },
      ]),
      argv: [
        "single-agent typed safety state/router",
        "single-agent emergencyResources event route",
        "multi-agent typed safety state/router",
        "multi-agent emergencyResources event route",
      ],
    }),
    gate("mobl-2023-non-vacuous-xcode-selectors", "LAST_SLICE", 35, {
      required_test_paths: selectorTests,
      implementation_guidance:
        "Carry the exact EmergencyResources event into the full-screen alert; execute tapAction(). Patch the existing AgentAIFlowTests.swift and AIMultiAgentChatViewModelTests.swift. `let forwardedEvent = event` is an identity assertion. The selector accepts exactly either.",
      implementation_context: [{ kind: "READ", relative_path: safetyMutationPaths[0] }],
      argv: [
        "production emergency-resources action model",
        "production Text 988/Emergency resources action invocation",
        "exact emergencyResources event forwarding",
        "production action execution assertions",
        "not assign event to itself",
        "not a private test-only adapter",
        "existing AgentAIFlowTests.swift and AIMultiAgentChatViewModelTests.swift must observe emergency-resources routing into safetyAlert",
        'error?.code==="ENOENT"',
        "inline-card prevention assertion in AgentAIFlowTests.swift, AIMultiAgentChatViewModelTests.swift, or EmergencyResourcesTextFlowAdapterTests.swift",
        "emergencyResources\\s*:\\s*emergencyResources",
        "safetyAlertCoordinator\\s*\\.\\s*route\\s*\\(\\s*emergencyResources\\b",
      ],
    }),
    gate("ios-safety-alert-tests-final", "LAST_SLICE", 100, {
      gate_tier: "FULL",
      required_mutation_paths: [...safetyMutationPaths, ...flowMutationPaths],
      required_test_paths: [...safetyTests, ...flowTests, selectorTests[2], selectorTests[4]],
      argv: ["xcodebuild", "ENABLE_TESTABILITY=YES"],
    }),
    gate("mobl-2023-help-asset-input", "LAST_SLICE", 40),
  ];
  if (withChangelog) {
    definitions.push(
      gate("mobl-2023-testflight-changelog", "LAST_SLICE", 45, {
        required_mutation_paths: ["SonderClient/TestFlight/WhatToTest.en-US.txt"],
        implementation_context: [
          { kind: "READ", relative_path: "SonderClient/TestFlight/WhatToTest.en-US.txt" },
        ],
      }),
    );
  }
  const isolatedDefinitions = structuredClone(definitions);
  return {
    catalog: {
      definitions: isolatedDefinitions,
      get: (id: string) => isolatedDefinitions.find((definition) => definition.gate_id === id),
    },
    generatorCatalog: {
      definitions: [
        {
          generator_id: "mobl-2023-shared-assets",
          trigger_paths: ["SonderClient/SonderClientLibrary/Sources/Shared/AgentAI"],
          output_paths: [
            "SonderClient/SonderClientLibrary/Sources/Shared/Resources/Assets+Generated.swift",
          ],
        },
      ],
    },
    testPathAllowlist: [...allTests],
  } as Parameters<typeof assertLegacyMobl2023GateContract>[0];
}

describe("legacy MOBL2023 gate contract", () => {
  it.each([false, true])("accepts the portable legacy contract (changelog: %s)", (changelog) => {
    expect(assertLegacyMobl2023GateContract(fixture(changelog))).toHaveProperty(
      "finalSafetyContract.gate_schedule",
      "LAST_SLICE",
    );
  });

  it.each([
    [
      "missing final gate",
      "live task-wide safety-alert contract must run only on the last slice",
      (value: ReturnType<typeof fixture>) => value.catalog.definitions.splice(0, 1),
    ],
    [
      "wrong schedule",
      "live task-wide safety-alert contract must run only on the last slice",
      (value: ReturnType<typeof fixture>) => {
        value.catalog.definitions[0]!.gate_schedule = "EACH_SLICE";
      },
    ],
    [
      "wrong ownership",
      "live safety-alert ownership",
      (value: ReturnType<typeof fixture>) => {
        value.catalog.definitions[1]!.required_mutation_paths.pop();
      },
    ],
    [
      "wrong selector markers",
      "live selector gate must bind exact task-owned tests to production action execution",
      (value: ReturnType<typeof fixture>) => {
        value.catalog.definitions[3]!.argv.pop();
      },
    ],
    [
      "context cap",
      "live last-slice speculative context exceeds the bounded budget",
      (value: ReturnType<typeof fixture>) => {
        value.catalog.definitions[2]!.implementation_context!.push(
          ...Array.from({ length: 20 }, (_, index) => ({
            kind: "SEARCH",
            relative_path: `tmp/${index}.swift`,
            query: `q${index}`,
          })),
        );
      },
    ],
    [
      "wrong test authority",
      "live test path authority must remain exact and file-bounded",
      (value: ReturnType<typeof fixture>) => {
        value.testPathAllowlist.pop();
      },
    ],
    [
      "wrong generator",
      "live shared asset accessor must use the exact code-owned generator",
      (value: ReturnType<typeof fixture>) => {
        value.generatorCatalog!.definitions[0]!.output_paths[0] = "wrong.swift";
      },
    ],
    [
      "wrong help asset",
      "live help asset input must not require model-authored paths",
      (value: ReturnType<typeof fixture>) => {
        value.catalog.definitions[5]!.required_mutation_paths.push("Model.swift");
      },
    ],
  ])("rejects %s", (_label, expectedError, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => assertLegacyMobl2023GateContract(value)).toThrow(expectedError);
    expect(() => assertLegacyMobl2023GateContract(fixture())).not.toThrow();
    expect(() => assertLegacyMobl2023GateContract(fixture(true))).not.toThrow();
  });
});
