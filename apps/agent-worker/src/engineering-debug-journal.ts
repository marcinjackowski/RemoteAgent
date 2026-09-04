/** Bounded, content-free diagnostic journal for one Engineering invocation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { canonicalDigest, engineeringArtifact, sha256Digest } from "@remoteagent/contracts";
import type { Database, JobLease } from "@remoteagent/database";
import {
  implementationToolResult,
  type ImplementationToolResult,
} from "@remoteagent/implementation-tools";
import type { StructuredLogger } from "@remoteagent/observability";
import type {
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeTransport,
  RuntimeUsage,
} from "@remoteagent/model-runtime";
import {
  subscriptionModelInvocationDescriptorV1,
  subscriptionModelRole,
  ToolInputError,
  type SubscriptionModelInvocationDescriptorV1,
  type SubscriptionModelRole,
} from "@remoteagent/model-runtime";
import * as z from "zod";

import { parseXcodeCompilerDiagnostics, parseXcodeTestDiagnostics } from "./xcode-gate-adapter.js";

const id = z.string().min(1).max(512);
const boundedName = z.string().min(1).max(128);
export const ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER = 3;
export const ENGINEERING_MODEL_HARD_TOKEN_LIMIT =
  600_000 * ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER;
export const ENGINEERING_MODEL_TARGET_TOKEN_LIMIT =
  250_000 * ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER;
export const ENGINEERING_MODEL_WARNING_TOKEN_LIMIT =
  400_000 * ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER;
export const ENGINEERING_MODEL_CALL_TOKEN_RESERVE =
  35_000 * ENGINEERING_MODEL_DIAGNOSTIC_BUDGET_MULTIPLIER;
/** Receipt-backed corrections start from bounded server-prefetched context, then rotate after one pair. */
export const ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE = 64_000;
export const ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE = 32_000;
export const ENGINEERING_REVIEWER_MODEL_CALL_TOKEN_RESERVE = 32_000;
export const ENGINEERING_VERIFIER_MODEL_CALL_TOKEN_RESERVE = 32_000;

function engineeringModelCallTokenReserve(
  role: SubscriptionModelRole | null | undefined,
  override?: number,
): number {
  if (override !== undefined) return override;
  if (role === "REVIEWER") return ENGINEERING_REVIEWER_MODEL_CALL_TOKEN_RESERVE;
  if (role === "VERIFIER") return ENGINEERING_VERIFIER_MODEL_CALL_TOKEN_RESERVE;
  return ENGINEERING_MODEL_CALL_TOKEN_RESERVE;
}

/** A typed, code-owned signal that permits receipt-backed implementation finalization. */
export class EngineeringModelBudgetError extends Error {
  readonly code = "ENGINEERING_MODEL_BUDGET_EXHAUSTED";

  constructor(readonly reserveTokens = ENGINEERING_MODEL_CALL_TOKEN_RESERVE) {
    super(
      `Engineering model call refused because the ${String(reserveTokens)}-token reserve would exceed the ${String(ENGINEERING_MODEL_HARD_TOKEN_LIMIT)}-token hard limit`,
    );
    this.name = "EngineeringModelBudgetError";
  }
}
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !isAbsolute(value) && !value.split(/[/\\]+/u).includes(".."));

const usage = z.strictObject({
  event: z.literal("MODEL_USAGE"),
  stage: boundedName.nullable(),
  role: subscriptionModelRole.nullable().optional(),
  slice_id: id.nullable().optional(),
  attempt: z.number().int().positive().nullable().optional(),
  invocation_digest: sha256Digest.nullable().optional(),
  provider: boundedName.nullable().optional(),
  profile_name: boundedName.nullable().optional(),
  model: boundedName.nullable().optional(),
  client_version: boundedName.nullable().optional(),
  response_input_tokens: z.number().int().nonnegative().nullable().optional(),
  response_output_tokens: z.number().int().nonnegative().nullable().optional(),
  response_total_tokens: z.number().int().nonnegative().nullable().optional(),
  provider_reported: z.boolean().optional(),
  responses: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  responses_without_usage: z.number().int().nonnegative(),
  responses_with_partial_usage: z.number().int().nonnegative(),
  comparison: z.enum(["TARGET", "WARNING", "HARD_LIMIT"]),
});

const toolBatch = z.strictObject({
  event: z.literal("TOOL_BATCH"),
  stage: boundedName.nullable().optional(),
  slice_id: id.nullable().optional(),
  attempt: z.number().int().positive().nullable().optional(),
  tools: z
    .array(
      z.strictObject({
        name: boundedName,
        relative_path: relativePath.nullable(),
        query_digest: sha256Digest.nullable(),
        files: z.array(relativePath).max(64),
        input_keys: z.array(boundedName).max(32),
      }),
    )
    .min(1)
    .max(64),
});

const replacementRepairDiagnostic = z.strictObject({
  relative_path: relativePath,
  replacement_index: z.number().int().nonnegative(),
  expected_old_content_digest: sha256Digest,
  current_excerpt_digest: sha256Digest,
  current_excerpt_complete: z.boolean(),
});

const toolResult = z.strictObject({
  event: z.literal("TOOL_RESULT"),
  stage: boundedName.nullable().optional(),
  slice_id: id.nullable().optional(),
  attempt: z.number().int().positive().nullable().optional(),
  kind: boundedName,
  outcome: z.enum(["SUCCEEDED", "FAILED", "AMBIGUOUS"]),
  failure_code: boundedName.nullable(),
  changed_files: z.array(relativePath).max(512),
  operation_id_digest: sha256Digest.nullable(),
  output_truncated: z.boolean(),
  repair_context: replacementRepairDiagnostic.nullable().optional(),
});

const toolInputRefusal = z.strictObject({
  event: z.literal("TOOL_INPUT_REFUSAL"),
  stage: boundedName.nullable().optional(),
  slice_id: id.nullable().optional(),
  attempt: z.number().int().positive().nullable().optional(),
  tool_name: boundedName,
  failure_code: z.literal("TOOL_INPUT_INVALID"),
  issues: z
    .array(
      z.strictObject({
        code: boundedName,
        path: z.array(boundedName).max(8),
      }),
    )
    .min(1)
    .max(8),
});

const checklistItem = z.enum([
  "DISCOVERY",
  "DESIGN",
  "SLICE",
  "TEST_FIRST",
  "IMPLEMENTATION",
  "FAST_GATES",
  "FULL_GATES",
  "REVIEW",
  "COMMIT",
]);
const progressState = z.enum(["PENDING", "IN_PROGRESS", "COMPLETE", "BLOCKED"]);
const debugDecisionCode = z.enum([
  "STAGE_ENTERED",
  "STAGE_COMPLETED",
  "STAGE_FAILED",
  "MODEL_CALL_RESERVED",
  "MODEL_CALL_REFUSED_BUDGET",
  "IMPLEMENTATION_RECEIPT_FINALIZED",
  "MODEL_RESPONSE_RECORDED",
  "DISCOVERY_BATCH_REQUESTED",
  "MUTATION_BATCH_REQUESTED",
  "MUTATION_RESULT_RECORDED",
  "FAST_GATES_PASSED",
  "FAST_GATES_BLOCKED",
  "FULL_GATES_PASSED",
  "FULL_GATES_BLOCKED",
]);
export type EngineeringDebugDecisionCode = z.infer<typeof debugDecisionCode>;

