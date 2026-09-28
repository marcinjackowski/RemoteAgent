import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { canonicalDigest } from "@remoteagent/contracts";
import type { SubscriptionModelRole } from "@remoteagent/model-runtime";
import { afterEach, expect, it } from "vitest";

import { EngineeringDebugJournal } from "../src/engineering-debug-journal.js";
import {
  assertEngineeringLiveQualificationAuthority,
  collectEngineeringLivePreflightEvidence,
  createAfterEngineeringLivePreflight,
  ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
  ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES,
  ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS,
  engineeringLiveBenchmarkPathsFromEnv,
  engineeringLiveQualificationSelectionFromEnv,
  loadEngineeringBenchmarkManifest,
  loadEngineeringBenchmarkOverlay,
  projectEngineeringLiveTerminal,
} from "../src/engineering-live-qualification.js";
import {
  VERIFICATION_GATE_SCHEMA_DIGEST,
  VerificationGateClass,
  VerificationGateCatalog,
  VerificationGateDefinition,
} from "@remoteagent/test-evidence";
import { computeTreeDigest } from "@remoteagent/workspace-runner";
import type { EngineeringExecutionConfig } from "../src/engineering-execution.js";
import type { ProductionEngineeringModelRouting } from "../src/engineering-model-routing.js";
import { createAfterMobl2023LiveProfileContract } from "./engineering-live-full-flow-profile-contract.js";

const roots: string[] = [];
const digest = (value: string) => canonicalDigest(value);
const run = promisify(execFile);

it("projects typed live terminal stops without inventing durable evidence", () => {
  expect(
    projectEngineeringLiveTerminal({
      terminalReasonCode: "GATE_CORRECTION_LIMIT_EXHAUSTED",
      hasDurableCommit: false,
      hasDurableEvidence: true,
    }),
  ).toEqual({
    engineering_outcome: "BLOCKED",
    terminal_reason_code: "GATE_CORRECTION_LIMIT_EXHAUSTED",
    next_safe_step: "RETRY",
    reconciliation_required: false,
  });
  expect(
    projectEngineeringLiveTerminal({
      terminalReasonCode: "COMPLETED",
      hasDurableCommit: false,
      hasDurableEvidence: false,
    }),
  ).toEqual({
    engineering_outcome: "INCOMPLETE",
    terminal_reason_code: "COMPLETED",
    next_safe_step: "RECONCILE",
    reconciliation_required: true,
  });
  expect(
    projectEngineeringLiveTerminal({
      terminalReasonCode: "COMPLETED",
      hasDurableCommit: true,
      hasDurableEvidence: true,
    }).engineering_outcome,
  ).toBe("COMPLETED");
});

