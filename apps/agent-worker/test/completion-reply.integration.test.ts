/**
 * RA-032 WU-05: projectCompletionReply turns an agent completion into a discord_case thread_message
 * (delivered by the RA-029 relay) + an AGENT conversation entry, ordered by a reserved per-case seq,
 * idempotent on the run id, and a no-op when the case has no Discord thread.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
} from "@remoteagent/database";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { projectCompletionReply } from "../src/completion-reply.js";

let db: Database;
let drop: () => Promise<void>;

async function seedCase(caseId: string, withBinding: boolean): Promise<void> {
  await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "o" });
  await new ConnectionRepository().insert(db, {
    connectionId: "conn-1",
    ownerId: "owner-1",
    provider: "jira",
    displayName: "c",
  });
  await new CaseRepository().insert(db, {
    caseId,
    ownerId: "owner-1",
    status: "IMPLEMENTING",
    integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
    discordThreadId: `thread-${caseId}`,
  });
  if (withBinding) {
    await db.query(
      `INSERT INTO discord_case_bindings (case_id, owner_id, channel_id, thread_id, next_seq, delivered_seq)
       VALUES ($1, 'owner-1', 'c-jira', 'thread-x', 1, 0)`,
      [caseId],
    );
  }
}

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});
afterEach(async () => {
  await drop();
});

it("enqueues a discord_case thread_message + AGENT message; idempotent on run id", async () => {
  await seedCase("case-1", true);
  const first = await projectCompletionReply({
    db,
    caseId: "case-1",
    runId: "run-1",
    body: "I retried the test; it passes now.",
  });
  expect(first).toBe(true);

  const outbox = await db.query<{ event_type: string; payload: { body: string; seq: number } }>(
    "SELECT event_type, payload FROM outbox WHERE aggregate='discord_case' AND aggregate_id='case-1'",
  );
  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0]!.event_type).toBe("discord.thread_message");
  expect(outbox.rows[0]!.payload.body).toBe("I retried the test; it passes now.");
  expect(typeof outbox.rows[0]!.payload.seq).toBe("number");
  const msg = await db.query<{ role: string; trust: string }>(
    "SELECT role, trust FROM case_messages WHERE case_id='case-1'",
  );
  expect(msg.rows).toEqual([{ role: "AGENT", trust: "TRUSTED" }]);

  // Same run id again: idempotent — no second thread_message.
  const second = await projectCompletionReply({
    db,
    caseId: "case-1",
    runId: "run-1",
    body: "dup",
  });
  expect(second).toBe(true);
  expect((await db.query("SELECT 1 FROM outbox WHERE aggregate='discord_case'")).rows).toHaveLength(
    1,
  );
});

it("is a no-op (false) when the case has no Discord binding", async () => {
  await seedCase("case-2", false);
  const posted = await projectCompletionReply({ db, caseId: "case-2", runId: "r", body: "hi" });
  expect(posted).toBe(false);
  expect((await db.query("SELECT 1 FROM outbox WHERE aggregate='discord_case'")).rows).toHaveLength(
    0,
  );
});
