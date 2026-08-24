/**
 * WU-04 (ADR-0009): the `jira.reconcile` worker run polls a project and correlates each changed
 * issue into a case — producing the `discord_case` outbox row the discord-bot relay delivers.
 * This closes the seam `scripts/dev/jira-poll.ts` left open (its `applyIssue` only printed).
 *
 * The `search` client is injected (an inline stub here; a real `JiraRestClient` in production),
 * so this proves the reconcile → correlate → outbox composition without a live Jira or a token.
 * The decisive assertion is the `discord_case` root_thread outbox row: if `applyIssue` did not
 * call correlation, the reconciler would still advance its watermark but produce no such row.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ConnectionRepository,
  Database,
  OwnerRepository,
  type JobLease,
} from "@remoteagent/database";
import { ChannelRegistry } from "@remoteagent/discord";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import { createJiraReconcileRun } from "../src/jira-reconcile.js";

let db: Database;
let drop: () => Promise<void>;

const channels = new ChannelRegistry({
  guildId: "guild",
  ownerId: "owner-1",
  channels: {
    jira: "jira-channel",
    "gmail-private": "gmail-private",
    "gmail-sondermind": "gmail-sondermind",
    "calendar-private": "calendar-private",
    "calendar-sondermind": "calendar-sondermind",
    gitlab: "gitlab",
    system: "system",
  },
});

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.db;
  drop = created.drop;
  await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
  await new ConnectionRepository().insert(db, {
    connectionId: "conn-1",
    ownerId: "owner-1",
    provider: "jira",
    alias: "private",
    displayName: "jira",
  });
});

afterEach(async () => {
  await drop();
});

it("reconcile run correlates a changed issue into a case and enqueues a discord_case row", async () => {
  let idCounter = 0;
  const search = {
    searchJql: async () => [
      {
        id: "10001",
        key: "PROJ-1",
        fields: {
          project: { key: "PROJ" },
          summary: { trust: "UNTRUSTED_DATA", value: "Do the thing" },
          status: { trust: "UNTRUSTED_DATA", value: "In Progress" },
          description: { trust: "UNTRUSTED_DATA", value: "Full context of the task." },
          labels: [],
          updated: "2026-08-23T21:00:00.000Z",
        },
      },
    ],
  };
  const run = createJiraReconcileRun({
    db,
    search,
    channelRegistry: channels,
    ids: {
      caseId: () => `case-${++idCounter}`,
      entityId: () => `entity-${idCounter}`,
      outboxId: () => `outbox-${idCounter}`,
    },
    now: () => "2026-08-23T21:30:00.000Z",
  });

  await run({
    payload: { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" },
  } as unknown as JobLease);

  // The issue became a case...
  const cases = await db.query<{ case_id: string }>("SELECT case_id FROM cases");
  expect(cases.rows).toHaveLength(1);
  // ...and produced a discord_case root_thread outbox row routed to the jira channel.
  const outbox = await db.query<{ aggregate: string; event_type: string }>(
    "SELECT aggregate, event_type FROM outbox",
  );
  expect(outbox.rows).toEqual([{ aggregate: "discord_case", event_type: "discord.root_thread" }]);
  const binding = await db.query<{ channel_id: string }>(
    "SELECT channel_id FROM discord_case_bindings",
  );
  expect(binding.rows[0]?.channel_id).toBe("jira-channel");

  // RA-033: the issue itself is recorded into the case transcript as UNTRUSTED SYSTEM context, so
  // the SUPERVISOR (which reads case_messages, not the Discord outbox) sees what the task is.
  const messages = await db.query<{ role: string; trust: string; body: string }>(
    "SELECT role, trust, body FROM case_messages",
  );
  expect(messages.rows).toHaveLength(1);
  const context = messages.rows[0]!;
  expect(context.role).toBe("SYSTEM");
  // The trust MARKING is the load-bearing security property (AGENTS.md §5). Mutation check:
  // flipping this to 'TRUSTED' in `jira-reconcile.ts` turns this assertion red.
  expect(context.trust).toBe("UNTRUSTED_DATA");
  expect(context.body).toContain("Jira issue PROJ-1");
  expect(context.body).toContain("Status: In Progress");
  expect(context.body).toContain("Summary: Do the thing");
  expect(context.body).toContain("Description: Full context of the task.");
});

it("does not duplicate the issue context turn when the same issue is reconciled again", async () => {
  let idCounter = 0;
  const search = {
    searchJql: async () => [
      {
        id: "10001",
        key: "PROJ-1",
        fields: {
          project: { key: "PROJ" },
          summary: { trust: "UNTRUSTED_DATA", value: "Do the thing" },
          status: { trust: "UNTRUSTED_DATA", value: "In Progress" },
          labels: [],
          // Same `updated` on both runs → same correlation eventId → the second run is a replay.
          updated: "2026-08-23T21:00:00.000Z",
        },
      },
    ],
  };
  const run = createJiraReconcileRun({
    db,
    search,
    channelRegistry: channels,
    ids: {
      caseId: () => `case-${++idCounter}`,
      entityId: () => `entity-${idCounter}`,
      outboxId: () => `outbox-${idCounter}`,
    },
    now: () => "2026-08-23T21:30:00.000Z",
  });

  const lease = {
    payload: { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" },
  } as unknown as JobLease;
  await run(lease);
  await run(lease);

  const messages = await db.query<{ message_id: string }>("SELECT message_id FROM case_messages");
  expect(messages.rows).toHaveLength(1);
});
