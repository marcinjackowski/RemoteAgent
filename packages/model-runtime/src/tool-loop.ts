import { canonicalDigest } from "@remoteagent/contracts";

import { ToolInputError, ToolLimitError, TransportError } from "./errors.js";
import { executeTransportDetailed, type TransportExecutionDependencies } from "./retry.js";
import type {
  RuntimeConfig,
  RuntimeCompletionMetadata,
  RuntimeContent,
  RuntimeJsonValue,
  RuntimeMessage,
  RuntimeOutputSchema,
  RuntimeResponse,
  RuntimeTransport,
  RuntimeToolDefinition,
} from "./types.js";

export type ToolExecutor = (
  name: string,
  input: RuntimeJsonValue,
  signal: AbortSignal | undefined,
) => Promise<RuntimeJsonValue>;

export interface ToolLoopRequest {
  readonly messages: readonly RuntimeMessage[];
  /** Compact code-owned prompt used after a configured context-epoch boundary. */
  readonly epochHandoffMessages?: readonly RuntimeMessage[];
  readonly tools: readonly RuntimeToolDefinition[];
  readonly execute: ToolExecutor;
  readonly signal?: AbortSignal;
  readonly outputSchema?: RuntimeOutputSchema;
  readonly execution?: TransportExecutionDependencies;
}

export interface ToolLoopResult extends RuntimeResponse {
  readonly iterations: number;
  readonly calls: number;
  readonly history: readonly RuntimeMessage[];
  readonly transportAttempts: number;
  readonly modelCompletions: readonly RuntimeCompletionMetadata[];
}

type CompletedToolPair = Readonly<{
  assistant: RuntimeMessage;
  tool: RuntimeMessage;
  projection: readonly RuntimeJsonValue[];
}>;

const MAX_PROJECTED_TOOL_CALLS = 64;

function recordOf(value: RuntimeJsonValue): Readonly<Record<string, RuntimeJsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function domainToolOutcome(value: RuntimeJsonValue): "SUCCEEDED" | "FAILED" | "AMBIGUOUS" | null {
  const record = recordOf(value);
  const outcome = record?.["outcome"];
  return outcome === "SUCCEEDED" || outcome === "FAILED" || outcome === "AMBIGUOUS"
    ? outcome
    : null;
}

function domainToolFailureCode(value: RuntimeJsonValue): string | null {
  const failureCode = recordOf(value)?.["failure_code"];
  return typeof failureCode === "string" && /^[A-Za-z0-9._-]{1,64}$/u.test(failureCode)
    ? failureCode
    : null;
}

function projectedChangedFiles(value: Readonly<Record<string, RuntimeJsonValue>> | null): string[] {
  const changedFiles = value?.["changed_files"];
  if (!Array.isArray(changedFiles) || changedFiles.length > 512) return [];
  const safe = changedFiles.filter(
    (entry): entry is string =>
      typeof entry === "string" &&
      entry.length >= 1 &&
      entry.length <= 1024 &&
      !entry.startsWith("/") &&
      !entry.includes("\\") &&
      entry.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  );
  return safe.length === changedFiles.length ? [...new Set(safe)].sort() : [];
}

function mutationTargetPaths(input: RuntimeJsonValue): readonly string[] {
  const record = recordOf(input);
  if (record === null) return [];
  const targets: string[] = [];
  const direct = record["relative_path"];
  if (typeof direct === "string") targets.push(direct);
  for (const key of ["files", "replacement_files"] as const) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const relativePath = recordOf(entry)?.["relative_path"];
      if (typeof relativePath === "string") targets.push(relativePath);
    }
  }
  return [...new Set(targets)].sort();
}

function mutationTargetIdentity(name: string, input: RuntimeJsonValue): string | undefined {
  const targets = mutationTargetPaths(input);
  if (targets.length === 0) return undefined;
  return canonicalDigest({ tool_name: name, targets });
}

type ReplacementFailureCoordinate = Readonly<{
  relativePath: string;
  replacementIndex: number;
  expectedOldContentDigest: string;
  currentExcerptDigest: string;
  currentExcerptComplete: boolean;
}>;

function canonicalRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/**
 * Read only the bounded, code-owned repair coordinate from an implementation-tool envelope.
 * Raw excerpts remain in the immediately preceding tool result and are never copied into progress
 * projections or logs. A malformed or foreign coordinate falls back to the coarser target guard.
 */
function replacementFailureCoordinate(
  input: RuntimeJsonValue,
  output: RuntimeJsonValue,
): ReplacementFailureCoordinate | undefined {
  if (domainToolFailureCode(output) !== "REPLACEMENT_MISMATCH") return undefined;
  const rendered = recordOf(recordOf(output)?.["output"] ?? null)?.["value"];
  if (typeof rendered !== "string" || rendered.length > 131_072) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch {
    return undefined;
  }
  const repair = recordOf(recordOf(parsed as RuntimeJsonValue)?.["repair_context"] ?? null);
  const relativePath = repair?.["relative_path"];
  const replacementIndex = repair?.["replacement_index"];
  const expectedOldContentDigest = repair?.["expected_old_content_digest"];
  const currentExcerptDigest = repair?.["current_excerpt_digest"];
  const currentExcerptComplete = repair?.["current_excerpt_complete"];
  if (
    !canonicalRelativePath(relativePath) ||
    typeof replacementIndex !== "number" ||
    !Number.isSafeInteger(replacementIndex) ||
    replacementIndex < 0 ||
    typeof expectedOldContentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(expectedOldContentDigest) ||
    typeof currentExcerptDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(currentExcerptDigest) ||
    typeof currentExcerptComplete !== "boolean"
  ) {
    return undefined;
  }
  const inputRecord = recordOf(input);
  const requested = ["files", "replacement_files"].flatMap((key) => {
    const entries = inputRecord?.[key];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const path = recordOf(entry)?.["relative_path"];
      return typeof path === "string" ? [path] : [];
    });
  });
  if (!requested.includes(relativePath)) return undefined;
  return Object.freeze({
    relativePath,
    replacementIndex,
    expectedOldContentDigest,
    currentExcerptDigest,
    currentExcerptComplete,
  });
}

function mutationRefusalSignature(
  name: string,
  input: RuntimeJsonValue,
  output: RuntimeJsonValue,
): string | undefined {
  const targetIdentity = mutationTargetIdentity(name, input);
  if (targetIdentity === undefined) return undefined;
  const coordinate = replacementFailureCoordinate(input, output);
  if (coordinate !== undefined) {
    return `${targetIdentity}:${canonicalDigest({
      failure_code: "REPLACEMENT_MISMATCH",
      relative_path: coordinate.relativePath,
      replacement_index: coordinate.replacementIndex,
      expected_old_content_digest: coordinate.expectedOldContentDigest,
      current_excerpt_digest: coordinate.currentExcerptDigest,
      current_excerpt_complete: coordinate.currentExcerptComplete,
    })}`;
  }
  return `${targetIdentity}:${domainToolFailureCode(output) ?? "UNKNOWN"}`;
}

function replacementRecoveryMessage(coordinate: ReplacementFailureCoordinate): RuntimeMessage {
  return Object.freeze({
    role: "user",
    content: Object.freeze([
      Object.freeze({
        type: "json" as const,
        value: Object.freeze({
          schema_version: 1,
          kind: "REPLACEMENT_REPAIR_REQUIRED",
          authority: "SERVER_OWNED",
          reason_code: "REPLACEMENT_MISMATCH",
          relative_path: coordinate.relativePath,
          replacement_index: coordinate.replacementIndex,
          expected_old_content_digest: coordinate.expectedOldContentDigest,
          current_excerpt_digest: coordinate.currentExcerptDigest,
          current_excerpt_complete: coordinate.currentExcerptComplete,
          next_action:
            "Retry only this exact path. Copy a minimal unique old_content block byte-for-byte from repair_context.current_excerpt in the immediately preceding tool result; prefer 3-20 lines and do not resend the whole file unless current_excerpt_complete is true. Do not include unrelated paths in this recovery batch.",
        }),
      }),
    ]),
  });
}

