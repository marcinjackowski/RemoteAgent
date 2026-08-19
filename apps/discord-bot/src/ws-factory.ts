/**
 * Concrete production gateway socket factory (RA-006, AUDIT-02 MEDIUM-11).
 *
 * {@link DiscordGatewaySession} takes an injected {@link GatewaySocketFactory} so
 * it can be exercised with a fake socket in tests. This module provides the REAL
 * factory used in a deployment, backed by the platform's global `WebSocket`
 * (Node ≥ 22 / undici, matching the global `fetch` the REST transport uses). No
 * extra dependency is introduced. Discord requires the JSON encoding query on the
 * gateway URL, which is appended here if the caller did not.
 *
 * Frame data may arrive as a string or binary; it is normalized to a string
 * before being handed to the session, which parses JSON. The socket carries NO
 * secret — the bot token is only ever sent inside Identify/Resume frames the
 * session builds.
 */
import type {
  GatewaySocket,
  GatewaySocketFactory,
  GatewaySocketHandlers,
} from "./gateway-session.js";

/** Append Discord's required `v` + `encoding=json` query params if absent. */
function withGatewayQuery(url: string): string {
  const hasQuery = url.includes("?");
  if (url.includes("encoding=")) return url;
  const sep = hasQuery ? "&" : "?";
  return `${url}${sep}v=10&encoding=json`;
}

/**
 * Build a {@link GatewaySocketFactory} backed by the global `WebSocket`. Throws if
 * the runtime has no global `WebSocket` (surfaces a clear deployment requirement
 * rather than failing opaquely at connect time).
 */
export function nodeWebSocketFactory(): GatewaySocketFactory {
  const WS = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof WS !== "function") {
    throw new Error(
      "nodeWebSocketFactory requires a global WebSocket (Node >= 22); none is available",
    );
  }
  const WebSocketCtor = WS as {
    new (url: string): {
      addEventListener(type: string, listener: (event: unknown) => void): void;
      send(data: string): void;
      close(): void;
    };
  };
  return (url: string, handlers: GatewaySocketHandlers): GatewaySocket => {
    const ws = new WebSocketCtor(withGatewayQuery(url));
    // A real socket commonly emits BOTH `error` and `close` for one disconnect.
    // Forward the terminal event AT MOST ONCE per socket so a single break maps to
    // a single reconnect (AUDIT-03 MEDIUM-18); the session is additionally
    // generation-fenced, but a once-guard here keeps the contract at the source.
    let closed = false;
    const closeOnce = (code: number): void => {
      if (closed) return;
      closed = true;
      handlers.onClose(code);
    };
    ws.addEventListener("open", () => handlers.onOpen());
    ws.addEventListener("message", (event: unknown) => {
      const data = (event as { data?: unknown }).data;
      handlers.onMessage(typeof data === "string" ? data : String(data));
    });
    ws.addEventListener("close", (event: unknown) => {
      const code = (event as { code?: unknown }).code;
      closeOnce(typeof code === "number" ? code : 1006);
    });
    ws.addEventListener("error", () => {
      // Surface as a close so the session's reconnect logic engages; the real
      // close event usually follows but is coalesced by the once-guard.
      closeOnce(1006);
    });
    return {
      send: (data: string) => ws.send(data),
      close: () => ws.close(),
    };
  };
}
