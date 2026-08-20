import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ConnectionRepository, Database, OwnerRepository } from "@remoteagent/database";
import { ChannelRegistry } from "@remoteagent/discord";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { JiraContractError } from "../src/errors.js";
import { correlateJiraIssue } from "../src/correlation.js";

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
  },
  available,
);