const progressSnapshot = z.strictObject({
  event: z.literal("PROGRESS_SNAPSHOT"),
  stage: boundedName.nullable(),
  slice_id: id.nullable(),
  attempt: z.number().int().positive().nullable(),
  decision_code: debugDecisionCode,
  checklist: z.array(z.strictObject({ item: checklistItem, status: progressState })).length(9),
  rounds: z.strictObject({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    mutation_reserved: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  calls: z.strictObject({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  tokens: z.strictObject({
    used: z.number().int().nonnegative(),
    target: z.number().int().positive(),
    warning: z.number().int().positive(),
    hard_limit: z.number().int().positive(),
    final_call_reserved: z.number().int().nonnegative(),
    remaining_to_target: z.number().int().nonnegative(),
    remaining_to_hard_limit: z.number().int().nonnegative(),
  }),
  gates: z.strictObject({ fast: progressState, full: progressState }),
});

const decisionEvent = z.strictObject({
  event: z.literal("DECISION"),
  stage: boundedName.nullable(),
  slice_id: id.nullable(),
  attempt: z.number().int().positive().nullable(),
  decision_code: debugDecisionCode,
  structural_digest: sha256Digest,
});

const debugEvent = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("RUN_STARTED"),
    case_id: id,
    run_id: id,
    model: boundedName,
    base_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    config_digest: sha256Digest,
  }),
  usage,
  toolBatch,
  toolResult,
  toolInputRefusal,
  progressSnapshot,
  decisionEvent,
  z.strictObject({
    event: z.literal("MODEL_OUTPUT_SHAPE"),
    keys: z.array(boundedName).max(64),
    artifact_kind: boundedName.nullable(),
    changed_files: z.array(relativePath).max(512).nullable(),
    decision: z
      .enum(["PASS", "CHANGES_REQUIRED", "BLOCKED", "VERIFIED", "FAILED", "INCONCLUSIVE"])
      .nullable(),
    criterion_statuses: z.array(z.enum(["PASSED", "FAILED", "INCONCLUSIVE"])).max(256),
    review_lines_examined: z.number().int().nonnegative().nullable(),
    review_findings: z
      .array(
        z.strictObject({
          severity: z.enum(["BLOCKER", "HIGH", "MEDIUM", "LOW", "NIT"]),
          relative_path: relativePath,
          line: z.number().int().positive(),
        }),
      )
      .max(64),
  }),
  z.strictObject({
    event: z.literal("MODEL_ATTEMPT_ERROR"),
    stage: boundedName.nullable(),
    role: subscriptionModelRole.nullable(),
    slice_id: id.nullable(),
    attempt: z.number().int().positive().nullable(),
    provider: boundedName.nullable(),
    profile_name: boundedName.nullable(),
    model: boundedName.nullable(),
    error_name: boundedName,
    error_code: boundedName.nullable(),
    error_detail_code: boundedName.nullable(),
    retryable: z.boolean(),
    error_digest: sha256Digest,
  }),
  z.strictObject({
    event: z.literal("STAGE_ERROR"),
    stage: boundedName,
    error_name: boundedName,
    error_code: boundedName.nullable(),
    error_detail_code: boundedName.nullable().optional(),
    error_digest: sha256Digest,
  }),
  z.strictObject({
    event: z.literal("GATE_BOUNDARY_ERROR"),
    gate_id: boundedName,
    target: boundedName,
    phase: boundedName,
    error_name: boundedName,
    error_code: boundedName.nullable(),
    protected_changes: z
      .array(
        z.strictObject({
          relative_path: relativePath,
          change: z.enum(["ADDED", "REMOVED", "MODIFIED"]),
        }),
      )
      .max(128),
    error_digest: sha256Digest,
  }),
  z.strictObject({
    event: z.literal("RUN_DIAGNOSTIC"),
    artifacts: z
      .array(
        z.strictObject({
          artifact_kind: boundedName,
          stage: boundedName,
          stage_attempt: z.number().int().positive(),
          review_decision: z.enum(["PASS", "CHANGES_REQUIRED", "BLOCKED"]).nullable(),
          verification_decision: z.enum(["VERIFIED", "FAILED", "INCONCLUSIVE"]).nullable(),
        }),
      )
      .max(512),
    compiler_diagnostics: z
      .array(
        z.strictObject({
          gate_id: boundedName,
          stage_attempt: z.number().int().positive(),
          path: relativePath,
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          message_digest: sha256Digest,
          diagnostic_digest: sha256Digest,
        }),
      )
      .max(512),
    test_diagnostics: z
      .array(
        z.strictObject({
          gate_id: boundedName,
          stage_attempt: z.number().int().positive(),
          test_name: z.string().trim().min(1).max(1024),
          path: relativePath.nullable(),
          line: z.number().int().positive().nullable(),
          message_digest: sha256Digest,
          diagnostic_digest: sha256Digest,
        }),
      )
      .max(512)
      .optional(),
    operations: z
      .array(
        z.strictObject({
          stage: boundedName,
          stage_attempt: z.number().int().positive(),
          effect_class: boundedName,
          started: z.boolean(),
          completed: z.boolean(),
        }),
      )
      .max(512),
    gate_receipts: z
      .array(
        z.strictObject({
          gate_id: boundedName,
          target: boundedName,
          outcome: boundedName,
          exit_code: z.number().int().nullable(),
          duration_ms: z.number().int().nonnegative(),
          tree_digest: sha256Digest,
          config_digest: sha256Digest,
          command_digest: sha256Digest,
          log_digest: sha256Digest.nullable(),
        }),
      )
      .max(512),
    error_digest: sha256Digest.nullable(),
  }),
  z.strictObject({
    event: z.literal("RUN_COMPLETED"),
    status: z.enum(["SUCCEEDED", "FAILED"]),
    commit_sha: z
      .string()
      .regex(/^[0-9a-f]{40}$/u)
      .nullable(),
    artifact_kinds: z.array(boundedName).max(512),
  }),
]);

export type EngineeringDebugEvent = z.infer<typeof debugEvent>;

type UsageTotals = {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  responsesWithoutUsage: number;
  responsesWithPartialUsage: number;
};

type JournalContext = {
  readonly journal: EngineeringDebugJournal;
  readonly state: {
    usage: UsageTotals;
    roundsUsed: number;
    callsUsed: number;
    roundLimit: number;
    callLimit: number;
    mutationReserved: number;
    mutationStarted: boolean;
    mutationSucceeded: boolean;
    sliceAttemptKey: string | null;
    completedStages: Set<string>;
    fastGates: "PENDING" | "PASSED" | "BLOCKED";
    fullGates: "PENDING" | "PASSED" | "BLOCKED";
  };
  readonly stage: string | null;
  readonly sliceId: string | null;
  readonly attempt: number | null;
  readonly modelCallBudget?: {
    readonly initialReserveTokens: number;
    readonly tailReserveTokens: number;
    callsStarted: number;
  };
};

const journalContext = new AsyncLocalStorage<JournalContext>();

type StoredEvent = EngineeringDebugEvent & {
  schema_version: 1;
  sequence: number;
  recorded_at: string;
};

export function engineeringDebugErrorDigest(error: unknown): string {
  return canonicalDigest({
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : "unknown",
  });
}

/** Select only a bounded structural error code; provider prose is never persisted. */
export function engineeringDebugErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  if (error instanceof z.ZodError) return "SCHEMA_VALIDATION_FAILED";
  const value = error as Record<string, unknown>;
  for (const key of ["outcome", "providerCode", "code"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)) {
      return candidate;
    }
  }
  if (error instanceof Error) {
    const codeOwned = new Map<string, string>([
      [
        "code-owned generator output cannot be a model-authored test path",
        "GENERATOR_OUTPUT_IN_TEST_PATH",
      ],
      [
        "model-facing slice has no editable path after generator outputs are removed",
        "NO_MODEL_EDITABLE_PATH",
      ],
      [
        "server-owned implementation context exceeds the code-owned discovery cap",
        "CORRECTION_CONTEXT_CAP_EXCEEDED",
      ],
    ]).get(error.message);
    if (codeOwned !== undefined) return codeOwned;
  }
  return null;
}

/** Select only the provider's bounded structural failure detail; never provider prose. */
export function engineeringDebugErrorDetailCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const candidate = (error as Record<string, unknown>)["detailCode"];
  return typeof candidate === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)
    ? candidate
    : null;
}

function safeName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 ? value : fallback;
}

