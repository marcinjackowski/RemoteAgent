import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";
import {
  EngineeringStage,
  type EngineeringSliceContract,
  canonicalDigest,
  engineeringGateFailureV2,
  engineeringReviewDecision,
} from "@remoteagent/contracts";
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
  BOUNDED_DISCOVERY_BUDGET_EXHAUSTED,
  implementationToolResult,
  createImplementationReadTools,
  type BoundedImplementationToolset,
} from "@remoteagent/implementation-tools";
import {
  LocalArtifactStore,
  VerificationGateCatalog,
  VerificationGateOutcome,
  VerificationGateReceipt,
  VerificationGateTarget,
  VerificationGateTier,
  CodeOwnedGeneratorCatalog,
} from "@remoteagent/test-evidence";
import * as z from "zod";

type CorrectionEntry = Parameters<typeof productionPrefetch>[1][number];
const correctionEntry = (entry: RepairContextPlanEntry | CorrectionEntry): CorrectionEntry => {
  if (entry.kind === "READ") return { ...entry, kind: "READ" };
  if (entry.query === undefined) throw new Error("SEARCH fixture requires a query");
  return { ...entry, kind: "SEARCH", query: entry.query };
};
const prefetchEngineeringImplementationContext = (
  tools: Parameters<typeof productionPrefetch>[0],
  plan: readonly (RepairContextPlanEntry | CorrectionEntry)[],
  ...rest: Parameters<typeof productionPrefetch> extends [unknown, unknown, ...infer Tail]
    ? Tail
    : never
) => productionPrefetch(tools, plan.map(correctionEntry), ...rest);

const requiredDiagnosticEvidence = (relative_path: string, line = 1) => ({
  kind: "READ" as const,
  relative_path,
  query: null,
  evidence: JSON.stringify({
    tool: "read",
    refused: false,
    complete: true,
    relative_path,
    digest: `sha256:${"d".repeat(64)}`,
    content: Array.from(
      { length: Math.max(64, line) },
      (_, index) => `source line ${index + 1}`,
    ).join("\n"),
  }),
});

const requiredPlanReads = (plan: {
  entries: readonly {
    kind: string;
    relative_path: string;
    query?: string | null;
    required?: boolean;
  }[];
}) =>
  plan.entries
    .filter((entry) => entry.kind === "READ" && entry.required === true)
    .map((entry) => requiredDiagnosticEvidence(entry.relative_path));

import {
  addEngineeringModelUsage,
  boundedToolInputError,
  buildEngineeringGateFailureArtifact,
  classifyEngineeringModelUsage,
  createConfiguredEngineeringStageExecutor,
  createEngineeringExecution,
  createEngineeringRoleModelComposition,
  emptyEngineeringModelUsage,
  engineeringModelRoleForStage,
  engineeringImplementationContext,
  engineeringImplementationContextPacket,
  engineeringCorrectionPathContext,
  engineeringCorrectionImplementationContext,
  engineeringCorrectionFallbackReadPaths,
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
  engineeringGateFailureCorrectionAuthority,
  createEngineeringGateFailureMapping,
  engineeringExecutionConfigWithGateFailureMapping,
  engineeringCompilerRepairContext,
  engineeringCompilerRepairRuntimeConfig,
  engineeringModelFacingSlice,
  engineeringModelRequiredCorrectionPaths,
  engineeringOptionalGateCandidateReadPaths,
  engineeringMutationToolDefinitions,
  engineeringExecutionConfigFromEnv,
  loadEngineeringExecutionConfig,
  prefetchEngineeringImplementationContext as productionPrefetch,
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
import {
  type RepairContextPlanEntry,
  buildEngineeringRepairContext,
  compactEngineeringCompilerDiagnostics,
  diagnosticSymbols,
  engineeringDiagnosticWindows,
  engineeringRepairContextEntryCallCost,
  finalizeEngineeringRepairContext,
  repairContextMetadata,
} from "../src/engineering-repair-context.js";

it("compacts only recognized duplicate compiler diagnostics", () => {
  const diagnostic = (path: string, message: string, line: number) => ({
    path,
    line,
    column: 1,
    message,
    excerpt: message,
    digest: canonicalDigest(`${path}:${line}:${message}`),
  });
  const result = compactEngineeringCompilerDiagnostics([
    diagnostic("src/A.swift", "cannot find type 'QuickSpec' in scope", 4),
    diagnostic("src/A.swift", "cannot find type 'QuickSpec' in scope", 8),
    diagnostic("src/B.swift", "cannot find type 'QuickSpec' in scope", 4),
    diagnostic("src/A.swift", "unrecognized compiler failure", 10),
    diagnostic("src/A.swift", "unrecognized compiler failure", 11),
  ]);
  expect(result).toHaveLength(4);
  expect(result.filter((item) => item.message.includes("QuickSpec"))).toHaveLength(2);
  expect(result.filter((item) => item.message.includes("unrecognized"))).toHaveLength(2);
});
import { createEngineeringQualificationFixture } from "./engineering-qualification-fixture.js";
import { createStructuredPreCommitReviewSessionFactory as createStructuredReviewFactory } from "../src/engineering-workflow.js";

const execFile = promisify(execFileCallback);

const createStructuredPreCommitReviewSessionFactory = (
  input: Parameters<typeof createStructuredReviewFactory>[0],
) => createStructuredReviewFactory(input).createSession;

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
  expect(() =>
    receiptBackedImplementationReport({
      error: new EngineeringModelBudgetError(),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: true,
      unresolvedMutationAmbiguity: false,
    }),
  ).toThrow(/reserve would exceed/);
  expect(() =>
    receiptBackedImplementationReport({
      error: new EngineeringModelBudgetError(),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: false,
      unresolvedMutationAmbiguity: true,
    }),
  ).toThrow(/reserve would exceed/);
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
  expect(() =>
    receiptBackedImplementationReport({
      error: new ToolLimitError("Repeated mutation target refusal made no progress"),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: true,
      unresolvedMutationAmbiguity: false,
    }),
  ).toThrow(/Repeated mutation target refusal/);
  expect(() =>
    receiptBackedImplementationReport({
      error: new ToolLimitError("Maximum tool iterations exceeded"),
      successfulMutationPaths: ["src/a.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toThrow(/Maximum tool iterations exceeded/);
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
      error: new ToolLimitError(
        "final response omitted",
        "FINAL_WITHOUT_REQUIRED_MUTATION_RECEIPT",
      ),
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
  expect(() =>
    receiptBackedImplementationReport({
      error: new ToolLimitError(
        "all review paths were not changed",
        "FINAL_WITHOUT_REQUIRED_CORRECTION_RECEIPT",
      ),
      successfulMutationPaths: ["src/Flow.swift"],
      requiredSuccessfulMutationPathsAll: ["src/Flow.swift", "src/FlowView.swift"],
      unresolvedMutationFailure: false,
    }),
  ).toThrow(/all review paths were not changed/);
  expect(
    receiptBackedImplementationReport({
      error: new ToolLimitError(
        "final response omitted",
        "FINAL_WITHOUT_REQUIRED_CORRECTION_RECEIPT",
      ),
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
  const baselineReceipt = VerificationGateReceipt.parse({
    ...receipt,
    receipt_id: "receipt-baseline",
    // Deliberately identical to CURRENT: target identity must still select the exact receipt.
    tree_digest: canonicalDigest({ tree: 1 }),
    target: VerificationGateTarget.BASELINE,
  });
  const actual = {
    changedFiles: ["Sources/Assets+Help.swift"],
    cumulativeAgentPaths: ["Sources/Assets+Help.swift"],
    treeDigest: canonicalDigest({ tree: 1 }),
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
  const gateCatalog = {
    config_digest: canonicalDigest({ config: 1 }),
    get: (gateId: string) =>
      gateId === "xcode-full"
        ? ({
            gate_class: "TEST",
            required_mutation_paths: [],
            required_test_paths: [],
            implementation_context: [],
          } as const)
        : undefined,
  } as unknown as VerificationGateCatalog;
  const mapping = {
    mapping_digest: canonicalDigest({
      targets: [{ target_id: "target-1", kind: "SOURCE", paths: ["Sources"] }],
      slices: [
        { slice_id: "slice-1", mutation_target_ids: ["target-1"], required_read_context: [] },
      ],
      criteria: [
        {
          criterion_id: "criterion-1",
          owning_slice_id: "slice-1",
          required_gate_ids: ["xcode-full"],
          related_target_ids: ["target-1"],
        },
      ],
    }),
    targets: [{ target_id: "target-1", kind: "SOURCE" as const, paths: ["Sources"] }],
    slices: [{ slice_id: "slice-1", mutation_target_ids: ["target-1"], required_read_context: [] }],
    criteria: [
      {
        criterion_id: "criterion-1",
        owning_slice_id: "slice-1",
        required_gate_ids: ["xcode-full"],
        related_target_ids: ["target-1"],
      },
    ],
  } as const;

  const artifact = await buildEngineeringGateFailureArtifact({
    binding,
    slice,
    contextManifestDigest: canonicalDigest({ context: 1 }),
    catalogConfigDigest: canonicalDigest({ config: 1 }),
    decisionIds: ["decision-2", "decision-1"],
    result: {
      status: "BLOCKED",
      aggregate: null,
      bundle: null,
      reason: "FAILED",
      selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
      blockingGateIds: ["xcode-full"],
      receipts: [baselineReceipt, receipt],
      actual,
    },
    artifactStore: store,
    mapping,
    catalog: gateCatalog,
  });

  expect(artifact).toMatchObject({
    schema_version: 2,
    artifact_kind: "GateFailure",
    authority: "SERVER_OWNED",
    slice_id: "slice-1",
    attempt: 2,
    blocking_gate_ids: ["xcode-full"],
    receipt_ids: ["receipt-baseline", "receipt-xcode"],
    mapping_digest: mapping.mapping_digest,
    decision_ids: ["decision-1", "decision-2"],
    diagnostics: [
      expect.objectContaining({
        gate_id: "xcode-full",
        outcome: "FAILED",
        trust: "UNTRUSTED_DATA",
      }),
    ],
  });
  expect(
    artifact !== null && "observations" in artifact ? artifact.observations : undefined,
  ).toEqual([
    {
      criterion_id: "criterion-1",
      gate_id: "xcode-full",
      failure_class: "ASSERTION_FAILED",
      evidence_ref: "receipt-xcode",
      related_target_ids: ["target-1"],
    },
  ]);
  expect(
    engineeringGateFailureCorrectionAuthority(artifact!, mapping, gateCatalog, "slice-1", [
      "Sources",
    ]).paths,
  ).toEqual([]);
  await expect(
    buildEngineeringGateFailureArtifact({
      binding,
      slice,
      contextManifestDigest: canonicalDigest({ context: 1 }),
      catalogConfigDigest: canonicalDigest({ config: 1 }),
      decisionIds: [],
      result: {
        status: "BLOCKED",
        aggregate: null,
        bundle: null,
        reason: "FAILED",
        selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
        blockingGateIds: ["xcode-full"],
        receipts: [receipt],
        actual,
      },
      artifactStore: store,
    }),
  ).resolves.toBeNull();
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
        reason: "FAILED",
        selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
        blockingGateIds: ["xcode-full"],
        receipts: [receipt],
        actual,
      },
      artifactStore: store,
    }),
  ).resolves.toBeNull();
  expect(() =>
    engineeringExecutionConfigWithGateFailureMapping({ catalog: gateCatalog } as never, {
      ...mapping,
      mapping_digest: canonicalDigest({ forged: true }),
    }),
  ).toThrow();
  await expect(
    buildEngineeringGateFailureArtifact({
      binding,
      slice,
      contextManifestDigest: canonicalDigest({ context: 1 }),
      catalogConfigDigest: canonicalDigest({ config: 1 }),
      decisionIds: [],
      result: {
        status: "BLOCKED",
        aggregate: null,
        bundle: null,
        reason: "FAILED",
        selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
        blockingGateIds: ["xcode-full"],
        receipts: [baselineReceipt, receipt],
        actual,
      },
      artifactStore: store,
      mapping: { ...mapping, mapping_digest: canonicalDigest({ forged: true }) },
      catalog: gateCatalog,
    }),
  ).resolves.toBeNull();
  const foreignCatalog = {
    config_digest: gateCatalog.config_digest,
    get: (gateId: string) =>
      gateId === "foreign-gate"
        ? ({
            gate_class: "TEST",
            required_mutation_paths: ["Other.swift"],
            required_test_paths: [],
            implementation_context: [],
          } as const)
        : gateCatalog.get(gateId),
  } as unknown as VerificationGateCatalog;
  const foreignGateMapping = {
    ...mapping,
    criteria: [
      {
        criterion_id: "criterion-1",
        owning_slice_id: "slice-1",
        required_gate_ids: ["foreign-gate"],
        related_target_ids: ["target-1"],
      },
    ],
  };
  await expect(
    buildEngineeringGateFailureArtifact({
      binding,
      slice,
      contextManifestDigest: canonicalDigest({ context: 1 }),
      catalogConfigDigest: canonicalDigest({ config: 1 }),
      decisionIds: [],
      result: {
        status: "BLOCKED",
        aggregate: null,
        bundle: null,
        reason: "FAILED",
        selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
        blockingGateIds: ["xcode-full"],
        receipts: [baselineReceipt, receipt],
        actual,
      },
      artifactStore: store,
      mapping: {
        ...foreignGateMapping,
        mapping_digest: canonicalDigest({
          targets: foreignGateMapping.targets,
          slices: foreignGateMapping.slices,
          criteria: foreignGateMapping.criteria,
        }),
      },
      catalog: foreignCatalog,
    }),
  ).resolves.toBeNull();
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
        reason: "FAILED",
        selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
        blockingGateIds: ["xcode-full"],
        receipts: [baselineReceipt, receipt],
        actual,
      },
      artifactStore: store,
      mapping,
      catalog: gateCatalog,
    }),
  ).resolves.toBeNull();
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
  expect(
    engineeringGateFailureCorrectionAuthority(artifact!, mapping, gateCatalog, "slice-1", [
      "Sources",
    ]),
  ).toEqual({ status: "UNCLASSIFIED_GATE_FAILURE", paths: [] });
  expect(
    engineeringGateFailureCorrectionAuthority(
      { ...artifact!, schema_version: 1 } as never,
      mapping,
      gateCatalog,
      "slice-1",
      ["Sources"],
    ),
  ).toEqual({ status: "UNCLASSIFIED_GATE_FAILURE", paths: [] });
  expect(
    engineeringGateFailureCorrectionAuthority(
      artifact!,
      { ...mapping, mapping_digest: canonicalDigest({ forged: true }) },
      gateCatalog,
      "slice-1",
      ["Sources"],
    ),
  ).toEqual({ status: "UNCLASSIFIED_GATE_FAILURE", paths: [] });

  const stoppedAfterFastFailure = await buildEngineeringGateFailureArtifact({
    binding,
    slice,
    contextManifestDigest: canonicalDigest({ context: 1 }),
    catalogConfigDigest: canonicalDigest({ config: 1 }),
    decisionIds: [],
    result: {
      status: "BLOCKED",
      aggregate: null,
      bundle: null,
      reason: "FAST_GATE_BLOCKED_FULL",
      selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
      blockingGateIds: ["xcode-full"],
      receipts: [receipt],
      actual,
    },
    artifactStore: store,
    mapping,
    catalog: gateCatalog,
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
        selectedGateCatalogConfigDigest: canonicalDigest({ config: 1 }),
        blockingGateIds: ["xcode-full"],
        receipts: [receipt],
        actual,
      },
      artifactStore: store,
    }),
  ).resolves.toBeNull();
});

it("accepts a failed receipt from the slice-selected catalog subset only", async () => {
  const executable = "/bin/echo";
  const definition = (gate_id: string) => ({
    schema_version: 1 as const,
    gate_id,
    gate_class: "TEST" as const,
    gate_tier: VerificationGateTier.FAST,
    gate_schedule: "EACH_SLICE" as const,
    execution_order: 1,
    executable,
    argv: [],
    relative_cwd: "src",
    required: true,
    baseline: false,
    test_first: false,
    timeout_ms: 10_000,
    environment_profile: "HERMETIC" as const,
    network_profile: "DENY" as const,
    mutable_outputs: [],
    required_test_paths: [],
    required_mutation_paths: [],
  });
  const catalog = await VerificationGateCatalog.create({
    definitions: [definition("selected"), definition("full-catalog-extra")],
    executable_allowlist: [executable],
  });
  const selectedCatalog = await VerificationGateCatalog.create({
    definitions: [catalog.get("selected")!],
    executable_allowlist: [executable],
  });
  const actual = {
    changedFiles: ["src/Feature.swift"],
    cumulativeAgentPaths: ["src/Feature.swift"],
    treeDigest: canonicalDigest("tree"),
    diffDigest: canonicalDigest("diff"),
    patch: "diff --git a/src/Feature.swift b/src/Feature.swift",
    filesChanged: 1,
    insertions: 1,
    deletions: 0,
  };
  const slice = {
    schema_version: 2 as const,
    artifact_kind: "SliceContract" as const,
    case_id: "case-subset",
    run_id: "run-subset",
    revision: 1,
    slice_id: "slice-subset",
    objective: "test selected catalog binding",
    observable_result: "selected gate is validated",
    allowed_paths: ["src"],
    test_paths: ["src"],
    gate_ids: ["selected"],
    inspection_method: "run test",
    stop_condition: "test passes",
  };
  const mapping = createEngineeringGateFailureMapping({
    targets: [{ target_id: "source", kind: "SOURCE", paths: ["src"] }],
    slices: [
      { slice_id: "slice-subset", mutation_target_ids: ["source"], required_read_context: [] },
    ],
    criteria: [
      {
        criterion_id: "criterion-subset",
        owning_slice_id: "slice-subset",
        required_gate_ids: ["selected"],
        related_target_ids: ["source"],
      },
    ],
    catalog,
  });
  const artifactRoot = await realpath(await mkdtemp(join(tmpdir(), "ra055-subset-")));
  cleanup.push(artifactRoot);
  const artifactStore = new LocalArtifactStore({ root: artifactRoot });
  const log = await artifactStore.put({
    artifact_id: "subset-failure-log",
    scope: { case_id: "case-subset", workspace_id: "workspace-subset" },
    content: "assertion failed",
  });
  const receipt = VerificationGateReceipt.parse({
    schema_version: 1,
    receipt_id: "receipt-subset",
    case_id: "case-subset",
    workspace_id: "workspace-subset",
    run_id: "run-subset",
    operation_id: "operation-subset",
    gate_id: "selected",
    target: VerificationGateTarget.CURRENT,
    tree_digest: actual.treeDigest,
    config_digest: selectedCatalog.config_digest,
    command_digest: selectedCatalog.commandDigest("selected"),
    outcome: VerificationGateOutcome.FAILED,
    exit_code: 1,
    signal: null,
    duration_ms: 1,
    log_artifact: log,
    log_digest: log.digest,
  });
  const base = {
    binding: {
      caseId: "case-subset",
      workUnitId: "unit-subset",
      runId: "run-subset",
      checkpointRevision: 1,
      stage: EngineeringStage.GATE_EXECUTION,
      attempt: 1,
    },
    slice,
    contextManifestDigest: canonicalDigest("context"),
    catalogConfigDigest: catalog.config_digest,
    decisionIds: [],
    result: {
      status: "BLOCKED" as const,
      aggregate: null,
      bundle: null,
      reason: "FAILED",
      blockingGateIds: ["selected"],
      receipts: [receipt],
      selectedGateCatalogConfigDigest: selectedCatalog.config_digest,
      actual,
    },
    artifactStore,
    mapping,
    catalog,
  };
  await expect(buildEngineeringGateFailureArtifact(base)).resolves.toMatchObject({
    artifact_kind: "GateFailure",
  });
  await expect(
    buildEngineeringGateFailureArtifact({
      ...base,
      result: { ...base.result, selectedGateCatalogConfigDigest: catalog.config_digest },
    }),
  ).resolves.toBeNull();
  await expect(
    buildEngineeringGateFailureArtifact({
      ...base,
      result: { ...base.result, selectedGateCatalogConfigDigest: undefined as never },
    }),
  ).resolves.toBeNull();
});

const resolverNegativeCases = [
  ["empty candidate authority", {}],
  ["UNKNOWN failure class", { failure_class: "UNKNOWN" }],
  ["INFRASTRUCTURE failure class", { failure_class: "INFRASTRUCTURE" }],
  ["forged criterion", { criterion_id: "criterion-forged" }],
  ["gate not bound to criterion", {}],
  ["related target set mismatch", { related_target_ids: ["target-2"] }],
  ["target path outside active slice", {}],
] as const;

