/**
 * Calendar sync: notification → incremental sync → deduplicated events.
 *
 * A Google Calendar push notification has **no body at all** — only headers naming
 * the channel and resource. It says "something in this collection changed", nothing
 * more. So the notification's only jobs are to authenticate itself and to identify
 * which collection to sync (criterion 1).
 *
 * ## Criterion 4: overlapping old and new channels must not duplicate
 *
 * Renewal creates a NEW channel before the old one expires, deliberately overlapping
 * so no notification is lost in the gap. That means the same change arrives twice,
 * through two channels, and the sync token cannot help: it is opaque, so there is no
 * "this token is older" comparison available (unlike RA-019's ordered `historyId`).
 *
 * Deduplication therefore keys on `(event_id, etag)`. Google changes the etag on every
 * mutation, so the same etag twice is the same version twice — a duplicate — while a
 * genuine second edit carries a new etag and is correctly emitted. Keying on
 * `event_id` alone would swallow real updates; keying on the token would not
 * deduplicate at all.
 *
 * ## Criterion 3: HTTP 410 forces an auditable full resync
 *
 * A sync token expires and cannot be validated locally; the only way to find out is to
 * use it and be refused. {@link CalendarSyncTokenExpiredError} is therefore a normal
 * control-flow path, and the resync it triggers is RECORDED with the token that
 * failed, so the gap reads as a deliberate reset rather than an unexplained quiet
 * period.
 *
 * ## Criterion 2: per-collection, not per-account
 *
 * Every method takes a {@link CalendarCollectionRef} — the (account, calendar) pair.
 * One account often watches several calendars, and a per-account cursor would let one
 * calendar's response advance another's position, skipping events silently.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import {
  CALENDAR_CHANNEL_UNAUTHENTICATED,
  CalendarChannelHealth,
  CalendarConnectorError,
  assertSameCollection,
  calendarChannel,
  calendarEventRecord,
  calendarSyncState,
} from "./contracts.js";
import type {
  CalendarAccountAlias,
  CalendarChangeKind,
  CalendarChannel,
  CalendarCollectionRef,
  CalendarEventRecord,
  CalendarRegistry,
  CalendarSyncState,
} from "./contracts.js";

/** Create a replacement channel when the current one expires within this window. */
export const CALENDAR_CHANNEL_RENEW_WITHIN_MS = 3_600_000;

/** Raised by an adapter when Google refuses the sync token with HTTP 410. */
export class CalendarSyncTokenExpiredError extends CalendarConnectorError {
  public constructor() {
    super("SYNC_TOKEN_EXPIRED", "calendar sync token is no longer usable");
  }
}

/** One event as returned by `events.list`. */
export type CalendarApiEvent = Readonly<{
  event_id: string;
  etag: string;
  kind: CalendarChangeKind;
  series_id?: string | null;
  original_start_time?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  time_zone?: string | null;
  summary?: string;
  description?: string;
  organizer?: string;
}>;

/** One page of a sync. `nextPageToken` continues it; `nextSyncToken` ends it. */
export type CalendarPage = Readonly<{
  events: readonly CalendarApiEvent[];
  nextPageToken?: string | null;
  nextSyncToken?: string | null;
}>;

export interface CalendarApi {
  /**
   * Incremental sync from a stored token.
   *
   * Must throw {@link CalendarSyncTokenExpiredError} on HTTP 410 rather than
   * returning an empty page: an empty page means "nothing changed", and conflating
   * the two would silently discard every change since the token was issued.
   */
  listIncremental(input: {
    collection: CalendarCollectionRef;
    syncToken: string;
    pageToken?: string;
  }): Promise<CalendarPage>;

  /** Full sync, for the first run or after a 410. */
  listFull(input: { collection: CalendarCollectionRef; pageToken?: string }): Promise<CalendarPage>;

  /** Create a watch channel. Renewal is a new channel, not an update. */
  createChannel(input: {
    collection: CalendarCollectionRef;
  }): Promise<{ channelId: string; resourceId: string; token: string; expiresAtMs: number }>;

  /** Stop a channel. Best-effort: an already-dead channel is not an error. */
  stopChannel(input: {
    collection: CalendarCollectionRef;
    channel: CalendarChannel;
  }): Promise<void>;
}

/** Per-collection sync state persistence. */
export interface CalendarSyncStore {
  read(alias: CalendarAccountAlias, calendarId: string): Promise<CalendarSyncState | null>;
  write(state: CalendarSyncState): Promise<void>;
}

