import { describe, expect, it } from "vitest";

import { authorizeInbound, deniedAudit, type InboundContext } from "../src/authorization.js";
import { ChannelRegistry } from "../src/channels.js";

function registry(): ChannelRegistry {
  return new ChannelRegistry({
    guildId: "guild-1",
    ownerId: "owner-1",
    channels: {
      jira: "c-jira",
      "gmail-private": "c-gmail-priv",
      "gmail-sondermind": "c-gmail-sm",
      "calendar-private": "c-cal-priv",
      "calendar-sondermind": "c-cal-sm",
      gitlab: "c-gitlab",
      system: "c-system",
    },
  });
}

const noThread = () => Promise.resolve(null);
const knownThread = (caseId: string) => () => Promise.resolve(caseId);

describe("authorizeInbound (acceptance criterion 2)", () => {
  it("allows the configured owner in a configured channel", async () => {
    const ctx: InboundContext = {
      guildId: "guild-1",
      userId: "owner-1",
      origin: { surface: "channel", channelId: "c-jira" },
    };
    expect(await authorizeInbound(registry(), ctx, noThread)).toEqual({
      allowed: true,
      caseId: null,
    });
  });

  it("resolves the case when the owner acts in a known thread", async () => {
    const ctx: InboundContext = {
      guildId: "guild-1",
      userId: "owner-1",
      origin: { surface: "thread", threadId: "t-1" },
    };
    expect(await authorizeInbound(registry(), ctx, knownThread("case-1"))).toEqual({
      allowed: true,
      caseId: "case-1",
    });
  });

  it("rejects a wrong guild, non-owner, unknown channel and unknown thread", async () => {
    const r = registry();
    expect(
      await authorizeInbound(
        r,
        {
          guildId: "other",
          userId: "owner-1",
          origin: { surface: "channel", channelId: "c-jira" },
        },
        noThread,
      ),
    ).toEqual({ allowed: false, reason: "wrong_guild" });

    expect(
      await authorizeInbound(
        r,
        { guildId: null, userId: "owner-1", origin: { surface: "channel", channelId: "c-jira" } },
        noThread,
      ),
    ).toEqual({ allowed: false, reason: "not_in_guild" });

    expect(
      await authorizeInbound(
        r,
        {
          guildId: "guild-1",
          userId: "intruder",
          origin: { surface: "channel", channelId: "c-jira" },
        },
        noThread,
      ),
    ).toEqual({ allowed: false, reason: "not_owner" });

    expect(
      await authorizeInbound(
        r,
        { guildId: "guild-1", userId: "owner-1", origin: { surface: "channel", channelId: "c-x" } },
        noThread,
      ),
    ).toEqual({ allowed: false, reason: "unknown_channel" });

    expect(
      await authorizeInbound(
        r,
        { guildId: "guild-1", userId: "owner-1", origin: { surface: "thread", threadId: "t-x" } },
        noThread,
      ),
    ).toEqual({ allowed: false, reason: "unknown_thread" });
  });

  it("produces a content-free audit record for a denied interaction", () => {
    const ctx: InboundContext = {
      guildId: "guild-1",
      userId: "intruder",
      origin: { surface: "channel", channelId: "c-jira" },
    };
    const audit = deniedAudit(ctx, "not_owner");
    expect(audit.outcome).toBe("FAILURE");
    expect(audit.action).toBe("discord.inbound.denied");
    // The audit carries ids and a reason but NEVER any message content.
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("content");
    expect(audit.detail).toEqual({
      reason: "not_owner",
      guild_id: "guild-1",
      user_id: "intruder",
      surface: "channel",
      channel_id: "c-jira",
      thread_id: null,
    });
  });
});
