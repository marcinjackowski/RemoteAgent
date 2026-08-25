/**
 * Show the owner a "typing…" hint while the agent composes a reply (RA-035).
 *
 * The worker never talks to Discord directly — it enqueues a `discord.thread_typing` event on
 * the transactional outbox (aggregate `discord_case`), which the discord-bot relay turns into a
 * native Discord typing indicator (`POST /channels/{threadId}/typing`). The event carries NO
 * seq: typing is an ephemeral, disposable UX signal, orthogonal to the ordered message stream,
 * and its dispatcher delivery is best-effort (never dead-letters).
 *
 * Fired at the START of an owner-driven `case.resume` pass — before the (slow) model call — so
 * the indicator appears while the owner is waiting. It is deliberately NOT fired for recovery or
 * implementer passes, where no owner is watching the thread.
 */
import { OutboxRepository, productionRuntime, type Database } from "@remoteagent/database";

import { DISCORD_OUTBOX_AGGREGATE, DISCORD_EVENT_TYPES } from "@remoteagent/discord";

export async function projectThinkingIndicator(input: {
  readonly db: Database;
  readonly caseId: string;
}): Promise<void> {
  const outbox = new OutboxRepository(productionRuntime());
  await input.db.withTransaction((tx) =>
    outbox.enqueue(tx, {
      aggregate: DISCORD_OUTBOX_AGGREGATE,
      aggregateId: input.caseId,
      eventType: DISCORD_EVENT_TYPES.THREAD_TYPING,
      payload: { case_id: input.caseId },
    }),
  );
}
