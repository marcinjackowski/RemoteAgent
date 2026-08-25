export type RuntimeErrorCode =
  "CONFIGURATION_INVALID" | "TIMEOUT" | "CANCELLED" | "LIMIT_EXCEEDED" | "TRANSPORT_ERROR";

export type TransportFailureKind = "THROTTLING" | "TRANSIENT" | "FATAL";

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

/** A server-pinned structured schema does not match the requested definition. */
export class StructuredSchemaIdentityError extends ConfigurationError {
  constructor() {
    super("Structured schema identity mismatch");
    this.name = "StructuredSchemaIdentityError";
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
  readonly kind: TransportFailureKind;

  constructor(message: string, kind: TransportFailureKind | boolean = "FATAL") {
    const normalizedKind: TransportFailureKind =
      typeof kind === "boolean" ? (kind ? "TRANSIENT" : "FATAL") : kind;
    super(
      "TRANSPORT_ERROR",
      message,
      normalizedKind === "THROTTLING" || normalizedKind === "TRANSIENT",
    );
    this.name = "TransportError";
    this.kind = normalizedKind;
  }
}

/** A transport response claims a model other than the configured provider/model. */
export class StructuredModelIdentityError extends TransportError {
  constructor() {
    super("Structured model identity mismatch", "FATAL");
    this.name = "StructuredModelIdentityError";
  }
}

/** The model response could not be parsed as its server-owned structured contract. */
export class StructuredContractOutputError extends TransportError {
  constructor() {
    super("Structured contract output is invalid", "FATAL");
    this.name = "StructuredContractOutputError";
  }
}