async function canonicalGitFixture(
  options: { trustedEvaluatorInputs?: boolean; evaluatorContent?: string } = {},
) {
  const trustedEvaluatorInputs = options.trustedEvaluatorInputs === true;
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra055-live-preflight-")));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "Sources"), { recursive: true });
  await mkdir(join(repo, "Tests"), { recursive: true });
  await writeFile(join(repo, "Sources", "A.swift"), "// fixture\n");
  await writeFile(join(repo, "Sources", "Screen.swift"), "// fixture\n");
  await writeFile(join(repo, "Tests", "Probe.swift"), "// fixture\n");
  await writeFile(join(repo, "Tests", "Planning.swift"), "// fixture\n");
  const git = (args: string[]) => run("git", args, { cwd: repo });
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "test"]);
  await git(["add", "."]);
  await git(["commit", "-qm", "fixture"]);
  const { stdout } = await git(["rev-parse", "HEAD"]);
  const seed = stdout.trim();
  const manifestPath = join(root, "manifest.json");
  const overlayPath = join(root, "overlay.json");
  const configPath = join(root, "engineering.json");
  const developerPath = join(root, "Developer");
  const xcodebuildPath = join(root, "xcodebuild");
  const asset = join(root, "asset.pdf");
  await mkdir(developerPath);
  await writeFile(xcodebuildPath, "");
  await writeFile(asset, "");
  await writeFile(configPath, "{}");
  const source = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(
      join(process.cwd(), "test/engineering-evals/fixtures/synthetic-manifest.json"),
      "utf8",
    ),
  );
  source.targets.push({ target_id: "probe", paths: ["Tests/Planning.swift"], kind: "test" });
  source.slices[0].mutation_target_ids.push("probe");
  source.criteria[0].related_target_ids.push("probe");
  const executionConfigDigest = digest("execution");
  const gateCatalogDigest = digest("catalog");
  const manifest = {
    ...source,
    model_policy: { ...source.model_policy, providers: ["codex_cli", "claude_code"] },
    repository_id: "synthetic-repo",
    seed_sha: seed,
    execution_config_digest: executionConfigDigest,
    gate_catalog_digest: gateCatalogDigest,
    gate_schema_digest: VERIFICATION_GATE_SCHEMA_DIGEST,
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const loaded = await (
    await import("../src/engineering-live-qualification.js")
  ).loadEngineeringBenchmarkManifest(manifestPath);
  const overlay = {
    benchmark_id: manifest.benchmark_id,
    version: 1,
    manifest_digest: loaded.canonical_manifest_digest,
    raw_source_bytes_digest: loaded.raw_source_bytes_digest,
    canonical_manifest_digest: loaded.canonical_manifest_digest,
    objective: "synthetic objective",
    objective_digest: manifest.objective_digest,
    execution_config_path: configPath,
    asset_refs: [asset],
    xcode: {
      developer_path: developerPath,
      xcodebuild_path: xcodebuildPath,
      sdk: "iphonesimulator",
      destination: "platform=iOS Simulator",
      simulator_mapping: { iOS: "platform=iOS Simulator" },
    },
    profiles: {
      DESIGNER: "codex-live",
      IMPLEMENTER: "codex-live",
      REVIEWER: "claude-live",
      VERIFIER: "claude-live",
    },
  };
  await writeFile(overlayPath, JSON.stringify(overlay));
  const xcodeGate = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "gate",
    gate_class: VerificationGateClass.TEST,
    executable: xcodebuildPath,
    argv: [
      "-project",
      "Fake.xcodeproj",
      "-destination",
      "platform=iOS Simulator",
      "-resultBundlePath",
      ".remoteagent-xcode/TestResults.xcresult",
      "-only-testing:SharedTests/SafetyAlertTests",
      ...(trustedEvaluatorInputs
        ? [
            "-only-testing:SharedTests/SafetyAlertTests/testEmergencyResourceButtonsRetainRealURLAndAnalyticsBehavior()",
          ]
        : []),
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
    ...(trustedEvaluatorInputs
      ? {
          trusted_evaluator_inputs: {
            files: [
              {
                relative_path: "Tests/Probe.swift",
                content: options.evaluatorContent ?? "import XCTest\n",
                content_digest: `sha256:${createHash("sha256")
                  .update(options.evaluatorContent ?? "import XCTest\n")
                  .digest("hex")}`,
              },
            ],
            required_executed_test_ids: [
              "SharedTests/SafetyAlertTests/testEmergencyResourceButtonsRetainRealURLAndAnalyticsBehavior()",
            ],
          },
        }
      : {}),
  });
  const executionConfig = {
    repositoryId: "synthetic-repo",
    configDigest: executionConfigDigest,
    workspaceConfig: { repositories: { "synthetic-repo": { sourcePath: repo } } },
    writePathAllowlist: ["Sources/Screen.swift", "Tests/Planning.swift"],
    testPathAllowlist: ["Tests/Planning.swift"],
    catalog: {
      config_digest: gateCatalogDigest,
      definitions: [xcodeGate],
      get: (id: string) =>
        id === "gate"
          ? {
              ...xcodeGate,
              required_mutation_paths: ["Sources/Screen.swift"],
              required_test_paths: [],
              implementation_context: [{ kind: "READ", relative_path: "Sources/Screen.swift" }],
            }
          : undefined,
    },
  } as unknown as EngineeringExecutionConfig;
  return {
    root,
    repo,
    manifestPath,
    overlayPath,
    overlay,
    configPath,
    xcodebuildPath,
    executionConfig,
    paths: { manifestPath, overlayPath },
    selection: {
      invocation_id: "live-1",
      implementer_profile: "codex-live",
      reviewer_profile: "claude-live",
    },
    routing: routing(),
  };
}

type LiveQualificationFixture = Awaited<ReturnType<typeof canonicalGitFixture>>;

