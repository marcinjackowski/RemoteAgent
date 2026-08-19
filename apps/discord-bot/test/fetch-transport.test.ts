/**
 * RA-006 fetch transport failure-classification tests (AUDIT-02 HIGH-07 Dowód 1).
 *
 * The production transport must NOT report a non-idempotent write as "safe to
 * retry" just because `fetch` rejected — the request may have reached the server
 * and only its response was lost. These tests stub the global `fetch` to prove:
 *
 *   - a READ (GET) transport failure is safe (DiscordUnavailableError);
 *   - a WRITE (POST) failure with a proven "never connected" code is safe;
 *   - a WRITE failure with any other cause is an UNKNOWN outcome
 *     (DiscordTransportError), which the dispatcher records as AMBIGUOUS.
 */
import {
  DiscordTransportError,
  DiscordUnavailableError,
  isSafeToRetry,
} from "@remoteagent/discord";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRestTransport } from "../src/fetch-transport.js";
import type { RestRequest } from "../src/rest-gateway.js";

const req = (method: RestRequest["method"]): RestRequest => ({
  method,
  path: "/api/v10/channels/c1/messages",
  headers: { authorization: "Bot REDACTED" },
  body: method === "GET" ? undefined : { content: "x" },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRestTransport failure classification (RA-006)", () => {
  it("treats a GET transport failure as provably-not-delivered (safe)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("socket hang up"))),
    );
    const transport = fetchRestTransport();
    const error = await transport(req("GET")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordUnavailableError);
    expect(isSafeToRetry(error)).toBe(true);
  });

  it("treats a POST connection-refused as provably-not-delivered (safe)", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(refused)),
    );
    const transport = fetchRestTransport();
    const error = await transport(req("POST")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordUnavailableError);
    expect(isSafeToRetry(error)).toBe(true);
  });

  it("treats a POST failure with an unknown cause as UNKNOWN (not safe to replay)", async () => {
    const dropped = Object.assign(new TypeError("terminated"), {
      cause: { code: "UND_ERR_SOCKET" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(dropped)),
    );
    const transport = fetchRestTransport();
    const error = await transport(req("POST")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordTransportError);
    expect(error).not.toBeInstanceOf(DiscordUnavailableError);
    expect(isSafeToRetry(error)).toBe(false);
  });

  it("passes an HTTP response (even 5xx) through to the adapter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 503 })),
      ),
    );
    const transport = fetchRestTransport();
    const res = await transport(req("POST"));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: "boom" });
  });
});
