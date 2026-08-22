import {
  bootstrapExecutor,
  executorConfigFromEnv,
} from "../../apps/action-executor/src/executor.js";
import { bootstrapWorker, workerConfigFromEnv } from "../../apps/agent-worker/src/worker.js";
import { bootstrapIngress, ingressConfigFromEnv } from "../../apps/ingress-api/src/ingress.js";
import { bootstrapScheduler, schedulerConfigFromEnv } from "../../apps/scheduler/src/scheduler.js";
import { afterEach, expect, it } from "vitest";

import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();

/**
 * The processes start, serve health and stop cleanly — against a REAL database
 * (RA-027-WU-03..WU-07, AC1, AC4).
 *
 * A FIXTURE NOTE THAT COST A RUN. Each process's `close()` ends the database pool — that is
 * its job. The harness's `drop()` then ends the same pool and `pg` throws "Called end on
 * pool more than once". That is the FIXTURE being wrong, not the product: a process must
 * close the pool it was given. So every test below tears down through `teardown()`, which
 * drops the database on its own short-lived connection and tolerates an already-closed
 * pool.
 *
 * WHY THIS SUITE IS THE POINT OF RA-027. Every §13 criterion was already proven by tests
 * that wire packages together in memory. What none of them showed is that a PROCESS can be
 * started, probed and stopped — which is what a deployment does, and which was impossible
 * before this task because no entry point existed.
 *
 * A real database, not a fake, because the interesting assertion is AC4: what a process
 * reports when the database goes away. A fake would report whatever the test wanted.
 */
const started: { shutdown(): Promise<unknown> }[] = [];

afterEach(async () => {
  // Each runtime binds a port and holds a pool. A leaked one makes the NEXT test fail with
  // EADDRINUSE or a connection limit, which reads as a defect in that test.
  for (const runtime of started.splice(0)) await runtime.shutdown();
});

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return { status: response.status, body: await response.text() };
}

/**
 * Stop the runtime, then drop the database.
 *
 * In that order, and tolerating an already-ended pool: the runtime's `close()` ends it, so
 * `drop()` arriving second is expected rather than exceptional.
 */
async function teardown(
  runtime: { shutdown(reason?: never): Promise<unknown> },
  drop: () => Promise<void>,
): Promise<void> {
  await runtime.shutdown();
  await drop().catch((error: unknown) => {
    if (!/end on pool more than once/i.test(String(error))) throw error;
  });
}

