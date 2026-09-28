import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { engineeringGateFailureV2 } from "@remoteagent/contracts";
import { VerificationGateCatalog, VerificationGateDefinition } from "@remoteagent/test-evidence";
import { describe, expect, it, vi } from "vitest";
import type { EngineeringExecutionConfig } from "../src/engineering-execution.js";
import {
  createEngineeringGateFailureMapping,
  engineeringGateFailureCorrectionAuthority,
} from "../src/engineering-execution.js";

// Only private fixture data is substituted; the real validators still run.
vi.mock("./engineering-live-full-flow-common-contract.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./engineering-live-full-flow-common-contract.js")>();
  const { canonicalDigest } = await import("@remoteagent/contracts");
  const policy = {
    ...original.FULL_FLOW_COMMON_CONTRACT_POLICY,
    assetArgvDigest: canonicalDigest(["asset"]),
    changelogArgvDigest: canonicalDigest(["changelog"]),
    generatorArgvDigest: canonicalDigest(["generator"]),
  };
  return {
    ...original,
    FULL_FLOW_COMMON_CONTRACT_POLICY: policy,
    assertFullFlowCommonContract: (
      input: Parameters<typeof original.assertFullFlowCommonContract>[0],
    ) => original.assertFullFlowCommonContract({ ...input, policy }),
  };
});

vi.mock("./engineering-live-full-flow-evaluators.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./engineering-live-full-flow-evaluators.js")>();
  const { createHash } = await import("node:crypto");
  const { validateTrustedEvaluatorInputs } = await import("@remoteagent/test-evidence");
  const content = "import XCTest\n";
  const syntheticExpectation = (
    expectation: import("./engineering-live-full-flow-evaluators.js").FullFlowEvaluatorExpectation,
  ) => ({
    ...expectation,
    inputDigest: validateTrustedEvaluatorInputs({
      files: expectation.inputPaths.map((relative_path) => ({
        relative_path,
        content,
        content_digest: "sha256:" + createHash("sha256").update(content).digest("hex"),
      })),
      required_executed_test_ids: [...expectation.requiredTestIds],
      ...(expectation.layout === undefined ? {} : { layout: expectation.layout }),
    }).digest,
  });
  return {
    ...original,
    FULL_FLOW_EVALUATOR_EXPECTATIONS: {
      combined: syntheticExpectation(original.FULL_FLOW_EVALUATOR_EXPECTATIONS.combined),
      text: syntheticExpectation(original.FULL_FLOW_EVALUATOR_EXPECTATIONS.text),
      ui: syntheticExpectation(original.FULL_FLOW_EVALUATOR_EXPECTATIONS.ui),
    },
  };
});

import { FULL_FLOW_COMMON_CONTRACT_POLICY as policy } from "./engineering-live-full-flow-common-contract.js";
import {
  FULL_FLOW_EVALUATOR_EXPECTATIONS as expectations,
  constructFullFlowEvaluatorArgv,
  type FullFlowEvaluatorExpectation,
} from "./engineering-live-full-flow-evaluators.js";
import {
  createAfterMobl2023LiveProfileContract,
  FULL_FLOW_GATE_IDS,
  TEXT_FLOW_GATE_IDS,
  type Mobl2023LiveProfileContractInput,
} from "./engineering-live-full-flow-profile-contract.js";

