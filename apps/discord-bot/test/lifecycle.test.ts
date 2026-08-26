/**
 * RA-006 inbound lifecycle mapping + composition test (AUDIT-01 HIGH-03 / MEDIUM-04).
 *
 * Verifies raw gateway events map to the right typed interaction (channel vs thread
 * surface decided from the registry, self-authored events ignored) and that the
 * composed dispatch handler durably audits a denied attempt via the append-only
 * audit repository — all with a fake Queryable, no network and no database.
 */
import {
  AuditLogRepository,
  Database,
  EngineeringApprovalIngressError,
  type Queryable,
} from "@remoteagent/database";
import { ChannelRegistry, type InteractionAcknowledger } from "@remoteagent/discord";
import { describe, expect, it } from "vitest";

import {
  createInboundDispatchHandler,
  extractInteractionAck,
  mapDispatchToInbound,
} from "../src/lifecycle.js";
import { createOwnerOutcomeSink } from "../src/env.js";

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

/** A Queryable that records the SQL/params of every query and returns one row. */
function captureQueryable(): { db: Queryable; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return Promise.resolve({ rows: [{ audit_id: "a1" }], rowCount: 1 });
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe("mapDispatchToInbound (RA-006)", () => {
  const config = { registry: registry(), botUserId: "bot-1" };

  it("maps a configured channel message to the channel surface", () => {
    const mapped = mapDispatchToInbound(config, "MESSAGE_CREATE", {
      channel_id: "c-jira",
      guild_id: "guild-1",
      author: { id: OWNER },
      content: "hi",
    });
    expect(mapped).toEqual({
      type: "message",
      guildId: "guild-1",
      userId: OWNER,
      origin: { surface: "channel", channelId: "c-jira" },
      content: "hi",
    });
  });

  it("maps an unknown channel id (a thread) to the thread surface", () => {
    const mapped = mapDispatchToInbound(config, "MESSAGE_CREATE", {
      channel_id: "thread-xyz",
      guild_id: "guild-1",
      author: { id: OWNER },
      content: "reply",
    });
    expect(mapped?.origin).toEqual({ surface: "thread", threadId: "thread-xyz" });
  });

  it("ignores the bot's own messages and unknown events", () => {
    expect(
      mapDispatchToInbound(config, "MESSAGE_CREATE", {
        channel_id: "c-jira",
        author: { id: "bot-1" },
        content: "loop",
      }),
    ).toBeNull();
    expect(mapDispatchToInbound(config, "TYPING_START", {})).toBeNull();
  });

  it("maps button and command interactions", () => {
    const button = mapDispatchToInbound(config, "INTERACTION_CREATE", {
      id: "interaction-button",
      type: 3,
      guild_id: "guild-1",
      channel_id: "thread-1",
      member: { user: { id: OWNER } },
      data: { custom_id: "v1:decision:d1:2:optA" },
    });
    expect(button).toMatchObject({
      type: "button",
      customId: "v1:decision:d1:2:optA",
      interactionId: "interaction-button",
    });

    const command = mapDispatchToInbound(config, "INTERACTION_CREATE", {
      id: "interaction-command",
      type: 2,
      guild_id: "guild-1",
      channel_id: "thread-1",
      member: { user: { id: OWNER } },
      data: { name: "stop" },
    });
    expect(command).toMatchObject({
      type: "command",
      command: "stop",
      interactionId: "interaction-command",
    });

    expect(
      mapDispatchToInbound(config, "INTERACTION_CREATE", {
        type: 2,
        guild_id: "guild-1",
        channel_id: "thread-1",
        member: { user: { id: OWNER } },
        data: { name: "engineering" },
      }),
    ).toBeNull();
  });
});

describe("createInboundDispatchHandler (RA-006 composition)", () => {
  it("persists engineering control outcomes before ACK and never ACKs a failed sink", async () => {
    const { db } = captureQueryable();
    const audit = new AuditLogRepository();
    const order: string[] = [];
    const acknowledger: InteractionAcknowledger = {
      acknowledgeInteraction: () => {
        order.push("ack");
        return Promise.resolve();
      },
    };
    const success = createInboundDispatchHandler(
      { registry: registry(), resolveThreadCase: async () => "case-1", audit, db },
      { registry: registry(), botUserId: "bot-1" },
      {
        acknowledger,
        onOutcome: (outcome) => {
          expect(outcome.kind).toBe("engineering");
          order.push("durable");
        },
      },
    );
    const event = {
      id: "int-engineering",
      token: "secret-token",
      type: 3,
      guild_id: "guild-1",
      channel_id: "thread-1",
      member: { user: { id: OWNER } },
      data: { custom_id: "v1:engineering:proposal-1:0:grant" },
    };
    await success("INTERACTION_CREATE", event);
    expect(order).toEqual(["durable", "ack"]);

    order.length = 0;
    const failure = createInboundDispatchHandler(
      { registry: registry(), resolveThreadCase: async () => "case-1", audit, db },
      { registry: registry(), botUserId: "bot-1" },
      {
        acknowledger,
        onOutcome: () => {
          order.push("durable-failed");
          return Promise.reject(new Error("database unavailable"));
        },
      },
    );
    await expect(failure("INTERACTION_CREATE", event)).rejects.toThrow(/database unavailable/);
    expect(order).toEqual(["durable-failed"]);
  });

  it("ACKs a deterministic engineering refusal but not an unexpected persistence failure", async () => {
    const { db: auditDb } = captureQueryable();
    const database = new Database({ connectionString: "postgres://unused/localhost" });
    const acks: string[] = [];
    const event = {
      id: "int-engineering-refusal",
      token: "secret-token",
      type: 3,
      guild_id: "guild-1",
      channel_id: "thread-1",
      member: { user: { id: OWNER } },
      data: { custom_id: "v1:engineering:proposal-1:0:grant" },
    };
    const makeHandler = (respond: () => Promise<never>) =>
      createInboundDispatchHandler(
        {
          registry: registry(),
          resolveThreadCase: async () => "case-1",
          audit: new AuditLogRepository(),
          db: auditDb,
        },
        { registry: registry(), botUserId: "bot-1" },
        {
          acknowledger: {
            acknowledgeInteraction: ({ interactionId }) => {
              acks.push(interactionId);
              return Promise.resolve();
            },
          },
          onOutcome: createOwnerOutcomeSink({
            db: database,
            engineeringIngress: {
              propose: () => Promise.reject(new Error("not used")),
              respond: () => respond(),
            },
            stopIngress: {
              stop: () => Promise.resolve({ status: "stopped", stoppedProposalIds: [] }),
            },
          }),
        },
      );

    await makeHandler(() =>
      Promise.reject(new EngineeringApprovalIngressError("deterministic stale proposal")),
    )("INTERACTION_CREATE", event);
    expect(acks).toEqual(["int-engineering-refusal"]);

    await expect(
      makeHandler(() => Promise.reject(new Error("database unavailable")))("INTERACTION_CREATE", {
        ...event,
        id: "int-engineering-db-failure",
      }),
    ).rejects.toThrow(/database unavailable/);
    expect(acks).toEqual(["int-engineering-refusal"]);
    await database.close();
  });

  it("durably audits a denied attempt and does not audit an authorized one", async () => {
    const { db, calls } = captureQueryable();
    const audit = new AuditLogRepository();
    const handler = createInboundDispatchHandler(
      { registry: registry(), resolveThreadCase: async () => "case-1", audit, db },
      { registry: registry(), botUserId: "bot-1" },
    );

    // Wrong guild → denied → exactly one append-only audit insert.
    await handler("MESSAGE_CREATE", {
      channel_id: "c-jira",
      guild_id: "intruder-guild",
      author: { id: "intruder" },
      content: "SECRET",
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.sql).toContain("INSERT INTO audit_log");
    // Content-free: the message body never reaches the audit params.
    expect(JSON.stringify(calls[0]!.params)).not.toContain("SECRET");

    // Authorized owner message in a case thread → no audit row.
    await handler("MESSAGE_CREATE", {
      channel_id: "thread-1",
      guild_id: "guild-1",
      author: { id: OWNER },
      content: "proceed",
    });
    expect(calls.length).toBe(1);
  });

  it("acknowledges (defers) an authorized interaction within the response window", async () => {
    const { db } = captureQueryable();
    const audit = new AuditLogRepository();
    const acks: { interactionId: string; deferred: boolean | undefined }[] = [];
    const acknowledger: InteractionAcknowledger = {
      acknowledgeInteraction: (input) => {
        acks.push({ interactionId: input.interactionId, deferred: input.deferred });
        return Promise.resolve();
      },
    };
    const handler = createInboundDispatchHandler(
      { registry: registry(), resolveThreadCase: async () => "case-1", audit, db },
      { registry: registry(), botUserId: "bot-1" },
      { acknowledger },
    );

    await handler("INTERACTION_CREATE", {
      id: "int-1",
      token: "tok-1",
      type: 3,
      guild_id: "guild-1",
      channel_id: "thread-1",
      member: { user: { id: OWNER } },
      data: { custom_id: "v1:decision:d1:2:optA" },
    });
    expect(acks).toEqual([{ interactionId: "int-1", deferred: true }]);

    // A plain message is NOT an interaction and is never acknowledged.
    await handler("MESSAGE_CREATE", {
      channel_id: "thread-1",
      guild_id: "guild-1",
      author: { id: OWNER },
      content: "hi",
    });
    expect(acks.length).toBe(1);
  });

  it("extractInteractionAck reads id/token only for interaction events", () => {
    expect(extractInteractionAck("INTERACTION_CREATE", { id: "i", token: "t", type: 2 })).toEqual({
      interactionId: "i",
      interactionToken: "t",
    });
    expect(extractInteractionAck("MESSAGE_CREATE", { id: "i", token: "t" })).toBeNull();
    expect(extractInteractionAck("INTERACTION_CREATE", { type: 2 })).toBeNull();
  });

  it("HIGH-15: a failed ACK logs only a safe class/code, never the token", async () => {
    const { db } = captureQueryable();
    const audit = new AuditLogRepository();
    const SECRET = "TOP-SECRET-INTERACTION-TOKEN";
    const logs: { event: string; detail?: Record<string, unknown> }[] = [];
    const acknowledger: InteractionAcknowledger = {
      acknowledgeInteraction: () => {
        // Emulate the REST adapter throwing an error whose message would carry the
        // token if it were not redacted upstream; the logger must still not see it.
        const error = Object.assign(
          new Error(`discord POST /interactions/i/${SECRET}/callback → 400`),
          {
            name: "DiscordApiError",
            status: 400,
          },
        );
        return Promise.reject(error);
      },
    };
    const handler = createInboundDispatchHandler(
      { registry: registry(), resolveThreadCase: async () => "case-1", audit, db },
      { registry: registry(), botUserId: "bot-1" },
      {
        acknowledger,
        logger: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
      },
    );

    await handler("INTERACTION_CREATE", {
      id: "int-1",
      token: SECRET,
      type: 3,
      guild_id: "guild-1",
      channel_id: "thread-1",
      member: { user: { id: OWNER } },
      data: { custom_id: "v1:decision:d1:2:optA" },
    });

    const ackLog = logs.find((l) => l.event === "inbound.ack_failed");
    expect(ackLog).toBeDefined();
    // Only the error class + status code — never the message or the token.
    expect(JSON.stringify(ackLog)).not.toContain(SECRET);
    expect(ackLog!.detail).toEqual({ error: "DiscordApiError", status: 400 });
  });
});
