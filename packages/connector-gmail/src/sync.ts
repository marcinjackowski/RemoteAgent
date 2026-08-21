/**
 * Gmail sync: notifications → history replay → deduplicated thread events.
 *
 * A Gmail push notification carries almost nothing — an account and a `historyId`.
 * It is not the change; it is a hint that changes exist at or before that point. So
 * the connector's real job is replaying `history.list` from its own stored cursor,
 * which makes the cursor the single most correctness-critical piece of state here.
 *
 * ## Criterion 1: a notification with only a history id reconstructs the changes
 *
 * {@link GmailSyncEngine.handleNotification} ignores the notification's payload
 * beyond the account and the id, and replays from the STORED cursor rather than from
 * the notification. Trusting the notification's id as a starting point would skip
 * every change between the stored cursor and it — which is precisely what happens
 * when a notification is lost and the next one arrives.
 *
 * ## Criterion 2: duplicates and out-of-order deliveries change nothing
 *
 * Two independent mechanisms, because they fail differently:
 *
 * - the cursor only ever moves FORWARD ({@link compareHistoryIds}), so a
 *   notification carrying an older id cannot rewind it and cause a replay;
 * - each emitted change is keyed by `(account, message_id, history_id, kind)` in a
 *   seen-set, so a replayed history window — which Gmail legitimately returns, since
 *   `history.list` is inclusive and overlapping — yields no duplicate events.
 *
 * A monotonic cursor alone is not enough: the same window can be replayed at the same
 * cursor after a crash. A seen-set alone is not enough either: it would grow without
 * bound and would not stop a rewind. Both are required.
 *
 * ## Criterion 7: an invalid cursor resyncs without losing the audit trail
 *
 * Gmail expires history after about a week and then returns 404 for an old
 * `startHistoryId`. The recovery is a full resync, and the important part is that it
 * is RECORDED: {@link GmailSyncOutcome} reports `resynced: true` with the cursor that
 * failed, so the gap is visible as a deliberate resync rather than as a mysteriously
 * quiet period.
 *
 * ## Criterion 5, again
 *
 * Every method takes a {@link GmailAccountRef} and calls {@link assertSameAccount} on
 * anything account-scoped it is handed. The engine holds one cursor store keyed by
 * alias, and an event's `account_alias` is copied from the ref rather than from the
 * API response — so a mislabelled response cannot route a private message to the work
 * channel.
 */
import {
  GMAIL_CURSOR_INVALID,
  GmailChangeKind,
  GmailConnectorError,
  GmailWatchHealth,
  assertSameAccount,
  compareHistoryIds,
  gmailCursor,
  gmailMessageSummary,
  gmailWatchState,
} from "./contracts.js";
import type {
  GmailAccountAlias,
  GmailAccountRef,
  GmailCursor,
  GmailMessageSummary,
  GmailWatchState,
} from "./contracts.js";

/** Renew a watch when it expires within this window. Gmail's own limit is 7 days. */
export const GMAIL_WATCH_RENEW_WITHIN_MS = 86_400_000;

/** One entry as returned by `history.list`. */
export type GmailHistoryEntry = Readonly<{
  history_id: string;
  message_id: string;
  thread_id: string;
  kind: GmailChangeKind;
  label_ids?: readonly string[];
  subject?: string;
  from?: string;
  snippet?: string;
}>;

/** Raised by an API adapter when the stored cursor is too old to replay. */
export class GmailHistoryExpiredError extends GmailConnectorError {
  public constructor() {
    super(GMAIL_CURSOR_INVALID, "gmail history cursor is no longer replayable");
  }
}

/** The Gmail surface this engine needs. Implemented by a real client. */
export interface GmailApi {
  /**
   * Replay history from `startHistoryId`, exclusive of that point.
   *
   * Must throw {@link GmailHistoryExpiredError} when Gmail rejects the start id, so
   * the engine can resync deliberately rather than treating it as an empty result —
   * an empty result would look like "nothing changed" and silently lose everything.
   */
  listHistory(input: {
    account: GmailAccountRef;
    startHistoryId: string;
  }): Promise<{ entries: readonly GmailHistoryEntry[]; latestHistoryId: string }>;

