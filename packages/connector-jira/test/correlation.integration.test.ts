import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ConnectionRepository, Database, OwnerRepository } from "@remoteagent/database";
import { ChannelRegistry } from "@remoteagent/discord";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { JiraContractError } from "../src/errors.js";
import {
  correlateJiraIssue,
  correlateJiraIssueInTransaction,
  replayJiraCorrelationInTransaction,
} from "../src/correlation.js";

const available = await ensurePostgres();

describeIntegration(
  "jira atomic correlation",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let idCounter = 0;
    const channels = new ChannelRegistry({
      guildId: "guild",
      ownerId: "owner-1",
      channels: {
        jira: "jira-channel",
        "gmail-private": "gmail-private",
        "gmail-sondermind": "gmail-sondermind",
        "calendar-private": "calendar-private",
        "calendar-sondermind": "calendar-sondermind",
        gitlab: "gitlab",
        system: "system",
      },
    });

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      idCounter = 0;
      await db.query(
        "TRUNCATE jira_projection_receipts, outbox_dispatch, outbox, discord_case_bindings, external_entities, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        alias: "private",
        displayName: "jira",
      });
    });

    const options = (
      ownerId = "owner-1",
      connectionId = "conn-1",
      fault?: (stage: "case" | "entity" | "binding" | "sequence" | "outbox" | "receipt") => void,
    ) => {
      const id = ++idCounter;
      return {
        db,
        ownerId,
        connectionId,
        channelRegistry: channels,
        fault,
        ids: {
          caseId: () => `case-${id}`,
          entityId: () => `entity-${id}`,
          outboxId: () => `outbox-${id}`,
        },
      };
    };
    const counts = async () =>
      (
        await db.query(
          "SELECT (SELECT count(*) FROM cases)::text cases, (SELECT count(*) FROM external_entities)::text entities, (SELECT count(*) FROM discord_case_bindings)::text bindings, (SELECT count(*) FROM outbox)::text outbox, (SELECT count(*) FROM outbox_dispatch)::text dispatch, (SELECT count(*) FROM jira_projection_receipts)::text receipts",
        )
      ).rows[0];

    const durableState = async () => ({
      cases: (await db.query("SELECT * FROM cases ORDER BY case_id")).rows,
      entities: (await db.query("SELECT * FROM external_entities ORDER BY entity_id")).rows,
      bindings: (await db.query("SELECT * FROM discord_case_bindings ORDER BY case_id")).rows,
      outbox: (await db.query("SELECT * FROM outbox ORDER BY outbox_id")).rows,
      dispatch: (await db.query("SELECT * FROM outbox_dispatch ORDER BY outbox_id")).rows,
      receipts: (await db.query("SELECT * FROM jira_projection_receipts ORDER BY event_id")).rows,
    });
    const replayOptions = () => ({
      ownerId: "owner-1",
      connectionId: "conn-1",
      channelRegistry: channels,
    });
    const expectReplayRejected = async (input: unknown, options = replayOptions()) => {
      await expect(
        db.withTransaction((tx) => replayJiraCorrelationInTransaction(tx, input, options)),
      ).rejects.toBeInstanceOf(JiraContractError);
    };
    const insertReplayFixture = async (input: {
      eventId: string;
      caseId: string;
      entityId: string;
      outboxId: string;
      eventType?: string;
      aggregate?: string;
      payload: unknown;
      dispatch?: boolean;
    }) => {
      await db.withTransaction(async (tx) => {
        await tx.query(
          "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4,$5::jsonb)",
          [
            input.outboxId,
            input.aggregate ?? "discord_case",
            input.caseId,
            input.eventType ?? "discord.root_thread",
            JSON.stringify(input.payload),
          ],
        );
        if (input.dispatch !== false)
          await tx.query("INSERT INTO outbox_dispatch(outbox_id) VALUES($1)", [input.outboxId]);
        await tx.query(
          "INSERT INTO jira_projection_receipts(event_id,owner_id,connection_id,issue_key,case_id,entity_id,outbox_id,canonical_digest) VALUES($1,'owner-1','conn-1','PROJ-1',$2,$3,$4,$5)",
          [
            input.eventId,
            input.caseId,
            input.entityId,
            input.outboxId,
            `sha256:${createHash("sha256").update(input.eventId).digest("hex")}`,
          ],
        );
      });
    };

    it("returns null without a receipt and performs no writes or ID allocation", async () => {
      const before = await durableState();
      const result = await db.withTransaction((tx) =>
        replayJiraCorrelationInTransaction(
          tx,
          { eventId: "missing-replay", issueKey: "PROJ-1" },
          { ownerId: "owner-1", connectionId: "conn-1", channelRegistry: channels },
        ),
      );
      expect(result).toBeNull();
      expect(await durableState()).toEqual(before);
    });

    it("replays from durable scoped state with identical independent reads", async () => {
      const first = await correlateJiraIssue(
        { eventId: "durable-replay", issueKey: "PROJ-1", status: "Open", summary: "Summary" },
        options(),
      );
      const before = await durableState();
      const replayOptions = {
        ownerId: "owner-1",
        connectionId: "conn-1",
        channelRegistry: channels,
      };
      const one = await db.withTransaction((tx) =>
        replayJiraCorrelationInTransaction(
          tx,
          { eventId: "durable-replay", issueKey: "PROJ-1" },
          replayOptions,
        ),
      );
      const two = await db.withTransaction((tx) =>
        replayJiraCorrelationInTransaction(
          tx,
          { issueKey: "PROJ-1", eventId: "durable-replay" },
          replayOptions,
        ),
      );
      expect(one).toEqual({ ...first, replay: true });
      expect(two).toEqual(one);
      expect(await durableState()).toEqual(before);
    });

    it("replays a durable thread message without REST-shaped fields", async () => {
      const root = await correlateJiraIssue(
        { eventId: "thread-root", issueKey: "PROJ-1" },
        options(),
      );
      const thread = await correlateJiraIssue(
        { eventId: "thread-event", issueKey: "PROJ-1", status: "Done" },
        options(),
      );
      const replay = await db.withTransaction((tx) =>
        replayJiraCorrelationInTransaction(
          tx,
          { eventId: "thread-event", issueKey: "PROJ-1" },
          replayOptions(),
        ),
      );
      expect(root.eventType).toBe("discord.root_thread");
      expect(replay).toEqual({ ...thread, replay: true });
    });

    it("rejects strict input and foreign owner, connection, or issue scope", async () => {
      await expectReplayRejected({ eventId: "missing", issueKey: "PROJ-1", summary: "forged" });
      const first = await correlateJiraIssue(
        { eventId: "scope-event", issueKey: "PROJ-1" },
        options(),
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-2", displayName: "owner two" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-2",
        ownerId: "owner-2",
        provider: "jira",
        alias: "private",
        displayName: "jira two",
      });
      await expectReplayRejected(
        { eventId: "scope-event", issueKey: "PROJ-1" },
        { ownerId: "owner-2", connectionId: "conn-2", channelRegistry: channels },
      );
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-3",
        ownerId: "owner-1",
        provider: "jira",
        alias: "private",
        displayName: "jira three",
      });
      await expectReplayRejected(
        { eventId: "scope-event", issueKey: "PROJ-1" },
        { ownerId: "owner-1", connectionId: "conn-3", channelRegistry: channels },
      );
      await expectReplayRejected({ eventId: first.eventId, issueKey: "FOREIGN-1" });
    });

    it("rejects tampered entity and case scope without further writes", async () => {
      const first = await correlateJiraIssue(
        { eventId: "entity-root", issueKey: "PROJ-1" },
        options(),
      );
      const second = await correlateJiraIssue(
        { eventId: "case-root", issueKey: "PROJ-2" },
        options(),
      );
      const beforeCase = await durableState();
      await expect(
        db.query("UPDATE jira_projection_receipts SET case_id=$2 WHERE event_id=$1", [
          "entity-root",
          second.caseId,
        ]),
      ).rejects.toThrow(/foreign key|append-only/i);
      expect(await durableState()).toEqual(beforeCase);
      const beforeEntity = await durableState();
      await expect(
        db.query("UPDATE external_entities SET external_id='FOREIGN-ENTITY' WHERE entity_id=$1", [
          first.entityId,
        ]),
      ).rejects.toThrow(/foreign key|append-only/i);
      expect(await durableState()).toEqual(beforeEntity);
    });

    it("rejects missing or wrong authoritative Discord binding", async () => {
      const first = await correlateJiraIssue(
        { eventId: "binding-event", issueKey: "PROJ-1" },
        options(),
      );
      await db.query("DELETE FROM discord_case_bindings WHERE case_id=$1", [first.caseId]);
      const missingBefore = await durableState();
      await expectReplayRejected({ eventId: "binding-event", issueKey: "PROJ-1" });
      expect(await durableState()).toEqual(missingBefore);
      await db.query(
        "INSERT INTO discord_case_bindings(case_id,owner_id,channel_id,next_seq,delivered_seq) VALUES($1,'owner-1','jira-channel',2,0)",
        [first.caseId],
      );
      const restored = await correlateJiraIssue(
        { eventId: "new-binding-event", issueKey: "PROJ-1" },
        options(),
      );
      await db.query(
        "UPDATE discord_case_bindings SET channel_id='wrong-channel' WHERE case_id=$1",
        [restored.caseId],
      );
      const wrongBefore = await durableState();
      await expectReplayRejected({ eventId: "new-binding-event", issueKey: "PROJ-1" });
      expect(await durableState()).toEqual(wrongBefore);
    });

    it("rejects tampered aggregate, event type, strict payload, sequence, or dispatch", async () => {
      const first = await correlateJiraIssue(
        { eventId: "fixture-root", issueKey: "PROJ-1" },
        options(),
      );
      const cases = [
        {
          eventId: "bad-aggregate",
          outboxId: "bad-aggregate-outbox",
          aggregate: "wrong",
          payload: {
            case_id: first.caseId,
            owner_id: "owner-1",
            seq: 1,
            provider: "jira",
            alias: "private",
            title: "Jira PROJ-1",
            body: "",
          },
        },
        {
          eventId: "bad-type",
          outboxId: "bad-type-outbox",
          eventType: "discord.status",
          payload: {
            case_id: first.caseId,
            owner_id: "owner-1",
            seq: 1,
            provider: "jira",
            alias: "private",
            title: "Jira PROJ-1",
            body: "",
          },
        },
        {
          eventId: "bad-extra",
          outboxId: "bad-extra-outbox",
          payload: {
            case_id: first.caseId,
            owner_id: "owner-1",
            seq: 1,
            provider: "jira",
            alias: "private",
            title: "Jira PROJ-1",
            body: "",
            secret: "forged",
          },
        },
        {
          eventId: "bad-seq",
          outboxId: "bad-seq-outbox",
          payload: {
            case_id: first.caseId,
            owner_id: "owner-1",
            seq: 2,
            provider: "jira",
            alias: "private",
            title: "Jira PROJ-1",
            body: "",
          },
        },
        {
          eventId: "missing-dispatch",
          outboxId: "missing-dispatch-outbox",
          dispatch: false,
          payload: {
            case_id: first.caseId,
            owner_id: "owner-1",
            seq: 1,
            provider: "jira",
            alias: "private",
            title: "Jira PROJ-1",
            body: "",
          },
        },
        {
          eventId: "bad-thread-seq",
          outboxId: "bad-thread-seq-outbox",
          eventType: "discord.thread_message",
          payload: { case_id: first.caseId, seq: 1, body: "" },
        },
        {
          eventId: "bad-thread-extra",
          outboxId: "bad-thread-extra-outbox",
          eventType: "discord.thread_message",
          payload: { case_id: first.caseId, seq: 2, body: "", secret: "forged" },
        },
      ] as const;
      for (const fixture of cases) {
        await insertReplayFixture({ ...fixture, caseId: first.caseId, entityId: first.entityId });
        const before = await durableState();
        await expectReplayRejected({ eventId: fixture.eventId, issueKey: "PROJ-1" });
        expect(await durableState()).toEqual(before);
      }
      const aggregateFixture = "bad-aggregate-id";
      await insertReplayFixture({
        eventId: aggregateFixture,
        caseId: first.caseId,
        entityId: first.entityId,
        outboxId: "bad-aggregate-id-outbox",
        payload: {
          case_id: first.caseId,
          owner_id: "owner-1",
          seq: 1,
          provider: "jira",
          alias: "private",
          title: "Jira PROJ-1",
          body: "",
        },
      });
      const beforeAggregateId = await durableState();
      await expect(
        db.query("UPDATE outbox SET aggregate_id='foreign-case' WHERE outbox_id=$1", [
          "bad-aggregate-id-outbox",
        ]),
      ).rejects.toThrow(/foreign key|append-only/i);
      expect(await durableState()).toEqual(beforeAggregateId);
    });

    it("atomically creates root and returns the same receipt on exact replay", async () => {
      const first = await correlateJiraIssue(
        { eventId: "event-1", issueKey: "PROJ-1", status: "Open", summary: "Summary" },
        options(),
      );
      expect(first.replay).toBe(false);
      expect(await counts()).toEqual({
        cases: "1",
        entities: "1",
        bindings: "1",
        outbox: "1",
        dispatch: "1",
        receipts: "1",
      });
      const stored = JSON.stringify((await db.query("SELECT payload FROM outbox")).rows[0]);
      expect(stored).not.toMatch(/description|comment|token|secret/i);
      const replay = await correlateJiraIssue(
        { summary: "Summary", issueKey: "PROJ-1", status: "Open", eventId: "event-1" },
        options(),
      );
      expect({ ...replay, replay: false }).toEqual({ ...first, replay: false });
    });

    it("rejects conflicting replay without writes", async () => {
      await correlateJiraIssue(
        { eventId: "event-1", issueKey: "PROJ-1", summary: "one" },
        options(),
      );
      await expect(
        correlateJiraIssue({ eventId: "event-1", issueKey: "PROJ-1", summary: "two" }, options()),
      ).rejects.toBeInstanceOf(JiraContractError);
      expect(await counts()).toEqual({
        cases: "1",
        entities: "1",
        bindings: "1",
        outbox: "1",
        dispatch: "1",
        receipts: "1",
      });
    });

    it("uses the same case and an ordered thread message for a later event", async () => {
      const first = await correlateJiraIssue({ eventId: "event-1", issueKey: "PROJ-1" }, options());
      const second = await correlateJiraIssue(
        { eventId: "event-2", issueKey: "PROJ-1", status: "Done" },
        options(),
      );
      expect(second).toMatchObject({
        replay: false,
        caseId: first.caseId,
        entityId: first.entityId,
        seq: 2,
      });

      const rows = await db.query<{ event_type: string; seq: number }>(
        "SELECT event_type, (payload->>'seq')::int seq FROM outbox ORDER BY created_at",
      );
      expect(rows.rows).toEqual([
        { event_type: "discord.root_thread", seq: 1 },
        { event_type: "discord.thread_message", seq: 2 },
      ]);
    });

    it("rolls back existing issue sequence, outbox and receipt without a gap", async () => {
      const first = await correlateJiraIssue({ eventId: "root", issueKey: "PROJ-3" }, options());
      for (const stage of ["sequence", "outbox", "receipt"] as const) {
        await expect(
          correlateJiraIssue(
            { eventId: `fault-existing-${stage}`, issueKey: "PROJ-3" },
            options("owner-1", "conn-1", (actual) => {
              if (actual === stage) throw new Error("fault");
            }),
          ),
        ).rejects.toThrow("fault");
        const state = await db.query<{ next_seq: string; outbox: string; receipts: string }>(
          "SELECT b.next_seq::text, (SELECT count(*) FROM outbox)::text outbox, (SELECT count(*) FROM jira_projection_receipts)::text receipts FROM discord_case_bindings b WHERE b.case_id=$1",
          [first.caseId],
        );
        expect(state.rows[0]).toEqual({ next_seq: "2", outbox: "1", receipts: "1" });
      }
      const next = await correlateJiraIssue(
        { eventId: "after-fault", issueKey: "PROJ-3" },
        options(),
      );
      expect(next).toMatchObject({
        caseId: first.caseId,
        seq: 2,
        eventType: "discord.thread_message",
      });
    });

    it("serializes concurrent events to one case and one root", async () => {
      const results = await Promise.all(
        ["e1", "e2", "e3"].map((eventId) =>
          correlateJiraIssue({ eventId, issueKey: "PROJ-2" }, options()),
        ),
      );
      expect(results.filter((result) => !result.replay)).toHaveLength(3);
      expect(await counts()).toEqual({
        cases: "1",
        entities: "1",
        bindings: "1",
        outbox: "3",
        dispatch: "3",
        receipts: "3",
      });

      expect(
        (await db.query("SELECT count(*) FROM outbox WHERE event_type='discord.root_thread'"))
          .rows[0].count,
      ).toBe("1");
      const sequences = await db.query<{ seq: number }>(
        "SELECT (payload->>'seq')::int seq FROM outbox ORDER BY (payload->>'seq')::int",
      );
      expect(sequences.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    });

    it("deduplicates concurrent exact calls to one receipt and outbox", async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          correlateJiraIssue(
            { eventId: "same-event", issueKey: "PROJ-4", summary: "same" },
            options(),
          ),
        ),
      );
      expect(results.filter((result) => !result.replay)).toHaveLength(1);
      expect(results.filter((result) => result.replay)).toHaveLength(3);
      expect(await counts()).toEqual({
        cases: "1",
        entities: "1",
        bindings: "1",
        outbox: "1",
        dispatch: "1",
        receipts: "1",
      });
      const canonical = results.find((result) => !result.replay);
      const withoutReplay = (result: (typeof results)[number]) =>
        Object.fromEntries(Object.entries(result).filter(([key]) => key !== "replay"));
      expect(results.map(withoutReplay)).toEqual(results.map(() => withoutReplay(canonical!)));
    });

    it("rejects replay when the durable outbox payload was tampered", async () => {
      const first = await correlateJiraIssue(
        { eventId: "tamper-event", issueKey: "PROJ-5" },
        options(),
      );
      await expect(
        db.query("UPDATE outbox SET payload='{}'::jsonb WHERE outbox_id=$1", [first.outboxId]),
      ).rejects.toThrow(/append-only/i);
      const replay = await correlateJiraIssue(
        { eventId: "tamper-event", issueKey: "PROJ-5" },
        options(),
      );
      expect({ ...replay, replay: false }).toEqual({ ...first, replay: false });
      expect(await counts()).toEqual({
        cases: "1",
        entities: "1",
        bindings: "1",
        outbox: "1",
        dispatch: "1",
        receipts: "1",
      });
    });

    it("rejects a schema-valid but semantically tampered replay payload", async () => {
      const first = await correlateJiraIssue({ eventId: "seed", issueKey: "PROJ-7" }, options());
      const eventId = "fixture-tampered";
      const digest = `sha256:${createHash("sha256")
        .update(JSON.stringify({ eventId, issueKey: "PROJ-7", status: null, summary: null }))
        .digest("hex")}`;
      await db.query(
        "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES($1,'discord_case',$2,'discord.root_thread',$3::jsonb)",
        [
          "fixture-tampered-outbox",
          first.caseId,
          JSON.stringify({
            case_id: first.caseId,
            owner_id: "owner-1",
            seq: 1,
            provider: "jira",
            alias: "private",
            title: "Jira PROJ-7",
            body: "schema-valid but wrong body",
          }),
        ],
      );
      await db.query("INSERT INTO outbox_dispatch(outbox_id) VALUES($1)", [
        "fixture-tampered-outbox",
      ]);
      await db.query(
        "INSERT INTO jira_projection_receipts(event_id,owner_id,connection_id,issue_key,case_id,entity_id,outbox_id,canonical_digest) VALUES($1,'owner-1','conn-1','PROJ-7',$2,$3,'fixture-tampered-outbox',$4)",
        [eventId, first.caseId, first.entityId, digest],
      );
      await expect(
        correlateJiraIssue({ eventId, issueKey: "PROJ-7" }, options()),
      ).rejects.toBeInstanceOf(JiraContractError);
    });

    it("routes using the connection row alias, never caller-provided alias", async () => {
      await db.query("UPDATE connections SET alias='sondermind' WHERE connection_id='conn-1'");
      let observedAlias: string | undefined;
      const registry = {
        routeChannelId: (_provider: string, alias: string) => {
          observedAlias = alias;
          return "jira-channel";
        },
      };
      const result = await correlateJiraIssue(
        { eventId: "alias-event", issueKey: "PROJ-6" },
        { ...options(), channelRegistry: registry },
      );
      expect(result.eventType).toBe("discord.root_thread");
      expect(observedAlias).toBe("sondermind");
    });

    it("keeps equal issue keys isolated by owner and connection", async () => {
      await new OwnerRepository().insert(db, { ownerId: "owner-2", displayName: "owner two" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-2",
        ownerId: "owner-2",
        provider: "jira",
        alias: "private",
        displayName: "jira two",
      });
      const first = await correlateJiraIssue({ eventId: "one", issueKey: "PROJ-1" }, options());
      const second = await correlateJiraIssue(
        { eventId: "two", issueKey: "PROJ-1" },
        options("owner-2", "conn-2"),
      );
      expect(second.caseId).not.toBe(first.caseId);
      expect(await counts()).toEqual({
        cases: "2",
        entities: "2",
        bindings: "2",
        outbox: "2",
        dispatch: "2",
        receipts: "2",
      });
    });

    it("rolls back every logical write boundary", async () => {
      for (const stage of ["case", "entity", "binding", "sequence", "outbox", "receipt"] as const) {
        await db.query(
          "TRUNCATE jira_projection_receipts, outbox_dispatch, outbox, discord_case_bindings, external_entities, cases RESTART IDENTITY CASCADE",
        );
        await expect(
          correlateJiraIssue(
            { eventId: `fault-${stage}`, issueKey: "PROJ-9" },
            options("owner-1", "conn-1", (actual) => {
              if (actual === stage) throw new Error("fault");
            }),
          ),
        ).rejects.toThrow("fault");
        expect(await counts()).toEqual({
          cases: "0",
          entities: "0",
          bindings: "0",
          outbox: "0",
          dispatch: "0",
          receipts: "0",
        });
      }
    });

    it("rejects extras, empty/oversized input, forged scope and wrong existing binding", async () => {
      await expect(
        correlateJiraIssue({ eventId: "", issueKey: "PROJ-1" }, options()),
      ).rejects.toBeInstanceOf(JiraContractError);
      await expect(
        correlateJiraIssue({ eventId: "bad", issueKey: "PROJ-1", token: "secret" }, options()),
      ).rejects.toBeInstanceOf(JiraContractError);
      await expect(
        correlateJiraIssue(
          { eventId: "bad", issueKey: "PROJ-1", summary: "x".repeat(65_537) },
          options(),
        ),
      ).rejects.toBeInstanceOf(JiraContractError);
      await expect(
        correlateJiraIssue(
          { eventId: "bad", issueKey: "PROJ-1" },
          { ...options(), ownerId: "owner-2" },
        ),
      ).rejects.toBeInstanceOf(JiraContractError);
      const first = await correlateJiraIssue({ eventId: "good", issueKey: "PROJ-1" }, options());
      await db.query(
        "UPDATE discord_case_bindings SET channel_id='wrong-channel' WHERE case_id=$1",
        [first.caseId],
      );
      await expect(
        correlateJiraIssue({ eventId: "later", issueKey: "PROJ-1" }, options()),
      ).rejects.toBeInstanceOf(JiraContractError);
    });
    it("runs inside a caller transaction and rolls back after the core returns", async () => {
      const outerOptions = options();
      await expect(
        db.withTransaction(async (tx) => {
          const { db: ignoredDb, ...coreOptions } = outerOptions;
          void ignoredDb;
          const result = await correlateJiraIssueInTransaction(
            tx,
            { eventId: "outer-event", issueKey: "PROJ-1", summary: "outer" },
            coreOptions,
          );
          expect(result.replay).toBe(false);
          throw new Error("caller fault after correlation");
        }),
      ).rejects.toThrow("caller fault");
      expect(await counts()).toEqual({
        cases: "0",
        entities: "0",
        bindings: "0",
        outbox: "0",
        dispatch: "0",
        receipts: "0",
      });
      const committed = await db.withTransaction(async (tx) => {
        const { db: ignoredDb, ...coreOptions } = options();
        void ignoredDb;
        return correlateJiraIssueInTransaction(
          tx,
          { eventId: "outer-success", issueKey: "PROJ-1" },
          coreOptions,
        );
      });
      expect(committed.replay).toBe(false);
      expect((await counts()).cases).toBe("1");
    });
  },
  available,
);
