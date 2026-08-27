import { ConfigurationError } from "./errors.js";
import type {
  ModelIdentity,
  RetryPolicy,
  RuntimeConfig,
  ToolLimits,
  ToolLoopPolicy,
} from "./types.js";

export const MAX_TIMEOUT_MS = 86_400_000;
export const MAX_TOOL_ITERATIONS = 100;
export const MAX_TOOL_CALLS = 1_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_BASE_DELAY_MS = 100;
export const MAX_RETRY_ATTEMPTS = 5;
export const MAX_RETRY_DELAY_MS = 60_000;

export interface RuntimeConfigInput {
  readonly model: ModelIdentity;
  readonly timeoutMs: number;
  readonly toolLimits: ToolLimits;
  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly toolLoopPolicy?: ToolLoopPolicy;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireBoundedInteger(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ConfigurationError(`${field} must be an integer between 0 and ${maximum}`);
  }
  return value;
}

function uniqueToolNames(values: unknown, field: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new ConfigurationError(`${field} must be an array with at most 256 entries`);
  }
  const names = values.map((value, index) => requireText(value, `${field}[${index}]`));
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError(`${field} must contain unique names`);
  }
  return Object.freeze(names);
}

/** Validate and copy the safe, provider-neutral portion of runtime settings. */
export function createRuntimeConfig(input: RuntimeConfigInput): RuntimeConfig {
  if (input === null || typeof input !== "object") {
    throw new ConfigurationError("runtime configuration must be an object");
  }

  const model = {
    provider: requireText(input.model?.provider, "model.provider"),
    model_id: requireText(input.model?.model_id, "model.model_id"),
  } as const;

  if (
    typeof input.timeoutMs !== "number" ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    input.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new ConfigurationError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }

  const toolLimits = {
    maxIterations: requireBoundedInteger(
      input.toolLimits?.maxIterations,
      "toolLimits.maxIterations",
      MAX_TOOL_ITERATIONS,
    ),
    maxCalls: requireBoundedInteger(
      input.toolLimits?.maxCalls,
      "toolLimits.maxCalls",
      MAX_TOOL_CALLS,
    ),
  } as const;

  const retryPolicy = {
    maxAttempts: requireBoundedInteger(
      input.retryPolicy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "retryPolicy.maxAttempts",
      MAX_RETRY_ATTEMPTS,
    ),
    baseDelayMs: requireBoundedInteger(
      input.retryPolicy?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      "retryPolicy.baseDelayMs",
      MAX_RETRY_DELAY_MS,
    ),
  } as const;
  if (retryPolicy.maxAttempts < 1) {
    throw new ConfigurationError("retryPolicy.maxAttempts must be at least 1");
  }

  let toolLoopPolicy: ToolLoopPolicy | undefined;
  if (input.toolLoopPolicy !== undefined) {
    const readonlyToolNames = uniqueToolNames(
      input.toolLoopPolicy.readonlyToolNames,
      "toolLoopPolicy.readonlyToolNames",
    );
    const mutationToolNames = uniqueToolNames(
      input.toolLoopPolicy.mutationToolNames,
      "toolLoopPolicy.mutationToolNames",
    );
    if (readonlyToolNames.some((name) => mutationToolNames.includes(name))) {
      throw new ConfigurationError("toolLoopPolicy tool classes must be disjoint");
    }
    const mutationIterationsReserved = requireBoundedInteger(
      input.toolLoopPolicy.mutationIterationsReserved,
      "toolLoopPolicy.mutationIterationsReserved",
      toolLimits.maxIterations,
    );
    const retainRecentToolPairs = requireBoundedInteger(
      input.toolLoopPolicy.retainRecentToolPairs,
      "toolLoopPolicy.retainRecentToolPairs",
      toolLimits.maxIterations,
    );
    if (
      input.toolLoopPolicy.requireSuccessfulMutationAfterFailure !== undefined &&
      typeof input.toolLoopPolicy.requireSuccessfulMutationAfterFailure !== "boolean"
    ) {
      throw new ConfigurationError(
        "toolLoopPolicy.requireSuccessfulMutationAfterFailure must be a boolean",
      );
    }
    toolLoopPolicy = Object.freeze({
      readonlyToolNames,
      mutationToolNames,
      mutationIterationsReserved,
      retainRecentToolPairs,
      ...(input.toolLoopPolicy.requireSuccessfulMutationAfterFailure === undefined
        ? {}
        : {
            requireSuccessfulMutationAfterFailure:
              input.toolLoopPolicy.requireSuccessfulMutationAfterFailure,
          }),
    });
  }

  return Object.freeze({
    model: Object.freeze(model),
    timeoutMs: input.timeoutMs,
    toolLimits: Object.freeze(toolLimits),
    retryPolicy: Object.freeze(retryPolicy),
    ...(toolLoopPolicy === undefined ? {} : { toolLoopPolicy }),
  });
}
