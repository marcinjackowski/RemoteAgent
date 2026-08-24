import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JiraReconcileEnvError,
  basicAuthTransport,
  jiraReconcileConfigFromEnv,
} from "../src/jira-auth.js";

const FULL = {
  JIRA_ORIGIN: "https://acme.atlassian.net/",
  JIRA_EMAIL: "me@example.com",
  JIRA_API_TOKEN: "super-secret-token",
  DISCORD_GUILD_ID: "guild-1",
  DISCORD_OWNER_ID: "owner-discord",
  DISCORD_CHANNEL_JIRA: "c-jira",
  DISCORD_CHANNEL_GMAIL_PRIVATE: "c-gmp",
  DISCORD_CHANNEL_GMAIL_SONDERMIND: "c-gms",
  DISCORD_CHANNEL_CALENDAR_PRIVATE: "c-cp",
  DISCORD_CHANNEL_CALENDAR_SONDERMIND: "c-cs",
  DISCORD_CHANNEL_GITLAB: "c-gl",
  DISCORD_CHANNEL_SYSTEM: "c-sys",
};

describe("jiraReconcileConfigFromEnv", () => {
  it("returns null when the feature is off (no token) — fail-closed, not misconfigured", () => {
    expect(jiraReconcileConfigFromEnv({})).toBeNull();
    expect(jiraReconcileConfigFromEnv({ JIRA_ORIGIN: FULL.JIRA_ORIGIN })).toBeNull();
  });

  it("parses a full config and normalizes the origin", () => {
    const config = jiraReconcileConfigFromEnv(FULL);
    expect(config).not.toBeNull();
    expect(config?.origin).toBe("https://acme.atlassian.net"); // trailing slash dropped
    expect(config?.ownerId).toBe("owner-local"); // default
    expect(config?.connectionId).toBe("connection-local-jira");
    expect(config?.alias).toBe("private");
    expect(config?.channels.jira).toBe("c-jira");
  });

  const without = (key: keyof typeof FULL): Record<string, string> => {
    const copy: Record<string, string> = { ...FULL };
    delete copy[key];
    return copy;
  };

  it("throws (not returns null) when the token IS set but a required var is missing", () => {
    expect(() => jiraReconcileConfigFromEnv(without("DISCORD_CHANNEL_JIRA"))).toThrow(
      JiraReconcileEnvError,
    );
    expect(() => jiraReconcileConfigFromEnv(without("JIRA_ORIGIN"))).toThrow(/JIRA_ORIGIN/);
  });

  it("never puts the token value in an error message (canary)", () => {
    try {
      jiraReconcileConfigFromEnv(without("JIRA_EMAIL"));
      throw new Error("expected a throw");
    } catch (error) {
      expect(String(error)).not.toContain(FULL.JIRA_API_TOKEN);
      expect(String(error)).toContain("JIRA_EMAIL");
    }
  });
});

describe("basicAuthTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("authenticates with Basic base64(email:token) and maps the response", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seen = { url, headers: init.headers };
      return {
        status: 200,
        headers: new Map(),
        redirected: false,
        url,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    });

    const transport = basicAuthTransport("me@example.com", "tok123");
    const res = await transport({
      method: "GET",
      url: "https://acme.atlassian.net/rest/api/3/myself",
      headers: { Accept: "application/json" },
    });

    expect(seen!.headers.Authorization).toBe(
      `Basic ${Buffer.from("me@example.com:tok123").toString("base64")}`,
    );
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(false);
    expect(res.finalUrl).toBe("https://acme.atlassian.net/rest/api/3/myself");
  });
});
