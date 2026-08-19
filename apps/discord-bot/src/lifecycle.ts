/**
 * Inbound gateway-event mapping and composition (RA-006, AUDIT-01 HIGH-03 /
 * MEDIUM-04, AUDIT-02 MEDIUM-11).
 *
 * Translates raw Discord gateway DISPATCH events (MESSAGE_CREATE, INTERACTION_CREATE)
 * into the typed {@link InboundInteraction} the domain understands, then runs them
 * through {@link processInbound} so an unauthorized attempt is DURABLY audited
 * content-free before anything else happens (MEDIUM-04). Mapping is defensive: a
 * malformed or unrecognized event maps to `null` and is ignored, never guessed.
 *
 * For INTERACTION_CREATE (buttons, slash commands) the raw interaction id + token
 * are preserved and the interaction is ACKNOWLEDGED (deferred) via the injected
 * {@link InteractionAcknowledger} within Discord's response window, so the user
 * never sees a "failed" interaction even though the domain side effect proceeds
 * asynchronously (AUDIT-02 MEDIUM-11). The ACK carries no content.
 *
 * Whether an event's channel is a top-level channel or a case thread is decided
 * deterministically from the {@link ChannelRegistry} (a configured channel id ⇒
 * channel surface; anything else ⇒ thread surface), never from the model.
 */
import type {
  InboundInteraction,
  InboundProcessorDeps,
  IntakeOutcome,
  InteractionAcknowledger,
} from "@remoteagent/discord";
import { ChannelRegistry, processInbound } from "@remoteagent/discord";

/** Discord interaction `type` values we handle. */
const INTERACTION_TYPE = { APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 } as const;

interface RawMessageCreate {
  channel_id?: string;
  guild_id?: string | null;
  author?: { id?: string };
  content?: string;
}

interface RawInteraction {
  id?: string;
  token?: string;
  type?: number;
  guild_id?: string | null;
  channel_id?: string;
  member?: { user?: { id?: string } };
  user?: { id?: string };
  data?: { name?: string; custom_id?: string };
}

/** The bot's own user id, so its own messages are never re-ingested. */
export interface DispatchMapConfig {
  registry: ChannelRegistry;
  botUserId: string;
}

/** The Discord-transport id/token needed to acknowledge an interaction. */
export interface InteractionAck {
  interactionId: string;
  interactionToken: string;
}

/**
 * Map a raw gateway dispatch (event name + data) to an {@link InboundInteraction},
 * or `null` when it is irrelevant/malformed/self-authored.
 */
export function mapDispatchToInbound(
  config: DispatchMapConfig,
  t: string,
  d: unknown,
): InboundInteraction | null {
  if (t === "MESSAGE_CREATE") {
    const m = d as RawMessageCreate;
    const userId = m.author?.id;
    const channelId = m.channel_id;
    if (userId === undefined || channelId === undefined) return null;
    if (userId === config.botUserId) return null; // ignore our own posts
    return {
      type: "message",
      guildId: m.guild_id ?? null,
      userId,
      origin: originOf(config.registry, channelId),
      content: m.content ?? "",
    };
  }
  if (t === "INTERACTION_CREATE") {
    const i = d as RawInteraction;
    const userId = i.member?.user?.id ?? i.user?.id;
    const channelId = i.channel_id;
    if (userId === undefined || channelId === undefined) return null;
    const origin = originOf(config.registry, channelId);
    if (i.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
      const customId = i.data?.custom_id;
      if (customId === undefined) return null;
      return { type: "button", guildId: i.guild_id ?? null, userId, origin, customId };
    }
    if (i.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
      const command = i.data?.name;
      if (command === undefined) return null;
      return { type: "command", guildId: i.guild_id ?? null, userId, origin, command };
    }
    return null;
  }
  return null;
}

/**
 * Extract the interaction id/token from a raw INTERACTION_CREATE so it can be
 * acknowledged. Returns `null` for non-interaction events or a malformed payload.
 */
export function extractInteractionAck(t: string, d: unknown): InteractionAck | null {
  if (t !== "INTERACTION_CREATE") return null;
  const i = d as RawInteraction;
  if (typeof i.id !== "string" || typeof i.token !== "string") return null;
  return { interactionId: i.id, interactionToken: i.token };
}

function originOf(registry: ChannelRegistry, channelId: string): InboundInteraction["origin"] {
  return registry.isConfiguredChannel(channelId)
    ? { surface: "channel", channelId }
    : { surface: "thread", threadId: channelId };
}

export interface InboundDispatchOptions {
  onOutcome?: (outcome: IntakeOutcome) => void | Promise<void>;
  /** Acknowledges interactions within Discord's response window (MEDIUM-11). */
  acknowledger?: InteractionAcknowledger;
  /** Structured log sink (never receives message content or secrets). */
  logger?: (event: string, detail?: Record<string, unknown>) => void;
}

/**
 * Build the gateway `onDispatch` handler: map the event, ACK an interaction
 * (deferred) so Discord shows success, then authorize + durably audit it via
 * {@link processInbound}. A mapped-to-null event is ignored.
 */
export function createInboundDispatchHandler(
  processorDeps: InboundProcessorDeps,
  mapConfig: DispatchMapConfig,
  options: InboundDispatchOptions = {},
): (t: string, d: unknown) => Promise<void> {
  return async (t, d) => {
    const interaction = mapDispatchToInbound(mapConfig, t, d);
    if (interaction === null) return;

    // Acknowledge interactions promptly (content-free defer) so the user's client
    // does not show a failure while the domain side effect proceeds.
    if (options.acknowledger !== undefined && interaction.type !== "message") {
      const ack = extractInteractionAck(t, d);
      if (ack !== null) {
        try {
          await options.acknowledger.acknowledgeInteraction({ ...ack, deferred: true });
        } catch (error) {
          // Log ONLY a safe class/code — never the error message, which for a
          // failed callback could embed the interaction token (AUDIT-03 HIGH-15).
          options.logger?.("inbound.ack_failed", safeErrorLabel(error));
        }
      }
    }

    const outcome = await processInbound(processorDeps, interaction);
    if (options.onOutcome !== undefined) {
      await options.onOutcome(outcome);
    }
  };
}

/**
 * A redacted description of an error for logging: the error CLASS and, when
 * present, a numeric status code — never the message/stack, so an interaction or
 * bot token can never reach the logger (AUDIT-03 HIGH-15).
 */
function safeErrorLabel(error: unknown): Record<string, unknown> {
  const name = error instanceof Error ? error.name : "UnknownError";
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? { error: name, status } : { error: name };
}
