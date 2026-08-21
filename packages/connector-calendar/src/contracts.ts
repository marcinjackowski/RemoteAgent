/**
 * Calendar connector contracts: account/calendar registry, sync token, events.
 *
 * Contracts only. Names are prefixed `calendar*` / `Calendar*` or otherwise unique;
 * the export-intersection test guards the barrel.
 *
 * ## How this differs from Gmail, and why it matters
 *
 * RA-019's cursor is a `historyId` — ordered, comparable, so "is this notification
 * older than what I have?" is answerable. A Calendar `syncToken` is **opaque**: it is
 * a server-issued string with no ordering, no embedded timestamp and no meaning to a
 * client. Two consequences shape everything here:
 *
 * 1. staleness cannot be detected by comparing tokens, so duplicate suppression must
 *    key on the EVENT (id + etag), not on the cursor. {@link calendarEventRecord}
 *    therefore carries `etag`, which Google changes on every mutation;
 * 2. a token cannot be validated locally. The only way to learn it has expired is to
 *    use it and receive HTTP 410, so {@link CalendarSyncTokenExpiredError} is a
 *    first-class control-flow path rather than an error case.
 *
 * Copying Gmail's comparison-based design here would produce code that looks correct
 * and silently mis-orders syncs, so the difference is stated rather than left for a
 * reader to infer.
 *
 * ## Criterion 6: two accounts separated in DB, context and Discord
 *
 * Same structural approach as RA-019, one level deeper: the unit of scope is
 * (account, calendar), not just account. One account may watch several calendars, and
 * a per-account cursor would conflate them — advancing one calendar's sync position
 * from another's response. {@link CalendarCollectionRef} is branded over the pair.
 */
import { TrustLevel, idString, text, valueObject, versionedContract } from "@remoteagent/contracts";
import * as z from "zod";

/** Upper bound on a carried summary or description, in characters. */
export const MAX_CALENDAR_TEXT = 2_048;

/** Upper bound on events one sync page may report. */
export const MAX_CALENDAR_PAGE = 512;

/** Raised when a Calendar request cannot be honoured safely. */
export class CalendarConnectorError extends Error {
  public readonly code: string;

  public constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "CalendarConnectorError";
    this.code = code;
  }
}

/** The (account, calendar) pair is not on the allowlist. */
export const CALENDAR_NOT_ALLOWED = "CALENDAR_NOT_ALLOWED";

/** Two values that must share a collection did not. */
export const CALENDAR_SCOPE_MISMATCH = "SCOPE_MISMATCH";

/** A watch notification failed authentication. */
export const CALENDAR_CHANNEL_UNAUTHENTICATED = "CHANNEL_UNAUTHENTICATED";

/** Reuses RA-019's aliases deliberately: the same two identities, one vocabulary. */
export const CalendarAccountAlias = {
  PRIVATE: "PRIVATE",
  SONDERMIND: "SONDERMIND",
} as const;

export type CalendarAccountAlias = (typeof CalendarAccountAlias)[keyof typeof CalendarAccountAlias];

export const calendarAccountAlias = z.enum([
  CalendarAccountAlias.PRIVATE,
  CalendarAccountAlias.SONDERMIND,
]);

/**
 * An allowlisted (account, calendar) pair. Obtainable ONLY from
 * {@link CalendarRegistry.resolve}.
 *
 * The unit of scope is the PAIR, not the account. One account commonly watches
 * several calendars ("work", "on-call", a shared team calendar), and each has its own
 * independent `syncToken` and watch channel. A per-account cursor would let one
 * calendar's response advance another's sync position, silently skipping events —
 * which is criterion 2's failure mode.
 */
declare const allowlisted: unique symbol;

export type CalendarCollectionRef = Readonly<{
  readonly [allowlisted]: true;
  account_alias: CalendarAccountAlias;
  calendar_id: string;
  connection_id: string;
  discord_channel: string;
}>;

