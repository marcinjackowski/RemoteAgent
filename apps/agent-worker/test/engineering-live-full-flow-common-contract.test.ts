import { canonicalDigest } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  FULL_FLOW_COMMON_CONTRACT_POLICY,
  assertFullFlowCommonContract,
  type FullFlowCommonContractInput,
  type FullFlowCommonContractPolicy,
} from "./engineering-live-full-flow-common-contract.js";
import { FULL_FLOW_SOURCE_PRECHECK_SCRIPT } from "./engineering-live-full-flow-precheck.js";

const policy: FullFlowCommonContractPolicy = {
  assetGateId: "asset",
  sourcePrecheckGateId: "precheck",
  changelogGateId: "changelog",
  generatorId: "generator",
  writePathAllowlist: ["Sources/AgentAI.swift"],
  assetSchedule: "EACH_SLICE",
  assetExecutionOrder: 10,
  sourcePrecheckSchedule: "LAST_SLICE",
  sourcePrecheckExecutionOrder: 25,
  sourcePrecheckCandidatePaths: [
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlert.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/AgentAI/SafetyAlertPresentation.swift",
    "SonderClient/SonderClientLibrary/Sources/Shared/Resources/en.lproj/Localizable.strings",
  ],
  changelogSchedule: "LAST_SLICE",
  changelogExecutionOrder: 45,
  assetArgvDigest: canonicalDigest(["asset-script"]),
  sourcePrecheckArgv: ["--input-type=module", "-e", "FULL_FLOW_SOURCE_PRECHECK_SCRIPT"],
  changelogArgvDigest: canonicalDigest(["changelog-script"]),
  generatorArgvDigest: canonicalDigest(["swiftgen", "run"]),
  generatorTriggerPaths: ["Sources/Shared/AgentAI"],
  generatorOutputPaths: ["Sources/Shared/Resources/Assets+Generated.swift"],
  generatorCwd: "Sources/Shared",
  generatorTimeoutMs: 30_000,
  testPathAllowlist: ["Tests/AgentAI.swift", "Tests/Flow.swift"],
  lastSliceContextCap: 19,
};

const gate = (id: string, argv: readonly string[], extra: Record<string, unknown> = {}) => ({
  gate_id: id,
  gate_class: "TEST",
  gate_tier: "FAST",
  gate_schedule: id === "asset" ? "EACH_SLICE" : "LAST_SLICE",
  execution_order: id === "asset" ? 10 : id === "precheck" ? 25 : 45,
  executable: "/usr/bin/node",
  relative_cwd: "SonderClient",
  required: true,
  baseline: false,
  test_first: false,
  timeout_ms: 30_000,
  environment_profile: "HERMETIC",
  network_profile: "DENY",
  mutable_outputs: [],
  required_mutation_paths: [],
  required_test_paths: [],
  argv,
  ...extra,
});

function fixture(): FullFlowCommonContractInput {
  const definitions = [
    gate("asset", ["asset-script"]),
    gate("precheck", policy.sourcePrecheckArgv, {
      required_mutation_paths: policy.sourcePrecheckCandidatePaths,
    }),
    gate("changelog", ["changelog-script"], {
      required_mutation_paths: ["SonderClient/TestFlight/WhatToTest.en-US.txt"],
    }),
  ];
  return {
    policy,
    catalog: { definitions, get: (id) => definitions.find((entry) => entry.gate_id === id) },
    generatorCatalog: {
      definitions: [
        {
          generator_id: "generator",
          trigger_paths: ["Sources/Shared/AgentAI"],
          output_paths: ["Sources/Shared/Resources/Assets+Generated.swift"],
          command: {
            executable: "/usr/local/bin/swiftgen",
            args: ["swiftgen", "run"],
            cwd: "Sources/Shared",
            timeoutMs: 30_000,
          },
        },
      ],
    },
    testPathAllowlist: policy.testPathAllowlist,
    writePathAllowlist: policy.writePathAllowlist,
    nodeExecutable: "/usr/bin/node",
    swiftgenExecutable: "/usr/local/bin/swiftgen",
    lastSliceContextLength: 19,
  };
}

