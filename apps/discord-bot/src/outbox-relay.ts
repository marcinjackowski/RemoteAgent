/**
 * Outbound outbox relay loop for the discord-bot process (RA-029 / ADR-0009).
 *
 * The discord-bot is the only process that can deliver Discord messages, so it is the process
 * that must relay the `discord_case` outbox aggregate. This is a RELAY-ONLY loop: no job
 * claiming and no lease reaping — those belong to the worker's `Scheduler`. Scoping the claim
 * to a set of aggregates (ADR-0009) is what lets this loop coexist with the worker's relay
 * without the two contending over rows neither `SKIP LOCKED` nor a narrow sink could otherwise
 * separate.
 *
 * Self-healing: `relayOnce` reclaims rows whose lease expired, so a crash mid-publish leaves
 * the row recoverable on the next pass. A sink failure (including a `DiscordDeferredError` for
 * an out-of-order ordered send) is handled inside `relayOnce` as a bounded retry; only a
 * DB-level relay failure reaches `onError`, which logs and continues — a single bad pass must
 * not kill the loop.
 */
import {
  OutboxRepository,
  productionRuntime,
  type Database,
  type OutboxSink,
} from "@remoteagent/database";

export interface OutboxRelayHandle {
  /** Stop the loop. Idempotent; a pass already in flight is not interrupted. */
  stop: () => void;
}

export function startOutboxRelay(input: {
  db: Database;
  sink: OutboxSink;
  aggregates: readonly string[];
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): OutboxRelayHandle {
  const outbox = new OutboxRepository(productionRuntime());
  const intervalMs = input.intervalMs ?? 1_000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const loop = async (): Promise<void> => {
    if (!running) return;
    try {
      await outbox.relayOnce(input.db, input.sink, { aggregates: input.aggregates });
    } catch (error) {
      input.onError?.(error);
    } finally {
      if (running) timer = setTimeout(() => void loop(), intervalMs);
    }
  };

  timer = setTimeout(() => void loop(), intervalMs);

  return {
    stop: () => {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
