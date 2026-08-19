export type RuntimeErrorCode =
  "CONFIGURATION_INVALID" | "TIMEOUT" | "CANCELLED" | "LIMIT_EXCEEDED" | "TRANSPORT_ERROR";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly retryable: boolean;

  constructor(code: RuntimeErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class ConfigurationError extends RuntimeError {
  constructor(message: string) {
    super("CONFIGURATION_INVALID", message);
    this.name = "ConfigurationError";
  }
}

export class RuntimeTimeoutError extends RuntimeError {
  constructor(message = "The runtime request timed out") {
    super("TIMEOUT", message, true);
    this.name = "RuntimeTimeoutError";
  }
}

export class RuntimeCancelledError extends RuntimeError {
  constructor(message = "The runtime request was cancelled") {
    super("CANCELLED", message);
    this.name = "RuntimeCancelledError";
  }
}

export class ToolLimitError extends RuntimeError {
  constructor(message: string) {
    super("LIMIT_EXCEEDED", message);
    this.name = "ToolLimitError";
  }
}

export class TransportError extends RuntimeError {
  constructor(message: string, retryable = false) {
    super("TRANSPORT_ERROR", message, retryable);
    this.name = "TransportError";
  }
}
