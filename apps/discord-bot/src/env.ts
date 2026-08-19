/**
 * Runnable environment composition for the Discord bot (RA-006, AUDIT-02 MEDIUM-11).
 *
 * This is the deployment entrypoint that turns process configuration into a
 * running {@link DiscordBot}: it reads the (non-secret and secret) settings from
 * the environment, builds the persistence repositories, the outbound
 * {@link DiscordDispatcher} over the production REST adapter, and the inbound
 * gateway session over the concrete {@link nodeWebSocketFactory}. Nothing here
 * logs the bot token or any message content.
 *
 * The parsing is split from the wiring ({@link discordConfigFromEnv} vs
 * {@link createDiscordBotFromEnv}) so a composition test can validate the env
 * contract WITHOUT a real token, network or database, satisfying the required
 * "contract/composition test without a real secret".
 */
import { Database } from "@remoteagent/database";
import {
  DiscordBindingRepository,
  DiscordReceiptRepository,
  DiscordSendIntentRepository,
  AuditLogRepository,
} from "@remoteagent/database";
import { ChannelRegistry, DiscordDispatcher, type ChannelKey } from "@remoteagent/discord";

import { createDiscordBot, type DiscordBot } from "./index.js";
import { DiscordRestGateway } from "./rest-gateway.js";
import { fetchRestTransport } from "./fetch-transport.js";
import { nodeWebSocketFactory } from "./ws-factory.js";
import type { DispatchMapConfig } from "./lifecycle.js";

/** Env var names (documented so a deployment knows exactly what to set). */
const ENV = {
  token: "DISCORD_BOT_TOKEN",
  guildId: "DISCORD_GUILD_ID",
  ownerId: "DISCORD_OWNER_ID",
  botUserId: "DISCORD_BOT_USER_ID",
  gatewayUrl: "DISCORD_GATEWAY_URL",
} as const;

const CHANNEL_ENV: Record<ChannelKey, string> = {
  jira: "DISCORD_CHANNEL_JIRA",
  "gmail-private": "DISCORD_CHANNEL_GMAIL_PRIVATE",
  "gmail-sondermind": "DISCORD_CHANNEL_GMAIL_SONDERMIND",
  "calendar-private": "DISCORD_CHANNEL_CALENDAR_PRIVATE",
  "calendar-sondermind": "DISCORD_CHANNEL_CALENDAR_SONDERMIND",
  gitlab: "DISCORD_CHANNEL_GITLAB",
  system: "DISCORD_CHANNEL_SYSTEM",
};

const CHANNEL_KEYS = Object.keys(CHANNEL_ENV) as ChannelKey[];

export class DiscordEnvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The parsed, non-throwing-to-log Discord configuration. */
export interface DiscordEnvConfig {
  token: string;
  guildId: string;
  ownerId: string;
  botUserId: string;
  gatewayUrl: string;
  channels: Record<ChannelKey, string>;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new DiscordEnvError(`missing required environment variable ${name}`);
  }
  return value.trim();
}

/**
 * Parse and validate the Discord configuration from an environment map. Fails
 * closed with a NAMED variable on any missing value; never echoes the token.
 */
export function discordConfigFromEnv(env: Env = process.env): DiscordEnvConfig {
  const channels = {} as Record<ChannelKey, string>;
  for (const key of CHANNEL_KEYS) {
    channels[key] = required(env, CHANNEL_ENV[key]);
  }
  const botUserId = required(env, ENV.botUserId);
  return {
    token: required(env, ENV.token),
    guildId: required(env, ENV.guildId),
    ownerId: required(env, ENV.ownerId),
    botUserId,
    gatewayUrl: env[ENV.gatewayUrl]?.trim() ?? "wss://gateway.discord.gg",
    channels,
  };
}

/**
 * Compose a runnable {@link DiscordBot} from a parsed config and a database. The
 * REST transport (`fetch`) and gateway socket (`WebSocket`) are the concrete
 * production ones; both are still injected into the adapters so tests can swap
 * them. Call `bot.session.start()` to connect and feed `bot.outboxSink` to the
 * relay.
 */
export function createDiscordBotFromEnv(
  config: DiscordEnvConfig,
  db: Database,
  overrides: {
    restTransport?: ReturnType<typeof fetchRestTransport>;
    socketFactory?: ReturnType<typeof nodeWebSocketFactory>;
    logger?: (event: string, detail?: Record<string, unknown>) => void;
  } = {},
): DiscordBot {
  const registry = new ChannelRegistry({
    guildId: config.guildId,
    ownerId: config.ownerId,
    channels: config.channels,
  });
  const restTransport = overrides.restTransport ?? fetchRestTransport();
  const gateway = new DiscordRestGateway(restTransport, {
    token: config.token,
    guildId: config.guildId,
    botUserId: config.botUserId,
  });
  const bindings = new DiscordBindingRepository();
  const dispatcher = new DiscordDispatcher({
    db,
    bindings,
    receipts: new DiscordReceiptRepository(),
    intents: new DiscordSendIntentRepository(),
    gateway,
    channels: registry,
  });
  const map: DispatchMapConfig = { registry, botUserId: config.botUserId };
  return createDiscordBot({
    dispatcher,
    processor: {
      registry,
      resolveThreadCase: async (threadId) =>
        (await bindings.findByThread(db, threadId))?.case_id ?? null,
      audit: new AuditLogRepository(),
      db,
    },
    map,
    session: {
      factory: overrides.socketFactory ?? nodeWebSocketFactory(),
      token: config.token,
      gatewayUrl: config.gatewayUrl,
      ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
    },
    acknowledger: gateway,
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
  });
}

/**
 * Full deployment entrypoint: parse the environment, open a database from the
 * environment, compose the bot and start its inbound gateway session. Returns the
 * bot so the caller can also drive its `outboxSink` from the relay. Never logs the
 * token.
 */
export function runFromEnv(env: Env = process.env): { bot: DiscordBot; db: Database } {
  const config = discordConfigFromEnv(env);
  const db = Database.fromEnv();
  const bot = createDiscordBotFromEnv(config, db);
  bot.session.start();
  return { bot, db };
}
