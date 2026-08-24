/**
 * WU-02 (ADR-0009): the worker is a job processor, not an outbox deliverer. Its relay must be
 * scoped to claim NO aggregates, so a `discord_case` row — which only the discord-bot can
 * deliver — is never claimed and dead-lettered by the worker. This drives the REAL composition
 * root (`createWorkerProcess`), not a hand-built Scheduler, so it proves the wiring, not the
 * queue primitive (that is covered in packages/database queue tests).
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  Database,
  OutboxRepository,
  productionRuntime,
  type ClaimableDispatch,
} from "@remoteagent/database";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { createWorkerProcess } from "../src/worker.js";

let db: Database;
let drop: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});

afterEach(async () => {
  await drop();
});

it("worker relay never claims a discord_case row — it stays PENDING for the discord-bot", async () => {
  const runtime = productionRuntime();
  const outbox = new OutboxRepository(runtime);
  // No FK on outbox.aggregate_id, so a bare enqueue is enough; `db` leaseTime is the server
  // clock, so available_at is now and the row is immediately claimable by any relay.
  const row = await db.withTransaction((tx) =>
    outbox.enqueue(tx, {
      aggregate: "discord_case",
      aggregateId: "case-1",
      eventType: "discord.root_thread",
      payload: { case_id: "case-1" },
    }),
  );

  const process = createWorkerProcess({
    db,
    config: { port: 0, intervalMs: 20, owner: "test-worker", drainMs: 1000 },
    handlers: {},
    // The production sink throws on any aggregate. If the worker's relay were NOT scoped it
    // would claim the discord_case row and this would fire, retrying the row (attempts >= 1).
    sink: async (message: ClaimableDispatch): Promise<void> => {
      throw new Error(`worker must not receive ${message.aggregate}`);
    },
  });

  process.start();
  // Let many poll ticks run. Correct behaviour is that the row is never touched, so the count
  // of ticks does not matter; an unscoped relay would have claimed and retried it long ago.
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.stopAcceptingWork();
  await process.drain();

  // NOT process.close(): that closes `db`, which afterEach still needs to drop the schema.
  expect(await outbox.dispatchStatus(db, row.outbox_id)).toMatchObject({
    status: "PENDING",
    attempts: 0,
  });
});
