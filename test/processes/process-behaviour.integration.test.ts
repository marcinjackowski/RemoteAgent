import { canonicalDigest } from "@remoteagent/contracts";
import {
  CaseRepository,
  ConnectionRepository,
  JobStore,
  OwnerRepository,
  SystemClock,
  WorkUnitRepository,
} from "@remoteagent/database";
import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import type { Database as ProductionDatabase } from "@remoteagent/database";
import { StructuredLogger } from "@remoteagent/observability";
import { afterEach, expect, it } from "vitest";

import {
  bootstrapExecutor,
  executorConfigFromEnv,
} from "../../apps/action-executor/src/executor.js";
import { probe, probeOptionsFromEnv } from "../../apps/agent-worker/src/health.js";
import { bootstrapWorker, workerConfigFromEnv } from "../../apps/agent-worker/src/worker.js";
import { createWorkerHandlers } from "../../apps/agent-worker/src/handlers.js";
import { WorkerPersistence } from "../../apps/agent-worker/src/persistence.js";
import { createRoles } from "../../apps/agent-worker/src/roles.js";
import { bootstrapIngress, ingressConfigFromEnv } from "../../apps/ingress-api/src/ingress.js";
import { bootstrapScheduler, schedulerConfigFromEnv } from "../../apps/scheduler/src/scheduler.js";
import { makeCheckpoint } from "../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();

/**
 * Per-process behaviour (RA-027-WU-04..WU-07).
 *
 * WHY THIS SUITE EXISTS. The first RA-027 mutation run left TWELVE survivors, and the
 * pattern was uniform: `lifecycle.integration.test.ts` proved every process starts, serves
 * health and stops — which is genuinely what AC1 asks — while asserting nothing about what
 * each process actually DOES. So mutations that made the executor pick up `AMBIGUOUS`
 * actions, removed the ingress body limit, or let scheduler ticks stack all stayed green.
 *
 * "It starts and stops" is a real property and an insufficient one. These are the
 * process-specific properties whose failure is silent.
 */
const started: { shutdown(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const runtime of started.splice(0)) await runtime.shutdown();
});

async function teardown(
  runtime: { shutdown(): Promise<unknown> },
  drop: () => Promise<void>,
): Promise<void> {
  await runtime.shutdown();
  await drop().catch((error: unknown) => {
    if (!/end on pool more than once/i.test(String(error))) throw error;
  });
}