async function useActualGateCatalog(
  fixture: LiveQualificationFixture,
  definitionOverride?: ReturnType<LiveQualificationFixture["executionConfig"]["catalog"]["get"]>,
  extraDefinitions: VerificationGateDefinition[] = [],
): Promise<void> {
  const definition = definitionOverride ?? fixture.executionConfig.catalog.get("gate");
  if (definition === undefined) throw new Error("fixture gate missing");
  const catalog = await VerificationGateCatalog.create({
    definitions: [definition, ...extraDefinitions],
    executable_allowlist: [definition.executable],
  });
  Object.assign(fixture.executionConfig, { catalog });
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
    gate_catalog_digest: string;
  };
  manifest.gate_catalog_digest = catalog.config_digest;
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const loadedManifest = await loadEngineeringBenchmarkManifest(fixture.manifestPath);
  const overlay = JSON.parse(await readFile(fixture.overlayPath, "utf8")) as Record<
    string,
    unknown
  >;
  overlay.manifest_digest = loadedManifest.canonical_manifest_digest;
  overlay.canonical_manifest_digest = loadedManifest.canonical_manifest_digest;
  overlay.raw_source_bytes_digest = loadedManifest.raw_source_bytes_digest;
  await writeFile(fixture.overlayPath, JSON.stringify(overlay));
  const loadedOverlay = await loadEngineeringBenchmarkOverlay(fixture.overlayPath);
  Object.assign(fixture.overlay, loadedOverlay.overlay);
}

async function rewriteProfileIdentity(
  fixture: LiveQualificationFixture,
  benchmarkId: string,
  evaluation: string,
): Promise<void> {
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as Record<
    string,
    unknown
  > & { projection_versions: Record<string, string> };
  manifest.benchmark_id = benchmarkId;
  manifest.projection_versions.evaluation = evaluation;
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const loadedManifest = await loadEngineeringBenchmarkManifest(fixture.manifestPath);
  const overlay = JSON.parse(await readFile(fixture.overlayPath, "utf8")) as Record<
    string,
    unknown
  >;
  overlay.benchmark_id = benchmarkId;
  overlay.manifest_digest = loadedManifest.canonical_manifest_digest;
  overlay.canonical_manifest_digest = loadedManifest.canonical_manifest_digest;
  overlay.raw_source_bytes_digest = loadedManifest.raw_source_bytes_digest;
  await writeFile(fixture.overlayPath, JSON.stringify(overlay));
}

function invocation(role: SubscriptionModelRole, profile: "codex-live" | "claude-live") {
  return {
    schema_version: 1 as const,
    role,
    provider: profile === "codex-live" ? ("codex_cli" as const) : ("claude_code" as const),
    profile_name: profile,
    client_version: "qualified-client-1",
    model: profile === "codex-live" ? "gpt-5.6-codex" : "claude-opus-4-8",
    executable_digest: digest(`${profile}:executable`),
    deployment_config_digest: digest("deployment"),
    profile_config_digest: digest(`${profile}:config`),
  };
}

function routing(): ProductionEngineeringModelRouting {
  const invocations = {
    DESIGNER: invocation("DESIGNER", "codex-live"),
    IMPLEMENTER: invocation("IMPLEMENTER", "codex-live"),
    REVIEWER: invocation("REVIEWER", "claude-live"),
    VERIFIER: invocation("VERIFIER", "claude-live"),
  };
  return {
    authority: "OFFICIAL_SUBSCRIPTION_CLI",
    deployment: {} as never,
    deploymentConfigDigest: digest("deployment"),
    roles: {} as never,
    forRole: (role) => ({ invocation: invocations[role] }) as never,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("scales the outer live timeout with the diagnostic budget multiplier", () => {
  expect(ENGINEERING_LIVE_EXECUTION_BUDGET_MS).toBe(6 * 60 * 60_000);
  expect(ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS).toBe(6 * 60 * 60_000 + 15 * 60_000);
  expect(ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS).toBeGreaterThan(
    ENGINEERING_LIVE_EXECUTION_BUDGET_MS,
  );
});

it("keeps live qualification disabled unless the complete explicit selection is present", () => {
  expect(engineeringLiveQualificationSelectionFromEnv({})).toBeNull();
  expect(() =>
    engineeringLiveQualificationSelectionFromEnv({
      RA_RUN_LIVE_IOS_ENGINEERING: "1",
      RA_LIVE_ENGINEERING_INVOCATION_ID: "live-1",
      RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE: "codex-live",
    }),
  ).toThrow(/RA_LIVE_ENGINEERING_REVIEWER_PROFILE/u);
});

it("requires absolute manifest and overlay paths only when live mode is enabled", () => {
  expect(engineeringLiveBenchmarkPathsFromEnv({})).toBeNull();
  expect(() =>
    engineeringLiveBenchmarkPathsFromEnv({ RA_RUN_LIVE_IOS_ENGINEERING: "1" }),
  ).toThrow();
  expect(() =>
    engineeringLiveBenchmarkPathsFromEnv({
      RA_RUN_LIVE_IOS_ENGINEERING: "1",
      RA_ENGINEERING_BENCHMARK_MANIFEST_PATH: "relative",
      RA_ENGINEERING_BENCHMARK_OVERLAY_PATH: "/tmp/overlay.json",
    }),
  ).toThrow(/MANIFEST_PATH.*absolute/u);
});

it("runs the canonical preflight before creating models and freezes its complete result", async () => {
  const fixture = await canonicalGitFixture();
  const before = await computeTreeDigest(fixture.repo);
  let calls = 0;
  const result = await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => {
      calls += 1;
      return preflight.authority;
    },
  );
  expect(calls).toBe(1);
  expect(Object.isFrozen(result.preflight)).toBe(true);
  expect(result.preflight.resolved.raw_source_bytes_digest).toBe(
    result.preflight.resolved.manifest.raw_source_bytes_digest,
  );
  expect(result.preflight.resolved.canonical_manifest_digest).toBe(
    result.preflight.resolved.manifest.canonical_manifest_digest,
  );
  expect(result.preflight.ownership.gate_ids).toEqual(["gate"]);
  expect(result.preflight.authority.authority).toBe("EXPLICIT_SUBSCRIPTION_ROUTE");
  expect(await computeTreeDigest(fixture.repo)).toBe(before);
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
        requireHostEvidence: true,
      },
      () => true,
    ),
  ).rejects.toThrow(/host preflight evidence/u);
});