function projectionForPair(
  uses: readonly Extract<RuntimeContent, { readonly type: "tool-use" }>[],
  results: readonly Extract<RuntimeContent, { readonly type: "tool-result" }>[],
): readonly RuntimeJsonValue[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return Object.freeze(
    uses.map((use) => {
      const result = byId.get(use.id);
      if (result === undefined) throw new TransportError("tool result projection is incomplete");
      const output = recordOf(result.output);
      const error = output === null ? null : recordOf(output["error"] ?? null);
      const value = output === null ? null : recordOf(output["value"] ?? null);
      const domainOutcome = value?.["outcome"];
      const projectedOutcome =
        domainOutcome === "SUCCEEDED" || domainOutcome === "FAILED" || domainOutcome === "AMBIGUOUS"
          ? domainOutcome
          : output?.["ok"] === true
            ? "SUCCEEDED"
            : "FAILED";
      const domainFailureCode = value?.["failure_code"];
      const errorCode =
        typeof error?.["code"] === "string"
          ? error["code"]
          : typeof domainFailureCode === "string" &&
              /^[A-Za-z0-9._-]{1,64}$/u.test(domainFailureCode)
            ? domainFailureCode
            : null;
      const changedFiles = projectedOutcome === "SUCCEEDED" ? projectedChangedFiles(value) : [];
      return Object.freeze({
        tool_name: use.name,
        tool_use_id_digest: canonicalDigest(use.id),
        outcome: projectedOutcome,
        error_code: errorCode,
        changed_files: changedFiles,
        input_digest: canonicalDigest(use.input),
        output_digest: canonicalDigest(result.output),
      });
    }),
  );
}

function compactToolHistory(
  initialMessages: readonly RuntimeMessage[],
  epochHandoffMessages: readonly RuntimeMessage[] | undefined,
  pairs: readonly CompletedToolPair[],
  retainRecentToolPairs: number,
  contextEpochPairLimit: number | undefined,
): RuntimeMessage[] {
  const contextEpoch =
    contextEpochPairLimit === undefined ? 0 : Math.floor(pairs.length / contextEpochPairLimit);
  const baseMessages =
    contextEpoch === 0 ? initialMessages : (epochHandoffMessages ?? initialMessages);
  const retainedStart = Math.max(0, pairs.length - retainRecentToolPairs);
  const olderEntries = pairs.slice(0, retainedStart).flatMap((pair) => pair.projection);
  const projected = olderEntries.slice(-MAX_PROJECTED_TOOL_CALLS);
  const omitted = olderEntries.slice(0, Math.max(0, olderEntries.length - projected.length));
  const projectionMessage: RuntimeMessage[] =
    olderEntries.length === 0
      ? []
      : [
          {
            role: "user",
            content: [
              {
                type: "json",
                value: {
                  schema_version: 1,
                  kind: "TOOL_HISTORY_PROJECTION",
                  authority: "SERVER_OWNED",
                  context_epoch: contextEpoch,
                  completed_tool_pairs: pairs.length,
                  initial_messages_digest: canonicalDigest(initialMessages),
                  projected_tool_calls: [...projected],
                  omitted_tool_calls: omitted.length,
                  omitted_tool_calls_digest: omitted.length === 0 ? null : canonicalDigest(omitted),
                },
              },
            ],
          },
        ];
  return [
    ...baseMessages,
    ...projectionMessage,
    ...pairs.slice(retainedStart).flatMap((pair) => [pair.assistant, pair.tool] as const),
  ];
}

function toolUses(content: readonly RuntimeContent[]) {
  return content.filter(
    (item): item is Extract<RuntimeContent, { readonly type: "tool-use" }> =>
      item.type === "tool-use",
  );
}

