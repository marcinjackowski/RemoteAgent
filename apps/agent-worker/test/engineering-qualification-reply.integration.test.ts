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
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";
import { createRoles } from "../src/roles.js";

const available = await ensurePostgres();
const FIXED_MS = Date.parse("2026-08-26T12:00:00.000Z");
const config = createRuntimeConfig({
  model: { provider: "bedrock", model_id: "qualification-model" },
  timeoutMs: 30_000,
  toolLimits: { maxIterations: 4, maxCalls: 8 },
});

describeIntegration(
  "RA-044 conversational reply-loop qualification",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const counters = new Map<string, number>();
    const runtime = {
      clock: { now: () => FIXED_MS },
      ids: {
        next: (prefix?: string) => {
          const key = prefix ?? "id";
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return `${key}-${String(next)}`;
        },
      },
    };

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      counters.clear();
    });

    afterEach(async () => {
      await drop();
    });

    it("preserves the legacy AgentCompletion reply path without constructing an engineering runtime", async () => {
      await new OwnerRepository().insert(db, { ownerId: "owner-reply", displayName: "Owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "connection-reply",
        ownerId: "owner-reply",
        provider: "jira",
        displayName: "Jira",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-reply",
        ownerId: "owner-reply",
        status: "NEW",
        integrationScope: {
          providers: ["jira"],
          connection_ids: ["connection-reply"],
        },
        discordThreadId: "thread-reply",
      });
      await db.query(
        `INSERT INTO discord_case_bindings
           (case_id, owner_id, channel_id, thread_id, next_seq, delivered_seq)
         VALUES ('case-reply', 'owner-reply', 'channel-reply', 'thread-reply', 1, 0)`,
      );
      await new WorkUnitRepository().insert(db, {
        workUnitId: "unit-reply",
        caseId: "case-reply",
        role: "SUPERVISOR",
        objective: "Reply directly to the owner",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: [],
          can_write_workspace: false,
        },
      });

      const completion = {
        schema_version: 1,
        run_id: "run-1",
        case_id: "case-reply",
        status: "COMPLETED",
        summary: "I checked the issue and the reply loop is healthy.",
        completed_steps: [],
        evidence: [],
        checkpoint_patch: {},
        next_actions: [],
      };
      const transport = new FakeTransport([
        { model: config.model, content: [{ type: "json", value: completion }] },
      ]);
      let engineeringFactoryCalls = 0;
      const persistence = new WorkerPersistence(db, runtime);
      const handlers = createWorkerHandlers({
        persistence,
        roles: createRoles(["SUPERVISOR"], { transport, config }),
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
        db,
        jobs: new JobStore({ ...runtime, leaseTime: "injected" }),
        engineering: () => {
          engineeringFactoryCalls += 1;
          throw new Error("conversational case.resume entered the engineering path");
        },
      });
      const lease: JobLease = {
        jobId: "job-reply",
        caseId: "case-reply",
        jobType: "case.resume",
        payload: { reason: "owner_message", messageId: "owner-message-1" },
        provider: null,
        serializationKey: "case-reply",
        attempts: 0,
        maxAttempts: 10,
        fencingToken: 1,
        leaseExpiresAtMs: FIXED_MS + 60_000,
        leaseOwner: "worker-reply",
      };

      // This is the production handler and SupervisorRuntime route. Only the model provider is
      // scripted; an accidentally parallel engineering route fails immediately above.
      await handlers["case.resume"]!(lease, async () => undefined);

      expect(transport.requests).toHaveLength(1);
      expect(engineeringFactoryCalls).toBe(0);
      expect(
        (
          await db.query<{
            status: string;
            completion: typeof completion;
          }>("SELECT status, completion FROM run_completions WHERE run_id = 'run-1'")
        ).rows,
      ).toEqual([{ status: "COMPLETED", completion }]);

      const checkpoints = await db.query<{ revision: number; last_run_id: string | null }>(
        `SELECT revision, last_run_id
         FROM case_checkpoints WHERE case_id = 'case-reply' ORDER BY revision`,
      );
      expect(checkpoints.rows).toEqual([
        { revision: 0, last_run_id: null },
        { revision: 1, last_run_id: "run-1" },
      ]);
      expect(
        (
          await db.query<{ checkpoint_revision: number; active_run_id: string | null }>(
            `SELECT checkpoint_revision, active_run_id
             FROM cases WHERE case_id = 'case-reply'`,
          )
        ).rows,
      ).toEqual([{ checkpoint_revision: 1, active_run_id: null }]);

      const outbox = await db.query<{
        aggregate: string;
        event_type: string;
        payload: { body?: string; case_id?: string; seq?: number };
      }>(
        `SELECT aggregate, event_type, payload
         FROM outbox WHERE aggregate_id = 'case-reply' ORDER BY created_at, outbox_id`,
      );
      expect(
        outbox.rows
          .map((row) => [row.aggregate, row.event_type])
          .sort(([leftAggregate, leftType], [rightAggregate, rightType]) =>
            `${leftAggregate}:${leftType}`.localeCompare(`${rightAggregate}:${rightType}`),
          ),
      ).toEqual([
        ["case", "agent.completion.recorded"],
        ["discord_case", "discord.thread_message"],
        ["discord_case", "discord.thread_typing"],
      ]);
      expect(
        outbox.rows.find((row) => row.event_type === "discord.thread_message")?.payload,
      ).toMatchObject({ case_id: "case-reply", seq: 1, body: completion.summary });
      expect(
        (
          await db.query<{ role: string; trust: string; body: string }>(
            `SELECT role, trust, body FROM case_messages
             WHERE message_id = 'reply:run-1'`,
          )
        ).rows,
      ).toEqual([{ role: "AGENT", trust: "TRUSTED", body: completion.summary }]);

      const engineeringRows = await db.query<{
        operations: string;
        artifacts: string;
        events: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations) AS operations,
           (SELECT count(*)::text FROM engineering_artifact_revisions) AS artifacts,
           (SELECT count(*)::text FROM engineering_stage_events) AS events`,
      );
      expect(engineeringRows.rows).toEqual([{ operations: "0", artifacts: "0", events: "0" }]);
    });
  },
  available,
);