it("rejects a manifest gate whose required test path has no TEST target before the factory", async () => {
  const fixture = await canonicalGitFixture();
  await useActualGateCatalog(fixture, {
    ...fixture.executionConfig.catalog.get("gate")!,
    required_test_paths: [],
  });
  await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => preflight,
  );
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
    targets: Array<{ target_id: string; kind: string; paths: string[] }>;
  };
  const testTarget = manifest.targets.find((target) => target.kind.toUpperCase() === "TEST");
  if (testTarget === undefined) throw new Error("canonical fixture test target is missing");
  testTarget.kind = "source";
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  const loadedManifest = await loadEngineeringBenchmarkManifest(fixture.manifestPath);
  const overlay = JSON.parse(await readFile(fixture.overlayPath, "utf8")) as Record<
    string,
    unknown
  >;
  overlay.manifest_digest = loadedManifest.canonical_manifest_digest;
  overlay.canonical_manifest_digest = loadedManifest.canonical_manifest_digest;
  overlay.raw_source_bytes_digest = loadedManifest.raw_source_bytes_digest;
  await writeFile(fixture.overlayPath, JSON.stringify(overlay));

  let callbackCalls = 0;
  let factoryCalls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        callbackCalls += 1;
        factoryCalls += 1;
      },
    ),
  ).rejects.toThrow(/Too small: expected array to have >=1 items/u);
  expect(callbackCalls).toBe(0);
  expect(factoryCalls).toBe(0);
});

it.each([
  ["unsupported evaluation", "MOBL-2023-full-flow-v1", "unknown", /unsupported or missing/u],
  ["reserved ID with legacy evaluation", "MOBL-2023-full-flow-v1", "v1", /reserved full-flow/u],
  ["full-flow evaluation with wrong ID", "synthetic-ios", "full-flow-v1", /reserved benchmark/u],
])(
  "rejects %s before the model factory after canonical binding",
  async (_name, benchmarkId, evaluation, expectedError) => {
    const fixture = await canonicalGitFixture();
    await rewriteProfileIdentity(fixture, benchmarkId, evaluation);
    let factoryCalls = 0;
    let callbackCalls = 0;
    await expect(
      createAfterEngineeringLivePreflight(
        {
          paths: fixture.paths,
          executionConfigPath: fixture.configPath,
          selection: fixture.selection,
          executionConfig: fixture.executionConfig,
          routing: fixture.routing,
        },
        (preflight) => {
          callbackCalls += 1;
          expect(preflight.resolved.manifest.manifest.benchmark_id).toBe(benchmarkId);
          expect(preflight.resolved.manifest.manifest.projection_versions.evaluation).toBe(
            evaluation,
          );
          return createAfterMobl2023LiveProfileContract(
            {
              manifest: preflight.resolved.manifest.manifest,
              executionConfig: fixture.executionConfig,
              nodeExecutable: process.execPath,
              swiftgenExecutable: "/usr/bin/swiftgen",
              xcodebuildPath: fixture.overlay.xcode.xcodebuild_path,
            },
            () => {
              factoryCalls += 1;
              return true;
            },
          );
        },
      ),
    ).rejects.toThrow(expectedError);
    expect(callbackCalls).toBe(1);
    expect(factoryCalls).toBe(0);
  },
);

