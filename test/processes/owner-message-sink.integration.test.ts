/**
 * RA-031 WU-04: the discord-bot's inbound outcome sink (`createOwnerMessageSink`, the exact handler
 * `createDiscordBotFromEnv` wires to `onInboundOutcome`) turns an owner `message` outcome into
 * durable work — a recorded message + a PENDING SUPERVISOR unit + a `case.resume` job — and ignores
 * every other outcome kind. In the root suite because it imports the cross-package DB harness.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  CaseRepository,
  ConnectionRepository,
  OwnerRepository,
} from "../../packages/database/src/index.js";
import { createTestDatabase } from "../../packages/database/test/harness.js";
import { createOwnerMessageSink } from "../../apps/discord-bot/src/env.js";

let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
let drop: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
  await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "o" });
  await new ConnectionRepository().insert(db, {
    connectionId: "conn-1",
    ownerId: "owner-1",
    provider: "jira",
    displayName: "c",
  });
  await new CaseRepository().insert(db, {
    caseId: "case-1",
    ownerId: "owner-1",
    status: "IMPLEMENTING",
    integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
    discordThreadId: "thread-1",
  });
});

afterEach(async () => {
  await drop();
});

it("a message outcome becomes a recorded message + PENDING SUPERVISOR unit + case.resume job", async () => {
  const sink = createOwnerMessageSink(db as never);
  await sink({
    kind: "message",
    caseId: "case-1",
    content: "please retry the failing test",
    trust: "UNTRUSTED_DATA",
    messageId: "disc-1",
  });

  expect((await db.query("SELECT 1 FROM case_messages WHERE case_id='case-1'")).rows).toHaveLength(
    1,
  );
  const unit = await db.query<{ role: string; status: string }>(
    "SELECT role, status FROM work_units WHERE case_id='case-1'",
  );
  expect(unit.rows).toEqual([{ role: "SUPERVISOR", status: "PENDING" }]);
  expect((await db.query("SELECT job_type FROM jobs WHERE case_id='case-1'")).rows).toEqual([
    { job_type: "case.resume" },
  ]);
});

it("ignores a non-message outcome (no work created)", async () => {
  const sink = createOwnerMessageSink(db as never);
  await sink({ kind: "ignored", reason: "message_outside_case_thread" });
  expect((await db.query("SELECT 1 FROM work_units WHERE case_id='case-1'")).rows).toHaveLength(0);
});
