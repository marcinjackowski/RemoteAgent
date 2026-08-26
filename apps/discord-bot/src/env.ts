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
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  engineeringWriteDeploymentPolicyFromExecutionConfigV2,
  type EngineeringWriteDeploymentPolicyV1,
} from "@remoteagent/contracts";
import { Database } from "@remoteagent/database";
import {
  DiscordBindingRepository,
  DiscordReceiptRepository,
  DiscordSendIntentRepository,
  AuditLogRepository,
  InboundMessageRepository,
  EngineeringApprovalIngressError,
  EngineeringApprovalIngressRepository,
  EngineeringStopIngressRepository,
  productionRuntime,
} from "@remoteagent/database";
import {
  ChannelRegistry,
  DiscordDispatcher,
  type ChannelKey,
  type IntakeOutcome,
} from "@remoteagent/discord";

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

type EngineeringIngressPort = Pick<EngineeringApprovalIngressRepository, "propose" | "respond">;
type EngineeringStopPort = Pick<EngineeringStopIngressRepository, "stop">;

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

/** Read only the authority projection from the worker's immutable deployment document. */
export async function engineeringWritePolicyFromEnv(
  env: Env = process.env,
): Promise<EngineeringWriteDeploymentPolicyV1 | null> {
  const path = env.RA_ENGINEERING_CONFIG_PATH?.trim();
  if (path === undefined || path === "") return null;
  if (!isAbsolute(path)) throw new DiscordEnvError("RA_ENGINEERING_CONFIG_PATH must be absolute");
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path)
    throw new DiscordEnvError("RA_ENGINEERING_CONFIG_PATH must be canonical");
  const decoded: unknown = JSON.parse(await readFile(canonicalPath, "utf8"));
  return engineeringWriteDeploymentPolicyFromExecutionConfigV2(decoded);
}

/**
 * RA-031: turn an authorized owner message in a case thread into durable work. It is recorded as
 * UNTRUSTED context and materialized into a PENDING supervisor unit + a `case.resume` job (see
 * {@link InboundMessageRepository}); every other outcome kind is left to its own path. Idempotent
 * on the Discord message id — a redelivered gateway event creates no duplicate. A message with no
 * id (never true for a real MESSAGE_CREATE) falls back to a random id so it is still processed,
 * just not dedupable. Exported so a composition test can drive it without a live gateway.
 */
export function createOwnerMessageSink(db: Database): (outcome: IntakeOutcome) => Promise<void> {
  const inbound = new InboundMessageRepository(productionRuntime());
  return async (outcome) => {
    if (outcome.kind !== "message") return;
    await inbound.receiveOwnerMessage(db, {
      messageId: outcome.messageId ?? randomUUID(),
      caseId: outcome.caseId,
      content: outcome.content,
    });
  };
}

/** Exhaustive production routing for owner outcomes; generic buttons never enter engineering. */
export function createOwnerOutcomeSink(input: {
  db: Database;
  engineeringIngress: EngineeringIngressPort | null;
  stopIngress: EngineeringStopPort;
  logger?: (event: string, detail?: Record<string, unknown>) => void;
}): (outcome: IntakeOutcome) => Promise<void> {
  const inbound = new InboundMessageRepository(productionRuntime());
  return async (outcome) => {
    switch (outcome.kind) {
      case "message":
        await inbound.receiveOwnerMessage(input.db, {
          messageId: outcome.messageId ?? randomUUID(),
          caseId: outcome.caseId,
          content: outcome.content,
        });
        return;
      case "stop":
        await input.stopIngress.stop(input.db, {
          caseId: outcome.caseId,
          actorId: outcome.actorId,
          interactionId: outcome.interactionId,
        });
        return;
      case "engineering_proposal":
        if (input.engineeringIngress === null) {
          input.logger?.("engineering.ingress_disabled", { reason: "deployment_policy_absent" });
          return;
        }
        try {
          await input.engineeringIngress.propose(input.db, {
            caseId: outcome.caseId,
            actorId: outcome.actorId,
            interactionId: outcome.interactionId,
          });
        } catch (error) {
          if (!(error instanceof EngineeringApprovalIngressError)) throw error;
          input.logger?.("engineering.proposal_refused", { error: error.name });
        }
        return;
      case "engineering":
        if (input.engineeringIngress === null) {
          input.logger?.("engineering.ingress_disabled", { reason: "deployment_policy_absent" });
          return;
        }
        try {
          await input.engineeringIngress.respond(input.db, {
            caseId: outcome.caseId,
            actorId: outcome.actorId,
            interactionId: outcome.interactionId,
            proposalId: outcome.interaction.proposalId,
            checkpointRevision: outcome.interaction.checkpointRevision,
            choice: outcome.interaction.choice,
          });
        } catch (error) {
          if (!(error instanceof EngineeringApprovalIngressError)) throw error;
          input.logger?.("engineering.response_refused", { error: error.name });
        }
        return;
      case "decision":
      case "approval":
      case "denied":
      case "ignored":
        return;
    }
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
    deploymentPolicy?: EngineeringWriteDeploymentPolicyV1 | null;
    engineeringIngress?: EngineeringIngressPort | null;
    stopIngress?: EngineeringStopPort;
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
  const runtime = productionRuntime();
  const engineeringIngress =
    overrides.engineeringIngress !== undefined
      ? overrides.engineeringIngress
      : overrides.deploymentPolicy == null
        ? null
        : new EngineeringApprovalIngressRepository({
            runtime,
            deploymentPolicy: overrides.deploymentPolicy,
          });
  const stopIngress = overrides.stopIngress ?? new EngineeringStopIngressRepository({ runtime });
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
    onInboundOutcome: createOwnerOutcomeSink({
      db,
      engineeringIngress,
      stopIngress,
      ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    }),
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
export function runFromEnv(
  env: Env = process.env,
  overrides: {
    logger?: (event: string, detail?: Record<string, unknown>) => void;
    /** Composition-test seam; production opens the database from the environment. */
    db?: Database;
    /** Composition-test seam proving the parsed policy reaches the real bot factory boundary. */
    composeBot?: typeof createDiscordBotFromEnv;
  } = {},
): Promise<{ bot: DiscordBot; db: Database }> {
  return runFromEnvAsync(env, overrides);
}

async function runFromEnvAsync(
  env: Env,
  overrides: {
    logger?: (event: string, detail?: Record<string, unknown>) => void;
    db?: Database;
    composeBot?: typeof createDiscordBotFromEnv;
  },
): Promise<{ bot: DiscordBot; db: Database }> {
  const config = discordConfigFromEnv(env);
  const db = overrides.db ?? Database.fromEnv();
  let deploymentPolicy: EngineeringWriteDeploymentPolicyV1 | null = null;
  try {
    deploymentPolicy = await engineeringWritePolicyFromEnv(env);
  } catch (error) {
    overrides.logger?.("engineering.config_invalid", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
  // The logger is forwarded because without it the process is UNDIAGNOSABLE. The gateway
  // classifies a disallowed privileged intent as a FATAL close (`4014`) and stops rather than
  // reconnecting — correct behaviour, but the only record of it is `gateway.close_fatal`. With
  // no logger the process prints "discord ready" and then goes silent, which reads as a
  // working bot that nobody is talking to.
  const composeBot = overrides.composeBot ?? createDiscordBotFromEnv;
  const bot = composeBot(config, db, {
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
    deploymentPolicy,
  });
  bot.session.start();
  return { bot, db };
}
