/**
 * Outbox → Discord dispatcher (RA-006).
 *
 * Turns a claimed transactional-outbox message (RA-004) into an idempotent,
 * ordered Discord side effect. Two invariants are enforced here, neither of them
 * trusting the model:
 *
 *   - EXACTLY-ONCE (acceptance criterion 1): every delivery is gated behind a
 *     receipt keyed by the originating outbox id. The receipt check runs under
 *     the per-case binding row lock, so a redelivered outbox event (the outbox is
 *     at-least-once) is a no-op. Thread creation additionally reconciles an
 *     existing thread by a deterministic case tag, so a crash between the Discord
 *     side effect and the local commit never spawns a second thread.
 *   - ORDERING (acceptance criterion 4): each ordered send carries a producer
 *     reserved, gap-free sequence. A message is delivered only when its seq is
 *     exactly `delivered_seq + 1`; an out-of-order claim (possible after a retry
 *     or reconnect) is DEFERRED and retried later, never reordered. Different
 *     cases lock different binding rows and so proceed in parallel (criterion 3).
 *
 * A send that ultimately fails (rate limits exhausted, transient error) rolls the
 * transaction back: no receipt is written and `delivered_seq` does not advance, so
 * a later relay pass retries the exact same slot.
 */
import type { AuditLogRepository, Database } from "@remoteagent/database";
import type { SecretRedactor } from "@remoteagent/observability";
import { randomUUID } from "node:crypto";
import type * as z from "zod";

import type { ChannelRegistry } from "./channels.js";
import { encodeApproval, encodeDecision } from "./custom-id.js";
import { caseTag, markerSubtextOverhead, statusMarker, withMarkerSubtext } from "./markers.js";
import type { DiscordGateway, MessageButton } from "./gateway.js";
import {
  DISCORD_EVENT_TYPES,
  rootThreadPayload,
  statusPayload,
  threadMessagePayload,
  type RootThreadPayload,
  type StatusPayload,
  type ThreadMessagePayload,
} from "./messages.js";
import { isSafeToRetry, withDiscordRetry, type RetryOptions } from "./retry.js";
import { renderStatusMessage } from "./status.js";
import {
  MAX_MESSAGE_LENGTH,
  sanitizeMessage,
  sanitizeSingle,
  sanitizeThreadName,
} from "./sanitize.js";
import type {
  DiscordBindingRepository,
  DiscordBindingRow,
  DiscordReceiptRepository,
  DiscordSendIntentRepository,
} from "@remoteagent/database";

export class DiscordPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raised when an outbox payload's derived route does not match the case's durable
 * binding (owner/channel). Routing is authoritative and server-side: it is taken
 * from the persisted binding, never widened by the payload (AUDIT-01 HIGH-02).
 * A mismatch means a producer bug or a replayed/altered payload; it is a
 * fail-closed, non-retryable error so it never publishes a case's content into
 * the wrong (e.g. cross-account) channel.
 */
export class DiscordRoutingError extends Error {
  public readonly caseId: string;

  public constructor(caseId: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.caseId = caseId;
  }
}

/**
 * Raised when a Discord side effect's outcome is UNKNOWN and cannot be reconciled
 * (Master Plan §6.2, AUDIT-01 HIGH-01). The side effect's intent has been durably
 * marked `AMBIGUOUS`, so automatic replay is halted: a later attempt re-reads the
 * intent and throws this again WITHOUT re-issuing the write. The outbox relay
 * (RA-004) treats the throw as a publish failure: it retries with backoff and,
 * after `maxAttempts`, moves the dispatch row to the durable DEAD_LETTER state
 * (`OutboxRepository.listDeadLettered` is the operator's DLQ view). Forwarding the
 * DLQ to the `#system` channel is a later task; RA-006 stops at fail-closed
 * halting plus the durable DEAD_LETTER record rather than blindly repeating a write
 * that may already have taken effect.
 */
export class DiscordAmbiguousError extends Error {
  public readonly caseId: string;
  public readonly idempotencyKey: string;

