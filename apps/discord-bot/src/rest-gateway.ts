/**
 * Production Discord REST adapter (RA-006, AUDIT-01 HIGH-03, AUDIT-02 HIGH-07/MEDIUM-11).
 *
 * Implements the {@link DiscordGateway} port the dispatcher depends on plus the
 * inbound {@link InteractionAcknowledger}, using the Discord HTTP API. The HTTP
 * transport is INJECTED ({@link RestTransport}) so:
 *
 *   - production wires a `fetch`-backed transport ({@link fetchRestTransport});
 *   - contract tests replay recorded, redacted fixtures with NO network and NO
 *     real token.
 *
 * Failure classification is conservative and matches the port contract
 * (gateway.ts, AUDIT-01 HIGH-01):
 *
 *   - HTTP 429 → {@link DiscordRateLimitError} (retry-after honoured);
 *   - a transport-level failure the transport proves was NOT sent →
 *     {@link DiscordUnavailableError} (safe to retry) — otherwise the transport
 *     raises an unknown-outcome error that the dispatcher records as AMBIGUOUS;
 *   - any other non-2xx (5xx, 4xx) or unexpected shape → {@link DiscordApiError},
 *     an UNKNOWN outcome that the dispatcher must NOT blindly replay.
 *
 * Reconciliation reads (find case thread/anchor/status message) are PAGINATED and
 * matched by the deterministic marker AND, for messages, the bot's own author id,
 * so recovery adopts exactly the object this bot created rather than an unrelated
 * message or pin (AUDIT-02 HIGH-07).
 *
 * The bot token is held here and attached as the `Authorization` header; it is
 * NEVER logged and never returned to the model.
 */
import {
  DiscordRateLimitError,
  DiscordTransportError,
  DiscordUnavailableError,
  bodyHasMarker,
  clampToLimit,
  nameHasMarker,
  threadNameTagToken,
  MAX_MESSAGE_LENGTH,
  MAX_THREAD_NAME_LENGTH,
  type CreatedThread,
  type DiscordGateway,
  type InteractionAcknowledger,
  type MessageButton,
  type SentMessage,
  type ThreadState,
} from "@remoteagent/discord";

export type RestMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RestRequest {
  method: RestMethod;
  /** API path beneath the version base, e.g. `/channels/123/messages`. */
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface RestResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** The injected HTTP transport. A throw is a transport-level failure. */
export type RestTransport = (req: RestRequest) => Promise<RestResponse>;

/** Raised for a non-2xx response whose side-effect outcome is UNKNOWN. */
export class DiscordApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export interface DiscordRestConfig {
  /** Bot token (kept here, never logged). */
  token: string;
  /** Guild id used to enumerate active threads for reconciliation. */
  guildId: string;
  /** The bot's own application/user id, used to match its authored messages. */
  botUserId: string;
  /** API base path (defaults to Discord v10). */
  apiBase?: string;
  /** Max pages to scan when reconciling (bounds an unbounded history). */
  maxReconcilePages?: number;
}

const BUTTON_STYLE: Record<MessageButton["style"], number> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
};

/** Interaction callback types (Discord). 5 = deferred, 4 = channel message. */
const INTERACTION_CALLBACK = { CHANNEL_MESSAGE: 4, DEFERRED: 5 } as const;

const PAGE_LIMIT = 100;

export class DiscordRestGateway implements DiscordGateway, InteractionAcknowledger {
  readonly #transport: RestTransport;
  readonly #token: string;
  readonly #guildId: string;
  readonly #botUserId: string;
  readonly #apiBase: string;
  readonly #maxPages: number;

  public constructor(transport: RestTransport, config: DiscordRestConfig) {
    this.#transport = transport;
    this.#token = config.token;
    this.#guildId = config.guildId;
    this.#botUserId = config.botUserId;
    this.#apiBase = config.apiBase ?? "/api/v10";
    this.#maxPages = config.maxReconcilePages ?? 10;
  }

