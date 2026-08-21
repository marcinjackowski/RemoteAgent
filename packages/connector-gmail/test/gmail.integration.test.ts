/**
 * Tests for the Gmail two-account connector.
 *
 * The Gmail API is a fake, as the task's required verification specifies
 * ("Pub/Sub/watch/history fixtures for two accounts"), but a *recording* one: it
 * captures which account each call was made for, so cross-account assertions are
 * about what would actually have been requested rather than about return values.
 *
 * What each block proves:
 *
 *   1. **AC1 — a notification carrying only a history id reconstructs the changes.**
 *      Replay starts from the STORED cursor, not from the notification, which is the
 *      only version that also recovers a lost notification;
 *   2. **AC2 — duplicates and out-of-order deliveries change nothing.** Both
 *      mechanisms are driven separately, because a monotonic cursor and a seen-set
 *      fail differently;
 *   3. **AC3 — each watch renews independently with its own health.** Including the
 *      case that matters: one mailbox expired while the other is healthy;
 *   4. **AC4 — a lost notification is recovered by reconciliation.** A notification
 *      is dropped entirely and the change still arrives;
 *   5. **AC5 — private never reaches work and vice versa.** Adversarial: a response
 *      that lies about its own account, a foreign cursor, a foreign watch state, and
 *      a registry misconfiguration that would defeat every other test;
 *   6. **AC6 — content is not fetched or logged without need and provenance.**
 *   7. **AC7 — an invalid cursor resyncs without losing the audit trail.**
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GMAIL_BODY_POLICY,
  GMAIL_ACCOUNT_MISMATCH,
  GMAIL_ACCOUNT_NOT_REGISTERED,
  GMAIL_FETCH_NOT_JUSTIFIED,
  GmailAccountAlias,
  GmailAccountRegistry,
  GmailChangeKind,
  GmailConnectorError,
  GmailHistoryExpiredError,
  GmailSyncEngine,
  GmailWatchHealth,
  InMemoryGmailCursorStore,
  classifyWatch,
  compareHistoryIds,
  fetchGmailBody,
  gmailWatchState,
  routeGmailEvent,
} from "../src/index.js";
import type {
  GmailAccountRef,
  GmailApi,
  GmailContentApi,
  GmailHistoryEntry,
  GmailMessageSummary,
} from "../src/index.js";

const ENTRIES = [
  {
    alias: GmailAccountAlias.PRIVATE,
    connection_id: "conn-private",
    discord_channel: "#gmail-private",
    subscription: "projects/p/subscriptions/private",
  },
  {
    alias: GmailAccountAlias.SONDERMIND,
    connection_id: "conn-work",
    discord_channel: "#gmail-sondermind",
    subscription: "projects/p/subscriptions/work",
  },
] as const;

const SECRET = "glpat-EMAILLEAKTOKEN12345";

function registry() {
  return new GmailAccountRegistry([...ENTRIES]);
}

function entry(overrides: Partial<GmailHistoryEntry> = {}): GmailHistoryEntry {
  return {
    history_id: "1001",
    message_id: "msg-1",
    thread_id: "thread-1",
    kind: GmailChangeKind.MESSAGE_ADDED,
    label_ids: ["INBOX"],
    subject: "Status update",
    from: "someone@example.invalid",
    snippet: "Here is the update",
    ...overrides,
  };
}

/** Recording fake: remembers which account each call was for. */
function fakeApi(
  script: {
    history?: Record<string, { entries: readonly GmailHistoryEntry[]; latestHistoryId: string }>;
    expireFor?: readonly string[];
    recent?: { entries: readonly GmailHistoryEntry[]; latestHistoryId: string };
    watchExpiry?: number;
  } = {},
) {
  const calls: { method: string; alias: string; startHistoryId?: string }[] = [];
  const api: GmailApi = {
    listHistory: async ({ account, startHistoryId }) => {
      calls.push({ method: "listHistory", alias: account.alias, startHistoryId });
      if ((script.expireFor ?? []).includes(account.alias)) throw new GmailHistoryExpiredError();
      return script.history?.[account.alias] ?? { entries: [entry()], latestHistoryId: "1001" };
    },
    listRecentMessages: async ({ account }) => {
      calls.push({ method: "listRecentMessages", alias: account.alias });
      return script.recent ?? { entries: [entry()], latestHistoryId: "1001" };
    },
    registerWatch: async ({ account }) => {
      calls.push({ method: "registerWatch", alias: account.alias });
      return {
        expiresAtMs: script.watchExpiry ?? 10_000_000,
        startHistoryId: "900",
      };
    },
  };
  return { api, calls };
}