function safeRelativePath(value: unknown): string | null {
  const parsed = relativePath.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function jsonObject(value: RuntimeJsonValue): Readonly<Record<string, RuntimeJsonValue>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requestedFiles(input: Readonly<Record<string, RuntimeJsonValue>>): string[] {
  const candidate = Array.isArray(input.files)
    ? input.files
    : Array.isArray(input.replacement_files)
      ? input.replacement_files
      : [];
  return candidate
    .slice(0, 64)
    .map((entry) => {
      const object =
        entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
      return safeRelativePath(object?.relative_path);
    })
    .filter((value): value is string => value !== null);
}

function toolBatchEvent(
  content: readonly RuntimeContent[],
): Extract<EngineeringDebugEvent, { event: "TOOL_BATCH" }> | null {
  const tools = content
    .filter(
      (item): item is Extract<RuntimeContent, { type: "tool-use" }> => item.type === "tool-use",
    )
    .slice(0, 64)
    .map((item) => {
      const input = jsonObject(item.input) ?? {};
      const query = typeof input.query === "string" ? input.query : null;
      return {
        name: safeName(item.name, "INVALID_TOOL_NAME"),
        relative_path: safeRelativePath(input.relative_path),
        query_digest: query === null ? null : canonicalDigest({ query }),
        files: requestedFiles(input),
        input_keys: Object.keys(input)
          .filter((key) => key.length >= 1 && key.length <= 128)
          .sort()
          .slice(0, 32),
      };
    });
  return tools.length === 0 ? null : { event: "TOOL_BATCH", tools };
}

function outputShapeEvents(content: readonly RuntimeContent[]): EngineeringDebugEvent[] {
  return content
    .filter((item): item is Extract<RuntimeContent, { type: "json" }> => item.type === "json")
    .slice(0, 16)
    .map((item) => {
      const object = jsonObject(item.value);
      const changed = object?.changed_files;
      const changedFiles = Array.isArray(changed)
        ? changed
            .slice(0, 512)
            .map((value) => safeRelativePath(value))
            .filter((value): value is string => value !== null)
        : null;
      const decision = z
        .enum(["PASS", "CHANGES_REQUIRED", "BLOCKED", "VERIFIED", "FAILED", "INCONCLUSIVE"])
        .safeParse(object?.decision);
      const criterionStatuses = Array.isArray(object?.criterion_outcomes)
        ? object.criterion_outcomes
            .slice(0, 256)
            .map((criterion) =>
              z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]).safeParse(jsonObject(criterion)?.status),
            )
            .filter((status) => status.success)
            .map((status) => status.data)
        : [];
      const reviewLinesExamined =
        typeof object?.lines_examined === "number" &&
        Number.isSafeInteger(object.lines_examined) &&
        object.lines_examined >= 0
          ? object.lines_examined
          : null;
      const reviewFindings = Array.isArray(object?.findings)
        ? object.findings
            .slice(0, 64)
            .map((finding) => {
              const value = jsonObject(finding);
              const locationValue = value?.location;
              const location = locationValue === undefined ? null : jsonObject(locationValue);
              const severity = z
                .enum(["BLOCKER", "HIGH", "MEDIUM", "LOW", "NIT"])
                .safeParse(value?.severity);
              const relativePathValue = safeRelativePath(location?.relative_path);
              const line = location?.line;
              return severity.success &&
                relativePathValue !== null &&
                typeof line === "number" &&
                Number.isSafeInteger(line) &&
                line > 0
                ? { severity: severity.data, relative_path: relativePathValue, line }
                : null;
            })
            .filter(
              (
                finding,
              ): finding is {
                severity: "BLOCKER" | "HIGH" | "MEDIUM" | "LOW" | "NIT";
                relative_path: string;
                line: number;
              } => finding !== null,
            )
        : [];
      return {
        event: "MODEL_OUTPUT_SHAPE" as const,
        keys:
          object === null
            ? []
            : Object.keys(object)
                .filter((key) => key.length >= 1 && key.length <= 128)
                .sort()
                .slice(0, 64),
        artifact_kind: safeName(object?.artifact_kind, "") || null,
        changed_files: changedFiles,
        decision: decision.success ? decision.data : null,
        criterion_statuses: criterionStatuses,
        review_lines_examined: reviewLinesExamined,
        review_findings: reviewFindings,
      };
    });
}

function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function addUsage(current: UsageTotals, usage: RuntimeUsage | undefined): UsageTotals {
  if (usage === undefined) {
    return {
      ...current,
      responses: current.responses + 1,
      responsesWithoutUsage: current.responsesWithoutUsage + 1,
    };
  }
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const reportedTotal = tokenCount(usage.totalTokens);
  const complete = inputTokens !== undefined && outputTokens !== undefined;
  return {
    responses: current.responses + 1,
    inputTokens: current.inputTokens + (inputTokens ?? 0),
    outputTokens: current.outputTokens + (outputTokens ?? 0),
    totalTokens:
      current.totalTokens + (reportedTotal ?? (complete ? inputTokens + outputTokens : 0)),
    responsesWithoutUsage: current.responsesWithoutUsage,
    responsesWithPartialUsage:
      current.responsesWithPartialUsage +
      (inputTokens === undefined || outputTokens === undefined || reportedTotal === undefined
        ? 1
        : 0),
  };
}

function usageComparison(totalTokens: number): "TARGET" | "WARNING" | "HARD_LIMIT" {
  if (totalTokens > ENGINEERING_MODEL_HARD_TOKEN_LIMIT) return "HARD_LIMIT";
  if (totalTokens > ENGINEERING_MODEL_WARNING_TOKEN_LIMIT) return "WARNING";
  return "TARGET";
}

const CHECKLIST = Object.freeze([
  "DISCOVERY",
  "DESIGN",
  "SLICE",
  "TEST_FIRST",
  "IMPLEMENTATION",
  "FAST_GATES",
  "FULL_GATES",
  "REVIEW",
  "COMMIT",
] as const);

function checklistStage(item: (typeof CHECKLIST)[number]): string | null {
  switch (item) {
    case "DISCOVERY":
      return "DISCOVERY";
    case "DESIGN":
      return "PROGRAM_DESIGN";
    case "SLICE":
      return "SLICE_PLANNING";
    case "IMPLEMENTATION":
      return "SLICE_IMPLEMENTATION";
    case "REVIEW":
      return "SLICE_REVIEW";
    case "COMMIT":
      return "LOCAL_COMMIT";
    default:
      return null;
  }
}

function stageScopeKey(stage: string, sliceId: string | null, attempt: number | null): string {
  return canonicalDigest({ stage, slice_id: sliceId, attempt });
}

function progressStatus(
  context: JournalContext,
  item: (typeof CHECKLIST)[number],
): "PENDING" | "IN_PROGRESS" | "COMPLETE" | "BLOCKED" {
  if (item === "TEST_FIRST") return context.state.mutationSucceeded ? "COMPLETE" : "PENDING";
  if (item === "FAST_GATES") {
    return context.state.fastGates === "PASSED"
      ? "COMPLETE"
      : context.state.fastGates === "BLOCKED"
        ? "BLOCKED"
        : "PENDING";
  }
  if (item === "FULL_GATES") {
    return context.state.fullGates === "PASSED"
      ? "COMPLETE"
      : context.state.fullGates === "BLOCKED"
        ? "BLOCKED"
        : "PENDING";
  }
  const stage = checklistStage(item);
  if (stage === null) return "PENDING";
  if (
    context.state.completedStages.has(stageScopeKey(stage, context.sliceId, context.attempt)) ||
    context.state.completedStages.has(stageScopeKey(stage, null, null))
  )
    return "COMPLETE";
  return context.stage === stage ? "IN_PROGRESS" : "PENDING";
}

function progressEvent(
  context: JournalContext,
  decisionCode: EngineeringDebugDecisionCode,
): EngineeringDebugEvent {
  const state = context.state;
  return {
    event: "PROGRESS_SNAPSHOT",
    stage: context.stage,
    slice_id: context.sliceId,
    attempt: context.attempt,
    decision_code: decisionCode,
    checklist: CHECKLIST.map((item) => ({ item, status: progressStatus(context, item) })),
    rounds: {
      used: state.roundsUsed,
      limit: state.roundLimit,
      mutation_reserved: state.mutationStarted ? 0 : state.mutationReserved,
      remaining: Math.max(0, state.roundLimit - state.roundsUsed),
    },
    calls: {
      used: state.callsUsed,
      limit: state.callLimit,
      remaining: Math.max(0, state.callLimit - state.callsUsed),
    },
    tokens: {
      used: state.usage.totalTokens,
      target: ENGINEERING_MODEL_TARGET_TOKEN_LIMIT,
      warning: ENGINEERING_MODEL_WARNING_TOKEN_LIMIT,
      hard_limit: ENGINEERING_MODEL_HARD_TOKEN_LIMIT,
      final_call_reserved: engineeringModelCallTokenReserve(
        undefined,
        context.modelCallBudget === undefined
          ? undefined
          : context.modelCallBudget.callsStarted === 0
            ? context.modelCallBudget.initialReserveTokens
            : context.modelCallBudget.tailReserveTokens,
      ),
      remaining_to_target: Math.max(
        0,
        ENGINEERING_MODEL_TARGET_TOKEN_LIMIT - state.usage.totalTokens,
      ),
      remaining_to_hard_limit: Math.max(
        0,
        ENGINEERING_MODEL_HARD_TOKEN_LIMIT - state.usage.totalTokens,
      ),
    },
    gates: {
      fast:
        state.fastGates === "PASSED"
          ? "COMPLETE"
          : state.fastGates === "BLOCKED"
            ? "BLOCKED"
            : "PENDING",
      full:
        state.fullGates === "PASSED"
          ? "COMPLETE"
          : state.fullGates === "BLOCKED"
            ? "BLOCKED"
            : "PENDING",
    },
  };
}

function capturedDecisionAppend(
  context: JournalContext,
  decisionCode: EngineeringDebugDecisionCode,
): () => Promise<void> {
  // Capture both records from one exact in-memory boundary. A later tool result may update the
  // shared invocation state while the first append is waiting on disk; computing progress only
  // after that await would let an earlier decision claim future progress.
  const decision: EngineeringDebugEvent = {
    event: "DECISION",
    stage: context.stage,
    slice_id: context.sliceId,
    attempt: context.attempt,
    decision_code: decisionCode,
    structural_digest: canonicalDigest({
      stage: context.stage,
      slice_id: context.sliceId,
      attempt: context.attempt,
      decision_code: decisionCode,
      rounds_used: context.state.roundsUsed,
      calls_used: context.state.callsUsed,
      tokens_used: context.state.usage.totalTokens,
    }),
  };
  const progress = progressEvent(context, decisionCode);
  return async () => {
    await context.journal.append(decision);
    await context.journal.append(progress);
  };
}