it("rejects a stale profile manifest binding before callback and factory", async () => {
  const fixture = await canonicalGitFixture();
  await rewriteProfileIdentity(fixture, "MOBL-2023-full-flow-v1", "full-flow-v1");
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
    projection_versions: { evaluation: string };
  };
  manifest.projection_versions.evaluation = "v1";
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  let callbackCalls = 0;
  let factoryCalls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        callbackCalls += 1;
        factoryCalls += 1;
      },
    ),
  ).rejects.toThrow(/manifest.*overlay|overlay.*manifest|drift/u);
  expect(callbackCalls).toBe(0);
  expect(factoryCalls).toBe(0);
});

it("binds trusted evaluator inputs into live preflight identities while preserving legacy gates", async () => {
  const fixture = await canonicalGitFixture({ trustedEvaluatorInputs: true });
  const trustedDefinition = fixture.executionConfig.catalog.get("gate");
  if (trustedDefinition === undefined || trustedDefinition.trusted_evaluator_inputs === undefined)
    throw new Error("trusted evaluator fixture gate missing");
  await useActualGateCatalog(fixture, trustedDefinition);
  let trustedFactoryCalls = 0;
  const trustedResult = await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => {
      trustedFactoryCalls += 1;
      return preflight;
    },
  );
  const legacyDefinition = { ...trustedDefinition, trusted_evaluator_inputs: undefined };
  await useActualGateCatalog(fixture, legacyDefinition);
  const legacyResult = await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => preflight,
  );
  const changedDefinition = {
    ...trustedDefinition,
    trusted_evaluator_inputs: {
      ...trustedDefinition.trusted_evaluator_inputs,
      files: trustedDefinition.trusted_evaluator_inputs.files.map((file) => ({
        ...file,
        content: `${file.content}// changed evaluator input\n`,
        content_digest: `sha256:${createHash("sha256").update(`${file.content}// changed evaluator input\n`).digest("hex")}`,
      })),
    },
  };
  const changedCatalog = await VerificationGateCatalog.create({
    definitions: [changedDefinition],
    executable_allowlist: [changedDefinition.executable],
  });
  Object.assign(fixture.executionConfig, { catalog: changedCatalog });
  let staleFactoryCalls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        staleFactoryCalls += 1;
      },
    ),
  ).rejects.toThrow(/execution drift/u);
  expect(staleFactoryCalls).toBe(0);
  await useActualGateCatalog(fixture, trustedDefinition);
  Object.assign(fixture.executionConfig, { catalog: changedCatalog });
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        staleFactoryCalls += 1;
      },
    ),
  ).rejects.toThrow(/execution drift/u);
  expect(staleFactoryCalls).toBe(0);
  await useActualGateCatalog(fixture, changedDefinition);
  const trustedChangedResult = await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => preflight,
  );
  expect(trustedFactoryCalls).toBe(1);
  expect(trustedResult.preflight.resolved.manifest.manifest.gate_catalog_digest).not.toBe(
    legacyResult.preflight.resolved.manifest.manifest.gate_catalog_digest,
  );
  expect(trustedResult.preflight.resolved.manifest.manifest.execution_config_digest).toBe(
    legacyResult.preflight.resolved.manifest.manifest.execution_config_digest,
  );
  expect(trustedResult.preflight.resolved.manifest.manifest.gate_catalog_digest).not.toBe(
    trustedChangedResult.preflight.resolved.manifest.manifest.gate_catalog_digest,
  );
  expect(trustedResult.preflight.resolved.canonical_manifest_digest).not.toBe(
    trustedChangedResult.preflight.resolved.canonical_manifest_digest,
  );
  expect(trustedResult.preflight.resolved.canonical_manifest_digest).not.toBe(
    legacyResult.preflight.resolved.canonical_manifest_digest,
  );
});

it("rejects stale trusted evaluator configuration and selectors before the factory", async () => {
  const stale = await canonicalGitFixture({ trustedEvaluatorInputs: true });
  Object.assign(stale.executionConfig, { configDigest: digest("stale-execution") });
  let calls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: stale.paths,
        executionConfigPath: stale.configPath,
        selection: stale.selection,
        executionConfig: stale.executionConfig,
        routing: stale.routing,
      },
      () => {
        calls += 1;
      },
    ),
  ).rejects.toThrow(/execution drift/u);
  expect(calls).toBe(0);

  const missingSelector = await canonicalGitFixture({ trustedEvaluatorInputs: true });
  const parsedGate = missingSelector.executionConfig.catalog.get("gate");
  if (parsedGate === undefined || parsedGate.trusted_evaluator_inputs === undefined)
    throw new Error("trusted evaluator fixture gate missing");
  expect(() =>
    VerificationGateDefinition.parse({
      ...parsedGate,
      trusted_evaluator_inputs: {
        ...parsedGate.trusted_evaluator_inputs,
        required_executed_test_ids: ["SharedTests/SafetyAlertTests/missing()"],
      },
    }),
  ).toThrow();
});