function safeToolFailure(error: unknown): Readonly<Record<string, RuntimeJsonValue>> {
  if (error instanceof ToolInputError) {
    return {
      ok: false,
      error: {
        code: error.code,
        issues: error.issues.map((issue) => ({ path: [...issue.path], code: issue.code })),
      },
    };
  }
  return { ok: false, error: { code: "TOOL_EXECUTION_FAILED" } };
}

function boundedToolInputDetail(toolName: string, error: ToolInputError): string {
  const issue = error.issues[0];
  const safe = (value: string, fallback: string) => {
    const normalized = value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 64);
    return normalized.length === 0 ? fallback : normalized;
  };
  const coordinate =
    issue === undefined || issue.path.length === 0
      ? "ROOT"
      : issue.path.map((part) => safe(part, "FIELD")).join(".");
  return [
    "TOOL_INPUT_INVALID",
    safe(toolName, "UNKNOWN_TOOL"),
    safe(issue?.code ?? "invalid", "invalid"),
    coordinate,
  ]
    .join(":")
    .slice(0, 128);
}

function remainingBudget(
  config: RuntimeConfig,
  iterationsAfterBatch: number,
  callsAfterBatch: number,
): Readonly<Record<string, RuntimeJsonValue>> {
  return {
    tool_iterations_remaining: Math.max(0, config.toolLimits.maxIterations - iterationsAfterBatch),
    tool_calls_remaining: Math.max(0, config.toolLimits.maxCalls - callsAfterBatch),
  };
}

