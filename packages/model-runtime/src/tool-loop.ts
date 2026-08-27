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

function mutationTargetIdentity(name: string, input: RuntimeJsonValue): string | undefined {
  const record = recordOf(input);
  if (record === null) return undefined;
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
  if (targets.length === 0) return undefined;
  return canonicalDigest({ tool_name: name, targets: [...new Set(targets)].sort() });
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
      return Object.freeze({
        tool_name: use.name,
        tool_use_id_digest: canonicalDigest(use.id),
        outcome: projectedOutcome,
        error_code: errorCode,
        input_digest: canonicalDigest(use.input),
        output_digest: canonicalDigest(result.output),
      });
    }),
  );
}

function compactToolHistory(
  initialMessages: readonly RuntimeMessage[],
  pairs: readonly CompletedToolPair[],
  retainRecentToolPairs: number,
): RuntimeMessage[] {
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
                  projected_tool_calls: [...projected],
                  omitted_tool_calls: omitted.length,
                  omitted_tool_calls_digest: omitted.length === 0 ? null : canonicalDigest(omitted),
                },
              },
            ],
          },
        ];
  return [
    ...initialMessages,
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
  let reserveRefused = false;
  let unresolvedMutationFailure = false;
  let completionRecoveryRefused = false;
  let recoveryMutationExtensionConsumed = false;
  const refusedMutationTargets = new Map<string, number>();

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
      if (policy?.requireSuccessfulMutationAfterFailure === true && unresolvedMutationFailure) {
        if (completionRecoveryRefused) {
          throw new ToolLimitError("Final report repeated before a failed mutation was recovered");
        }
        completionRecoveryRefused = true;
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
                  reason_code: "FAILED_MUTATION_NOT_RECOVERED",
                  next_action:
                    "Use a mutation tool to correct the prior failed mutation before returning the final report.",
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
    const usesRecoveryMutationExtension =
      exceedsIterationLimit &&
      policy?.requireSuccessfulMutationAfterFailure === true &&
      completionRecoveryRefused &&
      unresolvedMutationFailure &&
      !recoveryMutationExtensionConsumed &&
      uses.length > 0 &&
      uses.every((use) => mutationToolNames.has(use.name));
    if (exceedsIterationLimit && !usesRecoveryMutationExtension) {
      throw new ToolLimitError("Maximum tool iterations exceeded");
    }
    if (calls + uses.length > config.toolLimits.maxCalls) {
      throw new ToolLimitError("Maximum tool calls exceeded");
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
    const entersMutationReserve =
      policy !== undefined &&
      !mutationAttempted &&
      isReadOnlyBatch &&
      iterations + 1 > config.toolLimits.maxIterations - policy.mutationIterationsReserved;
    if (entersMutationReserve) {
      if (reserveRefused) {
        throw new ToolLimitError("Read-only discovery repeated after mutation reserve refusal");
      }
      reserveRefused = true;
      for (const use of uses) executed.add(use.id);
      const assistant: RuntimeMessage = { role: "assistant", content: [...response.content] };
      const progress = {
        ...remainingBudget(config, iterations, calls),
        mutation_iterations_reserved: policy.mutationIterationsReserved,
      };
      const tool: RuntimeMessage = {
        role: "tool",
        content: uses.map((use) => ({
          type: "tool-result" as const,
          id: use.id,
          output: {
            ok: false,
            error: { code: "TOOL_MUTATION_RESERVE" },
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
      messages = compactToolHistory(initialMessages, completedPairs, policy.retainRecentToolPairs);
      enabledTools = request.tools.filter((definition) => mutationToolNames.has(definition.name));
      continue;
    }

    const assistant: RuntimeMessage = { role: "assistant", content: [...response.content] };
    messages = [...messages, assistant];
    const results: RuntimeContent[] = [];
    let mutationBatchSucceeded = false;
    let mutationBatchFailed = false;
    let repeatedMutationTargetRefusal = false;
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
            if (targetIdentity !== undefined) refusedMutationTargets.delete(targetIdentity);
          } else {
            mutationBatchFailed = true;
            if (outcome === "FAILED" && targetIdentity !== undefined) {
              const refusals = (refusedMutationTargets.get(targetIdentity) ?? 0) + 1;
              refusedMutationTargets.set(targetIdentity, refusals);
              if (refusals >= 2) repeatedMutationTargetRefusal = true;
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
          const targetIdentity = mutationTargetIdentity(use.name, use.input);
          if (targetIdentity !== undefined) {
            const refusals = (refusedMutationTargets.get(targetIdentity) ?? 0) + 1;
            refusedMutationTargets.set(targetIdentity, refusals);
            if (refusals >= 2) repeatedMutationTargetRefusal = true;
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
            throw new ToolLimitError("Repeated invalid tool input made no progress");
          }
        } else {
          repeatedInvalidFingerprint = undefined;
          repeatedInvalidCount = 0;
        }
      }
    }
    if (mutationBatchFailed) {
      unresolvedMutationFailure = true;
      // A real mutation attempt is progress even when the domain boundary refuses it. Permit one
      // fresh recovery instruction for the new failure; repeated finals without a mutation remain
      // bounded by completionRecoveryRefused above.
      completionRecoveryRefused = false;
    } else if (mutationBatchSucceeded) {
      unresolvedMutationFailure = false;
      completionRecoveryRefused = false;
    }
    if (repeatedMutationTargetRefusal) {
      throw new ToolLimitError("Repeated mutation target refusal made no progress");
    }
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
      messages = compactToolHistory(initialMessages, completedPairs, policy.retainRecentToolPairs);
    }
    iterations += 1;
    calls += uses.length;
  }
}

/** Alias retained as a descriptive public entry point. */
export const converseWithTools = runToolLoop;
