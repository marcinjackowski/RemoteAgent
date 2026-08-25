/**
 * CTF-020: CheckpointRepository.ensureBaseline creates a case's missing revision-0 baseline
 * checkpoint, idempotently, WITHOUT bumping cases.checkpoint_revision (so a run claimed at 0 stays
 * aligned with apply()'s `run.checkpoint_revision === checkpoint.revision - 1`).
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";

let db: Database;
let drop: () => Promise<void>;
const checkpoints = new CheckpointRepository();

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

it("creates a revision-0 baseline without bumping the case revision, idempotently", async () => {
  const first = await db.withTransaction((tx) =>
    checkpoints.ensureBaseline(tx, { caseId: "case-1", updatedAt: "2026-08-25T00:00:00.000Z" }),
  );
  expect(first.revision).toBe(0);
  expect(first.case_id).toBe("case-1");

  // A second call is a no-op: still exactly one row, still revision 0.
  await db.withTransaction((tx) =>
    checkpoints.ensureBaseline(tx, { caseId: "case-1", updatedAt: "2026-08-25T01:00:00.000Z" }),
  );

  const rows = await db.query<{ revision: number }>(
    "SELECT revision FROM case_checkpoints WHERE case_id = 'case-1' ORDER BY revision",
  );
  expect(rows.rows.map((r) => r.revision)).toEqual([0]);

  // The case revision counter is untouched — the run was claimed at 0 and must stay aligned.
  const caseRow = await db.query<{ checkpoint_revision: number }>(
    "SELECT checkpoint_revision FROM cases WHERE case_id = 'case-1'",
  );
  expect(caseRow.rows[0]?.checkpoint_revision).toBe(0);

  // latest() now returns the baseline, so the completion path no longer sees null.
  const latest = await checkpoints.latest(db, "case-1");
  expect(latest?.revision).toBe(0);
});
