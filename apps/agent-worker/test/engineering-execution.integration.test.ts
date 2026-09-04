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
  runToolLoop,
} from "@remoteagent/model-runtime";
import {
  createSubscriptionModelInvocationDescriptor,
  subscriptionModelProfileV1,
  type SubscriptionModelRole,
} from "@remoteagent/model-runtime";
import {
  BOUNDED_TEST_CONTENT_POLICY,
  implementationToolResult,
  type BoundedImplementationToolset,
} from "@remoteagent/implementation-tools";
import {
  LocalArtifactStore,
  VerificationGateCatalog,
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
  engineeringImplementationContextPacket,
  engineeringCorrectionPathContext,
  engineeringCorrectionImplementationContext,
  engineeringCorrectionRuntimeConfig,
  engineeringPriorPathsForActiveSlice,
  engineeringImplementationDiscoveryCallLimit,
  engineeringImplementationToolDefinitions,
  engineeringImplementationGuidance,
  engineeringImplementationEpochHandoff,
  engineeringImplementationPrompt,
  engineeringActiveGateFailureHistory,
  engineeringPreviousReviewCorrection,
  engineeringReviewCorrectionMutationPaths,
  engineeringRequiredSubstantiveMutationPaths,
  engineeringBehavioralCorrectionMutationPaths,
  engineeringImplementationRuntimeConfig,
  engineeringGateCorrectionRuntimeConfig,
  engineeringReviewCorrectionRuntimeConfig,
  engineeringGateCorrectionMutationPaths,
  engineeringCompilerRepairContext,
  engineeringCompilerRepairRuntimeConfig,
  engineeringModelFacingSlice,
  engineeringMutationToolDefinitions,
  engineeringExecutionConfigFromEnv,
  loadEngineeringExecutionConfig,
  prefetchEngineeringImplementationContext,
  receiptBackedImplementationReport,
  successfulReceiptImplementationReport,
  EngineeringImplementationContextError,
} from "../src/engineering-execution.js";
import {
  ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
  ENGINEERING_MODEL_WARNING_TOKEN_LIMIT,
  EngineeringModelBudgetError,
  engineeringDebugErrorCode,
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
  expect(() =>
    receiptBackedImplementationReport({
      error: new ToolLimitError("required correction path was not changed"),
      successfulMutationPaths: ["tests/FlowTests.swift"],
      requiredSuccessfulMutationPaths: ["src/Flow.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toThrow(/required correction path was not changed/);
  expect(
    receiptBackedImplementationReport({
      error: new ToolLimitError("final response omitted"),
      successfulMutationPaths: ["tests/FlowTests.swift", "src/Flow.swift"],
      requiredSuccessfulMutationPaths: ["src/Flow.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toEqual({ changed_files: ["src/Flow.swift", "tests/FlowTests.swift"] });
  expect(() =>
    receiptBackedImplementationReport({
      error: new ToolLimitError("all review paths were not changed"),
      successfulMutationPaths: ["src/Flow.swift"],
      requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toThrow(/all review paths were not changed/);
  expect(
    receiptBackedImplementationReport({
      error: new ToolLimitError("final response omitted"),
      successfulMutationPaths: ["src/FlowView.swift", "src/Flow.swift"],
      requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toEqual({ changed_files: ["src/Flow.swift", "src/FlowView.swift"] });
});

it("projects a normal implementation completion onto exact successful mutation receipts", () => {
  expect(
    successfulReceiptImplementationReport({
      reportedChangedFiles: ["src/Localizable.strings", "src/Flow.swift"],
      successfulMutationPaths: ["tests/FlowTests.swift", "src/Flow.swift"],
    }),
  ).toEqual({ changed_files: ["src/Flow.swift", "tests/FlowTests.swift"] });
  expect(
    successfulReceiptImplementationReport({
      reportedChangedFiles: [],
      successfulMutationPaths: ["src/FlowView.swift", "src/Flow.swift"],
      requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
    }),
  ).toEqual({ changed_files: ["src/Flow.swift", "src/FlowView.swift"] });
  expect(() =>
    successfulReceiptImplementationReport({
      reportedChangedFiles: ["src/Flow.swift"],
      successfulMutationPaths: [],
    }),
  ).toThrow(/without a successful mutation receipt/);
  expect(() =>
    successfulReceiptImplementationReport({
      reportedChangedFiles: ["src/Flow.swift"],
      successfulMutationPaths: ["src/Flow.swift"],
      requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
    }),
  ).toThrow(/required correction path/);
  expect(() =>
    successfulReceiptImplementationReport({
      reportedChangedFiles: ["src/Flow.swift"],
      successfulMutationPaths: ["src/Flow.swift"],
      unresolvedMutationAmbiguity: true,
    }),
  ).toThrow(/ambiguous implementation mutation/);
});

it("binds the union of exact gate and review targets to substantive correction receipts", () => {
  expect(
    engineeringRequiredSubstantiveMutationPaths(
      ["src/Flow.swift", "tests/FlowTests.swift"],
      ["src/FlowView.swift", "src/Flow.swift"],
    ),
  ).toEqual(["src/Flow.swift", "src/FlowView.swift", "tests/FlowTests.swift"]);
  expect(() => engineeringRequiredSubstantiveMutationPaths(["../foreign"], [])).toThrow();
  expect(Object.isFrozen(engineeringRequiredSubstantiveMutationPaths(["src/Flow.swift"], []))).toBe(
    true,
  );
});

it("selects only exact test paths for behavioral correction and exempts compiler repair", () => {
  expect(
    engineeringBehavioralCorrectionMutationPaths({
      requiredCorrectionPaths: ["src/Flow.swift", "tests/FlowTests.swift"],
      testPaths: ["tests"],
      compilerRepair: false,
    }),
  ).toEqual(["tests/FlowTests.swift"]);
  expect(
    engineeringBehavioralCorrectionMutationPaths({
      requiredCorrectionPaths: ["tests/FlowTests.swift"],
      testPaths: ["tests"],
      compilerRepair: true,
    }),
  ).toEqual([]);
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
      "Sources/Assets+Help.swift:8:14: error: cannot find 'Bundle' in scope",
      "let image = Bundle.module",
      "            ^",
      "Tests/SafetyAlertTests.swift:73: error: -[SharedTests.SafetyAlertTests testCloseDismissesAlert] : XCTAssertFalse failed - alert remained visible",
      "Test Case '-[SharedTests.SafetyAlertTests testCloseDismissesAlert]' failed (0.018 seconds).",
      "/Users/private/source/Other.swift:1:1: error: hidden host path",
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
  expect(artifact?.diagnostics[0]?.compiler_diagnostics).toEqual([
    expect.objectContaining({
      path: "Sources/Assets+Help.swift",
      line: 8,
      column: 14,
      message: "cannot find 'Bundle' in scope",
    }),
  ]);
  expect(artifact?.diagnostics[0]?.compiler_diagnostics?.[0]?.excerpt).toContain(
    "let image = Bundle.module",
  );
  expect(artifact?.diagnostics[0]?.test_diagnostics).toEqual([
    expect.objectContaining({
      test_name: "-[SharedTests.SafetyAlertTests testCloseDismissesAlert]",
      message: "XCTAssertFalse failed - alert remained visible",
      path: "Tests/SafetyAlertTests.swift",
      line: 73,
    }),
    expect.objectContaining({
      test_name: "-[SharedTests.SafetyAlertTests testCloseDismissesAlert]",
      message: "Test case failed",
      path: null,
      line: null,
    }),
  ]);
  expect(JSON.stringify(artifact)).not.toContain("/Users/private");

  const stoppedAfterFastFailure = await buildEngineeringGateFailureArtifact({
    binding,
    slice,
    contextManifestDigest: canonicalDigest({ context: 1 }),
    catalogConfigDigest: canonicalDigest({ catalog: 1 }),
    decisionIds: [],
    result: {
      status: "BLOCKED",
      aggregate: null,
      bundle: null,
      reason: "FAST_GATE_BLOCKED_FULL",
      blockingGateIds: ["xcode-full"],
      receipts: [receipt],
      actual,
    },
    artifactStore: store,
  });
  expect(stoppedAfterFastFailure).toMatchObject({
    artifact_kind: "GateFailure",
    blocking_gate_ids: ["xcode-full"],
    diagnostics: [expect.objectContaining({ outcome: "FAILED" })],
  });

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
        blockingGateIds: ["xcode-full"],
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
  expect(definitions.get("patch")?.description).toMatch(/whole workspace tree/i);
  expect(definitions.get("patch")?.description).toMatch(/set it to null/i);
  expect(definitions.get("write")?.description).toMatch(/complete final file contents/i);
  expect(definitions.get("search")?.description).toMatch(/before guessing/i);
  expect(definitions.has("command")).toBe(false);
  expect(engineeringMutationToolDefinitions.map((tool) => tool.name).sort()).toEqual([
    "mkdir",
    "patch",
  ]);
  expect(engineeringMutationToolDefinitions.map((tool) => tool.name)).not.toContain("write");
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
    maxReadonlyIterationsBeforeMutation: 2,
    retainRecentToolPairs: 3,
    contextEpochPairLimit: 3,
    requireSuccessfulMutationAfterFailure: true,
    requireSuccessfulMutationBeforeFinal: true,
  });
  expect(Object.isFrozen(bounded)).toBe(true);
  expect(Object.isFrozen(bounded.toolLimits)).toBe(true);
  expect(Object.isFrozen(bounded.toolLoopPolicy)).toBe(true);
  expect(Object.isFrozen(bounded.toolLoopPolicy?.readonlyToolNames)).toBe(true);

  const correction = engineeringGateCorrectionRuntimeConfig(bounded, [
    "src/FlowView.swift",
    "src/Flow.swift",
    "src/Flow.swift",
  ]);
  expect(correction.toolLoopPolicy?.requiredSuccessfulMutationPathsAll).toEqual([
    "src/Flow.swift",
    "src/FlowView.swift",
  ]);
  expect(correction.toolLoopPolicy?.requiredSuccessfulMutationPaths).toBeUndefined();
  expect(Object.isFrozen(correction.toolLoopPolicy?.requiredSuccessfulMutationPathsAll)).toBe(true);
  expect(() => engineeringGateCorrectionRuntimeConfig(bounded, ["../foreign"])).toThrow();

  const reviewCorrection = engineeringReviewCorrectionRuntimeConfig(bounded, [
    "src/FlowView.swift",
    "src/Flow.swift",
    "src/Flow.swift",
  ]);
  expect(reviewCorrection.toolLoopPolicy?.requiredSuccessfulMutationPathsAll).toEqual([
    "src/Flow.swift",
    "src/FlowView.swift",
  ]);
  expect(Object.isFrozen(reviewCorrection.toolLoopPolicy?.requiredSuccessfulMutationPathsAll)).toBe(
    true,
  );
  expect(() => engineeringReviewCorrectionRuntimeConfig(bounded, ["../foreign"])).toThrow();

  const combinedCorrection = engineeringReviewCorrectionRuntimeConfig(correction, [
    "src/ReviewTests.swift",
    "src/Flow.swift",
  ]);
  expect(combinedCorrection.toolLoopPolicy?.requiredSuccessfulMutationPathsAll).toEqual([
    "src/Flow.swift",
    "src/FlowView.swift",
    "src/ReviewTests.swift",
  ]);

  const compactCorrection = engineeringCorrectionRuntimeConfig(reviewCorrection);
  expect(compactCorrection.toolLoopPolicy).toMatchObject({
    retainRecentToolPairs: 1,
    contextEpochPairLimit: 1,
    requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
  });
  expect(Object.isFrozen(compactCorrection.toolLoopPolicy)).toBe(true);

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
    maxReadonlyIterationsBeforeMutation: 2,
    retainRecentToolPairs: 2,
    contextEpochPairLimit: 2,
  });
});

it("allows two compiler repair batches plus one exact failed-target recovery call", () => {
  const broad = createRuntimeConfig({
    model: { provider: "test", model_id: "implementation-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 16, maxCalls: 64 },
  });
  const repair = engineeringCompilerRepairRuntimeConfig(broad);
  expect(repair.toolLimits).toEqual({ maxIterations: 2, maxCalls: 3 });
  expect(repair.toolLoopPolicy).toEqual({
    readonlyToolNames: [],
    mutationToolNames: ["patch"],
    mutationIterationsReserved: 0,
    retainRecentToolPairs: 1,
    contextEpochPairLimit: 1,
    requireSuccessfulMutationAfterFailure: true,
    requireSuccessfulMutationBeforeFinal: true,
  });
  expect(Object.isFrozen(repair.toolLoopPolicy?.mutationToolNames)).toBe(true);
});

it("rotates a receipt-backed correction away from its large prompt after the first tool pair", async () => {
  const broad = createRuntimeConfig({
    model: { provider: "test", model_id: "implementation-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 8, maxCalls: 8 },
  });
  const correction = engineeringCorrectionRuntimeConfig(
    engineeringImplementationRuntimeConfig(broad),
  );
  const patchResponse = (id: string, marker: string) => ({
    model: broad.model,
    content: [
      {
        type: "tool-use" as const,
        id,
        name: "patch",
        input: { marker },
      },
    ],
  });
  const transport = new FakeTransport([
    patchResponse("patch-1", "FIRST_PATCH_BYTES"),
    patchResponse("patch-2", "SECOND_PATCH_BYTES"),
    { model: broad.model, content: [{ type: "text", text: "done" }] },
  ]);

  await runToolLoop(transport, correction, {
    messages: [
      { role: "user", content: [{ type: "text", text: "LARGE_PREFETCHED_CONTEXT_CANARY" }] },
    ],
    epochHandoffMessages: [
      {
        role: "user",
        content: [{ type: "json", value: { kind: "ENGINEERING_CORRECTION_HANDOFF" } }],
      },
    ],
    tools: [{ name: "patch", inputSchema: { type: "object" } }],
    execute: async (_name, input) => ({
      outcome: "SUCCEEDED",
      changed_files: [
        (input as { marker?: string }).marker === "FIRST_PATCH_BYTES"
          ? "src/first.swift"
          : "src/second.swift",
      ],
    }),
  });

  const afterFirstPair = JSON.stringify(transport.requests[1]?.messages);
  expect(afterFirstPair).toContain("ENGINEERING_CORRECTION_HANDOFF");
  expect(afterFirstPair).toContain("FIRST_PATCH_BYTES");
  expect(afterFirstPair).not.toContain("LARGE_PREFETCHED_CONTEXT_CANARY");

  const afterSecondPair = JSON.stringify(transport.requests[2]?.messages);
  expect(afterSecondPair).toContain("ENGINEERING_CORRECTION_HANDOFF");
  expect(afterSecondPair).toContain("SECOND_PATCH_BYTES");
  expect(afterSecondPair).toContain("TOOL_HISTORY_PROJECTION");
  expect(afterSecondPair).toContain("src/first.swift");
  expect(afterSecondPair).not.toContain("FIRST_PATCH_BYTES");
  expect(afterSecondPair).not.toContain("LARGE_PREFETCHED_CONTEXT_CANARY");
});

it("prefetches exact compiler files and related Swift declarations without widening slice scope", () => {
  const base = {
    path: "Sources/Shared/AgentAI/AgentAIFlowView.swift",
    line: 219,
    column: 24,
    message:
      "cannot convert value of type 'SafetyAlertPresentation' to expected argument type 'SafetyAlertPresentationModel'",
    excerpt: "SafetyAlertView(model: presentation.model)",
  };
  const context = engineeringCompilerRepairContext({
    diagnostics: [{ ...base, digest: canonicalDigest(base) }],
    allowedPaths: ["Sources/Shared"],
  });

  expect(context).toEqual([
    { kind: "READ", relative_path: "Sources/Shared/AgentAI/AgentAIFlowView.swift" },
    {
      kind: "SEARCH",
      relative_path: "Sources/Shared",
      query: "SafetyAlertPresentation",
    },
    {
      kind: "SEARCH",
      relative_path: "Sources/Shared",
      query: "SafetyAlertPresentationModel",
    },
  ]);
  expect(JSON.stringify(context)).not.toContain("Tests/Foreign");
});

it("does not turn semantic gate context into compiler repair without compiler diagnostics", () => {
  expect(
    engineeringCompilerRepairContext({
      diagnostics: [],
      allowedPaths: ["Sources/Shared", "Tests/Shared"],
      dependencyPaths: ["Sources/Shared/AgentAI/SafetyAlert.swift"],
      configuredContext: [
        { kind: "READ", relative_path: "Sources/Shared/AgentAI/SafetyAlert.swift" },
        {
          kind: "SEARCH",
          relative_path: "Tests/Shared",
          query: "EmergencyResourcesRouterTests",
        },
      ],
    }),
  ).toEqual([]);
});

it("prioritizes missing Swift members and reads an exact earlier-slice type dependency", () => {
  const first = {
    path: "Sources/Shared/AgentAI/AgentAIFlowView.swift",
    line: 37,
    column: 42,
    message: "value of type 'SafetyAlert' has no member 'onText988'",
    excerpt: "text988: safetyAlert.onText988",
  };
  const second = {
    path: "Sources/Shared/AgentAI/MultiAgent/AIMultiAgentFlowView.swift",
    line: 94,
    column: 53,
    message: "value of type 'SafetyAlert' has no member 'onOpenEmergencyResources'",
    excerpt: "openEmergencyResources: safetyAlert.onOpenEmergencyResources",
  };
  const context = engineeringCompilerRepairContext({
    diagnostics: [
      { ...first, digest: canonicalDigest(first) },
      { ...second, digest: canonicalDigest(second) },
    ],
    allowedPaths: ["Sources/Shared/AgentAI"],
    dependencyPaths: [
      "Sources/Shared/AgentAI/SafetyAlert.swift",
      "Tests/Shared/AgentAI/SafetyAlertTests.swift",
    ],
  });

  expect(context.slice(0, 3)).toEqual([
    { kind: "READ", relative_path: "Sources/Shared/AgentAI/AgentAIFlowView.swift" },
    {
      kind: "READ",
      relative_path: "Sources/Shared/AgentAI/MultiAgent/AIMultiAgentFlowView.swift",
    },
    { kind: "READ", relative_path: "Sources/Shared/AgentAI/SafetyAlert.swift" },
  ]);
  expect(context.filter((entry) => entry.kind === "SEARCH").map((entry) => entry.query)).toEqual([
    "onOpenEmergencyResources",
    "onText988",
    "SafetyAlert",
  ]);
  expect(JSON.stringify(context)).not.toContain("Tests/Shared");
});

it("reads a prefix-matched earlier-slice Swift protocol before repairing conformance", () => {
  const diagnostic = {
    path: "Sources/Shared/AgentAI/AgentAIFlow.swift",
    line: 22,
    column: 20,
    message: "type 'AgentAIFlow' does not conform to protocol 'SafetyAlertActionHandling'",
    excerpt: "public final class AgentAIFlow: SafetyAlertActionHandling",
  };
  const context = engineeringCompilerRepairContext({
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: [
      "Sources/Shared/AgentAI/AgentAIFlow.swift",
      "Sources/Shared/AgentAI/MultiAgent/AIMultiAgentChatViewModel.swift",
    ],
    dependencyPaths: [
      "Sources/Shared/AgentAI/SafetyAlert.swift",
      "Tests/Shared/AgentAI/SafetyAlertTests.swift",
    ],
  });

  expect(context.slice(0, 2)).toEqual([
    { kind: "READ", relative_path: "Sources/Shared/AgentAI/AgentAIFlow.swift" },
    { kind: "READ", relative_path: "Sources/Shared/AgentAI/SafetyAlert.swift" },
  ]);
  expect(context).toContainEqual({
    kind: "SEARCH",
    relative_path: "Sources/Shared/AgentAI/SafetyAlert.swift",
    query: "SafetyAlertActionHandling",
  });
  expect(JSON.stringify(context)).not.toContain("Tests/Shared");
});

it("keeps the code-owned API declaration in compiler repair context before broad searches", () => {
  const diagnostic = {
    path: "Tests/Shared/AgentAI/EmergencyResourcesTextFlowAdapterTests.swift",
    line: 25,
    column: 17,
    message: "'ButtonModel.Content' initializer is inaccessible due to 'internal' protection level",
    excerpt: "content: ButtonModel.Content(title: title)",
  };
  const context = engineeringCompilerRepairContext({
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: ["Tests/Shared/AgentAI", "Sources/Shared/AgentAI"],
    configuredContext: [
      {
        kind: "SEARCH",
        relative_path: "Sources/Shared/Chat/ChatEmergencyResourcesView.swift",
        query: "public class ButtonModel",
      },
      {
        kind: "READ",
        relative_path: "Sources/Shared/Chat/ChatEmergencyResourcesView.swift",
      },
      { kind: "READ", relative_path: "Sources/Shared/Unrelated.swift" },
    ],
  });

  expect(context.slice(0, 2)).toEqual([
    {
      kind: "READ",
      relative_path: "Tests/Shared/AgentAI/EmergencyResourcesTextFlowAdapterTests.swift",
    },
    {
      kind: "READ",
      relative_path: "Sources/Shared/Chat/ChatEmergencyResourcesView.swift",
    },
  ]);
  expect(context.findIndex((entry) => entry.kind === "SEARCH")).toBeGreaterThan(1);
});

it("treats an exact code-owned compiler symbol search miss as bounded negative evidence", async () => {
  const output = (value: string) => ({
    trust: "UNTRUSTED_DATA" as const,
    value,
    truncated: false,
    original_byte_length: Buffer.byteLength(value),
  });
  const identity = { case_id: "case-1", workspace_id: "workspace-1" };
  const read = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "compiler-read",
    identity,
    kind: "READ_FILE",
    outcome: "SUCCEEDED",
    before_digest: null,
    after_digest: canonicalDigest("exact Swift source"),
    changed_files: [],
    output: output("exact Swift source"),
  });
  const noMatch = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "compiler-search",
    identity,
    kind: "SEARCH_TEXT",
    outcome: "FAILED",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: "DISCOVERY_FAILED",
    output: output('{"tool":"search","refused":true,"failure_code":"DISCOVERY_FAILED"}'),
  });
  const unavailable = async () => {
    throw new Error("unexpected tool");
  };
  const tools = {
    read: async () => read,
    search: async () => noMatch,
    tree: unavailable,
    config: unavailable,
    write: unavailable,
    patch: unavailable,
    mkdir: unavailable,
  } as unknown as BoundedImplementationToolset;

  await expect(
    prefetchEngineeringImplementationContext(tools, [
      { kind: "READ", relative_path: "Sources/Feature.swift" },
      { kind: "SEARCH", relative_path: "Sources/Feature.swift", query: "MissingPeer" },
    ]),
  ).resolves.toEqual([
    {
      kind: "READ",
      relative_path: "Sources/Feature.swift",
      query: null,
      evidence: "exact Swift source",
    },
  ]);
});

it("keeps generator outputs in durable scope but removes them from the model-facing slice", () => {
  const durable = {
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-1",
    objective: "update an asset source",
    observable_result: "generated accessor exists",
    allowed_paths: ["Sources/schema.json", "Sources/Assets+Generated.swift"],
    test_paths: ["Sources/schema.json"],
    gate_ids: ["unit"],
    inspection_method: "compile",
    stop_condition: "gate passes",
  } as const;
  const modelFacing = engineeringModelFacingSlice(durable, ["Sources/Assets+Generated.swift"]);

  expect(durable.allowed_paths).toContain("Sources/Assets+Generated.swift");
  expect(modelFacing.allowed_paths).toEqual(["Sources/schema.json"]);
  expect(JSON.stringify(modelFacing)).not.toContain("Assets+Generated.swift");
  expect(
    engineeringImplementationPrompt({
      objective: "update an asset source",
      slice: modelFacing,
      contextPacket: "bounded",
      gateGuidance: [],
    }),
  ).not.toContain("Sources/Assets+Generated.swift");
});

it("keeps a file-bounded test path beneath a model-editable directory root", () => {
  const durable = {
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-1",
    objective: "update alert behavior",
    observable_result: "targeted test passes",
    allowed_paths: ["Sources/Feature", "Sources/Assets+Generated.swift"],
    test_paths: ["Sources/Feature/FeatureTests.swift"],
    gate_ids: ["unit"],
    inspection_method: "compile",
    stop_condition: "gate passes",
  } as const;

  expect(engineeringModelFacingSlice(durable, ["Sources/Assets+Generated.swift"])).toMatchObject({
    allowed_paths: ["Sources/Feature"],
    test_paths: ["Sources/Feature/FeatureTests.swift"],
  });
});

it("refuses a third compiler repair tool batch without a failed-target recovery", async () => {
  const response = (id: string) => ({
    model: { provider: "test", model_id: "implementation-model" },
    content: [
      {
        type: "tool-use" as const,
        id,
        name: "patch",
        input: { replacement_files: [] },
      },
    ],
  });
  const transport = new FakeTransport([
    response("repair-1"),
    response("repair-2"),
    response("repair-3"),
  ]);
  let executions = 0;
  await expect(
    runToolLoop(
      transport,
      engineeringCompilerRepairRuntimeConfig(
        createRuntimeConfig({
          model: { provider: "test", model_id: "implementation-model" },
          timeoutMs: 1_000,
          toolLimits: { maxIterations: 16, maxCalls: 64 },
        }),
      ),
      {
        messages: [{ role: "user", content: [{ type: "text", text: "repair" }] }],
        epochHandoffMessages: [
          {
            role: "user",
            content: [{ type: "json", value: { kind: "COMPILER_REPAIR_HANDOFF" } }],
          },
        ],
        tools: [{ name: "patch", inputSchema: { type: "object" } }],
        execute: async () => {
          executions += 1;
          return { outcome: "SUCCEEDED", changed_files: ["Sources/Feature.swift"] };
        },
      },
    ),
  ).rejects.toThrow(/Maximum tool iterations exceeded/u);
  expect(executions).toBe(2);
  expect(transport.requests).toHaveLength(3);
});

it("allows one bounded compiler repair retry after a clean pre-state refusal", async () => {
  const response = (id: string) => ({
    model: { provider: "test", model_id: "implementation-model" },
    content: [
      {
        type: "tool-use" as const,
        id,
        name: "patch",
        input: { replacement_files: [] },
      },
    ],
  });
  const transport = new FakeTransport([
    response("stale-tree"),
    {
      model: { provider: "test", model_id: "implementation-model" },
      content: [{ type: "text", text: "premature" }],
    },
    response("fresh-tree"),
    {
      model: { provider: "test", model_id: "implementation-model" },
      content: [{ type: "text", text: "done" }],
    },
  ]);
  let executions = 0;
  const result = await runToolLoop(
    transport,
    engineeringCompilerRepairRuntimeConfig(
      createRuntimeConfig({
        model: { provider: "test", model_id: "implementation-model" },
        timeoutMs: 1_000,
        toolLimits: { maxIterations: 16, maxCalls: 64 },
      }),
    ),
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "LARGE_COMPILER_CONTEXT_CANARY" }] },
      ],
      epochHandoffMessages: [
        {
          role: "user",
          content: [{ type: "json", value: { kind: "COMPILER_REPAIR_HANDOFF" } }],
        },
      ],
      tools: [{ name: "patch", inputSchema: { type: "object" } }],
      execute: async () => {
        executions += 1;
        return executions === 1
          ? { outcome: "FAILED", failure_code: "PRE_STATE_MISMATCH", changed_files: [] }
          : { outcome: "SUCCEEDED", failure_code: null, changed_files: ["Sources/Feature.swift"] };
      },
    },
  );

  expect(executions).toBe(2);
  expect(result).toMatchObject({ iterations: 2, calls: 2 });
  expect(JSON.stringify(transport.requests[1]?.messages)).toContain("COMPILER_REPAIR_HANDOFF");
  expect(JSON.stringify(transport.requests[1]?.messages)).not.toContain(
    "LARGE_COMPILER_CONTEXT_CANARY",
  );
  expect(JSON.stringify(transport.requests[2]?.messages)).toContain(
    '"mutation_recovery_extension_remaining":1',
  );
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
    { kind: "READ" as const, relative_path: "src/session.swift" },
    { kind: "READ" as const, relative_path: "tests/session-tests.swift" },
  ];
  expect(
    engineeringCorrectionImplementationContext(
      configured,
      ["src/flow.swift", "src/generated.swift", "src/shared.swift", "src/generated.swift"],
      true,
    ),
  ).toEqual([
    { kind: "SEARCH", relative_path: "src/flow.swift", query: "routeAlert" },
    { kind: "READ", relative_path: "src/shared.swift" },
    { kind: "READ", relative_path: "src/session.swift" },
    { kind: "READ", relative_path: "tests/session-tests.swift" },
    { kind: "READ", relative_path: "src/generated.swift" },
  ]);
  expect(
    engineeringCorrectionImplementationContext(configured, ["src/generated.swift"], false),
  ).toEqual(configured);
  expect(
    engineeringCorrectionImplementationContext(
      configured,
      ["src/flow.swift", "src/generated.swift"],
      true,
      ["src/flow.swift"],
    ),
  ).toEqual([
    { kind: "READ", relative_path: "src/shared.swift" },
    { kind: "READ", relative_path: "src/session.swift" },
    { kind: "READ", relative_path: "tests/session-tests.swift" },
    { kind: "READ", relative_path: "src/flow.swift" },
    { kind: "READ", relative_path: "src/generated.swift" },
  ]);
  expect(() =>
    engineeringCorrectionImplementationContext(
      [],
      Array.from({ length: 25 }, (_, index) => `src/generated-${String(index)}.swift`),
      true,
    ),
  ).toThrow(/code-owned discovery cap/u);
});

it("scopes cumulative correction paths to the active slice with segment boundaries", () => {
  expect(
    engineeringPriorPathsForActiveSlice(
      [
        "Sources/Previous/One.swift",
        "Sources/Active/Nested/Two.swift",
        "Sources/Active.swift",
        "Sources/Active/One.swift",
        "Sources/Active/One.swift",
        "Sources/ActiveSibling/Foreign.swift",
      ],
      ["Sources/Active", "Sources/Active.swift"],
    ),
  ).toEqual([
    "Sources/Active.swift",
    "Sources/Active/Nested/Two.swift",
    "Sources/Active/One.swift",
  ]);
});

it("prefetches only the immediately rejected leaf while retaining cumulative write provenance", () => {
  expect(
    engineeringCorrectionPathContext({
      cumulativePaths: [
        "Sources/Active/Feature.swift",
        "Tests/Active/HistoricalLargeTests.swift",
        "Tests/Active/FocusedTests.swift",
        "Sources/Foreign/Unrelated.swift",
      ],
      previousAttemptPaths: ["Sources/Active/Feature.swift", "Sources/Foreign/Unrelated.swift"],
      activeSlicePaths: ["Sources/Active", "Tests/Active"],
    }),
  ).toEqual({
    existingPaths: [
      "Sources/Active/Feature.swift",
      "Tests/Active/FocusedTests.swift",
      "Tests/Active/HistoricalLargeTests.swift",
    ],
    prefetchPaths: ["Sources/Active/Feature.swift"],
  });
});

it("retains only bounded failures from the active slice when the immediate attempt failed", () => {
  const slice = {
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-2",
    objective: "wire the production flow",
    observable_result: "real event route invokes the alert",
    allowed_paths: ["src"],
    test_paths: ["src/flow.test.ts"],
    gate_ids: ["unit"],
    inspection_method: "focused test",
    stop_condition: "required gate passes",
  } as const;
  const row = (stageAttempt: number, payload: unknown) =>
    ({ stage_attempt: stageAttempt, payload }) as never;
  const failure = (attempt: number, sliceId = slice.slice_id) => ({
    schema_version: 1,
    artifact_kind: "GateFailure",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: sliceId,
    attempt,
    diagnostics: [],
  });
  const rows = [
    row(1, { ...slice, slice_id: "slice-1" }),
    row(1, failure(1, "slice-1")),
    row(1, slice),
    row(2, failure(2)),
    row(3, failure(3)),
    row(4, failure(4)),
    row(5, failure(5)),
    row(6, failure(6)),
  ];

  const history = engineeringActiveGateFailureHistory(
    rows,
    { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 7 },
    slice,
  );
  expect(history?.current.stage_attempt).toBe(6);
  expect(history?.regressionHistory.map((entry) => entry.stage_attempt)).toEqual([3, 4, 5]);
  expect(
    engineeringActiveGateFailureHistory(
      rows,
      { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 8 },
      slice,
    ),
  ).toBeUndefined();
});

it("keeps only the active-slice rejected review through an intervening gate repair", () => {
  const slice = {
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-2",
    objective: "wire the production flow",
    observable_result: "real event route invokes the alert",
    allowed_paths: ["src"],
    test_paths: ["src/flow.test.ts"],
    gate_ids: ["unit"],
    inspection_method: "focused test",
    stop_condition: "required gate passes",
  } as const;
  const artifactRow = (stageAttempt: number, payload: unknown) =>
    ({ stage_attempt: stageAttempt, payload }) as never;
  const rows = [
    artifactRow(1, { ...slice, slice_id: "slice-1" }),
    artifactRow(1, {
      schema_version: 1,
      artifact_kind: "ReviewDecision",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      decision_id: "historical",
      rationale: "older slice rejected",
      decision: "CHANGES_REQUIRED",
      findings: ["historical finding must not leak"],
      reviewed_digest: canonicalDigest("historical"),
    }),
    artifactRow(1, slice),
    artifactRow(2, {
      schema_version: 1,
      artifact_kind: "ReviewDecision",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      decision_id: "immediate",
      rationale: "current slice rejected",
      decision: "CHANGES_REQUIRED",
      findings: [
        "[route] BLOCKER src/Flow.swift:42 — Route is missing Required: wire the existing production route",
        "[view] HIGH src/FlowView.swift:9 — Action is inert Required: exercise the real call site",
      ],
      reviewed_digest: canonicalDigest("current rejected patch"),
    }),
    artifactRow(3, {
      schema_version: 1,
      artifact_kind: "GateFailure",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      slice_id: "slice-2",
      attempt: 3,
    }),
  ];

  expect(
    engineeringPreviousReviewCorrection(
      rows,
      { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 3 },
      slice,
    ),
  ).toEqual({
    reviewed_digest: canonicalDigest("current rejected patch"),
    findings: [
      "[route] BLOCKER src/Flow.swift:42 — Route is missing Required: wire the existing production route",
      "[view] HIGH src/FlowView.swift:9 — Action is inert Required: exercise the real call site",
    ],
    source_attempt: 2,
    trust: "UNTRUSTED_DATA",
  });
  const reviewCorrection = engineeringPreviousReviewCorrection(
    rows,
    { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 3 },
    slice,
  );
  expect(
    engineeringReviewCorrectionMutationPaths(reviewCorrection?.findings ?? [], ["src"]),
  ).toEqual(["src/Flow.swift", "src/FlowView.swift"]);
  expect(() =>
    engineeringReviewCorrectionMutationPaths(
      ["[foreign] HIGH docs/README.md:1 — Foreign Required: widen scope"],
      ["src"],
    ),
  ).toThrow(/outside the active slice/);
  expect(() =>
    engineeringReviewCorrectionMutationPaths(["unstructured model prose"], ["src"]),
  ).toThrow(/invalid server format/);
  expect(
    engineeringPreviousReviewCorrection(
      rows,
      { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 4 },
      slice,
    ),
  ).toMatchObject({
    reviewed_digest: canonicalDigest("current rejected patch"),
    source_attempt: 2,
  });
  const acceptedRows = [
    ...rows,
    artifactRow(4, {
      schema_version: 1,
      artifact_kind: "ReviewDecision",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      decision_id: "accepted",
      rationale: "fresh review accepted the repaired tree",
      decision: "PASS",
      findings: [],
      reviewed_digest: canonicalDigest("accepted patch"),
    }),
  ];
  expect(
    engineeringPreviousReviewCorrection(
      acceptedRows,
      { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 5 },
      slice,
    ),
  ).toBeUndefined();
});

it("exposes a content-free code when exact server-owned prefetch exceeds its envelope", async () => {
  const output = {
    trust: "UNTRUSTED_DATA" as const,
    value: '{"tool":"read","refused":true,"failure_code":"OUTPUT_TOO_LARGE"}',
    truncated: false,
    original_byte_length: 72,
  };
  output.original_byte_length = Buffer.byteLength(output.value);
  const oversized = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "oversized-context",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "READ_FILE",
    outcome: "FAILED",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: "OUTPUT_TOO_LARGE",
    output,
  });
  const unavailable = async () => {
    throw new Error("unexpected tool");
  };
  const tools = {
    read: async () => oversized,
    search: unavailable,
    tree: unavailable,
    config: unavailable,
    write: unavailable,
    patch: unavailable,
    mkdir: unavailable,
  } as unknown as BoundedImplementationToolset;

  await expect(
    prefetchEngineeringImplementationContext(tools, [
      { kind: "READ", relative_path: "Tests/Active/HistoricalLargeTests.swift" },
    ]),
  ).rejects.toMatchObject<Partial<EngineeringImplementationContextError>>({
    name: "EngineeringImplementationContextError",
    code: "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE",
  });
  expect(
    engineeringDebugErrorCode(
      new EngineeringImplementationContextError("IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE"),
    ),
  ).toBe("IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE");
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
        required_test_paths: [
          "src/EmergencyResourcesRouterTests.swift",
          "src/EmergencyResourcesTextFlowAdapterTests.swift",
          "src/SafetyAlertTests.swift",
        ],
        required_mutation_paths: ["src/settings.ts"],
        implementation_guidance:
          "Edit the existing settings view and focused behavior tests; do not duplicate production constants in a test-only type.",
        implementation_context: [
          { kind: "READ", relative_path: "src/settings.ts" },
          { kind: "SEARCH", relative_path: "src/settings.ts", query: "redundant-fragment" },
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
      bounded_test_content_policy: BOUNDED_TEST_CONTENT_POLICY,
      gate_config_digest: loaded.catalog.config_digest,
      generator_config_digest: loaded.generatorCatalog?.config_digest,
    }),
  );
  expect(loaded.generatorCatalog?.definitions.map((entry) => entry.generator_id)).toEqual([
    "client_codegen",
  ]);
  expect(loaded.catalog.definitions.map((gate) => gate.gate_id)).toEqual(["unit"]);
  expect(loaded.catalog.definitions[0]?.gate_tier).toBe(VerificationGateTier.FAST);
  expect(loaded.catalog.definitions[0]?.required_test_paths).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
  ]);
  expect(loaded.catalog.definitions[0]?.required_mutation_paths).toEqual(["src/settings.ts"]);
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
  expect(
    engineeringGateCorrectionMutationPaths(loaded.catalog, ["unit"], ["src", "packages"]),
  ).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
  ]);
  expect(
    engineeringGateCorrectionMutationPaths(
      loaded.catalog,
      ["unit"],
      ["src", "packages"],
      [
        {
          gate_id: "unit",
          excerpt:
            "MOBL-2023 missing executable selector/evidence: EmergencyResourcesTextFlowAdapterTests",
        },
      ],
    ),
  ).toEqual(["src/EmergencyResourcesTextFlowAdapterTests.swift"]);
  expect(
    engineeringGateCorrectionMutationPaths(
      loaded.catalog,
      ["unit"],
      ["src", "packages"],
      [
        {
          gate_id: "unit",
          excerpt:
            "MOBL-2023 missing executable selector/evidence: EmergencyResourcesTextFlowAdapterTests",
        },
        {
          gate_id: "unit",
          excerpt:
            "MOBL-2023 missing executable selector/evidence: EmergencyResourcesRouterTests and SafetyAlertTests",
        },
      ],
    ),
  ).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
  ]);
  expect(
    engineeringGateCorrectionMutationPaths(
      loaded.catalog,
      ["unit"],
      ["src", "packages"],
      [
        {
          gate_id: "unit",
          excerpt:
            "MOBL-2023 incremental missing: focused behavior; SafetyAlertTests must invoke both actions",
        },
      ],
    ),
  ).toEqual(["src/SafetyAlertTests.swift"]);
  const collidingSafetyAlertCatalog = await VerificationGateCatalog.create({
    definitions: [
      {
        ...loaded.catalog.definitions[0]!,
        required_mutation_paths: ["src/SafetyAlert.swift"],
        required_test_paths: ["src/SafetyAlertTests.swift"],
      },
    ],
    executable_allowlist: [executable],
  });
  expect(
    engineeringGateCorrectionMutationPaths(
      collidingSafetyAlertCatalog,
      ["unit"],
      ["src"],
      [
        {
          gate_id: "unit",
          excerpt:
            "MOBL-2023 incremental missing: focused behavior; SafetyAlertTests must invoke both actions",
        },
      ],
    ),
  ).toEqual(["src/SafetyAlertTests.swift"]);
  expect(
    engineeringGateCorrectionMutationPaths(
      loaded.catalog,
      ["unit"],
      ["src", "packages"],
      [
        {
          gate_id: "unit",
          excerpt: "MOBL-2023 missing production contract in src/settings.ts",
        },
      ],
    ),
  ).toEqual(["src/settings.ts"]);
  expect(
    engineeringGateCorrectionMutationPaths(
      loaded.catalog,
      ["unit"],
      ["src", "packages"],
      [
        {
          gate_id: "unit",
          excerpt: "MOBL-2023 incremental missing: unshared heading",
        },
      ],
    ),
  ).toEqual(["src/settings.ts"]);
  expect(engineeringGateCorrectionMutationPaths(loaded.catalog, ["unit"], ["packages"])).toEqual(
    [],
  );
  expect(JSON.stringify(engineeringImplementationGuidance(loaded.catalog, ["unit"]))).not.toContain(
    executable,
  );
  const patchSchema = engineeringImplementationToolDefinitions.find(
    (definition) => definition.name === "patch",
  )?.inputSchema as { anyOf?: Array<{ required?: string[]; additionalProperties?: boolean }> };
  expect(patchSchema.anyOf).toHaveLength(2);
  expect(patchSchema.anyOf?.map((branch) => branch.required)).toEqual([
    ["files"],
    ["replacement_files"],
  ]);
  expect(patchSchema.anyOf?.every((branch) => branch.additionalProperties === false)).toBe(true);
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
  expect(implementationPrompt).toContain(
    "Tests must exercise observable behavior or a typed public contract",
  );
  expect(implementationPrompt).toContain("TEST_SOURCE_INTROSPECTION_REFUSED");
  expect(implementationPrompt).toContain("comments/dead code");
  expect(implementationPrompt).not.toContain(executable);
  const prefetchedInput = {
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
      required_mutation_paths: ["src/flow.test.ts", "src/flow.ts"],
      diagnostics: [
        {
          gate_id: "unit",
          outcome: "FAILED",
          trust: "UNTRUSTED_DATA",
          excerpt: "error: cannot find symbol",
          compiler_diagnostics: [],
          test_diagnostics: [],
        },
      ],
      regression_history: [
        {
          attempt: 2,
          diagnostics: [
            {
              gate_id: "unit",
              outcome: "FAILED",
              trust: "UNTRUSTED_DATA",
              excerpt: "SafetyAlert must retain the variant property",
              compiler_diagnostics: [],
              test_diagnostics: [],
            },
          ],
        },
      ],
    },
  } as const;
  const prefetchedPrompt = engineeringImplementationPrompt(prefetchedInput);
  expect(prefetchedPrompt).toContain("server already performed the complete code-owned discovery");
  expect(prefetchedPrompt).toContain("Use only the supplied write, patch, and mkdir tools");
  expect(prefetchedPrompt).toContain("bounded repository excerpt");
  expect(prefetchedPrompt).toContain("Previous required-gate correction evidence");
  expect(prefetchedPrompt).toContain("src/flow.ts");
  expect(prefetchedPrompt).toContain("cannot find symbol");
  expect(prefetchedPrompt).toContain("bounded regression history");
  expect(prefetchedPrompt).toContain("SafetyAlert must retain the variant property");
  expect(prefetchedPrompt).toContain(
    '["src/existing-source.ts","src/existing-test.ts"]. Never call write for these paths',
  );
  expect(prefetchedPrompt).toContain("patch.replacement_files and exact old_content");
  expect(prefetchedPrompt).toContain("patch.files for an absent new path");
  expect(prefetchedPrompt).toContain("never place the same path in both arrays");
  expect(prefetchedPrompt).not.toContain("Use search/tree results");
  const correctionPrompt = engineeringImplementationPrompt({
    ...prefetchedInput,
    testFirstAlreadySatisfied: true,
    reviewCorrection: {
      reviewed_digest: canonicalDigest("previous rejected patch"),
      findings: [
        "[finding-1] HIGH src/flow.ts:42 — Adapter is unreachable Required: wire the existing production event flow to invoke it",
        "[finding-2] MEDIUM src/flow.test.ts:9 — Route is untested Required: exercise the real call site",
      ],
      required_mutation_paths: ["src/flow.test.ts", "src/flow.ts"],
      mode: "DIRECT_CORRECTION",
      trust: "UNTRUSTED_DATA",
    },
  });
  expect(correctionPrompt).toContain("durable earlier attempt for this exact slice");
  expect(correctionPrompt).toContain("address the receipt-backed correction directly");
  expect(correctionPrompt).toContain(
    "A changed_files final report is not a filesystem mutation receipt",
  );
  expect(correctionPrompt).toContain("exact correction checklist");
  expect(correctionPrompt).toContain("declares every state/router/property it references");
  expect(correctionPrompt).toContain("another path-only edit is not progress");
  expect(correctionPrompt).toContain(
    "create that exact path with patch.files in the first response",
  );
  expect(correctionPrompt).toContain("do not return changed_files=[]");
  expect(correctionPrompt).toContain(
    'Immediate server-owned correction action: every exact path in ["src/flow.test.ts","src/flow.ts"] MUST receive a successful patch receipt',
  );
  expect(correctionPrompt).toContain("group existing paths into one patch.replacement_files call");
  expect(correctionPrompt).toContain("group absent paths into a separate patch.files call");
  expect(correctionPrompt).toContain(
    "Do not return a final report or changed_files=[] while any exact path remains",
  );
  expect(correctionPrompt).toContain(
    "patch.replacement_files call using exact current old_content",
  );
  expect(correctionPrompt).toContain("exact immediate correction checklist");
  expect(correctionPrompt).toContain("whitespace-only edits on required correction paths");
  expect(correctionPrompt).toContain("existing reachable production flow");
  expect(correctionPrompt).toContain("wire the existing production event flow");
  expect(correctionPrompt).toContain("do not stop after fixing only the first item");
  expect(correctionPrompt).toContain(
    '"required_mutation_paths":["src/flow.test.ts","src/flow.ts"]',
  );
  expect(correctionPrompt).toContain("every listed path must have a successful mutation receipt");
  expect(correctionPrompt).not.toContain("first successful filesystem mutation must contain only");
  const regressionGuardPrompt = engineeringImplementationPrompt({
    ...prefetchedInput,
    testFirstAlreadySatisfied: true,
    reviewCorrection: {
      reviewed_digest: canonicalDigest("previous rejected patch"),
      findings: [
        "[finding-1] HIGH src/flow.ts:42 — Adapter is unreachable Required: wire the existing production event flow to invoke it",
      ],
      required_mutation_paths: [],
      mode: "REGRESSION_GUARD",
      trust: "UNTRUSTED_DATA",
    },
  });
  expect(regressionGuardPrompt).toContain("remain the active regression checklist");
  expect(regressionGuardPrompt).toContain("patch only the exact current gate/compiler failure");
  expect(regressionGuardPrompt).toContain("fresh review will re-evaluate every finding");
  expect(regressionGuardPrompt).not.toContain(
    "every listed path must have a successful mutation receipt",
  );
  const compilerRepairPrompt = engineeringImplementationPrompt({
    ...prefetchedInput,
    compilerRepair: true,
    testFirstAlreadySatisfied: true,
  });
  expect(compilerRepairPrompt).toContain("one normal mutation batch");
  expect(compilerRepairPrompt).toContain(
    "one additional patch batch only if the first cleanly returns FAILED",
  );
  expect(compilerRepairPrompt).toContain("AMBIGUOUS result is never retryable");
  expect(compilerRepairPrompt).toContain("Set expected_before_digest to null");
  expect(compilerRepairPrompt).toContain("whole workspace tree");
  expect(compilerRepairPrompt).toContain("read/evidence digests are not valid");
  const epochHandoff = JSON.stringify(engineeringImplementationEpochHandoff(prefetchedInput));
  expect(epochHandoff).toContain("ENGINEERING_IMPLEMENTATION_CONTEXT_EPOCH");
  expect(epochHandoff).toContain(canonicalDigest("bounded repository excerpt"));
  expect(epochHandoff).toContain(canonicalDigest("bounded context"));
  expect(epochHandoff).not.toContain("bounded repository excerpt");
  expect(epochHandoff).not.toContain("bounded context");
  expect(epochHandoff).not.toContain("cannot find symbol");
  const compactCorrectionContext = engineeringImplementationContextPacket(
    "raw context canary that must not be resent",
    true,
  );
  expect(compactCorrectionContext).toContain("ENGINEERING_CORRECTION_CONTEXT_REFERENCE");
  expect(compactCorrectionContext).toContain(
    canonicalDigest("raw context canary that must not be resent"),
  );
  expect(compactCorrectionContext).not.toContain("raw context canary that must not be resent");
  expect(engineeringImplementationContextPacket("first-attempt-context", false)).toBe(
    "first-attempt-context",
  );
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
            artifact_kind: "ProgramDesign",
            case_id: "case-1",
            run_id: "run-1",
            revision: 0,
            call_flow: ["bounded flow"],
            file_tree_delta: ["src/schema.json"],
            key_types_and_signatures: ["Schema"],
            uncertainty_review: ["none"],
            expected_tests: ["unit"],
            slice_order: ["slice-1"],
            source_digest: `sha256:${"a".repeat(64)}`,
            slice_blueprints: [
              {
                slice_id: "slice-1",
                objective: "bounded change",
                observable_result: "one visible result",
                allowed_paths: ["src"],
                test_paths: ["src/settings.test.ts"],
                gate_ids: ["unit"],
                inspection_method: "inspect result",
                stop_condition: "required gate passes",
              },
            ],
          },
        },
      ],
    },
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
  const designed = await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.PROGRAM_DESIGN,
      attempt: 1,
    },
    objective: "bounded change",
    context: { packet: "bounded context" } as never,
    orderedArtifacts: [],
    processClass: "SMALL",
  });
  expect(designed).toMatchObject({
    kind: "ARTIFACT",
    artifact: {
      artifact_kind: "ProgramDesign",
      slice_blueprints: [
        {
          allowed_paths: [
            "packages/generated.ts",
            "src",
            "src/EmergencyResourcesRouterTests.swift",
            "src/EmergencyResourcesTextFlowAdapterTests.swift",
            "src/SafetyAlertTests.swift",
            "src/settings.ts",
          ],
          test_paths: [
            "src/EmergencyResourcesRouterTests.swift",
            "src/EmergencyResourcesTextFlowAdapterTests.swift",
            "src/SafetyAlertTests.swift",
            "src/settings.test.ts",
          ],
        },
      ],
    },
  });
  const planned = await executor.execute({
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
  expect(planned).toMatchObject({
    kind: "ARTIFACT",
    artifact: {
      artifact_kind: "SliceContract",
      allowed_paths: [
        "packages/generated.ts",
        "src",
        "src/EmergencyResourcesRouterTests.swift",
        "src/EmergencyResourcesTextFlowAdapterTests.swift",
        "src/SafetyAlertTests.swift",
        "src/settings.ts",
      ],
      test_paths: [
        "src/EmergencyResourcesRouterTests.swift",
        "src/EmergencyResourcesTextFlowAdapterTests.swift",
        "src/SafetyAlertTests.swift",
        "src/settings.test.ts",
      ],
    },
  });
  expect(executor.slicePlanningConstraints?.generatorBindings).toEqual([
    { triggerPaths: ["src/schema.json"], outputPaths: ["packages/generated.ts"] },
  ]);
  expect(executor.slicePlanningConstraints?.requiredGateGuidance).toEqual({
    unit: "Edit the existing settings view and focused behavior tests; do not duplicate production constants in a test-only type.",
  });
  expect(executor.slicePlanningConstraints?.requiredGateTestPaths).toEqual({
    unit: [
      "src/EmergencyResourcesRouterTests.swift",
      "src/EmergencyResourcesTextFlowAdapterTests.swift",
      "src/SafetyAlertTests.swift",
    ],
  });
  expect(executor.slicePlanningConstraints?.requiredGateMutationPaths).toEqual({
    unit: ["src/settings.ts"],
  });
  const programDesignPrompt =
    transport.requests[0]?.messages
      .flatMap((message) => message.content)
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n") ?? "";
  expect(programDesignPrompt).toContain("code-owned implementation/acceptance guidance");
  expect(programDesignPrompt).toContain("gate-required test files are injected by the server");
  expect(programDesignPrompt).not.toContain("src/EmergencyResourcesTextFlowAdapterTests.swift");
  expect(programDesignPrompt).toContain("Edit the existing settings view");
  expect(programDesignPrompt).toContain(
    "early foundational slice must not claim reachable production integration",
  );
  const planningPrompt =
    transport.requests[1]?.messages
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
  expect(planningPrompt).toContain(
    "generator outputs and gate-required test files are injected by the server",
  );
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      repository: {
        ...value.repository,
        write_path_allowlist: ["src", "packages/generated.ts"],
      },
    })}\n`,
  );
  const narrower = await loadEngineeringExecutionConfig(configPath);
  expect(narrower.configDigest).not.toBe(loaded.configDigest);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      repository: { ...value.repository, test_path_allowlist: ["src", "packages"] },
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
      gates: [{ ...value.gates[0], required_mutation_paths: ["foreign/settings.ts"] }],
    })}\n`,
  );
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/write allowlist/u);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      gates: [{ ...value.gates[0], required_test_paths: ["packages/foreign.test.ts"] }],
    })}\n`,
  );
  await expect(loadEngineeringExecutionConfig(configPath)).rejects.toThrow(/write allowlist/u);
  await writeFile(
    configPath,
    `${JSON.stringify({
      ...value,
      generators: [
        {
          ...value.generators[0],
          output_paths: ["foreign/generated.ts"],
        },
      ],
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
