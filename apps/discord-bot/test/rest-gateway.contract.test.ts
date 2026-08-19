/**
 * RA-006 production REST adapter contract tests (AUDIT-01 HIGH-03, AUDIT-02 HIGH-07/MEDIUM-11).
 *
 * Drives {@link DiscordRestGateway} against RECORDED, REDACTED fixtures through an
 * in-memory transport — no network, no real token. Asserts each port method maps
 * to the right Discord endpoint/method/body, that the (redacted) bot token is
 * attached, that reconciliation is by the deterministic marker + bot author id
 * (never an unrelated pin), that root creation embeds the case tag, that failures
 * are classified per the port contract, and that interactions are acknowledged.
 */
import {
  DiscordRateLimitError,
  DiscordTransportError,
  DiscordUnavailableError,
  caseTag,
  statusMarker,
} from "@remoteagent/discord";
import { describe, expect, it } from "vitest";

import {
  DiscordApiError,
  DiscordRestGateway,
  type RestRequest,
  type RestResponse,
  type RestTransport,
} from "../src/rest-gateway.js";

const TOKEN = "REDACTED-TEST-TOKEN"; // fixture placeholder, never a real secret
const GUILD = "guild-1";
const BOT = "bot-1";

interface Canned {
  match: (req: RestRequest) => boolean;
  response: RestResponse;
}

function transportOf(canned: Canned[]): { transport: RestTransport; requests: RestRequest[] } {
  const requests: RestRequest[] = [];
  const transport: RestTransport = (req) => {
    requests.push(req);
    const hit = canned.find((c) => c.match(req));
    if (hit === undefined) {
      return Promise.reject(new Error(`no fixture for ${req.method} ${req.path}`));
    }
    return Promise.resolve(hit.response);
  };
  return { transport, requests };
}

const ok = (body: unknown, status = 200): RestResponse => ({ status, headers: {}, body });

function gatewayWith(canned: Canned[]): {
  gateway: DiscordRestGateway;
  requests: RestRequest[];
} {
  const { transport, requests } = transportOf(canned);
  return {
    gateway: new DiscordRestGateway(transport, { token: TOKEN, guildId: GUILD, botUserId: BOT }),
    requests,
  };
}

