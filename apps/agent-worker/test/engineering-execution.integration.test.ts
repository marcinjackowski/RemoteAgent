import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { EngineeringStage } from "@remoteagent/contracts";
import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import { ToolInputError } from "@remoteagent/bedrock-runtime";
import * as z from "zod";

import {
  addEngineeringModelUsage,
  boundedToolInputError,
  classifyEngineeringModelUsage,
  createConfiguredEngineeringStageExecutor,
  emptyEngineeringModelUsage,
  engineeringImplementationContext,
  engineeringImplementationToolDefinitions,
  engineeringImplementationGuidance,
  engineeringImplementationPrompt,
  engineeringImplementationRuntimeConfig,
  engineeringMutationToolDefinitions,
  engineeringExecutionConfigFromEnv,
  loadEngineeringExecutionConfig,
} from "../src/engineering-execution.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("maps real bounded-tool schema failures without echoing rejected values", () => {
  let validationError: unknown;
  try {
    z.strictObject({ relative_path: z.string() }).parse({
      relative_path: 42,
      leaked: "/Users/private/secret-token",
    });
  } catch (error) {
    validationError = error;
  }
  const mapped = boundedToolInputError(validationError);
  expect(mapped).toBeInstanceOf(ToolInputError);
  expect(mapped).toMatchObject({
    code: "TOOL_INPUT_INVALID",
    issues: expect.arrayContaining([
      expect.objectContaining({ path: ["relative_path"], code: "invalid_type" }),
    ]),
  });
  expect(JSON.stringify(mapped)).not.toContain("/Users/private/secret-token");
});

it("aggregates only provider-reported token usage and marks missing or partial responses", () => {
  const afterComplete = addEngineeringModelUsage(emptyEngineeringModelUsage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  });
  const afterPartial = addEngineeringModelUsage(afterComplete, { totalTokens: 7 });
  const actual = addEngineeringModelUsage(afterPartial, undefined);

  expect(actual).toEqual({
    responses: 3,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 127,
    responsesWithoutUsage: 1,
    responsesWithPartialUsage: 1,
  });
  expect(Object.isFrozen(actual)).toBe(true);
  expect(() =>
    addEngineeringModelUsage(actual, { inputTokens: -1, outputTokens: 0, totalTokens: 0 }),
  ).toThrow(/invalid input token count/);
  expect(classifyEngineeringModelUsage(150_000)).toBe("TARGET");
  expect(classifyEngineeringModelUsage(150_001)).toBe("WARNING");
  expect(classifyEngineeringModelUsage(250_001)).toBe("HARD_LIMIT");
});

it("describes bounded write semantics and search-first discovery to the implementer", () => {
  const definitions = new Map(
    engineeringImplementationToolDefinitions.map((definition) => [definition.name, definition]),
  );
  expect([...definitions.keys()].sort()).toEqual([
    "config",
    "mkdir",
    "patch",
    "read",
    "search",
    "tree",
    "write",
  ]);
  expect(definitions.get("patch")?.description).toMatch(/complete final file contents/i);
  expect(definitions.get("patch")?.description).toMatch(/never a unified diff/i);
  expect(definitions.get("write")?.description).toMatch(/complete final file contents/i);
  expect(definitions.get("search")?.description).toMatch(/before guessing/i);
  expect(definitions.has("command")).toBe(false);
  expect(engineeringMutationToolDefinitions.map((tool) => tool.name).sort()).toEqual([
    "mkdir",
    "patch",
    "write",
  ]);
});

