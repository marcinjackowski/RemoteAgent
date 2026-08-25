/**
 * CTF-020 regression: a case created the way the reconciler creates one has NO checkpoint, and
 * nothing in production ever wrote the first one — so the FIRST completion of any run on a fresh
 * case used to throw "has no checkpoint to advance", silently breaking the reply loop (RA-031/032)
 * and the implementer loop (RA-034). Every handler test masked it by seeding a revision-0 checkpoint
 * directly (`handlers.integration` seed(), line ~143).
 *
 * This drives the REAL `case.resume` handler on a fresh case with NO seeded checkpoint and asserts
 * the completion now persists: a revision-0 baseline is created lazily and the run advances 0 → 1.
 * The mutation check (revert `handlers.ts` to `throw`) turns this red.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  type Database,
  type JobLease,
} from "@remoteagent/database";
import { StructuredLogger } from "@remoteagent/observability";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";
import { createRoles } from "../src/roles.js";

let db: Database;
let drop: () => Promise<void>;

const FIXED_MS = Date.parse("2026-08-25T12:00:00.000Z");
const config = createRuntimeConfig({
  model: { provider: "bedrock", model_id: "test-model" },
  timeoutMs: 30_000,
  toolLimits: { maxIterations: 4, maxCalls: 8 },
});

const counters = new Map<string, number>();
const runtime = {
  clock: { now: () => FIXED_MS },
  ids: {
    next: (prefix?: string) => {
      const key = prefix ?? "id";
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return `${key}-${String(n)}`;
    },
  },
};

function completionJson(caseId: string, runId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    case_id: caseId,
    status: "COMPLETED",
    summary: "answered the owner",
    completed_steps: [],
    evidence: [],
    checkpoint_patch: {},
    next_actions: [],
  };
}

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
  counters.clear();
});
afterEach(async () => {
  await drop();
});

it("first completion on a fresh (checkpoint-less) case creates the baseline and persists (CTF-020)", async () => {
  // Exactly what the correlator + inbound-message produce: a case and a PENDING SUPERVISOR unit,
  // and NO checkpoint (the masked gap).
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
  await new WorkUnitRepository().insert(db, {
    workUnitId: "unit-1",
    caseId: "case-1",
    role: "SUPERVISOR",
    objective: "reply to the owner",
    authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
  });
  // Precondition: the fresh case genuinely has no checkpoint.
  const persistence = new WorkerPersistence(db, runtime);
  expect(await persistence.latestCheckpoint("case-1")).toBeNull();

  const handlers = createWorkerHandlers({
    persistence,
    roles: createRoles(["SUPERVISOR"], {
      transport: new FakeTransport([
        { model: config.model, content: [{ type: "json", value: completionJson("case-1", "run-1") }] },
      ]),
      config,
    }),
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
    db,
    jobs: new JobStore({ ...runtime, leaseTime: "injected" }),
  });

  const lease: JobLease = {
    jobId: "job-1",
    caseId: "case-1",
    jobType: "case.resume",
    payload: {},
    provider: null,
    serializationKey: "case-1",
    attempts: 0,
    maxAttempts: 10,
    fencingToken: 1,
    leaseExpiresAtMs: FIXED_MS + 60_000,
    leaseOwner: "worker-1",
  };
  // Before CTF-020 this threw "has no checkpoint to advance".
  await handlers["case.resume"]!(lease, async () => undefined);

  // The completion persisted...
  const completion = await db.query<{ case_id: string }>("SELECT case_id FROM run_completions");
  expect(completion.rows).toHaveLength(1);
  expect(completion.rows[0]?.case_id).toBe("case-1");
  // ...the baseline (revision 0) was created and the run advanced to revision 1...
  const revisions = await db.query<{ revision: number }>(
    "SELECT revision FROM case_checkpoints WHERE case_id = 'case-1' ORDER BY revision",
  );
  expect(revisions.rows.map((r) => r.revision)).toEqual([0, 1]);
  // ...and the case now points at the advanced revision.
  const caseRow = await db.query<{ checkpoint_revision: number }>(
    "SELECT checkpoint_revision FROM cases WHERE case_id = 'case-1'",
  );
  expect(caseRow.rows[0]?.checkpoint_revision).toBe(1);
});
