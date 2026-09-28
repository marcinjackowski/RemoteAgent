import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { canonicalDigest } from "@remoteagent/contracts";
import { describe, expect, it } from "vitest";

import {
  VerificationGateAggregate,
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
  VerificationGateDeriveAggregate,
  VerificationGateOutcome,
  VerificationGateReceipt,
  VerificationGateStatus,
  VerificationGateTarget,
  assertTrustedEvaluatorReceiptEvidence,
  validateTrustedEvaluatorInputs,
  testEvidence,
  verificationGateReceiptId,
  type VerificationGateAggregateInput,
} from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

const uiHarnessFiles = [
  {
    relative_path: "Tests/RemoteAgentUIHarness/App/RemoteAgentUIHarnessApp.swift",
    content: "import SwiftUI\n",
  },
  {
    relative_path: "Tests/RemoteAgentUIHarness/UITests/RemoteAgentUIHarnessUITests.swift",
    content: "import XCTest\n",
  },
  {
    relative_path: "Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.pbxproj",
    content: "// project\n",
  },
  {
    relative_path:
      "Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/xcshareddata/xcschemes/RemoteAgentUIHarness.xcscheme",
    content: "<Scheme/>\n",
  },
].map((file) => ({
  ...file,
  content_digest: `sha256:${createHash("sha256").update(file.content).digest("hex")}`,
}));
const uiHarnessPackageResolved = {
  relative_path:
    "Tests/RemoteAgentUIHarness/RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
  content: '{"pins":[]}' + "\n",
  content_digest: `sha256:${createHash("sha256")
    .update('{"pins":[]}' + "\n")
    .digest("hex")}`,
};
const uiTestIds = [
  "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testGeneralHelp",
  "RemoteAgentUIHarnessUITests/RemoteAgentUIHarnessUITests/testActivitySharing",
];

async function fixture() {
  const executable = await realpath(process.execPath);
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "unit.test-first",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: ["--test", "literal;touch /tmp/not-a-shell"],
    relative_cwd: "packages/test-evidence",
    required: true,
    baseline: true,
    test_first: true,
    timeout_ms: 30_000,
    environment_profile: "HERMETIC",
    network_profile: "DENY",
    mutable_outputs: ["coverage"],
    implementation_guidance:
      "Change the existing settings view and its focused tests; do not create disconnected constants.",
    implementation_context: [
      { kind: "READ", relative_path: "src/settings.ts" },
      { kind: "SEARCH", relative_path: "src/strings.ts", query: "privacy-policy" },
    ],
  });
  const catalog = await VerificationGateCatalog.create({
    definitions: [definition],
    executable_allowlist: [executable],
  });
  const receipt = (
    target: "BASELINE" | "CURRENT",
    outcome: "PASSED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "INFRASTRUCTURE" | "AMBIGUOUS",
  ) =>
    VerificationGateReceipt.parse({
      schema_version: 1,
      receipt_id: `receipt-${target.toLowerCase()}`,
      case_id: "case-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      operation_id: target === VerificationGateTarget.BASELINE ? "op-baseline" : "op-current",
      gate_id: definition.gate_id,
      target,
      tree_digest: target === VerificationGateTarget.BASELINE ? digest("a") : digest("b"),
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(definition.gate_id),
      outcome,
      exit_code:
        outcome === VerificationGateOutcome.PASSED
          ? 0
          : outcome === VerificationGateOutcome.FAILED
            ? 1
            : null,
      duration_ms: 12,
      signal: null,
      log_artifact: {
        artifact_id: `log-${target.toLowerCase()}`,
        scope: { case_id: "case-1", workspace_id: "workspace-1" },
        relative_path: `case-1/workspace-1/log-${target.toLowerCase()}.log`,
        digest: digest("c"),
        byte_length: 0,
        complete: true,
        original_byte_length: 0,
      },
      log_digest: digest("c"),
    });
  const input = (receipts: ReturnType<typeof receipt>[]): VerificationGateAggregateInput => ({
    catalog,
    receipts,
    case_id: "case-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    current_tree_digest: digest("b"),
    baseline_tree_digest: digest("a"),
    operation_bindings: [
      { gate_id: definition.gate_id, target: "BASELINE", operation_id: "op-baseline" },
      { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-current" },
    ],
  });
  return { catalog, definition, receipt, input };
}

