/**
 * RA-006 dispatcher integration tests against a REAL PostgreSQL.
 *
 * Exercises every acceptance criterion end to end through the transactional
 * outbox and the persistent case↔Discord mapping:
 *   1. duplicate outbox delivery → one message/thread (idempotency);
 *   3. two cases converse independently in parallel;
 *   4. per-case ordering survives out-of-order claims, retries and reconnects;
 * plus the audit focus: reconnect, duplicate delivery, archived thread and rate
 * limits. Criteria 2, 5 and 6 (authorization, button binding, /stop scoping) are
 * covered by the unit suites (authorization/custom-id/intake).
 */
import {
  Database,
  DiscordBindingRepository,
  DiscordReceiptRepository,
  DiscordSendIntentRepository,
  OutboxRepository,
  productionRuntime,
} from "@remoteagent/database";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { ChannelRegistry } from "../src/channels.js";
import {
  DiscordAmbiguousError,
  DiscordDeferredError,
  DiscordDispatcher,
  DiscordRoutingError,
  caseTag,
  type OutboxMessage,
} from "../src/dispatcher.js";
import { MAX_MESSAGE_LENGTH } from "../src/sanitize.js";
import { DISCORD_EVENT_TYPES } from "../src/messages.js";
import { FakeDiscordGateway, FakeOrchestrator } from "../src/fakes.js";
import { handleInbound } from "../src/intake.js";
import {
  createTestDatabase,
  describeIntegration,
  postgresAvailable,
  type TestDatabase,
} from "./pg-harness.js";

const available = await postgresAvailable();

const OWNER = "owner-1";
const CHANNELS = {
  jira: "c-jira",
  "gmail-private": "c-gmail-priv",
  "gmail-sondermind": "c-gmail-sm",
  "calendar-private": "c-cal-priv",
  "calendar-sondermind": "c-cal-sm",
  gitlab: "c-gitlab",
  system: "c-system",
} as const;

function registry(): ChannelRegistry {
  return new ChannelRegistry({ guildId: "guild-1", ownerId: OWNER, channels: { ...CHANNELS } });
}

async function seedOwner(db: Database): Promise<void> {
  await db.query(`INSERT INTO owners (owner_id, display_name) VALUES ($1, $2)`, [OWNER, "Owner"]);
  // A real connection is required so cases.integration_scope (validated by the
  // migration-011 sync trigger) references a known connection of the owner.
  await db.query(
    `INSERT INTO connections (
       connection_id, owner_id, provider, alias, display_name, capabilities,
       credential_secret_ref, health_status)
     VALUES ('conn-1', $1, 'jira', 'private', 'conn', ARRAY[]::text[],
             'unconfigured://conn-1', 'ERROR')`,
    [OWNER],
  );
}

async function seedCase(db: Database, caseId: string): Promise<void> {
  await db.query(
    `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
     VALUES ($1, $2, 'NEW', $3::jsonb, $4)`,
    [
      caseId,
      OWNER,
      JSON.stringify({ providers: ["jira"], connection_ids: ["conn-1"] }),
      `placeholder-${caseId}`,
    ],
  );
}

async function claim(db: Database, outboxId: string): Promise<OutboxMessage> {
  const row = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
    `SELECT event_type, payload FROM outbox WHERE outbox_id = $1`,
    [outboxId],
  );
  const found = row.rows[0];
  if (found === undefined) throw new Error(`no outbox row ${outboxId}`);
  return { outboxId, eventType: found.event_type, payload: found.payload };
}

