/**
 * RA-006 env composition contract test (AUDIT-02 MEDIUM-11).
 *
 * Validates the deployment env contract and that a runnable bot composes from it
 * WITHOUT a real token, network or database: the REST transport and gateway socket
 * are stubbed, so `session.start()` connects to the fake socket and the outbound
 * sink is wired. Also proves the env parser fails closed on a missing variable and
 * never echoes the token.
 */
import { Database } from "@remoteagent/database";
import { describe, expect, it } from "vitest";

import { DiscordEnvError, createDiscordBotFromEnv, discordConfigFromEnv } from "../src/env.js";
import type { GatewaySocket, GatewaySocketHandlers } from "../src/gateway-session.js";
import type { RestResponse } from "../src/rest-gateway.js";

const TOKEN = "REDACTED-TEST-TOKEN";

function fullEnv(): Record<string, string> {
  return {
    DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_GUILD_ID: "guild-1",
    DISCORD_OWNER_ID: "owner-1",
    DISCORD_BOT_USER_ID: "bot-1",
    DISCORD_CHANNEL_JIRA: "c-jira",
    DISCORD_CHANNEL_GMAIL_PRIVATE: "c-gmail-priv",
    DISCORD_CHANNEL_GMAIL_SONDERMIND: "c-gmail-sm",
    DISCORD_CHANNEL_CALENDAR_PRIVATE: "c-cal-priv",
    DISCORD_CHANNEL_CALENDAR_SONDERMIND: "c-cal-sm",
    DISCORD_CHANNEL_GITLAB: "c-gitlab",
    DISCORD_CHANNEL_SYSTEM: "c-system",
  };
}

describe("discordConfigFromEnv (RA-006 composition)", () => {
  it("parses a complete environment", () => {
    const config = discordConfigFromEnv(fullEnv());
    expect(config.token).toBe(TOKEN);
    expect(config.guildId).toBe("guild-1");
    expect(config.channels.jira).toBe("c-jira");
    expect(config.gatewayUrl).toBe("wss://gateway.discord.gg");
  });

  it("fails closed with the missing variable name (never echoing the token)", () => {
    const env = fullEnv();
    delete env.DISCORD_CHANNEL_SYSTEM;
    let thrown: unknown;
    try {
      discordConfigFromEnv(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DiscordEnvError);
    expect((thrown as Error).message).toContain("DISCORD_CHANNEL_SYSTEM");
    expect((thrown as Error).message).not.toContain(TOKEN);
  });

  it("composes a runnable bot with injected transports (no network, no secret)", () => {
    const config = discordConfigFromEnv(fullEnv());
    // A Database instance is constructed but never queried in this test (no
    // gateway/outbox traffic is driven), so no PostgreSQL is required.
    const db = new Database({ connectionString: "postgres://unused/localhost" });

    const restCalls: string[] = [];
    const restTransport = (req: { method: string; path: string }): Promise<RestResponse> => {
      restCalls.push(`${req.method} ${req.path}`);
      return Promise.resolve({ status: 200, headers: {}, body: { id: "x" } });
    };
    const sockets: { closed: boolean }[] = [];
    const socketFactory = (_url: string, handlers: GatewaySocketHandlers): GatewaySocket => {
      const socket = { closed: false, sent: [] as string[] };
      sockets.push(socket);
      return {
        send: () => {},
        close: () => {
          socket.closed = true;
          handlers.onClose(1000);
        },
      };
    };
    const logs: string[] = [];

    const bot = createDiscordBotFromEnv(config, db, {
      restTransport,
      socketFactory,
      logger: (event) => logs.push(event),
    });
    expect(typeof bot.outboxSink).toBe("function");
    bot.session.start();
    expect(sockets.length).toBe(1);
    bot.session.stop();
    // The token never reached the logger.
    expect(logs.join("|")).not.toContain(TOKEN);
    void db.close();
  });
});
