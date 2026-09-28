import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import {
  LocalArtifactStore,
  testRunReceiptDigest,
  VerificationGateClass,
  VerificationGateDefinition,
  VerificationGateValidateTestRun,
} from "@remoteagent/test-evidence";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterEach, expect, it, vi } from "vitest";

import {
  createXcodeVerificationGatePlatformAdapter,
  isXcodeDiskExhaustion,
  parseXcodeTestEvidence,
  parseXcodeCompilerDiagnostics,
  parseXcodeTestDiagnostics,
  shouldRetryUninformativeXcodeTest,
  xcodeDestinationFromGateCatalog,
  xcodeExpectedSuiteIds,
  xcodeExpectedTestIds,
  validateXcodeTestGateResultBundlePath,
} from "../src/xcode-gate-adapter.js";

const roots: string[] = [];
const XCODE_RESULT = JSON.stringify({
  testPlanConfigurations: [],
  devices: [],
  testNodes: [
    {
      nodeType: "Test Suite",
      nodeIdentifier: "SharedTests/SafetyAlertTests",
      children: [
        {
          nodeType: "Test Case",
          nodeIdentifier: "SharedTests/SafetyAlertTests/testAlert",
          result: "Passed",
        },
      ],
    },
  ],
});
const xcodeResultReader = async (): Promise<string> => XCODE_RESULT;
const FAILED_XCODE_RESULT = XCODE_RESULT.replace('"Passed"', '"Failed"');
const failedXcodeResultReader = async (): Promise<string> => FAILED_XCODE_RESULT;

function gateDefinition(input: {
  executable: string;
  destination: string;
  gateId?: string;
}): VerificationGateDefinition {
  return VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: input.gateId ?? "ios-tests",
    gate_class: VerificationGateClass.TEST,
    executable: input.executable,
    argv: [
      "-project",
      "Fake.xcodeproj",
      "-destination",
      input.destination,
      "-derivedDataPath",
      ".remoteagent-xcode/DerivedData",
      "-clonedSourcePackagesDirPath",
      ".remoteagent-xcode/SourcePackages",
      "ENABLE_TESTABILITY=YES",
      "-resultBundlePath",
      ".remoteagent-xcode/TestResults.xcresult",
      "-only-testing:SharedTests/SafetyAlertTests",
      "test",
    ],
    relative_cwd: "project",
    required: true,
    baseline: false,
    test_first: false,
    timeout_ms: 60_000,
    environment_profile: "BUILD_TOOLCHAIN",
    network_profile: "PLATFORM_MANAGED",
    mutable_outputs: ["project/.remoteagent-xcode"],
  });
}