it.each(resolverNegativeCases)(
  "returns frozen UNCLASSIFIED_GATE_FAILURE for %s",
  (name, change) => {
    const catalog = {
      get: (gateId: string) =>
        gateId === "xcode-full" || gateId === "other-gate"
          ? ({
              gate_class: "TEST",
              required_mutation_paths: [
                name === "target path outside active slice" ? "Other" : "Sources",
              ],
              required_test_paths: [],
              implementation_context: [],
            } as const)
          : undefined,
    } as unknown as VerificationGateCatalog;
    const mapping = createEngineeringGateFailureMapping({
      catalog,
      targets: [
        {
          target_id: "target-1",
          kind: "SOURCE",
          paths: [name === "target path outside active slice" ? "Other" : "Sources"],
        },
        ...(name === "related target set mismatch"
          ? [{ target_id: "target-2", kind: "SOURCE" as const, paths: ["Sources"] }]
          : []),
      ],
      slices: [
        {
          slice_id: "slice-1",
          mutation_target_ids:
            name === "related target set mismatch" ? ["target-1", "target-2"] : ["target-1"],
          required_read_context: [],
        },
      ],
      criteria: [
        {
          criterion_id: "criterion-1",
          owning_slice_id: "slice-1",
          required_gate_ids:
            name === "gate not bound to criterion" ? ["other-gate"] : ["xcode-full"],
          related_target_ids: ["target-1"],
        },
      ],
    });
    const failure = engineeringGateFailureV2.parse({
      schema_version: 2,
      artifact_kind: "GateFailure",
      case_id: "case-1",
      run_id: "run-1",
      revision: 1,
      authority: "SERVER_OWNED",
      slice_id: "slice-1",
      attempt: 1,
      tree_digest: canonicalDigest({ tree: 1 }),
      diff_digest: canonicalDigest({ diff: 1 }),
      context_digest: canonicalDigest({ context: 1 }),
      config_digest: canonicalDigest({ config: 1 }),
      mapping_digest: mapping.mapping_digest,
      blocking_gate_ids: ["xcode-full"],
      receipt_ids: ["receipt-current"],
      decision_ids: [],
      diagnostics: [
        {
          gate_id: "xcode-full",
          outcome: "FAILED",
          log_digest: null,
          trust: "UNTRUSTED_DATA",
          excerpt: "failure",
        },
      ],
      observations: [
        {
          criterion_id: "criterion_id" in change ? change.criterion_id : "criterion-1",
          gate_id: "xcode-full",
          failure_class: "failure_class" in change ? change.failure_class : "ASSERTION_FAILED",
          evidence_ref: "receipt-current",
          related_target_ids:
            "related_target_ids" in change ? change.related_target_ids : ["target-1"],
        },
      ],
    });
    // Prove this mapping/catalog reaches authorization before injecting the one
    // defect under test. Empty authority must not mask every later predicate.
    const positiveGate = name === "gate not bound to criterion" ? "other-gate" : "xcode-full";
    const positiveFailure = engineeringGateFailureV2.parse({
      ...failure,
      blocking_gate_ids: [positiveGate],
      diagnostics: failure.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        gate_id: positiveGate,
      })),
      observations: [
        {
          criterion_id: "criterion-1",
          gate_id: positiveGate,
          failure_class: "ASSERTION_FAILED",
          evidence_ref: "receipt-current",
          related_target_ids: ["target-1"],
        },
      ],
    });
    expect(
      engineeringGateFailureCorrectionAuthority(positiveFailure, mapping, catalog, "slice-1", [
        "Sources",
        "Other",
      ]),
    ).toEqual({
      status: "AUTHORIZED",
      paths: [name === "target path outside active slice" ? "Other" : "Sources"],
    });
    const negativeCatalog =
      name === "empty candidate authority"
        ? ({
            get: (gateId: string) => {
              const definition = catalog.get(gateId);
              return definition === undefined
                ? undefined
                : { ...definition, required_mutation_paths: [] };
            },
          } as unknown as VerificationGateCatalog)
        : catalog;
    const result = engineeringGateFailureCorrectionAuthority(
      failure,
      mapping,
      negativeCatalog,
      "slice-1",
      ["Sources"],
    );
    expect(result).toEqual({ status: "UNCLASSIFIED_GATE_FAILURE", paths: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.paths)).toBe(true);
  },
);

it("selects only catalog-required paths from broad mapped gate targets", () => {
  const catalog = {
    get: (gateId: string) =>
      gateId === "gate"
        ? ({
            gate_class: "TEST",
            required_mutation_paths: ["Sources/Feature.swift"],
            required_test_paths: ["Tests/FeatureTests.swift"],
            implementation_context: [],
          } as const)
        : undefined,
  } as unknown as VerificationGateCatalog;
  const mapping = createEngineeringGateFailureMapping({
    catalog,
    targets: [
      { target_id: "source", kind: "SOURCE", paths: ["Sources/Feature.swift"] },
      { target_id: "test", kind: "TEST", paths: ["Tests/FeatureTests.swift"] },
      { target_id: "extra", kind: "SOURCE", paths: ["Sources/Unrelated.swift"] },
    ],
    slices: [
      {
        slice_id: "slice-1",
        mutation_target_ids: ["source", "test", "extra"],
        required_read_context: [],
      },
    ],
    criteria: [
      {
        criterion_id: "criterion-1",
        owning_slice_id: "slice-1",
        required_gate_ids: ["gate"],
        related_target_ids: ["source", "test", "extra"],
      },
    ],
  });
  const failure = engineeringGateFailureV2.parse({
    schema_version: 2,
    artifact_kind: "GateFailure",
    case_id: "case-1",
    run_id: "run-1",
    revision: 1,
    authority: "SERVER_OWNED",
    slice_id: "slice-1",
    attempt: 1,
    tree_digest: canonicalDigest("tree"),
    diff_digest: canonicalDigest("diff"),
    context_digest: canonicalDigest("context"),
    config_digest: canonicalDigest("config"),
    mapping_digest: mapping.mapping_digest,
    blocking_gate_ids: ["gate"],
    receipt_ids: ["receipt-current"],
    decision_ids: [],
    diagnostics: [
      {
        gate_id: "gate",
        outcome: "FAILED",
        log_digest: null,
        trust: "UNTRUSTED_DATA",
        excerpt: "failure",
      },
    ],
    observations: [
      {
        criterion_id: "criterion-1",
        gate_id: "gate",
        failure_class: "ASSERTION_FAILED",
        evidence_ref: "receipt-current",
        related_target_ids: ["source", "test", "extra"],
      },
    ],
  });

  expect(
    engineeringGateFailureCorrectionAuthority(failure, mapping, catalog, "slice-1", [
      "Sources",
      "Tests",
    ]),
  ).toEqual({
    status: "AUTHORIZED",
    paths: ["Sources/Feature.swift", "Tests/FeatureTests.swift"],
  });
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
  expect(definitions.has("read_excerpt")).toBe(false);
  expect(engineeringMutationToolDefinitions.some((tool) => tool.name === "read_excerpt")).toBe(
    false,
  );
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
  expect(correction.toolLoopPolicy?.requiredSuccessfulMutationPaths).toEqual([
    "src/Flow.swift",
    "src/FlowView.swift",
  ]);
  expect(correction.toolLoopPolicy?.requiredSuccessfulMutationPathsAll).toBeUndefined();
  expect(Object.isFrozen(correction.toolLoopPolicy?.requiredSuccessfulMutationPaths)).toBe(true);
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
    "src/ReviewTests.swift",
  ]);
  expect(combinedCorrection.toolLoopPolicy?.requiredSuccessfulMutationPaths).toEqual([
    "src/Flow.swift",
    "src/FlowView.swift",
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

it("does not promote test filenames to declarations for missing members", () => {
  const diagnostic = {
    path: "Sources/Shared/AgentAI/AgentAIFlowView.swift",
    line: 41,
    column: 18,
    message: "value of type 'AgentAIFlow' has no member 'submit'",
    excerpt: "flow.submit()",
  };
  const input = {
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: ["Sources/Shared/AgentAI", "Tests/Shared/AgentAI"],
    dependencyPaths: [
      "Tests/Shared/AgentAI/AgentAIFlowTests.swift",
      "Tests/Shared/AgentAI/Foo.swift",
    ],
    configuredContext: [
      { kind: "READ" as const, relative_path: "Sources/Shared/AgentAI/AgentAIFlow.swift" },
      { kind: "READ" as const, relative_path: "Sources/Shared/AgentAI/ChatViewModel.swift" },
      { kind: "READ" as const, relative_path: "Sources/Foreign/AgentAIFlow.swift" },
    ],
  };
  const plan = buildEngineeringRepairContext(input);
  const context = engineeringCompilerRepairContext(input);
  expect(context).toContainEqual({
    kind: "READ",
    relative_path: "Sources/Shared/AgentAI/AgentAIFlow.swift",
  });
  expect(
    plan.entries.find((entry) => entry.relative_path.endsWith("AgentAIFlowTests.swift")),
  ).toMatchObject({
    category: "TEST_SUPPORT",
  });
  expect(plan.entries.some((entry) => entry.relative_path.endsWith("Foo.swift"))).toBe(false);
  expect(context.some((entry) => entry.relative_path === ".")).toBe(false);
  expect(plan.entries).toContainEqual(
    expect.objectContaining({
      kind: "READ",
      relative_path: "Sources/Foreign/AgentAIFlow.swift",
      category: "DECLARATION",
    }),
  );
});

it("preserves exact test helper declarations for test diagnostics", () => {
  const diagnostic = {
    path: "Tests/Shared/AgentAI/AgentAIFlowTests.swift",
    line: 41,
    column: 18,
    message: "value of type 'Foo' has no member 'submit'",
    excerpt: "helper.submit()",
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: ["Tests/Shared/AgentAI"],
    dependencyPaths: ["Tests/Shared/AgentAI/Foo.swift"],
  });
  expect(plan.entries).toContainEqual(
    expect.objectContaining({
      relative_path: "Tests/Shared/AgentAI/Foo.swift",
      category: "DECLARATION",
    }),
  );
});

it("keeps a missing-member receiver declaration lookup required in tests", () => {
  const diagnostic = {
    path: "Tests/Shared/Chat/ChatViewModelTests.swift",
    line: 52,
    column: 21,
    message: "value of type 'ChatViewModel' has no member 'send'",
    excerpt: "viewModel.send()",
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: ["Tests/Shared/Chat", "Sources/Shared/Chat"],
  });
  const lookup = plan.entries.find((entry) => entry.declaration_lookup_symbol === "ChatViewModel");
  expect(lookup).toMatchObject({ declaration_lookup_required: true });
  expect(() =>
    finalizeEngineeringRepairContext(plan, [
      {
        kind: "READ",
        relative_path: diagnostic.path,
        query: null,
        evidence: diagnostic.excerpt,
      },
    ]),
  ).toThrow("REQUIRED_DECLARATION_UNRESOLVED");
});

it("requires source-backed declarations for get-only and conversion members", () => {
  const diagnostics = [
    {
      path: "Tests/Shared/Chat/ChatViewModelTests.swift",
      line: 10,
      column: 1,
      message: "cannot assign to property: 'isSendingBlocked' is a get-only property",
      excerpt: "fixture.flow.chatViewModel.isSendingBlocked = false",
    },
    {
      path: "Tests/Shared/Chat/ChatViewModelTests.swift",
      line: 11,
      column: 1,
      message: "cannot convert value to expected argument type",
      excerpt: 'fixture.model.presentSafetyAlert(eventID: "event-1", resources: fixture.resources)',
    },
  ].map((diagnostic) => ({ ...diagnostic, digest: canonicalDigest(diagnostic) }));
  const plan = buildEngineeringRepairContext({
    diagnostics,
    allowedPaths: ["Sources/Shared/Chat", "Tests/Shared/Chat"],
  });
  expect(plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        declaration_lookup_symbol: "isSendingBlocked",
        declaration_lookup_required: true,
      }),
      expect.objectContaining({
        declaration_lookup_symbol: "presentSafetyAlert",
        declaration_lookup_required: true,
      }),
    ]),
  );
});

it("prefetches and finalizes exact get-only and conversion member declarations", async () => {
  const sources = {
    canProceed: "Sources/Flow/FlowState.swift",
    showWarning: "Sources/Flow/WarningPresenter.swift",
  } as const;
  const diagnostics = [
    {
      path: "Tests/Flow/FlowTests.swift",
      line: 10,
      column: 1,
      message: "cannot assign to property: 'canProceed' is a get-only property",
      excerpt: "object.canProceed = false",
    },
    {
      path: "Tests/Flow/FlowTests.swift",
      line: 11,
      column: 1,
      message: "cannot convert value to expected argument type",
      excerpt: "object.showWarning(event: event)",
    },
  ].map((diagnostic) => ({ ...diagnostic, digest: canonicalDigest(diagnostic) }));
  const plan = buildEngineeringRepairContext({
    diagnostics,
    allowedPaths: ["Sources/Flow", "Tests/Flow"],
    configuredContext: Object.values(sources).map((relative_path) => ({
      kind: "READ" as const,
      relative_path,
    })),
  });
  const lookups = plan.entries.filter((entry) => entry.declaration_lookup_member === true);
  expect(lookups.map((entry) => entry.declaration_lookup_symbol).sort()).toEqual([
    "canProceed",
    "showWarning",
  ]);
  const tools = {
    read: async (input: { relative_path: string }) => ({
      outcome: "SUCCEEDED",
      output: {
        value: JSON.stringify({
          tool: "read",
          complete: true,
          relative_path: input.relative_path,
          digest: `sha256:${"a".repeat(64)}`,
          content: input.relative_path.endsWith("Package.swift")
            ? "// manifest"
            : input.relative_path.endsWith("FlowState.swift")
              ? '// var canProceed: Bool { false }\nlet decoy = "var canProceed"\npublic var canProceed: Bool { true }'
              : "public func showWarning(event: String) {}",
        }),
      },
    }),
  } as unknown as BoundedImplementationToolset;
  const prefetched = await prefetchEngineeringImplementationContext(tools, lookups, true);
  const finalized = finalizeEngineeringRepairContext(plan, [
    requiredDiagnosticEvidence("Tests/Flow/FlowTests.swift"),
    ...prefetched,
  ]);
  expect(
    finalized.evidence.filter((entry) => entry.kind === "READ").map((entry) => entry.relative_path),
  ).toEqual(expect.arrayContaining(Object.values(sources)));
});

async function realMemberReadFixture(contents: readonly string[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "engineering-member-real-")));
  await mkdir(join(root, "Sources", "Flow"), { recursive: true });
  const roots = contents.map((_, index) => "Sources/Flow/State" + index + ".swift");
  for (const [index, relativePath] of roots.entries())
    await writeFile(join(root, relativePath), contents[index]!);
  await writeFile(join(root, "Package.swift"), "// source module fixture\n");
  const port = await createImplementationReadTools({
    root,
    identity: { case_id: "member-real-case", workspace_id: "member-real-workspace" },
  });
  let operation = 0;
  const reads: string[] = [];
  const searches: string[] = [];
  const read = async (input: { relative_path: string }) => {
    reads.push(input.relative_path);
    return port.read({ ...input, operation_id: "member-read-" + operation++ });
  };
  const tools = {
    read,
    search: async (input: { query: string; relative_path?: string }) => {
      searches.push(input.query);
      return port.search({ ...input, operation_id: "member-search-" + operation++ });
    },
  } as unknown as BoundedImplementationToolset;
  const fields = {
    path: "Tests/FlowTests.swift",
    line: 1,
    column: 1,
    message: "cannot assign to property: 'canProceed' is a get-only property",
    excerpt: "flow.canProceed = false",
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [{ ...fields, digest: canonicalDigest(fields) }],
    allowedPaths: ["Sources/Flow", "Tests"],
    configuredContext: roots.map((relative_path) => ({ kind: "READ" as const, relative_path })),
  });
  const lookup = plan.entries.find((entry) => entry.declaration_lookup_member === true)!;
  expect(lookup).toBeDefined();
  return {
    root,
    roots,
    port,
    tools,
    read,
    reads,
    searches,
    plan,
    lookup,
    diagnostics: [{ ...fields, digest: canonicalDigest(fields) }],
  };
}

it.each([
  "public let canProceed = true\n",
  "public var \t canProceed: Bool { true }\n",
  "public let\n\n\n\n\n\n\n\ncanProceed = true\n",
])("retains a real member declaration across keyword and whitespace: %s", async (declaration) => {
  const fixture = await realMemberReadFixture([
    declaration,
    '// let canProceed = false\nlet decoy = "var canProceed"\n/* func canProceed() {} */\n',
  ]);
  const evidence = await prefetchEngineeringImplementationContext(
    fixture.tools,
    [fixture.lookup],
    true,
  );
  expect(fixture.reads).toEqual([...fixture.roots, "Package.swift"]);
  expect(fixture.searches).toEqual([]);
  const finalized = finalizeEngineeringRepairContext(fixture.plan, [
    requiredDiagnosticEvidence("Tests/FlowTests.swift"),
    ...evidence,
  ]);
  const declarationEvidence = finalized.evidence.find(
    (entry) => entry.kind === "READ" && entry.relative_path === fixture.roots[0],
  );
  expect(declarationEvidence).toBeDefined();
  expect(declarationEvidence!.evidence).toContain(declaration.trimEnd());
  expect(declarationEvidence!.full_file_digest).toBe(
    "sha256:" + createHash("sha256").update(declaration).digest("hex"),
  );
  expect(await readFile(join(fixture.root, fixture.roots[0]!), "utf8")).toBe(declaration);
});