async function appendDecision(
  context: JournalContext,
  decisionCode: EngineeringDebugDecisionCode,
): Promise<void> {
  await capturedDecisionAppend(context, decisionCode)();
}

/** Refuse a new provider call when its role-specific conservative reserve crosses the hard ceiling. */
export function assertEngineeringModelCallBudget(
  totalTokens: number,
  role?: SubscriptionModelRole | null,
  reserveOverride?: number,
): void {
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    throw new Error("Engineering model token total is invalid");
  }
  if (
    reserveOverride !== undefined &&
    (!Number.isSafeInteger(reserveOverride) || reserveOverride <= 0)
  ) {
    throw new Error("Engineering model call token reserve is invalid");
  }
  const reserveTokens = engineeringModelCallTokenReserve(role, reserveOverride);
  if (totalTokens > ENGINEERING_MODEL_HARD_TOKEN_LIMIT - reserveTokens) {
    throw new EngineeringModelBudgetError(reserveTokens);
  }
}

/**
 * Refuse a model-backed mutating stage before its durable STARTED event. The transport repeats the
 * same check immediately before dispatch, but that later boundary is too late to keep an exhausted
 * SLICE_IMPLEMENTATION operation retry-safe.
 */
export async function assertEngineeringModelCallBudgetBeforeStage(
  reserveTokens = ENGINEERING_MODEL_CALL_TOKEN_RESERVE,
): Promise<void> {
  const context = journalContext.getStore();
  if (context === undefined) return;
  try {
    assertEngineeringModelCallBudget(context.state.usage.totalTokens, undefined, reserveTokens);
  } catch (error) {
    await appendDecision(context, "MODEL_CALL_REFUSED_BUDGET").catch(() => undefined);
    throw error;
  }
}

/**
 * Use a smaller, still conservative tail only for a server-proven receipt-backed correction.
 * The first call keeps enough runway for the prefetched diagnostic/checklist context; after its
 * first exact tool pair the runtime rotates to the compact epoch and needs only the tail reserve.
 */
export function runWithEngineeringCorrectionModelCallBudget<T>(work: () => Promise<T>): Promise<T> {
  const context = journalContext.getStore();
  if (context === undefined) return work();
  return journalContext.run(
    {
      ...context,
      modelCallBudget: {
        initialReserveTokens: ENGINEERING_CORRECTION_INITIAL_MODEL_CALL_TOKEN_RESERVE,
        tailReserveTokens: ENGINEERING_CORRECTION_TAIL_MODEL_CALL_TOKEN_RESERVE,
        callsStarted: 0,
      },
    },
    work,
  );
}

/** Scope all async model/tool callbacks to the journal of exactly one leased invocation. */
export function runWithEngineeringDebugJournal<T>(
  journal: EngineeringDebugJournal,
  work: () => Promise<T>,
): Promise<T> {
  return journalContext.run(
    {
      journal,
      state: {
        usage: {
          responses: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          responsesWithoutUsage: 0,
          responsesWithPartialUsage: 0,
        },
        roundsUsed: 0,
        callsUsed: 0,
        roundLimit: 0,
        callLimit: 0,
        mutationReserved: 0,
        mutationStarted: false,
        mutationSucceeded: false,
        sliceAttemptKey: null,
        completedStages: new Set<string>(),
        fastGates: "PENDING",
        fullGates: "PENDING",
      },
      stage: "ENGINEERING_INVOCATION",
      sliceId: null,
      attempt: null,
    },
    work,
  );
}

/** Attribute provider usage to the exact server-selected stage without exposing prompt text. */
export function runWithEngineeringDebugStage<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const context = journalContext.getStore();
  if (context === undefined) return work();
  const scoped = { ...context, stage: safeName(stage, "INVALID_STAGE") };
  return journalContext.run(scoped, async () => {
    await appendDecision(scoped, "STAGE_ENTERED").catch(() => undefined);
    try {
      const result = await work();
      scoped.state.completedStages.add(
        stageScopeKey(scoped.stage ?? "INVALID_STAGE", scoped.sliceId, scoped.attempt),
      );
      await appendDecision(scoped, "STAGE_COMPLETED").catch(() => undefined);
      return result;
    } catch (error) {
      await appendDecision(scoped, "STAGE_FAILED").catch(() => undefined);
      throw error;
    }
  });
}

/** Add exact slice identity to structural progress without persisting task prose. */
export function runWithEngineeringDebugSlice<T>(
  stage: string,
  sliceId: string,
  attempt: number,
  work: () => Promise<T>,
): Promise<T> {
  const context = journalContext.getStore();
  if (context === undefined) return work();
  const parsedSliceId = id.parse(sliceId);
  const parsedAttempt = z.number().int().positive().parse(attempt);
  const sliceAttemptKey = canonicalDigest({ slice_id: parsedSliceId, attempt: parsedAttempt });
  if (context.state.sliceAttemptKey !== sliceAttemptKey) {
    context.state.sliceAttemptKey = sliceAttemptKey;
    context.state.roundsUsed = 0;
    context.state.callsUsed = 0;
    context.state.roundLimit = 0;
    context.state.callLimit = 0;
    context.state.mutationReserved = 0;
    context.state.mutationStarted = false;
    context.state.mutationSucceeded = false;
    context.state.fastGates = "PENDING";
    context.state.fullGates = "PENDING";
  }
  return journalContext.run({ ...context, sliceId: parsedSliceId, attempt: parsedAttempt }, () =>
    runWithEngineeringDebugStage(stage, work),
  );
}

/** Record that durable successful mutation receipts replaced a redundant model final report. */
export async function recordEngineeringDebugReceiptFinalization(): Promise<void> {
  const context = journalContext.getStore();
  if (context === undefined) return;
  await appendDecision(context, "IMPLEMENTATION_RECEIPT_FINALIZED");
}

export type EngineeringDebugModelAttribution = Readonly<{
  role: SubscriptionModelRole;
  invocation: SubscriptionModelInvocationDescriptorV1;
}>;

function runtimeUsageFromError(error: unknown): RuntimeUsage | undefined {
  if (error === null || typeof error !== "object" || !("usage" in error)) return undefined;
  const candidate = error.usage;
  if (candidate === null || typeof candidate !== "object") return undefined;
  const value = candidate as Record<string, unknown>;
  const inputTokens = tokenCount(
    typeof value.inputTokens === "number" ? value.inputTokens : undefined,
  );
  const outputTokens = tokenCount(
    typeof value.outputTokens === "number" ? value.outputTokens : undefined,
  );
  const totalTokens = tokenCount(
    typeof value.totalTokens === "number" ? value.totalTokens : undefined,
  );
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  });
}

async function recordModelUsage(input: {
  context: JournalContext;
  attribution: EngineeringDebugModelAttribution | null;
  usage: RuntimeUsage | undefined;
}): Promise<"TARGET" | "WARNING" | "HARD_LIMIT"> {
  input.context.state.usage = addUsage(input.context.state.usage, input.usage);
  const totals = input.context.state.usage;
  const comparison = usageComparison(totals.totalTokens);
  const responseInputTokens = tokenCount(input.usage?.inputTokens);
  const responseOutputTokens = tokenCount(input.usage?.outputTokens);
  const responseReportedTotal = tokenCount(input.usage?.totalTokens);
  const responseTotalTokens =
    responseReportedTotal ??
    (responseInputTokens !== undefined && responseOutputTokens !== undefined
      ? responseInputTokens + responseOutputTokens
      : undefined);
  await input.context.journal
    .append({
      event: "MODEL_USAGE",
      stage: input.context.stage,
      role: input.attribution?.role ?? null,
      slice_id: input.context.sliceId,
      attempt: input.context.attempt,
      invocation_digest:
        input.attribution === null ? null : canonicalDigest(input.attribution.invocation),
      provider: input.attribution?.invocation.provider ?? null,
      profile_name: input.attribution?.invocation.profile_name ?? null,
      model: input.attribution?.invocation.model ?? null,
      client_version: input.attribution?.invocation.client_version ?? null,
      response_input_tokens: responseInputTokens ?? null,
      response_output_tokens: responseOutputTokens ?? null,
      response_total_tokens: responseTotalTokens ?? null,
      provider_reported: input.usage !== undefined,
      responses: totals.responses,
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      total_tokens: totals.totalTokens,
      responses_without_usage: totals.responsesWithoutUsage,
      responses_with_partial_usage: totals.responsesWithPartialUsage,
      comparison,
    })
    .catch(() => undefined);
  return comparison;
}