export class InMemoryCalendarSyncStore implements CalendarSyncStore {
  readonly #byKey = new Map<string, CalendarSyncState>();

  public async read(
    alias: CalendarAccountAlias,
    calendarId: string,
  ): Promise<CalendarSyncState | null> {
    return this.#byKey.get(`${alias}\0${calendarId}`) ?? null;
  }

  public async write(state: CalendarSyncState): Promise<void> {
    this.#byKey.set(`${state.account_alias}\0${state.calendar_id}`, state);
  }
}

/** Headers Google sends with a (bodyless) notification. */
export type CalendarNotification = Readonly<{
  channelId: string | null | undefined;
  resourceId: string | null | undefined;
  channelToken: string | null | undefined;
  /** `sync` on the handshake notification, `exists` for a real change. */
  resourceState: string | null | undefined;
}>;

/** Constant-time comparison over fixed-width digests. */
function secretMatches(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

/**
 * Authenticate a notification against a registered channel.
 *
 * All three of channel id, resource id and token must match. The token is OURS — a
 * secret handed to Google at registration and echoed back — and it is the only thing
 * separating a genuine notification from anyone who found the endpoint, so it is
 * compared in constant time and never echoed in the refusal.
 *
 * Returns the collection to sync, so a caller cannot accidentally act on an
 * unauthenticated notification: there is no path that yields a collection without
 * passing this check.
 */
export function verifyCalendarNotification(input: {
  readonly notification: CalendarNotification;
  readonly channels: readonly CalendarChannel[];
  readonly registry: CalendarRegistry;
}): CalendarCollectionRef {
  const { notification, channels, registry } = input;
  const channelId = notification.channelId ?? "";
  const resourceId = notification.resourceId ?? "";
  const token = notification.channelToken ?? "";

  const matches = channels.filter(
    (candidate) => candidate.channel_id === channelId && candidate.resource_id === resourceId,
  );
  // AMBIGUITY IS A REFUSAL, not a first-match-wins. Found by an audit probe: with two
  // registered channels sharing a channel id, `find` returned whichever was listed
  // first, so a work-account notification could resolve to the private collection and
  // route a work event to the private Discord channel. Google's channel ids are
  // unique in practice, so more than one match means our own records are corrupt or
  // an attacker is replaying — neither is a case to guess through.
  if (matches.length > 1) {
    throw new CalendarConnectorError(
      CALENDAR_CHANNEL_UNAUTHENTICATED,
      "calendar notification matched more than one channel",
    );
  }
  const match = matches[0];
  if (match === undefined || token.length === 0 || !secretMatches(token, match.token)) {
    // Deliberately uniform: a caller cannot learn WHICH of the three failed, so a
    // probe cannot enumerate valid channel ids.
    throw new CalendarConnectorError(
      CALENDAR_CHANNEL_UNAUTHENTICATED,
      "calendar notification failed channel authentication",
    );
  }
  // Re-resolved through the allowlist rather than trusted from the channel record:
  // a stale channel for a de-allowlisted calendar must stop working.
  return registry.resolve(match.account_alias, match.calendar_id);
}

export type CalendarSyncOutcome = Readonly<{
  account_alias: CalendarAccountAlias;
  calendar_id: string;
  events: readonly CalendarEventRecord[];
  state: CalendarSyncState;
  /** True when a full sync ran: first run, or a recorded reset after HTTP 410. */
  full_sync: boolean;
  /** The token that was refused, when a 410 forced the resync. */
  reset_from: string | null;
  /** Pages fetched, so pagination is observable rather than assumed. */
  pages: number;
  /**
   * True when `maxPages` cut the sequence short, so the caller knows more remains.
   * Silently truncating would look identical to "that was everything".
   */
  truncated: boolean;
}>;

export type CalendarSyncEngineOptions = Readonly<{
  api: CalendarApi;
  store: CalendarSyncStore;
  now?: () => number;
  /** Bound on pages per sync, so a pathological pagination cannot spin forever. */
  maxPages?: number;
  /** Bound on the per-collection dedup set. */
  seenLimit?: number;
}>;

/** Dedup identity: the event AND its version. See the module note. */
function eventKey(record: CalendarEventRecord): string {
  return `${record.event_id}\0${record.etag}`;
}

export class CalendarSyncEngine {
  readonly #api: CalendarApi;
  readonly #store: CalendarSyncStore;
  readonly #now: () => number;
  readonly #maxPages: number;
  readonly #seenLimit: number;
  /** Per-collection, never per-account: see criterion 2 in the module note. */
  readonly #seen = new Map<string, Set<string>>();

  public constructor(options: CalendarSyncEngineOptions) {
    this.#api = options.api;
    this.#store = options.store;
    this.#now = options.now ?? (() => Date.now());
    this.#maxPages = options.maxPages ?? 50;
    this.#seenLimit = options.seenLimit ?? 10_000;
  }

  #seenFor(collection: CalendarCollectionRef): Set<string> {
    const key = `${collection.account_alias}\0${collection.calendar_id}`;
    const existing = this.#seen.get(key);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    this.#seen.set(key, created);
    return created;
  }

  /** Bounded like RA-019's, and for the same reason: this runs for weeks. */
  #evict(seen: Set<string>): void {
    if (seen.size <= this.#seenLimit) return;
    let removed = 0;
    const excess = seen.size - this.#seenLimit;
    for (const key of seen) {
      seen.delete(key);
      removed += 1;
      if (removed >= excess) break;
    }
  }

  #toRecord(collection: CalendarCollectionRef, event: CalendarApiEvent): CalendarEventRecord {
    return calendarEventRecord.parse({
      // From the REF, never from the response: a mislabelled response must not be
      // able to choose its own destination channel.
      account_alias: collection.account_alias,
      calendar_id: collection.calendar_id,
      event_id: event.event_id,
      etag: event.etag,
      kind: event.kind,
      series_id: event.series_id ?? null,
      original_start_time: event.original_start_time ?? null,
      start_time: event.start_time ?? null,
      end_time: event.end_time ?? null,
      time_zone: event.time_zone ?? null,
      untrusted: {
        trust: "UNTRUSTED_DATA",
        summary: event.summary ?? "",
        description: event.description ?? "",
        organizer: event.organizer ?? "",
      },
    });
  }

  /**
   * Sync one collection, following pagination to the end.
   *
   * A notification carries no body, so this is the whole of "handle a notification":
   * identify the collection, then sync it.
   */
  public async sync(collection: CalendarCollectionRef): Promise<CalendarSyncOutcome> {
    const stored = await this.#store.read(collection.account_alias, collection.calendar_id);
    if (stored !== null) assertSameCollection(collection, stored);

    if (stored?.sync_token == null) {
      // First run. Recorded as a full sync so it is not mistaken for a gap.
      return this.#run(collection, null, true, null);
    }

    try {
      return await this.#run(collection, stored.sync_token, false, null);
    } catch (error) {
      if (error instanceof CalendarSyncTokenExpiredError) {
        // Criterion 3: an auditable reset carrying the token that failed.
        return this.#run(collection, null, true, stored.sync_token);
      }
      throw error;
    }
  }

  /** Periodic reconciliation for a notification that never arrived (criterion 7). */
  public async reconcile(collection: CalendarCollectionRef): Promise<CalendarSyncOutcome> {
    // Identical to a notification-driven sync: the notification carried no
    // information, so its absence costs nothing but a delay.
    return this.sync(collection);
  }

  async #run(
    collection: CalendarCollectionRef,
    syncToken: string | null,
    fullSync: boolean,
    resetFrom: string | null,
  ): Promise<CalendarSyncOutcome> {
    const seen = this.#seenFor(collection);
    const emitted: CalendarEventRecord[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    let pages = 0;
    /**
     * True when `maxPages` cut the sequence short.
     *
     * This is NOT the same as "the sequence ended": Google issues `nextSyncToken`
     * only on the final page, so a truncated sync has no new token AND has unread
     * pages behind it. An audit probe showed the consequence — the token went `null`
     * and the next run did a needless full sync. Keeping the OLD token is the right
     * answer: it still points at the last fully-consumed position, so the next
     * incremental sync resumes and reads the pages this run did not reach. Adopting a
     * new token here would be the actual bug, because it would skip them.
     */
    let truncated = false;

    do {
      if (pages >= this.#maxPages) {
        truncated = true;
        break;
      }
      const page: CalendarPage =
        syncToken === null
          ? await this.#api.listFull({
              collection,
              ...(pageToken === undefined ? {} : { pageToken }),
            })
          : await this.#api.listIncremental({
              collection,
              syncToken,
              ...(pageToken === undefined ? {} : { pageToken }),
            });
      pages += 1;

      for (const event of page.events) {
        const record = this.#toRecord(collection, event);
        const key = eventKey(record);
        // `(event_id, etag)`: the same version twice is a duplicate — which is what
        // an overlapping renewal channel delivers — while a real second edit carries
        // a new etag and is emitted.
        if (seen.has(key)) continue;
        seen.add(key);
        emitted.push(record);
      }

      pageToken = page.nextPageToken ?? undefined;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken !== undefined);

    this.#evict(seen);

    const state = calendarSyncState.parse({
      schema_version: 1,
      account_alias: collection.account_alias,
      calendar_id: collection.calendar_id,
      // Keep the PREVIOUS token when this run issued no new one — whether the
      // sequence ended without a token or `maxPages` truncated it. The old token
      // still marks the last fully-consumed position, so the next incremental sync
      // resumes there and reads whatever this run did not reach. Nulling it would
      // force a needless full sync; adopting a new token mid-truncation would skip
      // the unread pages outright.
      sync_token:
        (truncated ? null : nextSyncToken) ??
        (await this.#store.read(collection.account_alias, collection.calendar_id))?.sync_token ??
        null,
      updated_at_ms: this.#now(),
    });
    await this.#store.write(state);

    return Object.freeze({
      account_alias: collection.account_alias,
      calendar_id: collection.calendar_id,
      events: Object.freeze(emitted),
      state,
      full_sync: fullSync,
      reset_from: resetFrom,
      pages,
      truncated,
    });
  }

  /**
   * Ensure a live watch channel, renewing by OVERLAP.
   *
   * Google channels cannot be extended, only replaced. So renewal creates the new
   * channel FIRST and stops the old one after — the overlap is deliberate, because
   * the alternative (stop then create) leaves a window in which notifications are
   * silently dropped. The duplicate deliveries the overlap causes are handled by the
   * `(event_id, etag)` dedup, which is why that had to key on the event rather than
   * on the cursor.
   */
  public async ensureChannel(input: {
    readonly collection: CalendarCollectionRef;
    readonly current: CalendarChannel | null;
  }): Promise<{ channel: CalendarChannel; replaced: CalendarChannel | null }> {
    const { collection, current } = input;
    if (current !== null) assertSameCollection(collection, current);

    if (
      classifyChannel(current, this.#now()) === CalendarChannelHealth.ACTIVE &&
      current !== null
    ) {
      return { channel: current, replaced: null };
    }

    const created = await this.#api.createChannel({ collection });
    const channel = calendarChannel.parse({
      schema_version: 1,
      account_alias: collection.account_alias,
      calendar_id: collection.calendar_id,
      channel_id: created.channelId,
      resource_id: created.resourceId,
      token: created.token,
      expires_at_ms: created.expiresAtMs,
    });

    if (current !== null) {
      // Best-effort: an already-dead channel is not a failure, and leaving it to
      // expire on its own is harmless because dedup absorbs the overlap.
      await this.#api.stopChannel({ collection, channel: current }).catch(() => undefined);
    }
    return { channel, replaced: current };
  }
}

