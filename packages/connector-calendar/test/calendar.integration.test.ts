/**
 * Tests for the Calendar two-account connector.
 *
 * The Google API is a recording fake, per the task's required verification
 * ("fixtures watch headers, full/incremental sync, pagination and 410"): it captures
 * which collection each call was for and whether a token was used, so assertions are
 * about what would actually have been requested.
 *
 * What each block proves:
 *
 *   1. **AC1 — a bodyless notification drives the right incremental sync.** The
 *      notification is authenticated from headers alone and the resolved collection is
 *      the one synced;
 *   2. **AC2 — each collection has its own cursor and channel lifecycle.** Two
 *      calendars of the SAME account are driven independently, which is the case a
 *      per-account cursor would break;
 *   3. **AC3 — HTTP 410 forces an auditable full resync.** Recorded with the token
 *      that was refused;
 *   4. **AC4 — an overlapping old/new channel does not duplicate.** The same event
 *      arrives twice with the same etag, and once more with a new etag;
 *   5. **AC5 — a recurring instance correlates to its series.** Including the
 *      distinction a series id alone cannot make: which occurrence was cancelled;
 *   6. **AC6 — private and work stay separate.** Adversarial: a lying response, a
 *      foreign sync state, a foreign channel, and a cross-account channel share;
 *   7. **AC7 — a lost notification is found by reconciliation.**
 *
 * Timezone/DST cases are covered in their own block, because "9am local across a DST
 * boundary" is where a UTC-only representation quietly produces the wrong hour.
 */
import { describe, expect, it } from "vitest";

import {
  CALENDAR_CHANNEL_UNAUTHENTICATED,
  CALENDAR_NOT_ALLOWED,
  CALENDAR_SCOPE_MISMATCH,
  CalendarAccountAlias,
  CalendarChangeKind,
  CalendarChannelHealth,
  CalendarConnectorError,
  CalendarRegistry,
  CalendarSyncEngine,
  CalendarSyncTokenExpiredError,
  InMemoryCalendarSyncStore,
  calendarChannel,
  calendarEventRecord,
  classifyChannel,
  correlateSeries,
  routeCalendarEvent,
  verifyCalendarNotification,
} from "../src/index.js";
import type {
  CalendarApi,
  CalendarApiEvent,
  CalendarChannel,
  CalendarCollectionRef,
  CalendarEventRecord,
  CalendarPage,
} from "../src/index.js";

const ENTRIES = [
  {
    account_alias: CalendarAccountAlias.PRIVATE,
    calendar_id: "primary",
    connection_id: "conn-private",
    discord_channel: "#calendar-private",
  },
  {
    account_alias: CalendarAccountAlias.SONDERMIND,
    calendar_id: "primary",
    connection_id: "conn-work",
    discord_channel: "#calendar-sondermind",
  },
  {
    // A SECOND calendar for the same account: the case a per-account cursor breaks.
    account_alias: CalendarAccountAlias.SONDERMIND,
    calendar_id: "oncall@example.invalid",
    connection_id: "conn-work",
    discord_channel: "#calendar-sondermind",
  },
] as const;

const NOW = 5_000_000;
const TOKEN = "channel-secret-token-abc123";

function registry() {
  return new CalendarRegistry([...ENTRIES]);
}

function apiEvent(overrides: Partial<CalendarApiEvent> = {}): CalendarApiEvent {
  return {
    event_id: "evt-1",
    etag: "etag-1",
    kind: CalendarChangeKind.UPDATED,
    start_time: "2026-03-29T09:00:00+01:00",
    end_time: "2026-03-29T10:00:00+01:00",
    time_zone: "Europe/Warsaw",
    summary: "Standup",
    organizer: "someone@example.invalid",
    ...overrides,
  };
}