/** Instrument the shared transport without leaking one concurrent run into another journal. */
export function createEngineeringDebugTransport(
  delegate: RuntimeTransport,
  rawAttribution?: EngineeringDebugModelAttribution,
): RuntimeTransport {
  const attribution =
    rawAttribution === undefined
      ? null
      : Object.freeze({
          role: subscriptionModelRole.parse(rawAttribution.role),
          invocation: subscriptionModelInvocationDescriptorV1.parse(rawAttribution.invocation),
        });
  if (attribution !== null && attribution.invocation.role !== attribution.role) {
    throw new Error("Engineering debug attribution role does not match invocation");
  }
  return {
    async converse(request, config) {
      const context = journalContext.getStore();
      if (context !== undefined) {
        context.state.roundLimit = config.toolLimits.maxIterations;
        context.state.callLimit = config.toolLimits.maxCalls;
        context.state.mutationReserved = config.toolLoopPolicy?.mutationIterationsReserved ?? 0;
        try {
          const reserveOverride =
            context.modelCallBudget === undefined
              ? undefined
              : context.modelCallBudget.callsStarted === 0
                ? context.modelCallBudget.initialReserveTokens
                : context.modelCallBudget.tailReserveTokens;
          assertEngineeringModelCallBudget(
            context.state.usage.totalTokens,
            attribution?.role,
            reserveOverride,
          );
          await appendDecision(context, "MODEL_CALL_RESERVED").catch(() => undefined);
        } catch (error) {
          await appendDecision(context, "MODEL_CALL_REFUSED_BUDGET").catch(() => undefined);
          throw error;
        }
        if (context.modelCallBudget !== undefined) context.modelCallBudget.callsStarted += 1;
      }
      let response: Awaited<ReturnType<RuntimeTransport["converse"]>>;
      try {
        response = await delegate.converse(request, config);
      } catch (error) {
        if (context !== undefined) {
          await recordModelUsage({
            context,
            attribution,
            usage: runtimeUsageFromError(error),
          });
          await context.journal
            .append({
              event: "MODEL_ATTEMPT_ERROR",
              stage: context.stage,
              role: attribution?.role ?? null,
              slice_id: context.sliceId,
              attempt: context.attempt,
              provider: attribution?.invocation.provider ?? null,
              profile_name: attribution?.invocation.profile_name ?? null,
              model: attribution?.invocation.model ?? null,
              error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
              error_code: engineeringDebugErrorCode(error),
              error_detail_code: engineeringDebugErrorDetailCode(error),
              retryable:
                error !== null &&
                typeof error === "object" &&
                "retryable" in error &&
                error.retryable === true,
              error_digest: engineeringDebugErrorDigest(error),
            })
            .catch(() => undefined);
        }
        throw error;
      }
      if (context === undefined) return response;
      const comparison = await recordModelUsage({ context, attribution, usage: response.usage });
      try {
        const batch = toolBatchEvent(response.content);
        if (batch !== null) {
          await context.journal.append({
            ...batch,
            stage: context.stage,
            slice_id: context.sliceId,
            attempt: context.attempt,
          });
          context.state.roundsUsed += 1;
          context.state.callsUsed += batch.tools.length;
          const mutation = batch.tools.some((tool) =>
            ["write", "patch", "mkdir"].includes(tool.name),
          );
          if (mutation) context.state.mutationStarted = true;
          await appendDecision(
            context,
            mutation ? "MUTATION_BATCH_REQUESTED" : "DISCOVERY_BATCH_REQUESTED",
          );
        }
        for (const event of outputShapeEvents(response.content))
          await context.journal.append(event);
        await appendDecision(context, "MODEL_RESPONSE_RECORDED");
      } catch {
        // A diagnostic write failure after a provider response cannot change stage semantics or
        // turn an otherwise recoverable model result into an unknown external effect.
      }
      if (comparison === "HARD_LIMIT") {
        throw new Error(
          `Engineering model usage exceeded the ${String(ENGINEERING_MODEL_HARD_TOKEN_LIMIT)}-token hard limit`,
        );
      }
      return response;
    },
  };
}

/** Extract only content-free exact-replacement coordinates; repository bytes never leave output. */
export function engineeringDebugReplacementRepairDiagnostic(
  result: ImplementationToolResult,
): z.infer<typeof replacementRepairDiagnostic> | null {
  if (
    result.outcome !== "FAILED" ||
    result.failure_code !== "REPLACEMENT_MISMATCH" ||
    result.output.truncated ||
    result.output.value.length > 131_072
  ) {
    return null;
  }
  try {
    const envelope = JSON.parse(result.output.value) as unknown;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return null;
    const repair = Reflect.get(envelope, "repair_context") as unknown;
    if (typeof repair !== "object" || repair === null || Array.isArray(repair)) return null;
    const candidate = replacementRepairDiagnostic.safeParse({
      relative_path: Reflect.get(repair, "relative_path"),
      replacement_index: Reflect.get(repair, "replacement_index"),
      expected_old_content_digest: Reflect.get(repair, "expected_old_content_digest"),
      current_excerpt_digest: Reflect.get(repair, "current_excerpt_digest"),
      current_excerpt_complete: Reflect.get(repair, "current_excerpt_complete"),
    });
    return candidate.success ? candidate.data : null;
  } catch {
    // Malformed untrusted tool text is not diagnostic authority and is omitted.
    return null;
  }
}

/** Record only the strict structural result; output.value is intentionally never journaled. */
export function recordEngineeringDebugToolResult(result: ImplementationToolResult): void {
  const context = journalContext.getStore();
  if (context === undefined) return;
  const parsed = implementationToolResult.parse(result);
  const repairContext = engineeringDebugReplacementRepairDiagnostic(parsed);
  if (
    parsed.outcome === "SUCCEEDED" &&
    (parsed.kind === "WRITE_FILE" || parsed.kind === "APPLY_PATCH")
  ) {
    context.state.mutationStarted = true;
    context.state.mutationSucceeded = true;
  }
  const appendResultDecision = capturedDecisionAppend(context, "MUTATION_RESULT_RECORDED");
  void context.journal
    .append({
      event: "TOOL_RESULT",
      stage: context.stage,
      slice_id: context.sliceId,
      attempt: context.attempt,
      kind: parsed.kind,
      outcome: parsed.outcome,
      failure_code: parsed.outcome === "FAILED" ? parsed.failure_code : null,
      changed_files: [...parsed.changed_files],
      operation_id_digest: canonicalDigest({ operation_id: parsed.operation_id }),
      output_truncated: parsed.output.truncated,
      ...(repairContext === null ? {} : { repair_context: repairContext }),
    })
    .then(appendResultDecision)
    .catch(() => undefined);
}

/** Record only bounded schema coordinates for a refused model-proposed tool input. */
export async function recordEngineeringDebugToolInputRefusal(
  toolName: string,
  error: ToolInputError,
): Promise<void> {
  const context = journalContext.getStore();
  if (context === undefined) return;
  const safeSegment = (value: string, fallback: string) => {
    const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64);
    return normalized.length === 0 ? fallback : normalized;
  };
  const issues = error.issues.slice(0, 8).map((issue) => ({
    code: safeSegment(issue.code, "invalid"),
    path: issue.path.slice(0, 8).map((part) => safeSegment(part, "FIELD")),
  }));
  if (issues.length === 0) issues.push({ code: "invalid", path: [] });
  await context.journal
    .append({
      event: "TOOL_INPUT_REFUSAL",
      stage: context.stage,
      slice_id: context.sliceId,
      attempt: context.attempt,
      tool_name: safeSegment(toolName, "UNKNOWN_TOOL"),
      failure_code: "TOOL_INPUT_INVALID",
      issues,
    })
    .catch(() => undefined);
}

/** Record a bounded gate decision; receipt/log bytes remain in their durable stores. */
export function recordEngineeringDebugGateProgress(input: {
  tier: "FAST" | "FULL";
  status: "PASSED" | "BLOCKED";
}): Promise<void> {
  const context = journalContext.getStore();
  if (context === undefined) return Promise.resolve();
  if (input.tier === "FAST") context.state.fastGates = input.status;
  else context.state.fullGates = input.status;
  const code = `${input.tier}_GATES_${input.status}` as EngineeringDebugDecisionCode;
  return appendDecision(context, code).catch(() => undefined);
}

