import {
  engineeringImplementationContext,
  type EngineeringExecutionConfig,
} from "../src/engineering-execution.js";
import type { EngineeringBenchmarkManifestV1 } from "../src/engineering-live-qualification.js";
import type { VerificationGateDefinition } from "@remoteagent/test-evidence";
import {
  FULL_FLOW_COMMON_CONTRACT_POLICY,
  assertFullFlowCommonContract,
} from "./engineering-live-full-flow-common-contract.js";
import {
  FULL_FLOW_EVALUATOR_EXPECTATIONS,
  validateFullFlowEvaluatorDefinition,
} from "./engineering-live-full-flow-evaluators.js";
import { assertLegacyMobl2023GateContract } from "./engineering-live-legacy-contract.js";
import { selectMobl2023LiveProfile } from "./engineering-live-profile.js";

export const FULL_FLOW_GATE_IDS = Object.freeze([
  FULL_FLOW_COMMON_CONTRACT_POLICY.assetGateId,
  FULL_FLOW_COMMON_CONTRACT_POLICY.sourcePrecheckGateId,
  FULL_FLOW_COMMON_CONTRACT_POLICY.changelogGateId,
  FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.gateId,
  FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.gateId,
] as const);

export const TEXT_FLOW_GATE_IDS = Object.freeze([
  FULL_FLOW_COMMON_CONTRACT_POLICY.assetGateId,
  FULL_FLOW_COMMON_CONTRACT_POLICY.sourcePrecheckGateId,
  FULL_FLOW_COMMON_CONTRACT_POLICY.changelogGateId,
  FULL_FLOW_EVALUATOR_EXPECTATIONS.text.gateId,
  FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.gateId,
] as const);

type ProfileManifest = Pick<
  EngineeringBenchmarkManifestV1,
  "benchmark_id" | "projection_versions" | "slices" | "criteria" | "xcode"
>;

export type Mobl2023LiveProfileContract = Readonly<{
  profile: "legacy" | "full-flow-v1" | "full-flow-text-v1";
  positiveSourceProbe: VerificationGateDefinition;
  negativeSourceProbe: VerificationGateDefinition;
}>;

export type Mobl2023LiveProfileContractInput = Readonly<{
  manifest: ProfileManifest;
  executionConfig: EngineeringExecutionConfig;
  nodeExecutable: string;
  swiftgenExecutable: string;
  xcodebuildPath: string;
}>;

function assertFullFlowManifest(
  input: Mobl2023LiveProfileContractInput,
  textProfile: boolean,
): Mobl2023LiveProfileContract {
  const { manifest, executionConfig: config } = input;
  if (manifest.slices.length !== 1) throw new Error("full-flow profile requires exactly one slice");
  const slice = manifest.slices[0]!;
  const expectedGateIds = new Set(textProfile ? TEXT_FLOW_GATE_IDS : FULL_FLOW_GATE_IDS);
  const actualGateIds = new Set(
    manifest.criteria.flatMap((criterion) => criterion.required_gate_ids),
  );
  if (
    actualGateIds.size !== expectedGateIds.size ||
    [...expectedGateIds].some((gateId) => !actualGateIds.has(gateId))
  )
    throw new Error("full-flow profile gate set is not exact");
  for (const criterion of manifest.criteria) {
    if (
      criterion.owning_slice_id !== slice.slice_id ||
      criterion.expected_outcomes.baseline !== "SKIP" ||
      criterion.expected_outcomes.current !== "PASS"
    )
      throw new Error("full-flow profile criterion outcome or ownership drift");
  }
  const catalogGateIds = new Set(
    config.catalog.definitions.map((definition) => definition.gate_id),
  );
  if (
    catalogGateIds.size !== expectedGateIds.size ||
    [...expectedGateIds].some((gateId) => !catalogGateIds.has(gateId))
  )
    throw new Error("full-flow profile catalog gate set is not exact");
  for (const gateId of expectedGateIds) {
    if (config.catalog.get(gateId) === undefined)
      throw new Error(`full-flow profile gate is missing: ${gateId}`);
  }
  if (config.generatorCatalog === undefined)
    throw new Error("full-flow profile generator catalog is required");
  const contextGateIds = config.catalog.definitions
    .filter(
      (definition) =>
        definition.required &&
        (definition.gate_schedule === "EACH_SLICE" || definition.gate_schedule === "LAST_SLICE"),
    )
    .map((definition) => definition.gate_id);
  const lastSliceContextLength = engineeringImplementationContext(
    config.catalog,
    contextGateIds,
  ).length;
  assertFullFlowCommonContract({
    catalog: config.catalog,
    generatorCatalog: config.generatorCatalog,
    testPathAllowlist: config.testPathAllowlist,
    writePathAllowlist: config.writePathAllowlist,
    nodeExecutable: input.nodeExecutable,
    swiftgenExecutable: input.swiftgenExecutable,
    lastSliceContextLength,
  });
  const modelExpectation = textProfile
    ? FULL_FLOW_EVALUATOR_EXPECTATIONS.text
    : FULL_FLOW_EVALUATOR_EXPECTATIONS.combined;
  validateFullFlowEvaluatorDefinition({
    definition: config.catalog.get(modelExpectation.gateId)!,
    expectation: modelExpectation,
    host: { xcodebuildPath: input.xcodebuildPath, destination: manifest.xcode.destination },
  });
  validateFullFlowEvaluatorDefinition({
    definition: config.catalog.get(FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.gateId)!,
    expectation: FULL_FLOW_EVALUATOR_EXPECTATIONS.ui,
    host: { xcodebuildPath: input.xcodebuildPath, destination: manifest.xcode.destination },
  });
  return Object.freeze({
    profile: textProfile ? "full-flow-text-v1" : "full-flow-v1",
    positiveSourceProbe: config.catalog.get(FULL_FLOW_COMMON_CONTRACT_POLICY.assetGateId)!,
    negativeSourceProbe: config.catalog.get(FULL_FLOW_COMMON_CONTRACT_POLICY.sourcePrecheckGateId)!,
  });
}

export function assertMobl2023LiveProfileContract(
  input: Mobl2023LiveProfileContractInput,
): Mobl2023LiveProfileContract {
  const profile = selectMobl2023LiveProfile(input.manifest);
  if (profile === "legacy") {
    const legacy = assertLegacyMobl2023GateContract(input.executionConfig);
    if (legacy.incrementalSafetyContract === undefined || legacy.finalSafetyContract === undefined)
      throw new Error("legacy profile source probes are missing");
    return Object.freeze({
      profile,
      positiveSourceProbe: legacy.incrementalSafetyContract,
      negativeSourceProbe: legacy.finalSafetyContract,
    });
  }
  return assertFullFlowManifest(input, profile === "full-flow-text-v1");
}

export function createAfterMobl2023LiveProfileContract<T>(
  input: Mobl2023LiveProfileContractInput,
  factory: (contract: Mobl2023LiveProfileContract) => T,
): Readonly<{ contract: Mobl2023LiveProfileContract; value: T }> {
  const contract = assertMobl2023LiveProfileContract(input);
  return Object.freeze({ contract, value: factory(contract) });
}