/** Execute model-proposed tools exactly once, with limits checked before execution. */
export async function runToolLoop(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: ToolLoopRequest,
): Promise<ToolLoopResult> {
  const initialMessages: RuntimeMessage[] = request.messages.map((message) => ({
    ...message,
    content: [...message.content],
  }));
  let messages: RuntimeMessage[] = [...initialMessages];
  const completedPairs: CompletedToolPair[] = [];
  const executed = new Set<string>();
  let iterations = 0;
  let calls = 0;
  let transportAttempts = 0;
  const modelCompletions: RuntimeCompletionMetadata[] = [];
  let repeatedInvalidFingerprint: string | undefined;
  let repeatedInvalidCount = 0;
  let response: RuntimeResponse;
  const configuredTools =
    config.toolLimits.maxIterations === 0 || config.toolLimits.maxCalls === 0
      ? undefined
      : request.tools;
  const policy = config.toolLoopPolicy;
  const readonlyToolNames = new Set(policy?.readonlyToolNames ?? []);
  const mutationToolNames = new Set(policy?.mutationToolNames ?? []);
  if (
    policy?.contextEpochPairLimit !== undefined &&
    (request.epochHandoffMessages === undefined || request.epochHandoffMessages.length === 0)
  ) {
    throw new TransportError("A code-owned context epoch handoff is required by the tool policy");
  }
  if (policy !== undefined) {
    for (const definition of request.tools) {
      if (!readonlyToolNames.has(definition.name) && !mutationToolNames.has(definition.name)) {
        throw new TransportError(
          `Tool is absent from the code-owned loop policy: ${definition.name}`,
        );
      }
    }
  }
  let enabledTools = configuredTools;
  let mutationAttempted = false;
  let successfulMutationObserved = false;
  let requiredMutationObserved = policy?.requiredSuccessfulMutationPaths === undefined;
  const remainingRequiredMutationPathsAll = new Set(
    policy?.requiredSuccessfulMutationPathsAll ?? [],
  );
  let readonlyIterationsBeforeMutation = 0;
  let readonlyRefused = false;
  let unresolvedMutationFailure = false;
  const unresolvedFailedMutationPaths = new Set<string>();
  let unresolvedUnscopedMutationFailure = false;
  let completionRecoveryRefusals = 0;
  let recoveryMutationExtensionConsumed = false;
  let unresolvedMutationAmbiguity = false;
  const refusedMutationSignatures = new Map<string, number>();

  for (;;) {
    const execution = await executeTransportDetailed(
      transport,
      config,
      {
        messages,
        ...(enabledTools === undefined ? {} : { tools: enabledTools }),
        ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      request.execution,
    );
    response = execution.response;
    transportAttempts += execution.attempts;
    modelCompletions.push({
      model: response.model,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
      ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      transportAttempts: execution.attempts,
    });
    const uses = toolUses(response.content);
    if (uses.length === 0) {
      if (unresolvedMutationAmbiguity) {
        throw new ToolLimitError("Ambiguous mutation requires reconciliation before any retry");
      }
      const missingRequiredMutation =
        policy?.requireSuccessfulMutationBeforeFinal === true && !successfulMutationObserved;
      const missingRecoveryMutation =
        policy?.requireSuccessfulMutationAfterFailure === true && unresolvedMutationFailure;
      const missingRequiredMutationPathAny = !requiredMutationObserved;
      const missingRequiredMutationPathAll = remainingRequiredMutationPathsAll.size > 0;
      const missingRequiredMutationPath =
        missingRequiredMutationPathAny || missingRequiredMutationPathAll;
      if (missingRequiredMutation || missingRecoveryMutation || missingRequiredMutationPath) {
        // A correction path is server-owned and exact. Codex subscription occasionally returns a
        // structured `changed_files` final without invoking the enabled mutation tool at all. Give
        // that receipt-less claim one extra, still mutation-only recovery prompt; ordinary missing
        // mutations and failed-mutation recovery remain limited to one prompt.
        const completionRecoveryLimit = missingRequiredMutationPath ? 2 : 1;
        if (completionRecoveryRefusals >= completionRecoveryLimit) {
          throw new ToolLimitError(
            missingRecoveryMutation
              ? "Final report repeated before a failed mutation was recovered"
              : missingRequiredMutationPath
                ? missingRequiredMutationPathAll
                  ? "Final report repeated before all required correction paths were changed"
                  : "Final report repeated before a required correction path was changed"
                : "Final report repeated before the required mutation was completed",
            missingRecoveryMutation
              ? "FINAL_WITHOUT_FAILED_MUTATION_RECOVERY"
              : missingRequiredMutationPath
                ? "FINAL_WITHOUT_REQUIRED_CORRECTION_RECEIPT"
                : "FINAL_WITHOUT_REQUIRED_MUTATION_RECEIPT",
          );
        }
        completionRecoveryRefusals += 1;
        const requiredCorrectionPathsAny = missingRequiredMutationPathAny
          ? [...(policy?.requiredSuccessfulMutationPaths ?? [])]
          : [];
        const requiredCorrectionPathsAll = [...remainingRequiredMutationPathsAll].sort();
        const requiredCorrectionPaths = [
          ...new Set([...requiredCorrectionPathsAny, ...requiredCorrectionPathsAll]),
        ].sort();
        messages = [
          ...messages,
          { role: "assistant", content: [...response.content] },
          {
            role: "user",
            content: [
              {
                type: "json",
                value: {
                  schema_version: 1,
                  kind: "MUTATION_RECOVERY_REQUIRED",
                  authority: "SERVER_OWNED",
                  reason_code: missingRecoveryMutation
                    ? "FAILED_MUTATION_NOT_RECOVERED"
                    : missingRequiredMutationPath
                      ? "REQUIRED_CORRECTION_PATH_NOT_CHANGED"
                      : "SUCCESSFUL_MUTATION_REQUIRED",
                  next_action: missingRecoveryMutation
                    ? "Use a mutation tool to correct the prior failed mutation before returning the final report."
                    : missingRequiredMutationPath
                      ? completionRecoveryRefusals > 1
                        ? "The previous final report produced no mutation receipt. Invoke an enabled mutation tool for the exact required correction path now; do not return changed_files until that tool succeeds."
                        : requiredCorrectionPathsAll.length > 0
                          ? "Use mutation tools to change every exact path in required_correction_paths_all before returning the final report; when required_correction_paths_any is non-empty, also change at least one of those paths."
                          : "Use a mutation tool to change at least one exact path in required_correction_paths_any before returning the final report."
                      : "Use a mutation tool and record a successful mutation before returning the final report.",
                  ...(missingRequiredMutationPath
                    ? {
                        recovery_prompt_attempt: completionRecoveryRefusals,
                        final_report_claims_are_not_mutation_receipts: true,
                        required_correction_paths: requiredCorrectionPaths,
                        required_correction_paths_any: requiredCorrectionPathsAny,
                        required_correction_paths_all: requiredCorrectionPathsAll,
                      }
                    : {}),
                  mutation_recovery_extension_remaining:
                    (missingRecoveryMutation || missingRequiredMutationPath) &&
                    !recoveryMutationExtensionConsumed &&
                    calls < config.toolLimits.maxCalls
                      ? 1
                      : 0,
                  ...remainingBudget(config, iterations, calls),
                },
              },
            ],
          },
        ];
        enabledTools = request.tools.filter((definition) => mutationToolNames.has(definition.name));
        continue;
      }
      return {
        ...response,
        iterations,
        calls,
        history: [...messages, { role: "assistant", content: [...response.content] }],
        transportAttempts,
        modelCompletions,
      };
    }

    // Validate the entire batch before invoking even the first executor.
    if (config.toolLimits.maxIterations === 0 || config.toolLimits.maxCalls === 0) {
      throw new ToolLimitError("Tool execution is disabled by zero tool limits");
    }
    const exceedsIterationLimit = iterations + 1 > config.toolLimits.maxIterations;
    const hasMissingRequiredCorrectionPath =
      !requiredMutationObserved || remainingRequiredMutationPathsAll.size > 0;
    const usesRecoveryMutationExtension =
      exceedsIterationLimit &&
      ((policy?.requireSuccessfulMutationAfterFailure === true && unresolvedMutationFailure) ||
        hasMissingRequiredCorrectionPath) &&
      !unresolvedMutationAmbiguity &&
      !recoveryMutationExtensionConsumed &&
      uses.length > 0 &&
      uses.every((use) => mutationToolNames.has(use.name));
    if (exceedsIterationLimit && !usesRecoveryMutationExtension) {
      throw new ToolLimitError("Maximum tool iterations exceeded");
    }
    if (calls + uses.length > config.toolLimits.maxCalls) {
      throw new ToolLimitError("Maximum tool calls exceeded");
    }
    if (unresolvedMutationAmbiguity && uses.some((use) => mutationToolNames.has(use.name))) {
      throw new ToolLimitError("Ambiguous mutation cannot be retried");
    }
    const names = new Set(request.tools.map((tool) => tool.name));
    const batchIds = new Set<string>();
    for (const use of uses) {
      if (use.id.length === 0 || batchIds.has(use.id) || executed.has(use.id)) {
        throw new TransportError(`Duplicate or unknown tool-use id: ${use.id}`);
      }
      if (!names.has(use.name)) throw new TransportError(`Unknown tool: ${use.name}`);
      batchIds.add(use.id);
    }
    if (usesRecoveryMutationExtension) recoveryMutationExtensionConsumed = true;

    const isReadOnlyBatch =
      policy !== undefined && uses.every((use) => readonlyToolNames.has(use.name));
    const exceedsReadonlyLimit =
      policy?.maxReadonlyIterationsBeforeMutation !== undefined &&
      !mutationAttempted &&
      isReadOnlyBatch &&
      readonlyIterationsBeforeMutation + 1 > policy.maxReadonlyIterationsBeforeMutation;
    const entersMutationReserve =
      policy !== undefined &&
      !mutationAttempted &&
      isReadOnlyBatch &&
      iterations + 1 > config.toolLimits.maxIterations - policy.mutationIterationsReserved;
    if (exceedsReadonlyLimit || entersMutationReserve) {
      if (readonlyRefused) {
        throw new ToolLimitError("Read-only discovery repeated after code-owned refusal");
      }
      readonlyRefused = true;
      for (const use of uses) executed.add(use.id);
      const assistant: RuntimeMessage = { role: "assistant", content: [...response.content] };
      const progress = {
        ...remainingBudget(config, iterations, calls),
        mutation_iterations_reserved: policy.mutationIterationsReserved,
        readonly_iterations_used: readonlyIterationsBeforeMutation,
        readonly_iterations_limit: policy.maxReadonlyIterationsBeforeMutation ?? null,
      };
      const tool: RuntimeMessage = {
        role: "tool",
        content: uses.map((use) => ({
          type: "tool-result" as const,
          id: use.id,
          output: {
            ok: false,
            error: {
              code: exceedsReadonlyLimit ? "TOOL_DISCOVERY_LIMIT" : "TOOL_MUTATION_RESERVE",
            },
            progress,
          },
        })),
      };
      completedPairs.push({
        assistant,
        tool,
        projection: projectionForPair(
          uses,
          tool.content.filter(
            (result): result is Extract<RuntimeContent, { readonly type: "tool-result" }> =>
              result.type === "tool-result",
          ),
        ),
      });
      messages = compactToolHistory(
        initialMessages,
        request.epochHandoffMessages,
        completedPairs,
        policy.retainRecentToolPairs,
        policy.contextEpochPairLimit,
      );
      enabledTools = request.tools.filter((definition) => mutationToolNames.has(definition.name));
      continue;
    }

    const assistant: RuntimeMessage = { role: "assistant", content: [...response.content] };
    messages = [...messages, assistant];
    const results: RuntimeContent[] = [];
    let mutationBatchSucceeded = false;
    let mutationBatchFailed = false;
    let mutationBatchUnscopedFailure = false;
    let mutationBatchAmbiguous = false;
    let repeatedMutationTargetRefusal = false;
    let repeatedMutationTargetRefusalDetail: string | undefined;
    let replacementRecovery: ReplacementFailureCoordinate | undefined;
    const progress = remainingBudget(config, iterations + 1, calls + uses.length);
    for (const use of uses) {
      if (mutationToolNames.has(use.name)) mutationAttempted = true;
      executed.add(use.id);
      try {
        const output = await request.execute(use.name, use.input, request.signal);
        if (mutationToolNames.has(use.name)) {
          const outcome = domainToolOutcome(output);
          const targetIdentity = mutationTargetIdentity(use.name, use.input);
          if (outcome === "SUCCEEDED") {
            mutationBatchSucceeded = true;
            successfulMutationObserved = true;
            const changedFiles = projectedChangedFiles(recordOf(output));
            const repairedPaths =
              changedFiles.length > 0 ? changedFiles : mutationTargetPaths(use.input);
            for (const path of repairedPaths) unresolvedFailedMutationPaths.delete(path);
            if (
              policy?.requiredSuccessfulMutationPaths?.some((path) =>
                changedFiles.includes(path),
              ) === true
            ) {
              requiredMutationObserved = true;
            }
            for (const path of changedFiles) remainingRequiredMutationPathsAll.delete(path);
            if (targetIdentity !== undefined) {
              for (const signature of refusedMutationSignatures.keys()) {
                if (signature.startsWith(`${targetIdentity}:`)) {
                  refusedMutationSignatures.delete(signature);
                }
              }
            }
          } else {
            mutationBatchFailed = true;
            if (outcome === "AMBIGUOUS") mutationBatchAmbiguous = true;
            if (outcome === "FAILED") {
              replacementRecovery = replacementFailureCoordinate(use.input, output);
              const failedPaths =
                replacementRecovery === undefined
                  ? mutationTargetPaths(use.input)
                  : [replacementRecovery.relativePath];
              if (failedPaths.length === 0) mutationBatchUnscopedFailure = true;
              else for (const path of failedPaths) unresolvedFailedMutationPaths.add(path);
              const signature = mutationRefusalSignature(use.name, use.input, output);
              if (signature !== undefined) {
                const refusals = (refusedMutationSignatures.get(signature) ?? 0) + 1;
                refusedMutationSignatures.set(signature, refusals);
                if (refusals >= 2) repeatedMutationTargetRefusal = true;
              }
            }
          }
        }
        results.push({
          type: "tool-result",
          id: use.id,
          output: { ok: true, value: output, progress },
        });
        repeatedInvalidFingerprint = undefined;
        repeatedInvalidCount = 0;
      } catch (error) {
        if (mutationToolNames.has(use.name)) {
          mutationBatchFailed = true;
          const failedPaths = mutationTargetPaths(use.input);
          if (failedPaths.length === 0) mutationBatchUnscopedFailure = true;
          else for (const path of failedPaths) unresolvedFailedMutationPaths.add(path);
          const targetIdentity = mutationTargetIdentity(use.name, use.input);
          if (targetIdentity !== undefined) {
            const failureCode =
              error instanceof ToolInputError ? error.code : "TOOL_EXECUTION_FAILED";
            const signature = `${targetIdentity}:${failureCode}`;
            const refusals = (refusedMutationSignatures.get(signature) ?? 0) + 1;
            refusedMutationSignatures.set(signature, refusals);
            if (refusals >= 2) {
              repeatedMutationTargetRefusal = true;
              if (error instanceof ToolInputError) {
                repeatedMutationTargetRefusalDetail = boundedToolInputDetail(use.name, error);
              }
            }
          }
        }
        // Errors are data, so a failed tool never causes a side-effecting retry.
        results.push({
          type: "tool-result",
          id: use.id,
          output: { ...safeToolFailure(error), progress },
        });
        if (error instanceof ToolInputError && uses.length === 1) {
          const fingerprint = canonicalDigest({
            tool: use.name,
            input: use.input,
            issues: error.issues,
          });
          repeatedInvalidCount =
            fingerprint === repeatedInvalidFingerprint ? repeatedInvalidCount + 1 : 1;
          repeatedInvalidFingerprint = fingerprint;
          if (repeatedInvalidCount >= 3) {
            throw new ToolLimitError(
              "Repeated invalid tool input made no progress",
              boundedToolInputDetail(use.name, error),
            );
          }
        } else {
          repeatedInvalidFingerprint = undefined;
          repeatedInvalidCount = 0;
        }
      }
    }
    if (mutationBatchFailed) {
      if (mutationBatchUnscopedFailure) unresolvedUnscopedMutationFailure = true;
      unresolvedMutationFailure =
        unresolvedUnscopedMutationFailure || unresolvedFailedMutationPaths.size > 0;
      unresolvedMutationAmbiguity = mutationBatchAmbiguous;
      // A real mutation attempt is progress even when the domain boundary refuses it. Permit one
      // fresh recovery instruction for the new failure; repeated finals without a mutation remain
      // bounded by completionRecoveryRefusals above.
      completionRecoveryRefusals = 0;
    } else if (mutationBatchSucceeded) {
      unresolvedUnscopedMutationFailure = false;
      unresolvedMutationFailure = unresolvedFailedMutationPaths.size > 0;
      unresolvedMutationAmbiguity = false;
      completionRecoveryRefusals = 0;
    }
    if (repeatedMutationTargetRefusal) {
      throw new ToolLimitError(
        "Repeated mutation target refusal made no progress",
        repeatedMutationTargetRefusalDetail,
      );
    }
    if (isReadOnlyBatch && !mutationAttempted) readonlyIterationsBeforeMutation += 1;
    const toolMessage: RuntimeMessage = { role: "tool", content: results };
    if (policy === undefined) {
      messages = [...messages, toolMessage];
    } else {
      completedPairs.push({
        assistant,
        tool: toolMessage,
        projection: projectionForPair(
          uses,
          results.filter(
            (result): result is Extract<RuntimeContent, { readonly type: "tool-result" }> =>
              result.type === "tool-result",
          ),
        ),
      });
      messages = compactToolHistory(
        initialMessages,
        request.epochHandoffMessages,
        completedPairs,
        policy.retainRecentToolPairs,
        policy.contextEpochPairLimit,
      );
    }
    if (replacementRecovery !== undefined) {
      messages = [...messages, replacementRecoveryMessage(replacementRecovery)];
    }
    iterations += 1;
    calls += uses.length;
  }
}

/** Alias retained as a descriptive public entry point. */
export const converseWithTools = runToolLoop;
