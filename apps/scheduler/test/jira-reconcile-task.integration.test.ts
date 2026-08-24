/**
 * WU-04 (ADR-0009): the scheduler task enqueues a `jira.reconcile` job per configured project,
 * and dedupes so a reconcile slower than the tick does not pile up duplicate scans. It calls no
 * provider — the reconciliation REST read runs in the worker (`createJiraReconcileRun`).
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { Database, JobStore, productionRuntime } from "@remoteagent/database";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { createJiraReconcileTask } from "../src/jira-reconcile-task.js";

let db: Database;
let drop: () => Promise<void>;
const jobs = new JobStore(productionRuntime());

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});

afterEach(async () => {
  await drop();
});

it("enqueues one jira.reconcile job per project and dedupes on re-run", async () => {
  const task = createJiraReconcileTask({
    db,
    jobs,
    projects: [{ ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" }],
  });

  await task.run();
  const first = await db.query<{ job_type: string; payload: { projectKey: string } }>(
    "SELECT job_type, payload FROM jobs WHERE job_type = 'jira.reconcile'",
  );
  expect(first.rows).toHaveLength(1);
  expect(first.rows[0]?.payload.projectKey).toBe("PROJ");

  // A second scan while the first job is still PENDING must NOT enqueue a duplicate.
  await task.run();
  const second = await db.query("SELECT job_id FROM jobs WHERE job_type = 'jira.reconcile'");
  expect(second.rows).toHaveLength(1);
});
