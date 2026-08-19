import {
  RuntimeCancelledError,
  RuntimeTimeoutError,
  TransportError,
  type TransportFailureKind,
} from "./errors.js";
import type { RuntimeConfig, RuntimeRequest, RuntimeResponse, RuntimeTransport } from "./types.js";

export interface TransportExecutionDependencies {
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface DetailedTransportResponse {
  readonly response: RuntimeResponse;
  readonly attempts: number;
}

export async function executeTransportDetailed(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: RuntimeRequest,
  dependencies: TransportExecutionDependencies = {},
): Promise<DetailedTransportResponse> {
  const controller = new AbortController();
  const transportRequest: RuntimeRequest = { ...request, signal: controller.signal };
  const setTimeoutFn =
    dependencies.setTimeout ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const clearTimeoutFn =
    dependencies.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const sleep =
    dependencies.sleep ??
    ((delayMs: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new RuntimeCancelledError());
          return;
        }
        let handle: unknown;
        const onAbort = () => {
          if (handle !== undefined) clearTimeoutFn(handle);
          reject(new RuntimeCancelledError());
        };
        handle = setTimeoutFn(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        signal.addEventListener("abort", onAbort, { once: true });
      }));
  let finished = false;
  let attempts = 0;
  let timer: unknown;
  let onAbort: (() => void) | undefined;

  const result = new Promise<DetailedTransportResponse>((resolve, reject) => {
    const settle = (callback: () => void) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeoutFn(timer);
      if (onAbort !== undefined) request.signal?.removeEventListener("abort", onAbort);
      controller.abort();
      callback();
    };
    onAbort = () => settle(() => reject(new RuntimeCancelledError()));
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    request.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeoutFn(() => settle(() => reject(new RuntimeTimeoutError())), config.timeoutMs);

    const run = async () => {
      for (let attempt = 1; attempt <= config.retryPolicy.maxAttempts; attempt += 1) {
        if (finished) return;
        try {
          attempts += 1;
          const response = await transport.converse(transportRequest, config);
          settle(() => resolve({ response, attempts }));
          return;
        } catch (error) {
          if (finished) return;
          if (!(error instanceof TransportError) || !error.retryable) {
            settle(() => reject(error));
            return;
          }
          if (attempt >= config.retryPolicy.maxAttempts) {
            settle(() => reject(error));
            return;
          }
          try {
            await sleep(config.retryPolicy.baseDelayMs * 2 ** (attempt - 1), controller.signal);
          } catch (sleepError) {
            if (!finished) settle(() => reject(sleepError));
            return;
          }
        }
      }
    };
    void run().catch((error: unknown) => {
      if (!finished) settle(() => reject(error));
    });
  });
  return result;
}

export async function executeTransport(
  transport: RuntimeTransport,
  config: RuntimeConfig,
  request: RuntimeRequest,
  dependencies: TransportExecutionDependencies = {},
): Promise<RuntimeResponse> {
  const result = await executeTransportDetailed(transport, config, request, dependencies);
  return result.response;
}

export type TransportFailureClassification = TransportFailureKind | "CANCELLED";

const THROTTLING_NAMES = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
]);
const TRANSIENT_NAMES = new Set([
  "InternalServerException",
  "ServiceUnavailableException",
  "ModelTimeoutException",
  "RequestTimeout",
  "TimeoutError",
  "NetworkError",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const CANCELLATION_NAMES = new Set(["AbortError", "CancellationError", "CancelledError"]);

function structuralError(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
}

function statusOf(error: Record<string, unknown>): number | undefined {
  if (typeof error.statusCode === "number") return error.statusCode;
  if (typeof error.httpStatusCode === "number") return error.httpStatusCode;
  const metadata = error.$metadata;
  if (metadata !== null && typeof metadata === "object") {
    const status = (metadata as Record<string, unknown>).httpStatusCode;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Classify only stable structural SDK fields; error messages are deliberately ignored. */
export function classifyTransportFailure(error: unknown): TransportFailureClassification {
  const value = structuralError(error);
  const names = [value.name, value.code].filter(
    (field): field is string => typeof field === "string",
  );
  const status = statusOf(value);
  const retryable = value.retryable === true || value.$retryable !== undefined;
  const retryDetails = value.$retryable;
  const throttlingTrait =
    retryDetails !== null &&
    typeof retryDetails === "object" &&
    (retryDetails as Record<string, unknown>).throttling === true;

  if (names.some((name) => CANCELLATION_NAMES.has(name))) return "CANCELLED";
  if (names.some((name) => THROTTLING_NAMES.has(name))) return "THROTTLING";
  if (throttlingTrait || status === 429) return "THROTTLING";
  if (
    names.some((name) => TRANSIENT_NAMES.has(name)) ||
    [408, 500, 502, 503, 504].includes(status ?? -1)
  ) {
    return "TRANSIENT";
  }
  if (retryable) return "TRANSIENT";
  return "FATAL";
}

export const classifyError = classifyTransportFailure;