async function fixture(text = false) {
  const executable = await realpath(process.execPath);
  const host = { xcodebuildPath: executable, destination: "platform=iOS Simulator,id=fixture" };
  const content = "import XCTest\n";
  const gateIds = text ? TEXT_FLOW_GATE_IDS : FULL_FLOW_GATE_IDS;
  const fast = (
    id: string,
    argv: readonly string[],
    order: number,
    schedule: string,
    paths: readonly string[] = [],
  ) =>
    VerificationGateDefinition.parse({
      schema_version: 1,
      gate_id: id,
      gate_class: "TEST",
      gate_tier: "FAST",
      gate_schedule: schedule,
      execution_order: order,
      executable,
      argv,
      relative_cwd: "SonderClient",
      required: true,
      baseline: false,
      test_first: false,
      timeout_ms: 30_000,
      environment_profile: "HERMETIC",
      network_profile: "DENY",
      mutable_outputs: [],
      required_test_paths: [],
      required_mutation_paths: paths,
    });
  const evaluatorExpectations: readonly FullFlowEvaluatorExpectation[] = [
    text ? expectations.text : expectations.combined,
    expectations.ui,
  ];
  const definitions = [
    fast(policy.assetGateId, ["asset"], policy.assetExecutionOrder, policy.assetSchedule),
    fast(
      policy.sourcePrecheckGateId,
      policy.sourcePrecheckArgv,
      policy.sourcePrecheckExecutionOrder,
      policy.sourcePrecheckSchedule,
      policy.sourcePrecheckCandidatePaths,
    ),
    fast(
      policy.changelogGateId,
      ["changelog"],
      policy.changelogExecutionOrder,
      policy.changelogSchedule,
      ["SonderClient/TestFlight/WhatToTest.en-US.txt"],
    ),
    ...evaluatorExpectations.map((expectation) =>
      VerificationGateDefinition.parse({
        schema_version: 1,
        gate_id: expectation.gateId,
        gate_class: "TEST",
        gate_tier: "FULL",
        gate_schedule: "LAST_SLICE",
        execution_order: expectation.executionOrder,
        executable,
        argv: constructFullFlowEvaluatorArgv(expectation, host),
        relative_cwd: expectation.relativeCwd,
        required: true,
        baseline: false,
        test_first: false,
        timeout_ms: 1_200_000,
        environment_profile: "BUILD_TOOLCHAIN",
        network_profile: "PLATFORM_MANAGED",
        mutable_outputs: expectation.mutableOutputs,
        required_test_paths: [],
        required_mutation_paths: expectation.requiredMutationPaths,
        trusted_evaluator_inputs: {
          files: expectation.inputPaths.map((relative_path) => ({
            relative_path,
            content,
            content_digest: "sha256:" + createHash("sha256").update(content).digest("hex"),
          })),
          required_executed_test_ids: [...expectation.requiredTestIds],
          ...(expectation.layout === undefined ? {} : { layout: expectation.layout }),
        },
      }),
    ),
  ];
  const catalog = await VerificationGateCatalog.create({
    definitions,
    executable_allowlist: [executable],
  });
  const targets = policy.writePathAllowlist.map((path, index) => ({
    target_id: `target-${String(index)}`,
    kind: policy.testPathAllowlist.includes(path)
      ? ("TEST" as const)
      : policy.generatorOutputPaths.includes(path)
        ? ("GENERATOR" as const)
        : ("SOURCE" as const),
    paths: [path],
  }));
  // Real ownership validation catches TEST paths incorrectly encoded as SOURCE
  // correction candidates, which catalog shape validation alone cannot detect.
  const mapping = createEngineeringGateFailureMapping({
    catalog,
    targets,
    slices: [
      {
        slice_id: "slice",
        mutation_target_ids: targets.map((target) => target.target_id),
        required_read_context: [],
      },
    ],
    criteria: gateIds.map((id) => ({
      criterion_id: id,
      owning_slice_id: "slice",
      required_gate_ids: [id],
      related_target_ids: targets.map((target) => target.target_id),
    })),
  });
  const executionConfig = {
    catalog,
    testPathAllowlist: policy.testPathAllowlist,
    writePathAllowlist: policy.writePathAllowlist,
    generatorCatalog: {
      definitions: [
        {
          generator_id: policy.generatorId,
          trigger_paths: policy.generatorTriggerPaths,
          output_paths: policy.generatorOutputPaths,
          command: {
            executable,
            args: ["generator"],
            cwd: policy.generatorCwd,
            timeoutMs: policy.generatorTimeoutMs,
          },
        },
      ],
    },
  } as unknown as EngineeringExecutionConfig;
  const manifest = {
    benchmark_id: text ? "MOBL-2023-full-flow-text-v1" : "MOBL-2023-full-flow-v1",
    projection_versions: { evaluation: text ? "full-flow-text-v1" : "full-flow-v1" },
    xcode: { destination: host.destination },
    slices: [{ slice_id: "slice" }],
    criteria: gateIds.map((id) => ({
      criterion_id: id,
      owning_slice_id: "slice",
      required_gate_ids: [id],
      expected_outcomes: { baseline: "SKIP", current: "PASS" },
    })),
  } as Mobl2023LiveProfileContractInput["manifest"];
  return {
    manifest,
    executionConfig,
    mapping,
    nodeExecutable: executable,
    swiftgenExecutable: executable,
    xcodebuildPath: executable,
  };
}

