/**
 * RA-031 WU-02: receiveOwnerMessage — one transaction that records the owner message, materializes
 * a PENDING read-only SUPERVISOR unit, and enqueues case.resume; idempotent on message_id.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  CaseRepository,
  ConnectionRepository,
  Database,
  InboundMessageRepository,
  OwnerRepository,
  productionRuntime,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";

let db: Database;
let drop: () => Promise<void>;
const inbound = new InboundMessageRepository(productionRuntime());

async function seedCase(status = "IMPLEMENTING"): Promise<void> {
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
    status: status as never,
    integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
    discordThreadId: "thread-1",
  });
}

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});
afterEach(async () => {
  await drop();
});

it("records the message, materializes a PENDING SUPERVISOR unit, enqueues case.resume", async () => {
  await seedCase();
  const r = await inbound.receiveOwnerMessage(db, {
    messageId: "disc-1",
    caseId: "case-1",
    content: "please retry the failing test",
  });
  expect(r.status).toBe("accepted");

  const msg = await db.query("SELECT role, trust, body FROM case_messages WHERE case_id='case-1'");
  expect(msg.rows).toEqual([
    { role: "OWNER", trust: "UNTRUSTED_DATA", body: "please retry the failing test" },
  ]);
  const unit = await db.query<{ role: string; status: string; scope: unknown }>(
    "SELECT role, status, authoritative_scope AS scope FROM work_units WHERE case_id='case-1'",
  );
  expect(unit.rows).toHaveLength(1);
  expect(unit.rows[0]).toMatchObject({ role: "SUPERVISOR", status: "PENDING" });
  expect((unit.rows[0]!.scope as { can_write_workspace: boolean }).can_write_workspace).toBe(false);
  const job = await db.query("SELECT job_type FROM jobs WHERE case_id='case-1'");
  expect(job.rows).toEqual([{ job_type: "case.resume" }]);
});

it("is idempotent on message_id: a redelivered message creates no second unit or job", async () => {
  await seedCase();
  const input = { messageId: "dup", caseId: "case-1", content: "hi" };
  const first = await inbound.receiveOwnerMessage(db, input);
  const second = await inbound.receiveOwnerMessage(db, input);
  expect(first.status).toBe("accepted");
  expect(second.status).toBe("replayed");
  expect((await db.query("SELECT 1 FROM work_units WHERE case_id='case-1'")).rows).toHaveLength(1);
  expect((await db.query("SELECT 1 FROM jobs WHERE case_id='case-1'")).rows).toHaveLength(1);
});

it("ignores a message to a terminal case without creating work", async () => {
  await seedCase("DONE");
  const r = await inbound.receiveOwnerMessage(db, {
    messageId: "m",
    caseId: "case-1",
    content: "x",
  });
  expect(r).toEqual({ status: "ignored", reason: "case_DONE" });
  expect((await db.query("SELECT 1 FROM work_units WHERE case_id='case-1'")).rows).toHaveLength(0);
});
