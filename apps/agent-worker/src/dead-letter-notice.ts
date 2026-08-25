/**
 * Tell the owner, in the case thread, that the agent hit an error and could not reply (RA-036).
 *
 * When an owner-driven `case.resume` job exhausts its attempts and dead-letters, nothing else
 * surfaces that to the owner — the thread just stays silent after their message. This projects a
 * single, user-safe error message into the thread the same way `projectCompletionReply` projects a
 * normal reply: reserve the next per-case seq, enqueue the `discord.thread_message` the discord-bot
 * relay delivers, and record it as an AGENT message so the log/context stay consistent.
 *
 * Idempotent on the JOB id (`error:<jobId>`): a crash between the enqueue and the throw, followed by
 * a lease reap + re-claim, re-runs the handler — this must not post a second error. Returns false
 * when the case has no Discord thread (nothing to post in).
 *
 * The body is a FIXED, user-safe string: no stack trace, no internal ids (AC2). The failure detail
 * lives in the job's `last_error` / DLQ for an operator, never in the owner-facing thread.
 */
import {
  CaseMessageRepository,
  OutboxRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { DISCORD_EVENT_TYPES } from "@remoteagent/discord";

/** User-facing, detail-free error text delivered to the owner's thread. */
export const DEAD_LETTER_NOTICE_BODY =
  "⚠️ I ran into an error and couldn't finish responding to your last message. " +
  "Please try again in a moment.";

export async function projectDeadLetterNotice(input: {
  readonly db: Database;
  readonly caseId: string;
  readonly jobId: string;
}): Promise<boolean> {
  const outbox = new OutboxRepository(productionRuntime());
  const messages = new CaseMessageRepository();
  const messageId = `error:${input.jobId}`;
  return input.db.withTransaction(async (tx) => {
    const already = await tx.query(`SELECT 1 FROM case_messages WHERE message_id = $1`, [
      messageId,
    ]);
    if (already.rows.length > 0) return true; // already projected — idempotent on the job id
    const reserved = await tx.query<{ seq: string }>(
      `UPDATE discord_case_bindings SET next_seq = next_seq + 1
       WHERE case_id = $1 RETURNING (next_seq - 1)::bigint AS seq`,
      [input.caseId],
    );
    if (reserved.rows.length === 0) return false; // no Discord thread for this case
    const seq = Number(reserved.rows[0]!.seq);
    await outbox.enqueue(tx, {
      aggregate: "discord_case",
      aggregateId: input.caseId,
      eventType: DISCORD_EVENT_TYPES.THREAD_MESSAGE,
      payload: { case_id: input.caseId, seq, body: DEAD_LETTER_NOTICE_BODY },
    });
    // Recorded as the bot's own (TRUSTED) message so the thread log stays consistent and the
    // idempotency marker survives.
    await messages.append(tx, {
      messageId,
      caseId: input.caseId,
      role: "AGENT",
      trust: "TRUSTED",
      body: DEAD_LETTER_NOTICE_BODY,
    });
    return true;
  });
}
