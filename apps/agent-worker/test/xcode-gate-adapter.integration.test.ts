import { access, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LocalArtifactStore,
  VerificationGateClass,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import { afterEach, expect, it, vi } from "vitest";

import { createXcodeVerificationGatePlatformAdapter } from "../src/xcode-gate-adapter.js";

const roots: string[] = [];

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
  expect(processRunner).not.toHaveBeenCalled();
});
