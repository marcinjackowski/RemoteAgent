/**
 * RA-034 WU-01: enqueueImplementerWork — one transaction that materializes a PENDING IMPLEMENTER
 * unit (the sole workspace writer) with server-assigned write scope, and enqueues the
 * `agent.implementer` job. Single-writer guarded and terminal-case aware.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  CaseRepository,
  ConnectionRepository,
  Database,
  ImplementerWorkRepository,
  OwnerRepository,
  productionRuntime,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";

let db: Database;
let drop: () => Promise<void>;
const implementer = new ImplementerWorkRepository(productionRuntime());

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

it("materializes a PENDING IMPLEMENTER unit with write scope and enqueues agent.implementer", async () => {
  await seedCase();
  const r = await implementer.enqueueImplementerWork(db, { caseId: "case-1", repoId: "repo-1" });
  expect(r.status).toBe("accepted");

  const unit = await db.query<{ role: string; status: string; scope: unknown }>(
    "SELECT role, status, authoritative_scope AS scope FROM work_units WHERE case_id='case-1'",
  );
  expect(unit.rows).toHaveLength(1);
  expect(unit.rows[0]).toMatchObject({ role: "IMPLEMENTER", status: "PENDING" });
  const scope = unit.rows[0]!.scope as {
    can_write_workspace: boolean;
    repo_allowlist: string[];
    connection_ids: string[];
  };
  // Write scope is server-assigned, not model-supplied (AGENTS.md §4).
  expect(scope.can_write_workspace).toBe(true);
  expect(scope.repo_allowlist).toEqual(["repo-1"]);
  expect(scope.connection_ids).toEqual([]);

  const job = await db.query<{ job_type: string; payload: { repoId?: string } }>(
    "SELECT job_type, payload FROM jobs WHERE case_id='case-1'",
  );
  expect(job.rows).toHaveLength(1);
  expect(job.rows[0]!.job_type).toBe("agent.implementer");
  expect(job.rows[0]!.payload.repoId).toBe("repo-1");
});

it("refuses a second writer for the same case (single-writer, AGENTS.md §7)", async () => {
  await seedCase();
  const first = await implementer.enqueueImplementerWork(db, {
    caseId: "case-1",
    repoId: "repo-1",
  });
  expect(first.status).toBe("accepted");

  const second = await implementer.enqueueImplementerWork(db, {
    caseId: "case-1",
    repoId: "repo-1",
  });
  expect(second).toEqual({ status: "ignored", reason: "writer_active" });

  // No second unit and no second job were created.
  const units = await db.query("SELECT 1 FROM work_units WHERE case_id='case-1'");
  expect(units.rows).toHaveLength(1);
  const jobs = await db.query("SELECT 1 FROM jobs WHERE case_id='case-1'");
  expect(jobs.rows).toHaveLength(1);
});

it("ignores a terminal case", async () => {
  await seedCase("DONE");
  const r = await implementer.enqueueImplementerWork(db, { caseId: "case-1", repoId: "repo-1" });
  expect(r).toEqual({ status: "ignored", reason: "case_DONE" });
  const units = await db.query("SELECT 1 FROM work_units WHERE case_id='case-1'");
  expect(units.rows).toHaveLength(0);
});

it("ignores an unknown case", async () => {
  const r = await implementer.enqueueImplementerWork(db, { caseId: "nope", repoId: "repo-1" });
  expect(r).toEqual({ status: "ignored", reason: "case_not_found" });
});
