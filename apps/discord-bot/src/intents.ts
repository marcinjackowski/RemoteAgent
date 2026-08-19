/**
 * Minimal Discord gateway intents and bot permissions for RA-006 (AUDIT-01
 * HIGH-03).
 *
 * The bot is deliberately least-privilege (Master Plan §3.4, §11): it needs only
 * enough to (a) receive owner messages, the `/stop` command and decision/approval
 * button interactions in the private guild, and (b) publish + maintain a case's
 * thread and pinned status message. Interactions (buttons, slash commands) are
 * always delivered to the gateway and require NO privileged intent; MESSAGE_CONTENT
 * is the one privileged intent we need to read the owner's free-form replies.
 *
 * These values are configuration ASSIGNED OUTSIDE THE MODEL. The model can never
 * widen them; changing them is a deployment decision, not a runtime one.
 */

/** Discord gateway intent bit positions we actually use. */
export const GATEWAY_INTENT_BITS = {
  /** Guild lifecycle (channels/threads) — needed to resolve threads. */
  GUILDS: 1 << 0,
  /** Receive MESSAGE_CREATE in guild channels/threads. */
  GUILD_MESSAGES: 1 << 9,
  /** PRIVILEGED: read the actual text of the owner's replies. */
  MESSAGE_CONTENT: 1 << 15,
} as const;

/** The minimal intent bitfield the bot identifies with. */
export const MINIMAL_GATEWAY_INTENTS =
  GATEWAY_INTENT_BITS.GUILDS |
  GATEWAY_INTENT_BITS.GUILD_MESSAGES |
  GATEWAY_INTENT_BITS.MESSAGE_CONTENT;

/**
 * Minimal channel/bot permission bits (Discord permissions are a 64-bit field, so
 * these are `bigint`). Only the operations the dispatcher and intake actually
 * perform are requested.
 */
export const PERMISSION_BITS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  /** Pin/unpin the projected status message. */
  MANAGE_MESSAGES: 1n << 13n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  /** Reopen (unarchive) a case thread. */
  MANAGE_THREADS: 1n << 34n,
  /** Open a case thread off the anchor message. */
  CREATE_PUBLIC_THREADS: 1n << 35n,
  /** Post case turns into the thread. */
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
} as const;

/** The minimal permission bitfield to request when inviting the bot. */
export const MINIMAL_BOT_PERMISSIONS =
  PERMISSION_BITS.VIEW_CHANNEL |
  PERMISSION_BITS.SEND_MESSAGES |
  PERMISSION_BITS.MANAGE_MESSAGES |
  PERMISSION_BITS.READ_MESSAGE_HISTORY |
  PERMISSION_BITS.MANAGE_THREADS |
  PERMISSION_BITS.CREATE_PUBLIC_THREADS |
  PERMISSION_BITS.SEND_MESSAGES_IN_THREADS;

/** Render the permission bitfield as the decimal string Discord expects. */
export function permissionsParam(permissions: bigint = MINIMAL_BOT_PERMISSIONS): string {
  return permissions.toString();
}
