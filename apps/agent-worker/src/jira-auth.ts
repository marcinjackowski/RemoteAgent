/**
 * Production Jira auth for the reconcile handler (RA-030 / ADR-0010).
 *
 * Single-owner system: a personal API token over Basic auth, not OAuth 3LO. The token comes from
 * the process environment, is held as a string only as long as the config lives, and is never
 * logged (errors name the VARIABLE, never its value). `JiraRestClient` still sends Bearer by
 * default and owns origin allow-listing / redirect rejection / retry classification; the transport
 * here only rewrites the Authorization header — the sanctioned injection point proven by
 * `scripts/dev/jira-poll.ts` and accepted in RA-016.
 *
 * The env contract is parsed with NO database, NO network and NO secret leakage, so a composition
 * test can validate it without a live anything (the convention `env.ts` established).
 */
import type { JiraHttpRequest, JiraHttpResponse, JiraTransport } from "@remoteagent/connector-jira";
import type { ChannelKey } from "@remoteagent/discord";
import { connectionAliasSchema, type ConnectionAlias } from "@remoteagent/contracts";

/** A `fetch`-backed transport that authenticates with Basic instead of the client's Bearer. */
export function basicAuthTransport(email: string, token: string): JiraTransport {
  const credential = Buffer.from(`${email}:${token}`).toString("base64");
  return async (request: JiraHttpRequest): Promise<JiraHttpResponse> => {
    const response = await fetch(request.url, {
      method: request.method,
      // `manual`: the client rejects any redirect (a redirected Jira call can be an SSO
      // interception), so surface a 3xx as a rejected redirect rather than following it.
      redirect: "manual",
      headers: {
        ...request.headers,
        Authorization: `Basic ${credential}`,
        "User-Agent": "RemoteAgent-Worker/1.0",
      },
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers,
      json: () => response.json(),
      finalUrl: response.redirected ? response.url : request.url,
      redirected: response.redirected,
    };
  };
}

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

export interface JiraReconcileEnvConfig {
  readonly origin: string;
  readonly email: string;
  readonly token: string;
  /** RemoteAgent owner_id and connection_id in the DB (not the Discord user id). */
  readonly ownerId: string;
  readonly connectionId: string;
  readonly alias: ConnectionAlias;
  /** Discord routing config for the ChannelRegistry the correlator uses. */
  readonly guildId: string;
  readonly discordOwnerId: string;
  readonly channels: Record<ChannelKey, string>;
}

export class JiraReconcileEnvError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") {
    // Names the variable, never a value — no secret ever reaches an error string.
    throw new JiraReconcileEnvError(`missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Parse the Jira reconcile config from the environment.
 *
 * Returns `null` when the feature is simply OFF (no `JIRA_API_TOKEN`), so a deployment without
 * Jira credentials registers no handler — fail-closed to the DLQ, exactly like renewal. Throws
 * when the token IS set but the surrounding config is incomplete: that is a misconfiguration a
 * deployment must see, not silently ignore.
 */
export function jiraReconcileConfigFromEnv(env: Env = process.env): JiraReconcileEnvConfig | null {
  if ((env.JIRA_API_TOKEN ?? "").trim() === "") return null;
  const channels = {} as Record<ChannelKey, string>;
  for (const key of CHANNEL_KEYS) channels[key] = required(env, CHANNEL_ENV[key]);
  const originRaw = required(env, "JIRA_ORIGIN");
  let origin: string;
  try {
    origin = new URL(originRaw).origin;
  } catch {
    throw new JiraReconcileEnvError("JIRA_ORIGIN is not a valid URL");
  }
  const alias = connectionAliasSchema.safeParse(env.JIRA_CONNECTION_ALIAS?.trim() || "private");
  if (!alias.success) {
    throw new JiraReconcileEnvError("JIRA_CONNECTION_ALIAS must be 'private' or 'sondermind'");
  }
  return {
    origin,
    email: required(env, "JIRA_EMAIL"),
    token: required(env, "JIRA_API_TOKEN"),
    ownerId: env.JIRA_OWNER_ID?.trim() || "owner-local",
    connectionId: env.JIRA_CONNECTION_ID?.trim() || "connection-local-jira",
    alias: alias.data,
    guildId: required(env, "DISCORD_GUILD_ID"),
    discordOwnerId: required(env, "DISCORD_OWNER_ID"),
    channels,
  };
}