it("rejects real var/let ambiguity even when global search returns only its first file", async () => {
  const fixture = await realMemberReadFixture([
    "public var canProceed: Bool { true }\n",
    "public let canProceed = false\n",
  ]);
  const search = await fixture.port.search({
    operation_id: "prove-first-file",
    query: "var canProceed",
  });
  expect(search.outcome).toBe("SUCCEEDED");
  if (search.outcome !== "SUCCEEDED") throw new Error("real search fixture failed");
  const payload = JSON.parse(search.output.value) as { items: { relative_path: string }[] };
  expect([...new Set(payload.items.map((item) => item.relative_path))]).toEqual([fixture.roots[0]]);
  await expect(
    prefetchEngineeringImplementationContext(fixture.tools, [fixture.lookup], true),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  expect(fixture.reads).toEqual(fixture.roots);
  expect(fixture.searches).toEqual([]);
});

it("rejects retained real member evidence from outside its declared domain", async () => {
  const fixture = await realMemberReadFixture(["public let canProceed = true\n"]);
  const evidence = await prefetchEngineeringImplementationContext(
    fixture.tools,
    [fixture.lookup],
    true,
  );
  const outside = "Sources/Other.swift";
  await writeFile(join(fixture.root, outside), "public let canProceed = false\n");
  const read = await fixture.port.read({ relative_path: outside, operation_id: "outside-read" });
  if (read.outcome !== "SUCCEEDED") throw new Error("outside fixture read failed");
  const forgedProvenance = evidence.map((entry) =>
    entry.relative_path === fixture.roots[0]
      ? { ...entry, relative_path: outside, evidence: read.output.value }
      : entry,
  );
  expect(() =>
    finalizeEngineeringRepairContext(fixture.plan, [
      requiredDiagnosticEvidence("Tests/FlowTests.swift"),
      ...forgedProvenance,
    ]),
  ).toThrow(/REQUIRED_DECLARATION_UNRESOLVED/);
});

it("rejects missing real member declarations and ignores declarations outside the exact domain", async () => {
  const fixture = await realMemberReadFixture([
    '// var canProceed = true\nlet copy = "let canProceed = false"\n',
    "public let another = true\n",
  ]);
  await mkdir(join(fixture.root, "Sources", "Flow2"), { recursive: true });
  await writeFile(join(fixture.root, "Sources", "Flow2", "State.swift"), "let canProceed = true\n");
  await expect(
    prefetchEngineeringImplementationContext(fixture.tools, [fixture.lookup], true),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  expect(fixture.reads).toEqual(fixture.roots);
  expect(fixture.searches).toEqual([]);
});

it.each([
  "failed",
  "truncated",
  "incomplete",
  "malformed",
  "refused",
  "invalid-refused",
  "invalid-digest",
  "wrong-path",
  "wrong-tool",
  "invalid-content",
] as const)("rejects a late %s member read after a valid first match", async (mode) => {
  const fixture = await realMemberReadFixture([
    "public let canProceed = true\n",
    "public let another = false\n",
  ]);
  const tools = {
    ...fixture.tools,
    read: async (input: { relative_path: string }) => {
      const result = await fixture.read(input);
      if (input.relative_path !== fixture.roots[1]) return result;
      if (mode === "failed")
        return { ...result, outcome: "FAILED" as const, failure_code: "DISCOVERY_FAILED" };
      if (result.outcome !== "SUCCEEDED") throw new Error("fixture read failed");
      if (mode === "truncated") return { ...result, output: { ...result.output, truncated: true } };
      if (mode === "malformed")
        return { ...result, output: { ...result.output, value: "not-json" } };
      const payload = JSON.parse(result.output.value) as Record<string, unknown>;
      switch (mode) {
        case "incomplete":
          payload.complete = false;
          break;
        case "refused":
          payload.refused = true;
          break;
        case "invalid-refused":
          payload.refused = "false";
          break;
        case "invalid-digest":
          payload.digest = "not-a-digest";
          break;
        case "wrong-path":
          payload.relative_path = fixture.roots[0];
          break;
        case "wrong-tool":
          payload.tool = "search";
          break;
        case "invalid-content":
          payload.content = null;
          break;
      }
      return { ...result, output: { ...result.output, value: JSON.stringify(payload) } };
    },
  } as unknown as BoundedImplementationToolset;
  await expect(
    prefetchEngineeringImplementationContext(tools, [fixture.lookup], true),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  expect(fixture.reads).toEqual(fixture.roots);
});

it("refuses unenumerated member domains instead of selecting a first file from a directory", async () => {
  const fixture = await realMemberReadFixture(["public let canProceed = true\n"]);
  await expect(
    prefetchEngineeringImplementationContext(
      fixture.tools,
      [
        {
          ...fixture.lookup,
          declaration_lookup_roots: ["Sources/Flow"],
        },
      ],
      true,
    ),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  expect(fixture.reads).toEqual([]);
});

it("uses real allowed source files when configured member reads are absent", async () => {
  const fixture = await realMemberReadFixture(["public let canProceed = true\n"]);
  const plan = buildEngineeringRepairContext({
    diagnostics: fixture.diagnostics,
    allowedPaths: [...fixture.roots, "Tests/FlowTests.swift"],
  });
  const lookup = plan.entries.find((entry) => entry.declaration_lookup_member === true)!;
  expect(lookup.declaration_lookup_roots).toEqual(fixture.roots);
  await expect(
    prefetchEngineeringImplementationContext(fixture.tools, [lookup], true),
  ).resolves.toBeDefined();
  expect(fixture.reads).toEqual([...fixture.roots, "Package.swift"]);
});

it("fails closed when a member declaration span cannot fit its bounded evidence window", async () => {
  const fixture = await realMemberReadFixture([
    "public let" + "\n".repeat(12) + "canProceed = true\n",
  ]);
  const evidence = await prefetchEngineeringImplementationContext(
    fixture.tools,
    [fixture.lookup],
    true,
  );
  expect(() =>
    finalizeEngineeringRepairContext(fixture.plan, [
      requiredDiagnosticEvidence("Tests/FlowTests.swift"),
      ...evidence,
    ]),
  ).toThrow(/REQUIRED_DECLARATION_UNRESOLVED/);
});

it("bounds member declaration searches to configured sources or allowed roots", () => {
  const diagnostic = {
    path: "Tests/Flow/FlowTests.swift",
    line: 1,
    column: 1,
    message: "cannot assign to property: 'canProceed' is a get-only property",
    excerpt: "object.canProceed = false",
    digest: canonicalDigest("member-domain-roots"),
  };
  const configuredPlan = buildEngineeringRepairContext({
    diagnostics: [diagnostic],
    allowedPaths: ["Sources/Flow", "Sources/Flow2"],
    configuredContext: [{ kind: "READ" as const, relative_path: "Sources/Flow/FlowState.swift" }],
  });
  expect(
    configuredPlan.entries.find((entry) => entry.declaration_lookup_member === true),
  ).toMatchObject({
    declaration_lookup_roots: ["Sources/Flow/FlowState.swift"],
  });
  const fallbackPlan = buildEngineeringRepairContext({
    diagnostics: [diagnostic],
    allowedPaths: ["Sources/Flow.swift", "Sources/Flow2.swift", "Sources/Flow2Extra.swift"],
  });
  expect(
    fallbackPlan.entries.find((entry) => entry.declaration_lookup_member === true),
  ).toMatchObject({
    declaration_lookup_roots: [
      "Sources/Flow.swift",
      "Sources/Flow2.swift",
      "Sources/Flow2Extra.swift",
    ],
  });
});

it("normalizes generic missing-member receivers to the exact source declaration", () => {
  const diagnostic = {
    path: "Tests/Shared/Chat/ChatViewModelTests.swift",
    line: 52,
    column: 21,
    message: "type 'ChatViewModel<SonderChat, Nested<Inner>>' has no member 'send'",
    excerpt: "viewModel.send()",
  };
  const compactGenericDiagnostic = {
    path: "Tests/Shared/Chat/ABUsageTests.swift",
    line: 12,
    column: 8,
    message: "type 'AB<foo<bar>>' has no member 'send'",
    excerpt: "value.send()",
  };
  const input = {
    diagnostics: [
      { ...diagnostic, digest: canonicalDigest(diagnostic) },
      { ...compactGenericDiagnostic, digest: canonicalDigest(compactGenericDiagnostic) },
    ],
    allowedPaths: ["Sources/Shared/Chat", "Tests/Shared/Chat"],
    dependencyPaths: ["Tests/Shared/Chat/ChatViewModelTests.swift"],
    configuredContext: [
      { kind: "READ" as const, relative_path: "Sources/Shared/Chat/ChatViewModel.swift" },
      { kind: "READ" as const, relative_path: "Sources/Shared/Chat/AB.swift" },
    ],
  };
  const plan = buildEngineeringRepairContext(input);
  const context = engineeringCompilerRepairContext(input);
  expect(context).toContainEqual({
    kind: "READ",
    relative_path: "Sources/Shared/Chat/ChatViewModel.swift",
  });
  expect(context).toContainEqual({
    kind: "READ",
    relative_path: "Sources/Shared/Chat/AB.swift",
  });
  expect(
    plan.entries.find((entry) => entry.relative_path.endsWith("ChatViewModelTests.swift")),
  ).toMatchObject({
    category: "DIAGNOSTIC_LOCATION",
  });
  expect(JSON.stringify(context)).not.toContain("Nested<Inner>");
  expect(context.some((entry) => entry.relative_path === ".")).toBe(false);
});

it("rejects malformed generic receiver syntax and generic argument symbols", () => {
  const valid = {
    path: "Tests/Shared/Chat/ABUsageTests.swift",
    line: 12,
    column: 8,
    message: "type 'AB<ForeignType,Nested<Inner>>' has no member 'send'",
    excerpt: "value.send()",
  };
  const malformed = {
    ...valid,
    line: 13,
    message: "type 'AB<ForeignType,Nested<Inner>' has no member 'send'",
  };
  const extraClose = {
    ...valid,
    line: 14,
    message: "type 'AB<ForeignType>>' has no member 'send'",
  };
  const symbols = diagnosticSymbols([{ ...valid, digest: canonicalDigest(valid) }]);
  expect(symbols).toContain("AB");
  expect(symbols).not.toContain("ForeignType");
  expect(diagnosticSymbols([{ ...extraClose, digest: canonicalDigest(extraClose) }])).not.toContain(
    "AB",
  );
  const context = engineeringCompilerRepairContext({
    diagnostics: [{ ...malformed, digest: canonicalDigest(malformed) }],
    allowedPaths: ["Sources/Shared/Chat", "Tests/Shared/Chat"],
    configuredContext: [{ kind: "READ", relative_path: "Sources/Shared/Chat/AB.swift" }],
  });
  expect(context.some((entry) => entry.relative_path.endsWith("/AB.swift"))).toBe(false);
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

it("classifies test-only external missing types as non-terminal test support", () => {
  const plan = buildEngineeringRepairContext({
    diagnostics: [
      {
        path: "Tests/FeatureTests.swift",
        line: 18,
        column: 4,
        message: "cannot find type 'Analytics' in scope",
        excerpt: "Analytics",
        digest: canonicalDigest("analytics"),
      },
    ],
    allowedPaths: ["Sources/Shared", "Tests"],
    dependencyPaths: [],
    maxEntries: 24,
  });
  expect(plan.unresolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ symbol: "Analytics", category: "TEST_SUPPORT" }),
    ]),
  );
  expect(plan.unresolved.some((item) => item.category === "DECLARATION")).toBe(false);
  expect(plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        declaration_lookup_symbol: "Analytics",
        declaration_lookup_required: false,
      }),
    ]),
  );
});

it("finalizes optional test external lookup omissions but rejects production omissions", async () => {
  const makePlan = (path: string) =>
    buildEngineeringRepairContext({
      diagnostics: [
        {
          path,
          line: 18,
          column: 4,
          message: "cannot find type 'Analytics' in scope",
          excerpt: "Analytics",
          digest: canonicalDigest(path),
        },
      ],
      allowedPaths: ["Sources/Shared", "Tests"],
      dependencyPaths: [],
      maxEntries: 24,
    });
  const result = (value: string) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: "search",
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "SEARCH_TEXT",
      outcome: "SUCCEEDED",
      before_digest: null,
      after_digest: canonicalDigest(value),
      changed_files: [],
      output: {
        trust: "UNTRUSTED_DATA",
        value,
        truncated: false,
        original_byte_length: value.length,
      },
    });
  const tools = {
    search: async () => result(JSON.stringify({ tool: "search", complete: true, items: [] })),
    read: async () => {
      throw new Error("read must not occur");
    },
  } as unknown as BoundedImplementationToolset;
  const testPlan = makePlan("Tests/FeatureTests.swift");
  const testEvidence = await prefetchEngineeringImplementationContext(
    tools,
    testPlan.entries.filter((entry) => entry.declaration_lookup_symbol !== undefined),
    true,
  );
  expect(() =>
    finalizeEngineeringRepairContext(testPlan, [...requiredPlanReads(testPlan), ...testEvidence]),
  ).not.toThrow();
  const productionPlan = makePlan("Sources/Feature.swift");
  const productionEvidence = await prefetchEngineeringImplementationContext(
    tools,
    productionPlan.entries.filter((entry) => entry.declaration_lookup_symbol !== undefined),
    true,
  );
  expect(() =>
    finalizeEngineeringRepairContext(productionPlan, [
      ...requiredPlanReads(productionPlan),
      ...productionEvidence,
    ]),
  ).toThrow("REQUIRED_DECLARATION_UNRESOLVED");
});

it("stops optional declaration recovery after the first exact-read failure", async () => {
  const plan = buildEngineeringRepairContext({
    diagnostics: [
      {
        path: "Tests/FeatureTests.swift",
        line: 18,
        column: 4,
        message: "cannot find type 'Analytics' in scope",
        excerpt: "Analytics",
        digest: canonicalDigest("analytics-failure"),
      },
    ],
    allowedPaths: ["Sources/Shared", "Tests"],
    dependencyPaths: [],
    maxEntries: 24,
  });
  const entry = plan.entries.find(
    (candidate) => candidate.declaration_lookup_symbol === "Analytics",
  )!;
  const calls: string[] = [];
  const envelope = (
    kind: "SEARCH_TEXT" | "READ_FILE",
    outcome: "SUCCEEDED" | "FAILED",
    value: string,
    failure_code?: string,
  ) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: `op-${calls.length}`,
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind,
      outcome,
      before_digest: null,
      after_digest: outcome === "SUCCEEDED" ? canonicalDigest(value) : null,
      changed_files: [],
      ...(failure_code === undefined ? {} : { failure_code }),
      output: {
        trust: "UNTRUSTED_DATA",
        value,
        truncated: false,
        original_byte_length: value.length,
      },
    });
  const tools = {
    search: async (input: { query: string; relative_path?: string }) => {
      calls.push(`search:${input.relative_path ?? "<root>"}:${input.query}`);
      if (input.query === "Analytics")
        return envelope("SEARCH_TEXT", "FAILED", "{}", "OUTPUT_TOO_LARGE");
      if (input.query === "struct Analytics")
        return envelope(
          "SEARCH_TEXT",
          "SUCCEEDED",
          JSON.stringify({
            tool: "search",
            items: [
              { relative_path: "Sources/Shared/Analytics.swift", content: "struct Analytics" },
            ],
          }),
        );
      return envelope("SEARCH_TEXT", "FAILED", "{}", "DISCOVERY_FAILED");
    },
    read: async (input: { relative_path: string }) => {
      calls.push(`read:${input.relative_path}`);
      return envelope("READ_FILE", "FAILED", "{}", "DISCOVERY_FAILED");
    },
  } as unknown as BoundedImplementationToolset;
  const evidence = await prefetchEngineeringImplementationContext(tools, [entry], true);
  expect(calls).toEqual([
    "search:<root>:Analytics",
    "search:<root>:struct Analytics",
    "read:Sources/Shared/Analytics.swift",
  ]);
  expect(evidence).toEqual([expect.objectContaining({ kind: "SEARCH", evidence: "" })]);
  expect(() =>
    finalizeEngineeringRepairContext(plan, [...requiredPlanReads(plan), ...evidence]),
  ).not.toThrow();
});

it("merges overlapping compiler header and diagnostic excerpt windows", async () => {
  const calls: Array<{ start_line: number; end_line: number }> = [];
  const tools = {
    readExcerpt: async (input: { relative_path: string; start_line: number; end_line: number }) => {
      calls.push(input);
      return {
        outcome: "SUCCEEDED",
        output: {
          value: JSON.stringify({
            tool: "read_excerpt",
            relative_path: input.relative_path,
            complete: false,
            start_line: input.start_line,
            end_line: input.end_line,
            full_file_digest: canonicalDigest("file"),
            content: "line content\n",
          }),
        },
      };
    },
  } as unknown as BoundedImplementationToolset;
  const plan = [
    {
      kind: "READ" as const,
      relative_path: "Sources/Feature.swift",
      category: "DIAGNOSTIC_LOCATION" as const,
      rank: 0,
      required: true,
      provenance: "test",
    },
  ];
  await prefetchEngineeringImplementationContext(
    tools,
    plan,
    false,
    [],
    [
      { path: "Sources/Feature.swift", line: 20 },
      { path: "Sources/Feature.swift", line: 40 },
    ],
  );
  expect(calls).toEqual([
    { relative_path: "Sources/Feature.swift", start_line: 1, end_line: 24 },
    { relative_path: "Sources/Feature.swift", start_line: 37, end_line: 43 },
  ]);
  expect(engineeringDiagnosticWindows([20, 40])).toEqual([
    { start: 1, end: 24 },
    { start: 37, end: 43 },
  ]);
  expect(engineeringRepairContextEntryCallCost(plan[0]!, [20, 40])).toBe(calls.length);
});

it("injects review regression paths into ranked compiler repair metadata", () => {
  const compilerDiagnostic = {
    path: "Sources/Shared/AgentAI/Alert.swift",
    line: 12,
    column: 4,
    message: "type 'Alert' has no member 'onText988'",
    excerpt: "alert.onText988()",
    digest: canonicalDigest("review-regression-diagnostic"),
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [compilerDiagnostic],
    allowedPaths: ["Sources/Shared/AgentAI"],
    dependencyPaths: ["Sources/Shared/AgentAI/Alert.swift"],
    reviewRegressionPaths: ["Sources/Shared/AgentAI/AlertRegression.swift"],
  });
  const reviewIndex = plan.entries.findIndex((entry) => entry.category === "REVIEW_REGRESSION");
  expect(reviewIndex).toBeGreaterThan(
    plan.entries.findIndex((entry) => entry.category === "DECLARATION"),
  );
  expect(repairContextMetadata(plan).entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relative_path: "Sources/Shared/AgentAI/AlertRegression.swift",
        category: "REVIEW_REGRESSION",
        rank: 4,
      }),
    ]),
  );
});

it("root-discovers and exact-reads a sibling canonical missing-type declaration", async () => {
  const diagnostic = {
    path: "Sources/Shared/AgentAI/SafetyAlert.swift",
    line: 12,
    column: 9,
    message: "cannot find type 'EmergencyResources' in scope",
    excerpt: "let resources: EmergencyResources",
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: ["Sources/Shared/AgentAI"],
    dependencyPaths: ["Sources/Shared/AgentAI/SafetyAlert.swift"],
    maxEntries: 24,
  });
  const lookup = plan.entries.find(
    (entry) => entry.declaration_lookup_symbol === "EmergencyResources",
  );
  expect(lookup).toMatchObject({ kind: "SEARCH", relative_path: ".", query: "EmergencyResources" });
  const identity = { case_id: "case-1", workspace_id: "workspace-1" };
  const result = (value: string, operation_id: string) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id,
      identity,
      kind: "SEARCH_TEXT",
      outcome: "SUCCEEDED",
      before_digest: null,
      after_digest: canonicalDigest(value),
      changed_files: [],
      output: {
        trust: "UNTRUSTED_DATA",
        value,
        truncated: false,
        original_byte_length: value.length,
      },
    });
  const calls: string[] = [];
  const tools = {
    search: async (input: { query: string; relative_path?: string }) => {
      calls.push(`search:${input.relative_path ?? "<root>"}:${input.query}`);
      return result(
        JSON.stringify({
          tool: "search",
          refused: false,
          complete: true,
          dropped: 0,
          items: [
            {
              relative_path: "Sources/Shared/Chat/UnrelatedEmergencyResources.swift",
              digest: "sha256:decoy",
              line: 1,
              content: "public struct EmergencyResources {}",
            },
            {
              relative_path: "Sources/Shared/Chat/EmergencyResources.swift",
              digest: "sha256:declaration",
              line: 1,
              content: "[filename match]",
            },
          ],
        }),
        "lookup",
      );
    },
    read: async (input: { relative_path: string }) => {
      calls.push(`read:${input.relative_path}`);
      return result(
        JSON.stringify({
          tool: "read",
          refused: false,
          complete: true,
          relative_path: input.relative_path,
          digest: "sha256:declaration",
          content: "public struct EmergencyResources: Codable { let text988: String? }",
        }),
        "read",
      );
    },
  } as unknown as BoundedImplementationToolset;
  const prefetched = await prefetchEngineeringImplementationContext(tools, [lookup!], true);
  expect(calls).toEqual([
    "search:<root>:EmergencyResources",
    "read:Sources/Shared/Chat/EmergencyResources.swift",
    "read:Package.swift",
  ]);
  const finalized = finalizeEngineeringRepairContext(plan, [
    ...requiredPlanReads(plan),
    ...prefetched,
  ]);
  expect(finalized.evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "READ",
        relative_path: "Sources/Shared/Chat/EmergencyResources.swift",
      }),
    ]),
  );
});

it("retains source-backed declaring Package.swift evidence after exact lookup", async () => {
  const plan = [
    {
      kind: "READ" as const,
      relative_path: "SharedLibrary/Package.swift",
      category: "DIAGNOSTIC_LOCATION" as const,
      rank: 0,
      required: true,
      provenance: "manifest-consuming-read",
    },
    {
      kind: "SEARCH" as const,
      relative_path: ".",
      query: "EmergencyResources",
      category: "DECLARATION" as const,
      rank: 1,
      required: false,
      provenance: "declaration-lookup:EmergencyResources",
      declaration_lookup_symbol: "EmergencyResources",
      declaration_lookup_roots: ["SharedLibrary/Sources/Chat"],
      declaration_lookup_required: true,
      declaration_lookup_manifest_required: true,
    },
  ];
  const result = (kind: "SEARCH_TEXT" | "READ_FILE", value: string) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: `${kind}-${value.length}`,
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind,
      outcome: "SUCCEEDED",
      before_digest: null,
      after_digest: canonicalDigest(value),
      changed_files: [],
      output: {
        trust: "UNTRUSTED_DATA",
        value,
        truncated: false,
        original_byte_length: value.length,
      },
    });
  const failedRead = () =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: "manifest-failure",
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "READ_FILE",
      outcome: "FAILED",
      before_digest: null,
      after_digest: null,
      changed_files: [],
      failure_code: "DISCOVERY_FAILED",
      output: {
        trust: "UNTRUSTED_DATA",
        value: "manifest unavailable",
        truncated: false,
        original_byte_length: 20,
      },
    });
  const tools = {
    search: async () =>
      result(
        "SEARCH_TEXT",
        JSON.stringify({
          tool: "search",
          complete: true,
          items: [
            {
              relative_path: "SharedLibrary/Sources/Chat/EmergencyResources.swift",
              content: "public struct EmergencyResources {}",
            },
          ],
        }),
      ),
    read: async (input: { relative_path: string }) =>
      result(
        "READ_FILE",
        JSON.stringify({
          tool: "read",
          complete: true,
          relative_path: input.relative_path,
          digest: canonicalDigest(input.relative_path),
          content: input.relative_path.endsWith("Package.swift")
            ? 'let package = Package(name: "SharedLibrary", products: [.library(name: "Chat")])'
            : "public struct EmergencyResources {}",
        }),
      ),
  } as unknown as BoundedImplementationToolset;
  const prefetched = await prefetchEngineeringImplementationContext(tools, plan, true);
  expect(prefetched).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relative_path: "SharedLibrary/Sources/Chat/EmergencyResources.swift",
      }),
      expect.objectContaining({
        relative_path: "SharedLibrary/Package.swift",
        query: null,
      }),
    ]),
  );
  const finalizedPlan = {
    entries: plan,
    omissions: [],
    unresolved: [],
    diagnostics: [],
    bytes: 0,
    token_estimate: 0,
    limits: { entries: 24, bytes: 100_000, tokens: 20_000 },
  };
  expect(() => finalizeEngineeringRepairContext(finalizedPlan, prefetched)).not.toThrow();
  const manifestFailureTools = {
    ...tools,
    read: async (input: { relative_path: string }) =>
      input.relative_path.endsWith("Package.swift") ? failedRead() : tools.read(input),
  } as unknown as BoundedImplementationToolset;
  await expect(
    prefetchEngineeringImplementationContext(manifestFailureTools, plan, true),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
});