/** Record a platform/disposable gate failure without persisting its path-bearing message. */
export function recordEngineeringDebugGateBoundaryError(input: {
  gate_id: string;
  target: string;
  phase: string;
  error: unknown;
}): void {
  const context = journalContext.getStore();
  if (context === undefined) return;
  const protectedChanges =
    typeof input.error === "object" &&
    input.error !== null &&
    "protectedChanges" in input.error &&
    Array.isArray(input.error.protectedChanges)
      ? input.error.protectedChanges.slice(0, 128).flatMap((candidate) => {
          if (candidate === null || typeof candidate !== "object") return [];
          const path = "path" in candidate ? safeRelativePath(candidate.path) : null;
          const change = "change" in candidate ? candidate.change : null;
          return path !== null &&
            (change === "ADDED" || change === "REMOVED" || change === "MODIFIED")
            ? [{ relative_path: path, change }]
            : [];
        })
      : [];
  void context.journal
    .append({
      event: "GATE_BOUNDARY_ERROR",
      gate_id: safeName(input.gate_id, "INVALID_GATE_ID"),
      target: safeName(input.target, "INVALID_GATE_TARGET"),
      phase: safeName(input.phase, "INVALID_GATE_PHASE"),
      error_name: safeName(
        input.error instanceof Error ? input.error.name : undefined,
        "UnknownError",
      ),
      error_code:
        typeof input.error === "object" &&
        input.error !== null &&
        "code" in input.error &&
        typeof input.error.code === "string"
          ? safeName(input.error.code, "INVALID_ERROR_CODE")
          : null,
      protected_changes: protectedChanges,
      error_digest: engineeringDebugErrorDigest(input.error),
    })
    .catch(() => undefined);
}

export interface EngineeringInvocationJournalRunner {
  run<T>(lease: JobLease, work: () => Promise<T>): Promise<T>;
}

type ArtifactDiagnosticRow = {
  artifact_kind: string;
  stage: string;
  stage_attempt: number;
  commit_sha: string | null;
  review_decision: string | null;
  verification_decision: string | null;
};

export type EngineeringCompilerDiagnosticJournalRow = {
  gate_id: string;
  stage_attempt: number;
  path: string;
  line: number;
  column: number;
  message_digest: string;
  diagnostic_digest: string;
};

export type EngineeringXcodeTestDiagnosticJournalRow = {
  gate_id: string;
  stage_attempt: number;
  test_name: string;
  path: string | null;
  line: number | null;
  message_digest: string;
  diagnostic_digest: string;
};

type CompilerArtifactRow = {
  stage_attempt: number;
  payload: unknown;
};

/**
 * Project durable GateFailure artifacts into the same content-free compiler chain used by every
 * invocation summary. Live qualification and the production handler share this helper so a
 * failed live run cannot silently replace real diagnostics with an empty test-only placeholder.
 */
export function engineeringCompilerDiagnosticJournalRows(
  rows: readonly CompilerArtifactRow[],
): readonly EngineeringCompilerDiagnosticJournalRow[] {
  return Object.freeze(
    rows.flatMap((row): EngineeringCompilerDiagnosticJournalRow[] => {
      const artifact = engineeringArtifact.parse(row.payload);
      if (artifact.artifact_kind !== "GateFailure") {
        throw new Error("compiler diagnostic query returned a non-gate artifact");
      }
      return artifact.diagnostics.flatMap((diagnostic) => {
        const structured = diagnostic.compiler_diagnostics ?? [];
        const compilers =
          structured.length > 0 ? structured : parseXcodeCompilerDiagnostics(diagnostic.excerpt);
        return compilers.map((compiler) => ({
          gate_id: diagnostic.gate_id,
          stage_attempt: row.stage_attempt,
          path: compiler.path,
          line: compiler.line,
          column: compiler.column,
          message_digest: canonicalDigest(compiler.message),
          diagnostic_digest: compiler.digest,
        }));
      });
    }),
  );
}

/** Content-free durable XCTest failure chain for the per-invocation journal and summary. */
export function engineeringXcodeTestDiagnosticJournalRows(
  rows: readonly CompilerArtifactRow[],
): readonly EngineeringXcodeTestDiagnosticJournalRow[] {
  return Object.freeze(
    rows.flatMap((row): EngineeringXcodeTestDiagnosticJournalRow[] => {
      const artifact = engineeringArtifact.parse(row.payload);
      if (artifact.artifact_kind !== "GateFailure") {
        throw new Error("Xcode test diagnostic query returned a non-gate artifact");
      }
      return artifact.diagnostics.flatMap((diagnostic) => {
        const structured = diagnostic.test_diagnostics ?? [];
        const tests =
          structured.length > 0 ? structured : parseXcodeTestDiagnostics(diagnostic.excerpt);
        return tests.map((test) => ({
          gate_id: diagnostic.gate_id,
          stage_attempt: row.stage_attempt,
          test_name: test.test_name,
          path: test.path,
          line: test.line,
          message_digest: canonicalDigest(test.message),
          diagnostic_digest: test.digest,
        }));
      });
    }),
  );
}

type OperationDiagnosticRow = {
  stage: string;
  stage_attempt: number;
  effect_class: string;
  started: boolean;
  completed: boolean;
};

type GateDiagnosticRow = {
  gate_id: string;
  target: string;
  outcome: string;
  exit_code: number | null;
  duration_ms: number;
  tree_digest: string;
  config_digest: string;
  command_digest: string;
  log_digest: string | null;
};

