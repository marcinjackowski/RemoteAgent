/**
 * `fetch`-backed Discord REST transport (RA-006, AUDIT-01 HIGH-03, AUDIT-02 HIGH-07).
 *
 * Production wiring for {@link RestTransport}. Failure classification is CONSERVATIVE
 * because a `fetch` rejection can happen AFTER the server already accepted a
 * non-idempotent request and merely lost the response — replaying that would
 * duplicate the write. So a transport-level failure is surfaced as the
 * PROVABLY-NOT-DELIVERED {@link DiscordUnavailableError} (safe to retry) ONLY when
 * we have positive proof the request never took effect:
 *
 *   - the request is a READ (GET/HEAD), which has no side effect regardless; or
 *   - the connection was provably never established (DNS failure, connection
 *     refused), so no bytes reached the server.
 *
 * Every other write failure (a socket dropped mid/after send, an aborted request,
 * an unknown cause) is surfaced as {@link DiscordTransportError} — an UNKNOWN
 * outcome the dispatcher must NOT blindly replay (it records AMBIGUOUS instead).
 * Any HTTP response — including 4xx/5xx — is returned to the adapter, which
 * classifies it. The bot token lives only in the request headers the adapter
 * builds; this module never logs request contents.
 */
import { DiscordTransportError, DiscordUnavailableError } from "@remoteagent/discord";

import type { RestMethod, RestRequest, RestResponse, RestTransport } from "./rest-gateway.js";

/** Methods with no side effect: a failed attempt is always safe to retry. */
const READ_METHODS: ReadonlySet<RestMethod> = new Set<RestMethod>(["GET"]);

/**
 * Node/undici error `code`s that PROVE the request never reached the server (the
 * connection was never established), so even a non-idempotent write is safe to
 * retry. Anything not listed here is treated as an unknown outcome for writes.
 */
const PROVEN_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_INVALID_URL",
]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  return undefined;
}

export function fetchRestTransport(baseUrl = "https://discord.com"): RestTransport {
  return async (req: RestRequest): Promise<RestResponse> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${req.path}`, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const code = errorCode(error);
      const provablyNotSent =
        READ_METHODS.has(req.method) || (code !== undefined && PROVEN_NOT_SENT_CODES.has(code));
      if (provablyNotSent) {
        throw new DiscordUnavailableError(`discord transport failed before send: ${detail}`);
      }
      // A write that may have reached the server: outcome UNKNOWN, do not replay.
      throw new DiscordTransportError(
        `discord ${req.method} transport failed with unknown outcome: ${detail}`,
      );
    }
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status, headers, body };
  };
}