it.each(["SharedLibrary/Sources/Chat/ButtonView.swift", "Sources/Feature/ButtonView.swift"])(
  "resolves a call-site type from the required diagnostic source window: %s",
  async (declarationPath) => {
    const path = "Sources/Feature/SafetyAlert.swift";
    const basePlan = buildEngineeringRepairContext({
      diagnostics: [
        {
          path,
          line: 125,
          column: 4,
          message: "extra argument 'content' in call",
          excerpt: "argument content",
          digest: canonicalDigest("call-site-window"),
        },
      ],
      allowedPaths: ["Sources/Feature"],
      dependencyPaths: [],
    });
    const plan = basePlan;
    const marker = plan.entries.find((entry) => entry.call_site_lookup_required === true);
    expect(marker).toBeDefined();
    const calls: string[] = [];
    const tools = {
      readExcerpt: async (input: { start_line: number; end_line: number }) => {
        calls.push("excerpt");
        return {
          outcome: "SUCCEEDED",
          output: {
            value: JSON.stringify({
              tool: "read_excerpt",
              complete: false,
              relative_path: path,
              start_line: input.start_line,
              end_line: input.end_line,
              full_file_digest: canonicalDigest("source-window"),
              content: Array.from({ length: input.start_line === 1 ? 24 : 7 }, (_, index) =>
                input.start_line !== 1 && index === 0
                  ? "/* DecoyType("
                  : input.start_line !== 1 && index === 1
                    ? "still decoy"
                    : input.start_line !== 1 && index === 2
                      ? "*/"
                      : input.start_line !== 1 && index === 3
                        ? "ButtonView(model: model, content: content)"
                        : input.start_line !== 1 && index === 4
                          ? "AfterDiagnosticType(model: model)"
                          : `source line ${input.start_line + index}`,
              ).join("\n"),
            }),
          },
        };
      },
      search: async () => ({
        outcome: "SUCCEEDED",
        output: {
          value: JSON.stringify({
            items: [{ relative_path: declarationPath }],
          }),
        },
      }),
      read: async (input: { relative_path: string }) => ({
        outcome: "SUCCEEDED",
        output: {
          value: JSON.stringify({
            tool: "read",
            complete: true,
            relative_path: input.relative_path,
            digest: canonicalDigest(input.relative_path),
            content: input.relative_path.endsWith("Package.swift")
              ? 'let package = Package(name: "SharedLibrary")'
              : "public struct ButtonView {}",
          }),
        },
      }),
    } as unknown as BoundedImplementationToolset;
    const prefetched = await prefetchEngineeringImplementationContext(
      tools,
      plan.entries,
      true,
      [],
      [{ path, line: 125 }],
    );
    const declarationEvidence = prefetched.filter(
      (entry) => entry.query?.startsWith("__declaration_lookup__:") === true,
    );
    expect(
      new Set(declarationEvidence.map((entry) => `${entry.relative_path}:${entry.query ?? ""}`))
        .size,
    ).toBe(declarationEvidence.length);
    expect(calls).toContain("excerpt");
    expect(prefetched).toEqual(
      expect.arrayContaining([expect.objectContaining({ relative_path: declarationPath })]),
    );
    expect(prefetched.some((entry) => entry.query?.includes("AfterDiagnosticType") === true)).toBe(
      false,
    );
    const finalized = finalizeEngineeringRepairContext({ ...plan, unresolved: [] }, prefetched);
    expect(finalized.evidence.some((entry) => entry.relative_path === declarationPath)).toBe(true);
    if (declarationPath === "Sources/Feature/ButtonView.swift") {
      expect(
        finalized.evidence.filter(
          (entry) => entry.relative_path === "Package.swift" && entry.query === null,
        ),
      ).toHaveLength(1);
    }
  },
);

it("creates a server declaration lookup for a qualified-module missing-type diagnostic", () => {
  const diagnostic = {
    path: "Sources/Shared/AgentAI/SafetyAlert.swift",
    line: 12,
    column: 9,
    message: "no type named 'EmergencyResources' in module 'Networking'",
    excerpt: "let resources: Networking.EmergencyResources",
    digest: canonicalDigest("qualified-missing-type"),
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [diagnostic],
    allowedPaths: ["Sources/Shared/AgentAI"],
    dependencyPaths: ["Sources/Shared/AgentAI/SafetyAlert.swift"],
  });
  expect(plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        declaration_lookup_symbol: "EmergencyResources",
        query: "EmergencyResources",
        declaration_lookup_required: true,
      }),
    ]),
  );
});

it("treats a missing type used as a qualified namespace as usage context", () => {
  const diagnostic = {
    path: "Sources/Shared/AgentAI/SafetyAlert.swift",
    line: 12,
    column: 9,
    message: "cannot find type 'Chat' in scope",
    excerpt: "let resources: Chat.EmergencyResources",
    digest: canonicalDigest("qualified-namespace-missing-type"),
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [diagnostic],
    allowedPaths: ["Sources/Shared/AgentAI"],
    dependencyPaths: [],
  });
  expect(plan.entries.find((entry) => entry.declaration_lookup_symbol === "Chat")).toBeUndefined();
  expect(plan.unresolved).toEqual(
    expect.arrayContaining([expect.objectContaining({ symbol: "Chat", category: "USAGE" })]),
  );
});

it("does not promote unrelated compiler symbols to unresolved declarations", () => {
  const diagnostics = [
    {
      path: "Sources/Shared/AgentAI/SafetyAlert.swift",
      line: 12,
      column: 9,
      message: "cannot find type 'EmergencyResources' in scope",
      excerpt: "let resources: EmergencyResources",
    },
    {
      path: "Sources/Shared/AgentAI/SafetyAlert.swift",
      line: 18,
      column: 9,
      message: "cannot assign to property: 'safetyAlertCoordinator' is a 'let' constant",
      excerpt: "safetyAlertCoordinator = coordinator",
    },
    {
      path: "Sources/Shared/Chat/AlertView.swift",
      line: 21,
      column: 9,
      message: "value of type 'ImageAsset.Image' has no member 'resizable'",
      excerpt: "asset.resizable()",
    },
  ].map((diagnostic) => ({ ...diagnostic, digest: canonicalDigest(diagnostic.message) }));
  const plan = buildEngineeringRepairContext({
    diagnostics,
    allowedPaths: ["Sources/Shared/AgentAI", "Sources/Shared/Chat"],
    dependencyPaths: ["Sources/Shared/AgentAI/SafetyAlert.swift"],
  });
  expect(plan.unresolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ symbol: "safetyAlertCoordinator", category: "USAGE" }),
      expect.objectContaining({ symbol: "resizable", category: "USAGE" }),
    ]),
  );
  expect(plan.unresolved).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ symbol: "safetyAlertCoordinator", category: "DECLARATION" }),
      expect.objectContaining({ symbol: "resizable", category: "DECLARATION" }),
    ]),
  );
  expect(() =>
    finalizeEngineeringRepairContext(plan, [
      ...requiredPlanReads(plan),
      {
        kind: "READ",
        relative_path: "Sources/Shared/Chat/EmergencyResources.swift",
        query: null,
        evidence: "public struct EmergencyResources {}",
      },
    ]),
  ).not.toThrow();
});

it.each(["OUTPUT_TOO_LARGE", "OVERSIZE"] as const)(
  "recovers oversized root declaration search through the exact scoped path (%s)",
  async (failureCode) => {
    const plan = buildEngineeringRepairContext({
      diagnostics: [
        {
          path: "Sources/Shared/AgentAI/SafetyAlert.swift",
          line: 12,
          column: 9,
          message: "cannot find type 'EmergencyResources' in scope",
          excerpt: "EmergencyResources",
          digest: canonicalDigest("d"),
        },
      ],
      allowedPaths: ["Sources/Shared/AgentAI"],
      dependencyPaths: ["Sources/Shared/AgentAI/SafetyAlert.swift"],
      maxEntries: 24,
    });
    const lookup = plan.entries.find(
      (entry) => entry.declaration_lookup_symbol === "EmergencyResources",
    )!;
    const calls: string[] = [];
    const ok = (value: string, kind: "SEARCH_TEXT" | "READ_FILE", operation_id: string) =>
      implementationToolResult.parse({
        schema_version: 1,
        operation_id,
        identity: { case_id: "case-1", workspace_id: "workspace-1" },
        kind,
        outcome: "SUCCEEDED",
        before_digest: null,
        after_digest: canonicalDigest(value),
        changed_files: [],
        output: {
          trust: "UNTRUSTED_DATA",
          value,
          truncated: false,
          original_byte_length: value.length,
        },
      });
    const fail = (operation_id: string) =>
      implementationToolResult.parse({
        schema_version: 1,
        operation_id,
        identity: { case_id: "case-1", workspace_id: "workspace-1" },
        kind: "SEARCH_TEXT",
        outcome: "FAILED",
        before_digest: null,
        after_digest: null,
        changed_files: [],
        failure_code: failureCode,
        output: {
          trust: "UNTRUSTED_DATA",
          value: JSON.stringify({ tool: "search", refused: true, failure_code: failureCode }),
          truncated: true,
          original_byte_length: 1000,
        },
      });
    const tools = {
      search: async (input: { query: string; relative_path?: string }) => {
        calls.push(`search:${input.relative_path ?? "<root>"}:${input.query}`);
        return input.relative_path !== undefined
          ? ok(
              JSON.stringify({
                tool: "search",
                complete: true,
                items: [
                  {
                    relative_path: "Sources/Shared/Chat/EmergencyResources.swift",
                    content: "public struct EmergencyResources",
                  },
                ],
              }),
              "SEARCH_TEXT",
              "scoped",
            )
          : fail(input.query === "EmergencyResources" ? "root" : "targeted");
      },
      read: async (input: { relative_path: string }) => {
        calls.push(`read:${input.relative_path}`);
        return ok(
          JSON.stringify({
            tool: "read",
            complete: true,
            relative_path: input.relative_path,
            digest: "sha256:decl",
            content: "public struct EmergencyResources {}",
          }),
          "READ_FILE",
          "read",
        );
      },
    } as unknown as BoundedImplementationToolset;
    await prefetchEngineeringImplementationContext(
      tools,
      [{ ...lookup!, declaration_lookup_roots: ["Sources/Shared/Chat/EmergencyResources.swift"] }],
      true,
    );
    expect(calls).toEqual([
      "search:<root>:EmergencyResources",
      "search:<root>:struct EmergencyResources",
      "search:<root>:class EmergencyResources",
      "search:<root>:enum EmergencyResources",
      "search:<root>:protocol EmergencyResources",
      "search:<root>:typealias EmergencyResources",
      "search:<root>:extension EmergencyResources",
      "search:Sources/Shared/Chat/EmergencyResources.swift:EmergencyResources",
      "read:Sources/Shared/Chat/EmergencyResources.swift",
      "read:Package.swift",
    ]);
  },
);

it.each([
  { label: "resolved", resolved: true, readDenied: false, required: true },
  { label: "usage is not a declaration", resolved: false, readDenied: false, required: true },
  { label: "required read denied", resolved: true, readDenied: true, required: true },
  { label: "optional read denied", resolved: true, readDenied: true, required: false },
])(
  "bounds ViewModel filename candidate recovery: $label",
  async ({ resolved, readDenied, required }) => {
    const entry = {
      kind: "READ" as const,
      relative_path: "Sources/Feature/Consumer.swift",
      query: null,
      category: "DIAGNOSTIC_LOCATION" as const,
      rank: 0,
      required: true,
      provenance: "test",
      declaration_lookup_symbol: "EmergencyResourcesViewModel",
      declaration_lookup_roots: ["Sources"],
      declaration_lookup_required: required,
      declaration_lookup_manifest_required: false,
    };
    const calls: string[] = [];
    const result = (value: string, kind: "SEARCH_TEXT" | "READ_FILE") =>
      implementationToolResult.parse({
        schema_version: 1,
        operation_id: `${kind}-${calls.length}`,
        identity: { case_id: "case-1", workspace_id: "workspace-1" },
        kind,
        outcome: "SUCCEEDED",
        before_digest: null,
        after_digest: canonicalDigest(value),
        changed_files: [],
        output: {
          trust: "UNTRUSTED_DATA",
          value,
          truncated: false,
          original_byte_length: value.length,
        },
      });
    const failedRoot = implementationToolResult.parse({
      schema_version: 1,
      operation_id: "root",
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "SEARCH_TEXT",
      outcome: "FAILED",
      before_digest: null,
      after_digest: null,
      changed_files: [],
      failure_code: "OVERSIZE",
      output: {
        trust: "UNTRUSTED_DATA",
        value: "{}",
        truncated: true,
        original_byte_length: 50000,
      },
    });
    const tools = {
      search: async (input: { query: string; relative_path?: string }) => {
        calls.push(`search:${input.relative_path ?? "<root>"}:${input.query}`);
        if (input.relative_path === undefined && input.query === "EmergencyResourcesViewModel")
          return failedRoot;
        if (input.relative_path === undefined && input.query === "EmergencyResourcesView")
          return result(
            JSON.stringify({
              tool: "search",
              complete: true,
              items: [
                {
                  relative_path: "Sources/Noise/EmergencyResourcesView.swift",
                  content: "let x = EmergencyResourcesViewModel",
                },
                {
                  relative_path: "Sources/Noise/EmergencyResourcesView2.swift",
                  content: "let x = EmergencyResourcesViewModel",
                },
                {
                  relative_path: "Sources/Noise/EmergencyResourcesView3.swift",
                  content: "let x = EmergencyResourcesViewModel",
                },
                {
                  relative_path: "Sources/Feature/ChatEmergencyResourcesView.swift",
                  content: "public final class EmergencyResourcesViewModel {}",
                },
              ],
            }),
            "SEARCH_TEXT",
          );
        if (input.relative_path === "Sources/Noise/EmergencyResourcesView.swift")
          return result(
            JSON.stringify({
              tool: "search",
              complete: true,
              items: [
                {
                  relative_path: input.relative_path,
                  content: "let x = EmergencyResourcesViewModel",
                },
              ],
            }),
            "SEARCH_TEXT",
          );
        if (input.relative_path === "Sources/Feature/ChatEmergencyResourcesView.swift")
          return resolved
            ? result(
                JSON.stringify({
                  tool: "search",
                  complete: true,
                  items: [
                    {
                      relative_path: input.relative_path,
                      content: "public final class EmergencyResourcesViewModel {}",
                    },
                  ],
                }),
                "SEARCH_TEXT",
              )
            : result(
                JSON.stringify({
                  tool: "search",
                  complete: true,
                  items: [
                    {
                      relative_path: input.relative_path,
                      content: "let x = EmergencyResourcesViewModel",
                    },
                  ],
                }),
                "SEARCH_TEXT",
              );
        return failedRoot;
      },
      read: async (input: { relative_path: string }) => {
        calls.push(`read:${input.relative_path}`);
        if (readDenied)
          return implementationToolResult.parse({
            ...failedRoot,
            kind: "READ_FILE",
            failure_code: "FILE_NOT_ALLOWED",
          });
        return result(
          JSON.stringify({
            tool: "read",
            complete: true,
            relative_path: input.relative_path,
            digest: canonicalDigest("decl"),
            content: "public final class EmergencyResourcesViewModel {}",
          }),
          "READ_FILE",
        );
      },
    } as unknown as BoundedImplementationToolset;
    if (readDenied && !required) {
      const evidence = await prefetchEngineeringImplementationContext(tools, [entry], true);
      expect(evidence).toEqual([expect.objectContaining({ kind: "SEARCH", evidence: "" })]);
    } else if (resolved && !readDenied) {
      const evidence = await prefetchEngineeringImplementationContext(tools, [entry], true);
      expect(evidence).toEqual([
        expect.objectContaining({
          relative_path: "Sources/Feature/ChatEmergencyResourcesView.swift",
        }),
      ]);
    } else {
      if (readDenied || required) {
        await expect(
          prefetchEngineeringImplementationContext(tools, [entry], true),
        ).rejects.toMatchObject({
          code: "IMPLEMENTATION_CONTEXT_READ_FAILED",
        });
      } else {
        const evidence = await prefetchEngineeringImplementationContext(tools, [entry], true);
        expect(evidence).toEqual([expect.objectContaining({ kind: "SEARCH", evidence: "" })]);
      }
    }
    if (readDenied) {
      expect(calls.filter((call) => call.startsWith("read:"))).toHaveLength(1);
      expect(calls.at(-1)).toBe("read:Sources/Feature/ChatEmergencyResourcesView.swift");
    }
    if (!resolved) {
      expect(
        calls.filter((call) => call.startsWith("search:Sources/") && call.includes(".swift:")),
      ).toHaveLength(3);
      expect(calls.some((call) => call.includes("EmergencyResourcesView3.swift"))).toBe(false);
      expect(calls.some((call) => call.startsWith("read:"))).toBe(false);
    }
  },
);

it("recovers an oversized declaration through the real bounded read port", async () => {
  const root = await mkdtemp(join(tmpdir(), "engineering-locator-"));
  cleanup.push(root);
  await mkdir(join(root, "Sources", "ANoise"), { recursive: true });
  await mkdir(join(root, "Sources", "Feature"), { recursive: true });
  await writeFile(
    join(root, "Sources", "ANoise", "UnrelatedLarge.swift"),
    `public final class EmergencyResourcesViewModel {}\n${"x".repeat(1_100_000)}`,
  );
  await writeFile(
    join(root, "Sources", "Feature", "ChatEmergencyResourcesView.swift"),
    "public final class EmergencyResourcesViewModel {}\n",
  );
  const readTools = await createImplementationReadTools({
    root,
    identity: { case_id: "case-real-port", workspace_id: "workspace-real-port" },
  });
  let operation = 0;
  const outcomes: string[] = [];
  const tools = {
    search: async (input: { query: string; relative_path?: string }) => {
      const result = await readTools.search({ ...input, operation_id: `search-${operation++}` });
      outcomes.push(
        `search:${input.relative_path ?? "<root>"}:${input.query}:${result.outcome}:${result.outcome === "FAILED" ? result.failure_code : "none"}`,
      );
      return result;
    },
    read: async (input: { relative_path: string }) => {
      const result = await readTools.read({ ...input, operation_id: `read-${operation++}` });
      outcomes.push(`read:${input.relative_path}:${result.outcome}`);
      return result;
    },
  } as unknown as BoundedImplementationToolset;
  const entry = {
    kind: "READ" as const,
    relative_path: "Sources/Feature/Consumer.swift",
    query: null,
    category: "DIAGNOSTIC_LOCATION" as const,
    rank: 0,
    required: true,
    provenance: "real-port",
    declaration_lookup_symbol: "EmergencyResourcesViewModel",
    declaration_lookup_roots: ["Sources"],
    declaration_lookup_required: true,
    declaration_lookup_manifest_required: false,
  };
  const evidence = await prefetchEngineeringImplementationContext(tools, [entry], true);
  expect(evidence.filter((item) => item.kind === "READ").map((item) => item.relative_path)).toEqual(
    ["Sources/Feature/ChatEmergencyResourcesView.swift"],
  );
  expect(outcomes).toEqual([
    "search:<root>:EmergencyResourcesViewModel:FAILED:OVERSIZE",
    "search:<root>:EmergencyResourcesView:SUCCEEDED:none",
    "search:Sources/Feature/ChatEmergencyResourcesView.swift:EmergencyResourcesViewModel:SUCCEEDED:none",
    "read:Sources/Feature/ChatEmergencyResourcesView.swift:SUCCEEDED",
  ]);
  expect(operation).toBe(4);
  expect(evidence[0]?.query).toBe("__declaration_lookup__:EmergencyResourcesViewModel");
});

