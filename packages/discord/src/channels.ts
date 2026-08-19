/**
 * Channel configuration and provider→channel routing (RA-006, Master Plan §3.4).
 *
 * The private server exposes a fixed set of channels. Which Discord channel id
 * backs each logical channel — and which guild/owner are allowed — is TRUSTED
 * configuration assigned outside the model (Master Plan §3.4, §9); the model can
 * never widen it. `#system` carries alerts, DLQ and system status.
 *
 * Private and SonderMind accounts have SEPARATE channels and must not share
 * context through a model decision (Master Plan §3.4): the provider+alias→channel
 * map is the deterministic boundary that keeps them apart.
 */
import type { ConnectionAlias, Provider } from "@remoteagent/contracts";

/** The logical channels of the private RemoteAgent server. */
export const CHANNEL_KEYS = [
  "jira",
  "gmail-private",
  "gmail-sondermind",
  "calendar-private",
  "calendar-sondermind",
  "gitlab",
  "system",
] as const;

export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export class ChannelConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface ChannelRegistryConfig {
  /** The single guild (server) this bot serves. */
  guildId: string;
  /** The single owner allowed to command the bot. */
  ownerId: string;
  /** Map of each logical channel key to its concrete Discord channel id. */
  channels: Record<ChannelKey, string>;
}

/**
 * Resolves logical channels and routes an integration event to the right channel
 * while keeping the two accounts (private / SonderMind) strictly separated.
 */
export class ChannelRegistry {
  readonly #guildId: string;
  readonly #ownerId: string;
  readonly #channels: ReadonlyMap<ChannelKey, string>;
  readonly #idToKey: ReadonlyMap<string, ChannelKey>;

  public constructor(config: ChannelRegistryConfig) {
    const entries = CHANNEL_KEYS.map((key) => {
      const id = config.channels[key];
      if (id === undefined || id.trim().length === 0) {
        throw new ChannelConfigError(`missing channel id for "${key}"`);
      }
      return [key, id] as const;
    });
    const idToKey = new Map<string, ChannelKey>();
    for (const [key, id] of entries) {
      if (idToKey.has(id)) {
        throw new ChannelConfigError(`channel id ${id} is mapped to more than one logical channel`);
      }
      idToKey.set(id, key);
    }
    this.#guildId = config.guildId;
    this.#ownerId = config.ownerId;
    this.#channels = new Map(entries);
    this.#idToKey = idToKey;
  }

  public get guildId(): string {
    return this.#guildId;
  }

  public get ownerId(): string {
    return this.#ownerId;
  }

  /** The Discord channel id for a logical channel key. */
  public channelId(key: ChannelKey): string {
    const id = this.#channels.get(key);
    if (id === undefined) {
      throw new ChannelConfigError(`unknown channel key "${key}"`);
    }
    return id;
  }

  /** The `#system` channel id (alerts, DLQ, status). */
  public systemChannelId(): string {
    return this.channelId("system");
  }

  /** Whether a Discord channel id is one of the configured channels. */
  public isConfiguredChannel(channelId: string): boolean {
    return this.#idToKey.has(channelId);
  }

  /**
   * Route an integration event to its channel by provider + account alias so a
   * SonderMind mail never lands in the private channel and vice versa.
   */
  public routeChannelId(provider: Provider, alias: ConnectionAlias): string {
    const key = routeKey(provider, alias);
    return this.channelId(key);
  }
}

function routeKey(provider: Provider, alias: ConnectionAlias): ChannelKey {
  switch (provider) {
    case "jira":
      return "jira";
    case "gitlab":
      return "gitlab";
    case "gmail":
      return alias === "sondermind" ? "gmail-sondermind" : "gmail-private";
    case "calendar":
      return alias === "sondermind" ? "calendar-sondermind" : "calendar-private";
    case "discord":
      return "system";
    default: {
      // Exhaustiveness: a new provider must extend the routing table explicitly.
      const exhaustive: never = provider;
      throw new ChannelConfigError(`no channel route for provider ${String(exhaustive)}`);
    }
  }
}