  public constructor(caseId: string, idempotencyKey: string, options?: { cause?: unknown }) {
    super(
      `ambiguous discord side effect for case ${caseId} (${idempotencyKey}); automatic replay halted`,
      options,
    );
    this.name = new.target.name;
    this.caseId = caseId;
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Thrown when an ordered send cannot be delivered yet because an earlier message
 * for the case has not been delivered. It is a TRANSIENT signal: the outbox relay
 * treats a throw as "not published" and retries the slot on a later pass.
 */
export class DiscordDeferredError extends Error {
  public readonly caseId: string;
  public readonly expectedSeq: number;
  public readonly actualSeq: number;

  public constructor(caseId: string, expectedSeq: number, actualSeq: number) {
    super(
      `deferred discord delivery for case ${caseId}: expected seq ${expectedSeq}, got ${actualSeq}`,
    );
    this.name = new.target.name;
    this.caseId = caseId;
    this.expectedSeq = expectedSeq;
    this.actualSeq = actualSeq;
  }
}

export type DeliveryStatus = "delivered" | "duplicate";

export interface DeliveryResult {
  status: DeliveryStatus;
  caseId: string;
  threadId: string | null;
}

export interface DispatcherDeps {
  db: Database;
  bindings: DiscordBindingRepository;
  receipts: DiscordReceiptRepository;
  /** Durable per-side-effect intent ledger (AUDIT-01 HIGH-01). */
  intents: DiscordSendIntentRepository;
  gateway: DiscordGateway;
  channels: ChannelRegistry;
  retry?: RetryOptions;
  redactor?: SecretRedactor;
  audit?: AuditLogRepository;
  /**
   * Bounded lease (ms) for a claimed send intent (AUDIT-03 MEDIUM-16). While the
   * lease is live an in-flight owner's attempt is ACTIVE and cannot be transitioned
   * by a concurrent loser; once it lapses a recovering caller may resolve a
   * provably-abandoned attempt. Defaults to 30s.
   */
  intentLeaseMs?: number;
}

/** The Discord ids produced (or reconciled) by a single side effect. */
interface SideEffectIds {
  discordMessageId: string | null;
  discordThreadId: string | null;
}

export interface OutboxMessage {
  outboxId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Re-exported so producers/tests build the deterministic case tag/marker. */
export { caseTag, statusMarker } from "./markers.js";

export class DiscordDispatcher {
  readonly #deps: DispatcherDeps;
  readonly #leaseMs: number;

  public constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    this.#leaseMs = deps.intentLeaseMs ?? 30_000;
  }

  /**
   * Deliver one claimed outbox message. Returns `duplicate` for an already
   * delivered event (idempotent no-op) and `delivered` for a fresh delivery.
   * Throws {@link DiscordDeferredError} to defer an out-of-order ordered send and
   * rethrows any gateway failure so the relay retries the slot.
   */
  public async deliver(message: OutboxMessage): Promise<DeliveryResult> {
    switch (message.eventType) {
      case DISCORD_EVENT_TYPES.ROOT_THREAD:
        return this.#deliverRootThread(message.outboxId, this.#parse(rootThreadPayload, message));
      case DISCORD_EVENT_TYPES.THREAD_MESSAGE:
        return this.#deliverThreadMessage(
          message.outboxId,
          this.#parse(threadMessagePayload, message),
        );
      case DISCORD_EVENT_TYPES.STATUS:
        return this.#deliverStatus(message.outboxId, this.#parse(statusPayload, message));
      default:
        throw new DiscordPayloadError(`unknown discord event type: ${message.eventType}`);
    }
  }

  #parse<T>(schema: z.ZodType<T>, message: OutboxMessage): T {
    const parsed = schema.safeParse(message.payload);
    if (!parsed.success) {
      throw new DiscordPayloadError(
        `invalid payload for ${message.eventType} (outbox ${message.outboxId})`,
      );
    }
    return parsed.data;
  }

  async #deliverRootThread(outboxId: string, p: RootThreadPayload): Promise<DeliveryResult> {
    const { db, bindings, receipts, channels } = this.#deps;
    // HIGH-02: routing is authoritative and server-side. `ensure` sets the channel
    // ONLY on first creation; for an existing case the persisted channel/owner win
    // and a payload that derives a different route is rejected fail-closed, so a
    // replayed or altered payload can never move a case's content to another
    // (e.g. cross-account) channel.
    const requestedChannelId = channels.routeChannelId(p.provider, p.alias);
    const binding0 = await bindings.ensure(db, {
      caseId: p.case_id,
      ownerId: p.owner_id,
      channelId: requestedChannelId,
    });
    this.#assertAuthoritativeRoute(binding0, p.owner_id, requestedChannelId);