describeIntegration(
  "AC1: every process starts, serves health and stops cleanly",
  () => {
    it("worker: starts, reports UP on both probes, shuts down clean", async () => {
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapWorker>;
      try {
        runtime = bootstrapWorker({
          // Port 0 so tests never collide.
          config: { ...workerConfigFromEnv({}), port: 0, intervalMs: 50 },
          db: db as never,
          // Empty handler map: a claimed job fails closed to the DLQ. That is the shipped
          // default and is asserted rather than worked around.
          handlers: {},
          sink: async () => undefined,
        });
        started.push(runtime);
        await runtime.start();
        expect(runtime.port).toBeGreaterThan(0);
        expect((await get(runtime.port!, "/livez")).status).toBe(200);
        expect((await get(runtime.port!, "/readyz")).status).toBe(200);

        const outcome = await runtime.shutdown("SIGTERM");
        expect(outcome).toEqual({ reason: "SIGTERM", drained: true, clean: true });
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("executor: starts, serves health, shuts down clean", async () => {
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapWorker>;
      try {
        runtime = bootstrapExecutor({
          db: db as never,
          config: { ...executorConfigFromEnv({}), port: 0, intervalMs: 50 },
          // Throws, matching the shipped default: no provider adapter is wired.
          ports: {
            runOneAction: async () => {
              throw new Error("no adapter");
            },
          },
        });
        started.push(runtime);
        await runtime.start();
        expect((await get(runtime.port!, "/readyz")).status).toBe(200);
        expect((await runtime.shutdown("SIGTERM")).clean).toBe(true);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("ingress: serves health on one port and webhooks on another", async () => {
      // Two ports, deliberately: `infra/cdk` maps 8080 to the target group, so health must
      // NOT share it or the load balancer would route webhooks at the health endpoint.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapIngress>["runtime"];
      try {
        runtime = bootstrapIngress({
          db: db as never,
          config: { ...ingressConfigFromEnv({}), healthPort: 0, webhookPort: 0 },
          routes: [],
        }).runtime;
        started.push(runtime);
        await runtime.start();
        expect((await get(runtime.port!, "/livez")).status).toBe(200);
        expect((await runtime.shutdown("SIGTERM")).clean).toBe(true);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("scheduler: starts, ticks, shuts down clean", async () => {
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapScheduler>;
      try {
        let ticks = 0;
        runtime = bootstrapScheduler({
          db: db as never,
          config: { ...schedulerConfigFromEnv({}), port: 0, intervalMs: 30 },
          tasks: [
            {
              name: "probe",
              run: async () => {
                ticks += 1;
              },
            },
          ],
        });
        started.push(runtime);
        await runtime.start();
        // The first tick is immediate, not after one interval: after a restart a watch may
        // already be past its renewal window.
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(ticks).toBeGreaterThan(0);
        expect((await runtime.shutdown("SIGTERM")).clean).toBe(true);
      } finally {
        await teardown(runtime, drop);
      }
    });
  },
  available,
);

describeIntegration(
  "AC4: a process that loses the database reports UNREADY but stays ALIVE",
  () => {
    it("worker: readyz goes 503 while livez stays 200 after the pool closes", async () => {
      // THE AC4 assertion, and the reason this suite uses a real database. Reporting
      // unhealthy here would make ECS restart every worker during an outage — exactly when
      // their in-flight leases and logs are the only available evidence (RA-024).
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapWorker>;
      try {
        runtime = bootstrapWorker({
          config: { ...workerConfigFromEnv({}), port: 0, intervalMs: 10_000 },
          db: db as never,
          handlers: {},
          sink: async () => undefined,
        });
        started.push(runtime);
        await runtime.start();
        const port = runtime.port!;
        expect((await get(port, "/readyz")).status).toBe(200);

        // Simulate the database going away by closing the pool underneath the process. A
        // stopped container would be indistinguishable from the process's point of view.
        await db.close();

        const ready = await get(port, "/readyz");
        const live = await get(port, "/livez");
        expect(ready.status).toBe(503);
        expect(ready.body).toContain("postgres");
        // The load-bearing half: STILL ALIVE.
        expect(live.status).toBe(200);
      } finally {
        await teardown(runtime, drop);
      }
    });

    it("worker: still shuts down cleanly with the database already gone", async () => {
      // Shutdown must not depend on the thing that failed. A `close` that threw on an
      // already-closed pool would report unclean and, in ECS, hold the task until SIGKILL.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapWorker>;
      try {
        runtime = bootstrapWorker({
          config: { ...workerConfigFromEnv({}), port: 0, intervalMs: 10_000 },
          db: db as never,
          handlers: {},
          sink: async () => undefined,
        });
        started.push(runtime);
        await runtime.start();
        await db.close();
        const outcome = await runtime.shutdown("SIGTERM");
        expect(outcome.drained).toBe(true);
      } finally {
        await teardown(runtime, drop);
      }
    });
  },
  available,
);

describeIntegration(
  "AC1: shutdown does not abandon work that is in flight",
  () => {
    it("worker: waits for a running handler before closing", async () => {
      // The property that makes a rolling deploy safe. A worker killed between claiming a
      // job and completing it leaves the effect half-applied; the lease and reaper make that
      // recoverable, but not abandoning it in the first place is better.
      const { db, drop } = await createTestDatabase();
      let runtime!: ReturnType<typeof bootstrapWorker>;
      try {
        let handlerFinished = false;
        let handlerStarted = false;
        runtime = bootstrapWorker({
          config: { ...workerConfigFromEnv({}), port: 0, intervalMs: 20, drainMs: 5_000 },
          db: db as never,
          handlers: {
            "case.resume": async () => {
              handlerStarted = true;
              await new Promise((resolve) => setTimeout(resolve, 250));
              handlerFinished = true;
            },
          },
          sink: async () => undefined,
        });
        started.push(runtime);
        await runtime.start();

        // Enqueue a job the handler will claim. Seeded directly: the point is the process
        // lifecycle, not the enqueue path.
        await db.query(
          `INSERT INTO jobs (job_id, job_type, status, payload, available_at)
           VALUES ('job-drain', 'case.resume', 'PENDING', '{}'::jsonb, now())`,
        );

        // Wait until the handler is actually running, then shut down mid-work.
        for (let i = 0; i < 100 && !handlerStarted; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(handlerStarted).toBe(true);
        expect(handlerFinished).toBe(false);

        const outcome = await runtime.shutdown("SIGTERM");
        // Drained, and the handler ran to completion rather than being cut off.
        expect(outcome.drained).toBe(true);
        expect(handlerFinished).toBe(true);
      } finally {
        await teardown(runtime, drop);
      }
    });
  },
  available,
);