it.each(["valid", "malformed", "denied"] as const)(
  "handles successful filename-only declaration discovery through real ports: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "engineering-application-"));
    cleanup.push(root);
    await mkdir(join(root, "Library/Sources/Utilities"), { recursive: true });
    const declaration = "Library/Sources/Utilities/UIApplication+DependencyKey.swift";
    await writeFile(join(root, declaration), "public struct Application {}\n");
    await writeFile(join(root, "Library/Package.swift"), "// swift-tools-version: 6.0\n");
    const port = await createImplementationReadTools({
      root,
      identity: { case_id: "case-application", workspace_id: "workspace-application" },
    });
    const calls: string[] = [];
    const tools = {
      search: async (input: { query: string; relative_path?: string }) => {
        calls.push(`search:${input.query}`);
        if (mode === "denied" && calls.length === 1)
          return implementationToolResult.parse({
            schema_version: 1,
            operation_id: "denied",
            kind: "SEARCH_TEXT",
            identity: { case_id: "case-application", workspace_id: "workspace-application" },
            outcome: "FAILED",
            failure_code: "OUT_OF_SCOPE",
            before_digest: null,
            after_digest: null,
            changed_files: [],
            output: {
              trust: "UNTRUSTED_DATA",
              value: "{}",
              truncated: false,
              original_byte_length: 2,
            },
          });
        const result = await port.search({ ...input, operation_id: `search-${calls.length}` });
        if (mode === "malformed" && calls.length === 1 && result.outcome === "SUCCEEDED")
          return { ...result, output: { ...result.output, value: "not-json" } };
        return result;
      },
      read: async (input: { relative_path: string }) => {
        calls.push(`read:${input.relative_path}`);
        return port.read({ ...input, operation_id: `read-${calls.length}` });
      },
    } as unknown as BoundedImplementationToolset;
    const entry = {
      kind: "SEARCH" as const,
      relative_path: ".",
      query: "Application",
      category: "DECLARATION" as const,
      rank: 1,
      required: false,
      provenance: "application",
      declaration_lookup_symbol: "Application",
      declaration_lookup_roots: ["Library/Sources"],
      declaration_lookup_required: true,
      declaration_lookup_manifest_required: true,
    };
    if (mode !== "valid") {
      await expect(prefetchEngineeringImplementationContext(tools, [entry], true)).rejects.toThrow(
        "server-owned implementation context could not be read exactly",
      );
      expect(calls).toEqual(["search:Application"]);
      return;
    }
    const evidence = await prefetchEngineeringImplementationContext(tools, [entry], true);
    expect(calls).toEqual([
      "search:Application",
      "search:struct Application",
      `read:${declaration}`,
      "read:Library/Package.swift",
    ]);
    expect(evidence.map((item) => item.relative_path)).toEqual([
      declaration,
      "Library/Package.swift",
    ]);
    expect(evidence[0]?.query).toBe("__declaration_lookup__:Application");
  },
);

it("keeps missing-type repair unresolved when root discovery has no exact safe declaration", async () => {
  const diagnostic = {
    path: "Sources/Feature.swift",
    line: 2,
    column: 4,
    message: "cannot find type 'MissingThing' in scope",
    excerpt: "let value: MissingThing",
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [{ ...diagnostic, digest: canonicalDigest(diagnostic) }],
    allowedPaths: ["Sources"],
  });
  const lookup = plan.entries.find((entry) => entry.declaration_lookup_symbol === "MissingThing");
  const unavailable = async () => {
    return implementationToolResult.parse({
      schema_version: 1,
      operation_id: "lookup",
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "SEARCH_TEXT",
      outcome: "FAILED",
      before_digest: null,
      after_digest: null,
      changed_files: [],
      failure_code: "DISCOVERY_FAILED",
      output: {
        trust: "UNTRUSTED_DATA",
        value: '{"tool":"search","refused":true}',
        truncated: true,
        original_byte_length: 34,
      },
    });
  };
  const tools = {
    search: unavailable,
    read: unavailable,
  } as unknown as BoundedImplementationToolset;
  const prefetched = [
    ...requiredPlanReads(plan),
    ...(await prefetchEngineeringImplementationContext(tools, [lookup!], true)),
  ];
  await expect(
    Promise.resolve().then(() => finalizeEngineeringRepairContext(plan, prefetched)),
  ).rejects.toThrow("REQUIRED_DECLARATION_UNRESOLVED");
});

it("fails closed before converse when production compiler repair context is unresolved", async () => {
  const fixture = await createEngineeringQualificationFixture({ id: "r6-context-boundary" });
  try {
    cleanup.push(fixture.sourcePath);
    const lease = await fixture.claimImplementer();
    const requests: unknown[] = [];
    const transport = {
      requests,
      converse: async (request: unknown) => {
        requests.push(request);
        throw new Error("model converse must not be reached");
      },
    } as never;
    const mapping = createEngineeringGateFailureMapping({
      catalog: fixture.config.catalog,
      targets: [{ target_id: "target-1", kind: "SOURCE", paths: ["src"] }],
      slices: [
        { slice_id: "slice-1", mutation_target_ids: ["target-1"], required_read_context: [] },
      ],
      criteria: [
        {
          criterion_id: "criterion-1",
          owning_slice_id: "slice-1",
          required_gate_ids: ["qualification"],
          related_target_ids: ["target-1"],
        },
      ],
    });
    const config = engineeringExecutionConfigWithGateFailureMapping(fixture.config, mapping);
    const execution = createEngineeringExecution({
      db: fixture.db,
      jobs: fixture.jobs,
      lease,
      config,
      transport,
      modelConfig: fixture.modelConfig,
      taskBrief: "context boundary",
      createReviewerSession: createStructuredPreCommitReviewSessionFactory({
        transport,
        config: fixture.modelConfig,
      }),
    });
    const slice = {
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      slice_id: "slice-1",
      objective: "repair unresolved declaration",
      observable_result: "bounded result",
      allowed_paths: ["src"],
      test_paths: ["src"],
      gate_ids: ["qualification"],
      inspection_method: "run gate",
      stop_condition: "gate passes",
    } as const;
    const compiler = {
      path: "src/base.ts",
      line: 1,
      column: 1,
      message: "cannot find 'MissingProtocol' in scope",
      excerpt: "MissingProtocol",
      digest: canonicalDigest("missing"),
    };
    const receipt = {
      artifact_kind: "SliceImplementationReceipt",
      slice_id: "slice-1",
      cumulative_paths: [],
      changed_paths: [],
    };
    const failure = {
      schema_version: 2,
      artifact_kind: "GateFailure",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      authority: "SERVER_OWNED",
      slice_id: "slice-1",
      attempt: 1,
      tree_digest: canonicalDigest("tree"),
      diff_digest: canonicalDigest("diff"),
      context_digest: canonicalDigest("context"),
      config_digest: fixture.config.configDigest,
      mapping_digest: mapping.mapping_digest,
      blocking_gate_ids: ["qualification"],
      receipt_ids: ["receipt-current"],
      decision_ids: [],
      diagnostics: [
        {
          gate_id: "qualification",
          outcome: "FAILED",
          log_digest: null,
          trust: "UNTRUSTED_DATA",
          excerpt: compiler.excerpt,
          compiler_diagnostics: [compiler],
          test_diagnostics: [],
        },
      ],
      observations: [
        {
          criterion_id: "criterion-1",
          gate_id: "qualification",
          failure_class: "ASSERTION_FAILED",
          evidence_ref: "receipt-current",
          related_target_ids: ["target-1"],
        },
      ],
    };
    await expect(
      execution.implementationExecutor.execute({
        binding: {
          caseId: fixture.ids.caseId,
          workUnitId: fixture.ids.workUnitId,
          runId: fixture.ids.runId,
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_IMPLEMENTATION,
          attempt: 2,
        },
        objective: slice.objective,
        context: { packet: "bounded" } as never,
        orderedArtifacts: [
          { stage_attempt: 1, payload: slice },
          { stage_attempt: 1, payload: receipt },
          { stage_attempt: 1, payload: failure },
        ] as never,
      }),
    ).rejects.toThrow("UNCLASSIFIED_GATE_FAILURE: correction authority is unavailable");
    expect(requests).toHaveLength(0);
    expect(await readFile(join(fixture.sourcePath, "src/base.ts"), "utf8")).toContain(
      "base = true",
    );
  } finally {
    await fixture.drop();
  }
});

