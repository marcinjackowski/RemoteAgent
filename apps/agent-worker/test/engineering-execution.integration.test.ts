import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  engineeringExecutionConfigFromEnv,
  loadEngineeringExecutionConfig,
} from "../src/engineering-execution.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("loads one strict canonical deployment config and fails closed on widening", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "ra043-execution-config-")));
  cleanup.push(parent);
  const workspace = join(parent, "workspace");
  const baseline = join(parent, "baseline");
  const artifacts = join(parent, "artifacts");
  const source = join(parent, "source");
  await Promise.all([workspace, baseline, artifacts, source].map((path) => mkdir(path)));
  const artifactInsideSource = join(source, "artifact-child");
  const sourceInsideWorkspace = join(workspace, "source-child");
  await Promise.all([artifactInsideSource, sourceInsideWorkspace].map((path) => mkdir(path)));
  const executable = await realpath(process.execPath);
  const value = {
    schema_version: 2,
    workspace_root: workspace,
    baseline_root: baseline,
    artifact_root: artifacts,
    repository: {
      repository_id: "repo",
      source_path: source,
      base_branch: "main",
      write_path_allowlist: ["src", "packages"],
    },
    gates: [
      {
        schema_version: 1,
        gate_id: "unit",
        gate_class: "TEST",
        executable,
        argv: ["-e", "process.exit(0)"],
        relative_cwd: "source",
        required: true,
        baseline: false,
        test_first: false,
        timeout_ms: 10_000,
        environment_profile: "HERMETIC",
        network_profile: "DENY",
        mutable_outputs: [],
      },
    ],
    executable_allowlist: [executable],
  };
  const configPath = join(parent, "engineering.json");
  await writeFile(configPath, `${JSON.stringify(value)}\n`);
  const loaded = await loadEngineeringExecutionConfig(configPath);
  expect(loaded).toMatchObject({
    repositoryId: "repo",
    baselineRoot: baseline,
    artifactRoot: artifacts,
    writePathAllowlist: ["packages", "src"],
  });
  expect(loaded.catalog.definitions.map((gate) => gate.gate_id)).toEqual(["unit"]);
  expect(Object.isFrozen(loaded.writePathAllowlist)).toBe(true);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      repository: { ...value.repository, write_path_allowlist: ["src"] },
    })}\n`,
  );
  const narrower = await loadEngineeringExecutionConfig(configPath);
  expect(narrower.configDigest).not.toBe(loaded.configDigest);
  await writeFile(configPath, `${JSON.stringify(value)}\n`);
  await expect(
    engineeringExecutionConfigFromEnv({ RA_ENGINEERING_CONFIG_PATH: configPath }),
  ).resolves.toMatchObject({ repositoryId: "repo" });
  await expect(engineeringExecutionConfigFromEnv({})).resolves.toBeNull();

  const missingCap = { ...value.repository } as Record<string, unknown>;
  delete missingCap.write_path_allowlist;
  await writeFile(configPath, `${JSON.stringify({ ...value, repository: missingCap })}\n`);
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/unknown or missing/);
  await writeFile(configPath, `${JSON.stringify(value)}\n`);

  await writeFile(configPath, `${JSON.stringify({ ...value, unexpected: true })}\n`);
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/unknown or missing/);
  await writeFile(
    configPath,
    `${JSON.stringify({ ...value, gates: [{ ...value.gates[0], required: false }] })}\n`,
  );
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/only required gates/);
  await writeFile(
    configPath,
    `${JSON.stringify({ ...value, artifact_root: artifactInsideSource })}\n`,
  );
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/pairwise disjoint/);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      repository: { ...value.repository, source_path: sourceInsideWorkspace },
    })}\n`,
  );
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/pairwise disjoint/);
});