describe("VerificationGate contracts and catalog", () => {
  it("accepts up to 16 correction mutation paths and rejects 17", async () => {
    const executable = await realpath(process.execPath);
    const paths = Array.from({ length: 16 }, (_, index) => `Sources/Repair${index}.swift`).sort();
    const base = {
      schema_version: 1,
      gate_id: "bounded-correction-authority",
      gate_class: VerificationGateClass.TEST,
      executable,
      argv: ["--test"],
      relative_cwd: "packages/test-evidence",
      required: true,
      baseline: false,
      test_first: false,
      timeout_ms: 30_000,
      environment_profile: "HERMETIC",
      network_profile: "DENY",
      mutable_outputs: [],
      required_mutation_paths: paths,
    } as const;
    const definition = VerificationGateDefinition.parse(base);
    const catalog = await VerificationGateCatalog.create({
      definitions: [definition],
      executable_allowlist: [executable],
    });
    expect(catalog.get(base.gate_id)?.required_mutation_paths).toHaveLength(16);
    expect(() =>
      VerificationGateDefinition.parse({
        ...base,
        required_mutation_paths: [...paths, "Sources/Repair16.swift"],
      }),
    ).toThrow();
  });

  it("binds the UI harness layout to one exact project and scheme", async () => {
    const executable = await realpath(process.execPath);
    const trusted = {
      files: [...uiHarnessFiles, uiHarnessPackageResolved],
      required_executed_test_ids: uiTestIds,
      layout: "XCODE_UI_HARNESS_V1" as const,
    };
    const base = {
      schema_version: 1,
      gate_id: "ui-harness",
      gate_class: VerificationGateClass.TEST,
      executable,
      argv: [
        "-project",
        "RemoteAgentUIHarness.xcodeproj",
        "-scheme",
        "RemoteAgentUIHarness",
        ...uiTestIds.map((id) => `-only-testing:${id}`),
        "test",
      ],
      relative_cwd: "Tests/RemoteAgentUIHarness",
      required: true,
      baseline: false,
      test_first: false,
      timeout_ms: 30_000,
      environment_profile: "BUILD_TOOLCHAIN",
      network_profile: "PLATFORM_MANAGED",
      mutable_outputs: [],
      trusted_evaluator_inputs: trusted,
    };
    const definition = VerificationGateDefinition.parse(base);
    expect(definition.trusted_evaluator_inputs?.layout).toBe("XCODE_UI_HARNESS_V1");
    const catalog = await VerificationGateCatalog.create({
      definitions: [definition],
      executable_allowlist: [executable],
    });
    expect(catalog.get("ui-harness")?.trusted_evaluator_inputs?.layout).toBe("XCODE_UI_HARNESS_V1");
    expect(
      catalog
        .get("ui-harness")
        ?.trusted_evaluator_inputs?.files.find(({ relative_path }) =>
          relative_path.endsWith(
            "RemoteAgentUIHarness.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
          ),
        )?.content,
    ).toBe(uiHarnessPackageResolved.content);
    for (const argv of [
      base.argv.filter((arg) => arg !== "-project"),
      [...base.argv, "-project", "RemoteAgentUIHarness.xcodeproj"],
      [...base.argv, "-workspace", "Other.xcworkspace"],
      [...base.argv, "-workspace=Other.xcworkspace"],
      base.argv.filter((arg) => arg !== "-scheme" && arg !== "RemoteAgentUIHarness"),
      base.argv.map((arg) => (arg === "RemoteAgentUIHarness" ? "Other" : arg)),
      base.argv.map((arg) =>
        arg === "RemoteAgentUIHarness.xcodeproj" ? "../RemoteAgentUIHarness.xcodeproj" : arg,
      ),
      base.argv.map((arg) =>
        arg === "RemoteAgentUIHarness.xcodeproj" ? "/tmp/RemoteAgentUIHarness.xcodeproj" : arg,
      ),
      base.argv.map((arg) =>
        arg === "RemoteAgentUIHarness.xcodeproj" ? "./RemoteAgentUIHarness.xcodeproj" : arg,
      ),
      base.argv.map((arg) =>
        arg === "-project" ? "-project=RemoteAgentUIHarness.xcodeproj" : arg,
      ),
      base.argv.map((arg) => (arg === "-scheme" ? "-scheme=RemoteAgentUIHarness" : arg)),
    ]) {
      expect(() => VerificationGateDefinition.parse({ ...base, argv })).toThrow(
        /XCODE_UI_HARNESS_V1/u,
      );
    }
  });

  it("preserves the legacy no-evaluator command identity and absent field", async () => {
    const { definition, catalog } = await fixture();
    expect(Object.hasOwn(catalog.get(definition.gate_id)!, "trusted_evaluator_inputs")).toBe(false);
    expect(catalog.commandDigest(definition.gate_id)).toBe(
      canonicalDigest({
        gate_tier: definition.gate_tier,
        gate_schedule: definition.gate_schedule,
        executable: definition.executable,
        argv: definition.argv,
        relative_cwd: definition.relative_cwd,
        timeout_ms: definition.timeout_ms,
        environment_profile: definition.environment_profile,
        network_profile: definition.network_profile,
        mutable_outputs: definition.mutable_outputs,
      }),
    );
  });
  it("rejects aggregate evaluator binding and identity tampering", async () => {
    const { definition, receipt, input } = await fixture();
    const content = "import XCTest\n";
    const overlay = VerificationGateDefinition.parse({
      ...definition,
      baseline: false,
      test_first: false,
      environment_profile: "BUILD_TOOLCHAIN",
      network_profile: "PLATFORM_MANAGED",
      argv: ["-only-testing:T/S/test"],
      trusted_evaluator_inputs: {
        files: [
          {
            relative_path: "Tests/Probe.swift",
            content,
            content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          },
        ],
        required_executed_test_ids: ["T/S/test"],
      },
    });
    const catalog = await VerificationGateCatalog.create({
      definitions: [overlay],
      executable_allowlist: [overlay.executable],
    });
    const { schema_version: _version, receipt_id: _id, ...base } = receipt("CURRENT", "PASSED");
    void _version;
    void _id;
    const fields = {
      ...base,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(overlay.gate_id),
      trusted_evaluator_binding: {
        evaluator_inputs_digest: validateTrustedEvaluatorInputs(overlay.trusted_evaluator_inputs!)
          .digest,
        evaluated_tree_digest: digest("d"),
      },
      test_evidence: testEvidence.parse({
        kind: "XCODE_TEST_RESULT_V1",
        tool: "xcresulttool",
        schema_version: "0.1.0",
        executed_test_ids: ["T/S/test"],
        executed_count: 1,
        failed_test_ids: [],
        expected_suite_ids: ["T/S"],
        observed_suite_ids: ["T/S"],
        result_digest: digest("e"),
      }),
    };
    const valid = VerificationGateReceipt.parse({
      schema_version: 1,
      ...fields,
      receipt_id: verificationGateReceiptId(fields),
    });
    const derive = (value: typeof valid) =>
      VerificationGateDeriveAggregate({
        ...input([value]),
        catalog,
        operation_bindings: [
          { gate_id: overlay.gate_id, target: "CURRENT", operation_id: "op-current" },
        ],
      });
    expect(() => derive(valid)).not.toThrow();
    expect(() =>
      derive({
        ...valid,
        trusted_evaluator_binding: {
          ...fields.trusted_evaluator_binding,
          evaluated_tree_digest: digest("f"),
        },
      }),
    ).toThrow(/identity/u);
    for (const changed of [
      { ...fields, trusted_evaluator_binding: undefined },
      {
        ...fields,
        trusted_evaluator_binding: {
          ...fields.trusted_evaluator_binding,
          evaluator_inputs_digest: digest("f"),
        },
      },
      {
        ...fields,
        test_evidence: testEvidence.parse({
          ...fields.test_evidence,
          executed_test_ids: ["T/S/other"],
        }),
      },
    ]) {
      const tampered = VerificationGateReceipt.parse({
        schema_version: 1,
        ...changed,
        receipt_id: verificationGateReceiptId(changed),
      });
      expect(() => derive(tampered)).toThrow(/trusted evaluator/u);
    }
  });
  it("checks evaluator binding and exact selected-test evidence", async () => {
    const { definition } = await fixture();
    const content = "probe\n";
    const digestValue = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const overlay = VerificationGateDefinition.parse({
      ...definition,
      gate_class: VerificationGateClass.TEST,
      environment_profile: "BUILD_TOOLCHAIN",
      network_profile: "PLATFORM_MANAGED",
      argv: [...definition.argv, "-only-testing:T/S/test()"],
      trusted_evaluator_inputs: {
        files: [{ relative_path: "Tests/Probe.swift", content, content_digest: digestValue }],
        required_executed_test_ids: ["T/S/test()"],
      },
    });
    const evaluatorDigest = validateTrustedEvaluatorInputs(
      overlay.trusted_evaluator_inputs!,
    ).digest;
    const binding = {
      evaluator_inputs_digest: evaluatorDigest,
      evaluated_tree_digest: digest("b"),
    };
    const evidence = testEvidence.parse({
      kind: "XCODE_TEST_RESULT_V1",
      tool: "xcresulttool",
      schema_version: "0.1.0",
      executed_test_ids: ["T/S/test"],
      executed_count: 1,
      failed_test_ids: [],
      expected_suite_ids: ["T/S"],
      observed_suite_ids: ["T/S"],
      result_digest: digest("e"),
    });
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "PASSED",
        test_evidence: evidence,
        trusted_evaluator_binding: binding,
      }),
    ).not.toThrow();
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "PASSED",
        trusted_evaluator_binding: binding,
        test_evidence: testEvidence.parse({ ...evidence, executed_test_ids: ["S/test()"] }),
      }),
    ).not.toThrow();
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "INFRASTRUCTURE",
        test_evidence: evidence,
      }),
    ).toThrow(/unbound/u);
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "PASSED",
        trusted_evaluator_binding: binding,
        test_evidence: testEvidence.parse({ ...evidence, executed_test_ids: ["Other/S/test"] }),
      }),
    ).toThrow(/target/u);
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "FAILED",
        test_evidence: undefined,
        trusted_evaluator_binding: binding,
      }),
    ).not.toThrow();
    for (const outcome of ["INFRASTRUCTURE", "CANCELLED", "TIMED_OUT"] as const)
      expect(() =>
        assertTrustedEvaluatorReceiptEvidence(overlay, {
          outcome,
          test_evidence: undefined,
          trusted_evaluator_binding: undefined,
        }),
      ).not.toThrow();
    for (const receipt of [
      { outcome: "PASSED" as const, test_evidence: evidence, trusted_evaluator_binding: undefined },
      { outcome: "FAILED" as const, test_evidence: evidence, trusted_evaluator_binding: undefined },
      {
        outcome: "PASSED" as const,
        test_evidence: evidence,
        trusted_evaluator_binding: { ...binding, evaluator_inputs_digest: digest("d") },
      },
      {
        outcome: "PASSED" as const,
        test_evidence: evidence,
        trusted_evaluator_binding: { ...binding, evaluated_tree_digest: "bad" },
      },
    ])
      expect(() => assertTrustedEvaluatorReceiptEvidence(overlay, receipt)).toThrow();
    const missing = testEvidence.parse({ ...evidence, executed_test_ids: ["T/S/other"] });
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "PASSED",
        test_evidence: missing,
        trusted_evaluator_binding: binding,
      }),
    ).toThrow();
    const ambiguous = testEvidence.parse({
      ...evidence,
      expected_suite_ids: ["Other/S", "T/S"],
      observed_suite_ids: ["Other/S", "T/S"],
      executed_test_ids: ["S/test"],
      executed_count: 1,
    });
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(overlay, {
        outcome: "PASSED",
        test_evidence: ambiguous,
        trusted_evaluator_binding: binding,
      }),
    ).toThrow();
    expect(() =>
      assertTrustedEvaluatorReceiptEvidence(definition, {
        outcome: "PASSED",
        test_evidence: undefined,
        trusted_evaluator_binding: binding,
      }),
    ).toThrow();
  });
  it("canonicalizes trusted evaluator gate inputs and binds their identity", async () => {
    const { definition } = await fixture();
    const content = "import XCTest\n";
    const evaluator = {
      files: [{ relative_path: "Tests/Probe.swift", content, content_digest: digest("0") }],
      required_executed_test_ids: ["T/S/test()"],
    };
    const correct = {
      ...evaluator,
      files: [
        {
          ...evaluator.files[0],
          content_digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
        },
      ],
    };
    const overlay = VerificationGateDefinition.parse({
      ...definition,
      gate_class: VerificationGateClass.TEST,
      environment_profile: "BUILD_TOOLCHAIN",
      network_profile: "PLATFORM_MANAGED",
      argv: [...definition.argv, "-only-testing:T/S/test()"],
      trusted_evaluator_inputs: correct,
    });
    expect(overlay.trusted_evaluator_inputs?.required_executed_test_ids).toEqual(["T/S/test"]);
    expect(() =>
      VerificationGateDefinition.parse({ ...overlay, trusted_evaluator_inputs: evaluator }),
    ).toThrow();
    expect(() =>
      VerificationGateDefinition.parse({
        ...overlay,
        trusted_evaluator_inputs: { ...correct, required_executed_test_ids: ["T/S/other"] },
      }),
    ).toThrow();
    expect(() =>
      VerificationGateDefinition.parse({ ...overlay, network_profile: "DENY" }),
    ).toThrow();
    for (const conflict of [
      { mutable_outputs: ["Tests/Probe.swift/out"] },
      { required_mutation_paths: ["Tests"] },
      { required_test_paths: ["Tests/Probe.swift"] },
    ])
      expect(() => VerificationGateDefinition.parse({ ...overlay, ...conflict })).toThrow(
        /intersect/u,
      );
  });

  it("changes command identity when evaluator content or selected IDs change", async () => {
    const { definition } = await fixture();
    const content = "probe\n";
    const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const make = (value: string, id: string) =>
      VerificationGateDefinition.parse({
        ...definition,
        gate_class: VerificationGateClass.TEST,
        environment_profile: "BUILD_TOOLCHAIN",
        network_profile: "PLATFORM_MANAGED",
        argv: [...definition.argv, `-only-testing:T/S/${id}`],
        trusted_evaluator_inputs: {
          files: [
            {
              relative_path: "Tests/Probe.swift",
              content: value,
              content_digest:
                value === content
                  ? contentDigest
                  : `sha256:${createHash("sha256").update(value).digest("hex")}`,
            },
          ],
          required_executed_test_ids: [`T/S/${id}`],
        },
      });
    const catalogA = await VerificationGateCatalog.create({
      definitions: [make(content, "test")],
      executable_allowlist: [definition.executable],
    });
    const catalogB = await VerificationGateCatalog.create({
      definitions: [make("other\n", "test")],
      executable_allowlist: [definition.executable],
    });
    expect(catalogA.commandDigest("unit.test-first")).not.toBe(
      catalogB.commandDigest("unit.test-first"),
    );
    // Keep argv identical: otherwise selector argv alone would mask a missing input binding.
    const bothSelectors = ["-only-testing:T/S/test", "-only-testing:T/S/other"];
    const selectedCatalogs = await Promise.all(
      ["test", "other"].map((id) =>
        VerificationGateCatalog.create({
          definitions: [{ ...make(content, id), argv: bothSelectors }],
          executable_allowlist: [definition.executable],
        }),
      ),
    );
    expect(selectedCatalogs[0]!.commandDigest(definition.gate_id)).not.toBe(
      selectedCatalogs[1]!.commandDigest(definition.gate_id),
    );
  });

  it("rejects durable receipts whose outcome contradicts test evidence", async () => {
    const { receipt } = await fixture();
    const evidence = {
      kind: "XCODE_TEST_RESULT_V1" as const,
      tool: "xcresulttool" as const,
      schema_version: "0.1.0" as const,
      executed_test_ids: ["Suite/test"],
      executed_count: 1,
      failed_test_ids: ["Suite/test"],
      expected_suite_ids: ["Suite"],
      observed_suite_ids: ["Suite"],
      result_digest: digest("e"),
    };
    expect(() =>
      VerificationGateReceipt.parse({ ...receipt("CURRENT", "PASSED"), test_evidence: evidence }),
    ).toThrow(/failed tests/u);
    expect(() =>
      VerificationGateReceipt.parse({
        ...receipt("CURRENT", "FAILED"),
        test_evidence: { ...evidence, failed_test_ids: [] },
      }),
    ).toThrow(/failed test/u);
  });
  it("binds durable receipt identity to optional test evidence", async () => {
    const { catalog, receipt } = await fixture();
    const base = receipt("CURRENT", "PASSED");
    const evidence = testEvidence.parse({
      kind: "XCODE_TEST_RESULT_V1",
      tool: "xcresulttool",
      schema_version: "0.1.0",
      executed_test_ids: ["Suite/test"],
      executed_count: 1,
      failed_test_ids: [],
      expected_suite_ids: ["Suite"],
      observed_suite_ids: ["Suite"],
      result_digest: digest("e"),
    });
    const fields = {
      ...base,
      test_evidence: evidence,
    };
    const withoutIdentity = { ...fields };
    delete (withoutIdentity as { schema_version?: unknown }).schema_version;
    delete (withoutIdentity as { receipt_id?: unknown }).receipt_id;
    const withEvidenceId = verificationGateReceiptId(withoutIdentity);
    const withoutEvidence = { ...withoutIdentity };
    delete (withoutEvidence as { test_evidence?: unknown }).test_evidence;
    expect(withEvidenceId).not.toBe(verificationGateReceiptId(withoutEvidence));
    expect(VerificationGateReceipt.parse(base)).toBeTruthy();
    expect(catalog.config_digest).toMatch(/^sha256:/u);
  });
  it("uses strict versioned schemas and requires test-first gates to be required baseline gates", async () => {
    const { definition, receipt } = await fixture();
    expect(() => VerificationGateDefinition.parse({ ...definition, injected: true })).toThrow();
    expect(() =>
      VerificationGateDefinition.parse({
        ...definition,
        implementation_context: [
          { kind: "READ", relative_path: "src/settings.ts" },
          { kind: "READ", relative_path: "src/settings.ts" },
        ],
      }),
    ).toThrow(/unique/u);
    expect(() =>
      VerificationGateReceipt.parse({ ...receipt("CURRENT", "PASSED"), verdict: "PASSED" }),
    ).toThrow();
    expect(() => VerificationGateAggregate.parse({ schema_version: 1 })).toThrow();
    expect(() => VerificationGateDefinition.parse({ ...definition, required: false })).toThrow(
      /test-first/u,
    );
    expect(() => VerificationGateDefinition.parse({ ...definition, baseline: false })).toThrow(
      /test-first/u,
    );
    expect(() =>
      VerificationGateDefinition.parse({ ...definition, gate_class: "MODEL_INVENTED" }),
    ).toThrow();
    expect(definition.argv).toEqual(["--test", "literal;touch /tmp/not-a-shell"]);
    expect(definition.implementation_guidance).toMatch(/settings view/u);
    expect(definition.implementation_context).toHaveLength(2);
  });

  it("requires an exact scoped durable log and consistent process facts", async () => {
    const { receipt } = await fixture();
    const passed = receipt("CURRENT", "PASSED");
    expect(() =>
      VerificationGateReceipt.parse({ ...passed, log_artifact: null, log_digest: null }),
    ).toThrow(/log/u);
    expect(() =>
      VerificationGateReceipt.parse({
        ...receipt("CURRENT", "FAILED"),
        log_artifact: null,
        log_digest: null,
      }),
    ).toThrow(/INFRASTRUCTURE/u);
    expect(() => VerificationGateReceipt.parse({ ...passed, log_digest: digest("d") })).toThrow(
      /digest/u,
    );
    expect(() =>
      VerificationGateReceipt.parse({
        ...passed,
        log_artifact: {
          ...passed.log_artifact,
          scope: { case_id: "case-1", workspace_id: "workspace-foreign" },
        },
      }),
    ).toThrow(/workspace/u);
    expect(() => VerificationGateReceipt.parse({ ...passed, signal: "SIGKILL" })).toThrow(
      /signal/u,
    );
    expect(() => VerificationGateReceipt.parse({ ...passed, signal: "NOT_A_SIGNAL" })).toThrow();
    expect(
      VerificationGateReceipt.parse({
        ...passed,
        outcome: VerificationGateOutcome.INFRASTRUCTURE,
        exit_code: 0,
      }).exit_code,
    ).toBe(0);
    expect(() =>
      VerificationGateReceipt.parse({
        ...passed,
        outcome: VerificationGateOutcome.TIMED_OUT,
        exit_code: 0,
      }),
    ).toThrow(/exit code/u);
  });

  it("recomputes a canonical order-independent digest and rejects duplicate IDs", async () => {
    const { catalog, definition } = await fixture();
    expect(catalog.config_digest).toBe(
      canonicalDigest({
        definitions: [definition],
        executable_allowlist: [definition.executable],
      }),
    );
    await expect(
      VerificationGateCatalog.create({
        definitions: [definition, definition],
        executable_allowlist: [definition.executable],
      }),
    ).rejects.toThrow(/unique/u);
  });

  it("bounds the code-owned catalog at 128 gates", async () => {
    const { definition } = await fixture();
    const definitions = Array.from({ length: 128 }, (_, index) => ({
      ...definition,
      gate_id: `bounded.gate-${index}`,
      argv: [...definition.argv],
      mutable_outputs: [...definition.mutable_outputs],
    }));
    await expect(
      VerificationGateCatalog.create({
        definitions,
        executable_allowlist: [definition.executable],
      }),
    ).resolves.toBeInstanceOf(VerificationGateCatalog);
    await expect(
      VerificationGateCatalog.create({
        definitions: [
          ...definitions,
          {
            ...definition,
            gate_id: "bounded.gate-128",
            argv: [...definition.argv],
            mutable_outputs: [...definition.mutable_outputs],
          },
        ],
        executable_allowlist: [definition.executable],
      }),
    ).rejects.toThrow(/128/u);
  });

  it("deep-snapshots definitions and keeps exposed command configuration immutable", async () => {
    const { catalog, definition } = await fixture();
    const before = catalog.commandDigest(definition.gate_id);
    definition.argv.push("caller-mutation");
    definition.mutable_outputs.push("caller-output");
    expect(catalog.commandDigest(definition.gate_id)).toBe(before);
    expect(catalog.definitions[0]?.argv).not.toContain("caller-mutation");
    expect(() => (catalog.definitions[0]?.argv as string[]).push("exposed-mutation")).toThrow();
    expect(() =>
      (catalog.definitions[0]?.mutable_outputs as string[]).push("exposed-output"),
    ).toThrow();
    expect(catalog.commandDigest(definition.gate_id)).toBe(before);
  });

  it("rejects relative, non-canonical and non-allowlisted executables", async () => {
    const { definition } = await fixture();
    await expect(
      VerificationGateCatalog.create({ definitions: [definition], executable_allowlist: ["node"] }),
    ).rejects.toThrow(/absolute/u);
    await expect(
      VerificationGateCatalog.create({
        definitions: [{ ...definition, executable: "/bin/sh" }],
        executable_allowlist: [definition.executable],
      }),
    ).rejects.toThrow(/allowlisted/u);
  });
});