  public async findCaseThread(channelId: string, caseTag: string): Promise<CreatedThread | null> {
    // Active guild threads (single call), then this channel's archived public
    // threads, paginated by the `before` timestamp cursor.
    const active = await this.#request("GET", `/guilds/${this.#guildId}/threads/active`);
    const activeMatch = threadsOf(active.body).find(
      (t) => t.parent_id === channelId && nameHasMarker(t.name, caseTag),
    );
    if (activeMatch !== undefined) {
      return { threadId: String(activeMatch.id), rootMessageId: String(activeMatch.id) };
    }
    let before: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const query = before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
      const res = await this.#request(
        "GET",
        `/channels/${channelId}/threads/archived/public?limit=${PAGE_LIMIT}${query}`,
      );
      const threads = threadsOf(res.body);
      const match = threads.find(
        (t) => t.parent_id === channelId && nameHasMarker(t.name, caseTag),
      );
      if (match !== undefined) {
        return { threadId: String(match.id), rootMessageId: String(match.id) };
      }
      const hasMore = Boolean((res.body as { has_more?: unknown } | undefined)?.has_more);
      if (!hasMore || threads.length === 0) break;
      before = archivedCursor(threads);
      if (before === undefined) break;
    }
    return null;
  }

  public async findCaseAnchor(channelId: string, caseTag: string): Promise<SentMessage | null> {
    // Scan the channel's recent messages (paginated) for the bot's anchor carrying
    // the case tag, so an orphan anchor (posted before its thread) is reconciled.
    let before: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const query = before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
      const res = await this.#request(
        "GET",
        `/channels/${channelId}/messages?limit=${PAGE_LIMIT}${query}`,
      );
      const messages = messagesOf(res.body);
      if (messages.length === 0) break;
      const match = messages.find(
        (m) => this.#authoredByBot(m) && bodyHasMarker(m.content, caseTag),
      );
      if (match !== undefined) return { messageId: String(match.id) };
      before = String(messages[messages.length - 1]!.id);
    }
    return null;
  }

  public async createAnchorMessage(input: {
    channelId: string;
    caseTag: string;
    content: string;
  }): Promise<SentMessage> {
    const res = await this.#request("POST", `/channels/${input.channelId}/messages`, {
      body: { content: clampToLimit(input.content, MAX_MESSAGE_LENGTH) },
    });
    return { messageId: requireId(res.body, "anchor message") };
  }

  public async startThread(input: {
    channelId: string;
    anchorMessageId: string;
    caseTag: string;
    threadName: string;
  }): Promise<CreatedThread> {
    const thread = await this.#request(
      "POST",
      `/channels/${input.channelId}/messages/${input.anchorMessageId}/threads`,
      { body: { name: threadNameWithTag(input.threadName, input.caseTag) } },
    );
    return { threadId: requireId(thread.body, "thread"), rootMessageId: input.anchorMessageId };
  }

  public async sendThreadMessage(input: {
    threadId: string;
    content: string;
    components?: readonly MessageButton[];
  }): Promise<SentMessage> {
    const body: Record<string, unknown> = {
      content: clampToLimit(input.content, MAX_MESSAGE_LENGTH),
    };
    if (input.components !== undefined && input.components.length > 0) {
      body.components = [
        {
          type: 1,
          components: input.components.map((b) => ({
            type: 2,
            style: BUTTON_STYLE[b.style],
            label: b.label,
            custom_id: b.customId,
          })),
        },
      ];
    }
    const res = await this.#request("POST", `/channels/${input.threadId}/messages`, { body });
    return { messageId: requireId(res.body, "message") };
  }

  public async sendStatusMessage(input: {
    threadId: string;
    content: string;
  }): Promise<SentMessage> {
    const res = await this.#request("POST", `/channels/${input.threadId}/messages`, {
      body: { content: clampToLimit(input.content, MAX_MESSAGE_LENGTH) },
    });
    return { messageId: requireId(res.body, "status message") };
  }

  public async editMessage(input: {
    threadId: string;
    messageId: string;
    content: string;
  }): Promise<void> {
    await this.#request("PATCH", `/channels/${input.threadId}/messages/${input.messageId}`, {
      body: { content: clampToLimit(input.content, MAX_MESSAGE_LENGTH) },
    });
  }

  public async pinMessage(input: { threadId: string; messageId: string }): Promise<void> {
    await this.#request("PUT", `/channels/${input.threadId}/pins/${input.messageId}`);
  }

  public async getThread(threadId: string): Promise<ThreadState | null> {
    const res = await this.#request("GET", `/channels/${threadId}`, { allowStatuses: [404] });
    if (res.status === 404) return null;
    const archived = Boolean(
      (res.body as { thread_metadata?: { archived?: boolean } })?.thread_metadata?.archived,
    );
    return { threadId, archived };
  }

  public async unarchiveThread(threadId: string): Promise<void> {
    await this.#request("PATCH", `/channels/${threadId}`, { body: { archived: false } });
  }

  public async findStatusMessage(threadId: string, marker: string): Promise<SentMessage | null> {
    // The projected status is the bot's own message carrying the marker. Prefer a
    // pinned match, but a marked bot message that was not yet pinned (crash before
    // pin) is still adopted — never an unrelated pin (AUDIT-02 HIGH-07).
    const pins = await this.#request("GET", `/channels/${threadId}/pins`);
    const pinned = messagesOf(pins.body).find(
      (m) => this.#authoredByBot(m) && bodyHasMarker(m.content, marker),
    );
    if (pinned !== undefined) return { messageId: String(pinned.id) };

    let before: string | undefined;
    for (let page = 0; page < this.#maxPages; page += 1) {
      const query = before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
      const res = await this.#request(
        "GET",
        `/channels/${threadId}/messages?limit=${PAGE_LIMIT}${query}`,
      );
      const messages = messagesOf(res.body);
      if (messages.length === 0) break;
      const match = messages.find(
        (m) => this.#authoredByBot(m) && bodyHasMarker(m.content, marker),
      );
      if (match !== undefined) return { messageId: String(match.id) };
      before = String(messages[messages.length - 1]!.id);
    }
    return null;
  }

  public async acknowledgeInteraction(input: {
    interactionId: string;
    interactionToken: string;
    deferred?: boolean;
  }): Promise<void> {
    // Interaction callbacks are not authenticated by the bot token but by the
    // interaction token in the path; still routed through the same transport. The
    // interaction token is a CREDENTIAL, so it is registered as a secret to redact
    // from any error/log AND the diagnostic path is a redacted label — the token
    // never reaches an error message or the logger (AUDIT-03 HIGH-15).
    await this.#request(
      "POST",
      `/interactions/${input.interactionId}/${input.interactionToken}/callback`,
      {
        body: {
          type:
            input.deferred === false
              ? INTERACTION_CALLBACK.CHANNEL_MESSAGE
              : INTERACTION_CALLBACK.DEFERRED,
        },
        secrets: [input.interactionToken],
        redactedPath: `/interactions/${input.interactionId}/[REDACTED]/callback`,
      },
    );
  }

  #authoredByBot(message: RawMessage): boolean {
    return message.author?.id !== undefined && String(message.author.id) === this.#botUserId;
  }

  async #request(
    method: RestMethod,
    path: string,
    options: {
      body?: unknown;
      allowStatuses?: readonly number[];
      /** Extra secrets (beyond the bot token) to redact from any error/log. */
      secrets?: readonly string[];
      /** A redacted stand-in for `path` used in error text (never the raw path). */
      redactedPath?: string;
    } = {},
  ): Promise<RestResponse> {
    const allowStatuses = options.allowStatuses ?? [];
    // The bot token and any per-call secret (e.g. an interaction token) must never
    // appear in an error, log or serialized detail (AGENTS.md, AUDIT-03 HIGH-15).
    const secrets = [this.#token, ...(options.secrets ?? [])].filter((s) => s.length > 0);
    const safePath = options.redactedPath ?? path;
    const headers: Record<string, string> = {
      authorization: `Bot ${this.#token}`,
      "content-type": "application/json",
    };
    let res: RestResponse;
    try {
      res = await this.#transport({
        method,
        path: `${this.#apiBase}${path}`,
        headers,
        body: options.body,
      });
    } catch (error) {
      // AUDIT-04 HIGH-20: a transport rejection is `unknown` — it may be a string,
      // a plain object, an array, or a custom Error whose message/stack/cause OR
      // enumerable fields (e.g. `detail.url`, `detail.authorization`) embed a
      // credential. Do NOT propagate the original value or any of its fields.
      // Fail-closed: normalize it to an ALLOWLISTED error carrying only a safe
      // class (preserving the retry classification) and a redacted message.
      throw normalizeTransportError(error, secrets);
    }
    if (res.status >= 200 && res.status < 300) return res;
    if (allowStatuses.includes(res.status)) return res;
    if (res.status === 429) {
      throw new DiscordRateLimitError(retryAfterMs(res));
    }
    // 4xx/5xx: the write's outcome is unknown/failed; never a "safe" auto-replay.
    // The message is a redacted method + path (no token, no body).
    throw new DiscordApiError(
      res.status,
      `discord ${method} ${redactSecrets(safePath, secrets)} → ${res.status}`,
    );
  }
}

