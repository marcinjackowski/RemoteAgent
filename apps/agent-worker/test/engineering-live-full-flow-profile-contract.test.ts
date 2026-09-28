import { describe, expect, it } from "vitest";

import type { EngineeringExecutionConfig } from "../src/engineering-execution.js";
import {
  FULL_FLOW_GATE_IDS,
  TEXT_FLOW_GATE_IDS,
  assertMobl2023LiveProfileContract,
  createAfterMobl2023LiveProfileContract,
  type Mobl2023LiveProfileContractInput,
} from "./engineering-live-full-flow-profile-contract.js";

const baseManifest = {
  benchmark_id: "MOBL-2023-full-flow-v1",
  projection_versions: { evaluation: "full-flow-v1" },
  xcode: { destination: "platform=iOS Simulator" },
  slices: [{ slice_id: "slice" }],
  criteria: FULL_FLOW_GATE_IDS.map((gateId) => ({
    criterion_id: gateId,
    owning_slice_id: "slice",
    required_gate_ids: [gateId],
    expected_outcomes: { baseline: "SKIP", current: "PASS" },
  })),
} as Mobl2023LiveProfileContractInput["manifest"];

function input(overrides: Record<string, unknown> = {}, text = false) {
  const gateIds = text ? TEXT_FLOW_GATE_IDS : FULL_FLOW_GATE_IDS;
  const definitions = gateIds.map((gate_id) => ({
    gate_id,
    ...(gate_id === "mobl-2023-full-flow-source-precheck"
      ? {
          required_mutation_paths: [
            "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
            "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlertPresentation.swift",
            "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
          ],
        }
      : {}),
  }));
  const executionConfig = {
    catalog: {
      definitions,
      get: (id: string) => definitions.find((definition) => definition.gate_id === id),
    },
    generatorCatalog: { definitions: [] },
    testPathAllowlist: [],
    writePathAllowlist: [],
  } as unknown as EngineeringExecutionConfig;
  return {
    manifest: {
      ...baseManifest,
      ...(text
        ? {
            benchmark_id: "MOBL-2023-full-flow-text-v1",
            projection_versions: { evaluation: "full-flow-text-v1" },
            criteria: gateIds.map((criterion) => ({
              criterion_id: criterion,
              owning_slice_id: "slice",
              required_gate_ids: [criterion],
              expected_outcomes: { baseline: "SKIP", current: "PASS" },
            })),
          }
        : {}),
      ...overrides,
    } as Mobl2023LiveProfileContractInput["manifest"],
    executionConfig,
    nodeExecutable: "/usr/bin/node",
    swiftgenExecutable: "/usr/local/bin/swiftgen",
    xcodebuildPath: "/usr/bin/xcodebuild",
  };
}

describe("MOBL-2023 full-flow profile contract boundary", () => {
  it.each([
    ["unknown evaluation", { projection_versions: { evaluation: "unknown" } }, /unsupported/u],
    ["wrong benchmark ID", { benchmark_id: "legacy-id" }, /reserved/u],
    [
      "extra slice",
      { slices: [{ slice_id: "slice" }, { slice_id: "other" }] },
      /exactly one slice/u,
    ],
    ["missing criterion coverage", { criteria: baseManifest.criteria.slice(0, -1) }, /gate set/u],
    [
      "baseline claim",
      {
        criteria: baseManifest.criteria.map((criterion) => ({
          ...criterion,
          expected_outcomes: { baseline: "FAIL", current: "PASS" },
        })),
      },
      /criterion outcome/u,
    ],
  ])("rejects %s before factory", (_name, manifest, expectedError) => {
    let calls = 0;
    expect(() =>
      createAfterMobl2023LiveProfileContract(input(manifest), () => {
        calls += 1;
        return true;
      }),
    ).toThrow(expectedError);
    expect(calls).toBe(0);
  });

  it("rejects an extra catalog gate before factory", () => {
    const base = input();
    const definitions = [...base.executionConfig.catalog.definitions, { gate_id: "legacy-gate" }];
    const executionConfig = {
      ...base.executionConfig,
      catalog: {
        definitions,
        get: (id: string) => definitions.find((definition) => definition.gate_id === id),
      },
    } as unknown as EngineeringExecutionConfig;
    let calls = 0;
    expect(() =>
      createAfterMobl2023LiveProfileContract({ ...base, executionConfig }, () => {
        calls += 1;
        return true;
      }),
    ).toThrow(/catalog gate set/u);
    expect(calls).toBe(0);
  });

  it("freezes the runtime full-flow gate ID set", () => {
    expect(Object.isFrozen(FULL_FLOW_GATE_IDS)).toBe(true);
    expect(() => {
      (FULL_FLOW_GATE_IDS as unknown as string[])[0] = "drift";
    }).toThrow();
  });

  it("rejects a missing required catalog gate before factory", () => {
    const base = input();
    const missing = FULL_FLOW_GATE_IDS[1];
    const definitions = base.executionConfig.catalog.definitions.filter(
      (definition) => definition.gate_id !== missing,
    );
    const executionConfig = {
      ...base.executionConfig,
      catalog: {
        definitions,
        get: (id: string) => definitions.find((definition) => definition.gate_id === id),
      },
    } as unknown as EngineeringExecutionConfig;
    let calls = 0;
    expect(() => assertMobl2023LiveProfileContract({ ...base, executionConfig })).toThrow(
      /catalog gate set/u,
    );
    expect(() =>
      createAfterMobl2023LiveProfileContract({ ...base, executionConfig }, () => {
        calls += 1;
        return true;
      }),
    ).toThrow();
    expect(calls).toBe(0);
  });
});
