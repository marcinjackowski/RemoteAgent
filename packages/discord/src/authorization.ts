/**
 * Inbound authorization for Discord traffic (RA-006).
 *
 * The model is NOT an authorization layer (AGENTS.md §6): who may command the bot
 * is decided deterministically here, from TRUSTED configuration, before any
 * content is read or routed. An interaction is accepted only when ALL hold:
 *
 *   - it originates in the configured guild;
 *   - its author is the configured owner;
 *   - it targets a configured channel or a thread known to belong to a case.
 *
 * A rejected interaction is IGNORED and audited WITHOUT its content (acceptance
 * criterion 2): the audit record captures the actor/guild/channel ids and the
 * reason, never the message body, so an unauthorized probe cannot smuggle content
 * into the audit log.
 */
import type { ChannelRegistry } from "./channels.js";

export type InboundOrigin =
  { surface: "channel"; channelId: string } | { surface: "thread"; threadId: string };

export interface InboundContext {
  guildId: string | null;
  userId: string;
  origin: InboundOrigin;
}

export type AuthorizationDenyReason =
  "not_in_guild" | "wrong_guild" | "not_owner" | "unknown_channel" | "unknown_thread";

export type AuthorizationResult =
  { allowed: true; caseId: string | null } | { allowed: false; reason: AuthorizationDenyReason };

/**
 * A content-free description of a denied interaction, suitable for the audit log.
 * It intentionally omits any message body or component payload.
 */
export interface DeniedAudit {
  actor: string;
  action: "discord.inbound.denied";
  outcome: "FAILURE";
  detail: {
    reason: AuthorizationDenyReason;
    guild_id: string | null;
    user_id: string;
    surface: InboundOrigin["surface"];
    channel_id: string | null;
    thread_id: string | null;
  };
}

/**
 * Resolve the case a known thread belongs to. Implemented by the caller over
 * {@link DiscordBindingRepository.findByThread}; returns `null` for an unknown
 * thread so authorization can reject it fail-closed.
 */
export type ThreadCaseResolver = (threadId: string) => Promise<string | null>;

export async function authorizeInbound(
  registry: ChannelRegistry,
  ctx: InboundContext,
  resolveThreadCase: ThreadCaseResolver,
): Promise<AuthorizationResult> {
  if (ctx.guildId === null) {
    return { allowed: false, reason: "not_in_guild" };
  }
  if (ctx.guildId !== registry.guildId) {
    return { allowed: false, reason: "wrong_guild" };
  }
  if (ctx.userId !== registry.ownerId) {
    return { allowed: false, reason: "not_owner" };
  }
  if (ctx.origin.surface === "channel") {
    if (!registry.isConfiguredChannel(ctx.origin.channelId)) {
      return { allowed: false, reason: "unknown_channel" };
    }
    return { allowed: true, caseId: null };
  }
  const caseId = await resolveThreadCase(ctx.origin.threadId);
  if (caseId === null) {
    return { allowed: false, reason: "unknown_thread" };
  }
  return { allowed: true, caseId };
}

/** Build the content-free audit record for a denied interaction. */
export function deniedAudit(ctx: InboundContext, reason: AuthorizationDenyReason): DeniedAudit {
  return {
    actor: ctx.userId,
    action: "discord.inbound.denied",
    outcome: "FAILURE",
    detail: {
      reason,
      guild_id: ctx.guildId,
      user_id: ctx.userId,
      surface: ctx.origin.surface,
      channel_id: ctx.origin.surface === "channel" ? ctx.origin.channelId : null,
      thread_id: ctx.origin.surface === "thread" ? ctx.origin.threadId : null,
    },
  };
}
