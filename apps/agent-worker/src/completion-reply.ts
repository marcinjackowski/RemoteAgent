/**
 * Project an agent completion into a reply in the case's Discord thread (RA-032 WU-05).
 *
 * The completion persists a `case` outbox event that nothing delivers to Discord. This turns the
 * completion summary into a `discord_case` `thread_message` — reserving the next per-case seq (so
 * it orders after prior messages), enqueuing the row the discord-bot relay (RA-029) delivers, and
 * recording the reply as an `AGENT` message so the conversation log and future context include it.
 *
 * Idempotent on the run id: a second call is a no-op (the AGENT message already exists), so no
 * duplicate post. Returns false when the case has no Discord binding (no thread to reply in).
 *
 * NOT atomic with completion persistence (separate transaction): if the process crashes between
 * the completion commit and this call, the reply is lost — LOW severity, recoverable (the owner
 * re-asks), and never a duplicate. Full atomicity would require enqueuing inside the completion
 * transaction, which touches the accepted RA-008 completion contract.
 */
import {
  CaseMessageRepository,
  OutboxRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";

export async function projectCompletionReply(input: {
  readonly db: Database;
  readonly caseId: string;
  readonly runId: string;
  readonly body: string;
}): Promise<boolean> {
  const outbox = new OutboxRepository(productionRuntime());
  const messages = new CaseMessageRepository();
  const messageId = `reply:${input.runId}`;
  return input.db.withTransaction(async (tx) => {
    const already = await tx.query(`SELECT 1 FROM case_messages WHERE message_id = $1`, [
      messageId,
    ]);
    if (already.rows.length > 0) return true; // already projected — idempotent
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
      eventType: "discord.thread_message",
      payload: { case_id: input.caseId, seq, body: input.body },
    });
    // The agent's own reply is TRUSTED (system output), unlike the owner's UNTRUSTED input.
    await messages.append(tx, {
      messageId,
      caseId: input.caseId,
      role: "AGENT",
      trust: "TRUSTED",
      body: input.body,
    });
    return true;
  });
}