function retryAfterMs(res: RestResponse): number {
  const bodyRetry = (res.body as { retry_after?: number } | undefined)?.retry_after;
  if (typeof bodyRetry === "number") return Math.ceil(bodyRetry * 1000);
  const header = res.headers["retry-after"];
  const seconds = header === undefined ? NaN : Number(header);
  return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 1000;
}

interface RawThread {
  id: unknown;
  name?: unknown;
  parent_id?: unknown;
  thread_metadata?: { archive_timestamp?: unknown };
}

interface RawMessage {
  id: unknown;
  content?: unknown;
  author?: { id?: unknown };
}

function threadsOf(body: unknown): RawThread[] {
  const threads = (body as { threads?: unknown } | undefined)?.threads;
  return Array.isArray(threads) ? (threads as RawThread[]) : [];
}

function messagesOf(body: unknown): RawMessage[] {
  return Array.isArray(body) ? (body as RawMessage[]) : [];
}

/** Oldest archived thread's archive timestamp, used as the `before` cursor. */
function archivedCursor(threads: RawThread[]): string | undefined {
  const last = threads[threads.length - 1];
  const ts = last?.thread_metadata?.archive_timestamp;
  return typeof ts === "string" ? ts : undefined;
}

/** Compose a thread name that embeds the case tag within Discord's 100-char cap. */
function threadNameWithTag(threadName: string, caseTag: string): string {
  const token = threadNameTagToken(caseTag);
  const suffix = ` ${token}`;
  if (nameHasMarker(threadName, caseTag)) {
    return clampToLimit(threadName, MAX_THREAD_NAME_LENGTH);
  }
  // The marker is fixed-length, so this always fits: reserve room for the suffix,
  // then clamp the whole name defensively (AUDIT-03 HIGH-14 / MEDIUM-17).
  const room = Math.max(0, MAX_THREAD_NAME_LENGTH - suffix.length);
  return clampToLimit(`${threadName.slice(0, room)}${suffix}`, MAX_THREAD_NAME_LENGTH);
}

