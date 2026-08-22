/**
 * `discord.js` — the owner's control channel (RA-027-WU-06).
 *
 * THE THINNEST OF THE FIVE PROCESSES, because `runFromEnv()` in `./env.ts` already does the
 * work: parse the env contract, open a database, compose the bot, start the gateway session.
 * All this file adds is a process lifecycle around it — which is exactly the split RA-027 is
 * for, and the reason this one took minutes rather than hours.
 *
 * EXACTLY ONE INSTANCE, ALWAYS. `infra/cdk` sets `desiredCount: 1` for this service, and
 * that is correctness rather than cost: a second gateway session opens a second connection
 * and receives every interaction twice, so the owner's single click becomes two approvals.
 *
 * THE KILL SWITCH MUST NOT MAKE THIS PROCESS UNREADY. It is reported in the health payload
 * and ignored by both verdicts. During an incident the owner needs to read status and answer
 * decision questions; a control channel that goes down when effects are stopped removes the
 * operator's ability to act at the moment they most need it. That is the AC6 rule from
 * RA-024, and this is the process where getting it wrong would hurt most.
 */
import type { Database } from "@remoteagent/database";
import {
  ProcessRuntime,
  StructuredLogger,
  type ProcessDefinition,
} from "@remoteagent/observability";

import type { DiscordBot } from "./index.js";
import { runFromEnv } from "./env.js";

export const DISCORD_ENV = {
  port: "RA_HEALTH_PORT",
  drainMs: "RA_DRAIN_MS",
} as const;

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export interface DiscordProcessConfig {
  readonly port: number;
  readonly drainMs: number;
}

export function discordProcessConfigFromEnv(env: Env = process.env): DiscordProcessConfig {
  return {
    port: positiveInt(env, DISCORD_ENV.port, 8080),
    // Shorter than a worker's: there is no claimed job to finish, only an open socket to
    // close. A long drain here would just delay the restart.
    drainMs: positiveInt(env, DISCORD_ENV.drainMs, 5_000),
  };
}

/**
 * Wrap an already-composed bot in a process definition.
 *
 * Takes the bot rather than building it, so a composition test can drive the lifecycle with
 * a fake gateway and no token — the same reason `env.ts` splits parsing from wiring.
 */
export function createDiscordProcess(input: {
  readonly bot: DiscordBot;
  readonly db: Database;
  readonly logger?: StructuredLogger;
}): ProcessDefinition {
  let started = false;

  return {
    name: "discord",
    start: () => {
      // `runFromEnv` already started the session, so `start` is idempotent here rather than
      // starting a second one — which would be the two-connections bug above.
      started = true;
    },
    stopAcceptingWork: () => {
      input.bot.session.stop();
    },
    // No `drain`: there is no claimed work. An interaction being handled when the socket
    // closes is retried by Discord, and `custom_id` replay is already idempotent (RA-006).
    // Declaring an empty drain would imply a guarantee this process does not make.
    close: async () => {
      await input.db.close();
    },
    isResponsive: () => started,
    isDatabaseReachable: async () => {
      try {
        await input.db.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The deployment entry point. Fully wired: `runFromEnv` needs no injection. */
export async function main(): Promise<void> {
  const config = discordProcessConfigFromEnv();
  const logger = new StructuredLogger({
    sink: { log: (record) => console.log(JSON.stringify(record)) },
  });
  // `runFromEnv` throws on a missing env var rather than defaulting — a bot with no token
  // would otherwise start, report healthy and silently receive nothing.
  const { bot, db } = runFromEnv();
  const runtime = new ProcessRuntime(createDiscordProcess({ bot, db, logger }), {
    port: config.port,
    drainMs: config.drainMs,
    logger,
  });
  await runtime.start();
  // Never logs the token; `StructuredLogger` redacts, and nothing here passes it anyway.
  logger.info("discord ready", { port: config.port });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
