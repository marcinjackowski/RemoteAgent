/**
 * In-memory fakes for RA-006 tests (task scope: "fake orchestrator do testów bez
 * Bedrocka" and contract tests with recorded fixtures, no secrets).
 *
 * {@link FakeDiscordGateway} implements the {@link DiscordGateway} port entirely
 * in memory and can be programmed to simulate the adverse conditions the audit
 * focuses on: 429 rate limits, archived threads, and duplicate/lost deliveries.
 * It records every side effect so a test can assert exactly-once behaviour.
 *
 * {@link FakeOrchestrator} stands in for the (later) Bedrock-backed orchestrator:
 * it produces case events onto the transactional outbox with correctly reserved
 * per-case sequences, so the dispatcher can be exercised end to end without any
 * model or real Discord connection.
 */
import type { Database, OutboxRepository, DiscordBindingRepository } from "@remoteagent/database";
import { randomUUID } from "node:crypto";

import { DISCORD_EVENT_TYPES, DISCORD_OUTBOX_AGGREGATE } from "./messages.js";
import { caseTag } from "./markers.js";
import {
  DiscordRateLimitError,
  type CreatedThread,
  type DiscordGateway,
  type MessageButton,
  type SentMessage,
  type ThreadState,
} from "./gateway.js";

export interface RecordedMessage {
  threadId: string;
  messageId: string;
  content: string;
  components: readonly MessageButton[];
  pinned: boolean;
}

interface FakeThread {
  threadId: string;
  channelId: string;
  caseTag: string;
  archived: boolean;
}

/** An anchor (root) message posted directly in a channel (not a thread). */
interface FakeAnchor {
  messageId: string;
  channelId: string;
  caseTag: string;
  content: string;
}

export class FakeDiscordGateway implements DiscordGateway {
  #seq = 0;
  readonly #threads = new Map<string, FakeThread>();
  readonly #tagIndex = new Map<string, string>();
  readonly #anchors = new Map<string, FakeAnchor>();
  readonly #messages = new Map<string, RecordedMessage>();

  /** Ordered log of every message/root created, for ordering assertions. */
  public readonly log: RecordedMessage[] = [];
  public createThreadCalls = 0;
  public createAnchorCalls = 0;

  /** Pending programmable failures, consumed one per matching call. */
  #rateLimitQueue: number[] = [];
  /** Pending pre-effect unknown-outcome failures (thrown BEFORE any side effect). */
  #unknownQueue = 0;
  /** Pending post-effect failures: the write IS recorded, then an unknown error is
   *  thrown — simulating a lost response after a successful Discord send. */
  #postEffectFailures = 0;
  /** When set, the next `sendThreadMessage` whose content includes this marker
   *  records the message and THEN throws (targeted inter-chunk failure test). */
  #postEffectFailMarker: string | null = null;
  /** Pending pre-effect unknown failures for `startThread` (thread NOT created). */
  #startThreadFailures = 0;
  /**
   * Optional async hook awaited at the START of `sendThreadMessage` (before the
   * message is recorded). Lets a test HOLD a winner "in flight" while a concurrent
   * loser runs, exercising the ownership fence (AUDIT-03 MEDIUM-16).
   */
  #beforeSendThreadMessage: ((content: string) => Promise<void>) | null = null;

  /** Install a hook awaited before each `sendThreadMessage` records its message. */
  public onBeforeSendThreadMessage(hook: (content: string) => Promise<void>): void {
    this.#beforeSendThreadMessage = hook;
  }

  /** Program the NEXT write call(s) to throw a 429 with the given cool-downs. */
  public queueRateLimit(...retryAfterMs: number[]): void {
    this.#rateLimitQueue.push(...retryAfterMs);
  }

  /**
   * Program the next `count` write call(s) to throw a generic (unknown-outcome)
   * error BEFORE performing any side effect. Models a pre-effect failure whose
   * outcome the adapter cannot prove safe.
   */
  public queueUnknownFailure(count = 1): void {
    this.#unknownQueue += count;
  }