it("rejects trusted evaluator ownership overlapping a target in another slice", async () => {
  const fixture = await canonicalGitFixture({ trustedEvaluatorInputs: true });
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
    targets: Array<Record<string, unknown>>;
    slices: Array<Record<string, unknown>>;
    criteria: Array<Record<string, unknown>>;
  };
  manifest.targets.push({
    target_id: "probe-protected",
    paths: ["Tests/Probe.swift"],
    kind: "test",
  });
  manifest.targets.push({
    target_id: "probe-source",
    paths: ["Sources/Screen.swift"],
    kind: "source",
  });
  manifest.slices.push({
    slice_id: "probe-slice",
    mutation_target_ids: ["probe-protected", "probe-source"],
    required_read_context: [],
  });
  manifest.criteria.push({
    criterion_id: "probe-criterion",
    owning_slice_id: "probe-slice",
    required_gate_ids: ["other-gate"],
    executable_selector_ids: ["selector"],
    related_target_ids: ["probe-protected"],
    expected_outcomes: { baseline: "PASS", current: "PASS" },
  });
  await writeFile(fixture.manifestPath, JSON.stringify(manifest));
  Object.assign(fixture.executionConfig, {
    writePathAllowlist: ["Sources/Screen.swift", "Tests/Planning.swift", "Tests/Probe.swift"],
    testPathAllowlist: ["Tests/Planning.swift", "Tests/Probe.swift"],
  });
  const evaluatorGate = fixture.executionConfig.catalog.get("gate")!;
  const otherGate = VerificationGateDefinition.parse({
    ...evaluatorGate,
    gate_id: "other-gate",
    trusted_evaluator_inputs: undefined,
    required_mutation_paths: [],
    implementation_context: undefined,
  });
  await useActualGateCatalog(fixture, evaluatorGate, [otherGate]);
  let factoryCalls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        factoryCalls += 1;
      },
    ),
  ).rejects.toThrow(/ownership/u);
  expect(factoryCalls).toBe(0);
  // Same two slices and gates must pass when only the target path stops colliding.
  const siblingManifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  siblingManifest.targets.find(
    (target: { target_id: string }) => target.target_id === "probe-protected",
  ).paths = ["Tests/Sibling.swift"];
  await writeFile(fixture.manifestPath, JSON.stringify(siblingManifest));
  Object.assign(fixture.executionConfig, {
    writePathAllowlist: [
      "Sources/Screen.swift",
      "Tests/Planning.swift",
      "Tests/Probe.swift",
      "Tests/Sibling.swift",
    ],
    testPathAllowlist: ["Tests/Planning.swift", "Tests/Probe.swift", "Tests/Sibling.swift"],
  });
  await useActualGateCatalog(fixture, evaluatorGate, [otherGate]);
  await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    () => {
      factoryCalls += 1;
    },
  );
  expect(factoryCalls).toBe(1);
});

it("rejects malformed Xcode result bundle before factory invocation", async () => {
  const fixture = await canonicalGitFixture();
  const originalGet = fixture.executionConfig.catalog.get;
  const validGate = originalGet("gate");
  if (validGate === undefined) throw new Error("fixture gate missing");
  fixture.executionConfig.catalog.get = (id: string) =>
    id === "gate"
      ? {
          ...validGate,
          argv: validGate.argv.filter(
            (argument) => argument !== "-resultBundlePath" && !argument.endsWith(".xcresult"),
          ),
        }
      : undefined;
  let calls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        calls += 1;
        return true;
      },
    ),
  ).rejects.toThrow(/result bundle|resultBundlePath|exactly one -resultBundlePath/u);
  expect(calls).toBe(0);
});

