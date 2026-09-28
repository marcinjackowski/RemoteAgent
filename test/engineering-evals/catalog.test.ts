import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonicalDigest } from "@remoteagent/contracts";
import { afterEach, expect, it } from "vitest";
import {
  loadEngineeringBenchmarkManifest,
  loadEngineeringBenchmarkOverlay,
  resolveEngineeringBenchmark,
} from "../../apps/agent-worker/src/engineering-live-qualification.js";
import type { EngineeringExecutionConfig } from "../../apps/agent-worker/src/engineering-execution.js";
import type {
  EngineeringBenchmarkManifestV1,
  EngineeringBenchmarkOverlayV1,
} from "../../apps/agent-worker/src/engineering-live-qualification.js";
import type { ProductionEngineeringModelRouting } from "../../apps/agent-worker/src/engineering-model-routing.js";

const manifestPath = join(process.cwd(), "test/engineering-evals/fixtures/synthetic-manifest.json");
const zero = `sha256:${"0".repeat(64)}`;
const tempRoots = new Set<string>();
const execFile = promisify(execFileCallback);
afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});
async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempRoots.add(root);
  return root;
}

it("keeps synthetic benchmark raw and canonical digests explicit", async () => {
  const bytes = await readFile(manifestPath);
  const loaded = await loadEngineeringBenchmarkManifest(manifestPath);
  expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(
    loaded.raw_source_bytes_digest,
  );
  expect(loaded.raw_source_bytes_digest).toBe(
    "sha256:14d0fdcf220e03c8c2fc50a1adbdfe621d9238ee358321190420c2c554956c10",
  );
  expect(canonicalDigest(loaded.manifest)).toBe(loaded.canonical_manifest_digest);
  expect(loaded.canonical_manifest_digest).toBe(
    "sha256:e32a612de2823246661ffb6978788fce306da5b26edf905543bd4f028edf4ed2",
  );
  expect(loaded.raw_source_bytes_digest).not.toBe(loaded.canonical_manifest_digest);
});
it("rejects unknown private credential fields", async () => {
  const root = await tempDir("benchmark-overlay-strict-");
  const file = join(root, "overlay.json");
  await writeFile(
    file,
    JSON.stringify({ benchmark_id: "synthetic-ios", version: 1, api_key: "forbidden" }),
  );
  await expect(loadEngineeringBenchmarkOverlay(file)).rejects.toThrow();
});