describe("DiscordRestGateway (RA-006 production adapter)", () => {
  it("createAnchorMessage posts the anchor; token is attached", async () => {
    const { gateway, requests } = gatewayWith([
      {
        match: (r) => r.method === "POST" && r.path.endsWith("/channels/c1/messages"),
        response: ok({ id: "m1" }),
      },
    ]);
    const anchor = await gateway.createAnchorMessage({
      channelId: "c1",
      caseTag: "RA:case-1",
      content: "hello\n-# RA:case-1",
    });
    expect(anchor).toEqual({ messageId: "m1" });
    expect(requests.every((r) => r.headers.authorization === `Bot ${TOKEN}`)).toBe(true);
    expect(requests[0]!.body).toEqual({ content: "hello\n-# RA:case-1" });
  });

  it("startThread opens the thread off the anchor and embeds the case tag in the name", async () => {
    const { gateway, requests } = gatewayWith([
      {
        match: (r) => r.method === "POST" && r.path.endsWith("/channels/c1/messages/m1/threads"),
        response: ok({ id: "t1" }),
      },
    ]);
    const created = await gateway.startThread({
      channelId: "c1",
      anchorMessageId: "m1",
      caseTag: "RA:case-1",
      threadName: "Case 1",
    });
    expect(created).toEqual({ threadId: "t1", rootMessageId: "m1" });
    expect((requests[0]!.body as { name: string }).name).toContain("RA:case-1");
  });

  it("findCaseAnchor reconciles a bot-authored orphan anchor by the case tag", async () => {
    const hit = gatewayWith([
      {
        match: (r) => r.method === "GET" && r.path.includes("/channels/c1/messages"),
        response: ok([
          { id: "x", content: "unrelated", author: { id: "someone" } },
          { id: "anchor-1", content: "root\n-# RA:case-7", author: { id: BOT } },
        ]),
      },
    ]);
    expect(await hit.gateway.findCaseAnchor("c1", "RA:case-7")).toEqual({ messageId: "anchor-1" });

    // A message with the tag but NOT authored by the bot is ignored.
    const foreign = gatewayWith([
      {
        match: (r) => r.method === "GET" && r.path.includes("/channels/c1/messages"),
        response: ok([{ id: "y", content: "root\n-# RA:case-7", author: { id: "intruder" } }]),
      },
    ]);
    expect(await foreign.gateway.findCaseAnchor("c1", "RA:case-7")).toBeNull();
  });

  it("sendThreadMessage renders an action row with mapped button styles", async () => {
    const { gateway, requests } = gatewayWith([
      {
        match: (r) => r.method === "POST" && r.path.endsWith("/channels/t1/messages"),
        response: ok({ id: "m9" }),
      },
    ]);
    const sent = await gateway.sendThreadMessage({
      threadId: "t1",
      content: "decide",
      components: [
        { customId: "cid-a", label: "A", style: "primary" },
        { customId: "cid-b", label: "B", style: "danger" },
      ],
    });
    expect(sent).toEqual({ messageId: "m9" });
    const body = requests[0]!.body as {
      components: { components: { style: number; custom_id: string }[] }[];
    };
    expect(body.components[0]!.components).toEqual([
      { type: 2, style: 1, label: "A", custom_id: "cid-a" },
      { type: 2, style: 4, label: "B", custom_id: "cid-b" },
    ]);
  });

  it("getThread returns null on 404 and archived state on 200", async () => {
    const missing = gatewayWith([
      {
        match: (r) => r.method === "GET" && r.path.endsWith("/channels/gone"),
        response: ok(null, 404),
      },
    ]);
    expect(await missing.gateway.getThread("gone")).toBeNull();

    const live = gatewayWith([
      {
        match: (r) => r.method === "GET" && r.path.endsWith("/channels/t2"),
        response: ok({ id: "t2", thread_metadata: { archived: true } }),
      },
    ]);
    expect(await live.gateway.getThread("t2")).toEqual({ threadId: "t2", archived: true });
  });

  it("classifies a 429 as a rate limit and honours retry_after", async () => {
    const { gateway } = gatewayWith([
      {
        match: (r) => r.method === "POST",
        response: { status: 429, headers: {}, body: { retry_after: 2 } },
      },
    ]);
    await expect(gateway.sendThreadMessage({ threadId: "t1", content: "x" })).rejects.toMatchObject(
      { name: "DiscordRateLimitError", retryAfterMs: 2000 },
    );
  });

  it("classifies a 5xx as an unknown-outcome DiscordApiError (never a safe replay)", async () => {
    const { gateway } = gatewayWith([
      { match: (r) => r.method === "POST", response: ok({ message: "server error" }, 503) },
    ]);
    const error = await gateway
      .sendThreadMessage({ threadId: "t1", content: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error).not.toBeInstanceOf(DiscordRateLimitError);
    expect((error as DiscordApiError).status).toBe(503);
  });

  it("findCaseThread reconciles by the case tag across active + archived threads", async () => {
    const { gateway } = gatewayWith([
      {
        match: (r) => r.path.endsWith(`/guilds/${GUILD}/threads/active`),
        response: ok({ threads: [{ id: "tX", name: "Other", parent_id: "c1" }] }),
      },
      {
        match: (r) => r.path.includes("/channels/c1/threads/archived/public"),
        response: ok({
          threads: [{ id: "tHit", name: "Case [RA:case-7]", parent_id: "c1" }],
          has_more: false,
        }),
      },
    ]);
    expect(await gateway.findCaseThread("c1", "RA:case-7")).toEqual({
      threadId: "tHit",
      rootMessageId: "tHit",
    });
  });

  it("findStatusMessage matches the bot's marked message, not an unrelated pin", async () => {
    // A foreign pin exists; only the bot-authored, marked message is adopted.
    const hit = gatewayWith([
      {
        match: (r) => r.path.endsWith("/channels/t1/pins"),
        response: ok([
          { id: "foreign", content: "someone's pin", author: { id: "intruder" } },
          { id: "status-1", content: "status\n-# RA-STATUS:case-1", author: { id: BOT } },
        ]),
      },
    ]);
    expect(await hit.gateway.findStatusMessage("t1", "RA-STATUS:case-1")).toEqual({
      messageId: "status-1",
    });

    const none = gatewayWith([
      { match: (r) => r.path.endsWith("/channels/t1/pins"), response: ok([]) },
      {
        match: (r) => r.path.includes("/channels/t1/messages"),
        response: ok([]),
      },
    ]);
    expect(await none.gateway.findStatusMessage("t1", "RA-STATUS:case-1")).toBeNull();
  });

  it("acknowledgeInteraction defers via the interaction callback endpoint", async () => {
    const { gateway, requests } = gatewayWith([
      {
        match: (r) => r.method === "POST" && r.path.endsWith("/interactions/i1/tok1/callback"),
        response: ok({}, 204),
      },
    ]);
    await gateway.acknowledgeInteraction({
      interactionId: "i1",
      interactionToken: "tok1",
      deferred: true,
    });
    expect(requests[0]!.body).toEqual({ type: 5 });
  });

  it("HIGH-14: reconciliation matches the EXACT case tag, never a prefixed one", async () => {
    const tag1 = caseTag("case-1");
    const tag10 = caseTag("case-10");
    // A bot message tagged for case-10 must NOT be adopted when looking up case-1.
    const anchors = gatewayWith([
      {
        match: (r) => r.method === "GET" && r.path.includes("/channels/c1/messages"),
        response: ok([{ id: "m-10", content: `root\n-# ${tag10}`, author: { id: BOT } }]),
      },
    ]);
    expect(await anchors.gateway.findCaseAnchor("c1", tag1)).toBeNull();

    // Threads: case-10's thread is not adopted for case-1.
    const threads = gatewayWith([
      {
        match: (r) => r.path.endsWith(`/guilds/${GUILD}/threads/active`),
        response: ok({ threads: [{ id: "t10", name: `Case [${tag10}]`, parent_id: "c1" }] }),
      },
      {
        match: (r) => r.path.includes("/channels/c1/threads/archived/public"),
        response: ok({ threads: [], has_more: false }),
      },
    ]);
    expect(await threads.gateway.findCaseThread("c1", tag1)).toBeNull();

    // Status: case-10's status message is not adopted for case-1.
    const status = gatewayWith([
      { match: (r) => r.path.endsWith("/channels/t1/pins"), response: ok([]) },
      {
        match: (r) => r.path.includes("/channels/t1/messages"),
        response: ok([
          { id: "s-10", content: `x\n-# ${statusMarker("case-10")}`, author: { id: BOT } },
        ]),
      },
    ]);
    expect(await status.gateway.findStatusMessage("t1", statusMarker("case-1"))).toBeNull();
  });

  it("HIGH-14 / MEDIUM-17: a 512-char case id yields a thread name within Discord's cap", async () => {
    const longId = "x".repeat(512);
    const tag = caseTag(longId);
    const { gateway, requests } = gatewayWith([
      {
        match: (r) => r.method === "POST" && r.path.endsWith("/channels/c1/messages/m1/threads"),
        response: ok({ id: "t1" }),
      },
    ]);
    await gateway.startThread({
      channelId: "c1",
      anchorMessageId: "m1",
      caseTag: tag,
      threadName: "A very long human thread title ".repeat(10),
    });
    const name = (requests[0]!.body as { name: string }).name;
    expect(name.length).toBeLessThanOrEqual(100);
    expect(name).toContain(`[${tag}]`);
  });

  it("HIGH-15: a non-2xx interaction callback error never contains the interaction token", async () => {
    const BOT_TOKEN = "BOT-SECRET-DO-NOT-LOG";
    const INTERACTION_TOKEN = "TOP-SECRET-INTERACTION-TOKEN";
    const { transport } = transportOf([
      {
        match: (r) => r.method === "POST" && r.path.includes("/callback"),
        response: ok({ message: "invalid" }, 400),
      },
    ]);
    const gateway = new DiscordRestGateway(transport, {
      token: BOT_TOKEN,
      guildId: GUILD,
      botUserId: BOT,
    });
    const error = await gateway
      .acknowledgeInteraction({ interactionId: "i1", interactionToken: INTERACTION_TOKEN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordApiError);
    const serialized = `${(error as Error).message}\n${(error as Error).stack ?? ""}\n${JSON.stringify(error)}`;
    expect(serialized).not.toContain(INTERACTION_TOKEN);
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  it("HIGH-15: a transport error carrying the token in its message/cause is redacted", async () => {
    const BOT_TOKEN = "BOT-SECRET-DO-NOT-LOG";
    const INTERACTION_TOKEN = "TOP-SECRET-INTERACTION-TOKEN";
    const transport: RestTransport = (req) => {
      // Mimic a fetch failure whose message embeds the full URL (with the token)
      // and whose cause repeats it — the adapter must strip both.
      const err = new Error(
        `fetch failed for https://discord.com${req.path} with Bot ${BOT_TOKEN}`,
      );
      err.cause = new Error(`ECONNRESET https://discord.com${req.path}`);
      return Promise.reject(err);
    };
    const gateway = new DiscordRestGateway(transport, {
      token: BOT_TOKEN,
      guildId: GUILD,
      botUserId: BOT,
    });
    const error = await gateway
      .acknowledgeInteraction({ interactionId: "i1", interactionToken: INTERACTION_TOKEN })
      .catch((e: unknown) => e);
    const err = error as Error & { cause?: unknown };
    const serialized = `${err.message}\n${err.stack ?? ""}\n${(err.cause as Error | undefined)?.message ?? ""}`;
    expect(serialized).not.toContain(INTERACTION_TOKEN);
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  it("HIGH-15: an ordinary non-2xx error never contains the bot token", async () => {
    const BOT_TOKEN = "BOT-SECRET-DO-NOT-LOG";
    const { transport } = transportOf([
      { match: (r) => r.method === "POST", response: ok({ message: "server error" }, 503) },
    ]);
    const gateway = new DiscordRestGateway(transport, {
      token: BOT_TOKEN,
      guildId: GUILD,
      botUserId: BOT,
    });
    const error = await gateway
      .sendThreadMessage({ threadId: "t1", content: "x" })
      .catch((e: unknown) => e);
    const serialized = `${(error as Error).message}\n${JSON.stringify(error)}`;
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  const BOT_TOKEN = "BOT-SECRET-DO-NOT-LOG";
  const INTERACTION_TOKEN = "TOP-SECRET-INTERACTION-TOKEN";

  /** Every place a credential could hide once an error escapes the adapter. */
  function fullySerialized(error: unknown): string {
    const e = error as Error & { cause?: unknown; detail?: unknown };
    return [
      String(error),
      e.message ?? "",
      e.stack ?? "",
      JSON.stringify(error),
      JSON.stringify((e as { detail?: unknown }).detail ?? null),
      String((e.cause as Error | undefined)?.message ?? ""),
    ].join("\n");
  }

  function ackGateway(transport: RestTransport): DiscordRestGateway {
    return new DiscordRestGateway(transport, { token: BOT_TOKEN, guildId: GUILD, botUserId: BOT });
  }

  it("HIGH-20: a STRING transport rejection is normalized fail-closed, no token leak", async () => {
    const transport: RestTransport = () =>
      Promise.reject(`transport ${INTERACTION_TOKEN} ${BOT_TOKEN}`);
    const error = await ackGateway(transport)
      .acknowledgeInteraction({ interactionId: "i1", interactionToken: INTERACTION_TOKEN })
      .catch((e: unknown) => e);
    // Unknown outcome → fail-closed to the non-retryable transport class.
    expect(error).toBeInstanceOf(DiscordTransportError);
    const serialized = fullySerialized(error);
    expect(serialized).not.toContain(INTERACTION_TOKEN);
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  it("HIGH-20: a custom Error with enumerable credential fields never leaks them", async () => {
    const transport: RestTransport = (req) => {
      const err = new Error("socket hang up") as Error & { detail?: unknown };
      // Enumerable fields (the shape that survives JSON.stringify) carrying secrets.
      err.detail = {
        url: `https://discord.com${req.path}`,
        authorization: `Bot ${BOT_TOKEN}`,
        nested: [{ token: INTERACTION_TOKEN }],
      };
      return Promise.reject(err);
    };
    const error = await ackGateway(transport)
      .acknowledgeInteraction({ interactionId: "i1", interactionToken: INTERACTION_TOKEN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordTransportError);
    const serialized = fullySerialized(error);
    expect(serialized).not.toContain(INTERACTION_TOKEN);
    expect(serialized).not.toContain(BOT_TOKEN);
    // Arbitrary fields are DROPPED, not merely redacted in place.
    expect((error as { detail?: unknown }).detail).toBeUndefined();
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it("HIGH-20: a plain-object/array/nested rejection collapses to a safe unknown-outcome error", async () => {
    const transport: RestTransport = (req) =>
      Promise.reject({
        url: `https://discord.com${req.path}`,
        headers: [`Bot ${BOT_TOKEN}`, { authorization: INTERACTION_TOKEN }],
        token: INTERACTION_TOKEN,
      });
    const error = await ackGateway(transport)
      .acknowledgeInteraction({ interactionId: "i1", interactionToken: INTERACTION_TOKEN })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordTransportError);
    const serialized = fullySerialized(error);
    expect(serialized).not.toContain(INTERACTION_TOKEN);
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  it("HIGH-20: a proven-safe DiscordUnavailableError keeps its retryable class, redacted", async () => {
    const transport: RestTransport = (req) =>
      Promise.reject(
        new DiscordUnavailableError(`refused https://discord.com${req.path} Bot ${BOT_TOKEN}`),
      );
    const gateway = new DiscordRestGateway(transport, {
      token: BOT_TOKEN,
      guildId: GUILD,
      botUserId: BOT,
    });
    const error = await gateway
      .sendThreadMessage({ threadId: "t1", content: "x" })
      .catch((e: unknown) => e);
    // Safe classification is preserved (retryable), but the message is redacted.
    expect(error).toBeInstanceOf(DiscordUnavailableError);
    const serialized = fullySerialized(error);
    expect(serialized).not.toContain(BOT_TOKEN);
  });

  it("HIGH-20: a 429 rejection keeps DiscordRateLimitError + retry-after, redacted", async () => {
    const transport: RestTransport = (req) =>
      Promise.reject(
        new DiscordRateLimitError(
          1500,
          `rate limited https://discord.com${req.path} Bot ${BOT_TOKEN}`,
        ),
      );
    const gateway = new DiscordRestGateway(transport, {
      token: BOT_TOKEN,
      guildId: GUILD,
      botUserId: BOT,
    });
    const error = await gateway
      .sendThreadMessage({ threadId: "t1", content: "x" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordRateLimitError);
    expect((error as DiscordRateLimitError).retryAfterMs).toBe(1500);
    expect(fullySerialized(error)).not.toContain(BOT_TOKEN);
  });
});
