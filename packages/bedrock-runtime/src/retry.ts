import type { TransportFailureKind } from "./errors.js";

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