async function prepareFakeProject(workspace: string): Promise<void> {
  await mkdir(
    join(workspace, "project", "Fake.xcodeproj", "project.xcworkspace", "xcshareddata", "swiftpm"),
    { recursive: true },
  );
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("derives one exact simulator destination from the server-owned gate catalog", async () => {
  const executable = await realpath(process.execPath);
  const selected = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const first = gateDefinition({ executable, destination: selected, gateId: "ios-tests-a" });
  const second = VerificationGateDefinition.parse({
    ...gateDefinition({ executable, destination: selected, gateId: "ios-tests-b" }),
    argv: [...first.argv.slice(0, -1), "-only-testing:SharedTests/SecondTests", "test"],
  });
  expect(xcodeDestinationFromGateCatalog([first, second], executable)).toBe(selected);
  expect(() =>
    xcodeDestinationFromGateCatalog(
      [first, gateDefinition({ executable, destination: selected, gateId: "duplicate-tests" })],
      executable,
    ),
  ).toThrow(/duplicate test command/u);
  expect(() =>
    xcodeDestinationFromGateCatalog(
      [
        gateDefinition({ executable, destination: selected, gateId: "ios-tests-a" }),
        gateDefinition({
          executable,
          destination: "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000002",
          gateId: "ios-tests-b",
        }),
      ],
      executable,
    ),
  ).toThrow(/conflicting simulator destinations/u);
});

it("parses bounded nested xcresult test nodes and rejects malformed or incomplete evidence", () => {
  const raw = JSON.stringify({
    testPlanConfigurations: [],
    devices: [],
    testNodes: [
      {
        nodeType: "Test Suite",
        children: [
          {
            nodeType: "Test Case",
            nodeIdentifier: "SharedTests/SafetyAlertTests/testAlert",
            result: "Failed",
          },
        ],
      },
    ],
  });
  const evidence = parseXcodeTestEvidence(raw, ["SharedTests/SafetyAlertTests"]);
  expect(evidence.executed_test_ids).toEqual(["SharedTests/SafetyAlertTests/testAlert"]);
  expect(evidence.failed_test_ids).toEqual(["SharedTests/SafetyAlertTests/testAlert"]);
  expect(evidence.result_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(xcodeExpectedSuiteIds(["-only-testing:SharedTests/SafetyAlertTests"])).toEqual([
    "SharedTests/SafetyAlertTests",
  ]);
  expect(() =>
    parseXcodeTestEvidence(
      JSON.stringify({ testPlanConfigurations: [], devices: [], testNodes: [] }),
      [],
    ),
  ).toThrow(/executed tests invalid/u);
  for (const payload of [
    "{",
    JSON.stringify({ testNodes: [] }),
    JSON.stringify({ testNodes: [{ nodeType: "Test Case", result: "Passed" }] }),
  ]) {
    expect(() => parseXcodeTestEvidence(payload, ["SharedTests/SafetyAlertTests"])).toThrow();
  }
  expect(() =>
    parseXcodeTestEvidence(JSON.stringify({ testNodes: JSON.parse(raw).testNodes }), [
      "SharedTests/SafetyAlertTests",
    ]),
  ).toThrow();
  expect(() => parseXcodeTestEvidence(raw, ["SharedTests/MissingTests"])).toThrow();
  const skipped = JSON.stringify({
    testPlanConfigurations: [],
    devices: [],
    testNodes: [
      {
        nodeType: "Test Case",
        nodeIdentifier: "SharedTests/SafetyAlertTests/skipped",
        result: "Skipped",
      },
    ],
  });
  expect(() => parseXcodeTestEvidence(skipped, ["SharedTests/SafetyAlertTests"])).toThrow();
  const unknown = skipped.replace('"Skipped"', '"unknown"');
  expect(() => parseXcodeTestEvidence(unknown, ["SharedTests/SafetyAlertTests"])).toThrow();
  const expectedFailure = skipped.replace('"Skipped"', '"Expected Failure"');
  expect(() => parseXcodeTestEvidence(expectedFailure, ["SharedTests/SafetyAlertTests"])).toThrow();
  const mixed = JSON.stringify({
    testPlanConfigurations: [],
    devices: [],
    testNodes: [
      {
        nodeType: "Test Case",
        nodeIdentifier: "SharedTests/SafetyAlertTests/pass",
        result: "Passed",
      },
      {
        nodeType: "Test Case",
        nodeIdentifier: "SharedTests/SafetyAlertTests/skip",
        result: "Skipped",
      },
    ],
  });
  expect(() => parseXcodeTestEvidence(mixed, ["SharedTests/SafetyAlertTests"])).toThrow();
});

it("requires exact two- or three-segment test identities and matching targets", () => {
  const base = {
    testPlanConfigurations: [],
    devices: [],
  };
  const node = (nodeIdentifier: string) => ({
    ...base,
    testNodes: [{ nodeType: "Test Case", nodeIdentifier, result: "Passed" }],
  });
  expect(() =>
    parseXcodeTestEvidence(JSON.stringify(node("OtherTarget/SafetyAlertTests/test()")), [
      "SharedTests/SafetyAlertTests",
    ]),
  ).toThrow(/target cannot map/u);
  expect(() =>
    parseXcodeTestEvidence(JSON.stringify(node("SharedTests/SafetyAlertTests/nested/test()")), [
      "SharedTests/SafetyAlertTests",
    ]),
  ).toThrow(/malformed/u);
});

it("normalizes suite-only xcresult identifiers to canonical expected suites", () => {
  const raw = JSON.stringify({
    testPlanConfigurations: [],
    devices: [],
    testNodes: [
      {
        nodeType: "Test Case",
        nodeIdentifier: "SafetyAlertTests/testAlert()",
        result: "Passed",
      },
    ],
  });
  const evidence = parseXcodeTestEvidence(raw, ["SharedTests/SafetyAlertTests"]);
  expect(evidence.executed_test_ids).toEqual(["SafetyAlertTests/testAlert()"]);
  expect(evidence.observed_suite_ids).toEqual(["SharedTests/SafetyAlertTests"]);
  expect(() => parseXcodeTestEvidence(raw, ["SharedTests/MissingTests"])).toThrow(/cannot map/u);
  expect(() =>
    parseXcodeTestEvidence(raw, ["SharedTests/SafetyAlertTests", "Other/SafetyAlertTests"]),
  ).toThrow(/basename ambiguous/u);
  expect(() =>
    parseXcodeTestEvidence(raw.replace("SafetyAlertTests/testAlert()", "SafetyAlertTests"), [
      "SharedTests/SafetyAlertTests",
    ]),
  ).toThrow(/nodeIdentifier malformed/u);
});

it("requires every selected method and compares canonical method identities", () => {
  const selectorArgs = [
    "-only-testing:SharedTests/SafetyAlertTests/selected()",
    "-only-testing:SharedTests/SafetyAlertTests/second",
  ];
  expect(xcodeExpectedTestIds(selectorArgs)).toEqual([
    "SharedTests/SafetyAlertTests/second",
    "SharedTests/SafetyAlertTests/selected",
  ]);
  expect(xcodeExpectedTestIds(["-only-testing:SharedTests/SafetyAlertTests"])).toEqual([]);
  expect(() => xcodeExpectedTestIds(["-only-testing:SharedTests/SafetyAlertTests/a/b"])).toThrow(
    /malformed/u,
  );
  for (const selector of ["*", "?", "()", "bad method", " selected"]) {
    expect(() =>
      xcodeExpectedTestIds([`-only-testing:SharedTests/SafetyAlertTests/${selector}`]),
    ).toThrow(/malformed/u);
  }
  const result = (method: string, status = "Passed") =>
    JSON.stringify({
      testPlanConfigurations: [],
      devices: [],
      testNodes: [
        {
          nodeType: "Test Case",
          nodeIdentifier: `SafetyAlertTests/${method}()`,
          result: status,
        },
      ],
    });
  expect(
    parseXcodeTestEvidence(
      result("selected"),
      ["SharedTests/SafetyAlertTests"],
      ["SharedTests/SafetyAlertTests/selected()"],
    ).executed_test_ids,
  ).toEqual(["SafetyAlertTests/selected()"]);
  const fullTargetResult = result("selected").replace(
    "SafetyAlertTests/selected()",
    "SharedTests/SafetyAlertTests/selected()",
  );
  expect(
    parseXcodeTestEvidence(
      fullTargetResult,
      ["SharedTests/SafetyAlertTests"],
      ["SharedTests/SafetyAlertTests/selected"],
    ).executed_test_ids,
  ).toEqual(["SharedTests/SafetyAlertTests/selected()"]);
  expect(
    parseXcodeTestEvidence(
      result("selected", "Failed"),
      ["SharedTests/SafetyAlertTests"],
      ["SharedTests/SafetyAlertTests/selected"],
    ).failed_test_ids,
  ).toEqual(["SafetyAlertTests/selected()"]);
  expect(() =>
    parseXcodeTestEvidence(
      result("selected"),
      ["SharedTests/SafetyAlertTests"],
      ["SharedTests/SafetyAlertTests/selected", "SharedTests/SafetyAlertTests/second"],
    ),
  ).toThrow(/expected test missing/u);
  expect(() =>
    parseXcodeTestEvidence(
      result("other"),
      ["SharedTests/SafetyAlertTests"],
      ["SharedTests/SafetyAlertTests/selected"],
    ),
  ).toThrow(/expected test missing/u);
  expect(() =>
    parseXcodeTestEvidence(
      result("selected"),
      ["SharedTests/SafetyAlertTests"],
      ["SharedTests/SafetyAlertTests/selected/extra"],
    ),
  ).toThrow(/expected test id malformed/u);
  for (const selector of ["*", "?", "()", "bad method", " selected"]) {
    expect(() =>
      parseXcodeTestEvidence(
        result("selected"),
        ["SharedTests/SafetyAlertTests"],
        [`SharedTests/SafetyAlertTests/${selector}`],
      ),
    ).toThrow(/expected test id malformed/u);
  }
});

it("uses ordinal ordering for mixed-case evidence identities", () => {
  const raw = JSON.stringify({
    testPlanConfigurations: [],
    devices: [],
    testNodes: [
      {
        nodeType: "Test Case",
        nodeIdentifier: "ATests/test()",
        result: "Passed",
      },
      {
        nodeType: "Test Case",
        nodeIdentifier: "aTests/test()",
        result: "Passed",
      },
    ],
  });
  const evidence = parseXcodeTestEvidence(raw, ["SharedTests/ATests", "SharedTests/aTests"]);
  expect(evidence.executed_test_ids).toEqual(["ATests/test()", "aTests/test()"]);
  expect(evidence.expected_suite_ids).toEqual(["SharedTests/ATests", "SharedTests/aTests"]);
  expect(evidence.observed_suite_ids).toEqual(["SharedTests/ATests", "SharedTests/aTests"]);
});

it("refuses an Xcode test catalog without one explicit testability setting", async () => {
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const valid = gateDefinition({ executable, destination });
  for (const argv of [
    valid.argv.filter((argument) => argument !== "ENABLE_TESTABILITY=YES"),
    valid.argv.map((argument) =>
      argument === "ENABLE_TESTABILITY=YES" ? "ENABLE_TESTABILITY=NO" : argument,
    ),
    [...valid.argv.slice(0, -1), "ENABLE_TESTABILITY=YES", "test"],
  ]) {
    expect(() =>
      xcodeDestinationFromGateCatalog(
        [VerificationGateDefinition.parse({ ...valid, argv })],
        executable,
      ),
    ).toThrow(/exactly one ENABLE_TESTABILITY=YES/u);
  }
  expect(() =>
    xcodeDestinationFromGateCatalog(
      [VerificationGateDefinition.parse({ ...valid, argv: ["-quiet", ...valid.argv] })],
      executable,
    ),
  ).toThrow(/cannot use -quiet/u);
});

it("validates the exact server-owned Xcode result bundle location", async () => {
  const executable = await realpath(process.execPath);
  const valid = gateDefinition({
    executable,
    destination: "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001",
  });
  expect(validateXcodeTestGateResultBundlePath(valid)).toBe(
    ".remoteagent-xcode/TestResults.xcresult",
  );
  for (const [label, resultBundlePath] of [
    ["missing", undefined],
    ["duplicate", ".remoteagent-xcode/Other.xcresult"],
    ["absolute", "/tmp/TestResults.xcresult"],
    ["traversal", ".remoteagent-xcode/../TestResults.xcresult"],
    ["wrong root", "Other/TestResults.xcresult"],
    ["wrong extension", ".remoteagent-xcode/TestResults.json"],
  ] as const) {
    const argv =
      resultBundlePath === undefined
        ? valid.argv.filter(
            (argument) =>
              argument !== "-resultBundlePath" &&
              argument !== ".remoteagent-xcode/TestResults.xcresult",
          )
        : label === "duplicate"
          ? [...valid.argv, "-resultBundlePath", resultBundlePath]
          : valid.argv.map((argument) =>
              argument === ".remoteagent-xcode/TestResults.xcresult" ? resultBundlePath : argument,
            );
    expect(() =>
      validateXcodeTestGateResultBundlePath(VerificationGateDefinition.parse({ ...valid, argv })),
    ).toThrow();
  }
});

it("accepts a compiler failure when Xcode provides diagnostics but no xcresult", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-compiler-failure-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "Broken.swift"), "let broken = 1\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner: async () => ({
      exitCode: 65,
      signal: null,
      stdout: "project/Broken.swift:2:3: error: cannot compile",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    }),
    xcresultReader: async () => {
      throw new Error("xcresult absent");
    },
  });
  const run = await adapter.run({
    definition: gateDefinition({ executable, destination }),
    disposable_root: workspace,
    scope: { case_id: "case-compiler", workspace_id: "workspace-compiler" },
    store: new LocalArtifactStore({ root: artifacts }),
  });
  expect(run.outcome).toBe("FAILED");
  expect(run.test_evidence).toBeUndefined();
  expect(run.excerpt.value).toContain("Broken.swift:2:3: error: cannot compile");
});

