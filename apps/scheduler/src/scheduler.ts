/**
 * `scheduler.js` — periodic renewal and reconciliation (RA-027-WU-07).
 *
 * WHY THIS IS ITS OWN PROCESS rather than a tick inside the worker: the work it does is
 * TIME-driven, not queue-driven, and the two have opposite failure modes. A worker that
 * stops claiming leaves jobs visibly pending; a scheduler that stops ticking leaves nothing
 * at all — no queue depth, no error, just watches quietly expiring until events stop
 * arriving. That silence is exactly why `renewals.failed` is one of the four AC4 alarm
 * classes.
 *
 * WHAT IT DOES, and each is a SCAN for due work rather than the work itself:
 *
 *   - webhook/watch registrations past `renew_after` → enqueue a renewal job;
 *   - reconciliation watermarks that have not advanced → enqueue a reconciliation.
 *
 * It performs no provider call. Enqueuing is the whole job, and the renewal itself runs in
 * the worker under a lease — because a renewal IS a provider write and must be leased,
 * fenced and retried like any other, not done inline in a timer.
 *
 * A TICK MUST NOT OVERLAP ITSELF. Two concurrent scans would enqueue the same renewal twice;
 * dedupe in `registration.ts` makes that harmless, but a self-overlapping timer under a slow
 * database degrades into an unbounded pile of scans. So a tick that is still running skips
 * the next slot rather than stacking.
 */
import { Database, JobStore, productionRuntime } from "@remoteagent/database";
import {
  ProcessRuntime,
  StructuredLogger,
  type ProcessDefinition,
} from "@remoteagent/observability";

import { createJiraReconcileTask, jiraReconcileProjectsFromEnv } from "./jira-reconcile-task.js";

export const SCHEDULER_ENV = {
  port: "RA_HEALTH_PORT",
  /** Tick interval. Minutes, not seconds: this scans for work due on an hourly horizon. */
  intervalMs: "RA_SCHEDULER_INTERVAL_MS",
  drainMs: "RA_DRAIN_MS",
} as const;

export interface SchedulerProcessConfig {
  readonly port: number;
  readonly intervalMs: number;
  readonly drainMs: number;
}

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export function schedulerConfigFromEnv(env: Env = process.env): SchedulerProcessConfig {
  return {
    port: positiveInt(env, SCHEDULER_ENV.port, 8080),
    // One minute. Watch expiry is measured in hours or days, so a faster tick buys nothing
    // and a slower one risks missing a narrow renewal window after a restart.
    intervalMs: positiveInt(env, SCHEDULER_ENV.intervalMs, 60_000),
    drainMs: positiveInt(env, SCHEDULER_ENV.drainMs, 10_000),
  };
}

/** One periodic scan. Supplied by the deployment so this file needs no connector. */
export interface SchedulerTask {
  readonly name: string;
  /** Find due work and enqueue it. Must not call a provider. */
  run(): Promise<void>;
}

export function createSchedulerProcess(input: {
  readonly db: Database;
  readonly config: SchedulerProcessConfig;
  readonly tasks: readonly SchedulerTask[];
  readonly logger?: StructuredLogger;
}): ProcessDefinition {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let responsive = true;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    for (const task of input.tasks) {
      try {
        await task.run();
      } catch (error) {
        // One failing scan must not stop the others: a broken Jira renewal scan should not
        // also stop Calendar watch renewal. Logged, and the next tick retries.
        input.logger?.error("scheduler task failed", { task: task.name, error });
      }
    }
  };

  const loop = async (): Promise<void> => {
    if (!running) return;
    // Skip rather than stack.
    //
    // BELT AND BRACES, not the mechanism. The real guarantee is structural: this loop
    // `await`s its pass before scheduling the next timer, so `inFlight` is always null when
    // checked and no overlap is reachable through `loop` itself. A mutation forcing this
    // branch to `true` therefore stays green — probed, so it is recorded here rather than
    // left as an unexplained survivor.
    //
    // Kept because it is the guard that would matter if a future change ever invoked `tick`
    // from a second site (an operator-triggered scan, a signal handler). Removing it would
    // make that change silently unsafe, and its cost is one comparison.
    if (inFlight === null) {
      const pass = tick();
      inFlight = pass;
      try {
        await pass;
        responsive = true;
      } catch (error) {
        responsive = false;
        input.logger?.error("scheduler tick failed", { error });
      } finally {
        if (inFlight === pass) inFlight = null;
      }
    } else {
      input.logger?.warn("scheduler tick skipped: previous pass still running");
    }
    if (running) timer = setTimeout(() => void loop(), input.config.intervalMs);
  };

  return {
    name: "scheduler",
    start: () => {
      running = true;
      // First tick is immediate, not after one interval: after a restart, a watch may
      // already be past its renewal window, and waiting a minute to find out is a minute of
      // lost events.
      timer = setTimeout(() => void loop(), 0);
    },
    stopAcceptingWork: () => {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    drain: async () => {
      // A scan in flight has possibly enqueued some renewals and not others. Letting it
      // finish keeps the enqueue set coherent; abandoning it means the next tick redoes the
      // scan, which dedupe makes safe but which loses nothing by waiting either.
      if (inFlight !== null) await inFlight;
    },
    close: async () => {
      await input.db.close();
    },
    isResponsive: () => responsive,
    isDatabaseReachable: async () => {
      try {
        await input.db.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function bootstrapScheduler(input: {
  readonly db: Database;
  readonly config: SchedulerProcessConfig;
  readonly tasks: readonly SchedulerTask[];
  readonly logger?: StructuredLogger;
}): ProcessRuntime {
  return new ProcessRuntime(createSchedulerProcess(input), {
    port: input.config.port,
    drainMs: input.config.drainMs,
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });
}

/**
 * The deployment entry point.
 *
 * `tasks` is EMPTY by default. The renewal scans need connector clients and credentials,
 * which RA-027 does not wire. An empty task list means the process starts, reports healthy
 * and does nothing — which is the one default here that IS quietly wrong rather than loudly
 * wrong, so it is logged explicitly at startup and recorded in the handoff. A scheduler with
 * no tasks is the silent-failure shape this whole process exists to prevent.
 */
export async function main(): Promise<void> {
  const config = schedulerConfigFromEnv();
  const logger = new StructuredLogger({
    sink: { log: (record) => console.log(JSON.stringify(record)) },
  });
  const db = Database.fromEnv();
  // RA-030: register the Jira reconcile scan when projects are configured. It only ENQUEUES a
  // `jira.reconcile` job (no provider call); the worker runs the REST read under a lease. Absent
  // JIRA_PROJECT_KEY = no task (the empty-tasks warning below fires, which is the intended signal).
  const projects = jiraReconcileProjectsFromEnv();
  const tasks: readonly SchedulerTask[] =
    projects.length > 0
      ? [createJiraReconcileTask({ db, jobs: new JobStore(productionRuntime()), projects })]
      : [];
  const runtime = bootstrapScheduler({ db, config, tasks, logger });
  await runtime.start();
  if (tasks.length === 0) {
    // Loud, because this is the one process whose failure mode is silence.
    logger.warn(
      "scheduler started with ZERO tasks: no watch or webhook renewal will be scheduled, " +
        "so provider events will stop arriving once existing registrations expire",
    );
  }
  logger.info("scheduler ready", { interval_ms: config.intervalMs, tasks: tasks.length });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