/** Production invocation boundary: one unique file from handler entry through terminal state. */
export function createEngineeringInvocationJournalRunner(input: {
  artifactRoot: string;
  db: Database;
  model: string;
  configDigest: string;
  logger: StructuredLogger;
}): EngineeringInvocationJournalRunner {
  const parsedConfigDigest = sha256Digest.parse(input.configDigest);
  return {
    async run<T>(lease: JobLease, work: () => Promise<T>): Promise<T> {
      const caseId = lease.caseId;
      const runId = lease.payload.runId;
      if (
        caseId === null ||
        lease.payload.caseId !== caseId ||
        typeof runId !== "string" ||
        runId.length === 0
      ) {
        throw new Error("Engineering invocation lacks an exact case/run binding");
      }
      const journal = await EngineeringDebugJournal.create({
        artifactRoot: input.artifactRoot,
        invocationId: `${lease.jobId}:${String(lease.fencingToken)}:${String(lease.attempts)}:${randomUUID()}`,
      });
      input.logger.info("engineering debug journal created", {
        job_id: lease.jobId,
        case_id: caseId,
        file_name: journal.fileName,
      });
      let failure: unknown;
      try {
        return await runWithEngineeringDebugJournal(journal, async () => {
          await journal.append({
            event: "RUN_STARTED",
            case_id: caseId,
            run_id: runId,
            model: safeName(input.model, "UNKNOWN_MODEL"),
            base_sha: null,
            config_digest: parsedConfigDigest,
          });
          try {
            return await work();
          } catch (error) {
            failure = error;
            await journal
              .append({
                event: "STAGE_ERROR",
                stage: "ENGINEERING_INVOCATION",
                error_name: safeName(
                  error instanceof Error ? error.name : undefined,
                  "UnknownError",
                ),
                error_code: engineeringDebugErrorCode(error),
                error_detail_code: engineeringDebugErrorDetailCode(error),
                error_digest: engineeringDebugErrorDigest(error),
              })
              .catch(() => undefined);
            throw error;
          }
        });
      } finally {
        try {
          const [artifacts, operations, gateReceipts, gateFailureDiagnostics] = await Promise.all([
            input.db.query<ArtifactDiagnosticRow>(
              `SELECT artifact_kind, stage, stage_attempt,
                      CASE WHEN artifact_kind = 'LocalCommitReceipt'
                           THEN payload->>'commit_sha' ELSE NULL END AS commit_sha,
                      CASE WHEN artifact_kind = 'ReviewDecision'
                           THEN payload->>'decision' ELSE NULL END AS review_decision,
                      CASE WHEN artifact_kind = 'VerificationDecision'
                           THEN payload->>'decision' ELSE NULL END AS verification_decision
                 FROM engineering_artifact_revisions
                WHERE run_id = $1
                ORDER BY revision`,
              [runId],
            ),
            input.db.query<OperationDiagnosticRow>(
              `SELECT o.stage, o.stage_attempt, o.effect_class,
                      EXISTS (
                        SELECT 1 FROM engineering_stage_events e
                         WHERE e.operation_id = o.operation_id AND e.event_type = 'STARTED'
                      ) AS started,
                      EXISTS (
                        SELECT 1 FROM job_completions c WHERE c.intent_id = o.intent_id
                      ) AS completed
                 FROM engineering_operations o
                WHERE o.run_id = $1
                ORDER BY o.recorded_at, o.operation_id`,
              [runId],
            ),
            input.db.query<GateDiagnosticRow>(
              `SELECT c.receipt->>'gate_id' AS gate_id,
                      c.receipt->>'target' AS target,
                      c.receipt->>'outcome' AS outcome,
                      (c.receipt->>'exit_code')::integer AS exit_code,
                      (c.receipt->>'duration_ms')::integer AS duration_ms,
                      c.receipt->>'tree_digest' AS tree_digest,
                      c.receipt->>'config_digest' AS config_digest,
                      c.receipt->>'command_digest' AS command_digest,
                      c.receipt->>'log_digest' AS log_digest
                 FROM job_completions c
                 JOIN job_intents i ON i.intent_id = c.intent_id
                 JOIN engineering_operations o ON o.intent_id = i.intent_id
                WHERE o.run_id = $1
                  AND i.kind = 'engineering.verification.gate'
                ORDER BY c.recorded_at, c.completion_id`,
              [runId],
            ),
            input.db
              .query<CompilerArtifactRow>(
                `SELECT stage_attempt, payload
                   FROM engineering_artifact_revisions
                  WHERE run_id = $1
                    AND artifact_kind = 'GateFailure'
                  ORDER BY revision`,
                [runId],
              )
              .then((result) => ({
                rows: {
                  compiler: engineeringCompilerDiagnosticJournalRows(result.rows),
                  tests: engineeringXcodeTestDiagnosticJournalRows(result.rows),
                },
              })),
          ]);
          await journal.append({
            event: "RUN_DIAGNOSTIC",
            artifacts: artifacts.rows.map((row) => ({
              artifact_kind: safeName(row.artifact_kind, "INVALID_ARTIFACT_KIND"),
              stage: safeName(row.stage, "INVALID_STAGE"),
              stage_attempt: row.stage_attempt,
              review_decision:
                row.review_decision === "PASS" ||
                row.review_decision === "CHANGES_REQUIRED" ||
                row.review_decision === "BLOCKED"
                  ? row.review_decision
                  : null,
              verification_decision:
                row.verification_decision === "VERIFIED" ||
                row.verification_decision === "FAILED" ||
                row.verification_decision === "INCONCLUSIVE"
                  ? row.verification_decision
                  : null,
            })),
            operations: operations.rows.map((row) => ({
              stage: safeName(row.stage, "INVALID_STAGE"),
              stage_attempt: row.stage_attempt,
              effect_class: safeName(row.effect_class, "INVALID_EFFECT_CLASS"),
              started: row.started,
              completed: row.completed,
            })),
            gate_receipts: gateReceipts.rows.map((row) => ({
              gate_id: safeName(row.gate_id, "INVALID_GATE_ID"),
              target: safeName(row.target, "INVALID_GATE_TARGET"),
              outcome: safeName(row.outcome, "INVALID_GATE_OUTCOME"),
              exit_code: row.exit_code,
              duration_ms: row.duration_ms,
              tree_digest: row.tree_digest,
              config_digest: row.config_digest,
              command_digest: row.command_digest,
              log_digest: row.log_digest,
            })),
            compiler_diagnostics: gateFailureDiagnostics.rows.compiler.map((row) => ({
              gate_id: safeName(row.gate_id, "INVALID_GATE_ID"),
              stage_attempt: row.stage_attempt,
              path: relativePath.parse(row.path),
              line: row.line,
              column: row.column,
              message_digest: row.message_digest,
              diagnostic_digest: row.diagnostic_digest,
            })),
            test_diagnostics: gateFailureDiagnostics.rows.tests.map((row) => ({
              gate_id: safeName(row.gate_id, "INVALID_GATE_ID"),
              stage_attempt: row.stage_attempt,
              test_name: row.test_name,
              path: row.path === null ? null : relativePath.parse(row.path),
              line: row.line,
              message_digest: row.message_digest,
              diagnostic_digest: row.diagnostic_digest,
            })),
            error_digest: failure === undefined ? null : engineeringDebugErrorDigest(failure),
          });
          const commitSha =
            artifacts.rows.find((row) => row.commit_sha !== null)?.commit_sha ?? null;
          await journal.append({
            event: "RUN_COMPLETED",
            status: failure === undefined ? "SUCCEEDED" : "FAILED",
            commit_sha: commitSha,
            artifact_kinds: artifacts.rows.map((row) =>
              safeName(row.artifact_kind, "INVALID_ARTIFACT_KIND"),
            ),
          });
        } catch (error) {
          await journal
            .append({
              event: "STAGE_ERROR",
              stage: "RUN_DIAGNOSTIC",
              error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
              error_code: engineeringDebugErrorCode(error),
              error_detail_code: engineeringDebugErrorDetailCode(error),
              error_digest: engineeringDebugErrorDigest(error),
            })
            .catch(() => undefined);
          await journal
            .append({
              event: "RUN_COMPLETED",
              status: failure === undefined ? "SUCCEEDED" : "FAILED",
              commit_sha: null,
              artifact_kinds: [],
            })
            .catch(() => undefined);
          input.logger.warn("engineering debug journal final diagnostic failed", {
            job_id: lease.jobId,
            case_id: caseId,
            error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
          });
        } finally {
          await journal.close().catch((error: unknown) => {
            input.logger.warn("engineering debug journal close failed", {
              job_id: lease.jobId,
              case_id: caseId,
              error_name: safeName(error instanceof Error ? error.name : undefined, "UnknownError"),
            });
          });
        }
      }
    },
  };
}

function markdownCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value)
    .replace(/\|/gu, "\\|")
    .replace(/[\r\n]+/gu, " ")
    .slice(0, 512);
}