/**
 * Classify a channel's health.
 *
 * `EXPIRING` exists so a replacement is created before delivery stops. Treating
 * "not yet expired" as healthy would guarantee a delivery gap on every renewal cycle.
 */
export function classifyChannel(
  channel: CalendarChannel | null,
  nowMs: number,
): CalendarChannelHealth {
  if (channel === null) return CalendarChannelHealth.ABSENT;
  const remaining = channel.expires_at_ms - nowMs;
  if (remaining <= 0) return CalendarChannelHealth.EXPIRED;
  if (remaining <= CALENDAR_CHANNEL_RENEW_WITHIN_MS) return CalendarChannelHealth.EXPIRING;
  return CalendarChannelHealth.ACTIVE;
}

/**
 * Correlate an event with its recurring series (criterion 5).
 *
 * Returns the id that identifies the SERIES for correlation purposes: the parent id
 * for an instance, the event's own id for a standalone event. The occurrence is
 * identified separately by `original_start_time`, because a series id alone cannot say
 * which occurrence was cancelled and an instance id alone cannot find the series.
 */
export function correlateSeries(record: CalendarEventRecord): {
  readonly series_id: string;
  readonly occurrence: string | null;
  readonly is_instance: boolean;
} {
  const isInstance = record.series_id !== null;
  return Object.freeze({
    series_id: record.series_id ?? record.event_id,
    occurrence: record.original_start_time,
    is_instance: isInstance,
  });
}
