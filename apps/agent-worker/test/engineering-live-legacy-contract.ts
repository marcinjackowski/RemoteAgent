import {
  engineeringImplementationContext,
  type EngineeringExecutionConfig,
} from "../src/engineering-execution.js";

export function assertLegacyMobl2023GateContract(
  input: Pick<EngineeringExecutionConfig, "catalog" | "generatorCatalog" | "testPathAllowlist">,
) {
  const liveGateSchedules = new Map(
    input.catalog.definitions.map((definition) => [definition.gate_id, definition.gate_schedule]),
  );
  if (liveGateSchedules.get("mobl-2023-safety-alert-contract") !== "LAST_SLICE") {
    throw new Error("live task-wide safety-alert contract must run only on the last slice");
  }
  const incrementalSafetyContract = input.catalog.get(
    "mobl-2023-safety-alert-contract-incremental",
  );
  const finalSafetyContract = input.catalog.get("mobl-2023-safety-alert-contract");
  const incrementalSafetyCommand = incrementalSafetyContract?.argv.join("\n") ?? "";
  const incrementalSafetyContext = incrementalSafetyContract?.implementation_context ?? [];
  const incrementalSafetyQueries = incrementalSafetyContext.flatMap((entry) =>
    entry.kind === "SEARCH" ? [entry.query] : [],
  );
  const incrementalSafetyPaths = incrementalSafetyContext.map((entry) => entry.relative_path);
  const safetyAlertMutationPaths = [
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
  ] as const;
  const safetyAlertTestPaths = [
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
  ] as const;
  if (
    incrementalSafetyContract?.gate_schedule !== "EACH_SLICE" ||
    incrementalSafetyContract.gate_tier !== "FAST" ||
    incrementalSafetyContract.execution_order !== 20 ||
    incrementalSafetyContract.required_test_paths.join("\n") !== safetyAlertTestPaths.join("\n") ||
    incrementalSafetyContract.required_mutation_paths.join("\n") !==
      [...safetyAlertMutationPaths].join("\n") ||
    incrementalSafetyContract.implementation_guidance === undefined ||
    !incrementalSafetyContract.implementation_guidance.includes(
      "Comparing only String(localized:) to the same production localization key is vacuous",
    ) ||
    !incrementalSafetyContract.implementation_guidance.includes(
      "Something you wrote suggested you might not be safe right now. Caring, trained counselors are ready to listen, for free, 24/7.",
    ) ||
    !incrementalSafetyContract.implementation_guidance.includes(
      "Messages that raise a safety concern are automatically shared with your provider at SonderMind.",
    ) ||
    !incrementalSafetyContract.implementation_guidance.includes(
      "In the meantime, caring, trained counselors are ready to listen and support you right now, for free, 24/7.",
    ) ||
    incrementalSafetyContract.implementation_context === undefined ||
    !incrementalSafetyCommand.includes("Tests/SharedTests/AgentAI/SafetyAlertTests.swift") ||
    !incrementalSafetyCommand.includes(
      "SafetyAlertTests must assert the exact UI copy: This message was shared for safety reasons",
    ) ||
    !incrementalSafetyCommand.includes(
      "production emergency-resources action model in SafetyAlert.swift",
    ) ||
    !incrementalSafetyCommand.includes(
      "SafetyAlertTests must invoke both ButtonModel tapAction closures",
    ) ||
    !incrementalSafetyCommand.includes(
      'safetyTests.includes("SafetyAlert(") && safetyTests.includes(".emergencyResourcesViewModel")',
    ) ||
    !incrementalSafetyCommand.includes(
      "SafetyAlertTests must assert application URL and analytics",
    ) ||
    !incrementalSafetyCommand.includes("(?:openURLCalls|openUrlCalls|openedURLs|openedUrls)") ||
    !incrementalSafetyContract.implementation_guidance.includes(
      "same claiming slice must wire the production SafetyAlert.swift",
    ) ||
    !incrementalSafetyContract.implementation_guidance.includes(
      "invoke both ButtonModel tapAction() closures",
    ) ||
    !incrementalSafetyQueries.includes("final class TestApplication") ||
    !incrementalSafetyPaths.includes(
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    ) ||
    finalSafetyContract?.gate_schedule !== "LAST_SLICE" ||
    finalSafetyContract.gate_tier !== "FAST" ||
    finalSafetyContract.execution_order !== 25 ||
    finalSafetyContract.implementation_guidance !== undefined ||
    finalSafetyContract.implementation_context !== undefined
  ) {
    throw new Error(
      "live safety-alert ownership must fail the claiming slice and retain independent final evidence",
    );
  }
  if (liveGateSchedules.get("mobl-2023-flow-integration") !== "LAST_SLICE") {
    throw new Error("live task-wide flow integration must run only on the last slice");
  }
  const flowIntegration = input.catalog.get("mobl-2023-flow-integration");
  const flowCommand = flowIntegration?.argv.join("\n") ?? "";
  const flowContextQueries = (flowIntegration?.implementation_context ?? []).flatMap((entry) =>
    entry.kind === "SEARCH" ? [entry.query] : [],
  );
  const flowContextSearches = (flowIntegration?.implementation_context ?? []).flatMap((entry) =>
    entry.kind === "SEARCH" ? [`${entry.relative_path}:${entry.query}`] : [],
  );
  const flowMutationPaths = [
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlow.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlowView.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatViewModel.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentFlowView.swift",
  ] as const;
  const flowTestPaths = [
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
  ] as const;
  if (
    flowIntegration?.required_mutation_paths.join("\n") !== flowMutationPaths.join("\n") ||
    flowIntegration.required_test_paths.join("\n") !== flowTestPaths.join("\n") ||
    flowIntegration?.implementation_guidance === undefined ||
    !flowIntegration.implementation_guidance.includes(
      "touching the four paths is not completion",
    ) ||
    !flowCommand.includes("single-agent typed safety state/router") ||
    !flowCommand.includes("single-agent emergencyResources event route") ||
    !flowCommand.includes("multi-agent typed safety state/router") ||
    !flowCommand.includes("multi-agent emergencyResources event route") ||
    flowContextQueries.filter(
      (query) => query === "private var emergencyResources: EmergencyResources?",
    ).length !== 2 ||
    !flowContextSearches.includes(
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift:emergencyResources",
    ) ||
    !flowContextSearches.includes(
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift:emergencyResources",
    )
  ) {
    throw new Error(
      "live flow correction must prefetch exact declaration, session routing, and session-test boundaries",
    );
  }
  const lastSliceGateIds = input.catalog.definitions
    .filter(
      (definition) =>
        definition.required &&
        (definition.gate_schedule === "EACH_SLICE" || definition.gate_schedule === "LAST_SLICE"),
    )
    .map((definition) => definition.gate_id);
  const changelogGate = input.catalog.get("mobl-2023-testflight-changelog");
  const changelogContext = changelogGate?.implementation_context ?? [];
  if (
    changelogGate !== undefined &&
    (changelogGate.gate_schedule !== "LAST_SLICE" ||
      changelogGate.gate_tier !== "FAST" ||
      changelogGate.gate_class !== "TEST" ||
      changelogGate.required !== true ||
      changelogGate.execution_order !== 45 ||
      changelogGate.required_mutation_paths.join("\n") !==
        "SonderClient/TestFlight/WhatToTest.en-US.txt" ||
      changelogGate.required_test_paths.length !== 0 ||
      changelogGate.network_profile !== "DENY" ||
      changelogGate.mutable_outputs.length !== 0 ||
      changelogContext.length !== 1 ||
      changelogContext[0]?.kind !== "READ" ||
      changelogContext[0]?.relative_path !== "SonderClient/TestFlight/WhatToTest.en-US.txt")
  ) {
    throw new Error("live optional TestFlight changelog gate must remain exact and bounded");
  }
  const lastSliceContext = engineeringImplementationContext(input.catalog, lastSliceGateIds);
  const lastSliceContextCap = changelogGate === undefined ? 18 : 19;
  if (lastSliceContext.length > lastSliceContextCap) {
    throw new Error(
      `live last-slice speculative context exceeds the bounded budget: ${lastSliceContext.length}`,
    );
  }
  const expectedTestPaths = [
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentSessionTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/AgentAIStreamingEngineTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
  ] as const;
  if (input.testPathAllowlist.join("\n") !== expectedTestPaths.join("\n")) {
    throw new Error("live test path authority must remain exact and file-bounded");
  }
  const requiredSelectorTestPaths = [
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
  ] as const;
  const selectorGate = input.catalog.get("mobl-2023-non-vacuous-xcode-selectors");
  const selectorCommand = selectorGate?.argv.join("\n") ?? "";
  const selectorContextReads = (selectorGate?.implementation_context ?? []).flatMap((entry) =>
    entry.kind === "READ" ? [entry.relative_path] : [],
  );
  if (
    selectorGate?.required_test_paths.join("\n") !== requiredSelectorTestPaths.join("\n") ||
    selectorGate.implementation_guidance === undefined ||
    !selectorGate.implementation_guidance.includes(
      "Carry the exact EmergencyResources event into the full-screen alert",
    ) ||
    !selectorGate.implementation_guidance.includes("execute tapAction()") ||
    !selectorGate.implementation_guidance.includes(
      "Patch the existing AgentAIFlowTests.swift and AIMultiAgentChatViewModelTests.swift",
    ) ||
    !selectorGate.implementation_guidance.includes(
      "`let forwardedEvent = event` is an identity assertion",
    ) ||
    !selectorGate.implementation_guidance.includes("The selector accepts exactly either") ||
    !selectorContextReads.includes(
      "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
    ) ||
    !selectorCommand.includes("production emergency-resources action model") ||
    !selectorCommand.includes("production Text 988/Emergency resources action invocation") ||
    !selectorCommand.includes("exact emergencyResources event forwarding") ||
    !selectorCommand.includes("production action execution assertions") ||
    !selectorCommand.includes("not assign event to itself") ||
    !selectorCommand.includes("not a private test-only adapter") ||
    !selectorCommand.includes(
      "existing AgentAIFlowTests.swift and AIMultiAgentChatViewModelTests.swift must observe emergency-resources routing into safetyAlert",
    ) ||
    !selectorCommand.includes('error?.code==="ENOENT"') ||
    !selectorCommand.includes(
      "inline-card prevention assertion in AgentAIFlowTests.swift, AIMultiAgentChatViewModelTests.swift, or EmergencyResourcesTextFlowAdapterTests.swift",
    ) ||
    !selectorCommand.includes("emergencyResources\\s*:\\s*emergencyResources") ||
    !selectorCommand.includes(
      "safetyAlertCoordinator\\s*\\.\\s*route\\s*\\(\\s*emergencyResources\\b",
    )
  ) {
    throw new Error(
      "live selector gate must bind exact task-owned tests to production action execution",
    );
  }
  const targetedFast = input.catalog.definitions.find(
    (definition) => definition.gate_id === "ios-safety-alert-tests",
  );
  const targetedFull = input.catalog.definitions.find(
    (definition) => definition.gate_id === "ios-safety-alert-tests-final",
  );
  const compilePreflight = input.catalog.get("mobl-2023-ios-compile");
  const finalXcodeMutationPaths = [...safetyAlertMutationPaths, ...flowMutationPaths];
  const finalXcodeTestPaths = [
    ...safetyAlertTestPaths,
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
  ];
  if (
    targetedFast !== undefined ||
    compilePreflight !== undefined ||
    targetedFull?.gate_schedule !== "LAST_SLICE" ||
    targetedFull.gate_tier !== "FULL" ||
    targetedFull.execution_order !== 100 ||
    targetedFull.argv.includes("-quiet") ||
    targetedFull.argv.filter((argument) => argument === "ENABLE_TESTABILITY=YES").length !== 1 ||
    targetedFull.required_mutation_paths.join("\n") !== finalXcodeMutationPaths.join("\n") ||
    targetedFull.required_test_paths.join("\n") !== finalXcodeTestPaths.join("\n")
  ) {
    throw new Error(
      "live targeted iOS tests must have one exact verbose LAST_SLICE FULL gate without redundant compile",
    );
  }
  const assetGenerator = input.generatorCatalog?.definitions.find(
    (definition) => definition.generator_id === "mobl-2023-shared-assets",
  );
  if (
    assetGenerator === undefined ||
    assetGenerator.trigger_paths.join("\n") !==
      "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI" ||
    assetGenerator.output_paths.join("\n") !==
      "SonderClient/SonderClientLibrary/Sources/Shared/Resources/Assets+Generated.swift"
  ) {
    throw new Error("live shared asset accessor must use the exact code-owned generator");
  }
  const helpAssetInput = input.catalog.get("mobl-2023-help-asset-input");
  if (
    helpAssetInput === undefined ||
    helpAssetInput.required_mutation_paths.length !== 0 ||
    helpAssetInput.required_test_paths.length !== 0
  ) {
    throw new Error("live help asset input must not require model-authored paths");
  }
  return Object.freeze({ incrementalSafetyContract, finalSafetyContract });
}