/** Render only the already-validated, content-free journal projection. */
function renderEngineeringDebugSummary(events: readonly StoredEvent[]): string {
  const started = events.find((event) => event.event === "RUN_STARTED");
  const completed = [...events].reverse().find((event) => event.event === "RUN_COMPLETED");
  const diagnostic = [...events].reverse().find((event) => event.event === "RUN_DIAGNOSTIC");
  const usageEvents = events.filter((event) => event.event === "MODEL_USAGE");
  const attemptErrors = events.filter(
    (event): event is Extract<StoredEvent, { event: "MODEL_ATTEMPT_ERROR" }> =>
      event.event === "MODEL_ATTEMPT_ERROR",
  );
  const stageErrors = events.filter(
    (event): event is Extract<StoredEvent, { event: "STAGE_ERROR" }> =>
      event.event === "STAGE_ERROR",
  );
  const toolEvents = events
    .filter(
      (event): event is Extract<StoredEvent, { event: "TOOL_RESULT" }> =>
        event.event === "TOOL_RESULT",
    )
    .filter((event) => event.outcome !== "SUCCEEDED");
  const toolInputRefusals = events.filter(
    (event): event is Extract<StoredEvent, { event: "TOOL_INPUT_REFUSAL" }> =>
      event.event === "TOOL_INPUT_REFUSAL",
  );
  const roundByScope = new Map<string, number>();
  const usageRows = usageEvents.map((event) => {
    const scope = canonicalDigest({
      role: event.role ?? null,
      stage: event.stage,
      slice_id: event.slice_id ?? null,
      attempt: event.attempt ?? null,
    });
    const round = (roundByScope.get(scope) ?? 0) + 1;
    roundByScope.set(scope, round);
    return `| ${markdownCell(event.role)} | ${markdownCell(event.stage)} | ${markdownCell(event.slice_id)} | ${markdownCell(event.attempt)} | ${String(round)} | ${markdownCell(event.response_input_tokens)} | ${markdownCell(event.response_output_tokens)} | ${markdownCell(event.response_total_tokens)} |`;
  });
  const lastUsage = usageEvents.at(-1);
  const toolRows = toolEvents.map(
    (event) =>
      `| ${markdownCell(event.stage)} | ${markdownCell(event.slice_id)} | ${markdownCell(event.attempt)} | ${markdownCell(event.kind)} | ${markdownCell(event.outcome)} | ${markdownCell(event.failure_code)} | ${markdownCell(event.changed_files.join(", "))} |`,
  );
  const toolInputRows = toolInputRefusals.flatMap((event) =>
    event.issues.map(
      (issue) =>
        `| ${markdownCell(event.stage)} | ${markdownCell(event.slice_id)} | ${markdownCell(event.attempt)} | ${markdownCell(event.tool_name)} | ${markdownCell(event.failure_code)} | ${markdownCell(issue.code)}:${markdownCell(issue.path.length === 0 ? "ROOT" : issue.path.join("."))} |`,
    ),
  );
  const attemptErrorRows = attemptErrors.map(
    (event) =>
      `| ${markdownCell(event.role)} | ${markdownCell(event.stage)} | ${markdownCell(event.slice_id)} | ${markdownCell(event.attempt)} | ${markdownCell(event.error_code)} | ${markdownCell(event.error_detail_code)} | ${event.retryable ? "yes" : "no"} |`,
  );
  const stageErrorRows = stageErrors.map(
    (event) =>
      `| ${markdownCell(event.stage)} | ${markdownCell(event.error_name)} | ${markdownCell(event.error_code)} | ${markdownCell(event.error_detail_code)} |`,
  );
  const gateRows =
    diagnostic?.event === "RUN_DIAGNOSTIC"
      ? diagnostic.gate_receipts.map(
          (gate) =>
            `| ${markdownCell(gate.gate_id)} | ${markdownCell(gate.target)} | ${markdownCell(gate.outcome)} | ${markdownCell(gate.exit_code)} | ${String(gate.duration_ms)} |`,
        )
      : [];
  const compilerRows =
    diagnostic?.event === "RUN_DIAGNOSTIC"
      ? diagnostic.compiler_diagnostics.map(
          (compiler) =>
            `| ${markdownCell(compiler.gate_id)} | ${String(compiler.stage_attempt)} | ${markdownCell(compiler.path)}:${String(compiler.line)}:${String(compiler.column)} | ${markdownCell(compiler.message_digest)} | ${markdownCell(compiler.diagnostic_digest)} |`,
        )
      : [];
  const testDiagnosticRows =
    diagnostic?.event === "RUN_DIAGNOSTIC"
      ? (diagnostic.test_diagnostics ?? []).map(
          (test) =>
            `| ${markdownCell(test.gate_id)} | ${String(test.stage_attempt)} | ${markdownCell(test.test_name)} | ${test.path === null ? "—" : `${markdownCell(test.path)}:${String(test.line)}`} | ${markdownCell(test.message_digest)} | ${markdownCell(test.diagnostic_digest)} |`,
        )
      : [];
  const reviewFindingRows = events
    .filter(
      (event): event is Extract<StoredEvent, { event: "MODEL_OUTPUT_SHAPE" }> =>
        event.event === "MODEL_OUTPUT_SHAPE",
    )
    .flatMap((event) =>
      event.review_findings.map(
        (finding) =>
          `| ${markdownCell(finding.severity)} | ${markdownCell(finding.relative_path)}:${String(finding.line)} | ${markdownCell(event.review_lines_examined)} |`,
      ),
    );
  const reviews =
    diagnostic?.event === "RUN_DIAGNOSTIC"
      ? diagnostic.artifacts.filter((artifact) => artifact.review_decision !== null)
      : [];
  const verification =
    diagnostic?.event === "RUN_DIAGNOSTIC"
      ? [...diagnostic.artifacts]
          .reverse()
          .find((artifact) => artifact.verification_decision !== null)
      : undefined;
  const latestProgress = [...events].reverse().find((event) => event.event === "PROGRESS_SNAPSHOT");
  const lines = [
    "# Engineering invocation summary",
    "",
    `- Result: **${markdownCell(completed?.event === "RUN_COMPLETED" ? completed.status : "INCOMPLETE")}**`,
    `- Case: ${markdownCell(started?.event === "RUN_STARTED" ? started.case_id : null)}`,
    `- Run: ${markdownCell(started?.event === "RUN_STARTED" ? started.run_id : null)}`,
    `- Model route: ${markdownCell(started?.event === "RUN_STARTED" ? started.model : null)}`,
    `- Commit: ${markdownCell(completed?.event === "RUN_COMPLETED" ? completed.commit_sha : null)}`,
    `- Provider-reported tokens: ${markdownCell(lastUsage?.event === "MODEL_USAGE" ? lastUsage.total_tokens : 0)} / target ${String(ENGINEERING_MODEL_TARGET_TOKEN_LIMIT)} / warning ${String(ENGINEERING_MODEL_WARNING_TOKEN_LIMIT)} / hard ${String(ENGINEERING_MODEL_HARD_TOKEN_LIMIT)}`,
    "",
    "## Model usage by role, slice, attempt and round",
    "",
    "| Role | Stage | Slice | Attempt | Round | Input | Output | Total |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...(usageRows.length === 0 ? ["| — | — | — | — | — | — | — | — |"] : usageRows),
    "",
    "## Provider attempt failures",
    "",
    "| Role | Stage | Slice | Attempt | Code | Detail | Retryable |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...(attemptErrorRows.length === 0 ? ["| — | — | — | — | none | — | — |"] : attemptErrorRows),
    "",
    "## Stage failures",
    "",
    "| Stage | Error | Code | Detail |",
    "| --- | --- | --- | --- |",
    ...(stageErrorRows.length === 0 ? ["| — | none | — | — |"] : stageErrorRows),
    "",
    "## Tool refusals and ambiguities",
    "",
    "| Stage | Slice | Attempt | Kind | Outcome | Code | Changed files |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
    ...(toolRows.length === 0 ? ["| — | — | — | — | none | — | — |"] : toolRows),
    "",
    "## Tool input validation refusals",
    "",
    "| Stage | Slice | Attempt | Tool | Code | Schema issue |",
    "| --- | --- | ---: | --- | --- | --- |",
    ...(toolInputRows.length === 0 ? ["| — | — | — | — | none | — |"] : toolInputRows),
    "",
    "## Verification gates",
    "",
    "| Gate | Target | Outcome | Exit | Duration ms |",
    "| --- | --- | --- | ---: | ---: |",
    ...(gateRows.length === 0 ? ["| — | — | none | — | — |"] : gateRows),
    "",
    "## Compiler diagnostic chain",
    "",
    "| Gate | Attempt | Location | Message digest | Diagnostic digest |",
    "| --- | ---: | --- | --- | --- |",
    ...(compilerRows.length === 0 ? ["| — | — | none | — | — |"] : compilerRows),
    "",
    "## Xcode test diagnostic chain",
    "",
    "| Gate | Attempt | Test | Location | Message digest | Diagnostic digest |",
    "| --- | ---: | --- | --- | --- | --- |",
    ...(testDiagnosticRows.length === 0 ? ["| — | — | none | — | — | — |"] : testDiagnosticRows),
    "",
    "## Reviews and completion",
    "",
    ...(reviews.length === 0
      ? ["- Reviews: none recorded"]
      : reviews.map(
          (review) =>
            `- Review attempt ${String(review.stage_attempt)}: ${markdownCell(review.review_decision)}`,
        )),
    "",
    "| Blocking/non-blocking severity | Location | Lines examined |",
    "| --- | --- | ---: |",
    ...(reviewFindingRows.length === 0 ? ["| — | none recorded | — |"] : reviewFindingRows),
    `- Final verification: ${markdownCell(verification?.verification_decision ?? null)}`,
    `- Durable artifacts: ${markdownCell(completed?.event === "RUN_COMPLETED" ? completed.artifact_kinds.join(", ") : null)}`,
    "",
    "## Final checklist",
    "",
    ...(latestProgress?.event === "PROGRESS_SNAPSHOT"
      ? latestProgress.checklist.map(
          (item) => `- ${markdownCell(item.item)}: ${markdownCell(item.status)}`,
        )
      : ["- No progress snapshot was recorded."]),
    "",
    "Raw prompts, model prose, repository bytes, tool output and host paths are intentionally absent. Use the companion JSONL digests and durable artifacts for exact correlation.",
    "",
  ];
  return lines.join("\n");
}

export class EngineeringDebugJournal {
  readonly fileName: string;
  readonly filePath: string;
  readonly summaryFileName: string;
  readonly summaryFilePath: string;
  #handle: FileHandle;
  #events: StoredEvent[] = [];
  #sequence = 0;
  #pending: Promise<void> = Promise.resolve();
  #closed = false;
  #now: () => Date;

  private constructor(input: {
    handle: FileHandle;
    fileName: string;
    filePath: string;
    summaryFileName: string;
    summaryFilePath: string;
    now: () => Date;
  }) {
    this.#handle = input.handle;
    this.fileName = input.fileName;
    this.filePath = input.filePath;
    this.summaryFileName = input.summaryFileName;
    this.summaryFilePath = input.summaryFilePath;
    this.#now = input.now;
  }

  static async create(input: {
    artifactRoot: string;
    invocationId: string;
    now?: () => Date;
  }): Promise<EngineeringDebugJournal> {
    id.parse(input.invocationId);
    const root = await realpath(input.artifactRoot);
    const directory = join(root, "engineering-debug");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    const child = relative(root, canonicalDirectory);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error("engineering debug directory escaped the artifact root");
    }
    const digest = canonicalDigest({ invocation_id: input.invocationId }).slice("sha256:".length);
    const fileName = `engineering-${digest}.jsonl`;
    const filePath = join(canonicalDirectory, fileName);
    const summaryFileName = `engineering-${digest}.summary.md`;
    const summaryFilePath = join(canonicalDirectory, summaryFileName);
    const handle = await open(filePath, "wx", 0o600);
    return new EngineeringDebugJournal({
      handle,
      fileName,
      filePath,
      summaryFileName,
      summaryFilePath,
      now: input.now ?? (() => new Date()),
    });
  }

  append(event: EngineeringDebugEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("engineering debug journal is closed"));
    const parsed = debugEvent.parse(event);
    const stored: StoredEvent = {
      schema_version: 1,
      sequence: this.#sequence,
      recorded_at: this.#now().toISOString(),
      ...parsed,
    };
    this.#sequence += 1;
    this.#events.push(stored);
    this.#pending = this.#pending.then(async () => {
      await this.#handle.appendFile(`${JSON.stringify(stored)}\n`, { encoding: "utf8" });
    });
    return this.#pending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    await this.#handle.close();
    const summary = await open(this.summaryFilePath, "wx", 0o600);
    try {
      await summary.writeFile(renderEngineeringDebugSummary(this.#events), { encoding: "utf8" });
    } finally {
      await summary.close();
    }
  }
}
