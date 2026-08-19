import { describe, expect, it } from "vitest";

import { ChannelConfigError, ChannelRegistry } from "../src/channels.js";

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

describe("ChannelRegistry", () => {
  it("routes gmail/calendar per account alias, keeping private and SonderMind apart", () => {
    const r = registry();
    expect(r.routeChannelId("gmail", "private")).toBe("c-gmail-priv");
    expect(r.routeChannelId("gmail", "sondermind")).toBe("c-gmail-sm");
    expect(r.routeChannelId("calendar", "private")).toBe("c-cal-priv");
    expect(r.routeChannelId("calendar", "sondermind")).toBe("c-cal-sm");
    // A private route never resolves to the SonderMind channel.
    expect(r.routeChannelId("gmail", "private")).not.toBe(r.routeChannelId("gmail", "sondermind"));
  });

  it("routes jira and gitlab to their single channels regardless of alias", () => {
    const r = registry();
    expect(r.routeChannelId("jira", "private")).toBe("c-jira");
    expect(r.routeChannelId("jira", "sondermind")).toBe("c-jira");
    expect(r.routeChannelId("gitlab", "sondermind")).toBe("c-gitlab");
  });

  it("recognizes configured channels and exposes #system", () => {
    const r = registry();
    expect(r.isConfiguredChannel("c-jira")).toBe(true);
    expect(r.isConfiguredChannel("c-unknown")).toBe(false);
    expect(r.systemChannelId()).toBe("c-system");
  });

  it("fails closed on a missing or duplicated channel id", () => {
    expect(
      () =>
        new ChannelRegistry({
          guildId: "g",
          ownerId: "o",
          channels: {
            jira: "",
            "gmail-private": "a",
            "gmail-sondermind": "b",
            "calendar-private": "c",
            "calendar-sondermind": "d",
            gitlab: "e",
            system: "f",
          },
        }),
    ).toThrow(ChannelConfigError);

    expect(
      () =>
        new ChannelRegistry({
          guildId: "g",
          ownerId: "o",
          channels: {
            jira: "dup",
            "gmail-private": "dup",
            "gmail-sondermind": "b",
            "calendar-private": "c",
            "calendar-sondermind": "d",
            gitlab: "e",
            system: "f",
          },
        }),
    ).toThrow(ChannelConfigError);
  });
});