it("keeps invalid xcresult evidence fail-closed for successful and uninformed failures", async () => {
  const runCase = async (
    result: {
      exitCode: number | null;
      stdout: string;
      stderr?: string;
      signal?: string | null;
      timedOut?: boolean;
      cancelled?: boolean;
    },
    payload?: string,
    expectedOutcome: "INFRASTRUCTURE" | "TIMED_OUT" | "CANCELED" = "INFRASTRUCTURE",
  ) => {
    const parent = await mkdtemp(join(tmpdir(), "ra-xcode-invalid-evidence-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const artifacts = join(parent, "artifacts");
    await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
    await mkdir(join(workspace, "project"));
    await prepareFakeProject(workspace);
    const executable = await realpath(process.execPath);
    const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
    const store = new LocalArtifactStore({ root: artifacts });
    const adapter = await createXcodeVerificationGatePlatformAdapter({
      xcodebuildPath: executable,
      developerDir: dirname(executable),
      knownSecrets: ["crash-secret"],
      destination,
      processRunner: async () => ({
        ...result,
        signal: result.signal ?? null,
        stderr: result.stderr ?? "",
        timedOut: result.timedOut ?? false,
        cancelled: result.cancelled ?? false,
        outputTruncated: false,
      }),
      xcresultReader: async () => {
        if (payload !== undefined) return payload;
        throw new Error("xcresult unavailable");
      },
    });
    const definition = gateDefinition({ executable, destination });
    const scope = { case_id: "case-invalid-evidence", workspace_id: "workspace-invalid-evidence" };
    const run = await adapter.run({
      definition,
      disposable_root: workspace,
      scope,
      store,
    });
    expect(run.outcome).toBe(expectedOutcome);
    expect(run.test_evidence).toBeUndefined();
    expect(run.exit_code).toBe(result.exitCode);
    expect(run.signal).toBe(result.signal ?? null);
    if (expectedOutcome === "INFRASTRUCTURE")
      expect(run.excerpt.value).toContain("REMOTEAGENT_XCODE_EVIDENCE_INVALID");
    const { receipt_digest: receiptDigest, ...receipt } = run;
    expect(receiptDigest).toBe(testRunReceiptDigest(receipt));
    expect(() =>
      VerificationGateValidateTestRun(run, definition, {
        ...scope,
        tree_digest: run.tree_digest_before,
      }),
    ).not.toThrow();
    const artifact = run.artifact === null ? "" : await store.get(run.artifact);
    return { run, artifact };
  };
  await runCase({ exitCode: 0, stdout: "TEST SUCCEEDED" });
  await runCase({ exitCode: 65, stdout: "** TEST FAILED **" });
  const crash = await runCase({
    exitCode: null,
    stdout: "Xcode terminated unexpectedly /Users/private/crash/Crash.swift",
    stderr: "fatal simulator service crash-secret",
    signal: "SIGABRT",
  });
  expect(crash.run.outcome).toBe("INFRASTRUCTURE");
  expect(crash.run.excerpt.value).toContain("Xcode terminated unexpectedly");
  expect(crash.run.excerpt.value).not.toContain("crash-secret");
  expect(crash.run.excerpt.value).not.toContain("/Users/private/crash");
  expect(crash.artifact).toContain("fatal simulator service");
  expect(crash.artifact).not.toContain("crash-secret");
  expect(crash.artifact).not.toContain("/Users/private/crash");
  await runCase({ exitCode: null, stdout: "timed out", timedOut: true }, undefined, "TIMED_OUT");
  await runCase({ exitCode: null, stdout: "cancelled", cancelled: true }, undefined, "CANCELED");
  for (const invalid of [
    { nodeIdentifier: "SharedTests/SafetyAlertTests/omitted", result: "Skipped" },
    { nodeIdentifier: "SharedTests/SafetyAlertTests/knownFailure", result: "Expected Failure" },
    { nodeIdentifier: "OtherTarget/SafetyAlertTests/testOther", result: "Passed" },
    { nodeIdentifier: "SharedTests/SafetyAlertTests/nested/testOther", result: "Passed" },
  ]) {
    await runCase(
      { exitCode: 0, stdout: "TEST SUCCEEDED" },
      JSON.stringify({
        testPlanConfigurations: [],
        devices: [],
        testNodes: [
          {
            nodeType: "Test Case",
            nodeIdentifier: "SharedTests/SafetyAlertTests/testAlert",
            result: "Passed",
          },
          { nodeType: "Test Case", ...invalid },
        ],
      }),
    );
  }
});

it("fails closed on buried XCTest framework-link failures retained across stream chunks", async () => {
  for (const [stream, first, second, phrase] of [
    [
      "stdout",
      "A failure was recorded without linking the XCTest ",
      "framework",
      "A failure was recorded without linking the XCTest framework",
    ],
    [
      "stderr",
      "An issue was recorded without linking the Testing ",
      "framework",
      "An issue was recorded without linking the Testing framework",
    ],
  ] as const) {
    const parent = await mkdtemp(join(tmpdir(), "ra-xcode-framework-link-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const artifacts = join(parent, "artifacts");
    await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
    await mkdir(join(workspace, "project"));
    await prepareFakeProject(workspace);
    const executablePath = join(parent, "xcodebuild");
    await writeFile(
      executablePath,
      `#!${process.execPath}\nprocess.${stream}.write("A".repeat(600000));\nprocess.${stream}.write(${JSON.stringify(first)});\nsetImmediate(() => process.${stream}.write(${JSON.stringify(second)} + "B".repeat(600000)));\n`,
    );
    await chmod(executablePath, 0o755);
    const executable = await realpath(executablePath);
    const destination = "platform=iOS Simulator,id=00000000-0000-0000-000000000001";
    const adapter = await createXcodeVerificationGatePlatformAdapter({
      xcodebuildPath: executable,
      developerDir: parent,
      destination,
      xcresultReader: xcodeResultReader,
    });
    const run = await adapter.run({
      definition: gateDefinition({ executable, destination }),
      disposable_root: workspace,
      scope: {
        case_id: `case-framework-link-${stream}`,
        workspace_id: `workspace-framework-link-${stream}`,
      },
      store: new LocalArtifactStore({ root: artifacts }),
    });
    expect(run.outcome).toBe("INFRASTRUCTURE");
    expect(run.test_evidence).toBeUndefined();
    const artifact = await new LocalArtifactStore({ root: artifacts }).get(run.artifact!);
    expect(artifact).toContain("REMOTEAGENT_XCODE_TEST_FRAMEWORK_FAILURE");
    expect(artifact).not.toContain(phrase);
  }
});

it("uses the direct framework-link phrase fallback without rejecting ordinary warnings", async () => {
  const runCase = async (output: string, expected: "INFRASTRUCTURE" | "PASSED") => {
    const parent = await mkdtemp(join(tmpdir(), "ra-xcode-framework-link-short-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const artifacts = join(parent, "artifacts");
    await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
    await mkdir(join(workspace, "project"));
    await prepareFakeProject(workspace);
    const executable = await realpath(process.execPath);
    const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
    const adapter = await createXcodeVerificationGatePlatformAdapter({
      xcodebuildPath: executable,
      developerDir: dirname(executable),
      destination,
      processRunner: async () => ({
        exitCode: 0,
        signal: null,
        stdout: output,
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
      }),
      xcresultReader: xcodeResultReader,
    });
    const run = await adapter.run({
      definition: gateDefinition({ executable, destination }),
      disposable_root: workspace,
      scope: {
        case_id: `case-framework-link-short-${expected}`,
        workspace_id: "workspace-framework-link-short",
      },
      store: new LocalArtifactStore({ root: artifacts }),
    });
    expect(run.outcome).toBe(expected);
    if (expected === "INFRASTRUCTURE") expect(run.test_evidence).toBeUndefined();
    else
      expect(run.test_evidence?.executed_test_ids).toEqual([
        "SharedTests/SafetyAlertTests/testAlert",
      ]);
  };

  await runCase("ordinary xcode warning", "PASSED");
  await runCase("An issue was recorded without linking the Testing framework", "INFRASTRUCTURE");
});

it("makes an exit-zero method gate infrastructure-failed unless the selected method ran", async () => {
  const runCase = async (method: string) => {
    const parent = await mkdtemp(join(tmpdir(), "ra-xcode-method-selector-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const artifacts = join(parent, "artifacts");
    await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
    await mkdir(join(workspace, "project"));
    await prepareFakeProject(workspace);
    const executable = await realpath(process.execPath);
    const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
    const adapter = await createXcodeVerificationGatePlatformAdapter({
      xcodebuildPath: executable,
      developerDir: dirname(executable),
      destination,
      processRunner: async () => ({
        exitCode: 0,
        signal: null,
        stdout: "TEST SUCCEEDED",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
      }),
      xcresultReader: async () =>
        JSON.stringify({
          testPlanConfigurations: [],
          devices: [],
          testNodes: [
            {
              nodeType: "Test Case",
              nodeIdentifier: `SafetyAlertTests/${method}()`,
              result: "Passed",
            },
          ],
        }),
    });
    const base = gateDefinition({ executable, destination, gateId: `ios-method-${method}` });
    const definition = VerificationGateDefinition.parse({
      ...base,
      argv: base.argv.map((arg) =>
        arg === "-only-testing:SharedTests/SafetyAlertTests"
          ? `-only-testing:SharedTests/SafetyAlertTests/selected()`
          : arg,
      ),
    });
    return adapter.run({
      definition,
      disposable_root: workspace,
      scope: { case_id: `case-method-${method}`, workspace_id: "workspace-method" },
      store: new LocalArtifactStore({ root: artifacts }),
    });
  };
  const nonselected = await runCase("other");
  expect(nonselected.outcome).toBe("INFRASTRUCTURE");
  expect(nonselected.test_evidence).toBeUndefined();
  const selected = await runCase("selected");
  expect(selected.outcome).toBe("PASSED");
  expect(selected.test_evidence?.executed_test_ids).toEqual(["SafetyAlertTests/selected()"]);
});

it("runs a BUILD_TOOLCHAIN gate through the injected bounded boundary and mints evidence", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-adapter-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "project.txt"), "source\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const processRunner = vi.fn(async (input) => {
    const processCwd = join(input.workspaceRoot, input.cwd);
    expect(input.executable).toBe(executable);
    expect(input.args).toContain(destination);
    expect(input.env).toMatchObject({
      DEVELOPER_DIR: dirname(executable),
      HOME: expect.stringContaining(".remoteagent-xcode/Home"),
      TMPDIR: expect.stringContaining(".remoteagent-xcode/Tmp"),
    });
    const configuration = join(
      processCwd,
      "Fake.xcodeproj",
      "project.xcworkspace",
      "xcshareddata",
      "swiftpm",
      "configuration",
    );
    await expect(access(configuration)).resolves.toBeUndefined();
    await writeFile(join(configuration, "xcode-created.json"), "tool scratch");
    await mkdir(join(processCwd, ".remoteagent-xcode", "DerivedData"), { recursive: true });
    await writeFile(join(processCwd, ".remoteagent-xcode", "DerivedData", "build.db"), "build");
    return {
      exitCode: 0,
      signal: null,
      stdout: "TEST SUCCEEDED secret-value",
      stderr: "",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    } as const;
  });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    knownSecrets: ["secret-value"],
    processRunner,
    xcresultReader: xcodeResultReader,
  });
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "ios-tests",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: [
      "-project",
      "Fake.xcodeproj",
      "-destination",
      destination,
      "-derivedDataPath",
      ".remoteagent-xcode/DerivedData",
      "-clonedSourcePackagesDirPath",
      ".remoteagent-xcode/SourcePackages",
      "ENABLE_TESTABILITY=YES",
      "-resultBundlePath",
      ".remoteagent-xcode/TestResults.xcresult",
      "-only-testing:SharedTests/SafetyAlertTests",
      "test",
    ],
    relative_cwd: "project",
    required: true,
    baseline: false,
    test_first: false,
    timeout_ms: 60_000,
    environment_profile: "BUILD_TOOLCHAIN",
    network_profile: "PLATFORM_MANAGED",
    mutable_outputs: ["project/.remoteagent-xcode"],
  });
  const sourceTreeDigest = await computeTreeDigest(workspace);
  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-1", workspace_id: "workspace-1" },
    store: new LocalArtifactStore({ root: artifacts }),
  });
  expect(processRunner).toHaveBeenCalledTimes(1);
  expect(run.outcome).toBe("PASSED");
  expect(run.test_evidence?.executed_count).toBe(1);
  expect(run.test_evidence?.failed_test_ids).toEqual([]);
  expect(run.tree_digest_before).toBe(sourceTreeDigest);
  expect(run.tree_digest_after).toBe(sourceTreeDigest);
  expect(run.excerpt.value).not.toContain("secret-value");
  expect(run.environment.variable_names).toEqual([
    "DEVELOPER_DIR",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TMPDIR",
    "TZ",
  ]);
  await expect(access(join(workspace, "project", ".remoteagent-xcode"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    access(
      join(
        workspace,
        "project",
        "Fake.xcodeproj",
        "project.xcworkspace",
        "xcshareddata",
        "swiftpm",
        "configuration",
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("owns only the first missing SwiftPM component and preserves existing project state", async () => {
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const components = ["project.xcworkspace", "xcshareddata", "swiftpm", "configuration"];
  for (let existingDepth = 0; existingDepth <= components.length; existingDepth += 1) {
    const parent = await mkdtemp(join(tmpdir(), "ra-xcode-swiftpm-depth-"));
    roots.push(parent);
    const workspace = join(parent, "workspace");
    const artifacts = join(parent, "artifacts");
    await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
    await mkdir(join(workspace, "project", "Fake.xcodeproj"), { recursive: true });
    for (let index = 0; index < existingDepth; index += 1) {
      await mkdir(join(workspace, "project", "Fake.xcodeproj", ...components.slice(0, index + 1)), {
        recursive: true,
      });
      await writeFile(
        join(workspace, "project", "Fake.xcodeproj", ...components.slice(0, index + 1), "keep.txt"),
        "keep\n",
      );
    }
    const processRunner = vi.fn(async (input) => {
      const configuration = join(
        input.workspaceRoot,
        "project/Fake.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration",
      );
      await access(configuration);
      if (existingDepth < components.length)
        await writeFile(join(configuration, "scratch.txt"), "scratch\n");
      return {
        exitCode: 0,
        signal: null,
        stdout: "TEST SUCCEEDED",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
      } as const;
    });
    const adapter = await createXcodeVerificationGatePlatformAdapter({
      xcodebuildPath: executable,
      developerDir: dirname(executable),
      destination,
      processRunner,
      xcresultReader: xcodeResultReader,
    });
    const before = await computeTreeDigest(workspace);
    const run = await adapter.run({
      definition: gateDefinition({ executable, destination }),
      disposable_root: workspace,
      scope: { case_id: `case-depth-${existingDepth}`, workspace_id: "workspace-1" },
      store: new LocalArtifactStore({ root: artifacts }),
    });
    expect(run.outcome).toBe("PASSED");
    expect(processRunner).toHaveBeenCalledTimes(1);
    expect(run.tree_digest_before).toBe(before);
    expect(run.tree_digest_after).toBe(before);
    const configuration = join(
      workspace,
      "project/Fake.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration",
    );
    if (existingDepth < components.length) {
      await expect(access(configuration)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(access(join(configuration, "keep.txt"))).resolves.toBeUndefined();
    }
  }
});

it("rejects a symlink in the fixed SwiftPM chain before dispatch", async () => {
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-swiftpm-symlink-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  const outside = join(parent, "outside");
  await Promise.all([workspace, artifacts, outside].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project", "Fake.xcodeproj"), { recursive: true });
  await symlink(outside, join(workspace, "project", "Fake.xcodeproj", "project.xcworkspace"));
  const processRunner = vi.fn();
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner,
    xcresultReader: xcodeResultReader,
  });
  await expect(
    adapter.run({
      definition: gateDefinition({ executable, destination }),
      disposable_root: workspace,
      scope: { case_id: "case-symlink", workspace_id: "workspace-1" },
      store: new LocalArtifactStore({ root: artifacts }),
    }),
  ).rejects.toThrow(/unsafe type/u);
  expect(processRunner).not.toHaveBeenCalled();
});

it("removes a newly owned SwiftPM subtree after a process failure", async () => {
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-swiftpm-partial-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project", "Fake.xcodeproj"), { recursive: true });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner: async () => {
      throw new Error("synthetic process failure");
    },
    xcresultReader: xcodeResultReader,
  });
  const run = await adapter.run({
    definition: gateDefinition({ executable, destination }),
    disposable_root: workspace,
    scope: { case_id: "case-partial", workspace_id: "workspace-1" },
    store: new LocalArtifactStore({ root: artifacts }),
  });
  expect(run.outcome).toBe("INFRASTRUCTURE");
  await expect(
    access(join(workspace, "project/Fake.xcodeproj/project.xcworkspace")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a pre-existing SwiftPM configuration protected after mutation", async () => {
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-swiftpm-protected-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  const configuration = join(
    workspace,
    "project/Fake.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/configuration",
  );
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(configuration, { recursive: true });
  await writeFile(join(configuration, "keep.txt"), "original\n");
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner: async () => {
      await writeFile(join(configuration, "keep.txt"), "mutated\n");
      return {
        exitCode: 0,
        signal: null,
        stdout: "TEST SUCCEEDED",
        stderr: "",
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
      } as const;
    },
    xcresultReader: xcodeResultReader,
  });
  const run = await adapter.run({
    definition: gateDefinition({ executable, destination }),
    disposable_root: workspace,
    scope: { case_id: "case-protected", workspace_id: "workspace-1" },
    store: new LocalArtifactStore({ root: artifacts }),
  });
  expect(run.outcome).not.toBe("PASSED");
  await expect(readFile(join(configuration, "keep.txt"), "utf8")).resolves.toBe("mutated\n");
});

it("retries one uninformative Xcode 65 result but never retries a named test failure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-infrastructure-retry-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "project.txt"), "source\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const uninformative = {
    exitCode: 65,
    signal: null,
    stdout: "Testing started\n** TEST FAILED **\n",
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
  } as const;
  const namedFailure = {
    ...uninformative,
    stdout:
      "Tests/SafetyAlertTests.swift:73: error: -[SharedTests.SafetyAlertTests testCloseDismissesAlert] : XCTAssertFalse failed\n** TEST FAILED **\n",
  } as const;
  const definition = gateDefinition({ executable, destination });
  expect(shouldRetryUninformativeXcodeTest(definition.argv, uninformative)).toBe(true);
  expect(shouldRetryUninformativeXcodeTest(definition.argv, namedFailure)).toBe(false);
  const processRunner = vi
    .fn()
    .mockResolvedValueOnce(uninformative)
    .mockResolvedValueOnce({
      ...uninformative,
      exitCode: 0,
      stdout: "** TEST SUCCEEDED **\n",
    });
  const store = new LocalArtifactStore({ root: artifacts });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner,
    xcresultReader: xcodeResultReader,
  });

  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-retry", workspace_id: "workspace-retry" },
    store,
  });

  expect(processRunner).toHaveBeenCalledTimes(2);
  expect(run.outcome).toBe("PASSED");
  const log = await store.get(run.artifact!);
  expect(log).toContain("REMOTEAGENT_XCODE_INFRASTRUCTURE_RETRY");
  expect(log).toContain(
    canonicalDigest({
      exit_code: uninformative.exitCode,
      stdout: uninformative.stdout,
      stderr: uninformative.stderr,
    }),
  );
  expect(log).not.toContain("Testing started");
});

