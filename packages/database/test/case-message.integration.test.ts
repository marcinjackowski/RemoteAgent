/**
 * RA-031 WU-01: CaseMessageRepository over the (pre-existing, migration-003) `case_messages`
 * table — append + listRecent + idempotency on message_id.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  CaseMessageRepository,
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";

let db: Database;
let drop: () => Promise<void>;
const messages = new CaseMessageRepository();

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
    status: "NEW",
    integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
    discordThreadId: "thread-1",
  });
});

afterEach(async () => {
  await drop();
});

it("appends messages and lists them oldest-first with roles and trust", async () => {
  await db.withTransaction(async (tx) => {
    await messages.append(tx, {
      messageId: "m1",
      caseId: "case-1",
      role: "OWNER",
      trust: "UNTRUSTED_DATA",
      body: "looks good, proceed",
    });
    await messages.append(tx, {
      messageId: "m2",
      caseId: "case-1",
      role: "AGENT",
      trust: "TRUSTED",
      body: "on it",
    });
  });

  const recent = await messages.listRecent(db, "case-1", 10);
  expect(recent.map((m) => [m.message_id, m.role, m.trust, m.body])).toEqual([
    ["m1", "OWNER", "UNTRUSTED_DATA", "looks good, proceed"],
    ["m2", "AGENT", "TRUSTED", "on it"],
  ]);
});

it("is idempotent on message_id — a replayed delivery does not duplicate", async () => {
  const once = (id: string) =>
    db.withTransaction((tx) =>
      messages.append(tx, {
        messageId: id,
        caseId: "case-1",
        role: "OWNER",
        trust: "UNTRUSTED_DATA",
        body: "hello",
      }),
    );
  await once("dup");
  await once("dup"); // replay
  const recent = await messages.listRecent(db, "case-1");
  expect(recent).toHaveLength(1);
});