  /**
   * Program the next `count` `sendThreadMessage` call(s) to RECORD the message and
   * THEN throw a generic (unknown-outcome) error — the crux of AUDIT-01 HIGH-01:
   * a response lost after the write already took effect. Automatic replay must be
   * halted (AMBIGUOUS), never repeated.
   */
  public queuePostEffectFailure(count = 1): void {
    this.#postEffectFailures += count;
  }

  /**
   * Program the `sendThreadMessage` whose content includes `marker` to record the
   * message and THEN throw — a targeted lost-response on a specific chunk (e.g. the
   * second chunk of a multi-part message) so the inter-chunk crash window is tested.
   */
  public failPostEffectOnContent(marker: string): void {
    this.#postEffectFailMarker = marker;
  }

  /**
   * Program the next `count` `startThread` call(s) to throw an unknown-outcome
   * error BEFORE creating the thread — modelling a crash after the anchor was
   * posted but before its thread was started (the orphan-anchor window).
   */
  public failStartThread(count = 1): void {
    this.#startThreadFailures += count;
  }

  #maybeRateLimit(): void {
    const next = this.#rateLimitQueue.shift();
    if (next !== undefined) {
      throw new DiscordRateLimitError(next);
    }
    if (this.#unknownQueue > 0) {
      this.#unknownQueue -= 1;
      throw new Error("simulated unknown-outcome failure (pre-effect)");
    }
  }

  #id(prefix: string): string {
    this.#seq += 1;
    // A per-instance random suffix keeps ids globally unique across gateway
    // instances that share one database (each test builds a fresh gateway).
    return `${prefix}-${randomUUID().slice(0, 8)}-${this.#seq}`;
  }

  public findCaseThread(_channelId: string, tag: string): Promise<CreatedThread | null> {
    const threadId = this.#tagIndex.get(tag);
    if (threadId === undefined) return Promise.resolve(null);
    const thread = this.#threads.get(threadId);
    return Promise.resolve({
      threadId,
      rootMessageId: thread?.threadId ?? threadId,
    });
  }

  public findCaseAnchor(channelId: string, tag: string): Promise<SentMessage | null> {
    const anchor = [...this.#anchors.values()].find(
      (a) => a.channelId === channelId && a.caseTag === tag,
    );
    return Promise.resolve(anchor === undefined ? null : { messageId: anchor.messageId });
  }

  public createAnchorMessage(input: {
    channelId: string;
    caseTag: string;
    content: string;
  }): Promise<SentMessage> {
    this.#maybeRateLimit();
    this.createAnchorCalls += 1;
    const messageId = this.#id("root");
    this.#anchors.set(messageId, {
      messageId,
      channelId: input.channelId,
      caseTag: input.caseTag,
      content: input.content,
    });
    return Promise.resolve({ messageId });
  }

  public startThread(input: {
    channelId: string;
    anchorMessageId: string;
    caseTag: string;
    threadName: string;
  }): Promise<CreatedThread> {
    this.#maybeRateLimit();
    if (this.#startThreadFailures > 0) {
      this.#startThreadFailures -= 1;
      return Promise.reject(new Error("simulated startThread failure (thread not created)"));
    }
    this.createThreadCalls += 1;
    // A thread started from a message shares its id with the anchor message.
    const threadId = input.anchorMessageId;
    this.#threads.set(threadId, {
      threadId,
      channelId: input.channelId,
      caseTag: input.caseTag,
      archived: false,
    });
    this.#tagIndex.set(input.caseTag, threadId);
    const anchor = this.#anchors.get(input.anchorMessageId);
    this.#recordMessage(threadId, input.anchorMessageId, anchor?.content ?? "", []);
    return Promise.resolve({ threadId, rootMessageId: input.anchorMessageId });
  }

  /**
   * Test helper (NOT part of the port): create a full root anchor + thread in one
   * call, mirroring how a crashed prior attempt would have left Discord.
   */
  public async createRootThread(input: {
    channelId: string;
    caseTag: string;
    threadName: string;
    rootContent: string;
  }): Promise<CreatedThread> {
    const anchor = await this.createAnchorMessage({
      channelId: input.channelId,
      caseTag: input.caseTag,
      content: input.rootContent,
    });
    return this.startThread({
      channelId: input.channelId,
      anchorMessageId: anchor.messageId,
      caseTag: input.caseTag,
      threadName: input.threadName,
    });
  }

  public sendThreadMessage(input: {
    threadId: string;
    content: string;
    components?: readonly MessageButton[];
  }): Promise<SentMessage> {
    return this.#sendThreadMessage(input);
  }

  async #sendThreadMessage(input: {
    threadId: string;
    content: string;
    components?: readonly MessageButton[];
  }): Promise<SentMessage> {
    const hook = this.#beforeSendThreadMessage;
    if (hook !== null) {
      // Consume the hook once so only the first (winner) send is held.
      this.#beforeSendThreadMessage = null;
      await hook(input.content);
    }
    this.#maybeRateLimit();
    const thread = this.#threads.get(input.threadId);
    if (thread === undefined) {
      throw new Error(`unknown thread ${input.threadId}`);
    }
    if (thread.archived) {
      // Real Discord rejects posting to an archived thread; the caller must
      // unarchive first. Model that here so reconnect/archived tests are real.
      throw new Error(`thread ${input.threadId} is archived`);
    }
    const messageId = this.#id("msg");
    this.#recordMessage(input.threadId, messageId, input.content, input.components ?? []);
    if (this.#postEffectFailures > 0) {
      // The message WAS recorded (the side effect happened); now the response is
      // "lost". The dispatcher must treat this as AMBIGUOUS and never replay it.
      this.#postEffectFailures -= 1;
      throw new Error("simulated response lost after successful send");
    }
    if (this.#postEffectFailMarker !== null && input.content.includes(this.#postEffectFailMarker)) {
      this.#postEffectFailMarker = null;
      throw new Error("simulated response lost after successful send (marker)");
    }
    return { messageId };
  }

  public sendStatusMessage(input: { threadId: string; content: string }): Promise<SentMessage> {
    this.#maybeRateLimit();
    const messageId = this.#id("status");
    this.#recordMessage(input.threadId, messageId, input.content, []);
    if (this.#postEffectFailures > 0) {
      this.#postEffectFailures -= 1;
      return Promise.reject(new Error("simulated response lost after successful status send"));
    }
    return Promise.resolve({ messageId });
  }

  public editMessage(input: {
    threadId: string;
    messageId: string;
    content: string;
  }): Promise<void> {
    this.#maybeRateLimit();
    const message = this.#messages.get(input.messageId);
    if (message !== undefined) {
      message.content = input.content;
    }
    return Promise.resolve();
  }

  public pinMessage(input: { threadId: string; messageId: string }): Promise<void> {
    this.#maybeRateLimit();
    const message = this.#messages.get(input.messageId);
    if (message !== undefined) {
      message.pinned = true;
    }
    return Promise.resolve();
  }

  /** Thread ids for which `triggerTyping` was called, in call order (RA-035). */
  public readonly typingCalls: string[] = [];

  public triggerTyping(input: { threadId: string }): Promise<void> {
    // Honour a programmed failure so a test can prove the dispatcher SWALLOWS it.
    this.#maybeRateLimit();
    this.typingCalls.push(input.threadId);
    return Promise.resolve();
  }

  public getThread(threadId: string): Promise<ThreadState | null> {
    const thread = this.#threads.get(threadId);
    return Promise.resolve(thread === undefined ? null : { threadId, archived: thread.archived });
  }

  public findStatusMessage(threadId: string, marker: string): Promise<SentMessage | null> {
    // Production reconciles the bot's own marked, pinned status message; the fake
    // mirrors that by finding a recorded status message that carries the marker.
    const status = [...this.#messages.values()].find(
      (m) =>
        m.threadId === threadId && m.messageId.startsWith("status-") && m.content.includes(marker),
    );
    return Promise.resolve(status === undefined ? null : { messageId: status.messageId });
  }

  public unarchiveThread(threadId: string): Promise<void> {
    const thread = this.#threads.get(threadId);
    if (thread !== undefined) {
      thread.archived = false;
    }
    return Promise.resolve();
  }

  /** Test helper: force a thread into the archived state. */
  public archive(threadId: string): void {
    const thread = this.#threads.get(threadId);
    if (thread !== undefined) {
      thread.archived = true;
    }
  }

  /** Test helper: all messages in a thread, in creation order. */
  public messagesIn(threadId: string): RecordedMessage[] {
    return this.log.filter((m) => m.threadId === threadId);
  }

  #recordMessage(
    threadId: string,
    messageId: string,
    content: string,
    components: readonly MessageButton[],
  ): void {
    const record: RecordedMessage = {
      threadId,
      messageId,
      content,
      components,
      pinned: false,
    };
    this.#messages.set(messageId, record);
    this.log.push(record);
  }
}