it("retries transient package resolution once and classifies a repeated failure as infrastructure", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-package-retry-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "project.txt"), "source\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const dependencyFailure = {
    exitCode: 74,
    signal: null,
    stdout: "",
    stderr:
      "xcodebuild: error: Could not resolve package dependencies:\nFailed to clone repository https://example.invalid/repo: fatal: expected flush after ref listing\n",
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
  } as const;
  const definition = gateDefinition({ executable, destination });
  expect(shouldRetryUninformativeXcodeTest(definition.argv, dependencyFailure)).toBe(true);
  const processRunner = vi.fn().mockResolvedValue(dependencyFailure);
  const store = new LocalArtifactStore({ root: artifacts });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner,
    xcresultReader: xcodeResultReader,
  });

  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-package", workspace_id: "workspace-package" },
    store,
  });

  expect(processRunner).toHaveBeenCalledTimes(2);
  expect(run.outcome).toBe("INFRASTRUCTURE");
  const log = await store.get(run.artifact!);
  expect(log).toContain("runner refused: RUNNER_FAILED");
  expect(log).not.toContain("example.invalid");
});

it("classifies disk exhaustion before xcresult parsing and keeps successful output eligible", async () => {
  const failed = {
    exitCode: 65,
    signal: null,
    stdout: "CompileSwift normal arm64 /tmp/Foo.swift",
    stderr: "ld: write() failed, errno=28\nTesting cancelled because build failed",
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
  } as const;
  expect(isXcodeDiskExhaustion(failed)).toBe(true);
  expect(isXcodeDiskExhaustion({ ...failed, exitCode: 0 })).toBe(false);
  expect(isXcodeDiskExhaustion({ ...failed, stderr: "error: write failed for output" })).toBe(
    false,
  );

  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-disk-full-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const processRunner = vi.fn().mockResolvedValue(failed);
  const store = new LocalArtifactStore({ root: artifacts });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner,
    xcresultReader: async () => {
      throw new Error("xcresult reader must not run for disk exhaustion");
    },
  });
  const definition = gateDefinition({ executable, destination });
  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-disk-full", workspace_id: "workspace-disk-full" },
    store,
  });
  expect(processRunner).toHaveBeenCalledTimes(1);
  expect(run.outcome).toBe("INFRASTRUCTURE");
  expect(await store.get(run.artifact!)).toContain("runner refused: RESOURCE_LIMIT");
});