type Fixture = Awaited<ReturnType<typeof makeValidFixture>>;
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type BenchmarkInput = Parameters<typeof resolveEngineeringBenchmark>[0];
async function makeValidFixture() {
  const root = await tempDir("benchmark-matrix-");
  const source = join(root, "repo"),
    configPath = join(root, "engineering.json");
  const developer = join(root, "Developer"),
    xcodebuild = join(root, "xcodebuild"),
    asset = join(root, "asset.pdf");
  await mkdir(join(source, "Sources"), { recursive: true });
  await mkdir(join(source, "Tests"), { recursive: true });
  await Promise.all([
    writeFile(join(source, "Sources/Screen.swift"), "// synthetic"),
    writeFile(join(source, "Tests/ScreenTests.swift"), "// synthetic"),
    writeFile(configPath, "{}"),
    mkdir(developer),
    writeFile(xcodebuild, ""),
    writeFile(asset, ""),
  ]);
  await execFile("git", ["init", "--quiet", source]);
  await execFile("git", ["-C", source, "add", "."]);
  await execFile("git", [
    "-C",
    source,
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.test",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const original = await loadEngineeringBenchmarkManifest(manifestPath);
  const manifestFile = join(root, "manifest.json");
  const manifest = {
    ...original.manifest,
    repository_id: "synthetic-repo",
    seed_sha: "0".repeat(40),
    execution_config_digest: zero,
    gate_catalog_digest: zero,
    gate_schema_digest: zero,
  };
  await writeFile(manifestFile, JSON.stringify(manifest));
  let loaded = await loadEngineeringBenchmarkManifest(manifestFile);
  const overlay: EngineeringBenchmarkOverlayV1 = {
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
      developer_path: developer,
      xcodebuild_path: xcodebuild,
      sdk: "iphonesimulator",
      destination: "platform=iOS Simulator",
      simulator_mapping: { iOS: "platform=iOS Simulator" },
    },
    profiles: {
      DESIGNER: "codex-synthetic",
      IMPLEMENTER: "codex-synthetic",
      REVIEWER: "codex-synthetic",
      VERIFIER: "codex-synthetic",
    },
  };
  const routing = {
    forRole: (role: string) => ({
      invocation: { role, provider: "codex_cli", profile_name: "codex-synthetic" },
    }),
  };
  const execution = {
    repositoryId: "synthetic-repo",
    configDigest: zero,
    baselineRoot: source,
    artifactRoot: root,
    workspaceConfig: { repositories: { "synthetic-repo": { sourcePath: source } } },
    writePathAllowlist: ["Sources/Screen.swift"],
    testPathAllowlist: ["Tests/ScreenTests.swift"],
    writeDeploymentPolicy: {
      schema_version: 1 as const,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY" as const,
      repository_id: "synthetic-repo",
      write_path_allowlist: ["Sources/Screen.swift"],
    },
    catalog: {
      config_digest: zero,
      get: (id: string) =>
        id === "gate" ? { required_mutation_paths: [], required_test_paths: [] } : undefined,
    },
    generatorCatalog: {
      config_digest: zero,
      definitions: [{ output_paths: ["Generated/Screen.swift"] }],
    },
  };
  let observedGateSchemaDigest = zero;
  let readHead = async () => "0".repeat(40);
  const input = (): BenchmarkInput => ({
    manifest: loaded,
    overlay: {
      overlay,
      raw_source_bytes_digest: overlay.raw_source_bytes_digest,
      canonical_overlay_digest: canonicalDigest(overlay),
    },
    executionConfig: execution as unknown as EngineeringExecutionConfig,
    routing: routing as unknown as ProductionEngineeringModelRouting,
    readSourceHead: readHead,
    observedExecutionConfigPath: configPath,
    observedGateSchemaDigest,
  });
  const rewrite = async (mutate: (m: EngineeringBenchmarkManifestV1) => void, rebind = true) => {
    const next = structuredClone(loaded.manifest) as EngineeringBenchmarkManifestV1;
    mutate(next);
    await writeFile(manifestFile, JSON.stringify(next));
    loaded = await loadEngineeringBenchmarkManifest(manifestFile);
    if (rebind) {
      overlay.manifest_digest = loaded.canonical_manifest_digest;
      overlay.canonical_manifest_digest = loaded.canonical_manifest_digest;
      overlay.raw_source_bytes_digest = loaded.raw_source_bytes_digest;
    }
  };
  const reload = async () => {
    loaded = await loadEngineeringBenchmarkManifest(manifestFile);
  };
  return {
    root,
    manifestFile,
    loaded: () => loaded,
    overlay,
    execution: execution as unknown as Mutable<EngineeringExecutionConfig>,
    routing: routing as unknown as Mutable<ProductionEngineeringModelRouting>,
    input,
    rewrite,
    reload,
    setObservedGateSchemaDigest: (v: string) => {
      observedGateSchemaDigest = v;
    },
    setReadHead: (v: string) => {
      readHead = async () => v;
    },
  };
}

it("resolves a complete benchmark and freezes nested output", async () => {
  const f = await makeValidFixture();
  const result = await resolveEngineeringBenchmark(f.input());
  expect(result.repository_id).toBe("synthetic-repo");
  expect(result.invocation_digests).toHaveProperty("IMPLEMENTER");
  expect(Object.isFrozen(result.manifest.manifest.targets)).toBe(true);
  expect(() => {
    (result.manifest.manifest as unknown as { benchmark_id: string }).benchmark_id = "drift";
  }).toThrow();
});

it("records exact overlay bytes separately from canonical overlay content", async () => {
  const f = await makeValidFixture();
  const bytes = Buffer.from(JSON.stringify(f.overlay));
  const overlayFile = join(f.root, "overlay.json");
  await writeFile(overlayFile, bytes);
  const loaded = await loadEngineeringBenchmarkOverlay(overlayFile);
  expect(loaded.raw_source_bytes_digest).toBe(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  expect(loaded.canonical_overlay_digest).toBe(canonicalDigest(loaded.overlay));
  await writeFile(overlayFile, Buffer.concat([bytes, Buffer.from(" \n")]));
  const whitespace = await loadEngineeringBenchmarkOverlay(overlayFile);
  expect(whitespace.canonical_overlay_digest).toBe(loaded.canonical_overlay_digest);
  expect(whitespace.raw_source_bytes_digest).not.toBe(loaded.raw_source_bytes_digest);
  const resolved = await resolveEngineeringBenchmark({
    ...f.input(),
    overlay: loaded,
  });
  expect(resolved.overlay_raw_source_bytes_digest).toBe(loaded.raw_source_bytes_digest);
  expect(resolved.canonical_overlay_digest).toBe(loaded.canonical_overlay_digest);
});

const negativeCases: readonly [string, (f: Fixture) => Promise<void>][] = [
  [
    "raw bytes stale after whitespace-equivalent manifest",
    async (f) => {
      const before = f.loaded();
      await writeFile(f.manifestFile, (await readFile(f.manifestFile, "utf8")) + " \n");
      await f.reload();
      expect(f.loaded().canonical_manifest_digest).toBe(before.canonical_manifest_digest);
      expect(f.loaded().raw_source_bytes_digest).not.toBe(before.raw_source_bytes_digest);
    },
  ],
  [
    "objective drift",
    async (f) => {
      f.overlay.objective = "different objective";
    },
  ],
  [
    "overlay manifest binding drift",
    async (f) => {
      f.overlay.manifest_digest = zero;
    },
  ],
  [
    "overlay canonical binding drift",
    async (f) => {
      f.overlay.canonical_manifest_digest = zero;
    },
  ],
  [
    "execution config digest",
    async (f) => {
      f.execution.configDigest = `sha256:${"1".repeat(64)}`;
    },
  ],
  [
    "repository ID",
    async (f) => {
      f.execution.repositoryId = "other";
    },
  ],
  [
    "catalog digest",
    async (f) => {
      f.execution.catalog.config_digest = `sha256:${"1".repeat(64)}`;
    },
  ],
  [
    "gate schema digest",
    async (f) => {
      f.setObservedGateSchemaDigest("sha256:" + "1".repeat(64));
    },
  ],
  [
    "seed",
    async (f) => {
      f.setReadHead("1".repeat(40));
    },
  ],
  [
    "missing gate",
    async (f) =>
      f.rewrite((m) => {
        m.criteria[0]!.required_gate_ids = ["missing"];
      }),
  ],
  [
    "unresolved target",
    async (f) =>
      f.rewrite((m) => {
        m.slices[0]!.mutation_target_ids = ["missing"];
      }),
  ],
  [
    "criterion target outside owning slice",
    async (f) =>
      f.rewrite((m) => {
        m.targets.push({ target_id: "test", paths: ["Tests/ScreenTests.swift"], kind: "TEST" });
        m.criteria[0]!.related_target_ids = ["test"];
      }),
  ],
  [
    "uncovered slice",
    async (f) =>
      f.rewrite((m) => {
        m.slices.push({
          slice_id: "orphan",
          mutation_target_ids: ["screen"],
          required_read_context: [],
        });
      }),
  ],
  [
    "provider",
    async (f) => {
      f.routing.forRole = (role: string) => ({
        invocation: { role, provider: "claude_code", profile_name: "codex-synthetic" },
      });
    },
  ],
  [
    "profile",
    async (f) => {
      f.routing.forRole = (role: string) => ({
        invocation: { role, provider: "codex_cli", profile_name: "wrong" },
      });
    },
  ],
  [
    "invocation role",
    async (f) => {
      f.routing.forRole = (_role: string) => ({
        invocation: { role: "REVIEWER", provider: "codex_cli", profile_name: "codex-synthetic" },
      });
    },
  ],
  [
    "missing required read",
    async (f) =>
      f.rewrite((m) => {
        m.slices[0]!.required_read_context = [
          { relative_path: "Sources/Missing.swift", must_exist: true },
        ];
      }),
  ],
  [
    "required-read symlink escape",
    async (f) => {
      const outside = join(f.root, "outside.swift");
      await writeFile(outside, "// outside");
      await symlink(outside, join(f.root, "repo/Sources/Escaped.swift"));
      await f.rewrite((m) => {
        m.slices[0]!.required_read_context = [
          { relative_path: "Sources/Escaped.swift", must_exist: true },
        ];
      });
    },
  ],
  [
    "symlink/noncanonical physical",
    async (f) => {
      const link = join(f.root, "linked-asset");
      await symlink(f.overlay.asset_refs[0]!, link);
      f.overlay.asset_refs[0] = link;
    },
  ],
  [
    "Xcode SDK",
    async (f) => {
      f.overlay.xcode.sdk = "iphoneos";
    },
  ],
  [
    "Xcode destination",
    async (f) => {
      f.overlay.xcode.destination = "platform=iOS";
    },
  ],
  [
    "simulator mapping",
    async (f) => {
      f.overlay.xcode.simulator_mapping.iOS = "platform=iOS";
    },
  ],
  [
    "api_key",
    async (f) => {
      (f.overlay as unknown as Record<string, unknown>).api_key = "forbidden";
    },
  ],
  [
    "oauth_token",
    async (f) => {
      (f.overlay as unknown as Record<string, unknown>).oauth_token = "forbidden";
    },
  ],
  [
    "SOURCE foreign",
    async (f) =>
      f.rewrite((m) => {
        m.targets[0]!.paths = ["Tests/ScreenTests.swift"];
      }),
  ],
  [
    "TEST foreign",
    async (f) =>
      f.rewrite((m) => {
        m.targets[0]!.kind = "TEST";
        m.targets[0]!.paths = ["Sources/Screen.swift"];
      }),
  ],
  [
    "GENERATOR foreign",
    async (f) =>
      f.rewrite((m) => {
        m.targets[0]!.kind = "GENERATOR";
        m.targets[0]!.paths = ["Sources/Screen.swift"];
      }),
  ],
];
it.each(negativeCases)("catalog negative matrix: %s", async (_name, mutate) => {
  const f = await makeValidFixture();
  await mutate(f);
  await expect(resolveEngineeringBenchmark(f.input())).rejects.toThrow();
});
it("catalog negative matrix: empty selector schema", async () => {
  const root = await tempDir("benchmark-empty-selector-");
  const file = join(root, "manifest.json");
  const loaded = await loadEngineeringBenchmarkManifest(manifestPath);
  const invalid = structuredClone(loaded.manifest) as EngineeringBenchmarkManifestV1;
  invalid.criteria[0]!.executable_selector_ids = [];
  await writeFile(file, JSON.stringify(invalid));
  await expect(loadEngineeringBenchmarkManifest(file)).rejects.toThrow();
});
it("accepts TEST and GENERATOR targets under code-owned authorities", async () => {
  for (const kind of ["TEST", "GENERATOR"] as const) {
    const f = await makeValidFixture();
    await f.rewrite((m) => {
      m.targets[0]!.kind = kind;
      m.targets[0]!.paths = [
        kind === "TEST" ? "Tests/ScreenTests.swift" : "Generated/Screen.swift",
      ];
    });
    await expect(resolveEngineeringBenchmark(f.input())).resolves.toBeTruthy();
  }
});
