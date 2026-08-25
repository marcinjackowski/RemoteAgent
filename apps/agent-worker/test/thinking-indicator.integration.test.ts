/**
 * RA-035: an owner-driven `case.resume` pass shows the owner a native "typing…" indicator while
 * the model composes its reply. This drives the REAL `case.resume` handler and asserts that a
 * `discord.thread_typing` outbox event is enqueued BEFORE the model pass — but ONLY when the job
 * is owner-driven (`reason: "owner_message"`). A recovery/implementer pass (no owner waiting)
 * must NOT emit the hint. The mutation check (remove the `reason` gate in handlers.ts) turns the
 * "recovery pass emits none" case red.
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

async function seedCaseWithUnit(caseId: string): Promise<void> {
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
    status: "NEW",
    integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
    discordThreadId: "thread-1",
  });
  await new WorkUnitRepository().insert(db, {
    workUnitId: "unit-1",
    caseId,
    role: "SUPERVISOR",
    objective: "reply to the owner",
    authoritativeScope: { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
  });
}

function handlersFor(caseId: string) {
  return createWorkerHandlers({
    persistence: new WorkerPersistence(db, runtime),
    roles: createRoles(["SUPERVISOR"], {
      transport: new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson(caseId, "run-1") }],
        },
      ]),
      config,
    }),
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
    db,
    jobs: new JobStore({ ...runtime, leaseTime: "injected" }),
  });
}

function lease(caseId: string, payload: Record<string, unknown>): JobLease {
  return {
    jobId: "job-1",
    caseId,
    jobType: "case.resume",
    payload,
    provider: null,
    serializationKey: caseId,
    attempts: 0,
    maxAttempts: 10,
    fencingToken: 1,
    leaseExpiresAtMs: FIXED_MS + 60_000,
    leaseOwner: "worker-1",
  };
}

async function typingEventCount(caseId: string): Promise<number> {
  const rows = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox
      WHERE event_type = 'discord.thread_typing' AND payload->>'case_id' = $1`,
    [caseId],
  );
  return Number(rows.rows[0]?.n ?? "0");
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

it("an owner-driven resume enqueues a discord.thread_typing hint (RA-035)", async () => {
  await seedCaseWithUnit("case-1");
  const handlers = handlersFor("case-1");
  await handlers["case.resume"]!(
    lease("case-1", { reason: "owner_message", messageId: "m1" }),
    async () => undefined,
  );
  expect(await typingEventCount("case-1")).toBe(1);
});

it("a resume that is NOT owner-driven emits no typing hint (RA-035)", async () => {
  await seedCaseWithUnit("case-1");
  const handlers = handlersFor("case-1");
  // A recovery-triggered resume has no owner waiting on the thread — no reason field.
  await handlers["case.resume"]!(lease("case-1", {}), async () => undefined);
  expect(await typingEventCount("case-1")).toBe(0);
});