it("bounds verbose Xcode output without killing the selected build and preserves its diagnostic tail", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-output-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "project.txt"), "source\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const store = new LocalArtifactStore({ root: artifacts });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    xcresultReader: xcodeResultReader,
  });
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "verbose-ios-tests",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: [
      "-e",
      `process.stdout.write("x".repeat(${String(2 * 1024 * 1024)}) + "XCODE_TAIL_CANARY")`,
      "--",
      "-project",
      "Fake.xcodeproj",
      "-destination",
      destination,
      "-derivedDataPath",
      ".remoteagent-xcode/DerivedData",
      "-clonedSourcePackagesDirPath",
      ".remoteagent-xcode/SourcePackages",
      "ENABLE_TESTABILITY=YES",
      "-resultBundlePath",
      ".remoteagent-xcode/TestResults.xcresult",
      "-only-testing:SharedTests/SafetyAlertTests",
      "test",
    ],
    relative_cwd: "project",
    required: true,
    baseline: false,
    test_first: false,
    timeout_ms: 60_000,
    environment_profile: "BUILD_TOOLCHAIN",
    network_profile: "PLATFORM_MANAGED",
    mutable_outputs: ["project/.remoteagent-xcode"],
  });

  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-output", workspace_id: "workspace-output" },
    store,
  });

  expect(run.outcome).toBe("PASSED");
  expect(run.signal).toBeNull();
  expect(run.artifact).not.toBeNull();
  const stored = await store.get(run.artifact!);
  expect(stored).toContain("REMOTEAGENT_OUTPUT_TRUNCATED");
  expect(stored).toContain("original_bytes=2097169");
  expect(stored).toContain("XCODE_TAIL_CANARY");
  expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(1024 * 1024 + 256);
});