export const calendarAllowlistEntry = valueObject({
  account_alias: calendarAccountAlias,
  /** Google calendar id, e.g. `primary` or an address. */
  calendar_id: z.string().min(1).max(255),
  connection_id: idString,
  discord_channel: z
    .string()
    .min(2)
    .max(100)
    .regex(/^#[a-z0-9-]+$/u, "channel must look like #name"),
});

export type CalendarAllowlistEntry = z.infer<typeof calendarAllowlistEntry>;

/** Stable key for one collection. */
function collectionKey(alias: CalendarAccountAlias, calendarId: string): string {
  return `${alias}\0${calendarId}`;
}

/**
 * The (account, calendar) allowlist.
 *
 * Refuses a configuration where two DIFFERENT accounts route to the same Discord
 * channel — the misconfiguration that would defeat every isolation test while all of
 * them still passed. Two calendars of the SAME account may share a channel, which is
 * ordinary and useful ("all my work calendars in #calendar-sondermind").
 */
export class CalendarRegistry {
  readonly #byKey = new Map<string, CalendarAllowlistEntry>();
  readonly #channelOwner = new Map<string, CalendarAccountAlias>();

  public constructor(entries: readonly CalendarAllowlistEntry[]) {
    for (const raw of entries) {
      const entry = calendarAllowlistEntry.parse(raw);
      const key = collectionKey(entry.account_alias, entry.calendar_id);
      if (this.#byKey.has(key)) {
        throw new CalendarConnectorError(
          CALENDAR_SCOPE_MISMATCH,
          `duplicate calendar: ${entry.account_alias}/${entry.calendar_id}`,
        );
      }
      const owner = this.#channelOwner.get(entry.discord_channel);
      if (owner !== undefined && owner !== entry.account_alias) {
        // Cross-account channel sharing is the one mistake that makes correct
        // routing deliver to the wrong place.
        throw new CalendarConnectorError(
          CALENDAR_SCOPE_MISMATCH,
          `channel ${entry.discord_channel} is already owned by ${owner}`,
        );
      }
      this.#channelOwner.set(entry.discord_channel, entry.account_alias);
      this.#byKey.set(key, entry);
    }
  }

  /** Every allowlisted pair, for diagnostics. */
  public get collections(): readonly string[] {
    return Object.freeze(
      [...this.#byKey.values()]
        .map((entry) => `${entry.account_alias}/${entry.calendar_id}`)
        .sort(),
    );
  }

  /** Resolve a pair, or throw. The ONLY producer of {@link CalendarCollectionRef}. */
  public resolve(alias: CalendarAccountAlias | string, calendarId: string): CalendarCollectionRef {
    const entry = this.#byKey.get(collectionKey(alias as CalendarAccountAlias, calendarId));
    if (entry === undefined) {
      throw new CalendarConnectorError(
        CALENDAR_NOT_ALLOWED,
        `calendar is not allowlisted: ${String(alias)}/${calendarId}`,
      );
    }
    return Object.freeze({
      account_alias: entry.account_alias,
      calendar_id: entry.calendar_id,
      connection_id: entry.connection_id,
      discord_channel: entry.discord_channel,
    }) as CalendarCollectionRef;
  }

  public permits(alias: string, calendarId: string): boolean {
    return this.#byKey.has(collectionKey(alias as CalendarAccountAlias, calendarId));
  }
}

/** Refuse to combine values from different collections. */
export function assertSameCollection(
  collection: CalendarCollectionRef,
  scoped: { readonly account_alias: CalendarAccountAlias; readonly calendar_id: string },
): void {
  if (
    collection.account_alias !== scoped.account_alias ||
    collection.calendar_id !== scoped.calendar_id
  ) {
    throw new CalendarConnectorError(
      CALENDAR_SCOPE_MISMATCH,
      "value belongs to a different calendar collection",
    );
  }
}

/**
 * An opaque sync token, per collection.
 *
 * `token` is deliberately unvalidated beyond being a non-empty bounded string:
 * Google's format is undocumented and may change, and a client that rejects a
 * well-formed-but-unexpected token would break on a server change while looking
 * strict. There is no ordering here — see the module note.
 */
export const calendarSyncState = versionedContract({
  account_alias: calendarAccountAlias,
  calendar_id: z.string().min(1).max(255),
  /** `null` before the first full sync completes. */
  sync_token: z.string().min(1).max(4_096).nullable(),
  updated_at_ms: z.int().nonnegative(),
});

export type CalendarSyncState = z.infer<typeof calendarSyncState>;

/** What happened to an event. */
export const CalendarChangeKind = {
  CREATED: "CREATED",
  UPDATED: "UPDATED",
  /** Removed from the calendar entirely. */
  DELETED: "DELETED",
  /** Still present but cancelled — a distinct state in Google's model. */
  CANCELLED: "CANCELLED",
  /** An attendee response changed. */
  RESPONDED: "RESPONDED",
} as const;

export type CalendarChangeKind = (typeof CalendarChangeKind)[keyof typeof CalendarChangeKind];

export const calendarChangeKind = z.enum([
  CalendarChangeKind.CREATED,
  CalendarChangeKind.UPDATED,
  CalendarChangeKind.DELETED,
  CalendarChangeKind.CANCELLED,
  CalendarChangeKind.RESPONDED,
]);

/**
 * One event as observed.
 *
 * `series_id` and `original_start_time` are what make criterion 5 answerable. Google
 * models a recurring series as a parent event plus materialised "instances", and an
 * instance override carries its own id — so correlating a cancelled instance back to
 * its series requires the parent id, while distinguishing WHICH occurrence was
 * cancelled requires the original start time. Keeping only one of the two makes the
 * other question unanswerable.
 *
 * Times are stored as RFC 3339 strings WITH their offset, plus the IANA zone
 * separately. A UTC instant alone loses the information needed to render "9am local"
 * correctly across a DST boundary, and a zone alone cannot disambiguate the repeated
 * hour when clocks go back.
 */
export const calendarEventRecord = valueObject({
  account_alias: calendarAccountAlias,
  calendar_id: z.string().min(1).max(255),
  event_id: z.string().min(1).max(1_024),
  /** Google's version marker. Changes on every mutation; the dedup key. */
  etag: z.string().min(1).max(255),
  kind: calendarChangeKind,
  /** Parent series id for a recurring instance; `null` for a standalone event. */
  series_id: z.string().min(1).max(1_024).nullable(),
  /** Which occurrence this instance overrides; `null` unless an instance. */
  original_start_time: z.string().max(64).nullable(),
  /** RFC 3339 with offset, so a DST-repeated hour stays unambiguous. */
  start_time: z.string().max(64).nullable(),
  end_time: z.string().max(64).nullable(),
  /** IANA zone, kept alongside the offset rather than instead of it. */
  time_zone: z.string().max(64).nullable(),
  /** Attacker-influenced text: an invitation is sent by anyone. */
  untrusted: valueObject({
    trust: z.literal(TrustLevel.UNTRUSTED_DATA),
    summary: z.string().max(MAX_CALENDAR_TEXT),
    description: text,
    organizer: z.string().max(MAX_CALENDAR_TEXT),
  }),
});

export type CalendarEventRecord = z.infer<typeof calendarEventRecord>;

/**
 * A watch channel's identity and lifetime.
 *
 * `channel_id` and `resource_id` are Google's, and `token` is OURS — an opaque secret
 * we hand Google at registration and that it echoes back on every notification. It is
 * the only thing distinguishing a genuine notification from anyone who guessed the
 * endpoint, which is why {@link verifyCalendarNotification} compares it in constant
 * time.
 */
export const calendarChannel = versionedContract({
  account_alias: calendarAccountAlias,
  calendar_id: z.string().min(1).max(255),
  channel_id: z.string().min(1).max(255),
  resource_id: z.string().min(1).max(255),
  /** Our shared secret for this channel. Never logged. */
  token: z.string().min(8).max(512),
  expires_at_ms: z.int().nonnegative(),
});

export type CalendarChannel = z.infer<typeof calendarChannel>;

/** Health of one collection's watch channel. */
export const CalendarChannelHealth = {
  ACTIVE: "ACTIVE",
  /** Inside the renewal window; a replacement should be created now. */
  EXPIRING: "EXPIRING",
  EXPIRED: "EXPIRED",
  ABSENT: "ABSENT",
} as const;

export type CalendarChannelHealth =
  (typeof CalendarChannelHealth)[keyof typeof CalendarChannelHealth];

export const calendarChannelHealth = z.enum([
  CalendarChannelHealth.ACTIVE,
  CalendarChannelHealth.EXPIRING,
  CalendarChannelHealth.EXPIRED,
  CalendarChannelHealth.ABSENT,
]);