it("caps implementation to four batched tool rounds without widening a stricter deployment", () => {
  const broad = createRuntimeConfig({
    model: { provider: "test", model_id: "implementation-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
  const bounded = engineeringImplementationRuntimeConfig(broad);
  expect(bounded.toolLimits).toEqual({ maxIterations: 4, maxCalls: 24 });
  expect(Object.isFrozen(bounded)).toBe(true);
  expect(Object.isFrozen(bounded.toolLimits)).toBe(true);

  const stricter = createRuntimeConfig({
    model: broad.model,
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 7 },
  });
  expect(engineeringImplementationRuntimeConfig(stricter).toolLimits).toEqual({
    maxIterations: 2,
    maxCalls: 7,
  });
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
        implementation_guidance:
          "Edit the existing settings view and focused behavior tests; do not duplicate production constants in a test-only type.",
        implementation_context: [
          { kind: "READ", relative_path: "src/settings.ts" },
          { kind: "SEARCH", relative_path: "src/strings.ts", query: "privacy-policy" },
        ],
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
    writeDeploymentPolicy: {
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
      repository_id: "repo",
      write_path_allowlist: ["packages", "src"],
    },
  });
  expect(loaded.catalog.definitions.map((gate) => gate.gate_id)).toEqual(["unit"]);
  expect(engineeringImplementationGuidance(loaded.catalog, ["unit"])).toEqual([
    {
      gate_id: "unit",
      guidance:
        "Edit the existing settings view and focused behavior tests; do not duplicate production constants in a test-only type.",
    },
  ]);
  expect(engineeringImplementationContext(loaded.catalog, ["unit"])).toEqual([
    { kind: "READ", relative_path: "src/settings.ts" },
    { kind: "SEARCH", relative_path: "src/strings.ts", query: "privacy-policy" },
  ]);
  expect(JSON.stringify(engineeringImplementationGuidance(loaded.catalog, ["unit"]))).not.toContain(
    executable,
  );
  const implementationPrompt = engineeringImplementationPrompt({
    objective: "bounded change",
    slice: {
      schema_version: 1,
      artifact_kind: "SliceContract",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      slice_id: "slice-1",
      objective: "bounded change",
      observable_result: "one visible result",
      allowed_paths: ["src"],
      gate_ids: ["unit"],
      inspection_method: "inspect result",
      stop_condition: "required gate passes",
    },
    contextPacket: "bounded context",
    gateGuidance: engineeringImplementationGuidance(loaded.catalog, ["unit"]),
  });
  expect(implementationPrompt).toContain("Code-owned gate guidance");
  expect(implementationPrompt).toContain("existing settings view");
  expect(implementationPrompt).toContain("Use search/tree results");
  expect(implementationPrompt).toContain("use at most two discovery batches");
  expect(implementationPrompt).toContain("exact surrounding lines suitable");
  expect(implementationPrompt).toContain("do not read the whole file");
  expect(implementationPrompt).toContain("Batch independent replacements into the same patch call");
  expect(implementationPrompt).toContain("do not create a replacement test file");
  expect(implementationPrompt).not.toContain(executable);
  const prefetchedPrompt = engineeringImplementationPrompt({
    objective: "bounded change",
    slice: {
      schema_version: 1,
      artifact_kind: "SliceContract",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      slice_id: "slice-1",
      objective: "bounded change",
      observable_result: "one visible result",
      allowed_paths: ["src"],
      gate_ids: ["unit"],
      inspection_method: "inspect result",
      stop_condition: "required gate passes",
    },
    contextPacket: "bounded context",
    gateGuidance: engineeringImplementationGuidance(loaded.catalog, ["unit"]),
    prefetchedContext: [
      {
        kind: "SEARCH",
        relative_path: "src/strings.ts",
        query: "privacy-policy",
        evidence: "bounded repository excerpt",
      },
    ],
  });
  expect(prefetchedPrompt).toContain("server already performed the complete code-owned discovery");
  expect(prefetchedPrompt).toContain("Use only the supplied write, patch, and mkdir tools");
  expect(prefetchedPrompt).toContain("bounded repository excerpt");
  expect(prefetchedPrompt).not.toContain("Use search/tree results");
  expect(Object.isFrozen(loaded.writePathAllowlist)).toBe(true);
  const modelConfig = createRuntimeConfig({
    model: { provider: "test", model_id: "planning-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 2 },
  });
  const transport = new FakeTransport([
    {
      model: modelConfig.model,
      content: [
        {
          type: "json",
          value: {
            schema_version: 1,
            artifact_kind: "SliceContract",
            case_id: "case-1",
            run_id: "run-1",
            revision: 0,
            slice_id: "slice-1",
            objective: "bounded change",
            observable_result: "one visible result",
            allowed_paths: ["src"],
            gate_ids: ["unit"],
            inspection_method: "inspect result",
            stop_condition: "required gate passes",
          },
        },
      ],
    },
  ]);
  const executor = createConfiguredEngineeringStageExecutor({
    transport,
    modelConfig,
    executionConfig: loaded,
  });
  await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.SLICE_PLANNING,
      attempt: 1,
    },
    objective: "bounded change",
    context: { packet: "bounded context" } as never,
  });
  const planningPrompt =
    transport.requests[0]?.messages
      .flatMap((message) => message.content)
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n") ?? "";
  expect(planningPrompt).toContain(
    'allowed_paths must contain only applicable entries from ["packages","src"]',
  );
  expect(planningPrompt).toContain('gate_ids must equal ["unit"]');
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      repository: { ...value.repository, write_path_allowlist: ["src"] },
    })}\n`,
  );
  const narrower = await loadEngineeringExecutionConfig(configPath);
  expect(narrower.configDigest).not.toBe(loaded.configDigest);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      gates: [
        {
          ...value.gates[0],
          implementation_guidance: "A different code-owned implementation boundary.",
        },
      ],
    })}\n`,
  );
  const changedGuidance = await loadEngineeringExecutionConfig(configPath);
  expect(changedGuidance.configDigest).not.toBe(loaded.configDigest);
  await writeFile(configPath, `${JSON.stringify(value)}\n`);
  await expect(
    engineeringExecutionConfigFromEnv({ RA_ENGINEERING_CONFIG_PATH: configPath }),
  ).resolves.toMatchObject({ repositoryId: "repo" });
  await expect(engineeringExecutionConfigFromEnv({})).resolves.toBeNull();

  const missingCap = { ...value.repository } as Record<string, unknown>;
  delete missingCap.write_path_allowlist;
  await writeFile(configPath, `${JSON.stringify({ ...value, repository: missingCap })}\n`);
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(
    /expected array|unknown or missing/,
  );
  await writeFile(configPath, `${JSON.stringify(value)}\n`);

  await writeFile(configPath, `${JSON.stringify({ ...value, unexpected: true })}\n`);
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(
    /unrecognized|unknown or missing/i,
  );
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
