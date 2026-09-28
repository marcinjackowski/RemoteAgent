import { canonicalDigest, sha256Digest } from "@remoteagent/contracts";
import { execFile } from "node:child_process";
import { readFile, realpath, stat, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import * as z from "zod";

import {
  createEngineeringGateFailureMapping,
  assertEngineeringExecutionPlanningFeasibility,
  type EngineeringExecutionConfig,
  type EngineeringGateFailureMapping,
} from "./engineering-execution.js";
import { ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER } from "./engineering-debug-journal.js";
import type { ProductionEngineeringModelRouting } from "./engineering-model-routing.js";
import {
  validateEngineeringGateOwnership,
  VERIFICATION_GATE_SCHEMA_DIGEST,
} from "@remoteagent/test-evidence";
import { worktreeHead } from "@remoteagent/workspace-runner";
import { validateXcodeTestGateResultBundlePath } from "./xcode-gate-adapter.js";
import type { EngineeringRuntimeStopCode } from "@remoteagent/agent-orchestrator";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const MAX_BENCHMARK_DOCUMENT_BYTES = 1024 * 1024;
// A measured cold Xcode build allocated about 29 GiB in DerivedData and simulator
// scratch space. Keep a 40 GiB admission margin so a live run fails before any
// model invocation when the host cannot safely complete that build.
export const ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES = 40 * 1024 * 1024 * 1024;
const canonicalId = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const execFileAsync = promisify(execFile);
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.startsWith("/") && !v.split("/").includes(".."));
const physicalPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => isAbsolute(v) && !v.split("/").includes(".."));
const manifest = z
  .strictObject({
    benchmark_id: canonicalId,
    version: z.literal(1),
    repository_id: canonicalId,
    seed_sha: z.string().regex(/^[0-9a-f]{40}$/u),
    objective_digest: digest,
    projection_versions: z.strictObject({
      evaluation: z.string().min(1).max(128),
      finding_identity: z.string().min(1).max(128),
      gate_failure: z.string().min(1).max(128),
      journal: z.string().min(1).max(128),
    }),
    execution_config_digest: digest,
    gate_catalog_digest: digest,
    gate_schema_digest: digest,
    model_policy: z.strictObject({
      roles: z.tuple([
        z.literal("DESIGNER"),
        z.literal("IMPLEMENTER"),
        z.literal("REVIEWER"),
        z.literal("VERIFIER"),
      ]),
      providers: z
        .array(z.enum(["codex_cli", "claude_code"]))
        .min(1)
        .max(2)
        .refine(unique),
    }),
    targets: z
      .array(
        z.strictObject({
          target_id: canonicalId,
          paths: z.array(path).min(1).max(64).refine(unique),
          kind: z.preprocess(
            (value) => (typeof value === "string" ? value.toUpperCase() : value),
            z.enum(["SOURCE", "TEST", "GENERATOR"]),
          ),
        }),
      )
      .min(1)
      .max(256),
    slices: z
      .array(
        z.strictObject({
          slice_id: canonicalId,
          mutation_target_ids: z.array(canonicalId).min(1).max(256).refine(unique),
          required_read_context: z
            .array(z.strictObject({ relative_path: path, must_exist: z.boolean() }))
            .max(256),
        }),
      )
      .min(1)
      .max(128),
    criteria: z
      .array(
        z.strictObject({
          criterion_id: canonicalId,
          owning_slice_id: canonicalId,
          required_gate_ids: z.array(canonicalId).min(1).max(128).refine(unique),
          executable_selector_ids: z.array(canonicalId).min(1).max(128).refine(unique),
          related_target_ids: z.array(canonicalId).min(1).max(128).refine(unique),
          expected_outcomes: z.strictObject({
            baseline: z.enum(["PASS", "FAIL", "SKIP", "INCONCLUSIVE"]),
            current: z.enum(["PASS", "FAIL", "SKIP", "INCONCLUSIVE"]),
          }),
        }),
      )
      .min(1)
      .max(512),
    xcode: z.strictObject({
      scheme: z.string().min(1).max(128),
      platform: z.string().min(1).max(128),
      sdk: z.string().min(1).max(128),
      destination: z.string().min(1).max(512),
    }),
    evidence: z.strictObject({
      public_artifacts: z.array(z.string().max(256)).max(256),
      private_artifacts: z.array(z.string().max(256)).max(256),
    }),
  })
  .superRefine((value, ctx) => {
    for (const [field, values] of [
      ["target", value.targets.map((x) => x.target_id)],
      ["slice", value.slices.map((x) => x.slice_id)],
      ["criterion", value.criteria.map((x) => x.criterion_id)],
    ] as const)
      if (!unique(values))
        ctx.addIssue({ code: "custom", path: [field], message: "IDs must be unique" });
    for (const slice of value.slices) {
      const identities = slice.required_read_context.map((x) => x.relative_path);
      if (!unique(identities))
        ctx.addIssue({ code: "custom", path: ["slices"], message: "read context must be unique" });
    }
  });
