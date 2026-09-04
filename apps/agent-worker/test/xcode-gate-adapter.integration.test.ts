import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalDigest } from "@remoteagent/contracts";
import {
  LocalArtifactStore,
  VerificationGateClass,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterEach, expect, it, vi } from "vitest";

import {
  createXcodeVerificationGatePlatformAdapter,
  parseXcodeCompilerDiagnostics,
  parseXcodeTestDiagnostics,
  shouldRetryUninformativeXcodeTest,
  xcodeDestinationFromGateCatalog,
} from "../src/xcode-gate-adapter.js";

const roots: string[] = [];

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
