import { canonicalDigest } from "@remoteagent/contracts";
import { FULL_FLOW_SOURCE_PRECHECK_SCRIPT } from "./engineering-live-full-flow-precheck.js";

export const FULL_FLOW_COMMON_CONTRACT_POLICY = Object.freeze({
  assetGateId: "mobl-2023-help-asset-input",
  sourcePrecheckGateId: "mobl-2023-full-flow-source-precheck",
  changelogGateId: "mobl-2023-testflight-changelog",
  generatorId: "mobl-2023-shared-assets",
  writePathAllowlist: Object.freeze([
    "SharedLibrary/Sources/Chat/ChatViewController.swift",
    "SharedLibrary/Sources/Chat/ChatViewModel.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlow.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlowView.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatView.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatViewModel.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentSession.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlertPresentation.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/Resources/Assets+Generated.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentSessionTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/AgentAIStreamingEngineTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
    "SonderClient/TestFlight/WhatToTest.en-US.txt",
  ]),
  assetArgvDigest: "sha256:7762d01d703004e51204d2dd90239908d2b851ee3ab5bcddddda80ada8b329fb",
  assetSchedule: "EACH_SLICE",
  assetExecutionOrder: 10,
  sourcePrecheckSchedule: "LAST_SLICE",
  sourcePrecheckExecutionOrder: 25,
  sourcePrecheckCandidatePaths: Object.freeze([
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlertPresentation.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
  ]),
  changelogSchedule: "LAST_SLICE",
  changelogExecutionOrder: 45,
  sourcePrecheckArgv: Object.freeze([
    "--input-type=module",
    "-e",
    FULL_FLOW_SOURCE_PRECHECK_SCRIPT,
  ]),
  changelogArgvDigest: "sha256:a42265f36aa6bb116b37a33bcaa26be20624e4f155c9fdbe8a791bd76edfbfa8",
  generatorArgvDigest: "sha256:9115245134515f9b902b989366bc86e7832a0ef9d778c41c99b3d004952abbad",
  generatorTriggerPaths: Object.freeze([
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlow.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/AgentAIFlowView.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatView.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatViewModel.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/MultiAgent/AIMultiAgentSession.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlertPresentation.swift",
  ]),
  generatorOutputPaths: Object.freeze([
    "SonderClient/SonderClientLibrary/Sources/Shared/Resources/Assets+Generated.swift",
  ]),
  generatorCwd: "SonderClient/SonderClientLibrary/Sources/Shared",
  generatorTimeoutMs: 30_000,
  testPathAllowlist: Object.freeze([
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentChatViewModelTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AIMultiAgentSessionTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/AgentAIFlowTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/EmergencyResourcesRouterTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/AgentAI/SafetyAlertTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/AgentAIStreamingEngineTests.swift",
    "SonderClient/SonderClientLibrary/Tests/SharedTests/Chat/EmergencyResourcesTextFlowAdapterTests.swift",
  ]),
  lastSliceContextCap: 19,
} as const);

type GateLike = Readonly<{
  gate_id: string;
  gate_class: string;
  gate_tier: string;
  gate_schedule: string;
  execution_order: number;
  executable: string;
  relative_cwd: string;
  required: boolean;
  baseline: boolean;
  test_first: boolean;
  timeout_ms: number;
  environment_profile: string;
  network_profile: string;
  mutable_outputs: readonly string[];
  required_mutation_paths: readonly string[];
  required_test_paths: readonly string[];
  argv: readonly string[];
}>;

type GeneratorLike = Readonly<{
  generator_id: string;
  trigger_paths: readonly string[];
  output_paths: readonly string[];
  command: Readonly<{
    executable: string;
    args: readonly string[];
    cwd: string;
    timeoutMs: number;
  }>;
}>;

export type FullFlowCommonContractPolicy = Readonly<{
  assetGateId: string;
  sourcePrecheckGateId: string;
  changelogGateId: string;
  generatorId: string;
  writePathAllowlist: readonly string[];
  assetSchedule: string;
  assetExecutionOrder: number;
  sourcePrecheckSchedule: string;
  sourcePrecheckExecutionOrder: number;
  sourcePrecheckCandidatePaths: readonly string[];
  changelogSchedule: string;
  changelogExecutionOrder: number;
  assetArgvDigest: string;
  sourcePrecheckArgv: readonly string[];
  changelogArgvDigest: string;
  generatorArgvDigest: string;
  generatorTriggerPaths: readonly string[];
  generatorOutputPaths: readonly string[];
  generatorCwd: string;
  generatorTimeoutMs: number;
  testPathAllowlist: readonly string[];
  lastSliceContextCap: number;
}>;