export type EngineeringBenchmarkManifestV1 = z.infer<typeof manifest>;
const overlay = z.strictObject({
  benchmark_id: z.string().min(1),
  version: z.literal(1),
  manifest_digest: digest,
  raw_source_bytes_digest: digest,
  canonical_manifest_digest: digest,
  objective: z.string().min(1).max(65536),
  objective_digest: digest,
  execution_config_path: physicalPath,
  asset_refs: z.array(physicalPath).max(64).refine(unique),
  xcode: z.strictObject({
    developer_path: physicalPath,
    xcodebuild_path: physicalPath,
    sdk: z.string().min(1).max(128),
    destination: z.string().min(1).max(512),
    simulator_mapping: z.record(z.string(), z.string().min(1)).superRefine((v, c) => {
      if (Object.keys(v).length > 64) c.addIssue({ code: "custom", message: "bounded" });
      for (const [key, value] of Object.entries(v))
        if (key.length > 128 || value.length > 512)
          c.addIssue({ code: "custom", message: "bounded" });
    }),
  }),
  profiles: z.strictObject({
    DESIGNER: z.string().min(1).max(128),
    IMPLEMENTER: z.string().min(1).max(128),
    REVIEWER: z.string().min(1).max(128),
    VERIFIER: z.string().min(1).max(128),
  }),
});
export type EngineeringBenchmarkOverlayV1 = z.infer<typeof overlay>;
export type LoadedEngineeringBenchmarkOverlay = Readonly<{
  overlay: EngineeringBenchmarkOverlayV1;
  raw_source_bytes_digest: string;
  canonical_overlay_digest: string;
}>;
export type LoadedEngineeringBenchmarkManifest = Readonly<{
  manifest: EngineeringBenchmarkManifestV1;
  raw_source_bytes_digest: string;
  canonical_manifest_digest: string;
}>;
export type EngineeringLivePreflightEvidence = Readonly<{
  source_clean: true;
  xcode: { version: string; build: string };
  simulator: { platform: string; destination: string; mapping_digest: string };
  available_disk_bytes: number;
  postgres_select_1: 1;
  invocation_identities: Readonly<
    Record<
      string,
      Readonly<{
        provider: string;
        profile: string;
        model: string;
        client_version: string;
        descriptor_digest: string;
      }>
    >
  >;
  manifest_digest: string;
  overlay_digest: string;
  execution_config_digest: string;
  gate_catalog_digest: string;
  gate_schema_digest: string;
}>;
export type ResolvedEngineeringBenchmark = Readonly<{
  manifest: LoadedEngineeringBenchmarkManifest;
  overlay: LoadedEngineeringBenchmarkOverlay;
  manifest_digest: string;
  raw_source_bytes_digest: string;
  canonical_manifest_digest: string;
  overlay_raw_source_bytes_digest: string;
  canonical_overlay_digest: string;
  gate_failure_mapping: EngineeringGateFailureMapping;
  repository_id: string;
  source_head: string;
  invocation_digests: Readonly<Record<string, string>>;
  physical_paths: Readonly<Record<string, string>>;
}>;