it.each([
  {
    name: "missing optional READ",
    kind: "READ",
    path: "src/Absent.swift",
    required: false,
    correction: false,
    fragments: false,
  },
  {
    name: "existing optional READ",
    kind: "READ",
    path: "src/base.ts",
    required: false,
    correction: false,
    fragments: false,
  },
  {
    name: "missing required READ",
    kind: "READ",
    path: "src/Missing.swift",
    required: true,
    correction: false,
    fragments: false,
  },
  {
    name: "original missing SEARCH",
    kind: "SEARCH",
    path: "src/Absent.swift",
    required: false,
    correction: false,
    fragments: false,
  },
  {
    name: "missing correction READ",
    kind: "READ",
    path: "src/Absent.swift",
    required: false,
    correction: true,
    fragments: false,
  },
  {
    name: "oversized required READ fragments",
    kind: "READ",
    path: "src/LargeContext.swift",
    required: true,
    correction: false,
    fragments: true,
  },
  {
    name: "clipped required READ fragments",
    kind: "READ",
    path: "src/ClippedContext.swift",
    required: true,
    correction: false,
    fragments: true,
  },
] as const)(
  "keeps mutation tools after $name",
  async ({ kind, path, required, correction, fragments }) => {
    const fixture = await createEngineeringQualificationFixture({
      id: `prefetch-${kind}-${required}`,
    });
    try {
      cleanup.push(fixture.sourcePath);
      if (fragments) {
        const lines = Array.from({ length: path.includes("Large") ? 420 : 1_000 }, (_, index) =>
          path.includes("Large")
            ? `// ${path} line ${String(index + 1)} ${index === 419 ? "FRAGMENT_TAIL_SENTINEL" : ""} ${"x".repeat(183)}`
            : `// ${index === 999 ? "FRAGMENT_TAIL_SENTINEL" : '"'.repeat(20)} ${"x".repeat(33)}`,
        );
        await writeFile(join(fixture.sourcePath, path), `${lines.join("\n")}\n`);
        await execFile("git", ["-C", fixture.sourcePath, "add", path]);
        await execFile("git", [
          "-C",
          fixture.sourcePath,
          "commit",
          "--quiet",
          "-m",
          `fragment context ${path}`,
        ]);
        const probeTools = await createImplementationReadTools({
          root: fixture.sourcePath,
          identity: { case_id: "probe", workspace_id: "probe" },
        });
        const probe = await probeTools.read({ operation_id: "probe-read", relative_path: path });
        if (path.includes("Large")) {
          expect(probe.outcome).toBe("FAILED");
          if (probe.outcome === "FAILED") expect(probe.failure_code).toBe("OUTPUT_TOO_LARGE");
        } else {
          expect(probe.outcome).toBe("SUCCEEDED");
          if (probe.outcome === "SUCCEEDED") {
            expect(probe.output.truncated).toBe(true);
            expect(Buffer.byteLength(probe.output.value, "utf8")).toBeGreaterThan(60_000);
            expect(probe.output.value.length).toBeLessThan(65_536);
            expect(JSON.parse(probe.output.value)).toMatchObject({ complete: false });
          }
        }
      }
      const executable = await realpath(process.execPath);
      const gate = fixture.config.catalog.get("qualification");
      if (gate === undefined) throw new Error("qualification gate missing");
      const catalog = await VerificationGateCatalog.create({
        definitions: [
          {
            ...gate,
            implementation_context: [
              kind === "SEARCH"
                ? { kind, relative_path: path, query: "ABSENT_PREFETCH_SENTINEL" }
                : { kind, relative_path: path },
            ],
          },
        ],
        executable_allowlist: [executable],
      });
      const config = Object.freeze({
        ...fixture.config,
        catalog,
        gateFailureMapping: createEngineeringGateFailureMapping({
          catalog,
          targets: [{ target_id: "target-optional", kind: "SOURCE", paths: ["src"] }],
          slices: [
            {
              slice_id: "slice-1",
              mutation_target_ids: ["target-optional"],
              required_read_context: [{ relative_path: path, must_exist: required }],
            },
          ],
          criteria: [
            {
              criterion_id: "criterion-optional",
              owning_slice_id: "slice-1",
              required_gate_ids: ["qualification"],
              related_target_ids: ["target-optional"],
            },
          ],
        }),
        configDigest: canonicalDigest({
          repository_id: fixture.config.repositoryId,
          catalog: catalog.config_digest,
        }),
      });
      const requests: unknown[] = [];
      let modelResponses = 0;
      const transport = {
        requests,
        converse: async (request: unknown) => {
          requests.push(request);
          modelResponses += 1;
          if (modelResponses === 1) {
            return {
              model: fixture.modelConfig.model,
              content: [
                {
                  type: "tool-use",
                  id: "create-bounded-test",
                  name: "patch",
                  input: {
                    files: [
                      {
                        relative_path: "src/new-test.ts",
                        content: "export const bounded = true;\n",
                      },
                    ],
                  },
                },
              ],
            };
          }
          return {
            model: fixture.modelConfig.model,
            content: [
              {
                type: "json",
                value: { schema_version: 1, changed_files: ["src/new-test.ts"] },
              },
            ],
          };
        },
      } as never;
      const lease = await fixture.claimImplementer();
      const execution = createEngineeringExecution({
        db: fixture.db,
        jobs: fixture.jobs,
        lease,
        config,
        transport,
        modelConfig: fixture.modelConfig,
        taskBrief: "empty prefetch search",
        createReviewerSession: createStructuredPreCommitReviewSessionFactory({
          transport,
          config: fixture.modelConfig,
        }),
      });
      const slice = {
        schema_version: 2,
        artifact_kind: "SliceContract",
        case_id: fixture.ids.caseId,
        run_id: fixture.ids.runId,
        revision: 0,
        slice_id: "slice-1",
        objective: "make a bounded change",
        observable_result: "change is present",
        allowed_paths: ["src"],
        test_paths: ["src"],
        gate_ids: ["qualification"],
        inspection_method: "run gate",
        stop_condition: "gate passes",
      } as const;
      const implementationResult = execution.implementationExecutor.execute({
        binding: {
          caseId: fixture.ids.caseId,
          workUnitId: fixture.ids.workUnitId,
          runId: fixture.ids.runId,
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_IMPLEMENTATION,
          attempt: correction ? 2 : 1,
        },
        objective: slice.objective,
        context: { packet: "bounded" } as never,
        orderedArtifacts: [
          { stage_attempt: 1, payload: slice },
          ...(correction
            ? [
                {
                  stage_attempt: 1,
                  payload: {
                    artifact_kind: "SliceImplementationReceipt",
                    slice_id: "slice-1",
                    cumulative_paths: [path],
                    changed_paths: [path],
                  },
                },
              ]
            : []),
        ] as never,
      });
      if ((required && !fragments) || correction) {
        await expect(implementationResult).rejects.toThrow(
          "server-owned implementation context could not be read exactly",
        );
        expect(modelResponses).toBe(0);
        return;
      }
      await expect(implementationResult).resolves.toMatchObject({
        kind: "ARTIFACT",
        artifact: { changed_paths: ["src/new-test.ts"] },
      });
      expect(requests.length).toBeGreaterThan(0);
      if (kind === "READ" && path === "src/Absent.swift")
        expect(JSON.stringify(requests)).toMatch(/exists\\?":false/u);
      if (kind === "READ" && path === "src/base.ts") {
        expect(JSON.stringify(requests)).not.toMatch(/exists\\?":false/u);
        expect(JSON.stringify(requests)).toContain("export const base = true;");
      }
      if (fragments) {
        const requestText = JSON.stringify(requests);
        expect(requestText).toContain("read_excerpt");
        expect(requestText).toContain("start_line");
        expect(requestText).toContain("end_of_file");
        expect(requestText).toContain("FRAGMENT_TAIL_SENTINEL");
        expect(requestText).toContain("full_file_digest");
      }
      for (const request of requests) {
        expect(
          (request as { tools?: { name?: string }[] }).tools?.map((tool) => tool.name),
        ).toEqual(["patch", "mkdir"]);
      }
    } finally {
      await fixture.drop();
    }
  },
);

it.each([false, true])(
  "executes separate-source compiler repair with scope refusal=%s",
  async (outsideScope) => {
    const fixture = await createEngineeringQualificationFixture({
      id: `member-receipt-${outsideScope}`,
    });
    try {
      cleanup.push(fixture.sourcePath);
      const sourcePath = "src/Sources/Flow/FlowState.swift";
      const testPath = "src/Tests/FlowTests.swift";
      const otherPath = "src/Other.swift";
      const before = "public var canProceed: Bool { true }";
      const after = "public var canProceed: Bool = true";
      const testBytes = "object.canProceed = false\n";
      const otherBytes = "public let unrelated = true\n";
      await mkdir(join(fixture.sourcePath, "src/Tests"));
      await mkdir(join(fixture.sourcePath, "src/Sources/Flow"), { recursive: true });
      await writeFile(
        join(fixture.sourcePath, "src/Package.swift"),
        '// swift-tools-version:6.0\nimport PackageDescription\nlet package = Package(name: "Fixture")\n',
      );
      await writeFile(join(fixture.sourcePath, sourcePath), `${before}\n`);
      await writeFile(join(fixture.sourcePath, testPath), testBytes);
      await writeFile(join(fixture.sourcePath, otherPath), otherBytes);
      await execFile("git", ["-C", fixture.sourcePath, "add", "src"]);
      await execFile("git", [
        "-C",
        fixture.sourcePath,
        "commit",
        "--quiet",
        "-m",
        "separate member declaration fixture",
      ]);
      const gate = fixture.config.catalog.get("qualification");
      if (gate === undefined) throw new Error("qualification gate missing");
      const catalog = await VerificationGateCatalog.create({
        definitions: [
          {
            ...gate,
            required_mutation_paths: [sourcePath],
            implementation_context: [{ kind: "READ", relative_path: sourcePath }],
          },
        ],
        executable_allowlist: [gate.executable],
      });
      const mapping = createEngineeringGateFailureMapping({
        catalog,
        targets: [{ target_id: "source", kind: "SOURCE", paths: [sourcePath] }],
        slices: [
          {
            slice_id: "slice-1",
            mutation_target_ids: ["source"],
            required_read_context: [{ relative_path: sourcePath, must_exist: true }],
          },
        ],
        criteria: [
          {
            criterion_id: "mutable-state",
            owning_slice_id: "slice-1",
            required_gate_ids: ["qualification"],
            related_target_ids: ["source"],
          },
        ],
      });
      const config = engineeringExecutionConfigWithGateFailureMapping(
        {
          ...fixture.config,
          catalog,
          configDigest: canonicalDigest({ catalog: catalog.config_digest }),
        },
        mapping,
      );
      const changedPath = outsideScope ? otherPath : sourcePath;
      const transport = new FakeTransport([
        {
          model: fixture.modelConfig.model,
          content: [
            {
              type: "tool-use",
              id: "repair-member",
              name: "patch",
              input: {
                replacement_files: [
                  {
                    relative_path: changedPath,
                    replacements: [
                      {
                        old_content: outsideScope ? otherBytes : before,
                        new_content: outsideScope ? "public let unrelated = false\n" : after,
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        {
          model: fixture.modelConfig.model,
          content: [
            {
              type: "json",
              value: { schema_version: 1, changed_files: outsideScope ? [] : [sourcePath] },
            },
          ],
        },
        {
          model: fixture.modelConfig.model,
          content: [{ type: "json", value: { schema_version: 1, changed_files: [] } }],
        },
      ]);
      const lease = await fixture.claimImplementer();
      const execution = createEngineeringExecution({
        db: fixture.db,
        jobs: fixture.jobs,
        lease,
        config,
        transport,
        modelConfig: fixture.modelConfig,
        taskBrief: "repair state declaration without editing evaluator",
        createReviewerSession: createStructuredPreCommitReviewSessionFactory({
          transport,
          config: fixture.modelConfig,
        }),
      });
      const slice = {
        schema_version: 2,
        artifact_kind: "SliceContract",
        case_id: fixture.ids.caseId,
        run_id: fixture.ids.runId,
        revision: 0,
        slice_id: "slice-1",
        objective: "repair state declaration",
        observable_result: "source state is assignable",
        allowed_paths: [sourcePath, testPath],
        test_paths: [testPath],
        gate_ids: ["qualification"],
        inspection_method: "verify source receipt",
        stop_condition: "gate passes",
      } as const;
      const diagnosticFields = {
        path: testPath,
        line: 1,
        column: 8,
        message: "cannot assign to property: 'canProceed' is a get-only property",
        excerpt: testBytes.trim(),
      };
      const diagnostic = { ...diagnosticFields, digest: canonicalDigest(diagnosticFields) };
      const failure = engineeringGateFailureV2.parse({
        schema_version: 2,
        artifact_kind: "GateFailure",
        case_id: fixture.ids.caseId,
        run_id: fixture.ids.runId,
        revision: 0,
        authority: "SERVER_OWNED",
        slice_id: "slice-1",
        attempt: 1,
        tree_digest: canonicalDigest("tree"),
        diff_digest: canonicalDigest("diff"),
        context_digest: canonicalDigest("context"),
        config_digest: config.configDigest,
        mapping_digest: mapping.mapping_digest,
        blocking_gate_ids: ["qualification"],
        receipt_ids: ["prior-gate"],
        decision_ids: [],
        diagnostics: [
          {
            gate_id: "qualification",
            outcome: "FAILED",
            log_digest: null,
            trust: "UNTRUSTED_DATA",
            excerpt: testBytes,
            compiler_diagnostics: [diagnostic],
            test_diagnostics: [],
          },
        ],
        observations: [
          {
            criterion_id: "mutable-state",
            gate_id: "qualification",
            failure_class: "COMPILE_FAILED",
            evidence_ref: "prior-gate",
            related_target_ids: ["source"],
          },
        ],
      });
      const run = execution.implementationExecutor.execute({
        binding: {
          caseId: fixture.ids.caseId,
          workUnitId: fixture.ids.workUnitId,
          runId: fixture.ids.runId,
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_IMPLEMENTATION,
          attempt: 2,
        },
        objective: slice.objective,
        context: { packet: "bounded" } as never,
        orderedArtifacts: [
          { stage_attempt: 1, payload: slice },
          {
            stage_attempt: 1,
            payload: {
              artifact_kind: "SliceImplementationReceipt",
              slice_id: "slice-1",
              cumulative_paths: [],
              changed_paths: [],
            },
          },
          { stage_attempt: 1, payload: failure },
        ] as never,
      });
      if (outsideScope) {
        await expect(run).rejects.toThrow();
        const results = transport.requests
          .flatMap((request) => request.messages)
          .flatMap((message) => message.content)
          .flatMap((content) => {
            if (
              content.type !== "tool-result" ||
              typeof content.output !== "object" ||
              content.output === null ||
              Array.isArray(content.output)
            )
              return [];
            const parsed = implementationToolResult.safeParse(content.output["value"]);
            return parsed.success ? [parsed.data] : [];
          });
        const refusal = results.find(
          (result) => result.kind === "APPLY_PATCH" && result.outcome === "FAILED",
        );
        expect(refusal).toMatchObject({
          outcome: "FAILED",
          failure_code: "PATH_OUTSIDE_ALLOWED",
          changed_files: [],
        });
        if (refusal === undefined) throw new Error("scope refusal receipt missing");
        const workspace = join(
          config.workspaceConfig.workspaceRoot,
          fixture.ids.caseId,
          refusal.identity.workspace_id,
        );
        expect(await readFile(join(workspace, sourcePath), "utf8")).toBe(`${before}\n`);
        expect(await readFile(join(workspace, otherPath), "utf8")).toBe(otherBytes);
      } else {
        const result = await run.catch((error: unknown) => {
          throw new Error(
            error instanceof EngineeringImplementationContextError ? error.code : String(error),
            { cause: error },
          );
        });
        expect(result).toMatchObject({
          kind: "ARTIFACT",
          artifact: { artifact_kind: "SliceImplementationReceipt", changed_paths: [sourcePath] },
        });
        if (
          result.kind !== "ARTIFACT" ||
          result.artifact.artifact_kind !== "SliceImplementationReceipt"
        )
          throw new Error("source receipt missing");
        const workspace = join(
          config.workspaceConfig.workspaceRoot,
          fixture.ids.caseId,
          result.artifact.workspace_id,
        );
        expect(await readFile(join(workspace, sourcePath), "utf8")).toBe(`${after}\n`);
        expect(await readFile(join(workspace, testPath), "utf8")).toBe(testBytes);
        expect(await readFile(join(workspace, otherPath), "utf8")).toBe(otherBytes);
      }
      const prompt = JSON.stringify(transport.requests[0]);
      expect(prompt).toContain(
        "does not complete the slice when the objective also requires a source/product change",
      );
      expect(prompt).toContain(
        "Do not return any changed_files final report while the objective remains unmet",
      );
      expect(prompt).toContain(
        "does not require a source edit for a test-only objective or alter compiler-repair scope",
      );
      expect(prompt).toContain("source-backed related declarations");
      expect(prompt).not.toContain(
        "Patch only repository-relative files named by the structured compiler diagnostics",
      );
      expect(prompt).toContain(before);
      expect(prompt).toContain(testPath);
      expect(await readFile(join(fixture.sourcePath, sourcePath), "utf8")).toBe(`${before}\n`);
      expect(await readFile(join(fixture.sourcePath, otherPath), "utf8")).toBe(otherBytes);
    } finally {
      await fixture.drop();
    }
  },
);

it("counts every member fallback root before reserving discovery", () => {
  expect(
    engineeringRepairContextEntryCallCost({
      kind: "SEARCH",
      relative_path: ".",
      declaration_lookup_symbol: "canProceed",
      declaration_lookup_member: true,
      declaration_lookup_roots: ["src/A.swift", "src/B.swift"],
      declaration_lookup_manifest_required: true,
    }),
  ).toBe(5);
});

it("keeps explicit receiver obligations when inferred implicit-member diagnostics coexist", () => {
  const makeDiagnostic = (excerpt: string, line: number) => {
    const fields = {
      path: "Tests/FlowTests.swift",
      line,
      column: 1,
      message: "type 'GenericConstraint' has no member 'missing'",
      excerpt,
    };
    return { ...fields, digest: canonicalDigest(fields) };
  };
  const planFor = (diagnostics: ReturnType<typeof makeDiagnostic>[]) =>
    buildEngineeringRepairContext({ diagnostics, allowedPaths: ["Sources", "Tests"] });
  const implicit = makeDiagnostic("check(subject.value, .missing)", 1);
  const explicit = makeDiagnostic("GenericConstraint.missing()", 2);
  expect(
    planFor([implicit]).entries.some(
      (entry) =>
        entry.declaration_lookup_symbol === "GenericConstraint" &&
        entry.declaration_lookup_required === true,
    ),
  ).toBe(false);
  for (const diagnostics of [
    [explicit],
    [implicit, explicit],
    [makeDiagnostic("check(GenericConstraint.missing(), .other)", 3)],
    [makeDiagnostic("GenericConstraint.missing(.missing)", 4)],
    [makeDiagnostic("// check(.missing)\nGenericConstraint.missing()", 5)],
  ]) {
    expect(planFor(diagnostics).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declaration_lookup_symbol: "GenericConstraint",
          declaration_lookup_required: true,
        }),
      ]),
    );
  }
});

it("reaches converse with bounded fragments for a live-shaped compiler repair", async () => {
  const fixture = await createEngineeringQualificationFixture({ id: "r6-positive-boundary" });
  try {
    cleanup.push(fixture.sourcePath);
    const relativePath = "src/large-diagnostic.ts";
    const lines = Array.from({ length: 220 }, (_, index) => {
      const marker =
        index === 0 ? "OUTSIDE_START_SENTINEL" : index === 219 ? "OUTSIDE_END_SENTINEL" : "";
      return `// line ${String(index + 1)} ${marker} ${"x".repeat(180)}`;
    });
    const content = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(42_000);
    await writeFile(join(fixture.sourcePath, relativePath), content);
    await execFile("git", ["-C", fixture.sourcePath, "add", relativePath]);
    await execFile("git", [
      "-C",
      fixture.sourcePath,
      "commit",
      "--quiet",
      "-m",
      "large diagnostic fixture",
    ]);

    const criteria = ["criterion-1", "criterion-2"] as const;
    const fullFileDigest = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
    const qualificationGate = fixture.config.catalog.get("qualification");
    if (qualificationGate === undefined) throw new Error("qualification gate missing");
    const gateCatalog = await VerificationGateCatalog.create({
      definitions: [{ ...qualificationGate, required_mutation_paths: [relativePath] }],
      executable_allowlist: [qualificationGate.executable],
    });
    const compilerDiagnostics = [40, 162, 200].map((line) => ({
      path: relativePath,
      line,
      column: 1,
      message: `compiler failure at line ${String(line)}`,
      excerpt: `line ${String(line)}`,
      digest: canonicalDigest({
        path: relativePath,
        line,
        column: 1,
        message: `compiler failure at line ${String(line)}`,
        excerpt: `line ${String(line)}`,
      }),
    }));
    const mapping = createEngineeringGateFailureMapping({
      catalog: gateCatalog,
      targets: [{ target_id: "target-1", kind: "SOURCE", paths: [relativePath] }],
      slices: [
        { slice_id: "slice-1", mutation_target_ids: ["target-1"], required_read_context: [] },
      ],
      criteria: criteria.map((criterion_id) => ({
        criterion_id,
        owning_slice_id: "slice-1",
        required_gate_ids: ["qualification"],
        related_target_ids: ["target-1"],
      })),
    });
    const config = engineeringExecutionConfigWithGateFailureMapping(
      Object.freeze({
        ...fixture.config,
        catalog: gateCatalog,
        configDigest: canonicalDigest({
          repository_id: fixture.config.repositoryId,
          catalog: gateCatalog.config_digest,
        }),
      }),
      mapping,
    );
    const requests: unknown[] = [];
    const transport = {
      requests,
      converse: async (request: unknown) => {
        requests.push(request);
        return {
          model: fixture.modelConfig.model,
          content: [{ type: "json", value: { schema_version: 1, changed_files: [] } }],
        };
      },
    } as never;
    const lease = await fixture.claimImplementer();
    const execution = createEngineeringExecution({
      db: fixture.db,
      jobs: fixture.jobs,
      lease,
      config,
      transport,
      modelConfig: fixture.modelConfig,
      taskBrief: "large compiler repair",
      createReviewerSession: createStructuredPreCommitReviewSessionFactory({
        transport,
        config: fixture.modelConfig,
      }),
    });
    const slice = {
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      slice_id: "slice-1",
      objective: "repair the large diagnostic fixture",
      observable_result: "compiler repair is bounded",
      allowed_paths: ["src"],
      test_paths: ["src"],
      gate_ids: ["qualification"],
      inspection_method: "run gate",
      stop_condition: "gate passes",
    } as const;
    const failure = engineeringGateFailureV2.parse({
      schema_version: 2,
      artifact_kind: "GateFailure",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      authority: "SERVER_OWNED",
      slice_id: "slice-1",
      attempt: 1,
      tree_digest: canonicalDigest("tree"),
      diff_digest: canonicalDigest("diff"),
      context_digest: canonicalDigest("context"),
      config_digest: config.configDigest,
      mapping_digest: mapping.mapping_digest,
      blocking_gate_ids: ["qualification"],
      receipt_ids: ["receipt-current"],
      decision_ids: [],
      diagnostics: [
        {
          gate_id: "qualification",
          outcome: "FAILED",
          log_digest: null,
          trust: "UNTRUSTED_DATA",
          excerpt: "compiler diagnostics",
          compiler_diagnostics: compilerDiagnostics,
          test_diagnostics: [],
        },
      ],
      observations: criteria.map((criterion_id) => ({
        criterion_id,
        gate_id: "qualification",
        failure_class: "COMPILE_FAILED",
        evidence_ref: "receipt-current",
        related_target_ids: ["target-1"],
      })),
    });
    const latestFailure = engineeringGateFailureV2.parse({
      ...failure,
      attempt: 2,
      receipt_ids: ["receipt-latest"],
      observations: failure.observations.map((observation) => ({
        ...observation,
        evidence_ref: "receipt-latest",
      })),
    });
    await expect(
      execution.implementationExecutor.execute({
        binding: {
          caseId: fixture.ids.caseId,
          workUnitId: fixture.ids.workUnitId,
          runId: fixture.ids.runId,
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_IMPLEMENTATION,
          attempt: 3,
        },
        objective: slice.objective,
        context: { packet: "bounded" } as never,
        orderedArtifacts: [
          { stage_attempt: 1, payload: slice },
          {
            stage_attempt: 1,
            payload: {
              artifact_kind: "SliceImplementationReceipt",
              slice_id: "slice-1",
              cumulative_paths: [],
              changed_paths: [],
            },
          },
          { stage_attempt: 1, payload: failure },
          {
            stage_attempt: 2,
            payload: {
              artifact_kind: "SliceImplementationReceipt",
              slice_id: "slice-1",
              cumulative_paths: [],
              changed_paths: [],
            },
          },
          { stage_attempt: 2, payload: latestFailure },
        ] as never,
      }),
    ).rejects.toThrow("Final report repeated before the required mutation was completed");

    expect(requests.length).toBeGreaterThan(0);
    const requestText = requests
      .flatMap(
        (request) =>
          (request as { messages?: { content?: { type: string; text?: string }[] }[] }).messages ??
          [],
      )
      .flatMap((message) => message.content ?? [])
      .map((entry) => (entry.type === "text" ? (entry.text ?? "") : ""))
      .join("\n");
    expect(requestText).toContain(`start_line`);
    expect(requestText).toContain(`end_line`);
    expect(requestText).toContain(`complete`);
    expect(requestText).toContain(fullFileDigest);
    expect(requestText).toContain(JSON.stringify(failure.observations));
    expect(requestText).toContain(JSON.stringify(latestFailure.observations));
    expect(requestText).toContain(`"required_mutation_paths":["${relativePath}"]`);
    expect(requestText).toContain("line 40");
    expect(requestText).toContain("line 162");
    expect(requestText).toContain("line 37");
    expect(requestText).toContain("line 43");
    expect(requestText).toContain("line 159");
    expect(requestText).toContain("line 165");
    expect(requestText).toContain("line 197");
    expect(requestText).toContain("line 203");
    expect(requestText).toContain("line 200");
    expect(requestText).toContain("OUTSIDE_START_SENTINEL");
    expect(requestText).not.toContain("OUTSIDE_END_SENTINEL");
    expect(requestText).not.toContain(content);
  } finally {
    await fixture.drop();
  }
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

it("finalizes a trailing-newline diagnostic excerpt at its clamped EOF", () => {
  const message = "compiler diagnostic at end of source";
  const excerpt = "alert.foo()";
  const diagnostic = {
    path: "Sources/SafetyAlert.swift",
    line: 122,
    column: 4,
    message,
    excerpt,
    digest: canonicalDigest({
      path: "Sources/SafetyAlert.swift",
      line: 122,
      column: 4,
      message,
      excerpt,
    }),
  };
  const plan = buildEngineeringRepairContext({
    diagnostics: [diagnostic],
    allowedPaths: ["Sources"],
  });
  const content = "line-119\nline-120\nline-121\nline-122\nline-123\nline-124\n";
  const finalized = finalizeEngineeringRepairContext(plan, [
    {
      kind: "READ",
      relative_path: "Sources/SafetyAlert.swift",
      query: null,
      evidence: JSON.stringify({
        tool: "read_excerpt",
        complete: false,
        relative_path: "Sources/SafetyAlert.swift",
        start_line: 119,
        end_line: 124,
        full_file_digest: `sha256:${"a".repeat(64)}`,
        content,
      }),
    },
  ]);
  expect(finalized.evidence).toEqual([
    expect.objectContaining({
      relative_path: "Sources/SafetyAlert.swift",
      start_line: 119,
      end_line: 124,
      complete: false,
      evidence: expect.stringContaining("line-122"),
    }),
  ]);
});

it("retains an oversized optional compiler SEARCH as content-free omission evidence", async () => {
  const oversized = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "compiler-search-overflow",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "SEARCH_TEXT",
    outcome: "FAILED",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: "OUTPUT_TOO_LARGE",
    output: {
      trust: "UNTRUSTED_DATA",
      value: '{"tool":"search","refused":true,"failure_code":"OUTPUT_TOO_LARGE"}',
      truncated: true,
      original_byte_length: 72,
    },
  });
  const unavailable = async () => {
    throw new Error("unexpected tool");
  };
  const tools = {
    read: unavailable,
    search: async () => oversized,
    tree: unavailable,
    config: unavailable,
    write: unavailable,
    patch: unavailable,
    mkdir: unavailable,
  } as unknown as BoundedImplementationToolset;

  await expect(
    prefetchEngineeringImplementationContext(
      tools,
      [{ kind: "SEARCH", relative_path: "Sources/Feature.swift", query: "MissingPeer" }],
      true,
    ),
  ).resolves.toEqual([
    {
      kind: "SEARCH",
      relative_path: "Sources/Feature.swift",
      query: "MissingPeer",
      evidence: "",
    },
  ]);
});

it("retains a budget-exhausted optional compiler SEARCH as negative evidence", async () => {
  const exhausted = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "compiler-search-budget-exhausted",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "SEARCH_TEXT",
    outcome: "FAILED",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: BOUNDED_DISCOVERY_BUDGET_EXHAUSTED,
    output: {
      trust: "UNTRUSTED_DATA",
      value: `{"tool":"search","refused":true,"failure_code":"${BOUNDED_DISCOVERY_BUDGET_EXHAUSTED}"}`,
      truncated: true,
      original_byte_length: 88,
    },
  });
  const calls: string[] = [];
  const readResult = (relative_path: string) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: `read-${calls.length}`,
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "READ_FILE",
      outcome: "SUCCEEDED",
      before_digest: null,
      after_digest: canonicalDigest(relative_path),
      changed_files: [],
      output: {
        trust: "UNTRUSTED_DATA",
        value: `exact evidence for ${relative_path}`,
        truncated: false,
        original_byte_length: `exact evidence for ${relative_path}`.length,
      },
    });
  const tools = {
    read: async (input: { relative_path: string }) => {
      calls.push(`read:${input.relative_path}`);
      return readResult(input.relative_path);
    },
    search: async (input: { query: string; relative_path?: string }) => {
      calls.push(`search:${input.relative_path ?? "<root>"}:${input.query}`);
      return exhausted;
    },
    tree: async () => {
      throw new Error("unexpected tree");
    },
    config: async () => {
      throw new Error("unexpected config");
    },
    write: async () => {
      throw new Error("unexpected write");
    },
    patch: async () => {
      throw new Error("unexpected patch");
    },
    mkdir: async () => {
      throw new Error("unexpected mkdir");
    },
  } as unknown as BoundedImplementationToolset;

  const evidence = await prefetchEngineeringImplementationContext(
    tools,
    [
      { kind: "READ", relative_path: "Sources/Feature.swift" },
      { kind: "READ", relative_path: "Sources/Shared.swift" },
      { kind: "SEARCH", relative_path: "Sources/Feature.swift", query: "MissingPeer" },
    ],
    true,
  );
  expect(calls).toEqual([
    "read:Sources/Feature.swift",
    "read:Sources/Shared.swift",
    "search:Sources/Feature.swift:MissingPeer",
  ]);
  expect(evidence).toEqual([
    {
      kind: "READ",
      relative_path: "Sources/Feature.swift",
      query: null,
      evidence: "exact evidence for Sources/Feature.swift",
    },
    {
      kind: "READ",
      relative_path: "Sources/Shared.swift",
      query: null,
      evidence: "exact evidence for Sources/Shared.swift",
    },
    {
      kind: "SEARCH",
      relative_path: "Sources/Feature.swift",
      query: "MissingPeer",
      evidence: "",
    },
  ]);
});

it("retains OVERSIZE after required compiler reads as negative optional SEARCH evidence", async () => {
  const calls: string[] = [];
  const result = (
    kind: "READ_FILE" | "SEARCH_TEXT",
    outcome: "SUCCEEDED" | "FAILED",
    value: string,
  ) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: `oversize-${calls.length}`,
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind,
      outcome,
      before_digest: null,
      after_digest: outcome === "SUCCEEDED" ? canonicalDigest(value) : null,
      changed_files: [],
      ...(outcome === "FAILED" ? { failure_code: "OVERSIZE" } : {}),
      output: {
        trust: "UNTRUSTED_DATA",
        value,
        truncated: outcome === "FAILED",
        original_byte_length: value.length,
      },
    });
  const tools = {
    read: async (input: { relative_path: string }) => {
      calls.push(`read:${input.relative_path}`);
      return result("READ_FILE", "SUCCEEDED", `evidence:${input.relative_path}`);
    },
    search: async (input: { query: string; relative_path?: string }) => {
      calls.push(`search:${input.relative_path ?? "<root>"}:${input.query}`);
      return result("SEARCH_TEXT", "FAILED", '{"tool":"search","refused":true}');
    },
  } as unknown as BoundedImplementationToolset;
  const evidence = await prefetchEngineeringImplementationContext(
    tools,
    [
      { kind: "READ", relative_path: "Sources/Feature.swift" },
      { kind: "READ", relative_path: "Sources/Shared.swift" },
      { kind: "SEARCH", relative_path: "Sources/Feature.swift", query: "MissingPeer" },
    ],
    true,
  );
  expect(calls).toEqual([
    "read:Sources/Feature.swift",
    "read:Sources/Shared.swift",
    "search:Sources/Feature.swift:MissingPeer",
  ]);
  expect(evidence).toEqual([
    expect.objectContaining({ kind: "READ", relative_path: "Sources/Feature.swift" }),
    expect.objectContaining({ kind: "READ", relative_path: "Sources/Shared.swift" }),
    expect.objectContaining({ kind: "SEARCH", query: "MissingPeer", evidence: "" }),
  ]);
});

