import {
  TRUSTED_EVALUATOR_UI_LAYOUT,
  validateTrustedEvaluatorInputs,
} from "@remoteagent/test-evidence";
import type { VerificationGateDefinition } from "@remoteagent/test-evidence";
import { FULL_FLOW_COMMON_CONTRACT_POLICY } from "./engineering-live-full-flow-common-contract.js";

export type FullFlowEvaluatorProfile = "combined" | "text" | "ui";

export type FullFlowEvaluatorHost = Readonly<{
  xcodebuildPath: string;
  destination: string;
}>;

export type FullFlowEvaluatorExpectation = Readonly<{
  profile: FullFlowEvaluatorProfile;
  gateId: string;
  executionOrder: number;
  qualifiedArgv: readonly string[];
  relativeCwd: string;
  project: string;
  scheme: string;
  mutableOutputs: readonly string[];
  inputDigest: string;
  inputPaths: readonly string[];
  requiredTestIds: readonly string[];
  /** Explicit code-owned repair candidates; protected evaluator inputs stay immutable. */
  requiredMutationPaths: readonly string[];
  layout?: typeof TRUSTED_EVALUATOR_UI_LAYOUT;
}>;

const combinedArgvTestIds = [
  "SharedTests/RA055SafetyFlowModelTests/testChatViewModel_whenSendingBlocked_doesNotSend",
  "SharedTests/RA055SafetyFlowModelTests/testChatViewModel_whenFocusBlockedOnly_sendsExactText",
  "SharedTests/RA055SafetyFlowStateTests/testSingleFlow_unblockedAlertBlocksSendAndCloseRestoresAndSends",
  "SharedTests/RA055SafetyFlowStateTests/testSingleFlow_initiallyBlockedAlertCloseRestoresBlockedAndPreventsSend",
  "SharedTests/RA055SafetyFlowStateTests/testMultiFlow_unblockedAlertBlocksSendAndCloseRestores",
  "SharedTests/RA055SafetyFlowStateTests/testMultiFlow_initiallyBlockedAlertCloseRestoresBlocked",
  "SharedTests/RA055SafetyFlowVoiceTests/testSingleVoiceEmergencyDisconnectsStartedRoom",
  "SharedTests/RA055SafetyFlowVoiceTests/testMultiVoiceEmergencyDisconnectsStartedRoom",
  "SharedTests/RA055SafetyAlertEvaluatorTests/testGeneralHelpCopyAndActions",
  "SharedTests/RA055SafetyAlertEvaluatorTests/testActivitySharingCopyAndDistinctConstruction",
  "SharedTests/RA055SafetyAlertEvaluatorTests/testActivitySharingActions",
] as const;

const combinedTestIds = [...combinedArgvTestIds].sort();

const textArgvTestIds = combinedArgvTestIds.filter(
  (id) => !id.includes("RA055SafetyFlowVoiceTests/"),
);
const textTestIds = [...textArgvTestIds].sort();

const combinedArgv = [
  "-project",
  "SonderClient.xcodeproj",
  "-scheme",
  "SonderClient-Beta",
  "-destination",
  "platform=iOS Simulator,id=DADE0B09-F441-44CB-81F2-CE28F75C64D5",
  "-derivedDataPath",
  ".remoteagent-xcode/DerivedData",
  "-clonedSourcePackagesDirPath",
  ".remoteagent-xcode/SourcePackages",
  "-resultBundlePath",
  ".remoteagent-xcode/Qualified.xcresult",
  "ENABLE_TESTABILITY=YES",
  ...combinedArgvTestIds.map((id) => `-only-testing:${id}`),
  "test",
] as const;

const textArgv = combinedArgv.filter((arg) => !arg.includes("RA055SafetyFlowVoiceTests/"));

const uiArgvTestIds = [
  "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testSingleAgentGeneralHelpFlow",
  "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testSingleAgentActivitySharingFlow",
  "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testMultiAgentGeneralHelpFlow",
  "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testMultiAgentActivitySharingFlow",
] as const;

const uiTestIds = [...uiArgvTestIds].sort();

const fullFlowRepairCandidatePaths = FULL_FLOW_COMMON_CONTRACT_POLICY.writePathAllowlist.filter(
  (path) =>
    !FULL_FLOW_COMMON_CONTRACT_POLICY.generatorOutputPaths.includes(path) &&
    !FULL_FLOW_COMMON_CONTRACT_POLICY.testPathAllowlist.includes(path),
);

function assertRepairCandidatePaths(paths: readonly string[], label: string): void {
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`${label} repair candidate paths must be non-empty and unique`);
  }
  if (paths.some((path) => !fullFlowRepairCandidatePaths.includes(path))) {
    throw new Error(`${label} repair candidate paths contain a protected or foreign path`);
  }
}

