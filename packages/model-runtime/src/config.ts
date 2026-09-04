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

function canonicalRelativePaths(values: unknown, field: string): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > 512) {
    throw new ConfigurationError(`${field} must be an array with 1 to 512 entries`);
  }
  return Object.freeze(
    [...new Set(values)]
      .map((path) => {
        if (
          typeof path !== "string" ||
          path.length < 1 ||
          path.length > 1024 ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
          throw new ConfigurationError(`${field} must contain canonical relative paths`);
        }
        return path;
      })
      .sort(),
  );
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
    const maxReadonlyIterationsBeforeMutation =
      input.toolLoopPolicy.maxReadonlyIterationsBeforeMutation === undefined
        ? undefined
        : requireBoundedInteger(
            input.toolLoopPolicy.maxReadonlyIterationsBeforeMutation,
            "toolLoopPolicy.maxReadonlyIterationsBeforeMutation",
            toolLimits.maxIterations,
          );
    const contextEpochPairLimit =
      input.toolLoopPolicy.contextEpochPairLimit === undefined
        ? undefined
        : requireBoundedInteger(
            input.toolLoopPolicy.contextEpochPairLimit,
            "toolLoopPolicy.contextEpochPairLimit",
            toolLimits.maxIterations,
          );
    if (contextEpochPairLimit === 0) {
      throw new ConfigurationError("toolLoopPolicy.contextEpochPairLimit must be at least 1");
    }
    if (
      input.toolLoopPolicy.requireSuccessfulMutationAfterFailure !== undefined &&
      typeof input.toolLoopPolicy.requireSuccessfulMutationAfterFailure !== "boolean"
    ) {
      throw new ConfigurationError(
        "toolLoopPolicy.requireSuccessfulMutationAfterFailure must be a boolean",
      );
    }
    if (
      input.toolLoopPolicy.requireSuccessfulMutationBeforeFinal !== undefined &&
      typeof input.toolLoopPolicy.requireSuccessfulMutationBeforeFinal !== "boolean"
    ) {
      throw new ConfigurationError(
        "toolLoopPolicy.requireSuccessfulMutationBeforeFinal must be a boolean",
      );
    }
    if (
      input.toolLoopPolicy.requireSuccessfulMutationBeforeFinal === true &&
      mutationToolNames.length === 0
    ) {
      throw new ConfigurationError(
        "toolLoopPolicy.requireSuccessfulMutationBeforeFinal needs a mutation tool",
      );
    }
    const requiredSuccessfulMutationPaths = canonicalRelativePaths(
      input.toolLoopPolicy.requiredSuccessfulMutationPaths,
      "toolLoopPolicy.requiredSuccessfulMutationPaths",
    );
    const requiredSuccessfulMutationPathsAll = canonicalRelativePaths(
      input.toolLoopPolicy.requiredSuccessfulMutationPathsAll,
      "toolLoopPolicy.requiredSuccessfulMutationPathsAll",
    );
    if (
      (requiredSuccessfulMutationPaths !== undefined ||
        requiredSuccessfulMutationPathsAll !== undefined) &&
      mutationToolNames.length === 0
    ) {
      throw new ConfigurationError("toolLoopPolicy required mutation paths need a mutation tool");
    }
    if (maxReadonlyIterationsBeforeMutation !== undefined && mutationToolNames.length === 0) {
      throw new ConfigurationError(
        "toolLoopPolicy.maxReadonlyIterationsBeforeMutation needs a mutation tool",
      );
    }
    toolLoopPolicy = Object.freeze({
      readonlyToolNames,
      mutationToolNames,
      mutationIterationsReserved,
      ...(maxReadonlyIterationsBeforeMutation === undefined
        ? {}
        : { maxReadonlyIterationsBeforeMutation }),
      retainRecentToolPairs,
      ...(contextEpochPairLimit === undefined ? {} : { contextEpochPairLimit }),
      ...(input.toolLoopPolicy.requireSuccessfulMutationAfterFailure === undefined
        ? {}
        : {
            requireSuccessfulMutationAfterFailure:
              input.toolLoopPolicy.requireSuccessfulMutationAfterFailure,
          }),
      ...(input.toolLoopPolicy.requireSuccessfulMutationBeforeFinal === undefined
        ? {}
        : {
            requireSuccessfulMutationBeforeFinal:
              input.toolLoopPolicy.requireSuccessfulMutationBeforeFinal,
          }),
      ...(requiredSuccessfulMutationPaths === undefined ? {} : { requiredSuccessfulMutationPaths }),
      ...(requiredSuccessfulMutationPathsAll === undefined
        ? {}
        : { requiredSuccessfulMutationPathsAll }),
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
