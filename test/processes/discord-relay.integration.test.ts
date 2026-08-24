/**
 * WU-03 (ADR-0009): the runnable discord process must relay the `discord_case` outbox aggregate
 * to Discord — and ONLY that aggregate. This lives in the root `test/processes` suite (not
 * apps/discord-bot/test) because it imports the cross-package DB harness, whose src files sit
 * outside the app's typecheck rootDir; the same reason the other process integration tests live
 * here. It drives the real composition root (`createDiscordProcess`) through the real
 * `discordOutboxSink`, with a fake dispatcher standing in for the gateway (the dispatcher's own
 * delivery is proven in packages/discord). A mutation to the relay wiring or its aggregate scope
 * breaks one of the two assertions below.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { type DiscordDispatcher } from "@remoteagent/discord";

// Import the repository from src so it shares the harness's `Database` brand; only the
// dist-typed `createDiscordProcess` boundary needs the `as never` bridge (CTF-013).
import { OutboxRepository, productionRuntime } from "../../packages/database/src/index.js";
import { createTestDatabase } from "../../packages/database/test/harness.js";
import { discordOutboxSink, type DiscordBot } from "../../apps/discord-bot/src/index.js";
import { createDiscordProcess } from "../../apps/discord-bot/src/discord.js";
import type { DiscordGatewaySession } from "../../apps/discord-bot/src/gateway-session.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
let drop: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});

afterEach(async () => {
  await drop();
});

it("the discord process relays only discord_case rows through discordOutboxSink", async () => {
  const outbox = new OutboxRepository(productionRuntime());
  const discordRow = await db.withTransaction((tx) =>
    outbox.enqueue(tx, {
      aggregate: "discord_case",
      aggregateId: "case-1",
      eventType: "discord.root_thread",
      payload: { case_id: "case-1" },
    }),
  );
  // A foreign aggregate the discord process must NEVER claim (it has no consumer here).
  const caseRow = await db.withTransaction((tx) =>
    outbox.enqueue(tx, {
      aggregate: "case",
      aggregateId: "case-1",
      eventType: "agent.completion.recorded",
      payload: { case_id: "case-1" },
    }),
  );

  const delivered: { eventType: string }[] = [];
  const fakeDispatcher = {
    deliver: async (message: { eventType: string }) => {
      delivered.push({ eventType: message.eventType });
      return { status: "delivered" as const };
    },
  } as unknown as DiscordDispatcher;
  const session = {
    start: () => undefined,
    stop: () => undefined,
  } as unknown as DiscordGatewaySession;
  const bot: DiscordBot = { outboxSink: discordOutboxSink(fakeDispatcher), session };

  const process = createDiscordProcess({ bot, db: db as never, relayIntervalMs: 20 });
  process.start();
  // Several relay passes; correct behaviour is stable regardless of exact count.
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.stopAcceptingWork();

  // The discord_case row was delivered via the real sink and marked PUBLISHED.
  expect(delivered.map((d) => d.eventType)).toEqual(["discord.root_thread"]);
  expect(await outbox.dispatchStatus(db, discordRow.outbox_id).then((s) => s!.status)).toBe(
    "PUBLISHED",
  );
  // The foreign aggregate was never claimed by the discord process: still PENDING, 0 attempts.
  expect(await outbox.dispatchStatus(db, caseRow.outbox_id)).toMatchObject({
    status: "PENDING",
    attempts: 0,
  });
});
