/**
 * The outbound Discord API port (RA-006).
 *
 * RA-006 deliberately does NOT bind to a live Discord connection: real
 * integrations are out of scope (task "Out of scope"). Instead the interface
 * layer talks to this narrow port, which production backs with discord.js and
 * tests back with an in-memory {@link FakeDiscordGateway}. Keeping the port small
 * and effectful-only (each method is a single Discord side effect) is what lets
 * the dispatcher reason about idempotency and ordering without knowing whether it
 * is talking to a real gateway or a recorded fixture.
 *
 * Failures are CLASSIFIED so the dispatcher never replays a write whose outcome
 * is unknown (Master Plan §6.2, AUDIT-01 HIGH-01):
 *
 *   - {@link DiscordRateLimitError} (HTTP 429) and {@link DiscordUnavailableError}
 *     mean the request was PROVABLY NOT delivered (rejected before any effect).
 *     They are the only errors safe to retry automatically; the retry wrapper
 *     (see `retry.ts`) honours a 429's `retryAfterMs`.
 *   - Any OTHER throw (a lost response, a 5xx, a generic error) has an UNKNOWN
 *     outcome: the write may already have taken effect. The dispatcher must NOT
 *     retry it; it records the side effect's intent as AMBIGUOUS instead.
 *
 * A production adapter MUST map transport failures to this taxonomy conservatively
 * (default: unknown/ambiguous), so "probably safe" is never assumed.
 */

/** A created Discord message. */
export interface SentMessage {
  messageId: string;
}

/** A created (or reopened) Discord thread and its anchor message. */
export interface CreatedThread {
  threadId: string;
  rootMessageId: string;
}

/** Minimal thread state used to decide whether to reopen an archived thread. */
export interface ThreadState {
  threadId: string;
  archived: boolean;
}

export interface DiscordGateway {
  /**
   * Reconcile an existing case thread before creating a new one. Production
   * implements this by searching the channel's active + archived threads
   * (PAGINATED) for the deterministic case tag in the thread name; returning the
   * existing thread makes thread creation idempotent even across a crash between
   * the Discord side effect and the local commit (so a redelivered "case created"
   * event never spawns a second thread). Returns `null` when no thread for the tag
   * exists yet.
   */
  findCaseThread(channelId: string, caseTag: string): Promise<CreatedThread | null>;

  /**
   * Reconcile a case's ANCHOR message (AUDIT-02 HIGH-07): search the channel's
   * recent messages (PAGINATED, bot-authored) for the deterministic case tag in
   * the body. This detects an ORPHAN anchor — a crash after the anchor was posted
   * but before its thread was started — so root creation can resume by starting
   * the thread off the existing anchor rather than posting a second one. Returns
   * `null` when no anchor for the tag exists yet.
   */
  findCaseAnchor(channelId: string, caseTag: string): Promise<SentMessage | null>;

  /**
   * Post the case's anchor (root) message in the channel. The `caseTag` MUST be
   * embedded in the body so {@link findCaseAnchor} can later reconcile it.
   */
  createAnchorMessage(input: {
    channelId: string;
    caseTag: string;
    content: string;
  }): Promise<SentMessage>;

  /**
   * Start a thread off an already-posted anchor message. The `caseTag` MUST be
   * embedded in the thread name so {@link findCaseThread} can later reconcile it.
   */
  startThread(input: {
    channelId: string;
    anchorMessageId: string;
    caseTag: string;
    threadName: string;
  }): Promise<CreatedThread>;

  /** Post a message into an existing thread. */
  sendThreadMessage(input: {
    threadId: string;
    content: string;
    /** Optional decision/approval buttons rendered on the message. */
    components?: readonly MessageButton[];
  }): Promise<SentMessage>;

  /** Post the pinned status message (first status projection for a case). */
  sendStatusMessage(input: { threadId: string; content: string }): Promise<SentMessage>;