it("preserves a repository-relative Swift diagnostic from the dropped middle of verbose Xcode output", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-middle-diagnostic-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project", "Sources"), { recursive: true });
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "project.txt"), "source\n");
  await writeFile(join(workspace, "project", "Sources", "Feature.swift"), "struct Feature {}\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const diagnostic = `${join(workspace, "project", "Sources", "Feature.swift")}:18:23: error: exact middle failure`;
  const store = new LocalArtifactStore({ root: artifacts });
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    xcresultReader: failedXcodeResultReader,
  });
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "middle-diagnostic-ios-tests",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: [
      "-e",
      `process.stdout.write("x".repeat(700 * 1024) + "\\n" + ${JSON.stringify(diagnostic)} + "\\nlet value = missing\\n            ^\\n" + "y".repeat(700 * 1024));process.exitCode=65`,
      "--",
      "-project",
      "Fake.xcodeproj",
      "-destination",
      destination,
      "-derivedDataPath",
      ".remoteagent-xcode/DerivedData",
      "-clonedSourcePackagesDirPath",
      ".remoteagent-xcode/SourcePackages",
      "ENABLE_TESTABILITY=YES",
      "-resultBundlePath",
      ".remoteagent-xcode/TestResults.xcresult",
      "-only-testing:SharedTests/SafetyAlertTests",
      "test",
    ],
    relative_cwd: "project",
    required: true,
    baseline: false,
    test_first: false,
    timeout_ms: 60_000,
    environment_profile: "BUILD_TOOLCHAIN",
    network_profile: "PLATFORM_MANAGED",
    mutable_outputs: ["project/.remoteagent-xcode"],
  });

  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-middle-diagnostic", workspace_id: "workspace-middle-diagnostic" },
    store,
  });

  expect(run.outcome).toBe("FAILED");
  expect(run.excerpt.truncated).toBe(true);
  const stored = await store.get(run.artifact!);
  expect(stored).toContain("REMOTEAGENT_STREAMED_SWIFT_DIAGNOSTICS count=1");
  expect(stored).not.toContain(workspace);
  expect(parseXcodeCompilerDiagnostics(stored)).toEqual([
    expect.objectContaining({
      path: "project/Sources/Feature.swift",
      line: 18,
      column: 23,
      message: "exact middle failure",
    }),
  ]);
});

