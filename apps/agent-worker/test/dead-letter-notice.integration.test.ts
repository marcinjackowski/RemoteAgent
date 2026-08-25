/**
 * RA-036: when an owner-driven `case.resume` exhausts its attempts (dead-letters), the owner sees a
 * single user-safe error message in the thread instead of silence.
 *
 * Two layers:
 *  - `projectDeadLetterNotice` (WU-01): idempotent-on-job-id projection of the ⚠️ message; no thread
 *    → no-op; body carries no internals.
 *  - the `case.resume` handler (WU-02): enqueues the notice ONLY on the terminal attempt
 *    (`attempts >= maxAttempts`) of an owner-driven pass, then still throws so the job dead-letters.
 *
 * Mutation check: dropping the `attempts >= maxAttempts` gate turns the "non-terminal → none" case
 * red.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  DiscordBindingRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  type Database,
  type JobLease,
} from "@remoteagent/database";
import { StructuredLogger } from "@remoteagent/observability";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { DEAD_LETTER_NOTICE_BODY, projectDeadLetterNotice } from "../src/dead-letter-notice.js";
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
  if (withBinding) {
    await new DiscordBindingRepository().ensure(db, {
      caseId,
      ownerId: "owner-1",
      channelId: "chan-1",
    });
  }
}

// An empty transport makes every model call fail, so the SUPERVISOR unit ends the pass ambiguous
// and the handler throws — the failure path RA-036 reports.
function failingHandlers() {
  return createWorkerHandlers({
    persistence: new WorkerPersistence(db, runtime),
    roles: createRoles(["SUPERVISOR"], { transport: new FakeTransport([]), config }),
    logger: new StructuredLogger({ sink: { log: () => undefined } }),
    db,
    jobs: new JobStore({ ...runtime, leaseTime: "injected" }),
  });
}

function lease(caseId: string, attempts: number, maxAttempts: number): JobLease {
  return {
    jobId: "job-1",
    caseId,
    jobType: "case.resume",
    payload: { reason: "owner_message", messageId: "m1" },
    provider: null,
    serializationKey: caseId,
    attempts,
    maxAttempts,
    fencingToken: 1,
    leaseExpiresAtMs: FIXED_MS + 60_000,
    leaseOwner: "worker-1",
  };
}

async function errorMessages(caseId: string): Promise<{ body: string }[]> {
  const rows = await db.query<{ body: string; seq: string }>(
    `SELECT payload->>'body' AS body, payload->>'seq' AS seq FROM outbox
      WHERE event_type = 'discord.thread_message' AND payload->>'case_id' = $1
      ORDER BY created_at`,
    [caseId],
  );
  return rows.rows.map((r) => ({ body: r.body }));
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

it("projectDeadLetterNotice posts a user-safe message, idempotent on the job id (RA-036 WU-01)", async () => {
  await seedCase("case-1", true);

  expect(await projectDeadLetterNotice({ db, caseId: "case-1", jobId: "job-x" })).toBe(true);
  // A redelivery / re-claim must not post a second message.
  expect(await projectDeadLetterNotice({ db, caseId: "case-1", jobId: "job-x" })).toBe(true);

  const msgs = await errorMessages("case-1");
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.body).toBe(DEAD_LETTER_NOTICE_BODY);
  // AC2: nothing technical leaks to the owner.
  expect(msgs[0]!.body).not.toContain("job-x");
  expect(msgs[0]!.body.toLowerCase()).not.toContain("stack");
  expect(msgs[0]!.body).not.toContain("Error:");

  const recorded = await db.query(`SELECT 1 FROM case_messages WHERE message_id = 'error:job-x'`);
  expect(recorded.rows).toHaveLength(1);
});

it("a case with no Discord thread yields no notice (RA-036 WU-01)", async () => {
  await seedCase("case-1", false); // no binding
  expect(await projectDeadLetterNotice({ db, caseId: "case-1", jobId: "job-x" })).toBe(false);
  expect(await errorMessages("case-1")).toHaveLength(0);
});

it("the terminal attempt of an owner-driven resume posts the error and still throws (RA-036 WU-02)", async () => {
  await seedCase("case-1", true);
  const handlers = failingHandlers();
  await expect(
    handlers["case.resume"]!(lease("case-1", 10, 10), async () => undefined),
  ).rejects.toThrow(/did not complete its work/);
  expect(await errorMessages("case-1")).toHaveLength(1);
});

it("a non-terminal attempt throws WITHOUT posting an error (it will simply retry) (RA-036 WU-02)", async () => {
  await seedCase("case-1", true);
  const handlers = failingHandlers();
  await expect(
    handlers["case.resume"]!(lease("case-1", 0, 10), async () => undefined),
  ).rejects.toThrow(/did not complete its work/);
  expect(await errorMessages("case-1")).toHaveLength(0);
});