it("fails closed on an oversized SEARCH outside compiler repair", async () => {
  const oversized = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "normal-search-overflow",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "SEARCH_TEXT",
    outcome: "FAILED",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: "OUTPUT_TOO_LARGE",
    output: {
      trust: "UNTRUSTED_DATA",
      value: '{"tool":"search","refused":true,"failure_code":"OUTPUT_TOO_LARGE"}',
      truncated: true,
      original_byte_length: 72,
    },
  });
  const unavailable = async () => {
    throw new Error("unexpected tool");
  };
  const tools = {
    read: unavailable,
    search: async () => oversized,
    tree: unavailable,
    config: unavailable,
    write: unavailable,
    patch: unavailable,
    mkdir: unavailable,
  } as unknown as BoundedImplementationToolset;

  await expect(
    prefetchEngineeringImplementationContext(tools, [
      { kind: "SEARCH", relative_path: "Sources/Feature.swift", query: "MissingPeer" },
    ]),
  ).rejects.toMatchObject({
    name: "EngineeringImplementationContextError",
    code: "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE",
  });
});

it("keeps generator outputs in durable scope but removes them from the model-facing slice", () => {
  const durable: EngineeringSliceContract = {
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
  };
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

it("excludes only exact generator outputs from model-required gate corrections", () => {
  const paths = [
    "Sources/SafetyAlert.swift",
    "Sources/SafetyAlertTests.swift",
    "Sources/Assets+Generated.swift",
    "Sources/Assets+Generated.swift.bak",
  ];

  expect(
    engineeringModelRequiredCorrectionPaths(paths, ["Sources/Assets+Generated.swift"]),
  ).toEqual([
    "Sources/Assets+Generated.swift.bak",
    "Sources/SafetyAlert.swift",
    "Sources/SafetyAlertTests.swift",
  ]);
  expect(engineeringModelRequiredCorrectionPaths(paths, [])).toEqual([...new Set(paths)].sort());
  expect(engineeringModelRequiredCorrectionPaths(paths, ["Other/Assets+Generated.swift"])).toEqual(
    [...new Set(paths)].sort(),
  );
});

it("wires exact generator filtering through a real gate correction request", async () => {
  const fixture = await createEngineeringQualificationFixture({ id: "generator-correction" });
  try {
    cleanup.push(fixture.sourcePath);
    const executable = process.execPath;
    const generatorCatalog = await CodeOwnedGeneratorCatalog.create({
      definitions: [
        {
          generator_id: "asset-accessors",
          trigger_paths: ["src/schema.json"],
          output_paths: ["src/Assets+Generated.swift"],
          command: { executable, args: ["-e", "process.exit(0)"], env: {}, timeoutMs: 10_000 },
        },
      ],
      executable_allowlist: [executable],
    });
    const qualificationGate = fixture.config.catalog.get("qualification");
    if (qualificationGate === undefined) throw new Error("qualification gate missing");
    const gateCatalog = await VerificationGateCatalog.create({
      definitions: [
        {
          ...qualificationGate,
          required_mutation_paths: [
            "src/Feature.swift",
            "src/Assets+Generated.swift.bak",
            "src/Assets+Generated.swift",
          ],
          required_test_paths: ["src/FeatureTests.swift"],
          implementation_context: [
            {
              kind: "SEARCH",
              relative_path: "src/Feature.swift",
              query: "ABSENT_PREFETCH_SENTINEL",
            },
          ],
        },
      ],
      executable_allowlist: [executable],
    });
    const mapping = createEngineeringGateFailureMapping({
      catalog: gateCatalog,
      targets: [
        { target_id: "source", kind: "SOURCE", paths: ["src/Feature.swift"] },
        { target_id: "test", kind: "TEST", paths: ["src/FeatureTests.swift"] },
        { target_id: "generated", kind: "GENERATOR", paths: ["src/Assets+Generated.swift"] },
        { target_id: "backup", kind: "SOURCE", paths: ["src/Assets+Generated.swift.bak"] },
      ],
      slices: [
        {
          slice_id: "slice-1",
          mutation_target_ids: ["source", "test", "generated", "backup"],
          required_read_context: [{ relative_path: "src/Feature.swift", must_exist: true }],
        },
      ],
      criteria: [
        {
          criterion_id: "criterion-1",
          owning_slice_id: "slice-1",
          required_gate_ids: ["qualification"],
          related_target_ids: ["source", "test", "generated", "backup"],
        },
      ],
    });
    const config = engineeringExecutionConfigWithGateFailureMapping(
      Object.freeze({
        ...fixture.config,
        catalog: gateCatalog,
        generatorCatalog,
        writePathAllowlist: Object.freeze(["src"]),
        testPathAllowlist: Object.freeze(["src"]),
      }),
      mapping,
    );
    const requests: unknown[] = [];
    const transport = {
      requests,
      converse: async (request: unknown) => {
        requests.push(request);
        return {
          model: fixture.modelConfig.model,
          content: [{ type: "json", value: { schema_version: 1, changed_files: [] } }],
        };
      },
    } as never;
    const lease = await fixture.claimImplementer();
    const execution = createEngineeringExecution({
      db: fixture.db,
      jobs: fixture.jobs,
      lease,
      config,
      transport,
      modelConfig: fixture.modelConfig,
      taskBrief: "generator correction",
      createReviewerSession: createStructuredPreCommitReviewSessionFactory({
        transport,
        config: fixture.modelConfig,
      }),
    });
    const slice = {
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      slice_id: "slice-1",
      objective: "repair generated asset integration",
      observable_result: "generated accessor exists",
      allowed_paths: [
        "src/Feature.swift",
        "src/FeatureTests.swift",
        "src/Assets+Generated.swift",
        "src/Assets+Generated.swift.bak",
      ],
      test_paths: ["src/FeatureTests.swift"],
      gate_ids: ["qualification"],
      inspection_method: "run gate",
      stop_condition: "gate passes",
    } as const;
    const failure = {
      schema_version: 2,
      artifact_kind: "GateFailure",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      authority: "SERVER_OWNED",
      slice_id: "slice-1",
      attempt: 1,
      tree_digest: canonicalDigest("tree"),
      diff_digest: canonicalDigest("diff"),
      context_digest: canonicalDigest("context"),
      config_digest: config.configDigest,
      mapping_digest: mapping.mapping_digest,
      blocking_gate_ids: ["qualification"],
      receipt_ids: ["receipt-current"],
      decision_ids: [],
      diagnostics: [
        {
          gate_id: "qualification",
          outcome: "FAILED",
          log_digest: null,
          trust: "UNTRUSTED_DATA",
          excerpt: "generated accessor missing",
        },
      ],
      observations: [
        {
          criterion_id: "criterion-1",
          gate_id: "qualification",
          failure_class: "ASSERTION_FAILED",
          evidence_ref: "receipt-current",
          related_target_ids: ["source", "test", "generated", "backup"],
        },
      ],
    };
    await expect(
      execution.implementationExecutor.execute({
        binding: {
          caseId: fixture.ids.caseId,
          workUnitId: fixture.ids.workUnitId,
          runId: fixture.ids.runId,
          checkpointRevision: 0,
          stage: EngineeringStage.SLICE_IMPLEMENTATION,
          attempt: 2,
        },
        objective: slice.objective,
        context: { packet: "bounded" } as never,
        orderedArtifacts: [
          { stage_attempt: 1, payload: slice },
          {
            stage_attempt: 1,
            payload: {
              artifact_kind: "SliceImplementationReceipt",
              slice_id: "slice-1",
              cumulative_paths: [],
              changed_paths: [],
            },
          },
          { stage_attempt: 1, payload: failure },
        ] as never,
      }),
    ).rejects.toThrow("NO_PROGRESS: slice implementation produced no actual file change");

    const requestText = requests
      .flatMap(
        (request) =>
          (request as { messages?: { content?: { type: string; text?: string }[] }[] }).messages ??
          [],
      )
      .flatMap((message) => message.content ?? [])
      .map((content) => (content.type === "text" ? (content.text ?? "") : ""))
      .join("\n");
    const modelToolNames = (requests[0] as { tools?: { name?: string }[] }).tools?.map(
      (tool) => tool.name,
    );
    expect(modelToolNames).toEqual(["patch", "mkdir"]);
    expect(modelToolNames).not.toEqual(
      expect.arrayContaining(["read", "search", "tree", "config", "write"]),
    );
    expect(requestText).toContain("src/Feature.swift");
    expect(requestText).toContain("src/FeatureTests.swift");
    expect(requestText).toContain("src/Assets+Generated.swift.bak");
    expect(requestText).not.toMatch(/"src\/Assets\+Generated\.swift"(?:[,\]])/u);
    expect(failure.observations[0]?.related_target_ids).toContain("generated");
    expect(mapping.targets.find((target) => target.target_id === "generated")?.paths).toEqual([
      "src/Assets+Generated.swift",
    ]);
  } finally {
    await fixture.drop();
  }
});

it("keeps a file-bounded test path beneath a model-editable directory root", () => {
  const durable: EngineeringSliceContract = {
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
  };

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
        input: {
          replacement_files: [{ relative_path: "Sources/Feature.swift", content: "fixed" }],
        },
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
  expect(
    engineeringImplementationDiscoveryCallLimit([
      ...Array.from({ length: 9 }, (_, index) => ({
        kind: "SEARCH" as const,
        relative_path: `src/${String(index)}.ts`,
        query: `symbol-${String(index)}`,
      })),
      {
        kind: "READ" as const,
        relative_path: "src/large.swift",
        fallback_search_queries: ["one", "two"],
      },
    ]),
  ).toBe(12);
  expect(() =>
    engineeringImplementationDiscoveryCallLimit(
      Array.from({ length: 25 }, (_, index) => ({
        kind: "READ" as const,
        relative_path: `src/${String(index)}.ts`,
      })),
    ),
  ).toThrow(/code-owned discovery cap/u);
  expect(() =>
    engineeringImplementationDiscoveryCallLimit([
      ...Array.from({ length: 23 }, (_, index) => ({
        kind: "SEARCH" as const,
        relative_path: `src/${String(index)}.ts`,
        query: `symbol-${String(index)}`,
      })),
      {
        kind: "READ" as const,
        relative_path: "src/large.swift",
        fallback_search_queries: ["one", "two"],
      },
    ]),
  ).toThrow(/code-owned discovery cap/u);
  expect(
    engineeringImplementationDiscoveryCallLimit(
      Array.from({ length: 26 }, (_, index) => ({
        kind: "SEARCH" as const,
        relative_path: `src/${String(index)}.ts`,
        query: `server-symbol-${String(index)}`,
      })),
      true,
    ),
  ).toBe(26);
  expect(
    engineeringImplementationDiscoveryCallLimit(
      Array.from({ length: 24 }, (_, index) => ({
        kind: "SEARCH" as const,
        relative_path: `src/${String(index)}.ts`,
        query: `fragment-symbol-${String(index)}`,
      })),
      true,
      [],
      true,
    ),
  ).toBe(48);
  expect(() =>
    engineeringImplementationDiscoveryCallLimit(
      Array.from({ length: 49 }, (_, index) => ({
        kind: "SEARCH" as const,
        relative_path: `src/${String(index)}.ts`,
        query: `server-symbol-${String(index)}`,
      })),
      true,
    ),
  ).toThrow(/code-owned discovery cap/u);
});

it("accounts diagnostic windows in the server prefetch call budget", () => {
  const plan = [
    ...Array.from({ length: 47 }, (_, index) => ({
      kind: "SEARCH" as const,
      relative_path: `src/${index}.swift`,
      query: `symbol-${index}`,
    })),
    { kind: "READ" as const, relative_path: "src/diagnostic.swift" },
  ];
  expect(() =>
    engineeringImplementationDiscoveryCallLimit(plan, true, [
      { path: "src/diagnostic.swift", line: 40 },
    ]),
  ).toThrow(/discovery cap/u);
});

it("fails closed when a required declaration lookup exceeds the call budget", () => {
  const plan = buildEngineeringRepairContext({
    diagnostics: [
      {
        path: "src/Feature.swift",
        line: 10,
        column: 1,
        message: "cannot find type 'MissingType' in scope",
        excerpt: "MissingType",
        digest: canonicalDigest("missing"),
      },
    ],
    allowedPaths: [
      "src/Feature.swift",
      ...Array.from({ length: 50 }, (_, index) => `Sources/Root${index}`),
    ],
  });
  expect(plan.omissions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        query: "MissingType",
        required: true,
        reason: "DISCOVERY_CALL_BUDGET",
      }),
    ]),
  );
  expect(() => finalizeEngineeringRepairContext(plan, [])).toThrow(
    /REQUIRED_DECLARATION_TRUNCATED/u,
  );
});

it("retains required diagnostic reads while pruning optional lookup calls", () => {
  const diagnosticPath = "Tests/FeatureTests.swift";
  const plan = buildEngineeringRepairContext({
    diagnostics: [
      ...["Alpha", "Bravo", "Charlie"].map((symbol, index) => ({
        path: diagnosticPath,
        line: 20 + index * 40,
        column: 1,
        message: `cannot find type '${symbol}' in scope`,
        excerpt: symbol,
        digest: canonicalDigest(symbol),
      })),
    ],
    allowedPaths: ["Tests", ...Array.from({ length: 10 }, (_, index) => `Sources/Root${index}`)],
    maxEntries: 24,
  });
  const requiredReads = plan.entries.filter(
    (entry) => entry.kind === "READ" && entry.relative_path === diagnosticPath,
  );
  expect(requiredReads).toHaveLength(1);
  expect(() =>
    engineeringImplementationDiscoveryCallLimit(
      plan.entries.map(correctionEntry),
      true,
      plan.diagnostics,
    ),
  ).not.toThrow();
  expect(
    engineeringImplementationDiscoveryCallLimit(
      plan.entries.map(correctionEntry),
      true,
      plan.diagnostics,
    ),
  ).toBeLessThanOrEqual(48);
  expect(plan.omissions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "DECLARATION",
        reason: "DISCOVERY_CALL_BUDGET",
        required: false,
      }),
    ]),
  );
  const content = Array.from({ length: 140 }, (_, index) => `line ${index + 1}`).join("\n");
  expect(plan.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "READ", relative_path: "Package.swift", required: true }),
    ]),
  );
  expect(() =>
    finalizeEngineeringRepairContext(plan, [
      {
        kind: "READ",
        relative_path: "Package.swift",
        query: null,
        evidence: JSON.stringify({
          tool: "read",
          relative_path: "Package.swift",
          complete: true,
          content: "// swift-tools-version: 6.0\nimport PackageDescription",
          digest: canonicalDigest("// swift-tools-version: 6.0\nimport PackageDescription"),
        }),
      },
      {
        kind: "READ",
        relative_path: diagnosticPath,
        query: null,
        evidence: JSON.stringify({
          tool: "read",
          relative_path: diagnosticPath,
          complete: true,
          content,
          digest: canonicalDigest(content),
        }),
      },
    ]),
  ).not.toThrow();
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

it("prefetches unchanged gate candidates as exact reads instead of configured searches", () => {
  const configured = [
    { kind: "SEARCH" as const, relative_path: "src/unchanged.swift", query: "missingSymbol" },
    { kind: "READ" as const, relative_path: "src/context.swift" },
  ];
  expect(
    engineeringCorrectionImplementationContext(configured, [], true, ["src/unchanged.swift"]),
  ).toEqual([
    { kind: "READ", relative_path: "src/context.swift" },
    { kind: "READ", relative_path: "src/unchanged.swift" },
  ]);
});

it("selects optional gate reads only outside compiler and review-required paths", () => {
  const input = {
    correction: true,
    compilerRepair: false,
    gateCandidatePaths: ["src/normal.swift", "src/review.swift"],
    activeSlicePaths: ["src"],
    reviewRequiredPaths: ["src/review.swift"],
  };
  expect(engineeringOptionalGateCandidateReadPaths(input)).toEqual(["src/normal.swift"]);
  expect(engineeringOptionalGateCandidateReadPaths({ ...input, compilerRepair: true })).toEqual([]);
  expect(engineeringOptionalGateCandidateReadPaths({ ...input, correction: false })).toEqual([]);
});