it("preserves repository-relative compiler locations while redacting other host paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-diagnostics-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await mkdir(join(workspace, "project", "Sources"));
  await prepareFakeProject(workspace);
  await writeFile(join(workspace, "project", "project.txt"), "source\n");
  await writeFile(join(workspace, "project", "Sources", "Feature.swift"), "struct Feature {}\n");
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner: async () => ({
      exitCode: 65,
      signal: null,
      stdout: "/private/xcode-overlay/project/Sources/Feature.swift:8:14: error: missing symbol",
      stderr: "/Users/private/secret/Other.swift:1:1: error: must remain private",
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
    }),
    xcresultReader: failedXcodeResultReader,
  });
  const run = await adapter.run({
    definition: gateDefinition({ executable, destination }),
    disposable_root: workspace,
    scope: { case_id: "case-diagnostics", workspace_id: "workspace-diagnostics" },
    store: new LocalArtifactStore({ root: artifacts }),
  });

  expect(run.outcome, JSON.stringify(run)).toBe("FAILED");
  expect(run.excerpt.value).toContain("project/Sources/Feature.swift:8:14: error: missing symbol");
  expect(run.excerpt.value).not.toContain(workspace);
  expect(run.excerpt.value).not.toContain("/Users/private/secret");
  expect(run.excerpt.value).toContain("[REDACTED]");
  const stored = await new LocalArtifactStore({ root: artifacts }).get(run.artifact!);
  expect(parseXcodeCompilerDiagnostics(stored)).toEqual([
    expect.objectContaining({
      path: "project/Sources/Feature.swift",
      line: 8,
      column: 14,
      message: "missing symbol",
    }),
  ]);
});

it("projects bounded digest-bound Swift compiler diagnostics and ignores host paths", () => {
  const diagnostics = parseXcodeCompilerDiagnostics(
    [
      "SonderClient/Sources/Feature.swift:18:23: error: reference requires explicit 'self.'",
      "        sessionStartedDate = now",
      "        ^",
      "/Users/private/source/Foreign.swift:1:1: error: must not escape",
    ].join("\n"),
  );

  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({
    path: "SonderClient/Sources/Feature.swift",
    line: 18,
    column: 23,
    message: "reference requires explicit 'self.'",
  });
  expect(diagnostics[0]?.excerpt).toContain("sessionStartedDate = now");
  expect(diagnostics[0]?.digest).toBe(
    canonicalDigest({
      path: diagnostics[0]!.path,
      line: diagnostics[0]!.line,
      column: diagnostics[0]!.column,
      message: diagnostics[0]!.message,
      excerpt: diagnostics[0]!.excerpt,
    }),
  );
  expect(JSON.stringify(diagnostics)).not.toContain("/Users/private");
  expect(Object.isFrozen(diagnostics)).toBe(true);
  const bounded = parseXcodeCompilerDiagnostics(
    `Sources/Large.swift:1:1: error: bounded\n${"x".repeat(10_000)}`,
  );
  expect(bounded[0]?.excerpt.length).toBeLessThanOrEqual(4_096);
});

it("projects stable XCTest names, assertion messages, and repository-relative locations", () => {
  const diagnostics = parseXcodeTestDiagnostics(
    [
      "project/Tests/SafetyAlertTests.swift:73: error: -[SharedTests.SafetyAlertTests testCloseDismissesAlert] : XCTAssertFalse failed - alert remained visible",
      "Test Case '-[SharedTests.SafetyAlertTests testCloseDismissesAlert]' failed (0.018 seconds).",
      "/Users/private/ForeignTests.swift:1: error: -[ForeignTests testSecret] : must not escape",
    ].join("\n"),
  );

  expect(diagnostics).toEqual([
    expect.objectContaining({
      test_name: "-[SharedTests.SafetyAlertTests testCloseDismissesAlert]",
      message: "XCTAssertFalse failed - alert remained visible",
      path: "project/Tests/SafetyAlertTests.swift",
      line: 73,
    }),
    expect.objectContaining({
      test_name: "-[SharedTests.SafetyAlertTests testCloseDismissesAlert]",
      message: "Test case failed",
      path: null,
      line: null,
    }),
  ]);
  for (const diagnostic of diagnostics) {
    expect(diagnostic.digest).toBe(
      canonicalDigest({
        test_name: diagnostic.test_name,
        message: diagnostic.message,
        path: diagnostic.path,
        line: diagnostic.line,
      }),
    );
  }
  expect(JSON.stringify(diagnostics)).not.toContain("/Users/private");
  expect(Object.isFrozen(diagnostics)).toBe(true);
});

