import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { EngineeringStage, canonicalDigest } from "@remoteagent/contracts";
import {
  FakeTransport,
  ToolInputError,
  ToolLimitError,
  createRuntimeConfig,
} from "@remoteagent/model-runtime";
import {
  createSubscriptionModelInvocationDescriptor,
  subscriptionModelProfileV1,
  type SubscriptionModelRole,
} from "@remoteagent/model-runtime";
import {
  LocalArtifactStore,
  VerificationGateOutcome,
  VerificationGateReceipt,
  VerificationGateTarget,
  VerificationGateTier,
} from "@remoteagent/test-evidence";
import * as z from "zod";

import {
  addEngineeringModelUsage,
  boundedToolInputError,
  buildEngineeringGateFailureArtifact,
  classifyEngineeringModelUsage,
  createConfiguredEngineeringStageExecutor,
  createEngineeringRoleModelComposition,
  emptyEngineeringModelUsage,
  engineeringModelRoleForStage,
  engineeringImplementationContext,
  engineeringCorrectionImplementationContext,
  engineeringImplementationDiscoveryCallLimit,
  engineeringImplementationToolDefinitions,
  engineeringImplementationGuidance,
  engineeringImplementationPrompt,
  engineeringImplementationRuntimeConfig,
  engineeringMutationToolDefinitions,
  engineeringExecutionConfigFromEnv,
  loadEngineeringExecutionConfig,
  receiptBackedImplementationReport,
} from "../src/engineering-execution.js";
import {
  ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  ENGINEERING_MODEL_WARNING_TOKEN_LIMIT,
  EngineeringModelBudgetError,
} from "../src/engineering-debug-journal.js";
import { ENGINEERING_DIFF_POLICY } from "../src/vertical-slice-executor.js";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("routes every Engineering stage through its immutable subscription role", async () => {
  const preflightRoles: SubscriptionModelRole[] = [];
  const roleBinding = (role: SubscriptionModelRole) => {
    const provider = role === "IMPLEMENTER" || role === "VERIFIER" ? "claude_code" : "codex_cli";
    const model = `${role.toLowerCase()}-model`;
    const profile = subscriptionModelProfileV1.parse({
      schema_version: 1,
      profile_name: `${role.toLowerCase()}-profile`,
      provider,
      executable: process.execPath,
      model,
      timeout_ms: 10_000,
      kill_grace_ms: 100,
      max_stdin_bytes: 65_536,
      max_stdout_bytes: 65_536,
      max_stderr_bytes: 4096,
    });
    const invocation = createSubscriptionModelInvocationDescriptor({
      role,
      profile,
      clientVersion: provider === "codex_cli" ? "0.147.0" : "2.1.250",
      deploymentConfigDigest: `sha256:${"a".repeat(64)}`,
    });
    const config = createRuntimeConfig({
      model: { provider, model_id: model },
      timeoutMs: 10_000,
      toolLimits: { maxIterations: 16, maxCalls: 64 },
    });
    return Object.freeze({
      role,
      transport: Object.assign(new FakeTransport([]), {
        assertInvocationReady: async () => undefined,
      }),
      config,
      invocation,
      assertReadyForInvocation: async () => {
        preflightRoles.push(role);
      },
    });
  };
  const roles = Object.freeze({
    DESIGNER: roleBinding("DESIGNER"),
    IMPLEMENTER: roleBinding("IMPLEMENTER"),
    REVIEWER: roleBinding("REVIEWER"),
    VERIFIER: roleBinding("VERIFIER"),
  });
  const routing = Object.freeze({
    authority: "OFFICIAL_SUBSCRIPTION_CLI" as const,
    deployment: {} as never,
    deploymentConfigDigest: `sha256:${"a".repeat(64)}`,
    roles,
    forRole: (role: SubscriptionModelRole) => roles[role],
  });
  const composition = createEngineeringRoleModelComposition({
    routing,
    executionConfig: {
      configDigest: `sha256:${"b".repeat(64)}`,
      writePathAllowlist: ["src"],
      testPathAllowlist: ["src"],
      catalog: {
        definitions: [{ required: true, gate_id: "unit", gate_schedule: "EACH_SLICE" }],
      },
    } as never,
  });
  const expected = new Map<EngineeringStage, SubscriptionModelRole | null>([
    [EngineeringStage.DISCOVERY, null],
    [EngineeringStage.OUTCOME_DEFINITION, "DESIGNER"],
    [EngineeringStage.SYSTEM_DESIGN, "DESIGNER"],
    [EngineeringStage.PROGRAM_DESIGN, "DESIGNER"],
    [EngineeringStage.DESIGN_APPROVAL, "REVIEWER"],
    [EngineeringStage.SLICE_PLANNING, "DESIGNER"],
    [EngineeringStage.SLICE_IMPLEMENTATION, "IMPLEMENTER"],
    [EngineeringStage.GATE_EXECUTION, null],
    [EngineeringStage.SLICE_REVIEW, "REVIEWER"],
    [EngineeringStage.MEMORY_PROJECTION, "DESIGNER"],
    [EngineeringStage.FINAL_VERIFICATION, "VERIFIER"],
    [EngineeringStage.LOCAL_COMMIT, null],
  ]);
  for (const [stage, role] of expected) {
    expect(engineeringModelRoleForStage(stage)).toBe(role);
    expect(composition.stageExecutor.modelInvocation?.(stage)?.role ?? null).toBe(role);
  }
  expect(
    composition.stageExecutor.configDigestForStage?.(EngineeringStage.OUTCOME_DEFINITION),
  ).toBe(composition.stageExecutor.configDigestForStage?.(EngineeringStage.PROGRAM_DESIGN));
  expect(
    composition.stageExecutor.configDigestForStage?.(EngineeringStage.FINAL_VERIFICATION),
  ).not.toBe(composition.stageExecutor.configDigestForStage?.(EngineeringStage.PROGRAM_DESIGN));

  await composition.modelPreflight({
    binding: { stage: EngineeringStage.DESIGN_APPROVAL } as never,
    invocation: roles.REVIEWER.invocation,
  });
  expect(preflightRoles).toEqual(["REVIEWER"]);
  await expect(
    composition.modelPreflight({
      binding: { stage: EngineeringStage.DESIGN_APPROVAL } as never,
      invocation: roles.DESIGNER.invocation,
    }),
  ).rejects.toThrow(/matching subscription role/u);
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
  expect(classifyEngineeringModelUsage(ENGINEERING_MODEL_WARNING_TOKEN_LIMIT)).toBe("TARGET");
  expect(classifyEngineeringModelUsage(ENGINEERING_MODEL_WARNING_TOKEN_LIMIT + 1)).toBe("WARNING");
  expect(classifyEngineeringModelUsage(ENGINEERING_MODEL_HARD_TOKEN_LIMIT + 1)).toBe("HARD_LIMIT");
});