describe("VerificationGateDeriveAggregate", () => {
  it("passes test-first only for baseline FAILED and current PASSED", async () => {
    const { receipt, input } = await fixture();
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "FAILED"), receipt("CURRENT", "PASSED")]),
      ).status,
    ).toBe(VerificationGateStatus.PASSED);
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "PASSED"), receipt("CURRENT", "PASSED")]),
      ).status,
    ).toBe(VerificationGateStatus.FAILED);
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "FAILED"), receipt("CURRENT", "FAILED")]),
      ).status,
    ).toBe(VerificationGateStatus.FAILED);
    expect(
      VerificationGateDeriveAggregate(
        input([receipt("BASELINE", "AMBIGUOUS"), receipt("CURRENT", "PASSED")]),
      ).status,
    ).toBe(VerificationGateStatus.INCONCLUSIVE);
  });

  it("rejects empty, missing and duplicate receipt sets", async () => {
    const { receipt, input } = await fixture();
    expect(() => VerificationGateDeriveAggregate(input([]))).toThrow(/zero/u);
    expect(() => VerificationGateDeriveAggregate(input([receipt("CURRENT", "PASSED")]))).toThrow(
      /baseline/u,
    );
    const current = receipt("CURRENT", "PASSED");
    expect(() => VerificationGateDeriveAggregate(input([current, current]))).toThrow(/duplicate/u);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...input([receipt("BASELINE", "FAILED"), current]),
        receipts: [{ ...receipt("BASELINE", "FAILED"), receipt_id: current.receipt_id }, current],
      }),
    ).toThrow(/receipt_id/u);
  });

  it.each([
    ["tree_digest", digest("d"), /tree/u],
    ["config_digest", digest("d"), /config/u],
    ["command_digest", digest("d"), /command/u],
    ["operation_id", "op-foreign", /operation/u],
  ] as const)("rejects a foreign %s binding", async (field, value, message) => {
    const { receipt, input } = await fixture();
    const baseline = receipt("BASELINE", "FAILED");
    const current = { ...receipt("CURRENT", "PASSED"), [field]: value };
    expect(() => VerificationGateDeriveAggregate(input([baseline, current]))).toThrow(message);
  });

  it("rejects foreign gates, cases, workspaces and runs", async () => {
    const { receipt, input } = await fixture();
    const baseline = receipt("BASELINE", "FAILED");
    for (const patch of [
      { gate_id: "foreign" },
      { case_id: "foreign" },
      { workspace_id: "foreign" },
      { run_id: "foreign" },
    ]) {
      expect(() =>
        VerificationGateDeriveAggregate(
          input([baseline, { ...receipt("CURRENT", "PASSED"), ...patch }]),
        ),
      ).toThrow();
    }
  });

  it("binds each gate and target to its own operation", async () => {
    const { catalog: firstCatalog, definition, receipt } = await fixture();
    const second = VerificationGateDefinition.parse({
      ...definition,
      gate_id: "lint.required",
      gate_class: VerificationGateClass.LINT,
      argv: ["--lint"],
      baseline: false,
      test_first: false,
    });
    const catalog = await VerificationGateCatalog.create({
      definitions: [definition, second],
      executable_allowlist: [...firstCatalog.executable_allowlist],
    });
    const baseline = { ...receipt("BASELINE", "FAILED"), config_digest: catalog.config_digest };
    const current = { ...receipt("CURRENT", "PASSED"), config_digest: catalog.config_digest };
    const lint = VerificationGateReceipt.parse({
      ...current,
      receipt_id: "receipt-lint",
      gate_id: second.gate_id,
      operation_id: "op-lint-current",
      command_digest: catalog.commandDigest(second.gate_id),
    });
    baseline.command_digest = catalog.commandDigest(definition.gate_id);
    current.command_digest = catalog.commandDigest(definition.gate_id);
    const aggregate = VerificationGateDeriveAggregate({
      catalog,
      receipts: [baseline, current, lint],
      case_id: "case-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      current_tree_digest: digest("b"),
      baseline_tree_digest: digest("a"),
      operation_bindings: [
        { gate_id: definition.gate_id, target: "BASELINE", operation_id: "op-baseline" },
        { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-current" },
        { gate_id: second.gate_id, target: "CURRENT", operation_id: "op-lint-current" },
      ],
    });
    expect(aggregate.status).toBe(VerificationGateStatus.PASSED);
    expect(() =>
      VerificationGateDeriveAggregate({
        catalog,
        receipts: [baseline, current, lint],
        case_id: "case-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        current_tree_digest: digest("b"),
        baseline_tree_digest: digest("a"),
        operation_bindings: [
          { gate_id: definition.gate_id, target: "BASELINE", operation_id: "op-baseline" },
          { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-current" },
          { gate_id: second.gate_id, target: "CURRENT", operation_id: "op-wrong" },
        ],
      }),
    ).toThrow(/operation/u);
  });

  it("rejects duplicate operations, non-baseline targets and non-exact binding sets", async () => {
    const { catalog: firstCatalog, definition, receipt, input } = await fixture();
    const receipts = [receipt("BASELINE", "FAILED"), receipt("CURRENT", "PASSED")];
    const expected = input(receipts);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...expected,
        operation_bindings: expected.operation_bindings.map((binding) => ({
          ...binding,
          operation_id: "op-same",
        })),
      }),
    ).toThrow(/distinct/u);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...expected,
        operation_bindings: expected.operation_bindings.slice(0, 1),
      }),
    ).toThrow(/exactly/u);
    expect(() =>
      VerificationGateDeriveAggregate({
        ...expected,
        operation_bindings: [
          ...expected.operation_bindings,
          { gate_id: definition.gate_id, target: "CURRENT", operation_id: "op-extra" },
        ],
      }),
    ).toThrow(/duplicate/u);

    const currentOnly = VerificationGateDefinition.parse({
      ...definition,
      gate_id: "current-only",
      baseline: false,
      test_first: false,
    });
    const catalog = await VerificationGateCatalog.create({
      definitions: [currentOnly],
      executable_allowlist: [...firstCatalog.executable_allowlist],
    });
    const invalidBaseline = {
      ...receipt("BASELINE", "FAILED"),
      gate_id: currentOnly.gate_id,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(currentOnly.gate_id),
    };
    expect(() =>
      VerificationGateDeriveAggregate({
        catalog,
        receipts: [invalidBaseline],
        case_id: "case-1",
        workspace_id: "workspace-1",
        run_id: "run-1",
        current_tree_digest: digest("b"),
        baseline_tree_digest: digest("a"),
        operation_bindings: [
          { gate_id: currentOnly.gate_id, target: "BASELINE", operation_id: "op-baseline" },
        ],
      }),
    ).toThrow(/baseline|foreign/u);
  });
});