it("retains sanitized XCTest assertion diagnostics without inventing source paths", () => {
  const diagnostics = parseXcodeTestDiagnostics(
    [
      '[REDACTED] error: -[SharedTests.RA055SafetyAlertEvaluatorTests testGeneralHelpCopyAndActions] : XCTAssertEqual failed: ("actual") is not equal to ("expected")',
      '[REDACTED] error: -[SharedTests.RA055SafetyAlertEvaluatorTests testGeneralHelpCopyAndActions] : XCTAssertEqual failed: ("actual") is not equal to ("different")',
      "Test Case '-[SharedTests.RA055SafetyAlertEvaluatorTests testGeneralHelpCopyAndActions]' failed (0.001 seconds).",
      "Test Case '-[SharedTests.RA055SafetyAlertEvaluatorTests testGeneralHelpCopyAndActions]' failed (0.002 seconds).",
      "[REDACTED] error: this is not an XCTest assertion",
      "ordinary prose [REDACTED] error: -[NotARealTest testFoo] : XCTAssertTrue failed",
    ].join("\n"),
  );

  expect(
    diagnostics.filter((diagnostic) => diagnostic.message.startsWith("XCTAssertEqual")),
  ).toEqual([
    expect.objectContaining({
      test_name: "-[SharedTests.RA055SafetyAlertEvaluatorTests testGeneralHelpCopyAndActions]",
      message: 'XCTAssertEqual failed: ("actual") is not equal to ("expected")',
      path: null,
      line: null,
    }),
    expect.objectContaining({
      test_name: "-[SharedTests.RA055SafetyAlertEvaluatorTests testGeneralHelpCopyAndActions]",
      message: 'XCTAssertEqual failed: ("actual") is not equal to ("different")',
      path: null,
      line: null,
    }),
  ]);
  expect(
    diagnostics.filter((diagnostic) => diagnostic.message === "Test case failed"),
  ).toHaveLength(1);
  expect(diagnostics).toHaveLength(3);
  expect(new Set(diagnostics.map((diagnostic) => diagnostic.digest)).size).toBe(3);
  expect(
    diagnostics.every((diagnostic) => diagnostic.path === null && diagnostic.line === null),
  ).toBe(true);
  const oversized = parseXcodeTestDiagnostics(
    `[REDACTED] error: -[Suite test] : ${"x".repeat(5000)}`,
  );
  expect(oversized[0]?.message).toHaveLength(4096);
  const many = parseXcodeTestDiagnostics(
    Array.from(
      { length: 40 },
      (_, i) => `[REDACTED] error: -[Suite test${i}] : assertion failed`,
    ).join("\n"),
  );
  expect(many).toHaveLength(32);
});

it("projects stable build-test summaries retained after verbose Xcode output truncation", () => {
  const diagnostics = parseXcodeTestDiagnostics(
    [
      "[REMOTEAGENT_OUTPUT_TRUNCATED original_bytes=27937402 retained_bytes=524288]",
      "Testing failed:",
      "\tValue of type 'SafetyAlert' has no member 'variant'",
      "\tValue of type 'SafetyAlert' has no member 'variant'",
      "\tTesting cancelled because the build failed.",
      "",
      "** TEST FAILED **",
    ].join("\n"),
  );

  expect(diagnostics).toEqual([
    {
      test_name: "XCODE_TEST_BUILD",
      message: "Value of type 'SafetyAlert' has no member 'variant'",
      path: null,
      line: null,
      digest: canonicalDigest({
        test_name: "XCODE_TEST_BUILD",
        message: "Value of type 'SafetyAlert' has no member 'variant'",
        path: null,
        line: null,
      }),
    },
    {
      test_name: "XCODE_TEST_BUILD",
      message: "Testing cancelled because the build failed.",
      path: null,
      line: null,
      digest: canonicalDigest({
        test_name: "XCODE_TEST_BUILD",
        message: "Testing cancelled because the build failed.",
        path: null,
        line: null,
      }),
    },
  ]);
});

it("refuses a non-Xcode profile or output path before process dispatch", async () => {
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-refusal-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project"));
  await prepareFakeProject(workspace);
  const executable = await realpath(process.execPath);
  const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
  const processRunner = vi.fn();
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
    processRunner,
    xcresultReader: xcodeResultReader,
  });
  const base = {
    schema_version: 1,
    gate_id: "ios-tests",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: [
      "-project",
      "Fake.xcodeproj",
      "-destination",
      destination,
      "-derivedDataPath",
      ".remoteagent-xcode/DerivedData",
      "-clonedSourcePackagesDirPath",
      ".remoteagent-xcode/SourcePackages",
      "ENABLE_TESTABILITY=YES",
      "-resultBundlePath",
      ".remoteagent-xcode/TestResults.xcresult",
      "-only-testing:SharedTests/SafetyAlertTests",
      "test",
    ],
    relative_cwd: "project",
    required: true,
    baseline: false,
    test_first: false,
    timeout_ms: 60_000,
    environment_profile: "BUILD_TOOLCHAIN",
    network_profile: "PLATFORM_MANAGED",
    mutable_outputs: ["project/.remoteagent-xcode"],
  } as const;
  await expect(
    adapter.run({
      definition: VerificationGateDefinition.parse({ ...base, environment_profile: "HERMETIC" }),
      disposable_root: workspace,
      scope: { case_id: "case-1", workspace_id: "workspace-1" },
      store: new LocalArtifactStore({ root: artifacts }),
    }),
  ).rejects.toThrow(/BUILD_TOOLCHAIN/u);
  await expect(
    adapter.run({
      definition: VerificationGateDefinition.parse({
        ...base,
        mutable_outputs: ["foreign-output"],
      }),
      disposable_root: workspace,
      scope: { case_id: "case-1", workspace_id: "workspace-1" },
      store: new LocalArtifactStore({ root: artifacts }),
    }),
  ).rejects.toThrow(/mutable output/u);
  await expect(
    adapter.run({
      definition: VerificationGateDefinition.parse({
        ...base,
        argv: base.argv.filter((argument) => argument !== "ENABLE_TESTABILITY=YES"),
      }),
      disposable_root: workspace,
      scope: { case_id: "case-1", workspace_id: "workspace-1" },
      store: new LocalArtifactStore({ root: artifacts }),
    }),
  ).rejects.toThrow(/exactly one ENABLE_TESTABILITY=YES/u);
  expect(processRunner).not.toHaveBeenCalled();
});