it("finalizes an implementation from successful receipts only at the exact token fence", () => {
  expect(
    receiptBackedImplementationReport({
      error: new EngineeringModelBudgetError(),
      successfulMutationPaths: ["src/z.swift", "src/a.swift", "src/z.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toEqual({ changed_files: ["src/a.swift", "src/z.swift"] });
  expect(() =>
    receiptBackedImplementationReport({
      error: new Error("unrelated failure"),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toThrow(/unrelated failure/);
  expect(
    receiptBackedImplementationReport({
      error: new EngineeringModelBudgetError(),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: true,
      unresolvedMutationAmbiguity: false,
    }),
  ).toEqual({ changed_files: ["src/a.swift"] });
  expect(() =>
    receiptBackedImplementationReport({
      error: new EngineeringModelBudgetError(),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: true,
      unresolvedMutationAmbiguity: true,
    }),
  ).toThrow(/reserve would exceed/);
  expect(() =>
    receiptBackedImplementationReport({
      error: new EngineeringModelBudgetError(),
      successfulMutationPaths: [],
      unresolvedMutationFailure: false,
    }),
  ).toThrow(/reserve would exceed/);
  expect(
    receiptBackedImplementationReport({
      error: new ToolLimitError("Repeated mutation target refusal made no progress"),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: true,
      unresolvedMutationAmbiguity: false,
    }),
  ).toEqual({ changed_files: ["src/a.swift"] });
  expect(() =>
    receiptBackedImplementationReport({
      error: new ToolLimitError("Maximum tool iterations exceeded"),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: true,
      unresolvedMutationAmbiguity: true,
    }),
  ).toThrow(/Maximum tool iterations exceeded/);
});

it("builds bounded server-owned correction evidence only from failed gate diagnostics", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra048-gate-failure-")));
  cleanup.push(root);
  const store = new LocalArtifactStore({ root, knownSecrets: ["opaque-secret-canary"] });
  const log = await store.put({
    artifact_id: "xcode-log",
    scope: { case_id: "case-1", workspace_id: "workspace-1" },
    content: [
      "unrelated successful compilation detail that must not enter correction context",
      "/Users/private/source/Assets+Help.swift:8:14: error: cannot find 'Bundle' in scope",
      "fatal error: opaque-secret-canary must never survive redaction",
    ].join("\n"),
  });
  const receipt = VerificationGateReceipt.parse({
    schema_version: 1,
    receipt_id: "receipt-xcode",
    case_id: "case-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    operation_id: "operation-xcode",
    gate_id: "xcode-full",
    target: VerificationGateTarget.CURRENT,
    tree_digest: canonicalDigest({ tree: 1 }),
    config_digest: canonicalDigest({ config: 1 }),
    command_digest: canonicalDigest({ command: 1 }),
    outcome: VerificationGateOutcome.FAILED,
    exit_code: 65,
    signal: null,
    duration_ms: 236_300,
    log_artifact: log,
    log_digest: log.digest,
  });
  const actual = {
    changedFiles: ["Sources/Assets+Help.swift"],
    cumulativeAgentPaths: ["Sources/Assets+Help.swift"],
    treeDigest: canonicalDigest({ actual_tree: 1 }),
    diffDigest: canonicalDigest({ actual_diff: 1 }),
    patch: "diff --git a/Sources/Assets+Help.swift b/Sources/Assets+Help.swift",
    filesChanged: 1,
    insertions: 8,
    deletions: 0,
  };
  const binding = {
    caseId: "case-1",
    workUnitId: "unit-1",
    runId: "run-1",
    checkpointRevision: 2,
    stage: EngineeringStage.GATE_EXECUTION,
    attempt: 2,
  };
  const slice = {
    schema_version: 2 as const,
    artifact_kind: "SliceContract" as const,
    case_id: "case-1",
    run_id: "run-1",
    revision: 2,
    slice_id: "slice-1",
    objective: "compile the help asset accessor",
    observable_result: "the accessor compiles",
    allowed_paths: ["Sources"],
    test_paths: ["Tests"],
    gate_ids: ["xcode-full"],
    inspection_method: "run xcodebuild",
    stop_condition: "xcodebuild passes",
  };

  const artifact = await buildEngineeringGateFailureArtifact({
    binding,
    slice,
    contextManifestDigest: canonicalDigest({ context: 1 }),
    catalogConfigDigest: canonicalDigest({ catalog: 1 }),
    decisionIds: ["decision-2", "decision-1"],
    result: {
      status: "BLOCKED",
      aggregate: null,
      bundle: null,
      reason: "FAILED",
      blockingGateIds: ["xcode-full"],
      receipts: [receipt],
      actual,
    },
    artifactStore: store,
  });

  expect(artifact).toMatchObject({
    artifact_kind: "GateFailure",
    authority: "SERVER_OWNED",
    slice_id: "slice-1",
    attempt: 2,
    blocking_gate_ids: ["xcode-full"],
    receipt_ids: ["receipt-xcode"],
    decision_ids: ["decision-1", "decision-2"],
    diagnostics: [
      expect.objectContaining({
        gate_id: "xcode-full",
        outcome: "FAILED",
        trust: "UNTRUSTED_DATA",
      }),
    ],
  });
  const excerpt = artifact?.diagnostics[0]?.excerpt ?? "";
  expect(excerpt).toContain("cannot find 'Bundle' in scope");
  expect(excerpt).not.toContain("unrelated successful compilation detail");
  expect(excerpt).not.toContain("opaque-secret-canary");
  expect(excerpt).not.toContain("/Users/private/source");
  expect(excerpt.length).toBeLessThanOrEqual(16_384);

  await expect(
    buildEngineeringGateFailureArtifact({
      binding,
      slice,
      contextManifestDigest: canonicalDigest({ context: 1 }),
      catalogConfigDigest: canonicalDigest({ catalog: 1 }),
      decisionIds: [],
      result: {
        status: "BLOCKED",
        aggregate: null,
        bundle: null,
        reason: "TIMED_OUT",
        blockingGateIds: ["missing-failed-receipt"],
        receipts: [receipt],
        actual,
      },
      artifactStore: store,
    }),
  ).resolves.toBeNull();
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
  expect(definitions.get("patch")?.description).toMatch(/complete final contents.*new files/i);
  expect(definitions.get("patch")?.description).toMatch(/existing file.*replacement_files/i);
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

it("reserves mutation rounds within an eight-round engineering cap without widening deployment", () => {
  const broad = createRuntimeConfig({
    model: { provider: "test", model_id: "implementation-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
  const bounded = engineeringImplementationRuntimeConfig(broad);
  expect(bounded.toolLimits).toEqual({ maxIterations: 8, maxCalls: 32 });
  expect(bounded.toolLoopPolicy).toEqual({
    readonlyToolNames: ["read", "search", "tree", "config"],
    mutationToolNames: ["write", "patch", "mkdir"],
    mutationIterationsReserved: 3,
    retainRecentToolPairs: 3,
    requireSuccessfulMutationAfterFailure: true,
  });
  expect(Object.isFrozen(bounded)).toBe(true);
  expect(Object.isFrozen(bounded.toolLimits)).toBe(true);
  expect(Object.isFrozen(bounded.toolLoopPolicy)).toBe(true);
  expect(Object.isFrozen(bounded.toolLoopPolicy?.readonlyToolNames)).toBe(true);

  const stricter = createRuntimeConfig({
    model: broad.model,
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 7 },
  });
  expect(engineeringImplementationRuntimeConfig(stricter).toolLimits).toEqual({
    maxIterations: 2,
    maxCalls: 7,
  });
  expect(engineeringImplementationRuntimeConfig(stricter).toolLoopPolicy).toMatchObject({
    mutationIterationsReserved: 2,
    retainRecentToolPairs: 2,
  });
});

it("derives a separate bounded budget only for the exact server-owned prefetch plan", () => {
  expect(engineeringImplementationDiscoveryCallLimit([])).toBe(10);
  expect(
    engineeringImplementationDiscoveryCallLimit(
      Array.from({ length: 13 }, (_, index) => ({
        kind: "SEARCH" as const,
        relative_path: `src/${String(index)}.ts`,
        query: `symbol-${String(index)}`,
      })),
    ),
  ).toBe(13);
  expect(() =>
    engineeringImplementationDiscoveryCallLimit(
      Array.from({ length: 25 }, (_, index) => ({
        kind: "READ" as const,
        relative_path: `src/${String(index)}.ts`,
      })),
    ),
  ).toThrow(/code-owned discovery cap/u);
});

it("prefetches exact prior agent files only for a gate correction", () => {
  const configured = [
    { kind: "SEARCH" as const, relative_path: "src/flow.swift", query: "routeAlert" },
    { kind: "READ" as const, relative_path: "src/shared.swift" },
  ];
  expect(
    engineeringCorrectionImplementationContext(
      configured,
      ["src/generated.swift", "src/shared.swift", "src/generated.swift"],
      true,
    ),
  ).toEqual([
    { kind: "SEARCH", relative_path: "src/flow.swift", query: "routeAlert" },
    { kind: "READ", relative_path: "src/shared.swift" },
    { kind: "READ", relative_path: "src/generated.swift" },
  ]);
  expect(
    engineeringCorrectionImplementationContext(configured, ["src/generated.swift"], false),
  ).toEqual(configured);
  expect(() =>
    engineeringCorrectionImplementationContext(
      [],
      Array.from({ length: 25 }, (_, index) => `src/generated-${String(index)}.swift`),
      true,
    ),
  ).toThrow(/code-owned discovery cap/u);
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
    schema_version: 3,
    workspace_root: workspace,
    baseline_root: baseline,
    artifact_root: artifacts,
    repository: {
      repository_id: "repo",
      source_path: source,
      base_branch: "main",
      write_path_allowlist: ["src", "packages"],
      test_path_allowlist: ["src"],
    },
    gates: [
      {
        schema_version: 1,
        gate_id: "unit",
        gate_class: "TEST",
        gate_tier: VerificationGateTier.FAST,
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
    generators: [
      {
        generator_id: "client_codegen",
        trigger_paths: ["src/schema.json"],
        output_paths: ["packages/generated.ts"],
        command: {
          executable,
          args: ["-e", "process.exit(0)"],
          cwd: ".",
          timeoutMs: 10_000,
        },
      },
    ],
  };
  const configPath = join(parent, "engineering.json");
  await writeFile(configPath, `${JSON.stringify(value)}\n`);
  const loaded = await loadEngineeringExecutionConfig(configPath);
  expect(loaded).toMatchObject({
    repositoryId: "repo",
    baselineRoot: baseline,
    artifactRoot: artifacts,
    writePathAllowlist: ["packages", "src"],
    testPathAllowlist: ["src"],
    writeDeploymentPolicy: {
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
      repository_id: "repo",
      write_path_allowlist: ["packages", "src"],
    },
  });
  expect(loaded.configDigest).toBe(
    canonicalDigest({
      schema_version: 3,
      workspace_root: workspace,
      baseline_root: baseline,
      artifact_root: artifacts,
      repository: {
        repository_id: "repo",
        source_path: source,
        base_branch: "main",
        write_path_allowlist: ["packages", "src"],
        test_path_allowlist: ["src"],
      },
      engineering_diff_policy: ENGINEERING_DIFF_POLICY,
      gate_config_digest: loaded.catalog.config_digest,
      generator_config_digest: loaded.generatorCatalog?.config_digest,
    }),
  );
  expect(loaded.generatorCatalog?.definitions.map((entry) => entry.generator_id)).toEqual([
    "client_codegen",
  ]);
  expect(loaded.catalog.definitions.map((gate) => gate.gate_id)).toEqual(["unit"]);
  expect(loaded.catalog.definitions[0]?.gate_tier).toBe(VerificationGateTier.FAST);
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
  expect(implementationPrompt).toContain(
    "first successful filesystem mutation must contain only paths within slice.test_paths",
  );
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
    existingAgentPaths: ["src/existing-test.ts", "src/existing-source.ts"],
    gateCorrection: {
      blocking_gate_ids: ["unit"],
      diagnostics: [
        {
          gate_id: "unit",
          outcome: "FAILED",
          trust: "UNTRUSTED_DATA",
          excerpt: "error: cannot find symbol",
        },
      ],
    },
  });
  expect(prefetchedPrompt).toContain("server already performed the complete code-owned discovery");
  expect(prefetchedPrompt).toContain("Use only the supplied write, patch, and mkdir tools");
  expect(prefetchedPrompt).toContain("bounded repository excerpt");
  expect(prefetchedPrompt).toContain("Previous required-gate correction evidence");
  expect(prefetchedPrompt).toContain("cannot find symbol");
  expect(prefetchedPrompt).toContain(
    '["src/existing-source.ts","src/existing-test.ts"]. Never call write for these paths',
  );
  expect(prefetchedPrompt).toContain("patch.replacement_files and exact old_content");
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
            schema_version: 2,
            artifact_kind: "SliceContract",
            case_id: "case-1",
            run_id: "run-1",
            revision: 0,
            slice_id: "slice-1",
            objective: "bounded change",
            observable_result: "one visible result",
            allowed_paths: ["src"],
            test_paths: ["src/settings.test.ts"],
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
    orderedArtifacts: [],
    processClass: "SMALL",
  });
  const planningPrompt =
    transport.requests[0]?.messages
      .flatMap((message) => message.content)
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n") ?? "";
  expect(planningPrompt).toContain(
    'every blueprint or slice allowed_paths must contain only applicable entries from ["packages","src"]',
  );
  expect(planningPrompt).toContain(
    'test_paths must contain only applicable entries from the narrower code-owned test roots ["src"]',
  );
  expect(planningPrompt).toContain('"unit":"EACH_SLICE"');
  expect(planningPrompt).toContain("gate_ids must equal the applicable IDs in server order");
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
      repository: { ...value.repository, test_path_allowlist: ["packages"] },
    })}\n`,
  );
  const changedTestRoots = await loadEngineeringExecutionConfig(configPath);
  expect(changedTestRoots.configDigest).not.toBe(loaded.configDigest);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      repository: { ...value.repository, test_path_allowlist: ["foreign"] },
    })}\n`,
  );
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/write allowlist/u);
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
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      gates: [{ ...value.gates[0], gate_tier: VerificationGateTier.FULL }],
    })}\n`,
  );
  const changedTier = await loadEngineeringExecutionConfig(configPath);
  expect(changedTier.catalog.definitions[0]?.gate_tier).toBe(VerificationGateTier.FULL);
  expect(changedTier.configDigest).not.toBe(loaded.configDigest);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      generators: [
        {
          ...value.generators[0],
          command: { ...value.generators[0].command, args: ["-e", "process.exit(2)"] },
        },
      ],
    })}\n`,
  );
  const changedGenerator = await loadEngineeringExecutionConfig(configPath);
  expect(changedGenerator.configDigest).not.toBe(loaded.configDigest);
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