describe("full-flow correction authority before model factory", () => {
  it("accepts the text profile with exactly nine model IDs/three inputs and four UI IDs/five inputs", async () => {
    const input = await fixture(true);
    const factory = vi.fn((contract) => contract.profile);
    expect(createAfterMobl2023LiveProfileContract(input, factory).value).toBe("full-flow-text-v1");
    expect(factory).toHaveBeenCalledTimes(1);
    for (const [expectation, ids, paths] of [
      [expectations.text, 9, 3],
      [expectations.ui, 4, 5],
    ] as const) {
      const gate = input.executionConfig.catalog.get(expectation.gateId)!;
      expect(gate.trusted_evaluator_inputs!.files).toHaveLength(paths);
      expect(gate.trusted_evaluator_inputs!.required_executed_test_ids).toHaveLength(ids);
      expect(gate.argv.filter((arg) => arg.startsWith("-only-testing:"))).toHaveLength(ids);
    }
  });

  it.each(["missing-selector", "missing-id", "missing-input", "foreign-scope"] as const)(
    "rejects text %s before factory, starting from an accepted catalog",
    async (kind) => {
      const input = await fixture(true);
      const control = vi.fn(() => "accepted");
      expect(createAfterMobl2023LiveProfileContract(input, control).value).toBe("accepted");
      expect(control).toHaveBeenCalledTimes(1);
      const definitions = input.executionConfig.catalog.definitions.map((gate) => {
        if (gate.gate_id !== expectations.text.gateId) return gate;
        const inputs = gate.trusted_evaluator_inputs!;
        if (kind === "missing-selector")
          return {
            ...gate,
            argv: gate.argv.filter(
              (arg) => arg !== `-only-testing:${expectations.text.requiredTestIds[0]!}`,
            ),
          };
        if (kind === "missing-id")
          return {
            ...gate,
            trusted_evaluator_inputs: {
              ...inputs,
              required_executed_test_ids: inputs.required_executed_test_ids.slice(1),
            },
          };
        if (kind === "missing-input")
          return { ...gate, trusted_evaluator_inputs: { ...inputs, files: inputs.files.slice(1) } };
        return {
          ...gate,
          required_mutation_paths: [...gate.required_mutation_paths, "Sources/Foreign.swift"],
        };
      });
      const factory = vi.fn();
      await expect(
        (async () => {
          const catalog = await VerificationGateCatalog.create({
            definitions,
            executable_allowlist: [input.nodeExecutable],
          });
          return createAfterMobl2023LiveProfileContract(
            { ...input, executionConfig: { ...input.executionConfig, catalog } },
            factory,
          );
        })(),
      ).rejects.toThrow(/exact testing selector|argv mismatch|input digest|repair candidate/u);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["MOBL-2023-full-flow-v1", "full-flow-text-v1"],
    ["MOBL-2023-full-flow-text-v1", "full-flow-v1"],
    ["MOBL-2023-full-flow-text-v1", "v1"],
  ])("rejects cross-profile identity %s/%s before factory", async (benchmark_id, evaluation) => {
    const input = await fixture(true);
    const control = vi.fn(() => "accepted");
    expect(createAfterMobl2023LiveProfileContract(input, control).value).toBe("accepted");
    expect(control).toHaveBeenCalledTimes(1);
    const factory = vi.fn();
    expect(() =>
      createAfterMobl2023LiveProfileContract(
        {
          ...input,
          manifest: {
            ...input.manifest,
            benchmark_id,
            projection_versions: { ...input.manifest.projection_versions, evaluation },
          },
        },
        factory,
      ),
    ).toThrow(/reserved/u);
    expect(factory).not.toHaveBeenCalled();
  });

  it("accepts a parsed 11-candidate catalog through all profile validators", async () => {
    const input = await fixture();
    const factory = vi.fn(() => "created");
    expect(createAfterMobl2023LiveProfileContract(input, factory).value).toBe("created");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(
      input.executionConfig.catalog.get(expectations.combined.gateId)?.required_mutation_paths,
    ).toHaveLength(11);
  });

  it("authorizes only the exact source-precheck candidates from a real mapped GateFailure", async () => {
    const input = await fixture();
    const failure = engineeringGateFailureV2.parse({
      schema_version: 2,
      artifact_kind: "GateFailure",
      case_id: "case-source-precheck",
      run_id: "run-source-precheck",
      revision: 1,
      authority: "SERVER_OWNED",
      slice_id: "slice",
      attempt: 1,
      tree_digest: "sha256:" + "1".repeat(64),
      diff_digest: "sha256:" + "2".repeat(64),
      context_digest: "sha256:" + "3".repeat(64),
      config_digest: "sha256:" + "4".repeat(64),
      mapping_digest: input.mapping.mapping_digest,
      blocking_gate_ids: [policy.sourcePrecheckGateId],
      receipt_ids: ["receipt-source-precheck"],
      decision_ids: [],
      diagnostics: [
        {
          gate_id: policy.sourcePrecheckGateId,
          outcome: "FAILED",
          log_digest: null,
          trust: "UNTRUSTED_DATA",
          excerpt: "source precheck failed",
        },
      ],
      observations: [
        {
          criterion_id: policy.sourcePrecheckGateId,
          gate_id: policy.sourcePrecheckGateId,
          failure_class: "ASSERTION_FAILED",
          evidence_ref: "receipt-source-precheck",
          related_target_ids: input.mapping.slices[0]!.mutation_target_ids,
        },
      ],
    });
    expect(
      engineeringGateFailureCorrectionAuthority(
        failure,
        input.mapping,
        input.executionConfig.catalog,
        "slice",
        policy.writePathAllowlist,
      ),
    ).toEqual({ status: "AUTHORIZED", paths: policy.sourcePrecheckCandidatePaths });
    const emptyCatalog = await VerificationGateCatalog.create({
      definitions: input.executionConfig.catalog.definitions.map((definition) =>
        definition.gate_id === policy.sourcePrecheckGateId
          ? { ...definition, required_mutation_paths: [] }
          : definition,
      ),
      executable_allowlist: [input.nodeExecutable],
    });
    expect(
      engineeringGateFailureCorrectionAuthority(
        failure,
        input.mapping,
        emptyCatalog,
        "slice",
        policy.writePathAllowlist,
      ),
    ).toEqual({ status: "UNCLASSIFIED_GATE_FAILURE", paths: [] });
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
  ] as const)("rejects source-precheck %s candidates before factory", async (_name, paths) => {
    const input = await fixture();
    const validFactory = vi.fn(() => "valid");
    expect(createAfterMobl2023LiveProfileContract(input, validFactory).value).toBe("valid");
    expect(validFactory).toHaveBeenCalledTimes(1);
    const definitions = input.executionConfig.catalog.definitions.map((definition) =>
      definition.gate_id === policy.sourcePrecheckGateId
        ? { ...definition, required_mutation_paths: [...paths] }
        : definition,
    );
    const invalidFactory = vi.fn();
    await expect(
      (async () => {
        const catalog = await VerificationGateCatalog.create({
          definitions,
          executable_allowlist: [input.nodeExecutable],
        });
        return createAfterMobl2023LiveProfileContract(
          { ...input, executionConfig: { ...input.executionConfig, catalog } },
          invalidFactory,
        );
      })(),
    ).rejects.toThrow();
    expect(invalidFactory).not.toHaveBeenCalled();
  });

  const cases = (["combined", "ui"] as const).flatMap((profile) =>
    (
      ["empty", "missing", "duplicate", "generator", "foreign", "protected", "model-test"] as const
    ).map((kind) => ({ profile, kind })),
  );
  it.each(cases)("rejects $profile $kind candidates before factory", async ({ profile, kind }) => {
    const input = await fixture();
    const candidates = [...expectations[profile].requiredMutationPaths];
    const paths =
      kind === "empty"
        ? []
        : kind === "missing"
          ? candidates.slice(1)
          : [
              ...candidates,
              kind === "duplicate"
                ? candidates[0]!
                : kind === "generator"
                  ? policy.generatorOutputPaths[0]!
                  : kind === "model-test"
                    ? policy.testPathAllowlist[0]!
                    : kind === "protected"
                      ? expectations[profile].inputPaths[0]!
                      : "Sources/Foreign.swift",
            ];
    const expectedError =
      kind === "duplicate"
        ? /required mutation paths must be unique/u
        : kind === "protected"
          ? /evaluator inputs must not intersect/u
          : /repair candidate|scope metadata/u;
    const factory = vi.fn();
    await expect(
      (async () => {
        const catalog = await VerificationGateCatalog.create({
          definitions: input.executionConfig.catalog.definitions.map((definition) =>
            definition.gate_id === expectations[profile].gateId
              ? { ...definition, required_mutation_paths: paths }
              : definition,
          ),
          executable_allowlist: [input.nodeExecutable],
        });
        return createAfterMobl2023LiveProfileContract(
          { ...input, executionConfig: { ...input.executionConfig, catalog } },
          factory,
        );
      })(),
    ).rejects.toThrow(expectedError);
    expect(factory).not.toHaveBeenCalled();
  });
});