/**
 * A minimal producer that enqueues case events onto the outbox with correctly
 * reserved per-case sequences. Each enqueue is atomic with the sequence
 * reservation (one transaction), mirroring how a real producer would emit an
 * outbox message inside its business transaction.
 */
export class FakeOrchestrator {
  readonly #db: Database;
  readonly #outbox: OutboxRepository;
  readonly #bindings: DiscordBindingRepository;

  public constructor(deps: {
    db: Database;
    outbox: OutboxRepository;
    bindings: DiscordBindingRepository;
  }) {
    this.#db = deps.db;
    this.#outbox = deps.outbox;
    this.#bindings = deps.bindings;
  }

  /** Open a case: reserve seq 1 and enqueue the root-thread event. */
  public async openCase(input: {
    caseId: string;
    ownerId: string;
    provider: "jira" | "gmail" | "calendar" | "gitlab" | "discord";
    alias: "private" | "sondermind";
    channelId: string;
    title: string;
    body: string;
  }): Promise<string> {
    await this.#bindings.ensure(this.#db, {
      caseId: input.caseId,
      ownerId: input.ownerId,
      channelId: input.channelId,
    });
    return this.#db.withTransaction(async (tx) => {
      await this.#bindings.lockForUpdate(tx, input.caseId);
      const seq = await this.#bindings.reserveSeq(tx, input.caseId);
      const row = await this.#outbox.enqueue(tx, {
        aggregate: DISCORD_OUTBOX_AGGREGATE,
        aggregateId: input.caseId,
        eventType: DISCORD_EVENT_TYPES.ROOT_THREAD,
        payload: {
          case_id: input.caseId,
          owner_id: input.ownerId,
          seq,
          provider: input.provider,
          alias: input.alias,
          title: input.title,
          body: input.body,
        },
      });
      return row.outbox_id;
    });
  }

  /** Post a message turn into the case thread. */
  public async postMessage(input: {
    caseId: string;
    body: string;
    decision?: {
      decision_id: string;
      checkpoint_revision: number;
      options: { option_id: string; label: string }[];
    };
    approval?: { approval_id: string; checkpoint_revision: number };
  }): Promise<string> {
    return this.#db.withTransaction(async (tx) => {
      await this.#bindings.lockForUpdate(tx, input.caseId);
      const seq = await this.#bindings.reserveSeq(tx, input.caseId);
      const payload: Record<string, unknown> = {
        case_id: input.caseId,
        seq,
        body: input.body,
      };
      if (input.decision !== undefined) payload.decision = input.decision;
      if (input.approval !== undefined) payload.approval = input.approval;
      const row = await this.#outbox.enqueue(tx, {
        aggregate: DISCORD_OUTBOX_AGGREGATE,
        aggregateId: input.caseId,
        eventType: DISCORD_EVENT_TYPES.THREAD_MESSAGE,
        payload,
      });
      return row.outbox_id;
    });
  }

  /** Enqueue a status projection update (no sequence; idempotent upsert). */
  public async updateStatus(input: {
    caseId: string;
    status: string;
    goal: string;
    currentPhase: string;
    summary: string;
    checkpointRevision: number;
  }): Promise<string> {
    return this.#db.withTransaction(async (tx) => {
      const row = await this.#outbox.enqueue(tx, {
        aggregate: DISCORD_OUTBOX_AGGREGATE,
        aggregateId: input.caseId,
        eventType: DISCORD_EVENT_TYPES.STATUS,
        payload: {
          case_id: input.caseId,
          status: input.status,
          goal: input.goal,
          current_phase: input.currentPhase,
          summary: input.summary,
          checkpoint_revision: input.checkpointRevision,
        },
      });
      return row.outbox_id;
    });
  }
}

/** Test-only re-export so specs can build the deterministic case tag. */
export { caseTag };