const uiArgv = [
  "-project",
  "RemoteAgentUIHarness.xcodeproj",
  "-scheme",
  "RemoteAgentUIHarness",
  "-destination",
  "platform=iOS Simulator,id=DADE0B09-F441-44CB-81F2-CE28F75C64D5",
  "-derivedDataPath",
  ".remoteagent-xcode/DerivedData",
  "-clonedSourcePackagesDirPath",
  ".remoteagent-xcode/SourcePackages",
  "-resultBundlePath",
  ".remoteagent-xcode/Qualified.xcresult",
  "-disableAutomaticPackageResolution",
  "-onlyUsePackageVersionsFromResolvedFile",
  "ENABLE_TESTABILITY=YES",
  ...uiArgvTestIds.map((id) => `-only-testing:${id}`),
  "test",
] as const;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const FULL_FLOW_EVALUATOR_EXPECTATIONS = deepFreeze({
  combined: {
    profile: "combined",
    gateId: "ios-full-flow-model-tests-final",
    executionOrder: 100,
    qualifiedArgv: combinedArgv,
    relativeCwd: "SonderClient",
    project: "SonderClient.xcodeproj",
    scheme: "SonderClient-Beta",
    mutableOutputs: ["SonderClient/.remoteagent-xcode"],
    inputDigest: "sha256:c924afc57be92787c633a379efc57ebe5fe0860c41b9953051a0e3a9f1f4c606",
    inputPaths: [
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyAlertEvaluatorTests.swift",
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyFlowModelTests.swift",
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyFlowStateTests.swift",
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyFlowVoiceTests.swift",
    ],
    requiredTestIds: combinedTestIds,
    requiredMutationPaths: fullFlowRepairCandidatePaths,
  },
  text: {
    profile: "text",
    gateId: "ios-text-flow-model-tests-final",
    executionOrder: 100,
    qualifiedArgv: textArgv,
    relativeCwd: "SonderClient",
    project: "SonderClient.xcodeproj",
    scheme: "SonderClient-Beta",
    mutableOutputs: ["SonderClient/.remoteagent-xcode"],
    inputDigest: "sha256:1823cf8866e8a0b93e219fde2f5829097f6e159ea751de7207af44f92aedfc50",
    inputPaths: [
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyAlertEvaluatorTests.swift",
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyFlowModelTests.swift",
      "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/RA055SafetyFlowStateTests.swift",
    ],
    requiredTestIds: textTestIds,
    requiredMutationPaths: fullFlowRepairCandidatePaths,
  },
  ui: {
    profile: "ui",
    gateId: "ios-full-flow-ui-tests-final",
    executionOrder: 110,
    qualifiedArgv: uiArgv,
    relativeCwd: "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness",
    project: "RemoteAgentUIHarness.xcodeproj",
    scheme: "RemoteAgentUIHarness",
    mutableOutputs: [
      "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/.remoteagent-xcode",
    ],
    inputDigest: "sha256:b10e21fdb5f9a3f5763c704aec38f8b7e157ee89247c12ee40f5187455efb78d",
    inputPaths: [
      "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/App/RemoteAgentUIHarnessApp.swift",
      "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.pbxproj",
      "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
      "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme",
      "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/UITests/RemoteAgentUIHarnessUITests.swift",
    ],
    requiredTestIds: uiTestIds,
    requiredMutationPaths: fullFlowRepairCandidatePaths,
    layout: TRUSTED_EVALUATOR_UI_LAYOUT,
  },
} satisfies Record<FullFlowEvaluatorProfile, FullFlowEvaluatorExpectation>);

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedArgv(
  expectation: FullFlowEvaluatorExpectation,
  host: FullFlowEvaluatorHost,
): readonly string[] {
  const destinationIndex = expectation.qualifiedArgv.indexOf("-destination");
  if (
    destinationIndex < 0 ||
    destinationIndex + 1 >= expectation.qualifiedArgv.length ||
    expectation.qualifiedArgv.filter((arg) => arg === "-destination").length !== 1
  ) {
    throw new Error("qualified full-flow evaluator argv has an invalid destination flag");
  }
  return expectation.qualifiedArgv.map((arg, index) =>
    index === destinationIndex + 1 ? host.destination : arg,
  );
}

export function constructFullFlowEvaluatorArgv(
  expectation: FullFlowEvaluatorExpectation,
  host: FullFlowEvaluatorHost,
): readonly string[] {
  return expectedArgv(expectation, host);
}

