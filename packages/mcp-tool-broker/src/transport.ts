/**
 * The MCP transport boundary: version negotiation, bounded reads, and the
 * distinction between "did not happen" and "may have happened".
 *
 * The transport is a PORT, not an HTTP client. RA-023 supplies an AgentCore
 * Gateway adapter behind this same interface and RA-021 needs no network code to
 * prove its properties — a fake malicious server (`WU-06`) exercises every path
 * that matters. Writing a real HTTP client here would add an untested dependency
 * and prove nothing extra.
 *
 * **Dispatch is observable, and that is the point.** {@link ToolTransport.call}
 * receives an `onDispatch` callback that it MUST invoke immediately before the
 * request leaves the process. Everything about AC5 hangs on this: after
 * `onDispatch` fires, a timeout means `AMBIGUOUS`, and before it fires the same
 * timeout means `FAILED`. Without an explicit signal the executor would have to
 * guess, and guessing wrong in the safe direction (`always AMBIGUOUS`) makes every
 * pre-flight failure unretryable, while guessing wrong in the unsafe direction
 * turns a completed call into a duplicate.
 *
 * **A timeout does not cancel the remote side.** `AbortController` stops us
 * *listening*; it does not stop the server from having already served the request.
 * That asymmetry is why a post-dispatch timeout can never be reported as a read
 * failure, and it is the same reasoning RA-012 and RA-017 applied to local effects
 * and to GitLab writes.
 *
 * **Protocol version is negotiated, not assumed.** An unsupported version is a
 * refusal (`VERSION_UNSUPPORTED`) before any tool call is attempted, because a
 * server speaking a version we do not implement may interpret our arguments
 * differently than we intend — and for a scoped read, a differently-interpreted
 * argument is a cross-scope read.
 */
import { RefusalCode, ToolBrokerRefusal } from "./contracts.js";

/** Protocol versions this broker implements. A closed set, checked on connect. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26"];

/** Default ceiling on how long one call may take before it is abandoned. */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/**
 * Raised when a request may have reached the server but produced no usable
 * response.
 *
 * A distinct type rather than a flag: the whole difference between this and a
 * definite failure is which next steps are permitted, and a `boolean` on a shared
 * error class is one `if` away from being ignored.
 */
export class ToolTransportAmbiguous extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolTransportAmbiguous";
  }
}

/** Raised when the request demonstrably did not take effect. Retryable. */
export class ToolTransportFailed extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolTransportFailed";
  }
}

export type TransportCallInput = Readonly<{
  toolName: string;
  /** Validated arguments only. The broker never forwards a raw proposal. */
  arguments: Readonly<Record<string, unknown>>;
  /**
   * Invoked immediately before the request leaves the process. After this fires, a
   * failure is `AMBIGUOUS`; before it, `FAILED`.
   */
  onDispatch: () => void;
  signal: AbortSignal;
}>;

/**
 * The transport port.
 *
 * `listTools` returns raw advertisements — `UNTRUSTED_DATA`, compared against the
 * registry, never merged into it. `call` returns an opaque JSON value that the
 * executor normalizes and bounds; the transport itself makes no policy decisions.
 */
export type ToolTransport = Readonly<{
  /** Protocol version the server offers. Checked before any call. */
  protocolVersion(): Promise<string>;
  /** Raw `tools/list`. Untrusted claims, for conformance comparison only. */
  listTools(): Promise<readonly unknown[]>;
  /** Raw `tools/call`. Must invoke `onDispatch` before sending. */
  call(input: TransportCallInput): Promise<unknown>;
}>;

/**
 * Assert the server speaks a version we implement, or refuse.
 *
 * Fail-closed on an unrecognised version rather than attempting a best-effort
 * call: the failure mode of a version mismatch on a *scoped read* is that our
 * scoping argument means something else on the far side.
 */
export function assertSupportedProtocolVersion(version: string): void {
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new ToolBrokerRefusal(
      RefusalCode.VERSION_UNSUPPORTED,
      `server protocol version ${version} is not implemented by this broker ` +
        `(supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
    );
  }
}

export type BoundedCallResult =
  | { readonly kind: "RESPONSE"; readonly value: unknown; readonly dispatched: true }
  /** Timed out or lost AFTER dispatch: the call may have taken effect. */
  | { readonly kind: "AMBIGUOUS"; readonly reason: string; readonly dispatched: true }
  /** Failed BEFORE dispatch: nothing was sent. Retryable. */
  | { readonly kind: "FAILED"; readonly reason: string; readonly dispatched: false };

/**
 * Run one transport call under a deadline, classifying the outcome by whether the
 * request was dispatched.
 *
 * The classification is deliberately based on the `onDispatch` signal rather than
 * on the shape of the error. An error type can be wrong or wrapped; "did we send
 * it" is a fact the transport is in a position to state, and the executor's whole
 * retry policy depends on it.
 *
 * Note the ordering in the timeout branch: `dispatched` is read AFTER the race
 * settles, so a request that went out microseconds before the deadline is still
 * classified `AMBIGUOUS`. Reading it earlier would create a window in which a
 * dispatched call is reported as a clean failure — and a clean failure is
 * retryable.
 */
export async function callWithDeadline(
  transport: ToolTransport,
  input: Readonly<{
    toolName: string;
    arguments: Readonly<Record<string, unknown>>;
    timeoutMs: number;
    onDispatch: () => void;
  }>,
): Promise<BoundedCallResult> {
  const controller = new AbortController();
  let dispatched = false;
  const markDispatched = (): void => {
    if (!dispatched) {
      dispatched = true;
      input.onDispatch();
    }
  };

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => {
      // Abort stops US listening. It does NOT unwind whatever the server already
      // did, which is exactly why a post-dispatch timeout is not a failure.
      controller.abort();
      resolve("TIMEOUT");
    }, input.timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      transport
        .call({
          toolName: input.toolName,
          arguments: input.arguments,
          onDispatch: markDispatched,
          signal: controller.signal,
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      timeout,
    ]);

    if (outcome === "TIMEOUT") {
      return dispatched
        ? {
            kind: "AMBIGUOUS",
            reason: `no response within ${String(input.timeoutMs)}ms after dispatch`,
            dispatched: true,
          }
        : {
            kind: "FAILED",
            reason: `timed out before the request was dispatched`,
            dispatched: false,
          };
    }
    if (outcome.ok) {
      return { kind: "RESPONSE", value: outcome.value, dispatched: true };
    }
    // A thrown error after dispatch is still ambiguous unless the transport
    // explicitly says the request did not take effect. `ToolTransportFailed` is
    // that statement; anything else is treated as unknown, which is the fail-safe
    // direction for a side effect and the fail-noisy one for a read.
    if (!dispatched || outcome.error instanceof ToolTransportFailed) {
      return {
        kind: "FAILED",
        reason: errorMessage(outcome.error),
        dispatched: false,
      };
    }
    return { kind: "AMBIGUOUS", reason: errorMessage(outcome.error), dispatched: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "transport failed without an error message";
}