it("collects exact injectable host evidence and rejects unsafe probe results", async () => {
  const fixture = await canonicalGitFixture();
  expect(ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES).toBe(40 * 1024 * 1024 * 1024);
  const result = await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => preflight,
  );
  const base = {
    resolved: result.preflight.resolved,
    executionConfig: fixture.executionConfig,
    xcodebuildPath: fixture.xcodebuildPath,
    rootPath: fixture.root,
    probeXcodeVersion: async () => ({ version: "16.4", build: "16F6" }),
    probeAvailableDiskBytes: async () => ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES,
    probePostgres: async () => 1,
  };
  const evidence = await collectEngineeringLivePreflightEvidence({
    ...base,
    routing: fixture.routing,
  });
  expect(Object.keys(evidence.invocation_identities).sort()).toEqual([
    "DESIGNER",
    "IMPLEMENTER",
    "REVIEWER",
    "VERIFIER",
  ]);
  expect(evidence.invocation_identities.IMPLEMENTER).toBeDefined();
  expect(evidence.invocation_identities.IMPLEMENTER!.provider).toBe("codex_cli");
  expect(JSON.stringify(evidence)).not.toContain("objective");
  expect(evidence.available_disk_bytes).toBeGreaterThanOrEqual(
    ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES,
  );
  await expect(
    collectEngineeringLivePreflightEvidence({
      ...base,
      routing: fixture.routing,
      probeAvailableDiskBytes: async () => ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES - 1,
    }),
  ).rejects.toThrow(/disk/u);
  await expect(
    collectEngineeringLivePreflightEvidence({
      ...base,
      routing: fixture.routing,
      probeAvailableDiskBytes: async () => 32 * 1024 * 1024 * 1024,
    }),
  ).rejects.toThrow(/disk/u);
  await expect(
    collectEngineeringLivePreflightEvidence({
      ...base,
      routing: fixture.routing,
      probeXcodeVersion: async () => ({ version: "bad space", build: "bad" }),
    }),
  ).rejects.toThrow(/xcode version/u);
  await expect(
    collectEngineeringLivePreflightEvidence({
      ...base,
      routing: fixture.routing,
      probeAvailableDiskBytes: async () => 1,
    }),
  ).rejects.toThrow(/disk/u);
  await expect(
    collectEngineeringLivePreflightEvidence({
      ...base,
      routing: fixture.routing,
      probePostgres: async () => 2,
    }),
  ).rejects.toThrow(/PostgreSQL/u);
  await expect(
    collectEngineeringLivePreflightEvidence({
      ...base,
      routing: fixture.routing,
      resolved: {
        ...result.preflight.resolved,
        invocation_digests: { DESIGNER: result.preflight.resolved.invocation_digests.DESIGNER! },
      },
    }),
  ).rejects.toThrow(/role identity/u);
});

it("rejects a non-canonical xcodebuild probe path before running host probes", async () => {
  const fixture = await canonicalGitFixture();
  const result = await createAfterEngineeringLivePreflight(
    {
      paths: fixture.paths,
      executionConfigPath: fixture.configPath,
      selection: fixture.selection,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
    },
    (preflight) => preflight,
  );
  const alternateXcodebuildPath = join(fixture.root, "alternate-xcodebuild");
  await writeFile(alternateXcodebuildPath, "");
  let xcodeVersionProbes = 0;
  let diskProbes = 0;
  let postgresProbes = 0;

  await expect(
    collectEngineeringLivePreflightEvidence({
      resolved: result.preflight.resolved,
      executionConfig: fixture.executionConfig,
      routing: fixture.routing,
      xcodebuildPath: alternateXcodebuildPath,
      rootPath: fixture.root,
      probeXcodeVersion: async () => {
        xcodeVersionProbes += 1;
        return { version: "16.4", build: "16F6" };
      },
      probeAvailableDiskBytes: async () => {
        diskProbes += 1;
        return 32 * 1024 * 1024 * 1024;
      },
      probePostgres: async () => {
        postgresProbes += 1;
        return 1;
      },
    }),
  ).rejects.toThrow(/xcodebuild path drift/u);
  expect(xcodeVersionProbes).toBe(0);
  expect(diskProbes).toBe(0);
  expect(postgresProbes).toBe(0);
});