export async function loadEngineeringBenchmarkManifest(
  pathname: string,
): Promise<LoadedEngineeringBenchmarkManifest> {
  const bytes = await readFile(pathname);
  if (bytes.byteLength > MAX_BENCHMARK_DOCUMENT_BYTES)
    throw new Error("benchmark manifest exceeds bounded document size");
  const parsed = manifest.parse(JSON.parse(bytes.toString("utf8")));
  return deepFreeze({
    manifest: parsed,
    raw_source_bytes_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    canonical_manifest_digest: canonicalDigest(parsed),
  });
}
export async function loadEngineeringBenchmarkOverlay(
  pathname: string,
): Promise<LoadedEngineeringBenchmarkOverlay> {
  const bytes = await readFile(pathname);
  if (bytes.byteLength > MAX_BENCHMARK_DOCUMENT_BYTES)
    throw new Error("benchmark overlay exceeds bounded document size");
  const parsed = overlay.parse(JSON.parse(bytes.toString("utf8")));
  return deepFreeze({
    overlay: parsed,
    raw_source_bytes_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    canonical_overlay_digest: canonicalDigest(parsed),
  });
}
export async function resolveEngineeringBenchmark(input: {
  manifest: LoadedEngineeringBenchmarkManifest;
  overlay: LoadedEngineeringBenchmarkOverlay;
  executionConfig: EngineeringExecutionConfig;
  routing: ProductionEngineeringModelRouting;
  readSourceHead: (sourcePath: string) => Promise<string>;
  observedExecutionConfigPath: string;
  observedGateSchemaDigest: string;
}): Promise<ResolvedEngineeringBenchmark> {
  const loaded = input.manifest;
  const m = manifest.parse(loaded.manifest);
  const loadedOverlay = input.overlay;
  const o = overlay.parse(loadedOverlay.overlay);
  if (
    m.benchmark_id !== o.benchmark_id ||
    m.version !== o.version ||
    o.manifest_digest !== loaded.canonical_manifest_digest ||
    o.canonical_manifest_digest !== loaded.canonical_manifest_digest ||
    o.raw_source_bytes_digest !== loaded.raw_source_bytes_digest ||
    o.objective_digest !== canonicalDigest(o.objective) ||
    o.objective_digest !== m.objective_digest ||
    loadedOverlay.canonical_overlay_digest !== canonicalDigest(o)
  )
    throw new Error("benchmark manifest/overlay drift");
  if (
    o.xcode.sdk !== m.xcode.sdk ||
    o.xcode.destination !== m.xcode.destination ||
    o.xcode.simulator_mapping[m.xcode.platform] !== m.xcode.destination
  )
    throw new Error("benchmark logical Xcode drift");
  if (
    input.observedExecutionConfigPath !== o.execution_config_path ||
    input.observedGateSchemaDigest !== m.gate_schema_digest ||
    m.execution_config_digest !== input.executionConfig.configDigest ||
    m.repository_id !== input.executionConfig.repositoryId ||
    m.gate_catalog_digest !== input.executionConfig.catalog.config_digest
  )
    throw new Error("benchmark execution drift");
  const repo =
    input.executionConfig.workspaceConfig.repositories[input.executionConfig.repositoryId];
  if (repo === undefined) throw new Error("benchmark repository missing");
  if (
    (await realpath(input.observedExecutionConfigPath)) !==
    (await realpath(o.execution_config_path))
  )
    throw new Error("benchmark config path drift");
  for (const physical of [
    o.execution_config_path,
    o.xcode.developer_path,
    o.xcode.xcodebuild_path,
    ...o.asset_refs,
  ]) {
    const canonical = await realpath(physical);
    if (canonical !== physical) throw new Error("benchmark physical path is not canonical");
    const metadata = await stat(canonical);
    if (physical === o.xcode.developer_path && !metadata.isDirectory())
      throw new Error("developer path must be a directory");
    if (physical !== o.xcode.developer_path && !metadata.isFile())
      throw new Error("benchmark physical path must be a file");
  }
  const sourceHead = await input.readSourceHead(repo.sourcePath);
  if (!/^[0-9a-f]{40}$/u.test(sourceHead) || sourceHead !== m.seed_sha)
    throw new Error("benchmark source seed drift");
  const sourceStatus = await execFileAsync(
    "git",
    ["-C", repo.sourcePath, "status", "--porcelain", "--untracked-files=all"],
    {
      maxBuffer: 128 * 1024,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (sourceStatus.stdout.trim() !== "") throw new Error("benchmark source checkout is dirty");
  const invocations: Record<string, string> = {};
  for (const role of ["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"] as const) {
    const binding = input.routing.forRole(role);
    if (binding.invocation.role !== role) throw new Error("benchmark invocation role drift");
    if (
      !m.model_policy.providers.includes(binding.invocation.provider) ||
      binding.invocation.profile_name !== o.profiles[role]
    )
      throw new Error("benchmark subscription route drift");
    invocations[role] = canonicalDigest(binding.invocation);
  }
  const targetIds = new Set(m.targets.map((target) => target.target_id));
  const sliceIds = new Set(m.slices.map((slice) => slice.slice_id));
  for (const slice of m.slices) {
    if (slice.mutation_target_ids.some((id) => !targetIds.has(id)))
      throw new Error("benchmark target reference drift");
    for (const context of slice.required_read_context)
      if (context.must_exist) {
        const fs = await import("node:fs/promises");
        const sourceRoot = await realpath(repo.sourcePath);
        const candidate = resolve(sourceRoot, context.relative_path);
        if (!(candidate === sourceRoot || candidate.startsWith(`${sourceRoot}/`)))
          throw new Error("benchmark read context escaped source root");
        try {
          const canonical = await realpath(candidate);
          if (!(canonical === sourceRoot || canonical.startsWith(`${sourceRoot}/`)))
            throw new Error("benchmark read context symlink escaped source root");
          await fs.access(canonical);
        } catch {
          throw new Error("benchmark required context missing");
        }
      }
  }
  const authority = (kind: string): readonly string[] =>
    kind === "SOURCE"
      ? input.executionConfig.writePathAllowlist
      : kind === "TEST"
        ? input.executionConfig.testPathAllowlist
        : (input.executionConfig.generatorCatalog?.definitions.flatMap((d) => d.output_paths) ??
          []);
  for (const target of m.targets)
    for (const targetPath of target.paths)
      if (
        !authority(target.kind).some(
          (allowed) => targetPath === allowed || targetPath.startsWith(`${allowed}/`),
        )
      )
        throw new Error("benchmark target outside authority");
  for (const criterion of m.criteria) {
    const owning = m.slices.find((slice) => slice.slice_id === criterion.owning_slice_id);
    if (
      !sliceIds.has(criterion.owning_slice_id) ||
      criterion.related_target_ids.some((id) => !targetIds.has(id)) ||
      owning === undefined ||
      criterion.required_gate_ids.some(
        (gateId) => input.executionConfig.catalog.get(gateId) === undefined,
      ) ||
      criterion.related_target_ids.some((id) => !owning.mutation_target_ids.includes(id))
    )
      throw new Error("benchmark criterion reference drift");
  }
  if (
    m.slices.some(
      (slice) => !m.criteria.some((criterion) => criterion.owning_slice_id === slice.slice_id),
    )
  )
    throw new Error("benchmark slice is uncovered");
  return deepFreeze({
    manifest: loaded,
    overlay: loadedOverlay,
    manifest_digest: canonicalDigest(m),
    raw_source_bytes_digest: loaded.raw_source_bytes_digest,
    canonical_manifest_digest: loaded.canonical_manifest_digest,
    overlay_raw_source_bytes_digest: loadedOverlay.raw_source_bytes_digest,
    canonical_overlay_digest: loadedOverlay.canonical_overlay_digest,
    gate_failure_mapping: createEngineeringGateFailureMapping({
      targets: m.targets,
      slices: m.slices.map((slice) => ({
        slice_id: slice.slice_id,
        mutation_target_ids: slice.mutation_target_ids,
        required_read_context: slice.required_read_context,
      })),
      criteria: m.criteria,
      catalog: input.executionConfig.catalog,
    }),
    repository_id: m.repository_id,
    source_head: sourceHead,
    invocation_digests: Object.freeze(invocations),
    physical_paths: Object.freeze({
      execution_config: o.execution_config_path,
      developer: o.xcode.developer_path,
      xcodebuild: o.xcode.xcodebuild_path,
    }),
  });
}

const selection = z
  .object({
    invocation_id: z.string().min(1).max(512),
    implementer_profile: z.string().min(1).max(128),
    reviewer_profile: z.string().min(1).max(128),
  })
  .strict();

export type EngineeringLiveQualificationSelection = z.infer<typeof selection>;

export const ENGINEERING_LIVE_ENV = Object.freeze({
  enabled: "RA_RUN_LIVE_IOS_ENGINEERING",
  invocationId: "RA_LIVE_ENGINEERING_INVOCATION_ID",
  implementerProfile: "RA_LIVE_ENGINEERING_IMPLEMENTER_PROFILE",
  reviewerProfile: "RA_LIVE_ENGINEERING_REVIEWER_PROFILE",
  manifestPath: "RA_ENGINEERING_BENCHMARK_MANIFEST_PATH",
  overlayPath: "RA_ENGINEERING_BENCHMARK_OVERLAY_PATH",
});

export function engineeringLiveBenchmarkPathsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { manifestPath: string; overlayPath: string } | null {
  if (env[ENGINEERING_LIVE_ENV.enabled] !== "1") return null;
  const requiredPath = (name: string) => {
    const value = required(env, name);
    if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
    return value;
  };
  return {
    manifestPath: requiredPath(ENGINEERING_LIVE_ENV.manifestPath),
    overlayPath: requiredPath(ENGINEERING_LIVE_ENV.overlayPath),
  };
}

export async function collectEngineeringLivePreflightEvidence(input: {
  resolved: ResolvedEngineeringBenchmark;
  executionConfig: EngineeringExecutionConfig;
  routing: ProductionEngineeringModelRouting;
  xcodebuildPath: string;
  rootPath: string;
  probePostgres: () => Promise<unknown>;
  probeXcodeVersion?: () => Promise<{ version: string; build: string }>;
  probeAvailableDiskBytes?: () => Promise<number>;
}): Promise<EngineeringLivePreflightEvidence> {
  if ((await realpath(input.xcodebuildPath)) !== input.resolved.physical_paths.xcodebuild)
    throw new Error("xcodebuild path drift");
  const xcode =
    input.probeXcodeVersion === undefined
      ? await execFileAsync(input.xcodebuildPath, ["-version"], {
          maxBuffer: 16 * 1024,
          env: {
            PATH: process.env.PATH,
            DEVELOPER_DIR: input.resolved.physical_paths.developer,
          },
        }).then((result) => {
          const lines = result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const version = /^Xcode\s+([0-9][0-9A-Za-z._-]{0,31})$/u.exec(lines[0] ?? "")?.[1];
          const build = /^Build version\s+([0-9A-Za-z._-]{1,64})$/u.exec(lines[1] ?? "")?.[1];
          if (version === undefined || build === undefined)
            throw new Error("xcode version probe invalid");
          return { version, build };
        })
      : await input.probeXcodeVersion();
  const version = xcode.version;
  const build = xcode.build;
  if (!/^([0-9][0-9A-Za-z._-]{0,31})$/u.test(version) || !/^[0-9A-Za-z._-]{1,64}$/u.test(build))
    throw new Error("xcode version probe invalid");
  const available =
    input.probeAvailableDiskBytes === undefined
      ? await statfs(input.rootPath).then((disk) => disk.bavail * disk.bsize)
      : await input.probeAvailableDiskBytes();
  if (!Number.isSafeInteger(available) || available < ENGINEERING_LIVE_MIN_AVAILABLE_DISK_BYTES)
    throw new Error("live qualification disk space is below the bounded minimum");
  const pg = await input.probePostgres();
  if (pg !== 1) throw new Error("live qualification PostgreSQL probe failed");
  const requiredRoles = ["DESIGNER", "IMPLEMENTER", "REVIEWER", "VERIFIER"] as const;
  if (
    Object.keys(input.resolved.invocation_digests).length !== requiredRoles.length ||
    requiredRoles.some((role) => input.resolved.invocation_digests[role] === undefined)
  )
    throw new Error("live qualification role identity set is incomplete");
  const invocations = Object.fromEntries(
    (Object.entries(input.resolved.invocation_digests) as [string, string][]).map(
      ([role, descriptorDigest]) => {
        const descriptor = input.routing.forRole(
          role as "DESIGNER" | "IMPLEMENTER" | "REVIEWER" | "VERIFIER",
        ).invocation;
        return [
          role,
          {
            provider: descriptor.provider,
            profile: descriptor.profile_name,
            model: descriptor.model,
            client_version: descriptor.client_version,
            descriptor_digest: descriptorDigest,
          },
        ];
      },
    ),
  ) as EngineeringLivePreflightEvidence["invocation_identities"];
  return deepFreeze({
    source_clean: true,
    xcode: { version, build },
    simulator: {
      platform: input.resolved.manifest.manifest.xcode.platform,
      destination: input.resolved.manifest.manifest.xcode.destination,
      mapping_digest: canonicalDigest(input.resolved.overlay.overlay.xcode.simulator_mapping),
    },
    available_disk_bytes: available,
    postgres_select_1: 1,
    invocation_identities: invocations,
    manifest_digest: input.resolved.canonical_manifest_digest,
    overlay_digest: input.resolved.canonical_overlay_digest,
    execution_config_digest: input.executionConfig.configDigest,
    gate_catalog_digest: input.resolved.manifest.manifest.gate_catalog_digest,
    gate_schema_digest: input.resolved.manifest.manifest.gate_schema_digest,
  });
}

export async function preflightEngineeringLiveBenchmark(input: {
  paths: { manifestPath: string; overlayPath: string };
  executionConfigPath: string;
  selection: EngineeringLiveQualificationSelection;
  executionConfig: EngineeringExecutionConfig;
  routing: ProductionEngineeringModelRouting;
  hostProbes?: {
    xcodebuildPath: string;
    rootPath: string;
    probePostgres: () => Promise<unknown>;
  };
  requireHostEvidence?: boolean;
}): Promise<
  Readonly<{
    resolved: ResolvedEngineeringBenchmark;
    ownership: ReturnType<typeof validateEngineeringGateOwnership>;
    authority: EngineeringLiveQualificationAuthority;
    mapping: EngineeringGateFailureMapping;
    evidence?: EngineeringLivePreflightEvidence;
  }>
> {
  const paths = engineeringLiveBenchmarkPathsFromEnv({
    RA_RUN_LIVE_IOS_ENGINEERING: "1",
    RA_ENGINEERING_BENCHMARK_MANIFEST_PATH: input.paths.manifestPath,
    RA_ENGINEERING_BENCHMARK_OVERLAY_PATH: input.paths.overlayPath,
  })!;
  const canonicalManifestPath = await realpath(paths.manifestPath);
  const canonicalOverlayPath = await realpath(paths.overlayPath);
  if (canonicalManifestPath !== paths.manifestPath || canonicalOverlayPath !== paths.overlayPath)
    throw new Error("benchmark paths must be canonical");
  const manifest = await loadEngineeringBenchmarkManifest(canonicalManifestPath);
  const overlay = await loadEngineeringBenchmarkOverlay(canonicalOverlayPath);
  const repository =
    input.executionConfig.workspaceConfig.repositories[input.executionConfig.repositoryId];
  if (repository === undefined) throw new Error("benchmark repository missing");
  const resolved = await resolveEngineeringBenchmark({
    manifest,
    overlay,
    executionConfig: input.executionConfig,
    routing: input.routing,
    readSourceHead: worktreeHead,
    observedExecutionConfigPath: input.executionConfigPath,
    observedGateSchemaDigest: VERIFICATION_GATE_SCHEMA_DIGEST,
  });
  const authority = assertEngineeringLiveQualificationAuthority({
    selection: input.selection,
    routing: input.routing,
    executionConfig: input.executionConfig,
  });
  const ownership = validateEngineeringGateOwnership({
    catalog: input.executionConfig.catalog,
    targets: manifest.manifest.targets,
    slices: manifest.manifest.slices,
    criteria: manifest.manifest.criteria,
  });
  assertEngineeringExecutionPlanningFeasibility({
    ...input.executionConfig,
    gateFailureMapping: resolved.gate_failure_mapping,
  });
  const selectedGateIds = new Set(
    manifest.manifest.criteria.flatMap((criterion) => criterion.required_gate_ids),
  );
  for (const gateId of selectedGateIds) {
    const gate = input.executionConfig.catalog.get(gateId);
    if (
      gate !== undefined &&
      gate.gate_class === "TEST" &&
      gate.executable === resolved.physical_paths.xcodebuild
    ) {
      validateXcodeTestGateResultBundlePath(gate);
    }
  }
  const evidence =
    input.hostProbes === undefined
      ? undefined
      : await collectEngineeringLivePreflightEvidence({
          resolved,
          executionConfig: input.executionConfig,
          routing: input.routing,
          ...input.hostProbes,
        });
  return deepFreeze({
    resolved,
    ownership,
    authority,
    mapping: resolved.gate_failure_mapping,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

export type EngineeringLiveBenchmarkPreflightInput = Parameters<
  typeof preflightEngineeringLiveBenchmark
>[0];
export async function createAfterEngineeringLivePreflight<T>(
  preflightInput: EngineeringLiveBenchmarkPreflightInput,
  create: (preflight: Awaited<ReturnType<typeof preflightEngineeringLiveBenchmark>>) => T,
): Promise<{
  readonly preflight: Awaited<ReturnType<typeof preflightEngineeringLiveBenchmark>>;
  readonly value: T;
}> {
  const preflight = await preflightEngineeringLiveBenchmark(preflightInput);
  if (preflightInput.requireHostEvidence === true && preflight.evidence === undefined)
    throw new Error("live qualification host preflight evidence is required");
  const value = create(preflight);
  return Object.freeze({ preflight, value });
}

/**
 * The live harness is only an outer process backstop. Keep it proportional to
 * the explicitly enlarged diagnostic token budget so it cannot terminate a
 * bounded Engineering run while its own stage, attempt, token, and deadline
 * guards still permit progress.
 */
export const ENGINEERING_LIVE_EXECUTION_BUDGET_MS =
  2 * 60 * 60_000 * ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER;
export const ENGINEERING_LIVE_QUALIFICATION_TIMEOUT_MS =
  ENGINEERING_LIVE_EXECUTION_BUDGET_MS + 15 * 60_000;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for live Engineering qualification`);
  }
  return value;
}

/** Parse the live-only contract. The default/non-live test path never authenticates a provider. */
export function engineeringLiveQualificationSelectionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EngineeringLiveQualificationSelection | null {
  if (env[ENGINEERING_LIVE_ENV.enabled] !== "1") return null;
  return selection.parse({
    invocation_id: required(env, ENGINEERING_LIVE_ENV.invocationId),
    implementer_profile: required(env, ENGINEERING_LIVE_ENV.implementerProfile),
    reviewer_profile: required(env, ENGINEERING_LIVE_ENV.reviewerProfile),
  });
}

export type EngineeringLiveQualificationAuthority = Readonly<{
  authority: "EXPLICIT_SUBSCRIPTION_ROUTE";
  invocation_id: string;
  implementer_invocation_digest: string;
  reviewer_invocation_digest: string;
  execution_config_digest: string;
  external_writes: "FORBIDDEN";
}>;

export type EngineeringLiveTerminalProjection = Readonly<{
  engineering_outcome: "COMPLETED" | "BLOCKED" | "CANCELLED" | "INCOMPLETE";
  terminal_reason_code: EngineeringRuntimeStopCode | "INCOMPLETE";
  next_safe_step: "STOP" | "RETRY" | "RECONCILE" | "WAIT";
  reconciliation_required: boolean;
}>;

/** Project a direct Supervisor result when the live run lacks commit/evidence receipts. */
export function projectEngineeringLiveTerminal(input: {
  readonly terminalReasonCode?: EngineeringRuntimeStopCode | null;
  readonly hasDurableCommit: boolean;
  readonly hasDurableEvidence: boolean;
}): EngineeringLiveTerminalProjection {
  const code = input.terminalReasonCode;
  if (code === "CANCELLED")
    return {
      engineering_outcome: "CANCELLED",
      terminal_reason_code: code,
      next_safe_step: "WAIT",
      reconciliation_required: false,
    };
  if (code !== undefined && code !== null && code !== "COMPLETED")
    return {
      engineering_outcome: "BLOCKED",
      terminal_reason_code: code,
      next_safe_step: "RETRY",
      reconciliation_required: false,
    };
  if (code === "COMPLETED" && input.hasDurableCommit && input.hasDurableEvidence)
    return {
      engineering_outcome: "COMPLETED",
      terminal_reason_code: "COMPLETED",
      next_safe_step: "STOP",
      reconciliation_required: false,
    };
  return {
    engineering_outcome: "INCOMPLETE",
    terminal_reason_code: code === "COMPLETED" ? "COMPLETED" : "INCOMPLETE",
    next_safe_step: "RECONCILE",
    reconciliation_required: true,
  };
}

/**
 * Bind the owner's explicit live selection to the already authenticated role registry.
 * Neither a config default nor provider output can change the two compared profiles.
 */
export function assertEngineeringLiveQualificationAuthority(input: {
  selection: EngineeringLiveQualificationSelection;
  routing: ProductionEngineeringModelRouting;
  executionConfig: EngineeringExecutionConfig;
}): EngineeringLiveQualificationAuthority {
  const parsed = selection.parse(input.selection);
  const implementer = input.routing.forRole("IMPLEMENTER").invocation;
  const reviewer = input.routing.forRole("REVIEWER").invocation;
  if (implementer.profile_name !== parsed.implementer_profile) {
    throw new Error("live Engineering IMPLEMENTER profile does not match the explicit selection");
  }
  if (reviewer.profile_name !== parsed.reviewer_profile) {
    throw new Error("live Engineering REVIEWER profile does not match the explicit selection");
  }
  return Object.freeze({
    authority: "EXPLICIT_SUBSCRIPTION_ROUTE" as const,
    invocation_id: parsed.invocation_id,
    implementer_invocation_digest: sha256Digest.parse(canonicalDigest(implementer)),
    reviewer_invocation_digest: sha256Digest.parse(canonicalDigest(reviewer)),
    execution_config_digest: input.executionConfig.configDigest,
    external_writes: "FORBIDDEN" as const,
  });
}