/** Remove every known secret from a string (AUDIT-03 HIGH-15). */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/**
 * Fail-closed normalization of an UNKNOWN transport rejection (AUDIT-04 HIGH-20).
 *
 * A rejection may be ANY value (string, plain object, array, or a custom `Error`
 * subclass with enumerable fields). Its `String`/message/stack/`JSON.stringify`
 * output — or any nested field — could embed the bot or interaction token. Rather
 * than mutate and re-throw the original (which leaks arbitrary fields through
 * `JSON.stringify`/telemetry), build a FRESH allowlisted error that carries ONLY:
 *
 *   - a safe classification that preserves the retry contract: a proven-safe
 *     {@link DiscordUnavailableError} or {@link DiscordRateLimitError} stays
 *     retryable; EVERYTHING else (string/object/array/custom/unknown) collapses to
 *     the unknown-outcome {@link DiscordTransportError}, which is NOT auto-retried;
 *   - a redacted message.
 *
 * No original field (custom properties, `cause`, `detail`, …) is copied, so a
 * credential cannot survive in the serialized error, its stack, or a log.
 */
function normalizeTransportError(error: unknown, secrets: readonly string[]): Error {
  if (error instanceof DiscordRateLimitError) {
    return new DiscordRateLimitError(error.retryAfterMs, redactSecrets(error.message, secrets));
  }
  if (error instanceof DiscordUnavailableError) {
    return new DiscordUnavailableError(redactSecrets(error.message, secrets));
  }
  // Any other rejection is an UNKNOWN outcome. Derive a message ONLY from a string
  // rejection or an Error's own message (never by serializing an arbitrary object,
  // which could splice in nested credentials), then redact it.
  const raw =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "unknown transport rejection";
  return new DiscordTransportError(
    `discord transport failed with unknown outcome: ${redactSecrets(raw, secrets)}`,
  );
}

function requireId(body: unknown, what: string): string {
  const id = (body as { id?: unknown } | undefined)?.id;
  if (id === undefined || id === null) {
    throw new DiscordApiError(0, `discord response missing id for ${what}`);
  }
  return String(id);
}