describe("full-flow common profile contract", () => {
  it("accepts the pinned current-only gates, generator, authority, and context cap", () => {
    expect(() => assertFullFlowCommonContract(fixture())).not.toThrow();
  });

  it.each([
    ["empty", []],
    ["missing", policy.sourcePrecheckCandidatePaths.slice(1)],
    ["foreign", [...policy.sourcePrecheckCandidatePaths, "Sources/Foreign.swift"]],
    ["generator", [...policy.sourcePrecheckCandidatePaths, policy.generatorOutputPaths[0]!]],
    ["model-test", [...policy.sourcePrecheckCandidatePaths, policy.testPathAllowlist[0]!]],
    [
      "duplicate",
      [...policy.sourcePrecheckCandidatePaths, policy.sourcePrecheckCandidatePaths[0]!],
    ],
    [
      "extra",
      [...policy.sourcePrecheckCandidatePaths, "SonderClient/TestFlight/WhatToTest.en-US.txt"],
    ],
    ["reordered", [...policy.sourcePrecheckCandidatePaths].reverse()],
  ] as const)("rejects source-precheck candidate set %s", (_name, paths) => {
    const input = fixture();
    const definitions = input.catalog.definitions.map((definition) =>
      definition.gate_id === "precheck"
        ? { ...definition, required_mutation_paths: paths }
        : definition,
    );
    expect(() =>
      assertFullFlowCommonContract({
        ...input,
        catalog: { definitions, get: (id) => definitions.find((entry) => entry.gate_id === id) },
      }),
    ).toThrow(/full-flow common gate contract mismatch: precheck/u);
  });

  it.each([
    [
      "missing asset",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) => (id === "asset" ? undefined : input.catalog.get(id)),
        },
      }),
    ],
    [
      "optional precheck",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) => (id === "precheck" ? undefined : input.catalog.get(id)),
        },
      }),
    ],
    [
      "wrong schedule",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "precheck"
              ? { ...input.catalog.get(id)!, gate_schedule: "EACH_SLICE" }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "not required",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "precheck"
              ? { ...input.catalog.get(id)!, required: false }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "asset order drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "asset"
              ? { ...input.catalog.get(id)!, execution_order: 11 }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "precheck order drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "precheck"
              ? { ...input.catalog.get(id)!, execution_order: 26 }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "changelog order drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "changelog"
              ? { ...input.catalog.get(id)!, execution_order: 46 }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "extra outputs",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "asset"
              ? { ...input.catalog.get(id)!, mutable_outputs: [".build"] }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "extra generator",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        generatorCatalog: {
          definitions: [
            ...input.generatorCatalog.definitions,
            ...input.generatorCatalog.definitions,
          ],
        },
      }),
    ],
    [
      "source script drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        catalog: {
          ...input.catalog,
          get: (id: string) =>
            id === "precheck"
              ? { ...input.catalog.get(id)!, argv: ["--input-type=module", "-e", "other"] }
              : input.catalog.get(id),
        },
      }),
    ],
    [
      "tool mismatch",
      (input: FullFlowCommonContractInput) => ({ ...input, nodeExecutable: "/other/node" }),
    ],
    [
      "generator args drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        generatorCatalog: {
          definitions: [
            {
              ...input.generatorCatalog.definitions[0]!,
              command: { ...input.generatorCatalog.definitions[0]!.command, args: ["other"] },
            },
          ],
        },
      }),
    ],
    [
      "generator output drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        generatorCatalog: {
          definitions: [
            { ...input.generatorCatalog.definitions[0]!, output_paths: ["other.swift"] },
          ],
        },
      }),
    ],
    [
      "allowlist drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        testPathAllowlist: ["Tests/Other.swift"],
      }),
    ],
    [
      "write allowlist drift",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        writePathAllowlist: ["Sources/Other.swift"],
      }),
    ],
    [
      "write allowlist broad prefix",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        writePathAllowlist: ["Sources/Shared/AgentAI"],
      }),
    ],
    [
      "write allowlist extra path",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        writePathAllowlist: [...input.writePathAllowlist, "Sources/Extra.swift"],
      }),
    ],
    [
      "write allowlist missing path",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        writePathAllowlist: input.writePathAllowlist.slice(0, -1),
      }),
    ],
    [
      "generator trigger narrowing",
      (input: FullFlowCommonContractInput) => ({
        ...input,
        generatorCatalog: {
          definitions: [
            {
              ...input.generatorCatalog.definitions[0]!,
              trigger_paths: ["Sources/Other.swift"],
            },
          ],
        },
      }),
    ],
    [
      "context budget",
      (input: FullFlowCommonContractInput) => ({ ...input, lastSliceContextLength: 20 }),
    ],
    [
      "negative context budget",
      (input: FullFlowCommonContractInput) => ({ ...input, lastSliceContextLength: -1 }),
    ],
    [
      "noninteger context budget",
      (input: FullFlowCommonContractInput) => ({ ...input, lastSliceContextLength: 1.5 }),
    ],
    [
      "nonfinite context budget",
      (input: FullFlowCommonContractInput) => ({ ...input, lastSliceContextLength: Number.NaN }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(() => assertFullFlowCommonContract(mutate(fixture()))).toThrow();
  });

  it("pins the real source-precheck script and freezes default policy arrays", () => {
    expect(FULL_FLOW_COMMON_CONTRACT_POLICY.sourcePrecheckArgv[2]).toBe(
      FULL_FLOW_SOURCE_PRECHECK_SCRIPT,
    );
    expect(Object.isFrozen(FULL_FLOW_COMMON_CONTRACT_POLICY)).toBe(true);
    expect(Object.isFrozen(FULL_FLOW_COMMON_CONTRACT_POLICY.sourcePrecheckArgv)).toBe(true);
    expect(Object.isFrozen(FULL_FLOW_COMMON_CONTRACT_POLICY.sourcePrecheckCandidatePaths)).toBe(
      true,
    );
    expect(Object.isFrozen(FULL_FLOW_COMMON_CONTRACT_POLICY.testPathAllowlist)).toBe(true);
    expect(Object.isFrozen(FULL_FLOW_COMMON_CONTRACT_POLICY.writePathAllowlist)).toBe(true);
    expect(() => {
      (FULL_FLOW_COMMON_CONTRACT_POLICY.testPathAllowlist as string[])[0] = "drift";
    }).toThrow();
  });
});
