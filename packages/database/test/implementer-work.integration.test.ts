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

it("atomically materializes a claimed IMPLEMENTER run and exact writer job", async () => {
  await seedCase();
  const r = await implementer.enqueueImplementerWork(db, { caseId: "case-1", repoId: "repo-1" });
  expect(r.status).toBe("accepted");
  if (r.status !== "accepted") {
    throw new Error(`expected accepted writer work, received ${r.status}`);
  }

  const unit = await db.query<{ role: string; status: string; run_id: string; scope: unknown }>(
    "SELECT role, status, run_id, authoritative_scope AS scope FROM work_units WHERE case_id='case-1'",
  );
  expect(unit.rows).toHaveLength(1);
  expect(unit.rows[0]).toMatchObject({
    role: "IMPLEMENTER",
    status: "DISPATCHED",
    run_id: r.runId,
  });
  const scope = unit.rows[0]!.scope as {
    can_write_workspace: boolean;
    repo_allowlist: string[];
    connection_ids: string[];
  };
  // Write scope is server-assigned, not model-supplied (AGENTS.md §4).
  expect(scope.can_write_workspace).toBe(true);
  expect(scope.repo_allowlist).toEqual(["repo-1"]);
  expect(scope.connection_ids).toEqual([]);

  const job = await db.query<{
    job_type: string;
    payload: { repoId?: string; workUnitId?: string; runId?: string };
  }>("SELECT job_type, payload FROM jobs WHERE case_id='case-1'");
  expect(job.rows).toHaveLength(1);
  expect(job.rows[0]!.job_type).toBe("agent.implementer");
  expect(job.rows[0]!.payload).toMatchObject({
    repoId: "repo-1",
    workUnitId: r.workUnitId,
    runId: r.runId,
  });
  expect(
    (await db.query("SELECT run_id FROM agent_runs WHERE work_unit_id=$1", [r.workUnitId])).rows,
  ).toEqual([{ run_id: r.runId }]);
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

it("rolls back the unit and claimed run when writer-job enqueue fails", async () => {
  await seedCase();
  await db.query(`CREATE FUNCTION ra_test_reject_writer_job() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fault after claim'; END $$`);
  await db.query(`CREATE TRIGGER ra_test_reject_writer_job
    BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION ra_test_reject_writer_job()`);

  await expect(
    implementer.enqueueImplementerWork(db, { caseId: "case-1", repoId: "repo-1" }),
  ).rejects.toThrow(/fault after claim/);
  expect((await db.query("SELECT 1 FROM work_units")).rows).toHaveLength(0);
  expect((await db.query("SELECT 1 FROM agent_runs")).rows).toHaveLength(0);
  expect((await db.query("SELECT 1 FROM jobs")).rows).toHaveLength(0);
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
