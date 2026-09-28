import { createHash } from "node:crypto";

import {
  TRUSTED_EVALUATOR_UI_LAYOUT,
  validateTrustedEvaluatorInputs,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { describe, expect, it } from "vitest";

import {
  constructFullFlowEvaluatorArgv,
  FULL_FLOW_EVALUATOR_EXPECTATIONS,
  validateFullFlowEvaluatorDefinition,
  type FullFlowEvaluatorExpectation,
} from "./engineering-live-full-flow-evaluators.js";

const host = {
  xcodebuildPath: "/usr/bin/true",
  destination: "platform=iOS Simulator,id=fixture",
} as const;

function inputFile(relative_path: string, content: string) {
  return {
    relative_path,
    content,
    content_digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
  };
}

function makeInputs(layout: typeof TRUSTED_EVALUATOR_UI_LAYOUT | undefined) {
  if (layout === TRUSTED_EVALUATOR_UI_LAYOUT) {
    const root = "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness";
    return {
      files: [
        inputFile(`${root}/App/RemoteAgentUIHarnessApp.swift`, "import SwiftUI\n"),
        inputFile(`${root}/UITests/RemoteAgentUIHarnessUITests.swift`, "import XCTest\n"),
        inputFile(`${root}/RemoteAgentUIHarness.xcodeproj/project.pbxproj`, "// pbx\n"),
        inputFile(
          `${root}/RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme`,
          "<Scheme/>\n",
        ),
      ],
      required_executed_test_ids: [
        "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testSafety",
      ],
      layout,
    } as const;
  }
  return {
    files: [
      inputFile(
        "SonderClient/SonderClientLibrary/Tests/SharedTests/Probe.swift",
        "import XCTest\n",
      ),
    ],
    required_executed_test_ids: ["SharedTests/Probe/testSafety"],
  } as const;
}

function makeExpectation(layout: typeof TRUSTED_EVALUATOR_UI_LAYOUT | undefined) {
  const inputs = makeInputs(layout);
  const snapshot = validateTrustedEvaluatorInputs(inputs);
  const ui = layout === TRUSTED_EVALUATOR_UI_LAYOUT;
  const qualifiedArgv = [
    "-project",
    ui ? "RemoteAgentUIHarness.xcodeproj" : "SonderClient.xcodeproj",
    "-scheme",
    ui ? "RemoteAgentUIHarness" : "SonderClient-Beta",
    "-destination",
    "platform=iOS Simulator,id=qualified",
    "-derivedDataPath",
    ".remoteagent-xcode/DerivedData",
    "-clonedSourcePackagesDirPath",
    ".remoteagent-xcode/SourcePackages",
    "-resultBundlePath",
    ".remoteagent-xcode/Qualified.xcresult",
    ...snapshot.required_executed_test_ids.map((id) => `-only-testing:${id}`),
    "test",
  ];
  return {
    profile: ui ? "ui" : "combined",
    gateId: ui ? "synthetic-ui" : "synthetic-combined",
    executionOrder: ui ? 110 : 100,
    qualifiedArgv,
    relativeCwd: ui
      ? "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness"
      : "SonderClient",
    project: ui ? "RemoteAgentUIHarness.xcodeproj" : "SonderClient.xcodeproj",
    scheme: ui ? "RemoteAgentUIHarness" : "SonderClient-Beta",
    mutableOutputs: [
      ui
        ? "SonderClient/SonderClientLibrary/Tests/RemoteAgentUIHarness/.remoteagent-xcode"
        : "SonderClient/.remoteagent-xcode",
    ],
    inputDigest: snapshot.digest,
    inputPaths: snapshot.files.map((file) => file.relative_path),
    requiredTestIds: snapshot.required_executed_test_ids,
    requiredMutationPaths: ["SharedLibrary/Sources/Chat/ChatViewController.swift"],
    ...(layout === undefined ? {} : { layout }),
  } satisfies FullFlowEvaluatorExpectation;
}

function makeDefinition(
  expectation: FullFlowEvaluatorExpectation,
  overrides: Record<string, unknown> = {},
) {
  const inputs = makeInputs(expectation.layout);
  return VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: expectation.gateId,
    gate_class: "TEST",
    gate_tier: "FULL",
    gate_schedule: "LAST_SLICE",
    execution_order: expectation.executionOrder,
    executable: host.xcodebuildPath,
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
    trusted_evaluator_inputs: inputs,
    ...overrides,
  });
}

