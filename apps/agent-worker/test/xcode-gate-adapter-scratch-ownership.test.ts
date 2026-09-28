import { vi } from "vitest";

const fsState = vi.hoisted(() => ({
  active: false,
  injectCompeting: false,
  injected: false,
  competingRoot: "",
  competingFile: "",
  failOutputRoot: "",
  originalMkdir: undefined as typeof import("node:fs/promises").mkdir | undefined,
  originalWriteFile: undefined as typeof import("node:fs/promises").writeFile | undefined,
  originalRm: undefined as typeof import("node:fs/promises").rm | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  fsState.originalMkdir = actual.mkdir;
  fsState.originalWriteFile = actual.writeFile;
  fsState.originalRm = actual.rm;
  return {
    ...actual,
    mkdir: async (
      path: Parameters<typeof actual.mkdir>[0],
      options?: Parameters<typeof actual.mkdir>[1],
    ) => {
      if (
        fsState.active &&
        fsState.injectCompeting &&
        !fsState.injected &&
        String(path).endsWith(".remoteagent-xcode/Home")
      ) {
        fsState.injected = true;
        await fsState.originalMkdir!(fsState.competingRoot, { recursive: true });
        await fsState.originalWriteFile!(fsState.competingFile, "preserve\n");
      }
      return actual.mkdir(path, options);
    },
    rm: async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      if (fsState.active && String(path) === fsState.failOutputRoot) {
        throw new Error("synthetic output cleanup failure");
      }
      return actual.rm(path, options);
    },
  };
});

import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it, vi as testVi } from "vitest";

import { createXcodeVerificationGatePlatformAdapter } from "../src/xcode-gate-adapter.js";
import {
  LocalArtifactStore,
  VerificationGateClass,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";

const roots: string[] = [];
const destination = "platform=iOS Simulator,id=00000000-0000-0000-0000-000000000001";
const xcodeResultReader = async (): Promise<string> =>
  JSON.stringify({
    testPlanConfigurations: [],
    devices: [],
    testNodes: [
      {
        nodeType: "Test Case",
        nodeIdentifier: "SharedTests/SafetyAlertTests/testAlert",
        result: "Passed",
      },
    ],
  });

afterEach(async () => {
  fsState.active = false;
  fsState.injectCompeting = false;
  fsState.injected = false;
  fsState.competingRoot = "";
  fsState.competingFile = "";
  fsState.failOutputRoot = "";
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("rejects a competing first-missing SwiftPM root before process dispatch", async () => {
  const executable = await realpath(process.execPath);
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-scratch-ownership-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project", "Fake.xcodeproj"), { recursive: true });
  fsState.competingRoot = join(workspace, "project/Fake.xcodeproj/project.xcworkspace");
  fsState.competingFile = join(fsState.competingRoot, "competing.txt");
  fsState.injectCompeting = true;

  const processRunner = testVi.fn();
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
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

  fsState.active = true;
  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-scratch", workspace_id: "workspace-1" },
    store: new LocalArtifactStore({ root: artifacts }),
  });
  fsState.active = false;

  expect(fsState.injected).toBe(true);
  expect(run.outcome).not.toBe("PASSED");
  expect(processRunner).not.toHaveBeenCalled();
  await expect(readFile(fsState.competingFile, "utf8")).resolves.toBe("preserve\n");
  await expect(
    access(join(workspace, "project/Fake.xcodeproj/project.xcworkspace")),
  ).resolves.toBeUndefined();
});

it("cleans owned SwiftPM configuration when output cleanup fails", async () => {
  const executable = await realpath(process.execPath);
  const parent = await mkdtemp(join(tmpdir(), "ra-xcode-scratch-cleanup-"));
  roots.push(parent);
  const workspace = join(parent, "workspace");
  const artifacts = join(parent, "artifacts");
  await Promise.all([workspace, artifacts].map((path) => mkdir(path)));
  await mkdir(join(workspace, "project", "Fake.xcodeproj"), { recursive: true });
  const preservedFile = join(workspace, "project", "preserve.txt");
  await writeFile(preservedFile, "preserve\n");
  fsState.failOutputRoot = join(workspace, "project/.remoteagent-xcode");

  const processRunner = testVi.fn(async () => ({
    exitCode: 0,
    signal: null,
    stdout: "TEST SUCCEEDED",
    stderr: "",
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
  }));
  const adapter = await createXcodeVerificationGatePlatformAdapter({
    xcodebuildPath: executable,
    developerDir: dirname(executable),
    destination,
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

  fsState.active = true;
  const run = await adapter.run({
    definition,
    disposable_root: workspace,
    scope: { case_id: "case-cleanup", workspace_id: "workspace-1" },
    store: new LocalArtifactStore({ root: artifacts }),
  });
  fsState.active = false;

  expect(run.outcome).not.toBe("PASSED");
  expect(processRunner).toHaveBeenCalledOnce();
  await expect(
    access(join(workspace, "project/Fake.xcodeproj/project.xcworkspace")),
  ).rejects.toThrow();
  await expect(readFile(preservedFile, "utf8")).resolves.toBe("preserve\n");
});
