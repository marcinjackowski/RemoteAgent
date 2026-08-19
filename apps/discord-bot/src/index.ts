/**
 * @remoteagent/discord-bot — composition root for the Discord case interface
 * (RA-006).
 *
 * The domain logic lives in `@remoteagent/discord`; this app wires it into a
 * RUNNABLE bot: an outbound {@link OutboxSink} that drives the {@link DiscordDispatcher}
 * from the transactional outbox relay (RA-004), and an inbound gateway session
 * ({@link DiscordGatewaySession}) that authorizes, durably audits and routes owner
 * interactions. The concrete REST/gateway transports are injected so the whole
 * thing is exercised without a live connection or a real token.
 */
import type { ClaimableDispatch, OutboxSink } from "@remoteagent/database";
import {
  DISCORD_OUTBOX_AGGREGATE,
  DiscordDeferredError,
  type DiscordDispatcher,
  type InboundProcessorDeps,
  type InteractionAcknowledger,
  type IntakeOutcome,
} from "@remoteagent/discord";

import { createInboundDispatchHandler, type DispatchMapConfig } from "./lifecycle.js";
import { DiscordGatewaySession, type GatewaySessionDeps } from "./gateway-session.js";

export const appName = "discord-bot" as const;

export * from "./intents.js";
export * from "./rest-gateway.js";
export * from "./fetch-transport.js";
export * from "./gateway-session.js";
export * from "./ws-factory.js";
export * from "./lifecycle.js";
export * from "./env.js";

/**
 * Adapt a {@link DiscordDispatcher} into an outbox {@link OutboxSink}.
 *
 * The relay only hands us messages for the Discord aggregate; anything else is a
 * routing bug and throws. A {@link DiscordDeferredError} (an out-of-order ordered
 * send) is rethrown so the relay retries the slot on a later pass rather than
 * dropping it — the message stays PENDING and its order is preserved.
 */
export function discordOutboxSink(dispatcher: DiscordDispatcher): OutboxSink {
  return async (message: ClaimableDispatch): Promise<void> => {
    if (message.aggregate !== DISCORD_OUTBOX_AGGREGATE) {
      throw new Error(`discord-bot received a non-discord outbox message: ${message.aggregate}`);
    }
    await dispatcher.deliver({
      outboxId: message.outbox_id,
      eventType: message.event_type,
      payload: message.payload,
    });
  };
}

export interface DiscordBot {
  /** Feed this to the outbox relay to publish case events to Discord. */
  outboxSink: OutboxSink;
  /** The inbound gateway session; call `start()` to connect, `stop()` to shut down. */
  session: DiscordGatewaySession;
}

/**
 * Compose a runnable Discord bot from its already-built parts. Outbound goes
 * through the dispatcher; inbound gateway dispatches are authorized + durably
 * audited (content-free) and routed via {@link createInboundDispatchHandler}. The
 * gateway/REST transports are supplied by the caller (deployment), so this stays
 * free of any live connection.
 */
export function createDiscordBot(deps: {
  dispatcher: DiscordDispatcher;
  processor: InboundProcessorDeps;
  map: DispatchMapConfig;
  session: Omit<GatewaySessionDeps, "onDispatch">;
  /** Acknowledges inbound interactions (deferred) within Discord's window. */
  acknowledger?: InteractionAcknowledger;
  onInboundOutcome?: (outcome: IntakeOutcome) => void | Promise<void>;
  logger?: (event: string, detail?: Record<string, unknown>) => void;
}): DiscordBot {
  const onDispatch = createInboundDispatchHandler(deps.processor, deps.map, {
    ...(deps.onInboundOutcome !== undefined ? { onOutcome: deps.onInboundOutcome } : {}),
    ...(deps.acknowledger !== undefined ? { acknowledger: deps.acknowledger } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  });
  const session = new DiscordGatewaySession({ ...deps.session, onDispatch });
  return { outboxSink: discordOutboxSink(deps.dispatcher), session };
}

export { DiscordDeferredError };