describeIntegration(
  "DiscordDispatcher (RA-006)",
  () => {
    let test: TestDatabase;
    let db: Database;
    let gateway: FakeDiscordGateway;
    let dispatcher: DiscordDispatcher;
    let orchestrator: FakeOrchestrator;
    const bindings = new DiscordBindingRepository();
    const receipts = new DiscordReceiptRepository();
    const intents = new DiscordSendIntentRepository();

    beforeAll(async () => {
      test = await createTestDatabase();
      db = test.db;
      await seedOwner(db);
    });

    afterAll(async () => {
      await test.drop();
    });

    beforeEach(() => {
      gateway = new FakeDiscordGateway();
      dispatcher = new DiscordDispatcher({
        db,
        bindings,
        receipts,
        intents,
        gateway,
        channels: registry(),
        // Retry sleeps are no-ops so rate-limit tests stay fast and deterministic.
        retry: { sleep: () => Promise.resolve(), baseMs: 1 },
      });
      orchestrator = new FakeOrchestrator({
        db,
        outbox: new OutboxRepository(productionRuntime()),
        bindings,
      });
    });

    it("criterion 1: a redelivered outbox event never creates a second message or thread", async () => {
      const caseId = `case-dup-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Dup case",
        body: "opening",
      });
      const msgId = await orchestrator.postMessage({ caseId, body: "hello" });

      const first = await dispatcher.deliver(await claim(db, rootId));
      expect(first.status).toBe("delivered");
      await dispatcher.deliver(await claim(db, msgId));

      // Redeliver both (at-least-once outbox): both are idempotent no-ops.
      expect((await dispatcher.deliver(await claim(db, rootId))).status).toBe("duplicate");
      expect((await dispatcher.deliver(await claim(db, msgId))).status).toBe("duplicate");

      expect(gateway.createThreadCalls).toBe(1);
      const threadId = first.threadId!;
      // Root anchor + one thread message, nothing duplicated.
      expect(gateway.messagesIn(threadId).length).toBe(2);
    });

    it("criterion 1: thread creation reconciles an existing thread across a crash", async () => {
      const caseId = `case-reconcile-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "gitlab",
        alias: "private",
        channelId: registry().channelId("gitlab"),
        title: "Reconcile",
        body: "opening",
      });
      // Simulate a crash AFTER the Discord thread was created but BEFORE the local
      // commit: the thread exists on Discord (by case tag) but no binding/receipt.
      await gateway.createRootThread({
        channelId: registry().channelId("gitlab"),
        caseTag: caseTag(caseId),
        threadName: "Reconcile",
        rootContent: "opening",
      });
      expect(gateway.createThreadCalls).toBe(1);

      const result = await dispatcher.deliver(await claim(db, rootId));
      expect(result.status).toBe("delivered");
      // Reconciled the existing thread rather than creating a second one.
      expect(gateway.createThreadCalls).toBe(1);
    });

    it("criterion 4: out-of-order claims are deferred and never reordered", async () => {
      const caseId = `case-order-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Order",
        body: "root",
      });
      const m2 = await orchestrator.postMessage({ caseId, body: "second" });
      const m3 = await orchestrator.postMessage({ caseId, body: "third" });

      // Delivering later sequences first is deferred (thrown), not applied.
      await expect(dispatcher.deliver(await claim(db, m3))).rejects.toBeInstanceOf(
        DiscordDeferredError,
      );
      await expect(dispatcher.deliver(await claim(db, m2))).rejects.toBeInstanceOf(
        DiscordDeferredError,
      );

      const root = await dispatcher.deliver(await claim(db, rootId));
      // seq 3 still deferred until seq 2 lands.
      await expect(dispatcher.deliver(await claim(db, m3))).rejects.toBeInstanceOf(
        DiscordDeferredError,
      );
      await dispatcher.deliver(await claim(db, m2));
      await dispatcher.deliver(await claim(db, m3));

      const contents = gateway.messagesIn(root.threadId!).map((m) => m.content);
      expect(contents[0]).toContain("root");
      expect(contents[1]).toContain("second");
      expect(contents[2]).toContain("third");
    });

    it("criterion 3: two cases converse independently in parallel", async () => {
      const caseA = `case-A-${Date.now()}`;
      const caseB = `case-B-${Date.now()}`;
      await seedCase(db, caseA);
      await seedCase(db, caseB);
      const rootA = await orchestrator.openCase({
        caseId: caseA,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "A",
        body: "a-root",
      });
      const rootB = await orchestrator.openCase({
        caseId: caseB,
        ownerId: OWNER,
        provider: "gitlab",
        alias: "private",
        channelId: registry().channelId("gitlab"),
        title: "B",
        body: "b-root",
      });
      const a1 = await orchestrator.postMessage({ caseId: caseA, body: "a-one" });
      const b1 = await orchestrator.postMessage({ caseId: caseB, body: "b-one" });

      // Interleave the two cases' deliveries: each keeps its own thread + order.
      const [dA, dB] = await Promise.all([
        dispatcher.deliver(await claim(db, rootA)),
        dispatcher.deliver(await claim(db, rootB)),
      ]);
      await Promise.all([
        dispatcher.deliver(await claim(db, b1)),
        dispatcher.deliver(await claim(db, a1)),
      ]);

      expect(dA.threadId).not.toBe(dB.threadId);
      expect(
        gateway
          .messagesIn(dA.threadId!)
          .map((m) => m.content)
          .join("|"),
      ).toContain("a-one");
      expect(
        gateway
          .messagesIn(dB.threadId!)
          .map((m) => m.content)
          .join("|"),
      ).toContain("b-one");
      // No cross-contamination between the two threads.
      expect(gateway.messagesIn(dA.threadId!).some((m) => m.content.includes("b-"))).toBe(false);
    });

    it("audit focus: a reconnect (fresh gateway) still dedupes via the receipt ledger", async () => {
      const caseId = `case-reconnect-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Reconnect",
        body: "root",
      });
      await dispatcher.deliver(await claim(db, rootId));

      // Bot restarts: a brand-new gateway with NO in-memory state. Redelivery must
      // be a receipt-based no-op that never touches Discord.
      const freshGateway = new FakeDiscordGateway();
      const freshDispatcher = new DiscordDispatcher({
        db,
        bindings,
        receipts,
        intents,
        gateway: freshGateway,
        channels: registry(),
        retry: { sleep: () => Promise.resolve(), baseMs: 1 },
      });
      const redelivered = await freshDispatcher.deliver(await claim(db, rootId));
      expect(redelivered.status).toBe("duplicate");
      expect(freshGateway.createThreadCalls).toBe(0);
    });

    it("audit focus: an archived thread is reopened before posting", async () => {
      const caseId = `case-archived-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Archived",
        body: "root",
      });
      const msgId = await orchestrator.postMessage({ caseId, body: "after-archive" });
      const root = await dispatcher.deliver(await claim(db, rootId));
      gateway.archive(root.threadId!);

      const delivered = await dispatcher.deliver(await claim(db, msgId));
      expect(delivered.status).toBe("delivered");
      const state = await gateway.getThread(root.threadId!);
      expect(state?.archived).toBe(false);
      expect(
        gateway.messagesIn(root.threadId!).some((m) => m.content.includes("after-archive")),
      ).toBe(true);
    });

    it("audit focus: a rate-limited send is retried and still delivered exactly once", async () => {
      const caseId = `case-ratelimit-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "RateLimit",
        body: "root",
      });
      // The first two create attempts hit a 429; the retry wrapper backs off.
      gateway.queueRateLimit(1000, 2000);
      const result = await dispatcher.deliver(await claim(db, rootId));
      expect(result.status).toBe("delivered");
      expect(gateway.createThreadCalls).toBe(1);
    });

    it("integration: fake event → thread → authorized owner response", async () => {
      const caseId = `case-e2e-${Date.now()}`;
      await seedCase(db, caseId);
      const outbox = new OutboxRepository(productionRuntime());
      await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "End to end",
        body: "a new jira event",
      });

      // Drive the real outbox relay with the app sink shape (deliver by id).
      await outbox.relayOnce(db, async (message) => {
        await dispatcher.deliver({
          outboxId: message.outbox_id,
          eventType: message.event_type,
          payload: message.payload,
        });
      });

      const binding = await bindings.find(db, caseId);
      expect(binding?.thread_id).not.toBeNull();
      const threadId = binding!.thread_id!;

      // The owner replies in the case thread; intake resolves it to this case.
      const outcome = await handleInbound(
        registry(),
        {
          type: "message",
          guildId: "guild-1",
          userId: OWNER,
          origin: { surface: "thread", threadId },
          content: "looks good, proceed",
        },
        async (t) => (await bindings.findByThread(db, t))?.case_id ?? null,
      );
      expect(outcome).toEqual({
        kind: "message",
        caseId,
        content: "looks good, proceed",
        trust: "UNTRUSTED_DATA",
      });
    });

    it("HIGH-01: a response lost AFTER a send is AMBIGUOUS and never replayed", async () => {
      const caseId = `case-lost-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Lost response",
        body: "root",
      });
      const msgId = await orchestrator.postMessage({ caseId, body: "after-lost" });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const threadId = root.threadId!;

      // The send DOES take effect on Discord, but the response is lost. The write
      // must become AMBIGUOUS (durable intent), not be silently re-sent.
      gateway.queuePostEffectFailure(1);
      await expect(dispatcher.deliver(await claim(db, msgId))).rejects.toBeInstanceOf(
        DiscordAmbiguousError,
      );
      // Exactly one copy of the message exists (the one whose response was lost).
      expect(
        gateway.messagesIn(threadId).filter((m) => m.content.includes("after-lost")).length,
      ).toBe(1);

      // Redelivery (at-least-once outbox) re-reads the AMBIGUOUS intent and halts
      // WITHOUT re-issuing the write: still exactly one copy — the AUDIT-01 HIGH-01
      // probe now yields sameEventMessageCopies=1, not 2.
      await expect(dispatcher.deliver(await claim(db, msgId))).rejects.toBeInstanceOf(
        DiscordAmbiguousError,
      );
      expect(
        gateway.messagesIn(threadId).filter((m) => m.content.includes("after-lost")).length,
      ).toBe(1);
    });

    it("HIGH-01: a lost response on a later chunk never re-sends earlier chunks", async () => {
      const caseId = `case-chunk-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Inter-chunk",
        body: "root",
      });
      // A two-chunk message: chunk 0 is a full line of A's, chunk 1 carries a marker.
      const body = `${"A".repeat(1990)}\nSECOND-CHUNK-${"B".repeat(200)}`;
      const msgId = await orchestrator.postMessage({ caseId, body });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const threadId = root.threadId!;

      // Lose the response of the SECOND chunk only.
      gateway.failPostEffectOnContent("SECOND-CHUNK");
      await expect(dispatcher.deliver(await claim(db, msgId))).rejects.toBeInstanceOf(
        DiscordAmbiguousError,
      );
      const firstCount = () =>
        gateway.messagesIn(threadId).filter((m) => m.content.startsWith("AAAA")).length;
      const secondCount = () =>
        gateway.messagesIn(threadId).filter((m) => m.content.includes("SECOND-CHUNK")).length;
      expect(firstCount()).toBe(1);
      expect(secondCount()).toBe(1);

      // Redelivery: chunk 0's intent is SUCCEEDED (no re-send); chunk 1 is AMBIGUOUS.
      await expect(dispatcher.deliver(await claim(db, msgId))).rejects.toBeInstanceOf(
        DiscordAmbiguousError,
      );
      expect(firstCount()).toBe(1);
      expect(secondCount()).toBe(1);
    });

    it("HIGH-02: a payload whose route mismatches the durable binding is rejected", async () => {
      const caseId = `case-route-${Date.now()}`;
      await seedCase(db, caseId);
      // Create the binding in the jira channel WITHOUT delivering (thread still null).
      await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Routed",
        body: "root",
      });

      // A crafted (replayed/altered) payload that routes to the SonderMind channel.
      const mismatched: OutboxMessage = {
        outboxId: `crafted-${caseId}`,
        eventType: DISCORD_EVENT_TYPES.ROOT_THREAD,
        payload: {
          case_id: caseId,
          owner_id: OWNER,
          seq: 1,
          provider: "gmail",
          alias: "sondermind",
          title: "Routed",
          body: "leak attempt",
        },
      };
      await expect(dispatcher.deliver(mismatched)).rejects.toBeInstanceOf(DiscordRoutingError);
      // Fail-closed BEFORE any gateway call: no thread was created in any channel.
      expect(gateway.createThreadCalls).toBe(0);
    });

    it("MEDIUM-05: a late status revision never rolls the pinned message backwards", async () => {
      const caseId = `case-status-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Status",
        body: "root",
      });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const threadId = root.threadId!;

      const s2 = await orchestrator.updateStatus({
        caseId,
        status: "IMPLEMENTING",
        goal: "g",
        currentPhase: "phase-2",
        summary: "second",
        checkpointRevision: 2,
      });
      const s1 = await orchestrator.updateStatus({
        caseId,
        status: "PLANNING",
        goal: "g",
        currentPhase: "phase-1",
        summary: "first",
        checkpointRevision: 1,
      });

      // Deliver rev 2 first, then the stale rev 1.
      expect((await dispatcher.deliver(await claim(db, s2))).status).toBe("delivered");
      expect((await dispatcher.deliver(await claim(db, s1))).status).toBe("delivered");

      const status = gateway.messagesIn(threadId).find((m) => m.messageId.startsWith("status-"))!;
      // The pinned projection still shows rev 2, not the later-delivered rev 1.
      expect(status.content).toContain("rev 2");
      expect(status.content).not.toContain("rev 1");
      const binding = await bindings.find(db, caseId);
      expect(Number(binding!.last_status_revision)).toBe(2);
    });

    it("MEDIUM-06: a root body over 2000 chars is delivered in full, never truncated", async () => {
      const caseId = `case-big-${Date.now()}`;
      await seedCase(db, caseId);
      // 4500 chars, no newlines → three hard-split chunks (2000/2000/500).
      const body = "X".repeat(4500);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Big",
        body,
      });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const threadId = root.threadId!;

      // Anchor + continuation chunks reconstruct the full body with nothing lost.
      const xTotal = gateway
        .messagesIn(threadId)
        .map((m) => (m.content.match(/X/g) ?? []).length)
        .reduce((a, b) => a + b, 0);
      expect(xTotal).toBe(4500);
      // More than one message was needed (anchor + at least one continuation).
      expect(gateway.messagesIn(threadId).length).toBeGreaterThan(1);
    });

    it("HIGH-08: two concurrent deliveries of the same outbox event create exactly one thread", async () => {
      const caseId = `case-race-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Race",
        body: "root",
      });

      // The at-least-once outbox hands the SAME event to two workers at once.
      const results = await Promise.allSettled([
        dispatcher.deliver(await claim(db, rootId)),
        dispatcher.deliver(await claim(db, rootId)),
      ]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof dispatcher.deliver>>> =>
          r.status === "fulfilled",
      );
      const statuses = fulfilled.map((r) => r.value.status).sort();
      // Exactly one thread + one anchor regardless of interleaving.
      expect(gateway.createThreadCalls).toBe(1);
      expect(gateway.createAnchorCalls).toBe(1);
      // One delivered and one duplicate (the loser saw the receipt under the lock).
      expect(statuses).toEqual(["delivered", "duplicate"]);
    });

    it("HIGH-08: the intent claim yields a single winner under real contention", async () => {
      const caseId = `case-claim-${Date.now()}`;
      await seedCase(db, caseId);
      const key = `claim-${caseId}:x`;
      const base = {
        idempotencyKey: key,
        caseId,
        outboxId: `o-${caseId}`,
        step: "x",
        leaseMs: 30_000,
      };
      const [a, b] = await Promise.all([
        db.withTransaction((tx) => intents.claim(tx, { ...base, ownerToken: "tok-a" })),
        db.withTransaction((tx) => intents.claim(tx, { ...base, ownerToken: "tok-b" })),
      ]);
      // Exactly one transaction inserted the row; the other observed it.
      expect([a.inserted, b.inserted].filter(Boolean).length).toBe(1);
      expect(a.row.status).toBe("STARTED");
      expect(b.row.status).toBe("STARTED");
    });

    it("HIGH-08 / MEDIUM-16: terminal transitions are fenced on owner + state", async () => {
      const caseId = `case-fence-${Date.now()}`;
      await seedCase(db, caseId);
      const key = `fence-${caseId}:x`;
      await db.withTransaction((tx) =>
        intents.claim(tx, {
          idempotencyKey: key,
          caseId,
          outboxId: `o-${caseId}`,
          step: "x",
          ownerToken: "owner-1",
          leaseMs: 30_000,
        }),
      );
      // A NON-owner cannot mark it ambiguous (AUDIT-03 MEDIUM-16): the fence rejects it.
      const stolen = await db.withTransaction((tx) =>
        intents.markAmbiguous(tx, key, "intruder", "x"),
      );
      expect(stolen).toBe(false);
      const won = await db.withTransaction((tx) =>
        intents.succeed(tx, key, { discordMessageId: "m1", discordThreadId: "t1" }, "owner-1"),
      );
      expect(won).toBe(true);
      // A racing terminal transition after SUCCEEDED can no longer overwrite it.
      const lost = await db.withTransaction((tx) =>
        intents.markAmbiguous(tx, key, "owner-1", "late"),
      );
      expect(lost).toBe(false);
      const row = await intents.find(db, key);
      expect(row?.status).toBe("SUCCEEDED");
    });

    it("HIGH-07: a lost status response self-heals to exactly one status message", async () => {
      const caseId = `case-status-lost-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "StatusLost",
        body: "root",
      });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const threadId = root.threadId!;

      const s1 = await orchestrator.updateStatus({
        caseId,
        status: "PLANNING",
        goal: "g",
        currentPhase: "phase-1",
        summary: "first",
        checkpointRevision: 1,
      });
      // The status message send takes effect but its response is lost. Because the
      // status message carries a durable marker, the reconcilable intent finds the
      // just-sent message and adopts it rather than posting a second one.
      gateway.queuePostEffectFailure(1);
      const delivered = await dispatcher.deliver(await claim(db, s1));
      expect(delivered.status).toBe("delivered");
      const statusCount = () =>
        gateway.messagesIn(threadId).filter((m) => m.messageId.startsWith("status-")).length;
      expect(statusCount()).toBe(1);
      const binding = await bindings.find(db, caseId);
      expect(Number(binding!.last_status_revision)).toBe(1);

      // Redelivery is an idempotent no-op (receipt dedupe): still one message.
      expect((await dispatcher.deliver(await claim(db, s1))).status).toBe("duplicate");
      expect(statusCount()).toBe(1);
    });

    it("HIGH-07: an orphan anchor (thread start crashed) is reconciled, not duplicated", async () => {
      const caseId = `case-orphan-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Orphan",
        body: "root",
      });
      // First attempt: the anchor posts, but starting its thread fails with an
      // unknown outcome (crash window). The anchor intent is SUCCEEDED; the thread
      // is left recoverable.
      gateway.failStartThread(1);
      await expect(dispatcher.deliver(await claim(db, rootId))).rejects.toBeInstanceOf(
        DiscordAmbiguousError,
      );
      expect(gateway.createAnchorCalls).toBe(1);

      // Redelivery reuses the existing anchor (no second anchor) and starts the
      // thread, completing the root exactly once.
      const result = await dispatcher.deliver(await claim(db, rootId));
      expect(result.status).toBe("delivered");
      expect(gateway.createAnchorCalls).toBe(1);
      expect(gateway.createThreadCalls).toBe(1);
    });

    it("MEDIUM-12: a safe failure preserves attempt evidence and a later pass re-owns it", async () => {
      const caseId = `case-evidence-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Evidence",
        body: "root",
      });
      await dispatcher.deliver(await claim(db, rootId));
      const msgId = await orchestrator.postMessage({ caseId, body: "with-retry" });

      // Exhaust the retry budget with safe 429s so the chunk intent is left
      // RETRYABLE (kept, not deleted) with the attempt count recorded.
      gateway.queueRateLimit(1, 1, 1, 1, 1);
      await expect(dispatcher.deliver(await claim(db, msgId))).rejects.toBeTruthy();
      const afterFail = (await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0");
      expect(afterFail?.status).toBe("RETRYABLE");
      expect(afterFail!.attempts).toBeGreaterThan(0);
      expect(afterFail?.last_error).not.toBeNull();

      // A later pass re-owns the RETRYABLE intent and delivers exactly once.
      const delivered = await dispatcher.deliver(await claim(db, msgId));
      expect(delivered.status).toBe("delivered");
      const afterOk = (await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0");
      expect(afterOk?.status).toBe("SUCCEEDED");
      expect(
        gateway.messagesIn(delivered.threadId!).filter((m) => m.content.includes("with-retry"))
          .length,
      ).toBe(1);
    });

    it("MEDIUM-16: a loser cannot flip an in-flight winner's intent; one send, real SUCCEEDED", async () => {
      const caseId = `case-winner-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Winner",
        body: "root",
      });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const threadId = root.threadId!;
      const msgId = await orchestrator.postMessage({ caseId, body: "winner-in-flight" });

      // Hold the WINNER inside sendThreadMessage (its intent claimed + STARTED, lease
      // live) while a concurrent LOSER delivers the SAME event.
      let releaseWinner: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      let markEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      gateway.onBeforeSendThreadMessage(async () => {
        markEntered();
        await held;
      });

      const winnerP = dispatcher.deliver(await claim(db, msgId));
      await entered;
      // The loser sees the winner's live STARTED intent and MUST halt WITHOUT
      // mutating it (AUDIT-03 MEDIUM-16), rather than flipping it to AMBIGUOUS.
      const loserResult = await dispatcher.deliver(await claim(db, msgId)).catch((e: unknown) => e);
      releaseWinner();
      const winner = await winnerP;

      expect(winner.status).toBe("delivered");
      expect(loserResult).toBeInstanceOf(DiscordAmbiguousError);
      // Exactly one copy of the message, and the winner's intent is really SUCCEEDED.
      expect(
        gateway.messagesIn(threadId).filter((m) => m.content.includes("winner-in-flight")).length,
      ).toBe(1);
      const chunk = (await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0");
      expect(chunk?.status).toBe("SUCCEEDED");
    });

    it("MEDIUM-16: an abandoned STARTED intent (expired lease) recovers to AMBIGUOUS", async () => {
      const caseId = `case-lease-${Date.now()}`;
      await seedCase(db, caseId);
      const key = `lease-${caseId}:x`;
      // Claim with a lease that is already effectively expired.
      await db.withTransaction((tx) =>
        intents.claim(tx, {
          idempotencyKey: key,
          caseId,
          outboxId: `o-${caseId}`,
          step: "x",
          ownerToken: "dead-owner",
          leaseMs: 0,
        }),
      );
      // A recovering caller (no ownership) can transition the abandoned attempt via
      // the EXPIRY fence; an active (unexpired) attempt would not match.
      const recovered = await db.withTransaction((tx) =>
        intents.expireToAmbiguous(tx, key, "crash"),
      );
      expect(recovered).toBe(true);
      const row = await intents.find(db, key);
      expect(row?.status).toBe("AMBIGUOUS");
    });

    it("MEDIUM-21: expiry race + SAFE failure — the true owner records RETRYABLE, not a false AMBIGUOUS", async () => {
      const caseId = `case-exp-retry-${Date.now()}`;
      await seedCase(db, caseId);
      // A short lease so the winner's attempt lapses while it is held "in flight".
      const shortLease = new DiscordDispatcher({
        db,
        bindings,
        receipts,
        intents,
        gateway,
        channels: registry(),
        retry: { sleep: () => Promise.resolve(), baseMs: 1 },
        intentLeaseMs: 20,
      });
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "ExpRetry",
        body: "root",
      });
      const root = await shortLease.deliver(await claim(db, rootId));
      const threadId = root.threadId!;
      const msgId = await orchestrator.postMessage({ caseId, body: "winner-exp-retry" });

      // The winner's send is held past its lease, then fails SAFELY (a definitive
      // 429 the retry budget exhausts — provably not delivered).
      gateway.queueRateLimit(1, 1, 1, 1, 1);
      let releaseWinner: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      let markEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      gateway.onBeforeSendThreadMessage(async () => {
        markEntered();
        await held;
      });

      const winnerP = shortLease.deliver(await claim(db, msgId)).catch((e: unknown) => e);
      await entered;
      // The 20ms lease has lapsed: an observer proves abandonment → AMBIGUOUS.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const loser = await shortLease.deliver(await claim(db, msgId)).catch((e: unknown) => e);
      expect(loser).toBeInstanceOf(DiscordAmbiguousError);
      expect((await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0")?.status).toBe(
        "AMBIGUOUS",
      );

      releaseWinner();
      const winner = await winnerP;
      // The true owner OVERWRITES the observer's guess with its real terminal: the
      // write was provably rejected, so the intent is RETRYABLE (safe to re-issue),
      // NOT a false AMBIGUOUS — and the winner surfaced the safe error, not AMBIGUOUS.
      expect(winner).not.toBeInstanceOf(DiscordAmbiguousError);
      const chunk = (await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0");
      expect(chunk?.status).toBe("RETRYABLE");
      // Nothing was delivered (the 429 fired before any record).
      expect(
        gateway.messagesIn(threadId).filter((m) => m.content.includes("winner-exp-retry")).length,
      ).toBe(0);
    });

    it("MEDIUM-21: expiry race + SUCCESS — the true owner records SUCCEEDED over the observer's AMBIGUOUS", async () => {
      const caseId = `case-exp-ok-${Date.now()}`;
      await seedCase(db, caseId);
      const shortLease = new DiscordDispatcher({
        db,
        bindings,
        receipts,
        intents,
        gateway,
        channels: registry(),
        retry: { sleep: () => Promise.resolve(), baseMs: 1 },
        intentLeaseMs: 20,
      });
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "ExpOk",
        body: "root",
      });
      const root = await shortLease.deliver(await claim(db, rootId));
      const threadId = root.threadId!;
      const msgId = await orchestrator.postMessage({ caseId, body: "winner-exp-ok" });

      let releaseWinner: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      let markEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      gateway.onBeforeSendThreadMessage(async () => {
        markEntered();
        await held;
      });

      const winnerP = shortLease.deliver(await claim(db, msgId));
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const loser = await shortLease.deliver(await claim(db, msgId)).catch((e: unknown) => e);
      expect(loser).toBeInstanceOf(DiscordAmbiguousError);
      expect((await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0")?.status).toBe(
        "AMBIGUOUS",
      );

      releaseWinner();
      const winner = await winnerP;
      // The real performer completes the write: its owner-fenced SUCCEEDED overwrites
      // the observer's expiry-AMBIGUOUS, so a delivered write is recorded delivered.
      expect(winner.status).toBe("delivered");
      const chunk = (await intents.listByCase(db, caseId)).find((i) => i.step === "chunk:0");
      expect(chunk?.status).toBe("SUCCEEDED");
      // Exactly one copy was delivered (the winner's; the observer never sent).
      expect(
        gateway.messagesIn(threadId).filter((m) => m.content.includes("winner-exp-ok")).length,
      ).toBe(1);
    });

    it("MEDIUM-17: a root body at the 2000/2001 boundary keeps every send within 2000", async () => {
      for (const size of [2000, 2001]) {
        const caseId = `case-bound-${size}-${Date.now()}`;
        await seedCase(db, caseId);
        const body = "Z".repeat(size);
        const rootId = await orchestrator.openCase({
          caseId,
          ownerId: OWNER,
          provider: "jira",
          alias: "private",
          channelId: registry().channelId("jira"),
          title: "Boundary",
          body,
        });
        const root = await dispatcher.deliver(await claim(db, rootId));
        const messages = gateway.messagesIn(root.threadId!);
        // Every delivered body — including the anchor with its appended marker —
        // stays within Discord's hard limit (AUDIT-03 MEDIUM-17).
        for (const m of messages) {
          expect(m.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
        }
        // The full body survived (nothing truncated): count the Z payload chars.
        const zTotal = messages
          .map((m) => (m.content.match(/Z/g) ?? []).length)
          .reduce((a, b) => a + b, 0);
        expect(zTotal).toBe(size);
      }
    });

    it("MEDIUM-17: a maximal status projection stays within 2000 after the marker", async () => {
      const caseId = `case-statusbound-${Date.now()}`;
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "StatusBound",
        body: "root",
      });
      const root = await dispatcher.deliver(await claim(db, rootId));
      const s = await orchestrator.updateStatus({
        caseId,
        status: "IMPLEMENTING",
        goal: "G".repeat(4000),
        currentPhase: "phase",
        summary: "S".repeat(8000),
        checkpointRevision: 1,
      });
      await dispatcher.deliver(await claim(db, s));
      const status = gateway
        .messagesIn(root.threadId!)
        .find((m) => m.messageId.startsWith("status-"))!;
      expect(status.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    });

    it("MEDIUM-17 / HIGH-14: a 512-char case id reconciles by a bounded, exact marker", async () => {
      const caseId = `case-512-${"x".repeat(512 - 12)}`.slice(0, 512);
      await seedCase(db, caseId);
      const rootId = await orchestrator.openCase({
        caseId,
        ownerId: OWNER,
        provider: "jira",
        alias: "private",
        channelId: registry().channelId("jira"),
        title: "Long id",
        body: "root",
      });
      const root = await dispatcher.deliver(await claim(db, rootId));
      // The anchor carries the bounded marker and stays within Discord's limit.
      const anchor = gateway.messagesIn(root.threadId!)[0]!;
      expect(anchor.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      // Redelivery reconciles the existing thread by the exact tag (no duplicate).
      expect((await dispatcher.deliver(await claim(db, rootId))).status).toBe("duplicate");
      expect(gateway.createThreadCalls).toBe(1);
    });
  },
  available,
);