it("rejects drift before factory invocation and leaves the git tree unchanged", async () => {
  for (const mutate of [
    async (fixture: Awaited<ReturnType<typeof canonicalGitFixture>>) => {
      fixture.overlay.objective = "drifted";
      await writeFile(fixture.overlayPath, JSON.stringify(fixture.overlay));
    },
    async (fixture: Awaited<ReturnType<typeof canonicalGitFixture>>) => {
      const originalGet = fixture.executionConfig.catalog.get.bind(fixture.executionConfig.catalog);
      Object.assign(fixture.executionConfig.catalog, {
        get: (id: string) => (id === "gate" ? undefined : originalGet(id)),
      });
    },
    async (fixture: Awaited<ReturnType<typeof canonicalGitFixture>>) => {
      const link = join(fixture.root, "manifest-link.json");
      await symlink(fixture.manifestPath, link);
      fixture.paths.manifestPath = link;
    },
    async (fixture: Awaited<ReturnType<typeof canonicalGitFixture>>) => {
      const link = join(fixture.root, "overlay-link.json");
      await symlink(fixture.overlayPath, link);
      fixture.paths.overlayPath = link;
    },
  ]) {
    const fixture = await canonicalGitFixture();
    const before = await computeTreeDigest(fixture.repo);
    await mutate(fixture);
    let calls = 0;
    await expect(
      createAfterEngineeringLivePreflight(
        {
          paths: fixture.paths,
          executionConfigPath: fixture.configPath,
          selection: fixture.selection,
          executionConfig: fixture.executionConfig,
          routing: fixture.routing,
        },
        () => {
          calls += 1;
          return true;
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await computeTreeDigest(fixture.repo)).toBe(before);
  }
});

it("rejects a dirty source checkout before creating any live model", async () => {
  const fixture = await canonicalGitFixture();
  await writeFile(join(fixture.repo, "Sources", "dirty.swift"), "// dirty\n");
  const before = await computeTreeDigest(fixture.repo);
  let calls = 0;
  await expect(
    createAfterEngineeringLivePreflight(
      {
        paths: fixture.paths,
        executionConfigPath: fixture.configPath,
        selection: fixture.selection,
        executionConfig: fixture.executionConfig,
        routing: fixture.routing,
      },
      () => {
        calls += 1;
        return true;
      },
    ),
  ).rejects.toThrow(/source checkout is dirty/u);
  expect(calls).toBe(0);
  expect(await computeTreeDigest(fixture.repo)).toBe(before);
});

it.each(["api_key", "oauth_token"])(
  "rejects a complete-shaped private overlay field: %s",
  async (field) => {
    const fixture = await canonicalGitFixture();
    const before = await computeTreeDigest(fixture.repo);
    const overlay = { ...fixture.overlay, [field]: "forbidden" };
    await writeFile(fixture.overlayPath, JSON.stringify(overlay));
    let calls = 0;
    await expect(
      createAfterEngineeringLivePreflight(
        {
          paths: fixture.paths,
          executionConfigPath: fixture.configPath,
          selection: fixture.selection,
          executionConfig: fixture.executionConfig,
          routing: fixture.routing,
        },
        () => {
          calls += 1;
          return true;
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await computeTreeDigest(fixture.repo)).toBe(before);
  },
);

it("binds the explicit implementer and reviewer profiles without fallback", () => {
  const selected = engineeringLiveQualificationSelectionFromEnv({
    RA_RUN_LIVE_IOS_ENGINEERING: "1",
    RA_LIVE_ENGINEERING_INVOCATION_ID: "live-1",
    RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE: "codex-live",
    RA_LIVE_ENGINEERING_REVIEWER_PROFILE: "claude-live",
  });
  expect(selected).not.toBeNull();
  const authority = assertEngineeringLiveQualificationAuthority({
    selection: selected!,
    routing: routing(),
    executionConfig: { configDigest: digest("execution") } as EngineeringExecutionConfig,
  });
  expect(authority).toEqual({
    authority: "EXPLICIT_SUBSCRIPTION_ROUTE",
    invocation_id: "live-1",
    implementer_invocation_digest: canonicalDigest(invocation("IMPLEMENTER", "codex-live")),
    reviewer_invocation_digest: canonicalDigest(invocation("REVIEWER", "claude-live")),
    execution_config_digest: digest("execution"),
    external_writes: "FORBIDDEN",
  });
  expect(() =>
    assertEngineeringLiveQualificationAuthority({
      selection: { ...selected!, reviewer_profile: "codex-live" },
      routing: routing(),
      executionConfig: { configDigest: digest("execution") } as EngineeringExecutionConfig,
    }),
  ).toThrow(/REVIEWER profile/u);
});

it("refuses to reuse a journal identity from an earlier live run", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra053-live-journal-")));
  roots.push(root);
  const first = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "live-1",
  });
  await first.close();
  await expect(
    EngineeringDebugJournal.create({ artifactRoot: root, invocationId: "live-1" }),
  ).rejects.toMatchObject({ code: "EEXIST" });
  const second = await EngineeringDebugJournal.create({
    artifactRoot: root,
    invocationId: "live-2",
  });
  expect(second.filePath).not.toBe(first.filePath);
  await second.close();
});