  /**
   * Trigger the ephemeral "typing…" indicator in a thread (RA-035). Discord shows it for
   * ~10s or until the next message. It creates NO durable object and has no id, so it is a
   * disposable UX hint — safe to skip on any failure (the dispatcher never retries it).
   */
  triggerTyping(input: { threadId: string }): Promise<void>;

  /** Edit an existing message in place (idempotent status re-projection). */
  editMessage(input: { threadId: string; messageId: string; content: string }): Promise<void>;

  /** Pin a message (the projected case status). Idempotent on the Discord side. */
  pinMessage(input: { threadId: string; messageId: string }): Promise<void>;

  /** Read a thread's state, or `null` if it no longer exists. */
  getThread(threadId: string): Promise<ThreadState | null>;

  /** Reopen an archived thread so a new message can be posted (criterion 4). */
  unarchiveThread(threadId: string): Promise<void>;

  /**
   * Reconcile the case's pinned status message after a crash (AUDIT-02 HIGH-07):
   * search the thread's BOT-AUTHORED messages (PAGINATED) for the deterministic
   * status `marker`, returning the existing status message or `null`. This makes
   * the otherwise non-idempotent "first status message" create recoverable even
   * before it was pinned — a crash between the send and the pin/commit is healed
   * by finding the marked message again rather than posting (or editing an
   * unrelated pinned message) a second time.
   */
  findStatusMessage(threadId: string, marker: string): Promise<SentMessage | null>;
}

/** A single interactive button attached to a message (decision/approval). */
export interface MessageButton {
  /** Opaque, signed-by-construction custom id (see `custom-id.ts`). */
  customId: string;
  label: string;
  style: "primary" | "secondary" | "success" | "danger";
}

/** Raised on a Discord 429; carries the server-provided cool-down. */
export class DiscordRateLimitError extends Error {
  public readonly retryAfterMs: number;

  public constructor(retryAfterMs: number, message = "discord rate limited") {
    super(message);
    this.name = new.target.name;
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

/**
 * Raised when a Discord request was PROVABLY NOT delivered (e.g. the connection
 * was refused before the request was sent, or the server returned a definitive
 * "not processed" status). Safe to retry automatically because it cannot have had
 * a side effect. A production adapter must ONLY use this for pre-effect failures.
 */
export class DiscordUnavailableError extends Error {
  public constructor(message = "discord temporarily unavailable") {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raised when a Discord request failed at the transport level with an UNKNOWN
 * outcome — the request may already have reached the server and taken effect
 * (e.g. the connection dropped AFTER a non-idempotent POST was written, or the
 * response was lost). It is deliberately NOT a {@link DiscordUnavailableError},
 * so {@link isSafeToRetry} returns `false` and the dispatcher records the side
 * effect as AMBIGUOUS instead of blindly replaying it (AUDIT-02 HIGH-07). A
 * transport only uses {@link DiscordUnavailableError} when it can PROVE the
 * request was never sent (a read, or a connection that was never established).
 */
export class DiscordTransportError extends Error {
  public constructor(message = "discord transport failed with unknown outcome") {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Acknowledges an inbound Discord interaction (button/slash command) within
 * Discord's short response window. The gateway ONLY delivers the interaction; the
 * bot must answer it (an immediate ACK/defer) via the REST API or Discord marks
 * the command/button as failed even though the domain side effect began
 * (AUDIT-02 MEDIUM-11). Kept separate from {@link DiscordGateway} because it is an
 * inbound-path concern, not part of the dispatcher's outbound port.
 */
export interface InteractionAcknowledger {
  /**
   * Answer an interaction. `deferred` (the default for our flows) tells Discord
   * the bot received it and will follow up, clearing the user-facing spinner
   * without posting a visible reply.
   */
  acknowledgeInteraction(input: {
    interactionId: string;
    interactionToken: string;
    deferred?: boolean;
  }): Promise<void>;
}