it("adds review-required paths to correction READ fallback eligibility", () => {
  expect(
    engineeringCorrectionFallbackReadPaths(["src/normal.swift"], ["src/review.swift"]),
  ).toEqual(["src/normal.swift", "src/review.swift"]);
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
  const slice: EngineeringSliceContract = {
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
  };
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
  const slice: EngineeringSliceContract = {
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
  };
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
      required_mutation_paths: ["src/Flow.swift", "src/FlowView.swift"],
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
    required_mutation_paths: ["src/Flow.swift", "src/FlowView.swift"],
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

it("parses legacy review decisions but refuses untyped correction authority", () => {
  const legacy = engineeringReviewDecision.parse({
    schema_version: 1,
    artifact_kind: "ReviewDecision",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    decision_id: "legacy-review",
    rationale: "legacy review",
    decision: "CHANGES_REQUIRED",
    findings: ["legacy finding"],
    reviewed_digest: canonicalDigest("legacy"),
  });
  expect(legacy.required_mutation_paths).toEqual([]);
  const slice: EngineeringSliceContract = {
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-legacy",
    objective: "bounded slice",
    observable_result: "observable result",
    allowed_paths: ["src/legacy.ts"],
    test_paths: [],
    gate_ids: ["unit"],
    inspection_method: "focused test",
    stop_condition: "passes",
  };
  expect(() =>
    engineeringPreviousReviewCorrection(
      [
        { stage_attempt: 1, payload: slice } as never,
        { stage_attempt: 2, payload: legacy } as never,
      ],
      { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 3 },
      slice,
    ),
  ).toThrow("legacy CHANGES_REQUIRED review decision has no typed mutation paths");
});

it("carries an unchanged TestFlight target through review correction authority", () => {
  const slice: EngineeringSliceContract = {
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-mobl-2023",
    objective: "implement the safety alert",
    observable_result: "the alert interrupts the conversation",
    allowed_paths: [
      "SonderClient/Sources/SafetyAlert.swift",
      "SonderClient/TestFlight/WhatToTest.en-US.txt",
    ],
    test_paths: [],
    gate_ids: ["review"],
    inspection_method: "focused review",
    stop_condition: "review passes",
  };
  const decision = engineeringReviewDecision.parse({
    schema_version: 1,
    artifact_kind: "ReviewDecision",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    decision_id: "mobl-review",
    rationale: "missing TestFlight release note",
    decision: "CHANGES_REQUIRED",
    findings: ["[finding] HIGH SonderClient/Sources/SafetyAlert.swift:3 — Missing release note"],
    required_mutation_paths: ["SonderClient/TestFlight/WhatToTest.en-US.txt"],
    reviewed_digest: canonicalDigest("mobl-patch"),
  });
  const rows = [
    { stage_attempt: 1, payload: slice },
    { stage_attempt: 2, payload: decision },
  ] as never;
  const correction = engineeringPreviousReviewCorrection(
    rows,
    { caseId: "case-1", runId: "run-1", checkpointRevision: 0, attempt: 3 },
    slice,
  );
  expect(correction?.required_mutation_paths).toEqual([
    "SonderClient/TestFlight/WhatToTest.en-US.txt",
  ]);
  const context = engineeringCorrectionImplementationContext(
    [{ kind: "READ", relative_path: "SonderClient/Sources/SafetyAlert.swift" }],
    [],
    true,
    correction?.required_mutation_paths ?? [],
  );
  expect(context).toContainEqual({
    kind: "READ",
    relative_path: "SonderClient/TestFlight/WhatToTest.en-US.txt",
  });
  expect(
    engineeringRequiredSubstantiveMutationPaths([], correction?.required_mutation_paths ?? []),
  ).toEqual(["SonderClient/TestFlight/WhatToTest.en-US.txt"]);
});

it("prefetches current TestFlight bytes and requires its mutation receipt", async () => {
  const target = "SonderClient/TestFlight/WhatToTest.en-US.txt";
  const currentBytes = "Current TestFlight notes for the safety alert\n";
  const tools = {
    read: async ({ relative_path }: { relative_path: string }) =>
      implementationToolResult.parse({
        schema_version: 1,
        operation_id: "read-testflight",
        identity: { case_id: "case-1", workspace_id: "workspace-1" },
        kind: "READ_FILE",
        outcome: "SUCCEEDED",
        before_digest: null,
        after_digest: canonicalDigest(currentBytes),
        changed_files: [],
        output: {
          trust: "UNTRUSTED_DATA",
          value: relative_path === target ? currentBytes : "wrong path",
          truncated: false,
          original_byte_length: currentBytes.length,
        },
      }),
  } as unknown as BoundedImplementationToolset;
  const evidence = await prefetchEngineeringImplementationContext(
    tools,
    [{ kind: "READ", relative_path: target }],
    true,
  );
  expect(evidence).toContainEqual(
    expect.objectContaining({ relative_path: target, evidence: currentBytes }),
  );
  const runtime = engineeringReviewCorrectionRuntimeConfig(
    engineeringImplementationRuntimeConfig(
      createRuntimeConfig({
        model: { provider: "test", model_id: "implementation-model" },
        timeoutMs: 1_000,
        toolLimits: { maxIterations: 2, maxCalls: 4 },
      }),
    ),
    [target],
  );
  expect(runtime.toolLoopPolicy?.requiredSuccessfulMutationPathsAll).toEqual([target]);
  expect(runtime.toolLoopPolicy?.requiredSuccessfulMutationPathsAll).not.toContain(
    "SonderClient/Sources/SafetyAlert.swift",
  );
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
  ).rejects.toMatchObject({
    name: "EngineeringImplementationContextError",
    code: "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE",
  });
  expect(
    engineeringDebugErrorCode(
      new EngineeringImplementationContextError("IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE"),
    ),
  ).toBe("IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE");
});

it("fragments an inconsistent truncated READ only with an explicit server budget", async () => {
  const digest = canonicalDigest("complete-file");
  const succeeded = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "read-full",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "READ_FILE",
    outcome: "SUCCEEDED",
    before_digest: null,
    after_digest: digest,
    changed_files: [],
    output: {
      trust: "UNTRUSTED_DATA",
      value: JSON.stringify({ tool: "read", complete: true, digest, content: "tail" }),
      truncated: true,
      original_byte_length: 80_000,
    },
  });
  const excerptValue = JSON.stringify({
    tool: "read_excerpt",
    refused: false,
    complete: false,
    relative_path: "src/Large.swift",
    start_line: 1,
    end_line: 1,
    full_file_digest: digest,
    end_of_file: true,
    content: "FRAGMENT_TAIL_SENTINEL\n",
  });
  const excerpt = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "read-excerpt",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "READ_FILE",
    outcome: "SUCCEEDED",
    before_digest: null,
    after_digest: digest,
    changed_files: [],
    output: {
      trust: "UNTRUSTED_DATA",
      value: excerptValue,
      truncated: false,
      original_byte_length: Buffer.byteLength(excerptValue),
    },
  });
  const tools = {
    read: async () => succeeded,
    readExcerpt: async () => excerpt,
  } as unknown as BoundedImplementationToolset;
  const fragments = await prefetchEngineeringImplementationContext(
    tools,
    [{ kind: "READ", relative_path: "src/Large.swift" }],
    false,
    [],
    [],
    undefined,
    { used: 0 },
  );
  expect(fragments).toHaveLength(1);
  expect(fragments[0]?.evidence).toContain("FRAGMENT_TAIL_SENTINEL");
  await expect(
    prefetchEngineeringImplementationContext(
      {
        ...tools,
        readExcerpt: async () => ({
          ...excerpt,
          outcome: "FAILED",
          failure_code: "DISCOVERY_FAILED",
        }),
      } as never,
      [{ kind: "READ", relative_path: "src/Large.swift" }],
      false,
      [],
      [],
      undefined,
      { used: 0 },
    ),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
});

it("tolerates only an absent optional gate candidate and preserves required-read failures", async () => {
  const result = (failureCode: string) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id: "context-read",
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind: "READ_FILE",
      outcome: "FAILED",
      before_digest: null,
      after_digest: null,
      changed_files: [],
      failure_code: failureCode,
      output: {
        trust: "UNTRUSTED_DATA",
        value: JSON.stringify({ tool: "read", refused: true, failure_code: failureCode }),
        truncated: false,
        original_byte_length: Buffer.byteLength(
          JSON.stringify({ tool: "read", refused: true, failure_code: failureCode }),
        ),
      },
    });
  const tools = {
    read: async () => result("FILE_NOT_FOUND"),
    search: async () => result("DISCOVERY_FAILED"),
  } as unknown as BoundedImplementationToolset;
  await expect(
    prefetchEngineeringImplementationContext(
      tools,
      [{ kind: "READ", relative_path: "src/optional.swift" }],
      false,
      ["src/optional.swift"],
    ),
  ).resolves.toEqual([
    { kind: "READ", relative_path: "src/optional.swift", query: null, evidence: "", exists: false },
  ]);
  await expect(
    prefetchEngineeringImplementationContext(tools, [
      { kind: "READ", relative_path: "src/required.swift" },
    ]),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
  const fatalTools = {
    ...tools,
    read: async () => result("OUTPUT_TOO_LARGE"),
  } as unknown as BoundedImplementationToolset;
  await expect(
    prefetchEngineeringImplementationContext(
      fatalTools,
      [{ kind: "READ", relative_path: "src/optional.swift" }],
      false,
      ["src/optional.swift"],
    ),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_OUTPUT_TOO_LARGE" });
  const genericFailureTools = {
    ...tools,
    read: async () => result("DISCOVERY_FAILED"),
  };
  await expect(
    prefetchEngineeringImplementationContext(
      genericFailureTools,
      [{ kind: "READ", relative_path: "src/optional.swift" }],
      false,
      ["src/optional.swift"],
    ),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
});

it("retains configured SEARCH queries as fallback metadata for optional and review-required reads", () => {
  const configured = [
    { kind: "SEARCH" as const, relative_path: "src/Large.swift", query: "first" },
    { kind: "SEARCH" as const, relative_path: "src/Large.swift", query: "second" },
  ];
  const plan = engineeringCorrectionImplementationContext(
    configured,
    [],
    true,
    ["src/Large.swift", "src/Review.swift"],
    ["src/Large.swift"],
  );
  expect(plan).toEqual([
    {
      kind: "READ",
      relative_path: "src/Large.swift",
      fallback_search_queries: ["first", "second"],
    },
    { kind: "READ", relative_path: "src/Review.swift" },
  ]);
  const reviewPlan = engineeringCorrectionImplementationContext(
    [
      ...configured,
      { kind: "SEARCH" as const, relative_path: "src/Review.swift", query: "review" },
    ],
    [],
    true,
    ["src/Large.swift", "src/Review.swift"],
    ["src/Large.swift", "src/Review.swift"],
  );
  expect(reviewPlan.find((entry) => entry.relative_path === "src/Review.swift")).toEqual({
    kind: "READ",
    relative_path: "src/Review.swift",
    fallback_search_queries: ["review"],
  });
});

it("falls back from an oversized optional gate READ to every exact configured SEARCH", async () => {
  const make = (
    kind: "READ_FILE" | "SEARCH_TEXT",
    operation_id: string,
    value: string,
    failure_code?: string,
  ) =>
    implementationToolResult.parse({
      schema_version: 1,
      operation_id,
      identity: { case_id: "case-1", workspace_id: "workspace-1" },
      kind,
      outcome: failure_code === undefined ? "SUCCEEDED" : "FAILED",
      before_digest: null,
      after_digest: failure_code === undefined ? canonicalDigest(value) : null,
      changed_files: [],
      ...(failure_code === undefined ? {} : { failure_code }),
      output: {
        trust: "UNTRUSTED_DATA",
        value,
        truncated: false,
        original_byte_length: Buffer.byteLength(value),
      },
    });
  const calls: string[] = [];
  const tools = {
    read: async () => make("READ_FILE", "read", "too large", "OUTPUT_TOO_LARGE"),
    search: async (input: { query: string }) => {
      calls.push(input.query);
      return make("SEARCH_TEXT", `search-${input.query}`, `evidence-${input.query}`);
    },
  } as unknown as BoundedImplementationToolset;
  await expect(
    prefetchEngineeringImplementationContext(tools, [
      {
        kind: "READ",
        relative_path: "src/Large.swift",
        fallback_search_queries: ["first", "second"],
      } as never,
    ]),
  ).resolves.toEqual([
    {
      kind: "SEARCH",
      relative_path: "src/Large.swift",
      query: "first",
      evidence: "evidence-first",
    },
    {
      kind: "SEARCH",
      relative_path: "src/Large.swift",
      query: "second",
      evidence: "evidence-second",
    },
  ]);
  expect(calls).toEqual(["first", "second"]);
});

it("fails when an oversized optional gate READ fallback SEARCH fails", async () => {
  const failed = implementationToolResult.parse({
    schema_version: 1,
    operation_id: "failed-search",
    identity: { case_id: "case-1", workspace_id: "workspace-1" },
    kind: "SEARCH_TEXT",
    outcome: "FAILED",
    before_digest: null,
    after_digest: null,
    changed_files: [],
    failure_code: "DISCOVERY_FAILED",
    output: { trust: "UNTRUSTED_DATA", value: "x", truncated: false, original_byte_length: 1 },
  });
  const oversized = { ...failed, kind: "READ_FILE", failure_code: "OUTPUT_TOO_LARGE" } as never;
  const tools = {
    read: async () => oversized,
    search: async () => failed,
  } as unknown as BoundedImplementationToolset;
  await expect(
    prefetchEngineeringImplementationContext(tools, [
      {
        kind: "READ",
        relative_path: "src/Large.swift",
        fallback_search_queries: ["query"],
      } as never,
    ]),
  ).rejects.toMatchObject({ code: "IMPLEMENTATION_CONTEXT_READ_FAILED" });
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
    "src/settings.ts",
  ]);
  const noTestCatalog = await VerificationGateCatalog.create({
    definitions: [
      {
        ...loaded.catalog.definitions[0]!,
        required_test_paths: [],
        required_mutation_paths: ["src/settings.ts"],
      },
    ],
    executable_allowlist: [executable],
  });
  expect(engineeringGateCorrectionMutationPaths(noTestCatalog, ["unit"], ["src"])).toEqual([
    "src/settings.ts",
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
  ).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
    "src/settings.ts",
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
    "src/settings.ts",
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
  ).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
    "src/settings.ts",
  ]);
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
  ).toEqual(["src/SafetyAlert.swift", "src/SafetyAlertTests.swift"]);
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
  ).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
    "src/settings.ts",
  ]);
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
  ).toEqual([
    "src/EmergencyResourcesRouterTests.swift",
    "src/EmergencyResourcesTextFlowAdapterTests.swift",
    "src/SafetyAlertTests.swift",
    "src/settings.ts",
  ]);
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
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      slice_id: "slice-1",
      objective: "bounded change",
      observable_result: "one visible result",
      allowed_paths: ["src"],
      test_paths: ["src/flow.test.ts"],
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
  expect(implementationPrompt).toContain("Never infer or import Quick, Nimble");
  expect(implementationPrompt).toContain("TEST_SOURCE_INTROSPECTION_REFUSED");
  expect(implementationPrompt).toContain("comments/dead code");
  expect(implementationPrompt).not.toContain(executable);
  const prefetchedInput: Parameters<typeof engineeringImplementationPrompt>[0] = {
    objective: "bounded change",
    slice: {
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      slice_id: "slice-1",
      objective: "bounded change",
      observable_result: "one visible result",
      allowed_paths: ["src"],
      test_paths: ["src/flow.test.ts"],
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
      {
        kind: "READ",
        relative_path: "src/optional.swift",
        query: null,
        evidence: "",
        exists: false,
      },
      {
        kind: "READ",
        relative_path: "tests/flow.test.swift",
        query: null,
        evidence: "final class FlowTests: XCTestCase {}",
      },
    ],
    existingAgentPaths: ["src/existing-test.ts", "src/existing-source.ts"],
    gateCorrection: {
      blocking_gate_ids: ["unit"],
      required_mutation_paths: ["src/flow.test.ts", "src/flow.ts"],
      observations: ["criterion-action", "criterion-analytics"].map((criterion_id) => ({
        criterion_id,
        gate_id: "unit",
        failure_class: "ASSERTION_FAILED" as const,
        evidence_ref: "current-receipt",
        related_target_ids: ["flow-target"],
      })),
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
          observations: [
            {
              criterion_id: "criterion-variant",
              gate_id: "unit",
              failure_class: "ASSERTION_FAILED",
              evidence_ref: "previous-receipt",
              related_target_ids: ["flow-target"],
            },
          ],
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
  };
  const prefetchedPrompt = engineeringImplementationPrompt(prefetchedInput);
  expect(prefetchedPrompt).toContain(JSON.stringify(prefetchedInput.gateCorrection!.observations));
  expect(prefetchedPrompt).toContain(
    JSON.stringify(prefetchedInput.gateCorrection!.regression_history[0]!.observations),
  );
  expect(prefetchedPrompt).toContain("server already performed the complete code-owned discovery");
  expect(prefetchedPrompt).toContain("Use only the supplied write, patch, and mkdir tools");
  expect(prefetchedPrompt).toContain("bounded repository excerpt");
  expect(prefetchedPrompt).toContain("Previous required-gate correction evidence");
  expect(prefetchedPrompt).toContain("src/flow.ts");
  expect(prefetchedPrompt).toContain("cannot find symbol");
  expect(prefetchedPrompt).toContain(
    "Preserve exact code spellings and signatures named by diagnostics",
  );
  expect(prefetchedPrompt).toContain("bounded regression history");
  expect(prefetchedPrompt).toContain("SafetyAlert must retain the variant property");
  expect(prefetchedPrompt).toContain(
    "When writing test code, use only frameworks or modules demonstrated by the server-prefetched repository or dependency context",
  );
  expect(prefetchedPrompt).toContain(
    "when neighboring required test context uses XCTestCase, follow XCTestCase",
  );
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
    'Immediate server-owned correction action: the exact candidate set ["src/flow.test.ts","src/flow.ts"] is authorized for this gate correction; at least one candidate MUST receive a successful substantive patch receipt',
  );
  expect(correctionPrompt).toContain("at least one candidate");
  expect(correctionPrompt).toContain(
    "Do not return a final report or changed_files=[] before changing at least one candidate",
  );
  expect(correctionPrompt).toContain("exact immediate correction checklist");
  expect(correctionPrompt).toContain("Never infer or import Quick, Nimble");
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
    "Patch diagnostic-owned editable code or source-backed related declarations/current evidence within the existing slice.allowed_paths",
  );
  expect(compilerRepairPrompt).toContain("never modify immutable evaluator or injected tests");
  expect(compilerRepairPrompt).not.toContain(
    "Patch only repository-relative files named by the structured compiler diagnostics",
  );
  expect(compilerRepairPrompt).toContain(
    "one additional patch batch only if the first cleanly returns FAILED",
  );
  expect(compilerRepairPrompt).toContain("AMBIGUOUS result is never retryable");
  expect(compilerRepairPrompt).toContain("Set expected_before_digest to null");
  expect(compilerRepairPrompt).toContain("whole workspace tree");
  expect(compilerRepairPrompt).toContain("read/evidence digests are not valid");
  expect(compilerRepairPrompt).toContain(
    "when neighboring required test context uses XCTestCase, follow XCTestCase",
  );
  const epochHandoff = JSON.stringify(engineeringImplementationEpochHandoff(prefetchedInput));
  expect(epochHandoff).toContain(JSON.stringify(prefetchedInput.gateCorrection!.observations));
  expect(epochHandoff).toContain(
    JSON.stringify(prefetchedInput.gateCorrection!.regression_history[0]!.observations),
  );
  expect(epochHandoff).toContain("ENGINEERING_IMPLEMENTATION_CONTEXT_EPOCH");
  expect(epochHandoff).toContain(canonicalDigest("bounded repository excerpt"));
  expect(epochHandoff).toContain(canonicalDigest("bounded context"));
  expect(epochHandoff).toContain('"exists":false');
  expect(epochHandoff).not.toContain("bounded repository excerpt");
  expect(epochHandoff).toContain("bounded context");
  expect(epochHandoff).toContain("UNTRUSTED_DATA");
  expect(epochHandoff).not.toContain("cannot find symbol");
  const compactCorrectionContext = engineeringImplementationContextPacket(
    "raw context canary that must not be resent",
    true,
  );
  expect(compactCorrectionContext).toContain("ENGINEERING_CORRECTION_CONTEXT_REFERENCE");
  expect(compactCorrectionContext).toContain(
    canonicalDigest("raw context canary that must not be resent"),
  );
  expect(compactCorrectionContext).toContain("raw context canary that must not be resent");
  expect(compactCorrectionContext).toContain("UNTRUSTED_DATA");
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
          command: { ...value.generators[0]!.command, args: ["-e", "process.exit(2)"] },
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

it("retains the bounded owner task packet across correction and context epochs", () => {
  const ownerTaskLiteral = "Help is available only through the bounded owner task packet";
  const input: Parameters<typeof engineeringImplementationPrompt>[0] = {
    objective: "Implement the requested behavior without broadening the slice",
    slice: {
      schema_version: 2,
      artifact_kind: "SliceContract",
      case_id: "owner-packet-case",
      run_id: "owner-packet-run",
      revision: 0,
      slice_id: "owner-packet-slice",
      objective: "Implement the requested behavior without broadening the slice",
      observable_result: "the requested behavior is observable",
      allowed_paths: ["src/owned.ts"],
      test_paths: ["src/owned.test.ts"],
      gate_ids: [],
      inspection_method: "inspect result",
      stop_condition: "the focused test passes",
    },
    contextPacket: ownerTaskLiteral,
    gateGuidance: [],
    prefetchedContext: [
      {
        kind: "READ",
        relative_path: "src/owned.ts",
        query: null,
        evidence: "RAW_REPOSITORY_CANARY must not be replayed",
      },
    ],
  };
  const correctionPacket = engineeringImplementationContextPacket(input.contextPacket, true);
  const correctionPrompt = engineeringImplementationPrompt({
    ...input,
    contextPacket: correctionPacket,
  });
  expect(correctionPrompt).toContain(ownerTaskLiteral);
  expect(correctionPrompt).toContain(canonicalDigest(ownerTaskLiteral));

  const initialEpoch = JSON.stringify(engineeringImplementationEpochHandoff(input));
  expect(initialEpoch).toContain(ownerTaskLiteral);
  expect(initialEpoch).toContain(canonicalDigest(ownerTaskLiteral));
  expect(initialEpoch).toContain("UNTRUSTED_DATA");
  expect(initialEpoch).not.toContain("RAW_REPOSITORY_CANARY");

  const correctionEpoch = JSON.stringify(
    engineeringImplementationEpochHandoff({ ...input, contextPacket: correctionPacket }),
  );
  expect(correctionEpoch).toContain(ownerTaskLiteral);
  expect(correctionEpoch).toContain(canonicalDigest(correctionPacket));
  expect(correctionEpoch).toContain("UNTRUSTED_DATA");
  expect(correctionEpoch).not.toContain("RAW_REPOSITORY_CANARY");
});