/** Recording fake: remembers which collection each call was for. */
function fakeApi(
  script: {
    pages?: readonly CalendarPage[];
    full?: readonly CalendarPage[];
    expire?: boolean;
    channelExpiry?: number;
  } = {},
) {
  const calls: { method: string; key: string; usedToken?: string; pageToken?: string }[] = [];
  let incrementalIndex = 0;
  let fullIndex = 0;
  let channelSeq = 0;

  const api: CalendarApi = {
    listIncremental: async ({ collection, syncToken, pageToken }) => {
      calls.push({
        method: "listIncremental",
        key: `${collection.account_alias}/${collection.calendar_id}`,
        usedToken: syncToken,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      if (script.expire === true) throw new CalendarSyncTokenExpiredError();
      const page = script.pages?.[incrementalIndex];
      incrementalIndex += 1;
      return page ?? { events: [apiEvent()], nextSyncToken: "token-next" };
    },
    listFull: async ({ collection, pageToken }) => {
      calls.push({
        method: "listFull",
        key: `${collection.account_alias}/${collection.calendar_id}`,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const page = script.full?.[fullIndex];
      fullIndex += 1;
      return page ?? { events: [apiEvent()], nextSyncToken: "token-full" };
    },
    createChannel: async ({ collection }) => {
      channelSeq += 1;
      calls.push({
        method: "createChannel",
        key: `${collection.account_alias}/${collection.calendar_id}`,
      });
      return {
        channelId: `chan-${String(channelSeq)}`,
        resourceId: `res-${String(channelSeq)}`,
        token: TOKEN,
        expiresAtMs: script.channelExpiry ?? NOW + 90_000_000,
      };
    },
    stopChannel: async ({ collection }) => {
      calls.push({
        method: "stopChannel",
        key: `${collection.account_alias}/${collection.calendar_id}`,
      });
    },
  };
  return { api, calls };
}

function channel(
  collection: CalendarCollectionRef,
  overrides: Partial<CalendarChannel> = {},
): CalendarChannel {
  return calendarChannel.parse({
    schema_version: 1,
    account_alias: collection.account_alias,
    calendar_id: collection.calendar_id,
    channel_id: "chan-1",
    resource_id: "res-1",
    token: TOKEN,
    expires_at_ms: NOW + 90_000_000,
    ...overrides,
  });
}

function record(
  collection: CalendarCollectionRef,
  overrides: Partial<CalendarEventRecord> = {},
): CalendarEventRecord {
  return calendarEventRecord.parse({
    account_alias: collection.account_alias,
    calendar_id: collection.calendar_id,
    event_id: "evt-1",
    etag: "etag-1",
    kind: CalendarChangeKind.UPDATED,
    series_id: null,
    original_start_time: null,
    start_time: "2026-03-29T09:00:00+01:00",
    end_time: "2026-03-29T10:00:00+01:00",
    time_zone: "Europe/Warsaw",
    untrusted: { trust: "UNTRUSTED_DATA", summary: "s", description: "d", organizer: "o" },
    ...overrides,
  });
}

describe("calendar two-account connector", () => {
  describe("AC6: private and SonderMind stay separate", () => {
    it("refuses a calendar that is not allowlisted", () => {
      const reg = registry();
      for (const [alias, calendarId] of [
        [CalendarAccountAlias.PRIVATE, "oncall@example.invalid"],
        [CalendarAccountAlias.SONDERMIND, "secret@example.invalid"],
        ["PERSONAL", "primary"],
      ] as const) {
        try {
          reg.resolve(alias, calendarId);
          throw new Error(`expected a refusal for ${alias}/${calendarId}`);
        } catch (error) {
          expect((error as { code?: string }).code).toBe(CALENDAR_NOT_ALLOWED);
        }
      }
      // The private account may NOT reach the work account's on-call calendar even
      // though that calendar is allowlisted — for the other account.
      expect(reg.permits(CalendarAccountAlias.PRIVATE, "oncall@example.invalid")).toBe(false);
      expect(reg.permits(CalendarAccountAlias.SONDERMIND, "oncall@example.invalid")).toBe(true);
    });

    it("refuses a registry where two ACCOUNTS share a channel", () => {
      // The misconfiguration that defeats every other isolation test: routing would
      // be "correct" to a channel that is wrong.
      expect(
        () =>
          new CalendarRegistry([
            { ...ENTRIES[0] },
            { ...ENTRIES[1], discord_channel: "#calendar-private" },
          ]),
      ).toThrow(CalendarConnectorError);
    });

    it("ALLOWS two calendars of the same account to share a channel", () => {
      // Ordinary and useful: all my work calendars in one channel. Forbidding this
      // would be over-strict, so the rule is cross-account only.
      expect(() => new CalendarRegistry([{ ...ENTRIES[1] }, { ...ENTRIES[2] }])).not.toThrow();
    });

    it("routes each collection only to its own channel", () => {
      const reg = registry();
      const priv = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");
      const work = reg.resolve(CalendarAccountAlias.SONDERMIND, "primary");

      expect(routeCalendarEvent(priv, record(priv)).discord_channel).toBe("#calendar-private");
      expect(routeCalendarEvent(work, record(work)).discord_channel).toBe("#calendar-sondermind");
    });

    it("refuses an event that LIES about its collection", () => {
      const reg = registry();
      const work = reg.resolve(CalendarAccountAlias.SONDERMIND, "primary");
      const lying = record(work, { account_alias: CalendarAccountAlias.PRIVATE });

      try {
        routeCalendarEvent(work, lying);
        throw new Error("expected a refusal");
      } catch (error) {
        expect((error as { code?: string }).code).toBe(CALENDAR_SCOPE_MISMATCH);
      }
    });

    it("refuses a sync state belonging to another collection", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      const { api } = fakeApi();
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      // Write state for the work account, then sync the private one.
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.SONDERMIND,
        calendar_id: "primary",
        sync_token: "work-token",
        updated_at_ms: NOW,
      });

      const outcome = await engine.sync(reg.resolve(CalendarAccountAlias.PRIVATE, "primary"));
      // The private collection has no state of its own, so this is a first full sync
      // rather than a replay from the work account's position.
      expect(outcome.full_sync).toBe(true);
      expect(outcome.account_alias).toBe(CalendarAccountAlias.PRIVATE);
    });

    it("refuses a channel belonging to another collection", async () => {
      const reg = registry();
      const { api } = fakeApi();
      const engine = new CalendarSyncEngine({
        api,
        store: new InMemoryCalendarSyncStore(),
        now: () => NOW,
      });
      const work = reg.resolve(CalendarAccountAlias.SONDERMIND, "primary");

      await expect(
        engine.ensureChannel({
          collection: reg.resolve(CalendarAccountAlias.PRIVATE, "primary"),
          current: channel(work),
        }),
      ).rejects.toThrow(CalendarConnectorError);
    });
  });

  describe("AC1: a bodyless notification drives the right incremental sync", () => {
    it("authenticates from headers alone and resolves the collection", () => {
      const reg = registry();
      const priv = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");
      const resolved = verifyCalendarNotification({
        notification: {
          channelId: "chan-1",
          resourceId: "res-1",
          channelToken: TOKEN,
          resourceState: "exists",
        },
        channels: [channel(priv)],
        registry: reg,
      });

      expect(resolved.account_alias).toBe(CalendarAccountAlias.PRIVATE);
      expect(resolved.calendar_id).toBe("primary");
      expect(resolved.discord_channel).toBe("#calendar-private");
    });

    it("refuses a wrong token, wrong channel id or wrong resource id", () => {
      const reg = registry();
      const priv = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");
      const channels = [channel(priv)];

      for (const notification of [
        {
          channelId: "chan-1",
          resourceId: "res-1",
          channelToken: "wrong",
          resourceState: "exists",
        },
        { channelId: "chan-1", resourceId: "res-1", channelToken: null, resourceState: "exists" },
        { channelId: "other", resourceId: "res-1", channelToken: TOKEN, resourceState: "exists" },
        { channelId: "chan-1", resourceId: "other", channelToken: TOKEN, resourceState: "exists" },
      ]) {
        try {
          verifyCalendarNotification({ notification, channels, registry: reg });
          throw new Error("expected a refusal");
        } catch (error) {
          expect((error as { code?: string }).code).toBe(CALENDAR_CHANNEL_UNAUTHENTICATED);
        }
      }
    });

    it("refuses a stale channel for a de-allowlisted calendar", () => {
      // The channel record is valid, but the calendar is no longer allowlisted. The
      // collection is re-resolved through the registry, so the channel stops working.
      const shrunk = new CalendarRegistry([{ ...ENTRIES[0] }]);
      const work = registry().resolve(CalendarAccountAlias.SONDERMIND, "primary");

      expect(() =>
        verifyCalendarNotification({
          notification: {
            channelId: "chan-1",
            resourceId: "res-1",
            channelToken: TOKEN,
            resourceState: "exists",
          },
          channels: [channel(work)],
          registry: shrunk,
        }),
      ).toThrow(CalendarConnectorError);
    });

    it("syncs incrementally using the stored token", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.PRIVATE,
        calendar_id: "primary",
        sync_token: "stored-token",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi();
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      const outcome = await engine.sync(reg.resolve(CalendarAccountAlias.PRIVATE, "primary"));

      expect(outcome.full_sync).toBe(false);
      expect(calls[0]?.method).toBe("listIncremental");
      expect(calls[0]?.usedToken).toBe("stored-token");
      expect(outcome.events).toHaveLength(1);
      expect(outcome.state.sync_token).toBe("token-next");
    });

    it("follows pagination to the end", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.PRIVATE,
        calendar_id: "primary",
        sync_token: "stored-token",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi({
        pages: [
          { events: [apiEvent({ event_id: "a", etag: "e-a" })], nextPageToken: "p2" },
          { events: [apiEvent({ event_id: "b", etag: "e-b" })], nextPageToken: "p3" },
          { events: [apiEvent({ event_id: "c", etag: "e-c" })], nextSyncToken: "token-end" },
        ],
      });
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      const outcome = await engine.sync(reg.resolve(CalendarAccountAlias.PRIVATE, "primary"));

      expect(outcome.pages).toBe(3);
      expect(outcome.events.map((event) => event.event_id)).toEqual(["a", "b", "c"]);
      // The sync token comes from the LAST page; only it carries one.
      expect(outcome.state.sync_token).toBe("token-end");
      expect(calls.filter((call) => call.method === "listIncremental")).toHaveLength(3);
    });
  });

  describe("AC2: each collection has its own cursor and channel lifecycle", () => {
    it("keeps two calendars of the SAME account independent", async () => {
      // The case a per-account cursor would break: one calendar's response advancing
      // the other's position, silently skipping events.
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      const { api, calls } = fakeApi();
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      const primary = reg.resolve(CalendarAccountAlias.SONDERMIND, "primary");
      const oncall = reg.resolve(CalendarAccountAlias.SONDERMIND, "oncall@example.invalid");

      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.SONDERMIND,
        calendar_id: "primary",
        sync_token: "primary-token",
        updated_at_ms: NOW,
      });

      const first = await engine.sync(primary);
      const second = await engine.sync(oncall);

      expect(first.full_sync).toBe(false);
      // The on-call calendar has no token of its own, so it does a FULL sync rather
      // than reusing `primary`'s.
      expect(second.full_sync).toBe(true);
      expect(calls.map((call) => `${call.method}:${call.key}`)).toEqual([
        "listIncremental:SONDERMIND/primary",
        "listFull:SONDERMIND/oncall@example.invalid",
      ]);

      // And their stored states are separate.
      expect((await store.read(CalendarAccountAlias.SONDERMIND, "primary"))?.sync_token).toBe(
        "token-next",
      );
      expect(
        (await store.read(CalendarAccountAlias.SONDERMIND, "oncall@example.invalid"))?.sync_token,
      ).toBe("token-full");
    });

    it("refuses a value from the same ACCOUNT but a different calendar", async () => {
      // Found by mutation: dropping the `calendar_id` half of the scope check left
      // every test green, because no test crossed calendars WITHIN one account. That
      // is the exact conflation criterion 2 forbids — one account's two calendars
      // have independent tokens and channels, so mixing them silently skips events.
      const reg = registry();
      const primary = reg.resolve(CalendarAccountAlias.SONDERMIND, "primary");
      const oncall = reg.resolve(CalendarAccountAlias.SONDERMIND, "oncall@example.invalid");

      // Same account, different calendar: must still be refused.
      expect(() => routeCalendarEvent(primary, record(oncall))).toThrow(CalendarConnectorError);
      try {
        routeCalendarEvent(primary, record(oncall));
      } catch (error) {
        expect((error as { code?: string }).code).toBe(CALENDAR_SCOPE_MISMATCH);
      }

      // And a channel for the sibling calendar cannot be adopted.
      const { api } = fakeApi();
      const engine = new CalendarSyncEngine({
        api,
        store: new InMemoryCalendarSyncStore(),
        now: () => NOW,
      });
      await expect(
        engine.ensureChannel({ collection: primary, current: channel(oncall) }),
      ).rejects.toThrow(CalendarConnectorError);
    });

    it("refuses a sync state from a sibling calendar of the same account", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      const { api, calls } = fakeApi();
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      // Seed only the on-call calendar, then sync `primary`. If the scope check
      // ignored `calendar_id`, `primary` would incrementally sync from on-call's
      // token and skip everything before it.
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.SONDERMIND,
        calendar_id: "oncall@example.invalid",
        sync_token: "oncall-token",
        updated_at_ms: NOW,
      });

      const outcome = await engine.sync(reg.resolve(CalendarAccountAlias.SONDERMIND, "primary"));

      expect(outcome.full_sync).toBe(true);
      expect(calls[0]?.method).toBe("listFull");
      expect(calls[0]?.usedToken).toBeUndefined();
    });

    it("classifies channel health per collection", () => {
      const priv = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      expect(classifyChannel(null, NOW)).toBe(CalendarChannelHealth.ABSENT);
      expect(classifyChannel(channel(priv, { expires_at_ms: NOW - 1 }), NOW)).toBe(
        CalendarChannelHealth.EXPIRED,
      );
      // Inside the renewal window: a replacement must be created BEFORE delivery
      // stops, or every renewal cycle guarantees a gap.
      expect(classifyChannel(channel(priv, { expires_at_ms: NOW + 1_000 }), NOW)).toBe(
        CalendarChannelHealth.EXPIRING,
      );
      expect(classifyChannel(channel(priv, { expires_at_ms: NOW + 90_000_000 }), NOW)).toBe(
        CalendarChannelHealth.ACTIVE,
      );
    });

    it("renews one collection's channel without touching another's", async () => {
      const reg = registry();
      const { api, calls } = fakeApi();
      const engine = new CalendarSyncEngine({
        api,
        store: new InMemoryCalendarSyncStore(),
        now: () => NOW,
      });
      const primary = reg.resolve(CalendarAccountAlias.SONDERMIND, "primary");
      const oncall = reg.resolve(CalendarAccountAlias.SONDERMIND, "oncall@example.invalid");

      const renewed = await engine.ensureChannel({
        collection: primary,
        current: channel(primary, { expires_at_ms: NOW - 1 }),
      });
      const healthy = channel(oncall, { expires_at_ms: NOW + 90_000_000 });
      const untouched = await engine.ensureChannel({ collection: oncall, current: healthy });

      expect(renewed.replaced).not.toBeNull();
      expect(untouched.channel).toBe(healthy);
      expect(untouched.replaced).toBeNull();
      const created = calls.filter((call) => call.method === "createChannel");
      expect(created).toHaveLength(1);
      expect(created[0]?.key).toBe("SONDERMIND/primary");
    });
  });

  describe("AC3: HTTP 410 forces an auditable full resync", () => {
    it("resyncs and records the token that was refused", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.PRIVATE,
        calendar_id: "primary",
        sync_token: "expired-token",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi({ expire: true });
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      const outcome = await engine.sync(reg.resolve(CalendarAccountAlias.PRIVATE, "primary"));

      expect(outcome.full_sync).toBe(true);
      // The audit trail: WHICH token failed, so the gap is a deliberate reset.
      expect(outcome.reset_from).toBe("expired-token");
      expect(calls.map((call) => call.method)).toEqual(["listIncremental", "listFull"]);
      expect(outcome.state.sync_token).toBe("token-full");
    });

    it("does not mix another collection's data into the resync", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      for (const [alias, calendarId] of [
        [CalendarAccountAlias.PRIVATE, "primary"],
        [CalendarAccountAlias.SONDERMIND, "primary"],
      ] as const) {
        await store.write({
          schema_version: 1,
          account_alias: alias,
          calendar_id: calendarId,
          sync_token: `${alias}-token`,
          updated_at_ms: NOW,
        });
      }
      const { api, calls } = fakeApi({ expire: true });
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      const outcome = await engine.sync(reg.resolve(CalendarAccountAlias.PRIVATE, "primary"));

      // Every call was for the private collection; the resync did not touch work.
      expect(calls.every((call) => call.key === "PRIVATE/primary")).toBe(true);
      expect(outcome.events.every((event) => event.account_alias === "PRIVATE")).toBe(true);
      // And the work account's token is untouched.
      expect((await store.read(CalendarAccountAlias.SONDERMIND, "primary"))?.sync_token).toBe(
        "SONDERMIND-token",
      );
    });

    it("treats a first run as a recorded full sync, not a silent gap", async () => {
      const { api } = fakeApi();
      const engine = new CalendarSyncEngine({
        api,
        store: new InMemoryCalendarSyncStore(),
        now: () => NOW,
      });
      const outcome = await engine.sync(
        registry().resolve(CalendarAccountAlias.PRIVATE, "primary"),
      );
      expect(outcome.full_sync).toBe(true);
      expect(outcome.reset_from).toBeNull();
    });
  });

  describe("AC4: overlapping old and new channels do not duplicate", () => {
    it("emits the same etag once and a new etag again", async () => {
      // Renewal deliberately overlaps, so the same change arrives through two
      // channels. The sync token cannot help — it is opaque — so dedup keys on
      // (event_id, etag).
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.PRIVATE,
        calendar_id: "primary",
        sync_token: "t0",
        updated_at_ms: NOW,
      });
      const { api } = fakeApi({
        pages: [
          { events: [apiEvent({ etag: "v1" })], nextSyncToken: "t1" },
          // Same event, same version: the duplicate an overlap produces.
          { events: [apiEvent({ etag: "v1" })], nextSyncToken: "t2" },
          // Same event, NEW version: a real second edit, which must be emitted.
          { events: [apiEvent({ etag: "v2" })], nextSyncToken: "t3" },
        ],
      });
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });
      const collection = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");

      const first = await engine.sync(collection);
      const duplicate = await engine.sync(collection);
      const realEdit = await engine.sync(collection);

      expect(first.events).toHaveLength(1);
      expect(duplicate.events).toHaveLength(0);
      // Keying on event_id alone would have swallowed this.
      expect(realEdit.events).toHaveLength(1);
      expect(realEdit.events[0]?.etag).toBe("v2");
    });

    it("creates the new channel BEFORE stopping the old one", async () => {
      const reg = registry();
      const { api, calls } = fakeApi();
      const engine = new CalendarSyncEngine({
        api,
        store: new InMemoryCalendarSyncStore(),
        now: () => NOW,
      });
      const collection = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");

      await engine.ensureChannel({
        collection,
        current: channel(collection, { expires_at_ms: NOW + 1_000 }),
      });

      const methods = calls.map((call) => call.method);
      // Order matters: stop-then-create would leave a window in which notifications
      // are silently dropped.
      expect(methods.indexOf("createChannel")).toBeLessThan(methods.indexOf("stopChannel"));
    });

    it("survives a failure to stop the old channel", async () => {
      const reg = registry();
      const { api } = fakeApi();
      const engine = new CalendarSyncEngine({
        api: {
          ...api,
          stopChannel: async () => {
            throw new Error("already gone");
          },
        },
        store: new InMemoryCalendarSyncStore(),
        now: () => NOW,
      });
      const collection = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");

      // An already-dead channel is not a failure: it will expire on its own, and
      // dedup absorbs the overlap.
      const result = await engine.ensureChannel({
        collection,
        current: channel(collection, { expires_at_ms: NOW - 1 }),
      });
      expect(result.channel.channel_id).toBe("chan-1");
    });
  });

  describe("AC5: a recurring instance correlates to its series", () => {
    it("correlates an instance to its parent and names the occurrence", () => {
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      const instance = record(collection, {
        event_id: "series-1_20260329T080000Z",
        series_id: "series-1",
        original_start_time: "2026-03-29T09:00:00+01:00",
        kind: CalendarChangeKind.CANCELLED,
      });

      const correlation = correlateSeries(instance);
      expect(correlation.series_id).toBe("series-1");
      expect(correlation.is_instance).toBe(true);
      // A series id alone cannot say WHICH occurrence was cancelled; the original
      // start time is what answers that.
      expect(correlation.occurrence).toBe("2026-03-29T09:00:00+01:00");
    });

    it("treats a standalone event as its own series", () => {
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      const correlation = correlateSeries(record(collection, { event_id: "solo" }));
      expect(correlation.series_id).toBe("solo");
      expect(correlation.is_instance).toBe(false);
      expect(correlation.occurrence).toBeNull();
    });

    it("routes an instance under its series id, so it threads with the series", () => {
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      const route = routeCalendarEvent(
        collection,
        record(collection, { event_id: "series-1_2026", series_id: "series-1" }),
      );
      expect(route.series_id).toBe("series-1");
      expect(route.event_id).toBe("series-1_2026");
    });

    it("distinguishes CANCELLED from DELETED", () => {
      // Google's model has both: a cancelled instance still exists on the calendar,
      // a deleted one does not. Collapsing them would lose the difference between
      // "this meeting was called off" and "this meeting never existed".
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      expect(record(collection, { kind: CalendarChangeKind.CANCELLED }).kind).toBe("CANCELLED");
      expect(record(collection, { kind: CalendarChangeKind.DELETED }).kind).toBe("DELETED");
    });
  });

  describe("timezone and DST edge cases", () => {
    it("keeps the offset AND the zone, so a DST-repeated hour is unambiguous", () => {
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      // 2026-10-25 is the European DST fallback: 02:30 occurs twice in Warsaw, once
      // at +02:00 and once at +01:00. A UTC instant alone cannot render "02:30
      // local" correctly, and a zone alone cannot say which 02:30 this is.
      const before = record(collection, {
        event_id: "dst-1",
        etag: "e1",
        start_time: "2026-10-25T02:30:00+02:00",
        time_zone: "Europe/Warsaw",
      });
      const after = record(collection, {
        event_id: "dst-2",
        etag: "e2",
        start_time: "2026-10-25T02:30:00+01:00",
        time_zone: "Europe/Warsaw",
      });

      expect(before.start_time).not.toBe(after.start_time);
      // Same wall-clock text, different instants — which is exactly the ambiguity the
      // offset resolves.
      expect(new Date(before.start_time ?? "").getTime()).not.toBe(
        new Date(after.start_time ?? "").getTime(),
      );
      expect(before.time_zone).toBe(after.time_zone);
    });

    it("carries an all-day event with no time and no zone", () => {
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      // An all-day event has a date, not an instant. Forcing a time onto it would
      // invent a timezone the organiser never chose.
      const allDay = record(collection, {
        start_time: "2026-03-29",
        end_time: "2026-03-30",
        time_zone: null,
      });
      expect(allDay.time_zone).toBeNull();
      expect(allDay.start_time).toBe("2026-03-29");
    });

    it("carries a deleted event with no times at all", () => {
      const collection = registry().resolve(CalendarAccountAlias.PRIVATE, "primary");
      const deleted = record(collection, {
        kind: CalendarChangeKind.DELETED,
        start_time: null,
        end_time: null,
        time_zone: null,
      });
      expect(deleted.start_time).toBeNull();
    });
  });

  describe("AC7: a lost notification is found by reconciliation", () => {
    it("finds a change whose notification never arrived", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.PRIVATE,
        calendar_id: "primary",
        sync_token: "t0",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi({
        pages: [{ events: [apiEvent({ event_id: "lost", etag: "lost-1" })], nextSyncToken: "t1" }],
      });
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });

      // No notification at all: reconciliation syncs from the stored token.
      const outcome = await engine.reconcile(reg.resolve(CalendarAccountAlias.PRIVATE, "primary"));

      expect(outcome.events.map((event) => event.event_id)).toEqual(["lost"]);
      expect(calls[0]?.usedToken).toBe("t0");
    });

    it("does not re-emit what a notification already delivered", async () => {
      const reg = registry();
      const store = new InMemoryCalendarSyncStore();
      await store.write({
        schema_version: 1,
        account_alias: CalendarAccountAlias.PRIVATE,
        calendar_id: "primary",
        sync_token: "t0",
        updated_at_ms: NOW,
      });
      const { api } = fakeApi({
        pages: [
          { events: [apiEvent({ etag: "same" })], nextSyncToken: "t1" },
          { events: [apiEvent({ etag: "same" })], nextSyncToken: "t2" },
        ],
      });
      const engine = new CalendarSyncEngine({ api, store, now: () => NOW });
      const collection = reg.resolve(CalendarAccountAlias.PRIVATE, "primary");

      expect((await engine.sync(collection)).events).toHaveLength(1);
      expect((await engine.reconcile(collection)).events).toHaveLength(0);
    });
  });

  describe("export surface", () => {
    it("shares no exported name with the packages it builds on", async () => {
      const [own, contracts, tools] = await Promise.all([
        import("../src/index.js"),
        import("@remoteagent/contracts"),
        import("@remoteagent/implementation-tools"),
      ]);
      const foreign = new Set([...Object.keys(contracts), ...Object.keys(tools)]);
      expect(Object.keys(own).filter((name) => foreign.has(name))).toEqual([]);
    });

    it("no longer exports the RA-001 packageName skeleton relic", async () => {
      const own = await import("../src/index.js");
      expect(Object.keys(own)).not.toContain("packageName");
    });
  });
});