export type FullFlowCommonContractInput = Readonly<{
  catalog: Readonly<{
    definitions: readonly GateLike[];
    get: (id: string) => GateLike | undefined;
  }>;
  generatorCatalog: Readonly<{ definitions: readonly GeneratorLike[] }>;
  testPathAllowlist: readonly string[];
  writePathAllowlist: readonly string[];
  nodeExecutable: string;
  swiftgenExecutable: string;
  lastSliceContextLength: number;
  policy?: FullFlowCommonContractPolicy;
}>;

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function assertFastCurrentGate(
  gate: GateLike | undefined,
  expected: string,
  expectedSchedule: string,
  expectedOrder: number,
  requiredMutationPaths: readonly string[] = [],
  requiredTestPaths: readonly string[] = [],
): asserts gate is GateLike {
  if (
    gate === undefined ||
    gate.gate_id !== expected ||
    gate.gate_class !== "TEST" ||
    gate.gate_tier !== "FAST" ||
    gate.gate_schedule !== expectedSchedule ||
    gate.execution_order !== expectedOrder ||
    gate.required !== true ||
    gate.baseline !== false ||
    gate.test_first !== false ||
    gate.relative_cwd !== "SonderClient" ||
    gate.timeout_ms !== 30_000 ||
    gate.environment_profile !== "HERMETIC" ||
    gate.network_profile !== "DENY" ||
    gate.mutable_outputs.length !== 0 ||
    !samePaths(gate.required_mutation_paths, requiredMutationPaths) ||
    !samePaths(gate.required_test_paths, requiredTestPaths)
  )
    throw new Error(`full-flow common gate contract mismatch: ${expected}`);
}

export function assertFullFlowCommonContract(input: FullFlowCommonContractInput): void {
  const policy = input.policy ?? FULL_FLOW_COMMON_CONTRACT_POLICY;
  const asset = input.catalog.get(policy.assetGateId);
  assertFastCurrentGate(
    asset,
    policy.assetGateId,
    policy.assetSchedule,
    policy.assetExecutionOrder,
  );
  if (
    asset.executable !== input.nodeExecutable ||
    canonicalDigest(asset.argv) !== policy.assetArgvDigest
  )
    throw new Error("full-flow asset gate executable or argv drift");

  const precheck = input.catalog.get(policy.sourcePrecheckGateId);
  assertFastCurrentGate(
    precheck,
    policy.sourcePrecheckGateId,
    policy.sourcePrecheckSchedule,
    policy.sourcePrecheckExecutionOrder,
    policy.sourcePrecheckCandidatePaths,
  );
  if (!samePaths(precheck.argv, policy.sourcePrecheckArgv))
    throw new Error("full-flow source precheck argv drift");
  if (precheck.executable !== input.nodeExecutable)
    throw new Error("full-flow source precheck executable drift");

  const changelog = input.catalog.get(policy.changelogGateId);
  assertFastCurrentGate(
    changelog,
    policy.changelogGateId,
    policy.changelogSchedule,
    policy.changelogExecutionOrder,
    ["SonderClient/TestFlight/WhatToTest.en-US.txt"],
  );
  if (
    changelog.executable !== input.nodeExecutable ||
    canonicalDigest(changelog.argv) !== policy.changelogArgvDigest
  )
    throw new Error("full-flow changelog gate contract mismatch");

  if (!samePaths(input.testPathAllowlist, policy.testPathAllowlist))
    throw new Error("full-flow test path authority drift");
  if (!samePaths(input.writePathAllowlist, policy.writePathAllowlist))
    throw new Error("full-flow write path authority drift");
  if (
    !Number.isSafeInteger(input.lastSliceContextLength) ||
    input.lastSliceContextLength < 0 ||
    input.lastSliceContextLength > policy.lastSliceContextCap
  )
    throw new Error("full-flow last-slice context exceeds bounded cap");

  if (input.generatorCatalog.definitions.length !== 1)
    throw new Error("full-flow shared-assets generator cardinality drift");
  const generator = input.generatorCatalog.definitions.find(
    (entry) => entry.generator_id === policy.generatorId,
  );
  if (
    generator === undefined ||
    !samePaths(generator.trigger_paths, policy.generatorTriggerPaths) ||
    !samePaths(generator.output_paths, policy.generatorOutputPaths) ||
    generator.command.executable !== input.swiftgenExecutable ||
    generator.command.cwd !== policy.generatorCwd ||
    generator.command.timeoutMs !== policy.generatorTimeoutMs ||
    canonicalDigest(generator.command.args) !== policy.generatorArgvDigest
  )
    throw new Error("full-flow shared-assets generator contract mismatch");
}