    // The anchor message carries the FIRST chunk of the body; any further chunks
    // are delivered as continuation messages below so nothing is silently
    // truncated (AUDIT-01 MEDIUM-06). The first chunk RESERVES room for the case
    // marker appended to the anchor, so the final anchor body stays within
    // Discord's 2000-char limit even at the boundary (AUDIT-03 MEDIUM-17).
    const tag = caseTag(p.case_id);
    const anchorMarkerRoom = MAX_MESSAGE_LENGTH - markerSubtextOverhead(tag);
    const rootChunks = sanitizeMessage(
      p.body.trim().length > 0 ? p.body : p.title,
      MAX_MESSAGE_LENGTH,
      anchorMarkerRoom,
    );

    // Phase 0 (under the per-case lock): dedupe, order-gate, and resolve/create the
    // root anchor + thread. Everything here runs while HOLDING the row lock, so a
    // case has a SINGLE writer for its root creation — that is what lets a durable
    // side effect safely re-perform after reconciling that its object provably does
    // not exist (AUDIT-02 HIGH-07/HIGH-08). Both non-idempotent POSTs (anchor, then
    // thread) are individually guarded by a durable, reconcilable intent, so a
    // crash or lost response after either leaves a recoverable marker rather than an
    // orphan or a duplicate.
    const pre = await db.withTransaction(async (tx) => {
      const binding = await bindings.lockForUpdate(tx, p.case_id);
      if (binding === null) {
        throw new DiscordPayloadError(`no binding for case ${p.case_id} after ensure`);
      }
      this.#assertAuthoritativeRoute(binding, p.owner_id, requestedChannelId);
      const existing = await receipts.find(tx, outboxId);
      if (existing !== null) {
        return { duplicate: true as const, threadId: binding.thread_id, rootMessageId: null };
      }
      this.#assertInOrder(p.case_id, binding.delivered_seq, p.seq);

      const channelId = binding.channel_id;
      let threadId = binding.thread_id;
      let rootMessageId = binding.root_message_id;
      if (threadId === null || rootMessageId === null) {
        const anchorContent = withMarkerSubtext(rootChunks[0]!, tag);
        const created = await this.#createRoot(p.case_id, outboxId, {
          channelId,
          tag,
          anchorContent,
          threadName: sanitizeThreadName(p.title),
        });
        threadId = created.discordThreadId;
        rootMessageId = created.discordMessageId;
        await bindings.setThread(tx, p.case_id, {
          threadId: threadId!,
          rootMessageId: rootMessageId!,
        });
      }
      return { duplicate: false as const, threadId, rootMessageId };
    });
    if (pre.duplicate) {
      return { status: "duplicate", caseId: p.case_id, threadId: pre.threadId };
    }
    const threadId = pre.threadId!;

    // Continuation chunks (beyond the anchor) are non-reconcilable thread messages,
    // so each is guarded by a durable intent (HIGH-01) instead of being replayed.
    if (rootChunks.length > 1) {
      await this.#sendChunks({
        caseId: p.case_id,
        outboxId,
        threadId,
        chunks: rootChunks.slice(1),
        stepPrefix: "root_chunk",
      });
    }

    // Phase final (under the per-case lock): record the receipt and advance the
    // delivered sequence atomically. Recorded only AFTER every chunk succeeded, so
    // a crash mid-fan-out re-runs the (idempotent) chunk intents on redelivery.
    return db.withTransaction(async (tx) => {
      const binding = await bindings.lockForUpdate(tx, p.case_id);
      const existing = await receipts.find(tx, outboxId);
      if (existing !== null) {
        return { status: "duplicate", caseId: p.case_id, threadId };
      }
      await receipts.record(tx, {
        dedupeKey: outboxId,
        caseId: p.case_id,
        kind: "ROOT_THREAD",
        seq: p.seq,
        discordMessageId: pre.rootMessageId,
        discordThreadId: threadId,
      });
      const advanced = await bindings.advanceDelivered(tx, p.case_id, p.seq);
      if (!advanced) {
        throw new DiscordDeferredError(p.case_id, Number(binding?.delivered_seq ?? 0) + 1, p.seq);
      }
      return { status: "delivered", caseId: p.case_id, threadId };
    });
  }

  /**
   * Create (or reconcile) a case's root anchor + thread as TWO independently
   * recoverable, durably-intented side effects (AUDIT-02 HIGH-07). Runs while the
   * caller holds the per-case row lock (single writer), so reconciling that an
   * object does not exist is authoritative proof it was never created:
   *
   *   1. `root_anchor` — post the anchor message (marker embedded). Reconciled by
   *      an existing thread's root, or by an orphan anchor found in the channel.
   *   2. `root_thread` — start the thread off the anchor (marker in the name).
   *      Reconciled by finding the existing thread.
   */
  async #createRoot(
    caseId: string,
    outboxId: string,
    input: { channelId: string; tag: string; anchorContent: string; threadName: string },
  ): Promise<{ discordThreadId: string; discordMessageId: string }> {
    const { gateway } = this.#deps;
    const anchor = await this.#durableSideEffect({
      caseId,
      outboxId,
      step: "root_anchor",
      reconcile: async () => {
        const thread = await withDiscordRetry(
          () => gateway.findCaseThread(input.channelId, input.tag),
          this.#deps.retry,
        );
        if (thread !== null) {
          return { discordMessageId: thread.rootMessageId, discordThreadId: thread.threadId };
        }
        const orphan = await withDiscordRetry(
          () => gateway.findCaseAnchor(input.channelId, input.tag),
          this.#deps.retry,
        );
        return orphan === null
          ? null
          : { discordMessageId: orphan.messageId, discordThreadId: null };
      },
      perform: async () => {
        const sent = await gateway.createAnchorMessage({
          channelId: input.channelId,
          caseTag: input.tag,
          content: input.anchorContent,
        });
        return { discordMessageId: sent.messageId, discordThreadId: null };
      },
    });
    const rootMessageId = anchor.discordMessageId!;

    const thread = await this.#durableSideEffect({
      caseId,
      outboxId,
      step: "root_thread",
      reconcile: async () => {
        const found = await withDiscordRetry(
          () => gateway.findCaseThread(input.channelId, input.tag),
          this.#deps.retry,
        );
        return found === null
          ? null
          : { discordMessageId: found.rootMessageId, discordThreadId: found.threadId };
      },
      perform: async () => {
        const started = await gateway.startThread({
          channelId: input.channelId,
          anchorMessageId: rootMessageId,
          caseTag: input.tag,
          threadName: input.threadName,
        });
        return { discordMessageId: started.rootMessageId, discordThreadId: started.threadId };
      },
    });
    return {
      discordThreadId: thread.discordThreadId!,
      discordMessageId: thread.discordMessageId ?? rootMessageId,
    };
  }

  async #deliverThreadMessage(outboxId: string, p: ThreadMessagePayload): Promise<DeliveryResult> {
    const { db, bindings, receipts, gateway } = this.#deps;

    // Phase 0 (under the per-case lock): dedupe and order-gate before any side
    // effect. The lock is released before the (possibly slow, chunked) send.
    const pre = await db.withTransaction(async (tx) => {
      const binding = await bindings.lockForUpdate(tx, p.case_id);
      if (binding === null || binding.thread_id === null) {
        // The case's root thread has not been created yet; defer.
        throw new DiscordDeferredError(p.case_id, 1, p.seq);
      }
      const existing = await receipts.find(tx, outboxId);
      if (existing !== null) {
        return { duplicate: true as const, threadId: binding.thread_id };
      }
      this.#assertInOrder(p.case_id, binding.delivered_seq, p.seq);
      return { duplicate: false as const, threadId: binding.thread_id };
    });
    if (pre.duplicate) {
      return { status: "duplicate", caseId: p.case_id, threadId: pre.threadId };
    }
    const threadId = pre.threadId;

    // Reopen an archived thread before posting (scope: reopening threads;
    // acceptance criterion 4). getThread is a read and unarchive is idempotent, so
    // both are safe to repeat and need no intent (Master Plan §6.2).
    const state = await withDiscordRetry(() => gateway.getThread(threadId), this.#deps.retry);
    if (state !== null && state.archived) {
      await withDiscordRetry(() => gateway.unarchiveThread(threadId), this.#deps.retry);
    }

    const chunks = sanitizeMessage(p.body);
    const components = this.#buttonsFor(p);
    // Each chunk is a durable, non-reconcilable side effect (HIGH-01 / MEDIUM-06):
    // an unknown outcome halts as AMBIGUOUS instead of being replayed.
    const firstMessageId = await this.#sendChunks({
      caseId: p.case_id,
      outboxId,
      threadId,
      chunks,
      stepPrefix: "chunk",
      components,
    });

    // Phase final (under the per-case lock): record the receipt and advance order.
    return db.withTransaction(async (tx) => {
      const binding = await bindings.lockForUpdate(tx, p.case_id);
      const existing = await receipts.find(tx, outboxId);
      if (existing !== null) {
        return { status: "duplicate", caseId: p.case_id, threadId };
      }
      await receipts.record(tx, {
        dedupeKey: outboxId,
        caseId: p.case_id,
        kind: "THREAD_MESSAGE",
        seq: p.seq,
        discordMessageId: firstMessageId,
        discordThreadId: threadId,
      });
      const advanced = await bindings.advanceDelivered(tx, p.case_id, p.seq);
      if (!advanced) {
        throw new DiscordDeferredError(p.case_id, Number(binding?.delivered_seq ?? 0) + 1, p.seq);
      }
      return { status: "delivered", caseId: p.case_id, threadId };
    });
  }

  async #deliverStatus(outboxId: string, p: StatusPayload): Promise<DeliveryResult> {
    const { db, bindings, receipts, gateway } = this.#deps;
    // The status projection is a single, bounded edit of ONE pinned message and is
    // reconcilable/idempotent, so — unlike chunked thread messages — it runs wholly
    // under the per-case row lock. That makes the monotonic revision gate atomic
    // (AUDIT-01 MEDIUM-05): a late/reordered projection can never roll the pinned
    // message back, and different cases still proceed in parallel (different rows).
    return db.withTransaction(async (tx) => {
      const binding = await bindings.lockForUpdate(tx, p.case_id);
      if (binding === null || binding.thread_id === null) {
        // Status projection needs an existing thread; defer until it exists.
        throw new DiscordDeferredError(p.case_id, 1, 0);
      }
      const existing = await receipts.find(tx, outboxId);
      if (existing !== null) {
        return { status: "duplicate", caseId: p.case_id, threadId: binding.thread_id };
      }
      const threadId = binding.thread_id;

      // Monotonic gate: an older-or-equal revision is a deterministic no-op that
      // still records a receipt (so the outbox stops redelivering) but never edits
      // the pinned message backwards.
      const current = binding.last_status_revision;
      const isNewer = current === null || Number(current) < p.checkpoint_revision;
      if (!isNewer) {
        await receipts.record(tx, {
          dedupeKey: outboxId,
          caseId: p.case_id,
          kind: "STATUS_UPSERT",
          seq: null,
          discordMessageId: binding.status_message_id,
          discordThreadId: threadId,
        });
        return { status: "delivered", caseId: p.case_id, threadId };
      }

      const content = renderStatusMessage({
        caseId: p.case_id,
        status: p.status,
        goal: p.goal,
        currentPhase: p.current_phase,
        summary: p.summary,
        openQuestions: p.open_questions,
        nextActions: p.next_actions,
        blockers: p.blockers,
        pendingApprovals: p.pending_approvals,
        checkpointRevision: p.checkpoint_revision,
      });
      // A deterministic, bot-owned marker embedded in the body lets the first
      // projection be reconciled after a crash BEFORE the pin (AUDIT-02 HIGH-07):
      // recovery finds this exact message rather than editing an unrelated pin.
      // The rendered body RESERVES room for the marker so the final pinned body
      // stays within Discord's 2000-char limit at the boundary (AUDIT-03 MEDIUM-17).
      const marker = statusMarker(p.case_id);
      const markedContent = withMarkerSubtext(
        sanitizeSingle(content, MAX_MESSAGE_LENGTH - markerSubtextOverhead(marker)),
        marker,
      );

      let statusMessageId = binding.status_message_id;
      if (statusMessageId === null) {
        // First projection: send it behind a durable, reconcilable intent so a
        // crash/lost response never posts (or leaves) a second status message. The
        // whole status upsert runs under the per-case lock, so the reconcile is a
        // single-writer authoritative check (HIGH-07/HIGH-08).
        const sent = await this.#durableSideEffect({
          caseId: p.case_id,
          outboxId,
          step: "status_send",
          reconcile: async () => {
            const found = await withDiscordRetry(
              () => gateway.findStatusMessage(threadId, marker),
              this.#deps.retry,
            );
            return found === null
              ? null
              : { discordMessageId: found.messageId, discordThreadId: threadId };
          },
          perform: async () => {
            const created = await gateway.sendStatusMessage({ threadId, content: markedContent });
            return { discordMessageId: created.messageId, discordThreadId: threadId };
          },
        });
        statusMessageId = sent.discordMessageId!;
        await bindings.setStatusMessage(tx, p.case_id, statusMessageId);
        // Editing is idempotent; ensure a RECONCILED message shows current content.
        await withDiscordRetry(
          () =>
            gateway.editMessage({ threadId, messageId: statusMessageId!, content: markedContent }),
          this.#deps.retry,
        );
        // Pin last: idempotent on Discord's side and recovered by findStatusMessage
        // if a crash happens before it, so it needs no separate intent.
        await withDiscordRetry(
          () => gateway.pinMessage({ threadId, messageId: statusMessageId! }),
          this.#deps.retry,
        );
      } else {
        // Editing is idempotent (it overwrites content), so it is safe to repeat.
        await withDiscordRetry(
          () =>
            gateway.editMessage({ threadId, messageId: statusMessageId!, content: markedContent }),
          this.#deps.retry,
        );
      }

      // Atomically advance the durable revision under the same lock as the edit.
      await bindings.advanceStatusRevision(tx, p.case_id, p.checkpoint_revision);
      await receipts.record(tx, {
        dedupeKey: outboxId,
        caseId: p.case_id,
        kind: "STATUS_UPSERT",
        seq: null,
        discordMessageId: statusMessageId,
        discordThreadId: threadId,
      });
      return { status: "delivered", caseId: p.case_id, threadId };
    });
  }

  /**
   * Run a Discord side effect behind a durable, single-winner intent (Master Plan
   * §6.2, AUDIT-02 HIGH-07/HIGH-08):
   *
   *   1. atomically CLAIM the intent (`<outboxId>:<step>`). Exactly one concurrent
   *      caller inserts the STARTED row and owns the write; every other caller
   *      observes the existing row.
   *   2. the owner performs the write, retrying ONLY provably-safe errors, then
   *      marks the intent SUCCEEDED.
   *
   * Recovery depends on whether a `reconcile` callback is supplied:
   *
   *   - RECONCILABLE side effects (root anchor/thread, status send) MUST be run
   *     while holding the per-case row lock (single writer). A recovered/observed
   *     non-SUCCEEDED intent is reconciled: if the object exists it is adopted
   *     (SUCCEEDED); if it provably does NOT exist the intent is re-owned and the
   *     write re-performed. On an unknown-outcome failure the reconcile is retried
   *     before falling back to AMBIGUOUS.
   *   - NON-RECONCILABLE side effects (thread-message chunks) cannot be replayed:
   *     an observed in-flight/AMBIGUOUS intent halts as {@link DiscordAmbiguousError}
   *     and a RETRYABLE (provably-not-delivered) one is re-owned and retried.
   *
   * A provably-safe failure keeps the row as RETRYABLE (preserving attempt
   * evidence) so a later pass re-owns and re-issues it (AUDIT-02 MEDIUM-12).
   */
  async #durableSideEffect(args: {
    caseId: string;
    outboxId: string;
    step: string;
    perform: () => Promise<SideEffectIds>;
    reconcile?: () => Promise<SideEffectIds | null>;
  }): Promise<SideEffectIds> {
    const { db, intents } = this.#deps;
    const idempotencyKey = `${args.outboxId}:${args.step}`;
    const reconcilable = args.reconcile !== undefined;
    const leaseMs = this.#leaseMs;

    // Mint a per-attempt ownership token. Only the holder of the CURRENT token may
    // complete/abandon this attempt (AUDIT-03 MEDIUM-16), so a concurrent loser can
    // never mutate an active winner's intent.
    const claimToken = randomUUID();
    const claim = await db.withTransaction((tx) =>
      intents.claim(tx, {
        idempotencyKey,
        caseId: args.caseId,
        outboxId: args.outboxId,
        step: args.step,
        ownerToken: claimToken,
        leaseMs,
      }),
    );

    let owns = claim.inserted;
    let ownerToken = claimToken;
    if (!owns) {
      const status = claim.row.status;
      if (status === "SUCCEEDED") {
        return {
          discordMessageId: claim.row.discord_message_id,
          discordThreadId: claim.row.discord_thread_id,
        };
      }
      if (reconcilable) {
        // Single writer under the per-case lock: re-own for a fresh attempt; the
        // reconcile-before-perform below decides adopt-vs-create authoritatively.
        ownerToken = randomUUID();
        owns = await db.withTransaction((tx) =>
          intents.reopen(tx, idempotencyKey, ownerToken, leaseMs),
        );
        if (!owns) {
          throw new DiscordAmbiguousError(args.caseId, idempotencyKey);
        }
      } else if (status === "RETRYABLE") {
        ownerToken = randomUUID();
        owns = await db.withTransaction((tx) =>
          intents.takeForRetry(tx, idempotencyKey, ownerToken, leaseMs),
        );
        if (!owns) {
          throw new DiscordAmbiguousError(args.caseId, idempotencyKey);
        }
      } else {
        // A non-reconcilable STARTED/AMBIGUOUS observed by a non-owner. NEVER touch
        // an ACTIVE winner (live lease) — that is exactly the false-AMBIGUOUS bug
        // (AUDIT-03 MEDIUM-16): the loser halts its own duplicate and leaves the
        // winner to complete. Only a PROVABLY-ABANDONED STARTED (expired lease) is
        // transitioned to AMBIGUOUS during recovery; the expiry fence guarantees an
        // in-flight winner is untouched.
        if (status === "STARTED") {
          await db.withTransaction((tx) =>
            intents.expireToAmbiguous(tx, idempotencyKey, "recovered in-flight; outcome unknown"),
          );
        }
        throw new DiscordAmbiguousError(args.caseId, idempotencyKey);
      }
    }

    // Reconcilable side effects reconcile BEFORE performing (even on a fresh claim),
    // so an object created by a prior attempt — including one whose intent was lost
    // or created out-of-band — is adopted rather than duplicated (AUDIT-02 HIGH-07).
    // Safe because reconcilable side effects run under the per-case row lock.
    if (reconcilable) {
      const found = await args.reconcile!();
      if (found !== null) {
        await db.withTransaction((tx) => intents.succeed(tx, idempotencyKey, found, ownerToken));
        return found;
      }
    }

    let ids: SideEffectIds;
    try {
      ids = await withDiscordRetry(args.perform, this.#deps.retry);
    } catch (error) {
      if (isSafeToRetry(error)) {
        // Provably NOT delivered: keep the intent (RETRYABLE) with attempt evidence
        // so a later pass re-owns and re-issues cleanly (AUDIT-02 MEDIUM-12). This
        // owner writes its REAL terminal even if a racing lease-expiry observer
        // already flipped the row to AMBIGUOUS (AUDIT-04 MEDIUM-21). We CHECK the
        // result: a `false` means our token no longer owns the attempt (a takeover
        // re-owned it), so we must not assert a state we do not own — halt.
        const kept = await db.withTransaction((tx) =>
          intents.markRetryable(tx, idempotencyKey, ownerToken, errText(error)),
        );
        if (!kept) {
          throw new DiscordAmbiguousError(args.caseId, idempotencyKey, { cause: error });
        }
        throw error;
      }
      // Unknown outcome (lost response, 5xx): the write may have happened.
      if (reconcilable) {
        const found = await args.reconcile!();
        if (found !== null) {
          const adopted = await db.withTransaction((tx) =>
            intents.succeed(tx, idempotencyKey, found, ownerToken),
          );
          // The object provably exists, so it is genuinely delivered regardless of
          // whether OUR token recorded it (a concurrent owner may have): adopt it.
          if (adopted || (await intents.find(db, idempotencyKey))?.status === "SUCCEEDED") {
            return found;
          }
        }
      }
      // Owner-fenced AMBIGUOUS terminal (AUDIT-04 MEDIUM-21): recorded under our
      // token even over an observer's expiry-AMBIGUOUS. The outcome is ambiguous
      // whether or not the row transition applied, so halt automatic replay.
      await db.withTransaction((tx) =>
        intents.markAmbiguous(tx, idempotencyKey, ownerToken, errText(error)),
      );
      throw new DiscordAmbiguousError(args.caseId, idempotencyKey, { cause: error });
    }

    const done = await db.withTransaction((tx) =>
      intents.succeed(tx, idempotencyKey, ids, ownerToken),
    );
    if (!done) {
      // Our success could not be recorded under our token — a takeover (e.g. a
      // lease-expiry recovery that minted a new token) re-owned this attempt while
      // we were performing. The true state is uncertain from our vantage point, so
      // fail closed rather than report a success we can no longer fence (MEDIUM-21).
      const current = await intents.find(db, idempotencyKey);
      if (current?.status !== "SUCCEEDED") {
        throw new DiscordAmbiguousError(args.caseId, idempotencyKey);
      }
    }
    return ids;
  }

  /**
   * Send an ordered list of chunk bodies into a thread, each as its own durable
   * side effect. Buttons are attached to the LAST chunk only. Returns the first
   * chunk's message id (used as the receipt's representative message).
   */
  async #sendChunks(args: {
    caseId: string;
    outboxId: string;
    threadId: string;
    chunks: readonly string[];
    stepPrefix: string;
    components?: readonly MessageButton[];
  }): Promise<string | null> {
    const { gateway } = this.#deps;
    let firstMessageId: string | null = null;
    for (let i = 0; i < args.chunks.length; i += 1) {
      const isLast = i === args.chunks.length - 1;
      const content = args.chunks[i]!;
      const hasButtons = isLast && args.components !== undefined && args.components.length > 0;
      const ids = await this.#durableSideEffect({
        caseId: args.caseId,
        outboxId: args.outboxId,
        step: `${args.stepPrefix}:${i}`,
        perform: async () => {
          const sent = await gateway.sendThreadMessage({
            threadId: args.threadId,
            content,
            ...(hasButtons ? { components: args.components } : {}),
          });
          return { discordMessageId: sent.messageId, discordThreadId: args.threadId };
        },
      });
      if (firstMessageId === null) {
        firstMessageId = ids.discordMessageId;
      }
    }
    return firstMessageId;
  }

  /**
   * Fail-closed authoritative-route check (HIGH-02): the case's persisted binding
   * (owner + channel) is the source of truth. A payload whose derived owner/channel
   * disagrees with the durable binding is rejected before any gateway call.
   */
  #assertAuthoritativeRoute(
    binding: DiscordBindingRow,
    payloadOwnerId: string,
    requestedChannelId: string,
  ): void {
    if (binding.owner_id !== payloadOwnerId) {
      throw new DiscordRoutingError(
        binding.case_id,
        `owner mismatch for case ${binding.case_id}: binding ${binding.owner_id} != payload ${payloadOwnerId}`,
      );
    }
    if (binding.channel_id !== requestedChannelId) {
      throw new DiscordRoutingError(
        binding.case_id,
        `channel mismatch for case ${binding.case_id}: binding ${binding.channel_id} != requested ${requestedChannelId}`,
      );
    }
  }

  #buttonsFor(p: ThreadMessagePayload): MessageButton[] {
    const buttons: MessageButton[] = [];
    if (p.decision !== undefined) {
      for (const option of p.decision.options) {
        buttons.push({
          customId: encodeDecision({
            decisionId: p.decision.decision_id,
            checkpointRevision: p.decision.checkpoint_revision,
            optionId: option.option_id,
          }),
          label: option.label,
          style: "primary",
        });
      }
    }
    if (p.approval !== undefined) {
      buttons.push(
        {
          customId: encodeApproval({
            approvalId: p.approval.approval_id,
            checkpointRevision: p.approval.checkpoint_revision,
            choice: "grant",
          }),
          label: "Approve",
          style: "success",
        },
        {
          customId: encodeApproval({
            approvalId: p.approval.approval_id,
            checkpointRevision: p.approval.checkpoint_revision,
            choice: "deny",
          }),
          label: "Deny",
          style: "danger",
        },
      );
    }
    return buttons;
  }

  #assertInOrder(caseId: string, deliveredSeq: string, seq: number): void {
    const expected = Number(deliveredSeq) + 1;
    if (seq !== expected) {
      throw new DiscordDeferredError(caseId, expected, seq);
    }
  }
}

/** Redacted, bounded error text stored as attempt evidence (never a secret). */
function errText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 500);
}