describeIntegration(
  "the executor never picks up an action it must not touch",
  () => {
    /** Seed one action in a given status, with a payload unique to its id. */
    async function seedAction(
      db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
      actionId: string,
      status: string,
    ): Promise<void> {
      const payload = { issue: "MOBL-1", body: actionId };
      await db.query(
        `INSERT INTO external_actions
           (action_id, case_id, owner_id, tool_name, connection_id, canonical_payload,
            action_digest, risk_tier, policy_decision, status, idempotency_key)
         VALUES ($1,'case-p','owner-p','jira.issue.comment','conn-p',$2::jsonb,$3,
                 'R3','REQUIRES_APPROVAL',$4,$5)`,
        [actionId, JSON.stringify(payload), canonicalDigest(payload), status, `idem-${actionId}`],
      );
    }

    async function seedCase(
      db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
    ): Promise<void> {
      await new OwnerRepository().insert(db, { ownerId: "owner-p", displayName: "owner-p" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-p",
        ownerId: "owner-p",
        provider: "jira",
        alias: "private",
        displayName: "conn-p",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-p",
        ownerId: "owner-p",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-p"] },
        discordThreadId: "thread-p",
      });
    }

    it("NEVER selects an AMBIGUOUS action — the blind replay AC5 forbids", async () => {
      // THE most important assertion in this file. An AMBIGUOUS action may already have
      // posted the comment; picking it up again sends the write twice. A mutation adding
      // 'AMBIGUOUS' to the executor's status filter stayed green against the lifecycle
      // suite, which is exactly why this test exists.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapExecutor>;
      try {
        await seedCase(db);
        await seedAction(db, "act-ambiguous", "AMBIGUOUS");
        await seedAction(db, "act-executing", "EXECUTING");
        await seedAction(db, "act-succeeded", "SUCCEEDED");

        const attempted: string[] = [];
        runtime = bootstrapExecutor({
          db: db as never,
          config: { ...executorConfigFromEnv({}), port: 0, intervalMs: 20, batchSize: 10 },
          ports: {
            runOneAction: async (actionId) => {
              attempted.push(actionId);
            },
          },
        });
        started.push(runtime);
        await runtime.start();
        // Several intervals, so "not yet" cannot masquerade as "never".
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(attempted).toEqual([]);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("DOES select a PROPOSED and an APPROVED action", async () => {
      // The counter-case. A test asserting only absences would pass if the executor picked
      // up nothing at all — a broken process rather than a safe one.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapExecutor>;
      try {
        await seedCase(db);
        await seedAction(db, "act-proposed", "PROPOSED");
        await seedAction(db, "act-approved", "APPROVED");

        const attempted: string[] = [];
        runtime = bootstrapExecutor({
          db: db as never,
          config: { ...executorConfigFromEnv({}), port: 0, intervalMs: 20, batchSize: 10 },
          ports: {
            runOneAction: async (actionId) => {
              attempted.push(actionId);
            },
          },
        });
        started.push(runtime);
        await runtime.start();
        for (let i = 0; i < 50 && attempted.length < 2; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect([...attempted].sort()).toEqual(["act-approved", "act-proposed"]);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("waits for an action in flight before shutting down", async () => {
      // An action in flight has been moved to EXECUTING and may have reached the provider.
      // Being killed here is what turns a successful write into an unrecorded one.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapExecutor>;
      try {
        await seedCase(db);
        await seedAction(db, "act-slow", "APPROVED");

        let finished = false;
        let startedAction = false;
        runtime = bootstrapExecutor({
          db: db as never,
          config: { ...executorConfigFromEnv({}), port: 0, intervalMs: 20, drainMs: 5_000 },
          ports: {
            runOneAction: async () => {
              startedAction = true;
              await new Promise((resolve) => setTimeout(resolve, 250));
              finished = true;
            },
          },
        });
        started.push(runtime);
        await runtime.start();
        for (let i = 0; i < 100 && !startedAction; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(startedAction).toBe(true);
        expect(finished).toBe(false);

        const outcome = await runtime.shutdown("SIGTERM");
        expect(outcome.drained).toBe(true);
        expect(finished).toBe(true);
      } finally {
        await teardown(runtime, drop);
      }
    });
  },
  available,
);

describeIntegration(
  "the ingress narrows what an anonymous caller can do",
  () => {
    async function post(port: number, path: string, body: Uint8Array): Promise<number> {
      const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
        method: "POST",
        body,
      });
      return response.status;
    }

    /** Start an ingress with one route, and return both ports. */
    async function ingressWith(
      db: Awaited<ReturnType<typeof createTestDatabase>>["db"],
      options: {
        maxBodyBytes?: number;
        ingest?: (request: { authorization: string | null; body: Uint8Array }) => Promise<void>;
      } = {},
    ) {
      const { runtime, process: ingress } = bootstrapIngress({
        db: db as never,
        config: {
          ...ingressConfigFromEnv({}),
          healthPort: 0,
          webhookPort: 0,
          ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
        },
        routes: [
          {
            path: "/webhook/jira",
            ingest: options.ingest ?? (async () => undefined),
          },
        ],
      });
      started.push(runtime);
      await runtime.start();
      return { runtime, webhookPort: ingress.webhookPort! };
    }

    it("returns 413 for an oversized body, and never calls the route", async () => {
      // 413 tells a provider the request itself is the problem; 500 would invite it to retry
      // a body that will never fit. The limit is enforced DURING the read — buffering an
      // unbounded body and then rejecting it is the memory-exhaustion path, on the one
      // endpoint anyone can reach.
      const { db, drop } = await createTestDatabase();
      let runtime!: Awaited<ReturnType<typeof ingressWith>>["runtime"];
      try {
        let ingested = 0;
        const started_ = await ingressWith(db, {
          maxBodyBytes: 64,
          ingest: async () => {
            ingested += 1;
          },
        });
        runtime = started_.runtime;
        const status = await post(started_.webhookPort, "/webhook/jira", new Uint8Array(4096));
        expect(status).toBe(413);
        // The route must not see an oversized body at all.
        expect(ingested).toBe(0);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("accepts a body within the limit with 202, not 200", async () => {
      // 202: the payload is durably stored and a wake-up enqueued, but the work has not
      // happened. 200 would claim more than we know.
      const { db, drop } = await createTestDatabase();
      let runtime!: Awaited<ReturnType<typeof ingressWith>>["runtime"];
      try {
        let ingested = 0;
        const started_ = await ingressWith(db, {
          maxBodyBytes: 1024,
          ingest: async () => {
            ingested += 1;
          },
        });
        runtime = started_.runtime;
        expect(await post(started_.webhookPort, "/webhook/jira", new Uint8Array(16))).toBe(202);
        expect(ingested).toBe(1);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("returns 401 for a signature failure and 500 for anything else", async () => {
      // The distinction decides whether a provider retries. A signature will never become
      // valid, so 401; a transient fault is worth retrying, and dedupe makes that safe.
      const { db, drop } = await createTestDatabase();
      let runtime!: Awaited<ReturnType<typeof ingressWith>>["runtime"];
      try {
        const started_ = await ingressWith(db, {
          ingest: async () => {
            throw new Error("signature verification failed");
          },
        });
        runtime = started_.runtime;
        expect(await post(started_.webhookPort, "/webhook/jira", new Uint8Array(8))).toBe(401);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("returns 500 for a non-signature failure, so the provider retries", async () => {
      const { db, drop } = await createTestDatabase();
      let runtime!: Awaited<ReturnType<typeof ingressWith>>["runtime"];
      try {
        const started_ = await ingressWith(db, {
          ingest: async () => {
            throw new Error("database temporarily unavailable");
          },
        });
        runtime = started_.runtime;
        expect(await post(started_.webhookPort, "/webhook/jira", new Uint8Array(8))).toBe(500);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("404s an unknown path and a non-POST method", async () => {
      // The webhook server must expose exactly its routes. Anything else is surface on the
      // one component reachable by anyone.
      const { db, drop } = await createTestDatabase();
      let runtime!: Awaited<ReturnType<typeof ingressWith>>["runtime"];
      try {
        const started_ = await ingressWith(db);
        runtime = started_.runtime;
        expect(await post(started_.webhookPort, "/webhook/unknown", new Uint8Array(4))).toBe(404);
        const getResponse = await fetch(
          `http://127.0.0.1:${String(started_.webhookPort)}/webhook/jira`,
        );
        expect(getResponse.status).toBe(404);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("never leaks the failure detail into the response body", async () => {
      // A webhook error message embeds the token it failed to verify. The detail goes to the
      // REDACTING logger; the response carries only a verdict.
      const { db, drop } = await createTestDatabase();
      let runtime!: Awaited<ReturnType<typeof ingressWith>>["runtime"];
      try {
        const started_ = await ingressWith(db, {
          ingest: async () => {
            throw new Error("signature invalid for token glpat-ABCDEFGHIJKLMNOPQRST");
          },
        });
        runtime = started_.runtime;
        const response = await fetch(
          `http://127.0.0.1:${String(started_.webhookPort)}/webhook/jira`,
          { method: "POST", body: new Uint8Array(8) },
        );
        const body = await response.text();
        expect(response.status).toBe(401);
        expect(body).not.toContain("ABCDEFGHIJKLMNOPQRST");
        expect(body).toBe(JSON.stringify({ accepted: false }));
      } finally {
        await teardown(runtime, drop);
      }
    });
  },
  available,
);

describeIntegration(
  "the scheduler does not let ticks overlap",
  () => {
    it("skips a slot rather than stacking a second scan", async () => {
      // Two concurrent scans enqueue the same renewal twice — harmless thanks to dedupe, but
      // a self-overlapping timer under a slow database piles up scans without bound. A
      // mutation removing the guard stayed green against the lifecycle suite.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapScheduler>;
      try {
        let concurrent = 0;
        let peak = 0;
        runtime = bootstrapScheduler({
          db: db as never,
          config: { ...schedulerConfigFromEnv({}), port: 0, intervalMs: 10, drainMs: 5_000 },
          tasks: [
            {
              name: "slow",
              run: async () => {
                concurrent += 1;
                peak = Math.max(peak, concurrent);
                // Far longer than the interval, so an unguarded loop would stack several.
                await new Promise((resolve) => setTimeout(resolve, 120));
                concurrent -= 1;
              },
            },
          ],
        });
        started.push(runtime);
        await runtime.start();
        await new Promise((resolve) => setTimeout(resolve, 400));
        // Exactly one at a time, ever.
        expect(peak).toBe(1);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("runs its FIRST tick immediately, not after a full interval", async () => {
      // After a restart a watch may already be past its renewal window; waiting a full
      // interval to find out is that long of lost events. With a 60s default, a mutation
      // delaying the first tick would be invisible in production until something expired.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapScheduler>;
      try {
        let ticks = 0;
        runtime = bootstrapScheduler({
          db: db as never,
          // A long interval, so only an IMMEDIATE first tick can pass this.
          config: { ...schedulerConfigFromEnv({}), port: 0, intervalMs: 30_000 },
          tasks: [
            {
              name: "counter",
              run: async () => {
                ticks += 1;
              },
            },
          ],
        });
        started.push(runtime);
        await runtime.start();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(ticks).toBe(1);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("one failing task does not stop the others", async () => {
      // A broken Jira renewal scan must not also stop Calendar watch renewal.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapScheduler>;
      try {
        let secondRan = 0;
        runtime = bootstrapScheduler({
          db: db as never,
          config: { ...schedulerConfigFromEnv({}), port: 0, intervalMs: 30_000 },
          tasks: [
            {
              name: "broken",
              run: async () => {
                throw new Error("scan failed");
              },
            },
            {
              name: "healthy",
              run: async () => {
                secondRan += 1;
              },
            },
          ],
        });
        started.push(runtime);
        await runtime.start();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(secondRan).toBe(1);
      } finally {
        await teardown(runtime, drop);
      }
    });
  },
  available,
);

describeIntegration(
  "the health CLI reports the truth about a live process",
  () => {
    it("exits 0 against a healthy process and 1 against a stopped one", async () => {
      // The CLI is what Docker and ECS read. `probe` returning 0 unconditionally would make
      // every container look healthy forever — including a crashed one.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapScheduler>;
      try {
        runtime = bootstrapScheduler({
          db: db as never,
          config: { ...schedulerConfigFromEnv({}), port: 0, intervalMs: 30_000 },
          tasks: [],
        });
        started.push(runtime);
        await runtime.start();
        const port = runtime.port!;

        expect(await probe({ port, path: "/livez", timeoutMs: 2_000 })).toBe(0);
        await runtime.shutdown("SIGTERM");
        // Stopped: the port is closed, so the probe must report unhealthy rather than
        // treating "cannot connect" as fine.
        expect(await probe({ port, path: "/livez", timeoutMs: 500 })).toBe(1);
      } finally {
        await drop().catch(() => undefined);
      }
    });

    it("exits 1 for a 503, not just for an unreachable port", async () => {
      // A DEGRADED process answers with 503. Treating any response as healthy would keep a
      // task that cannot reach the database in the load balancer's rotation.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapScheduler>;
      try {
        runtime = bootstrapScheduler({
          db: db as never,
          config: { ...schedulerConfigFromEnv({}), port: 0, intervalMs: 30_000 },
          tasks: [],
        });
        started.push(runtime);
        await runtime.start();
        const port = runtime.port!;
        await db.close();
        // Readiness is 503 with the database gone; liveness is still 200.
        expect(await probe({ port, path: "/readyz", timeoutMs: 2_000 })).toBe(1);
        expect(await probe({ port, path: "/livez", timeoutMs: 2_000 })).toBe(0);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("rejects a nonsense RA_HEALTH_PORT rather than defaulting", async () => {
      // A misconfigured container must not look healthy. Defaulting would hide the
      // misconfiguration behind a working process on the wrong port.
      expect(() => probeOptionsFromEnv([], { RA_HEALTH_PORT: "not-a-port" })).toThrow(
        /must be a positive integer/,
      );
      expect(() => probeOptionsFromEnv([], { RA_HEALTH_PORT: "0" })).toThrow();
      // Absent is fine: 8080 is the documented default and matches `infra/cdk`.
      expect(probeOptionsFromEnv([], {}).port).toBe(8080);
    });
  },
  available,
);

describeIntegration(
  "the worker rejects a misconfigured environment",
  () => {
    it("throws on a nonsense interval rather than silently using the default", async () => {
      // A typo in `RA_POLL_INTERVAL_MS` that quietly reverted to 1000ms would be a
      // deployment that looks configured and is not.
      expect(() => workerConfigFromEnv({ RA_POLL_INTERVAL_MS: "fast" })).toThrow(
        /must be a positive integer/,
      );
      expect(() => workerConfigFromEnv({ RA_DRAIN_MS: "-5" })).toThrow();
      expect(() => workerConfigFromEnv({ RA_HEALTH_PORT: "1.5" })).toThrow();
      // Absent and empty both fall back, which IS intended — only a present-but-invalid
      // value is an error.
      expect(workerConfigFromEnv({}).intervalMs).toBe(1_000);
      expect(workerConfigFromEnv({ RA_POLL_INTERVAL_MS: "  " }).intervalMs).toBe(1_000);
    });

    it("gives the ingress a health port distinct from its webhook port", async () => {
      // They must differ, or the load balancer would route webhooks at the health endpoint.
      const config = ingressConfigFromEnv({});
      expect(config.healthPort).not.toBe(config.webhookPort);
      // 8080 is what `infra/cdk` maps to the target group, so webhooks must own it.
      expect(config.webhookPort).toBe(8080);
    });
  },
  available,
);

describeIntegration(
  "the worker process carries a case from the queue to a persisted completion",
  () => {
    /**
     * AC7 of RA-028, and the criterion RA-027 could only satisfy PARTIALLY.
     *
     * Every other test in this repository wires packages together in memory. This one
     * enqueues a row, starts the REAL `worker.js` process over a REAL database, and waits for
     * the scheduler's own polling loop to claim the job, run the handler and persist the
     * result. Nothing here calls a handler directly.
     *
     * Before RA-028 the same setup dead-lettered the job with `UnknownJobTypeError`, because
     * the process shipped with an empty handler map.
     */
    it("claims a case.resume job from its own loop and persists the completion", async () => {
      const { db, drop } = await createTestDatabase();
      const caseId = "case-live";
      const unitId = "unit-live";
      // A REAL clock, deliberately. `bootstrapWorker` builds its own `JobStore` with
      // `productionRuntime()` — system clock, `leaseTime: 'db'`. Enqueueing here with a FIXED
      // clock puts the queue's notion of time hours away from the process's, and whether the
      // job is claimed then depends on how the two disagree; the suite passed alone and failed
      // under load. Only the ids stay deterministic, because the scripted completion's `run_id`
      // must match the id the runtime mints.
      const counters = new Map<string, number>();
      const runtime = {
        clock: new SystemClock(),
        ids: {
          next: (prefix?: string) => {
            const key = prefix ?? "id";
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return `${key}-${String(next)}`;
          },
        },
      };

      await new OwnerRepository().insert(db, { ownerId: "owner-live", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "connection-live",
        ownerId: "owner-live",
        provider: "jira",
        displayName: "connection",
      });
      await new CaseRepository().insert(db, {
        caseId,
        ownerId: "owner-live",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-live"] },
        discordThreadId: "thread-live",
      });
      await new WorkUnitRepository().insert(db, {
        workUnitId: unitId,
        caseId,
        role: "REVIEWER",
        objective: "review the live case",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: [],
          can_write_workspace: false,
        },
      });
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ($1, 'owner-live', 0, $2::jsonb)",
        [caseId, JSON.stringify(makeCheckpoint(caseId, 0))],
      );

      // ONE documented cast at the boundary, the open half of `CTF-004`. `createTestDatabase`
      // returns a `Database` typed from `packages/database/src`, while `apps/agent-worker`
      // imports the `dist` declaration; the two are structurally identical but each declares a
      // private `pool`, so the compiler treats them as unrelated. The same bridge exists in
      // `test/golden-path`.
      const productionDb = db as unknown as ProductionDatabase;

      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, { caseId, jobType: "case.resume", payload: {} });

      const persistence = new WorkerPersistence(productionDb, runtime);
      const transport = new FakeTransport([
        {
          model: { provider: "bedrock", model_id: "test-model" },
          content: [
            {
              type: "json",
              value: {
                schema_version: 1,
                run_id: "run-1",
                case_id: caseId,
                status: "COMPLETED",
                summary: "reviewed",
                completed_steps: [],
                evidence: [],
                checkpoint_patch: {},
                next_actions: [],
              },
            },
          ],
        },
      ]);

      // `port: 0` so the health server never collides with another suite's worker.
      const process = bootstrapWorker({
        config: { port: 0, intervalMs: 10, owner: "worker-live", drainMs: 5_000 },
        db: productionDb,
        handlers: createWorkerHandlers({
          persistence,
          roles: createRoles(["REVIEWER"], {
            transport,
            config: createRuntimeConfig({
              model: { provider: "bedrock", model_id: "test-model" },
              timeoutMs: 30_000,
              toolLimits: { maxIterations: 4, maxCalls: 8 },
            }),
          }),
          logger: new StructuredLogger({ sink: { log: () => undefined } }),
          db: productionDb,
          jobs: new JobStore(runtime),
        }),
        sink: async () => undefined,
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
      });
      await process.start();

      // Poll for the durable result rather than sleeping a fixed interval: the assertion is
      // that the process GETS there, and a fixed sleep either flakes or wastes time.
      //
      // WAIT ON THE JOB STATUS, NOT THE COMPLETION ROW. Polling `run_completions` returns as
      // soon as the handler has persisted, but `Scheduler` marks the job `SUCCEEDED` only
      // AFTER the handler returns — so the completion is visible while the job is still
      // `LEASED` for a moment. This test failed exactly that way once in nine full-repo runs:
      // a race in the TEST, not in the product. The job status settles last, so waiting on it
      // means every earlier effect is already durable.
      const deadline = Date.now() + 20_000;
      let jobStatus = "";
      while (Date.now() < deadline) {
        const row = await db.query<{ status: string }>(
          "SELECT status FROM jobs WHERE case_id = $1",
          [caseId],
        );
        jobStatus = row.rows[0]?.status ?? "";
        if (jobStatus === "SUCCEEDED" || jobStatus === "DEAD_LETTER") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      expect((await db.query("SELECT 1 FROM run_completions")).rows).toHaveLength(1);
      // The full effect, not just the completion row: the case advanced and the outbox
      // carries the event that tells the rest of the system.
      const revision = await db.query<{ checkpoint_revision: number }>(
        "SELECT checkpoint_revision FROM cases WHERE case_id = $1",
        [caseId],
      );
      expect(revision.rows[0]?.checkpoint_revision).toBe(1);
      const outbox = await db.query<{ event_type: string }>(
        "SELECT event_type FROM outbox WHERE aggregate_id = $1",
        [caseId],
      );
      expect(outbox.rows.map((row) => row.event_type)).toContain("agent.completion.recorded");
      // The model was reached exactly once by the live process.
      expect(transport.requests).toHaveLength(1);
      // And the job itself succeeded rather than being retried or dead-lettered — which is
      // what the whole task turns on: before RA-028 this same job reached the DLQ.
      expect(jobStatus).toBe("SUCCEEDED");

      await teardown(process, drop);
    });
  },
  available,
);
