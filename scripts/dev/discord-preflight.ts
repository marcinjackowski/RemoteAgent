/**
 * Discord preflight — verify the configuration BEFORE starting the bot.
 *
 * WHY THIS EXISTS. `main()` in `apps/discord-bot/src/discord.ts` opens a gateway session, and
 * a misconfiguration there surfaces as a WebSocket close code rather than a message: `4014`
 * for a privileged intent that was never enabled in the Developer Portal, `4004` for a bad
 * token. Debugging a first run through close codes is miserable, so this script answers every
 * question it can with READ-ONLY REST calls first.
 *
 * READS ONLY. Every request is a `GET`. Nothing is posted, no thread is created, no message is
 * sent — so running this against a real guild cannot change anything. The token is read from
 * the environment, never logged, and never written to disk.
 *
 * Usage:
 *   . scripts/dev/env.sh
 *   export DISCORD_BOT_TOKEN=...            # and the other 11 vars
 *   pnpm tsx scripts/dev/discord-preflight.ts
 */
import {
  discordConfigFromEnv,
  DiscordEnvError,
  type DiscordEnvConfig,
} from "../../apps/discord-bot/src/env.js";
import {
  MINIMAL_BOT_PERMISSIONS,
  MINIMAL_GATEWAY_INTENTS,
  permissionsParam,
} from "../../apps/discord-bot/src/intents.js";

const API = "https://discord.com/api/v10";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

async function get(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API}${path}`, {
    method: "GET",
    headers: { authorization: `Bot ${token}`, "user-agent": "RemoteAgent-Preflight/1.0" },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** The channel keys, in the order a human reads them. */
const CHANNEL_LABELS = [
  "jira",
  "gmail-private",
  "gmail-sondermind",
  "calendar-private",
  "calendar-sondermind",
  "gitlab",
  "system",
] as const;

async function main(): Promise<void> {
  let config: DiscordEnvConfig;
  try {
    config = discordConfigFromEnv();
  } catch (error) {
    if (error instanceof DiscordEnvError) {
      // The env contract names the missing variable; print it and stop, because every later
      // check needs the token.
      process.stdout.write(`\nENV INCOMPLETE\n  ${error.message}\n\n`);
      process.stdout.write(
        "Required: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_OWNER_ID, DISCORD_BOT_USER_ID,\n" +
          "          DISCORD_CHANNEL_JIRA, DISCORD_CHANNEL_GMAIL_PRIVATE, DISCORD_CHANNEL_GMAIL_SONDERMIND,\n" +
          "          DISCORD_CHANNEL_CALENDAR_PRIVATE, DISCORD_CHANNEL_CALENDAR_SONDERMIND,\n" +
          "          DISCORD_CHANNEL_GITLAB, DISCORD_CHANNEL_SYSTEM\n" +
          "Optional: DISCORD_GATEWAY_URL (defaults to wss://gateway.discord.gg)\n\n",
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  record("env contract", true, "all 11 required variables present");

  // The registry rejects a duplicate channel id, so catching it here explains WHICH ids
  // collided rather than failing inside the bot's constructor.
  const seen = new Map<string, string>();
  let duplicate: string | null = null;
  for (const key of CHANNEL_LABELS) {
    const id = config.channels[key];
    const previous = seen.get(id);
    if (previous !== undefined) duplicate = `${id} is used by both "${previous}" and "${key}"`;
    seen.set(id, key);
  }
  record(
    "seven distinct channels",
    duplicate === null,
    duplicate ?? `${String(seen.size)} distinct channel ids`,
  );

  // --- identity -------------------------------------------------------------
  const me = await get("/users/@me", config.token);
  const meBody = me.body as { id?: string; username?: string } | null;
  record(
    "token valid",
    me.status === 200,
    me.status === 200
      ? `authenticated as ${meBody?.username ?? "?"}`
      : `HTTP ${String(me.status)} — token rejected (4004 at the gateway)`,
  );
  if (me.status !== 200) {
    report();
    return;
  }

  // A wrong DISCORD_BOT_USER_ID is quiet and nasty: the bot would fail to recognise its own
  // messages, so its own output could be treated as owner input.
  record(
    "DISCORD_BOT_USER_ID matches the token",
    meBody?.id === config.botUserId,
    meBody?.id === config.botUserId
      ? config.botUserId
      : `env says ${config.botUserId}, token belongs to ${meBody?.id ?? "?"}`,
  );

  // --- guild ----------------------------------------------------------------
  const guild = await get(`/guilds/${config.guildId}`, config.token);
  const guildBody = guild.body as { name?: string } | null;
  record(
    "bot is in the guild",
    guild.status === 200,
    guild.status === 200
      ? `${guildBody?.name ?? "?"} (${config.guildId})`
      : `HTTP ${String(guild.status)} — not a member, or wrong DISCORD_GUILD_ID`,
  );

  // --- channels -------------------------------------------------------------
  for (const key of CHANNEL_LABELS) {
    const id = config.channels[key];
    const channel = await get(`/channels/${id}`, config.token);
    const body = channel.body as { name?: string; guild_id?: string; type?: number } | null;
    if (channel.status !== 200) {
      record(
        `channel ${key}`,
        false,
        `HTTP ${String(channel.status)} — id ${id} is wrong or the bot cannot view it`,
      );
      continue;
    }
    // A channel in a DIFFERENT guild would pass a bare existence check and then break every
    // scope assertion, so the guild binding is verified explicitly.
    const sameGuild = body?.guild_id === config.guildId;
    // Type 0 is a text channel; threads are opened off an anchor message in one.
    const isText = body?.type === 0;
    record(
      `channel ${key}`,
      sameGuild && isText,
      sameGuild
        ? isText
          ? `#${body?.name ?? "?"}`
          : `#${body?.name ?? "?"} is type ${String(body?.type)}, not a text channel`
        : `#${body?.name ?? "?"} belongs to a different guild`,
    );
  }

  // --- privileged intent ----------------------------------------------------
  // THE ONE THING REST CANNOT PROVE. `MESSAGE_CONTENT` is a privileged intent: the gateway
  // accepts the Identify only if it is enabled in the Developer Portal, and rejects the whole
  // connection with close code 4014 otherwise. There is no REST endpoint that reports it, so
  // this is printed as an instruction rather than a check.
  process.stdout.write("\n=== Discord preflight (read-only) ===\n\n");
  report();

  process.stdout.write(
    "\nCANNOT BE CHECKED OVER REST — verify by hand in the Developer Portal:\n" +
      "  Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT must be ON.\n" +
      "  It is privileged, and without it the gateway closes the connection with 4014\n" +
      "  (the bot's own composition is fine, so the failure looks unrelated).\n\n" +
      `Gateway intents this bot identifies with: ${String(MINIMAL_GATEWAY_INTENTS)}\n` +
      "  = GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT\n\n" +
      `Minimal invite permissions: ${permissionsParam(MINIMAL_BOT_PERMISSIONS)}\n` +
      "  = VIEW_CHANNEL | SEND_MESSAGES | MANAGE_MESSAGES | READ_MESSAGE_HISTORY\n" +
      "    | MANAGE_THREADS | CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS\n\n",
  );
}

function report(): void {
  const width = Math.max(...checks.map((check) => check.name.length));
  for (const check of checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    process.stdout.write(`  [${mark}] ${check.name.padEnd(width)}  ${check.detail}\n`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  process.stdout.write(
    `\n  ${String(checks.length - failed)}/${String(checks.length)} checks passed\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

await main();