describe("full-flow evaluator definition validator", () => {
  it.each([undefined, TRUSTED_EVALUATOR_UI_LAYOUT] as const)(
    "accepts qualified %s definition",
    (layout) => {
      const expectation = makeExpectation(layout);
      const definition = makeDefinition(expectation);
      expect(validateFullFlowEvaluatorDefinition({ definition, expectation, host })).toBe(
        definition,
      );
    },
  );

  it("constructs the qualified argv with only the trusted destination substituted", () => {
    const expectation = makeExpectation(undefined);
    const argv = constructFullFlowEvaluatorArgv(expectation, host);
    expect(argv).toContain("platform=iOS Simulator,id=fixture");
    expect(argv).not.toContain("platform=iOS Simulator,id=qualified");
  });

  it("pins qualified selector order independently from sorted trusted IDs", () => {
    expect(
      FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.qualifiedArgv.filter((arg) =>
        arg.startsWith("-only-testing:"),
      ),
    ).toEqual([
      "-only-testing:SharedTests/RA055SafetyFlowModelTests/testChatViewModel_whenSendingBlocked_doesNotSend",
      "-only-testing:SharedTests/RA055SafetyFlowModelTests/testChatViewModel_whenFocusBlockedOnly_sendsExactText",
      "-only-testing:SharedTests/RA055SafetyFlowStateTests/testSingleFlow_unblockedAlertBlocksSendAndCloseRestoresAndSends",
      "-only-testing:SharedTests/RA055SafetyFlowStateTests/testSingleFlow_initiallyBlockedAlertCloseRestoresBlockedAndPreventsSend",
      "-only-testing:SharedTests/RA055SafetyFlowStateTests/testMultiFlow_unblockedAlertBlocksSendAndCloseRestores",
      "-only-testing:SharedTests/RA055SafetyFlowStateTests/testMultiFlow_initiallyBlockedAlertCloseRestoresBlocked",
      "-only-testing:SharedTests/RA055SafetyFlowVoiceTests/testSingleVoiceEmergencyDisconnectsStartedRoom",
      "-only-testing:SharedTests/RA055SafetyFlowVoiceTests/testMultiVoiceEmergencyDisconnectsStartedRoom",
      "-only-testing:SharedTests/RA055SafetyAlertEvaluatorTests/testGeneralHelpCopyAndActions",
      "-only-testing:SharedTests/RA055SafetyAlertEvaluatorTests/testActivitySharingCopyAndDistinctConstruction",
      "-only-testing:SharedTests/RA055SafetyAlertEvaluatorTests/testActivitySharingActions",
    ]);
    expect(
      FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.qualifiedArgv.filter((arg) =>
        arg.startsWith("-only-testing:"),
      ),
    ).toEqual([
      "-only-testing:RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testSingleAgentGeneralHelpFlow",
      "-only-testing:RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testSingleAgentActivitySharingFlow",
      "-only-testing:RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testMultiAgentGeneralHelpFlow",
      "-only-testing:RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testMultiAgentActivitySharingFlow",
    ]);
  });

  it.each([
    ["gate tier", { gate_tier: "FAST" }],
    ["schedule", { gate_schedule: "EACH_SLICE" }],
    ["required", { required: false }],
    ["baseline", { baseline: true }],
    ["required test path", { required_test_paths: ["Tests/Other.swift"] }],
    ["required mutation path", { required_mutation_paths: ["Sources/Other.swift"] }],
    ["mutable output", { mutable_outputs: ["SonderClient/.other-output"] }],
    ["execution order", { execution_order: 101 }],
    ["guidance", { implementation_guidance: "inherited" }],
    ["context", { implementation_context: [{ kind: "READ", relative_path: "Tests/Other.swift" }] }],
    ["timeout", { timeout_ms: 1_199_999 }],
    ["platform policy", { network_profile: "DENY" }],
  ] as const)("rejects metadata mutation: %s", (_name, override) => {
    const expectation = makeExpectation(undefined);
    expect(() =>
      validateFullFlowEvaluatorDefinition({
        definition: makeDefinition(expectation, override),
        expectation,
        host,
      }),
    ).toThrow();
  });

  it.each([
    ["duplicate project", (argv: string[]) => argv.splice(2, 0, "-project")],
    ["quiet", (argv: string[]) => argv.splice(0, 0, "-quiet")],
    ["equals alias", (argv: string[]) => argv.splice(0, 2, "-project=SonderClient.xcodeproj")],
    ["extra argument", (argv: string[]) => argv.splice(argv.length - 1, 0, "-extra")],
  ] as const)("rejects argv mutation: %s", (_name, mutate) => {
    const expectation = makeExpectation(undefined);
    const argv = [...constructFullFlowEvaluatorArgv(expectation, host)];
    mutate(argv);
    expect(() =>
      validateFullFlowEvaluatorDefinition({
        definition: makeDefinition(expectation, { argv }),
        expectation,
        host,
      }),
    ).toThrow();
  });

  it("rejects a rehashed trusted input whose digest is not the qualified identity", () => {
    const expectation = makeExpectation(undefined);
    const altered = makeInputs(undefined);
    const inputs = {
      ...altered,
      files: [inputFile(altered.files[0]!.relative_path, "import XCTest\n// altered\n")],
    };
    expect(() =>
      validateFullFlowEvaluatorDefinition({
        definition: makeDefinition(expectation, { trusted_evaluator_inputs: inputs }),
        expectation,
        host,
      }),
    ).toThrow(/input digest/u);
  });

  it.each([
    ["empty", []],
    [
      "duplicate",
      [
        "SharedLibrary/Sources/Chat/ChatViewController.swift",
        "SharedLibrary/Sources/Chat/ChatViewController.swift",
      ],
    ],
    [
      "extra",
      [
        "SharedLibrary/Sources/Chat/ChatViewController.swift",
        "SharedLibrary/Sources/Chat/ChatViewModel.swift",
      ],
    ],
  ] as const)("rejects %s repair candidate paths", (_name, required_mutation_paths) => {
    const expectation = makeExpectation(undefined);
    expect(() =>
      validateFullFlowEvaluatorDefinition({
        definition: makeDefinition(expectation, { required_mutation_paths }),
        expectation,
        host,
      }),
    ).toThrow();
  });

  it("fails closed when the qualified expectation itself has no repair authority", () => {
    const qualified = makeExpectation(undefined);
    const expectation = { ...qualified, requiredMutationPaths: [] };
    expect(() =>
      validateFullFlowEvaluatorDefinition({
        definition: makeDefinition(expectation),
        expectation,
        host,
      }),
    ).toThrow(/non-empty/u);
  });

  it("rejects missing, wrong-layout, and wrong-ID UI inputs", () => {
    const expectation = makeExpectation(TRUSTED_EVALUATOR_UI_LAYOUT);
    const inputs = makeInputs(TRUSTED_EVALUATOR_UI_LAYOUT);
    for (const mutation of [
      { ...inputs, files: inputs.files.slice(0, -1) },
      { ...inputs, layout: undefined },
      {
        ...inputs,
        required_executed_test_ids: ["OtherUITests/OtherUITests/testSafety"],
      },
    ]) {
      expect(() =>
        validateFullFlowEvaluatorDefinition({
          definition: makeDefinition(expectation, { trusted_evaluator_inputs: mutation }),
          expectation,
          host,
        }),
      ).toThrow();
    }
  });

  it("rejects a definition executable different from the trusted Xcode path", () => {
    const expectation = makeExpectation(undefined);
    const definition = makeDefinition(expectation, { executable: "/usr/bin/false" });
    expect(() => validateFullFlowEvaluatorDefinition({ definition, expectation, host })).toThrow(
      /scope metadata/u,
    );
  });

  it("keeps the qualified production registry deeply immutable and exact", () => {
    const combined = FULL_FLOW_EVALUATOR_EXPECTATIONS.combined;
    expect(Object.isFrozen(FULL_FLOW_EVALUATOR_EXPECTATIONS)).toBe(true);
    expect(Object.isFrozen(combined)).toBe(true);
    expect(Object.isFrozen(combined.qualifiedArgv)).toBe(true);
    expect(Reflect.set(combined as object, "gateId", "tampered")).toBe(false);
    expect(Reflect.set(combined.qualifiedArgv as object, "0", "tampered")).toBe(false);
    expect(combined.gateId).toBe("ios-full-flow-model-tests-final");
    expect(combined.qualifiedArgv[0]).toBe("-project");
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.inputDigest).toBe(
      "sha256:c924afc57be92787c633a379efc57ebe5fe0860c41b9953051a0e3a9f1f4c606",
    );
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.requiredTestIds).toHaveLength(11);
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.requiredMutationPaths).toHaveLength(11);
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.requiredMutationPaths).not.toContain(
      "SonderClient/SonderClientLibrary/Sources/Shared/Resources/Assets+Generated.swift",
    );
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.combined.requiredMutationPaths).toEqual(
      FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.requiredMutationPaths,
    );
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.inputDigest).toBe(
      "sha256:b10e21fdb5f9a3f5763c704aec38f8b7e157ee89247c12ee40f5187455efb78d",
    );
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.requiredTestIds).toHaveLength(4);
    expect(FULL_FLOW_EVALUATOR_EXPECTATIONS.ui.inputPaths).toHaveLength(5);
  });
});