  /** Full listing, for a resync after cursor expiry. */
  listRecentMessages(input: {
    account: GmailAccountRef;
    limit: number;
  }): Promise<{ entries: readonly GmailHistoryEntry[]; latestHistoryId: string }>;

  /** (Re)register the push watch. Returns Gmail's expiry and start point. */
  registerWatch(input: {
    account: GmailAccountRef;
  }): Promise<{ expiresAtMs: number; startHistoryId: string }>;
}

/** Per-account cursor persistence. A real deployment backs this with the database. */
export interface GmailCursorStore {
  read(alias: GmailAccountAlias): Promise<GmailCursor | null>;
  write(cursor: GmailCursor): Promise<void>;
}

/** In-memory cursor store for tests and single-process use. */
export class InMemoryGmailCursorStore implements GmailCursorStore {
  readonly #byAlias = new Map<GmailAccountAlias, GmailCursor>();

  public async read(alias: GmailAccountAlias): Promise<GmailCursor | null> {
    return this.#byAlias.get(alias) ?? null;
  }

  public async write(cursor: GmailCursor): Promise<void> {
    const existing = this.#byAlias.get(cursor.account_alias);
    // Monotonic by construction, even if a caller passes an older cursor: the store
    // is the last line of defence against a rewind that would cause a re-emit.
    if (existing !== undefined && compareHistoryIds(cursor.history_id, existing.history_id) < 0) {
      return;
    }
    this.#byAlias.set(cursor.account_alias, cursor);
  }
}

export type GmailSyncOutcome = Readonly<{
  account_alias: GmailAccountAlias;
  /** Newly observed changes, deduplicated. Empty for a duplicate notification. */
  changes: readonly GmailMessageSummary[];
  /** Cursor after this pass. */
  cursor: GmailCursor;
  /** True when the stored cursor had expired and a full resync was performed. */
  resynced: boolean;
  /** The cursor that failed, when `resynced`. Kept for the audit trail. */
  resynced_from: string | null;
  /** True when the notification was older than the stored cursor and ignored. */
  stale: boolean;
}>;

export type GmailSyncEngineOptions = Readonly<{
  api: GmailApi;
  cursors: GmailCursorStore;
  /** Injected clock so cursor timestamps and watch health are deterministic. */
  now?: () => number;
  /** Bound on a resync listing. */
  resyncLimit?: number;
  /**
   * Bound on the per-account dedup set. Defaults to 10_000 keys.
   *
   * Bounded on purpose: the engine runs for weeks, and an unbounded set is a slow
   * memory leak. Safe because the forward-only cursor is the primary defence; keys
   * only need to outlive Gmail's overlapping windows and a crash-replay.
   */
  seenLimit?: number;
}>;

/** Stable identity of one emitted change, for deduplication. */
function changeKey(summary: GmailMessageSummary): string {
  return [summary.account_alias, summary.message_id, summary.history_id, summary.kind].join("\0");
}

export class GmailSyncEngine {
  readonly #api: GmailApi;
  readonly #cursors: GmailCursorStore;
  readonly #now: () => number;
  readonly #resyncLimit: number;
  readonly #seenLimit: number;
  /** Emitted change keys, per account. Never shared between accounts. */
  readonly #seen = new Map<GmailAccountAlias, Set<string>>();

  public constructor(options: GmailSyncEngineOptions) {
    this.#api = options.api;
    this.#cursors = options.cursors;
    this.#now = options.now ?? (() => Date.now());
    this.#resyncLimit = options.resyncLimit ?? 100;
    this.#seenLimit = options.seenLimit ?? 10_000;
  }

