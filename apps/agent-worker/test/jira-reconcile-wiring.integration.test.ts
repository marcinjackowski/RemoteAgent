/**
 * WU-02/WU-03 (RA-030): the worker registers the `jira.reconcile` handler ONLY when Jira is
 * configured, and provisions the owner + connection the correlator needs — idempotently. Drives
 * `jiraReconcileHandlers` (the real composition helper `worker main()` calls), not a stub.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { Database, JobType, productionRuntime } from "@remoteagent/database";
import { StructuredLogger } from "@remoteagent/observability";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { jiraReconcileConfigFromEnv } from "../src/jira-auth.js";
import { jiraReconcileHandlers } from "../src/worker.js";

const ENV = {
  JIRA_ORIGIN: "https://acme.atlassian.net",
  JIRA_EMAIL: "me@example.com",
  JIRA_API_TOKEN: "secret-token",
  DISCORD_GUILD_ID: "guild-1",
  DISCORD_OWNER_ID: "owner-discord",
  DISCORD_CHANNEL_JIRA: "c-jira",
  DISCORD_CHANNEL_GMAIL_PRIVATE: "c-gmp",
  DISCORD_CHANNEL_GMAIL_SONDERMIND: "c-gms",
  DISCORD_CHANNEL_CALENDAR_PRIVATE: "c-cp",
  DISCORD_CHANNEL_CALENDAR_SONDERMIND: "c-cs",
  DISCORD_CHANNEL_GITLAB: "c-gl",
  DISCORD_CHANNEL_SYSTEM: "c-sys",
};

let db: Database;
let drop: () => Promise<void>;
const runtime = productionRuntime();
const logger = new StructuredLogger({ sink: { log: () => undefined } });

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
});
afterEach(async () => {
  await drop();
});

it("registers no handler and provisions nothing when Jira is not configured", async () => {
  const handlers = await jiraReconcileHandlers({
    db,
    runtime,
    logger,
    config: jiraReconcileConfigFromEnv({}),
  });
  expect(handlers[JobType.JIRA_RECONCILE]).toBeUndefined();
  const conns = await db.query("SELECT connection_id FROM connections");
  expect(conns.rows).toHaveLength(0);
});

it("registers the handler and idempotently provisions the owner + jira connection", async () => {
  const config = jiraReconcileConfigFromEnv(ENV);
  const first = await jiraReconcileHandlers({ db, runtime, logger, config });
  expect(typeof first[JobType.JIRA_RECONCILE]).toBe("function");

  const conn = await db.query<{ provider: string; owner_id: string; alias: string }>(
    "SELECT provider, owner_id, alias FROM connections WHERE connection_id = 'connection-local-jira'",
  );
  expect(conn.rows).toEqual([{ provider: "jira", owner_id: "owner-local", alias: "private" }]);

  // A second start must not duplicate or throw — single-owner workers restart freely.
  await jiraReconcileHandlers({ db, runtime, logger, config });
  const after = await db.query("SELECT connection_id FROM connections");
  expect(after.rows).toHaveLength(1);
});
