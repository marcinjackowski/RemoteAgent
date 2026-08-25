/**
 * Outbox → Discord delivery payloads (RA-006).
 *
 * The discord-bot consumes the transactional outbox (RA-004) and turns each
 * message into a Discord side effect. These schemas are the strict, fail-closed
 * contract for what a producer may enqueue: a malformed or unknown payload is
 * rejected rather than best-effort delivered, so a corrupt outbox row can never
 * cause an unintended Discord write.
 *
 * Producers are TRUSTED server components (case resolver, orchestrator), so they
 * may carry decision/approval identity used to build interaction buttons. The
 * dispatcher — not the producer and never the model — constructs the button
 * `custom_id`s from that identity, keeping the (decision id, checkpoint revision)
 * binding authoritative.
 */
import * as z from "zod";

const id = z.string().trim().min(1).max(512);
const revision = z.int().nonnegative();
/** Producer-reserved, gap-free per-case delivery sequence (starts at 1). */
const seq = z.int().min(1);

/** Aggregate name the discord-bot claims from the outbox. */
export const DISCORD_OUTBOX_AGGREGATE = "discord_case" as const;

export const rootThreadPayload = z.strictObject({
  case_id: id,
  owner_id: id,
  seq,
  provider: z.enum(["jira", "gmail", "calendar", "gitlab", "discord"]),
  alias: z.enum(["private", "sondermind"]),
  title: z.string().min(1).max(4000),
  body: z.string().max(65_536),
});

export const decisionButtonsSpec = z.strictObject({
  decision_id: id,
  checkpoint_revision: revision,
  options: z
    .array(z.strictObject({ option_id: id, label: z.string().min(1).max(80) }))
    .min(2)
    .max(3),
});

export const approvalButtonsSpec = z.strictObject({
  approval_id: id,
  checkpoint_revision: revision,
});

export const threadMessagePayload = z.strictObject({
  case_id: id,
  seq,
  body: z.string().max(65_536),
  decision: decisionButtonsSpec.optional(),
  approval: approvalButtonsSpec.optional(),
});

/**
 * A "the agent is composing a reply" hint (RA-035). It carries NO seq: typing is an
 * ephemeral, disposable UX signal (Discord shows it for ~10s), orthogonal to the ordered
 * message stream, so it must never reserve or advance a delivery sequence.
 */
export const threadTypingPayload = z.strictObject({
  case_id: id,
});

export const statusPayload = z.strictObject({
  case_id: id,
  status: z.string().min(1).max(64),
  goal: z.string().max(4000),
  current_phase: z.string().max(256),
  summary: z.string().max(8000),
  open_questions: z.array(z.string().max(1000)).max(64).default([]),
  next_actions: z.array(z.string().max(1000)).max(64).default([]),
  blockers: z.array(z.string().max(1000)).max(64).default([]),
  pending_approvals: z.array(z.string().max(1000)).max(64).default([]),
  checkpoint_revision: revision,
});

export type RootThreadPayload = z.infer<typeof rootThreadPayload>;
export type ThreadMessagePayload = z.infer<typeof threadMessagePayload>;
export type ThreadTypingPayload = z.infer<typeof threadTypingPayload>;
export type StatusPayload = z.infer<typeof statusPayload>;

export const DISCORD_EVENT_TYPES = {
  ROOT_THREAD: "discord.root_thread",
  THREAD_MESSAGE: "discord.thread_message",
  THREAD_TYPING: "discord.thread_typing",
  STATUS: "discord.status",
} as const;

export type DiscordEventType = (typeof DISCORD_EVENT_TYPES)[keyof typeof DISCORD_EVENT_TYPES];