function assertNoDuplicateOrForbiddenFlags(argv: readonly string[]): void {
  if (argv.some((arg) => arg === "-quiet" || arg.startsWith("-quiet="))) {
    throw new Error("full-flow evaluator argv must not contain quiet flags");
  }
  const singletonFlags = [
    "-project",
    "-scheme",
    "-destination",
    "-derivedDataPath",
    "-clonedSourcePackagesDirPath",
    "-resultBundlePath",
  ];
  for (const flag of singletonFlags) {
    if (argv.filter((arg) => arg === flag).length !== 1) {
      throw new Error(`full-flow evaluator argv must contain exactly one ${flag}`);
    }
  }
  if (argv.some((arg) => /^-(?:project|scheme|destination)=/u.test(arg))) {
    throw new Error("full-flow evaluator argv must not use equals aliases");
  }
  const selectors = argv.filter((arg) => arg.startsWith("-only-testing:"));
  if (new Set(selectors).size !== selectors.length) {
    throw new Error("full-flow evaluator argv contains duplicate test selectors");
  }
  if (argv.filter((arg) => arg === "test").length !== 1) {
    throw new Error("full-flow evaluator argv must contain exactly one test action");
  }
}

function assertTrustedInputs(
  definition: VerificationGateDefinition,
  expectation: FullFlowEvaluatorExpectation,
): void {
  if (definition.trusted_evaluator_inputs === undefined) {
    throw new Error("full-flow evaluator gate requires trusted evaluator inputs");
  }
  let snapshot;
  try {
    snapshot = validateTrustedEvaluatorInputs(definition.trusted_evaluator_inputs);
  } catch (error) {
    throw new Error("full-flow evaluator trusted inputs are invalid", { cause: error });
  }
  if (snapshot.digest !== expectation.inputDigest) {
    throw new Error("full-flow evaluator input digest is not qualified");
  }
  if (
    !exactArray(
      snapshot.files.map((file) => file.relative_path),
      expectation.inputPaths,
    )
  ) {
    throw new Error("full-flow evaluator input paths are not qualified");
  }
  if (!exactArray(snapshot.required_executed_test_ids, expectation.requiredTestIds)) {
    throw new Error("full-flow evaluator test IDs are not qualified");
  }
  if (snapshot.layout !== expectation.layout) {
    throw new Error("full-flow evaluator input layout is not qualified");
  }
}

export function validateFullFlowEvaluatorDefinition(input: {
  definition: VerificationGateDefinition;
  expectation: FullFlowEvaluatorExpectation;
  host: FullFlowEvaluatorHost;
}): VerificationGateDefinition {
  const { definition, expectation, host } = input;
  assertRepairCandidatePaths(expectation.requiredMutationPaths, "qualified expectation");
  assertRepairCandidatePaths(definition.required_mutation_paths, "definition");
  if (definition.gate_id !== expectation.gateId)
    throw new Error("full-flow evaluator gate ID mismatch");
  if (
    definition.gate_class !== "TEST" ||
    definition.gate_tier !== "FULL" ||
    definition.gate_schedule !== "LAST_SLICE" ||
    definition.execution_order !== expectation.executionOrder ||
    !definition.required ||
    definition.baseline ||
    definition.test_first
  ) {
    throw new Error("full-flow evaluator gate metadata is not current-only FULL LAST_SLICE");
  }
  if (
    definition.timeout_ms !== 1_200_000 ||
    definition.environment_profile !== "BUILD_TOOLCHAIN" ||
    definition.network_profile !== "PLATFORM_MANAGED"
  ) {
    throw new Error("full-flow evaluator gate execution policy mismatch");
  }
  if (
    definition.relative_cwd !== expectation.relativeCwd ||
    definition.executable !== host.xcodebuildPath ||
    !exactArray(definition.mutable_outputs, expectation.mutableOutputs) ||
    definition.required_test_paths.length !== 0 ||
    !exactArray(definition.required_mutation_paths, expectation.requiredMutationPaths) ||
    definition.implementation_context !== undefined ||
    definition.implementation_guidance !== undefined
  ) {
    throw new Error("full-flow evaluator gate scope metadata mismatch");
  }
  assertNoDuplicateOrForbiddenFlags(definition.argv);
  const argv = constructFullFlowEvaluatorArgv(expectation, host);
  if (!exactArray(definition.argv, argv)) {
    throw new Error("full-flow evaluator argv mismatch");
  }
  const projectIndex = definition.argv.indexOf("-project");
  const schemeIndex = definition.argv.indexOf("-scheme");
  if (
    definition.argv[projectIndex + 1] !== expectation.project ||
    definition.argv[schemeIndex + 1] !== expectation.scheme
  ) {
    throw new Error("full-flow evaluator project or scheme mismatch");
  }
  assertTrustedInputs(definition, expectation);
  return definition;
}