function summary(
  account: GmailAccountRef,
  overrides: Partial<GmailMessageSummary> = {},
): GmailMessageSummary {
  return {
    account_alias: account.alias,
    message_id: "msg-1",
    thread_id: "thread-1",
    history_id: "1001",
    kind: GmailChangeKind.MESSAGE_ADDED,
    label_ids: ["INBOX"],
    untrusted: { trust: "UNTRUSTED_DATA", subject: "s", from: "f", snippet: "n" },
    ...overrides,
  } as GmailMessageSummary;
}

const NOW = 5_000_000;

describe("gmail two-account connector", () => {
  describe("AC5: the two accounts cannot mix", () => {
    it("refuses an unregistered alias", () => {
      for (const bad of ["PERSONAL", "private", "WORK", ""]) {
        try {
          registry().resolve(bad);
          throw new Error(`expected a refusal for ${bad}`);
        } catch (error) {
          expect((error as { code?: string }).code, bad).toBe(GMAIL_ACCOUNT_NOT_REGISTERED);
        }
      }
    });

    it("refuses a registry where two accounts share a channel", () => {
      // The one misconfiguration that would defeat every other isolation test:
      // routing would be "correct" to a channel that happens to be the wrong one.
      for (const shared of [
        { field: "discord_channel", value: "#gmail-private" },
        { field: "connection_id", value: "conn-private" },
        { field: "subscription", value: "projects/p/subscriptions/private" },
      ]) {
        expect(
          () =>
            new GmailAccountRegistry([
              { ...ENTRIES[0] },
              { ...ENTRIES[1], [shared.field]: shared.value },
            ] as never),
          shared.field,
        ).toThrow(GmailConnectorError);
      }
    });

    it("refuses a duplicate alias", () => {
      expect(() => new GmailAccountRegistry([{ ...ENTRIES[0] }, { ...ENTRIES[0] }])).toThrow(
        GmailConnectorError,
      );
    });

    it("routes each account only to its own channel", () => {
      const reg = registry();
      const priv = reg.resolve(GmailAccountAlias.PRIVATE);
      const work = reg.resolve(GmailAccountAlias.SONDERMIND);

      expect(routeGmailEvent(priv, summary(priv)).discord_channel).toBe("#gmail-private");
      expect(routeGmailEvent(work, summary(work)).discord_channel).toBe("#gmail-sondermind");
    });

    it("refuses a response that LIES about which account it belongs to", () => {
      // The adversarial case: a work-mailbox response claiming to be private. The
      // channel is derived from the ref, so this is refused rather than misrouted.
      const reg = registry();
      const work = reg.resolve(GmailAccountAlias.SONDERMIND);
      const lying = summary(work, { account_alias: GmailAccountAlias.PRIVATE });

      try {
        routeGmailEvent(work, lying);
        throw new Error("expected a refusal");
      } catch (error) {
        expect((error as { code?: string }).code).toBe(GMAIL_ACCOUNT_MISMATCH);
      }
    });

    it("refuses a cursor belonging to the other account", async () => {
      const reg = registry();
      const cursors = new InMemoryGmailCursorStore();
      // Seed a cursor for the WORK account only.
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.SONDERMIND,
        history_id: "500",
        updated_at_ms: NOW,
      });
      const { api } = fakeApi();
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      // The private account must not see it: its own cursor is absent, so this is a
      // first-run resync rather than a replay from the work mailbox's position.
      const outcome = await engine.handleNotification({
        account: reg.resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "1001",
      });
      expect(outcome.resynced).toBe(true);
      expect(outcome.account_alias).toBe(GmailAccountAlias.PRIVATE);
    });

    it("refuses a watch state belonging to the other account", async () => {
      const reg = registry();
      const { api } = fakeApi();
      const engine = new GmailSyncEngine({ api, cursors: new InMemoryGmailCursorStore() });
      const foreign = gmailWatchState.parse({
        schema_version: 1,
        account_alias: GmailAccountAlias.SONDERMIND,
        health: GmailWatchHealth.ACTIVE,
        expires_at_ms: 9_999_999,
        start_history_id: "900",
      });

      await expect(
        engine.ensureWatch({ account: reg.resolve(GmailAccountAlias.PRIVATE), current: foreign }),
      ).rejects.toThrow(GmailConnectorError);
    });

    it("keeps each account's dedup memory separate", async () => {
      const reg = registry();
      const cursors = new InMemoryGmailCursorStore();
      const { api } = fakeApi({
        history: {
          PRIVATE: { entries: [entry()], latestHistoryId: "1001" },
          SONDERMIND: { entries: [entry()], latestHistoryId: "1001" },
        },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      for (const alias of [GmailAccountAlias.PRIVATE, GmailAccountAlias.SONDERMIND]) {
        await cursors.write({
          schema_version: 1,
          account_alias: alias,
          history_id: "500",
          updated_at_ms: NOW,
        });
      }

      const first = await engine.handleNotification({
        account: reg.resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "1001",
      });
      // The SAME message id in the other mailbox is a different message. One
      // account's dedup set must not suppress the other's event.
      const second = await engine.handleNotification({
        account: reg.resolve(GmailAccountAlias.SONDERMIND),
        notifiedHistoryId: "1001",
      });

      expect(first.changes).toHaveLength(1);
      expect(second.changes).toHaveLength(1);
      expect(first.changes[0]?.account_alias).toBe(GmailAccountAlias.PRIVATE);
      expect(second.changes[0]?.account_alias).toBe(GmailAccountAlias.SONDERMIND);
    });
  });

  describe("AC1: a notification with only a history id reconstructs the changes", () => {
    it("replays from the STORED cursor, not from the notification", async () => {
      const reg = registry();
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "500",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi({
        history: {
          PRIVATE: {
            entries: [entry({ history_id: "600" }), entry({ history_id: "700", message_id: "m2" })],
            latestHistoryId: "700",
          },
        },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      const outcome = await engine.handleNotification({
        account: reg.resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "700",
      });

      // The decisive assertion: the replay STARTED at the stored cursor. Starting at
      // the notification's id would skip everything between 500 and 700.
      expect(calls.find((call) => call.method === "listHistory")?.startHistoryId).toBe("500");
      expect(outcome.changes).toHaveLength(2);
      expect(outcome.cursor.history_id).toBe("700");
    });

    it("compares history ids beyond the safe integer range", () => {
      // Gmail ids exceed 2^53, so a numeric comparison would report these as equal
      // and silently drop the gap between them.
      const low = "20000000000000001";
      const high = "20000000000000002";
      expect(Number(low) === Number(high)).toBe(true);
      expect(compareHistoryIds(low, high)).toBeLessThan(0);
      expect(compareHistoryIds(high, low)).toBeGreaterThan(0);
      expect(compareHistoryIds("999", "1000")).toBeLessThan(0);
      expect(compareHistoryIds("0500", "500")).toBe(0);
    });
  });

  describe("AC2: duplicate and out-of-order notifications change nothing", () => {
    async function seeded() {
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "500",
        updated_at_ms: NOW,
      });
      return cursors;
    }

    it("emits a change once even when the history window is replayed", async () => {
      const cursors = await seeded();
      const { api } = fakeApi({
        history: { PRIVATE: { entries: [entry({ history_id: "600" })], latestHistoryId: "600" } },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });
      const account = registry().resolve(GmailAccountAlias.PRIVATE);

      const first = await engine.handleNotification({ account, notifiedHistoryId: "600" });
      // Gmail's history windows overlap and are replayed after a crash, so the same
      // entry legitimately arrives twice. Rewind the cursor to force the replay.
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "500",
        updated_at_ms: NOW,
      });
      const second = await engine.handleNotification({ account, notifiedHistoryId: "600" });

      expect(first.changes).toHaveLength(1);
      expect(second.changes).toHaveLength(0);
    });

    it("ignores a notification older than the stored cursor", async () => {
      const cursors = await seeded();
      const { api, calls } = fakeApi();
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      const outcome = await engine.handleNotification({
        account: registry().resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "400",
      });

      expect(outcome.stale).toBe(true);
      expect(outcome.changes).toEqual([]);
      // No API call at all: an out-of-order notification costs nothing.
      expect(calls.filter((call) => call.method === "listHistory")).toHaveLength(0);
      // And the cursor did not move backwards.
      expect(outcome.cursor.history_id).toBe("500");
    });

    it("bounds the dedup set so a long-running engine does not leak", async () => {
      // Found by an audit probe: the per-account set had no eviction, and this engine
      // is meant to run for weeks. Bounding it is safe because the forward-only
      // cursor is the primary defence — a key only needs to outlive Gmail's
      // overlapping windows and a crash-replay, both of which are recent.
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "0",
        updated_at_ms: NOW,
      });
      let round = 0;
      const api: GmailApi = {
        listHistory: async () => {
          round += 1;
          return {
            entries: [entry({ history_id: String(round), message_id: `m-${String(round)}` })],
            latestHistoryId: String(round),
          };
        },
        listRecentMessages: async () => ({ entries: [], latestHistoryId: "0" }),
        registerWatch: async () => ({ expiresAtMs: NOW + 90_000_000, startHistoryId: "0" }),
      };
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW, seenLimit: 5 });
      const account = registry().resolve(GmailAccountAlias.PRIVATE);

      // Twenty distinct changes through a set bounded at five.
      for (let index = 0; index < 20; index += 1) {
        const outcome = await engine.handleNotification({
          account,
          notifiedHistoryId: String(index + 100),
        });
        // Each is genuinely new, so each must still be emitted — eviction must not
        // suppress a real change.
        expect(outcome.changes).toHaveLength(1);
      }

      // And the most recent keys still deduplicate, which is what the set is for.
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "0",
        updated_at_ms: NOW,
      });
      round -= 1;
      const replay = await engine.handleNotification({ account, notifiedHistoryId: "500" });
      expect(replay.changes).toHaveLength(0);
    });

    it("never moves the cursor backwards, even from an API response", async () => {
      const cursors = await seeded();
      // A response whose latest id is BEHIND the stored cursor: a rewind would
      // re-emit every change after it.
      const { api } = fakeApi({
        history: { PRIVATE: { entries: [], latestHistoryId: "100" } },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      const outcome = await engine.handleNotification({
        account: registry().resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "900",
      });
      expect(outcome.cursor.history_id).toBe("500");
    });
  });

  describe("AC3: each account's watch renews independently with its own health", () => {
    it("classifies absent, active, expiring and expired", () => {
      expect(classifyWatch(null, NOW)).toBe(GmailWatchHealth.ABSENT);
      const state = (expires: number) =>
        gmailWatchState.parse({
          schema_version: 1,
          account_alias: GmailAccountAlias.PRIVATE,
          health: GmailWatchHealth.ACTIVE,
          expires_at_ms: expires,
          start_history_id: "900",
        });
      expect(classifyWatch(state(NOW - 1), NOW)).toBe(GmailWatchHealth.EXPIRED);
      // Inside the renewal window: renewal must happen BEFORE delivery stops, or
      // every renewal cycle guarantees a gap.
      expect(classifyWatch(state(NOW + 1_000), NOW)).toBe(GmailWatchHealth.EXPIRING);
      expect(classifyWatch(state(NOW + 90_000_000), NOW)).toBe(GmailWatchHealth.ACTIVE);
    });

    it("renews one account without touching the other", async () => {
      const reg = registry();
      const { api, calls } = fakeApi({ watchExpiry: NOW + 90_000_000 });
      const engine = new GmailSyncEngine({
        api,
        cursors: new InMemoryGmailCursorStore(),
        now: () => NOW,
      });

      // Private is expired; work is healthy. Renewing private must not renew work.
      const expiredPrivate = gmailWatchState.parse({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        health: GmailWatchHealth.EXPIRED,
        expires_at_ms: NOW - 1,
        start_history_id: "900",
      });
      const healthyWork = gmailWatchState.parse({
        schema_version: 1,
        account_alias: GmailAccountAlias.SONDERMIND,
        health: GmailWatchHealth.ACTIVE,
        expires_at_ms: NOW + 90_000_000,
        start_history_id: "900",
      });

      const renewed = await engine.ensureWatch({
        account: reg.resolve(GmailAccountAlias.PRIVATE),
        current: expiredPrivate,
      });
      const untouched = await engine.ensureWatch({
        account: reg.resolve(GmailAccountAlias.SONDERMIND),
        current: healthyWork,
      });

      expect(renewed.health).toBe(GmailWatchHealth.ACTIVE);
      expect(renewed.account_alias).toBe(GmailAccountAlias.PRIVATE);
      expect(untouched).toBe(healthyWork);
      // Exactly one registration, for the private account only.
      const registrations = calls.filter((call) => call.method === "registerWatch");
      expect(registrations).toHaveLength(1);
      expect(registrations[0]?.alias).toBe(GmailAccountAlias.PRIVATE);
    });

    it("registers a watch that is absent", async () => {
      const { api, calls } = fakeApi();
      const engine = new GmailSyncEngine({
        api,
        cursors: new InMemoryGmailCursorStore(),
        now: () => NOW,
      });
      const state = await engine.ensureWatch({
        account: registry().resolve(GmailAccountAlias.PRIVATE),
        current: null,
      });
      expect(state.health).toBe(GmailWatchHealth.ACTIVE);
      expect(calls.some((call) => call.method === "registerWatch")).toBe(true);
    });
  });

  describe("AC4: a lost notification is recovered by reconciliation", () => {
    it("finds a change whose notification never arrived", async () => {
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "500",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi({
        history: {
          PRIVATE: {
            entries: [entry({ history_id: "600", message_id: "lost-msg" })],
            latestHistoryId: "600",
          },
        },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      // No notification is delivered at all — reconciliation replays from the cursor.
      const outcome = await engine.reconcile(registry().resolve(GmailAccountAlias.PRIVATE));

      expect(outcome.changes.map((change) => change.message_id)).toEqual(["lost-msg"]);
      expect(calls.find((call) => call.method === "listHistory")?.startHistoryId).toBe("500");
    });

    it("does not re-emit changes a notification already delivered", async () => {
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "500",
        updated_at_ms: NOW,
      });
      const { api } = fakeApi({
        history: { PRIVATE: { entries: [entry({ history_id: "600" })], latestHistoryId: "600" } },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });
      const account = registry().resolve(GmailAccountAlias.PRIVATE);

      const viaNotification = await engine.handleNotification({
        account,
        notifiedHistoryId: "600",
      });
      const viaReconcile = await engine.reconcile(account);

      expect(viaNotification.changes).toHaveLength(1);
      expect(viaReconcile.changes).toHaveLength(0);
    });
  });

  describe("AC7: an invalid cursor resyncs without losing the audit trail", () => {
    it("resyncs and records the cursor that failed", async () => {
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.PRIVATE,
        history_id: "42",
        updated_at_ms: NOW,
      });
      const { api, calls } = fakeApi({
        expireFor: [GmailAccountAlias.PRIVATE],
        recent: { entries: [entry({ history_id: "2000" })], latestHistoryId: "2000" },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      const outcome = await engine.handleNotification({
        account: registry().resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "2000",
      });

      expect(outcome.resynced).toBe(true);
      // The audit trail: WHICH cursor failed, so the gap is a deliberate resync
      // rather than an unexplained quiet period.
      expect(outcome.resynced_from).toBe("42");
      expect(outcome.changes).toHaveLength(1);
      expect(outcome.cursor.history_id).toBe("2000");
      expect(calls.some((call) => call.method === "listRecentMessages")).toBe(true);
    });

    it("resyncs on reconciliation too, not only on a notification", async () => {
      const cursors = new InMemoryGmailCursorStore();
      await cursors.write({
        schema_version: 1,
        account_alias: GmailAccountAlias.SONDERMIND,
        history_id: "42",
        updated_at_ms: NOW,
      });
      const { api } = fakeApi({
        expireFor: [GmailAccountAlias.SONDERMIND],
        recent: { entries: [entry()], latestHistoryId: "3000" },
      });
      const engine = new GmailSyncEngine({ api, cursors, now: () => NOW });

      const outcome = await engine.reconcile(registry().resolve(GmailAccountAlias.SONDERMIND));
      expect(outcome.resynced).toBe(true);
      expect(outcome.resynced_from).toBe("42");
    });

    it("treats a first run as a recorded resync, not as a silent gap", async () => {
      const { api } = fakeApi();
      const engine = new GmailSyncEngine({
        api,
        cursors: new InMemoryGmailCursorStore(),
        now: () => NOW,
      });
      const outcome = await engine.handleNotification({
        account: registry().resolve(GmailAccountAlias.PRIVATE),
        notifiedHistoryId: "1001",
      });
      expect(outcome.resynced).toBe(true);
      expect(outcome.resynced_from).toBeNull();
    });
  });

  describe("AC6: content is not fetched or logged without need and provenance", () => {
    function contentApi(body: string, attachments: Parameters<typeof makeAttachments>[0] = []) {
      const calls: string[] = [];
      const api: GmailContentApi = {
        getBody: async ({ account, messageId }) => {
          calls.push(`${account.alias}:${messageId}`);
          return { body, attachments: makeAttachments(attachments) };
        },
      };
      return { api, calls };
    }

    function makeAttachments(
      specs: readonly { filename: string; mimeType: string; sizeBytes: number; content?: string }[],
    ) {
      return specs.map((spec) => ({ ...spec }));
    }

    it("refuses a fetch with no recognised purpose", async () => {
      const account = registry().resolve(GmailAccountAlias.PRIVATE);
      const { api, calls } = contentApi("body");

      await expect(
        fetchGmailBody({
          api,
          account,
          message: summary(account),
          purpose: "BECAUSE" as never,
        }),
      ).rejects.toThrow(GmailConnectorError);
      try {
        await fetchGmailBody({
          api,
          account,
          message: summary(account),
          purpose: "" as never,
        });
      } catch (error) {
        expect((error as { code?: string }).code).toBe(GMAIL_FETCH_NOT_JUSTIFIED);
      }
      // Nothing was fetched: the refusal precedes the call.
      expect(calls).toEqual([]);
    });

    it("carries the purpose and timestamp in the RECORD, not just a log", async () => {
      const account = registry().resolve(GmailAccountAlias.PRIVATE);
      const { api } = contentApi("hello");

      const record = await fetchGmailBody({
        api,
        account,
        message: summary(account),
        purpose: "USER_REQUESTED",
        now: () => NOW,
      });

      // The justification travels with the content into whatever stores it.
      expect(record.purpose).toBe("USER_REQUESTED");
      expect(record.fetched_at_ms).toBe(NOW);
      expect(record.account_alias).toBe(GmailAccountAlias.PRIVATE);
    });

    it("redacts secrets out of a body before carrying it", async () => {
      const account = registry().resolve(GmailAccountAlias.PRIVATE);
      const { api } = contentApi(
        `CI failed. token ${SECRET} at /Users/victim/repo and AKIAIOSFODNN7EXAMPLE`,
      );

      const record = await fetchGmailBody({
        api,
        account,
        message: summary(account),
        purpose: "CASE_CONTEXT",
        knownSecrets: [SECRET],
      });

      // Email bodies routinely quote CI output; a model reads this.
      expect(record.body.value).not.toContain(SECRET);
      expect(record.body.value).not.toContain("/Users/victim");
      expect(record.body.value).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("does not fetch attachment content by default", async () => {
      const account = registry().resolve(GmailAccountAlias.PRIVATE);
      const { api } = contentApi("body", [
        { filename: "payload.zip", mimeType: "application/zip", sizeBytes: 10, content: "secret" },
      ]);

      const record = await fetchGmailBody({
        api,
        account,
        message: summary(account),
        purpose: "CASE_CONTEXT",
      });

      expect(DEFAULT_GMAIL_BODY_POLICY.allow_attachment_content).toBe(false);
      // Metadata is kept; a null digest says plainly "we did not read this".
      expect(record.attachments).toHaveLength(1);
      expect(record.attachments[0]?.filename).toBe("payload.zip");
      expect(record.attachments[0]?.content_digest).toBeNull();
      expect(JSON.stringify(record)).not.toContain("secret");
    });

    it("bounds the body and declares the truncation", async () => {
      const account = registry().resolve(GmailAccountAlias.PRIVATE);
      const { api } = contentApi("x".repeat(5_000));

      const record = await fetchGmailBody({
        api,
        account,
        message: summary(account),
        purpose: "CASE_CONTEXT",
        policy: { ...DEFAULT_GMAIL_BODY_POLICY, max_body_bytes: 100 },
      });

      expect(record.body.truncated).toBe(true);
      expect(record.body.value.length).toBe(100);
      expect(record.body.original_byte_length).toBe(5_000);
    });

    it("redacts a secret hidden in an attachment FILENAME", async () => {
      // Found by an audit probe: the body was clean and the content was never read,
      // yet the filename carried the token verbatim into the record. A filename is
      // sender-controlled text, and "we only kept metadata" is not a reason to treat
      // it as safe.
      const account = registry().resolve(GmailAccountAlias.PRIVATE);
      const { api } = contentApi("clean body", [
        { filename: `${SECRET}.txt`, mimeType: "text/plain", sizeBytes: 5 },
        { filename: "/Users/victim/secrets.pdf", mimeType: "application/pdf", sizeBytes: 9 },
      ]);

      const record = await fetchGmailBody({
        api,
        account,
        message: summary(account),
        purpose: "CASE_CONTEXT",
        knownSecrets: [SECRET],
      });

      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("/Users/victim");
    });

    it("refuses to fetch a message belonging to the other account", async () => {
      const reg = registry();
      const priv = reg.resolve(GmailAccountAlias.PRIVATE);
      const work = reg.resolve(GmailAccountAlias.SONDERMIND);
      const { api, calls } = contentApi("body");

      await expect(
        fetchGmailBody({
          api,
          account: work,
          message: summary(priv),
          purpose: "CASE_CONTEXT",
        }),
      ).rejects.toThrow(GmailConnectorError);
      expect(calls).toEqual([]);
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