  #seenFor(alias: GmailAccountAlias): Set<string> {
    const existing = this.#seen.get(alias);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    this.#seen.set(alias, created);
    return created;
  }

  /**
   * Evict the oldest dedup keys once an account's set exceeds its bound.
   *
   * The set had no eviction, which an audit probe flagged: this engine is meant to
   * run for weeks, so an unbounded per-account set is a slow memory leak. Bounding
   * it is safe because the cursor is the primary defence — a key only needs to
   * survive long enough to catch Gmail's OVERLAPPING history windows and a
   * crash-replay at the same cursor, both of which are recent by nature. An ancient
   * key can be forgotten because the forward-only cursor already prevents replaying
   * that far back.
   *
   * Insertion order is preserved by `Set`, so the oldest keys are simply the first.
   */
  #evict(seen: Set<string>): void {
    if (seen.size <= this.#seenLimit) return;
    const excess = seen.size - this.#seenLimit;
    let removed = 0;
    for (const key of seen) {
      seen.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }

  /** Convert a raw history entry into an account-pinned, untrusted summary. */
  #toSummary(account: GmailAccountRef, entry: GmailHistoryEntry): GmailMessageSummary {
    return gmailMessageSummary.parse({
      // Copied from the REF, never from the API response: a mislabelled response
      // must not be able to route this message to the other account's channel.
      account_alias: account.alias,
      message_id: entry.message_id,
      thread_id: entry.thread_id,
      history_id: entry.history_id,
      kind: entry.kind,
      label_ids: [...(entry.label_ids ?? [])],
      untrusted: {
        trust: "UNTRUSTED_DATA",
        subject: entry.subject ?? "",
        from: entry.from ?? "",
        snippet: entry.snippet ?? "",
      },
    });
  }

  /**
   * Handle one push notification.
   *
   * `notifiedHistoryId` is treated as a HINT, not as a starting point. The replay
   * starts from the stored cursor, because a notification that arrives after a lost
   * one would otherwise skip every change in between.
   */
  public async handleNotification(input: {
    readonly account: GmailAccountRef;
    readonly notifiedHistoryId: string;
  }): Promise<GmailSyncOutcome> {
    const { account, notifiedHistoryId } = input;
    const stored = await this.#cursors.read(account.alias);
    if (stored !== null) assertSameAccount(account, stored);

    // No cursor yet: nothing to replay from, so establish one by resync. This is the
    // first-run path and is recorded as a resync so it is not mistaken for a gap.
    if (stored === null) {
      return this.#resync(account, null);
    }

    // A notification older than what we have already processed. Ignored, and
    // reported as `stale` rather than silently returning "no changes", so a
    // misordered stream is visible in the audit trail.
    if (compareHistoryIds(notifiedHistoryId, stored.history_id) <= 0) {
      return Object.freeze({
        account_alias: account.alias,
        changes: Object.freeze([]),
        cursor: stored,
        resynced: false,
        resynced_from: null,
        stale: true,
      });
    }

    let listed: Awaited<ReturnType<GmailApi["listHistory"]>>;
    try {
      listed = await this.#api.listHistory({
        account,
        startHistoryId: stored.history_id,
      });
    } catch (error) {
      if (error instanceof GmailHistoryExpiredError) {
        // Criterion 7: a deliberate, recorded resync rather than a silent gap.
        return this.#resync(account, stored.history_id);
      }
      throw error;
    }

    return this.#emit(account, listed, false, null);
  }

  /**
   * Periodic reconciliation, for notifications that never arrived.
   *
   * Criterion 4. Runs the same replay as a notification would, from the stored
   * cursor, so a dropped push is recovered without needing to know it was dropped.
   * This is why the replay start is the cursor and not the notification.
   */
  public async reconcile(account: GmailAccountRef): Promise<GmailSyncOutcome> {
    const stored = await this.#cursors.read(account.alias);
    if (stored === null) return this.#resync(account, null);
    assertSameAccount(account, stored);

    try {
      const listed = await this.#api.listHistory({
        account,
        startHistoryId: stored.history_id,
      });
      return this.#emit(account, listed, false, null);
    } catch (error) {
      if (error instanceof GmailHistoryExpiredError) {
        return this.#resync(account, stored.history_id);
      }
      throw error;
    }
  }

  /** Full resync after an expired or absent cursor. */
  async #resync(account: GmailAccountRef, failedFrom: string | null): Promise<GmailSyncOutcome> {
    const listed = await this.#api.listRecentMessages({
      account,
      limit: this.#resyncLimit,
    });
    return this.#emit(account, listed, true, failedFrom);
  }

  /** Deduplicate, advance the cursor forward-only, and return the outcome. */
  async #emit(
    account: GmailAccountRef,
    listed: { entries: readonly GmailHistoryEntry[]; latestHistoryId: string },
    resynced: boolean,
    resyncedFrom: string | null,
  ): Promise<GmailSyncOutcome> {
    const seen = this.#seenFor(account.alias);
    const changes: GmailMessageSummary[] = [];

    for (const entry of listed.entries) {
      const summary = this.#toSummary(account, entry);
      const key = changeKey(summary);
      // `history.list` windows overlap and are replayed after a crash, so a
      // per-account seen-set is what makes repeated delivery a no-op.
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push(summary);
    }

    this.#evict(seen);

    const stored = await this.#cursors.read(account.alias);
    // Forward-only: a resync or an overlapping window must never move the cursor
    // backwards, because a rewind would re-emit everything after it.
    const advanced =
      stored !== null && compareHistoryIds(listed.latestHistoryId, stored.history_id) < 0
        ? stored.history_id
        : listed.latestHistoryId;

    const cursor = gmailCursor.parse({
      schema_version: 1,
      account_alias: account.alias,
      history_id: advanced,
      updated_at_ms: this.#now(),
    });
    await this.#cursors.write(cursor);

    return Object.freeze({
      account_alias: account.alias,
      changes: Object.freeze(changes),
      cursor,
      resynced,
      resynced_from: resyncedFrom,
      stale: false,
    });
  }

  /**
   * Register or renew one account's watch, independently of the other's.
   *
   * Criterion 3. Takes a single account, so there is no code path that renews both
   * at once and reports one health for the pair — an expiry on the private mailbox
   * must not be masked by a healthy work mailbox.
   */
  public async ensureWatch(input: {
    readonly account: GmailAccountRef;
    readonly current: GmailWatchState | null;
  }): Promise<GmailWatchState> {
    const { account, current } = input;
    if (current !== null) assertSameAccount(account, current);

    const health = classifyWatch(current, this.#now());
    if (health === GmailWatchHealth.ACTIVE && current !== null) {
      return current;
    }

    const registered = await this.#api.registerWatch({ account });
    return gmailWatchState.parse({
      schema_version: 1,
      account_alias: account.alias,
      health: GmailWatchHealth.ACTIVE,
      expires_at_ms: registered.expiresAtMs,
      start_history_id: registered.startHistoryId,
    });
  }
}

/**
 * Classify a watch's health from its expiry.
 *
 * Exported because criterion 3 requires a health status per account, and a caller
 * needs to read it without attempting a renewal. `EXPIRING` exists so renewal happens
 * before delivery stops rather than after — treating "not yet expired" as healthy
 * would guarantee a gap on every renewal cycle.
 */
export function classifyWatch(state: GmailWatchState | null, nowMs: number): GmailWatchHealth {
  if (state === null || state.expires_at_ms === null) return GmailWatchHealth.ABSENT;
  const remaining = state.expires_at_ms - nowMs;
  if (remaining <= 0) return GmailWatchHealth.EXPIRED;
  if (remaining <= GMAIL_WATCH_RENEW_WITHIN_MS) return GmailWatchHealth.EXPIRING;
  return GmailWatchHealth.ACTIVE;
}
