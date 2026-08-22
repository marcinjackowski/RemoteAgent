/**
 * `executor.js` — the only process that performs an external write (RA-027-WU-04).
 *
 * WHY IT IS A SEPARATE PROCESS, restated here because the reason governs this file: the
 * executor holds provider credentials and must NOT be able to invoke Bedrock, while the
 * worker runs repository code and must NOT hold a provider credential. `infra/cdk` enforces
 * that with two disjoint IAM roles; this file is the other half — the code those roles run.
 *
 * WHAT THIS PROCESS DOES NOT DO, and each absence is load-bearing:
 *
 *   - it contains **no model reasoning**. Not "does not currently use a model" — there is no
 *     path from here into `bedrock-runtime`, which is why a Bedrock grant on the executor
 *     role could only ever be misuse;
 *   - it **never retries an AMBIGUOUS action**. `executeAction` refuses one, and this loop
 *     does not look for them. Resolving an ambiguous write requires reading the provider,
 *     which is `reconcileAmbiguousAction` and is a deliberate operator action;
 *   - it **decides nothing**. Tier, connection, payload and policy decision are all already
 *     on the durable row, put there by deterministic code.
 *
 * THE LOOP IS DELIBERATELY DUMB. It finds actions in a state from which execution may begin
 * and calls `executeAction` once per action. Every guard that matters — re-evaluating
 * policy, reading the kill switch in the consuming transaction, fencing on the approval —
 * lives inside `executeAction` and was audited in RA-022. Re-implementing any of it here
 * would create a second, unaudited copy.
 */
// Deliberately imports only `Database`. The repositories this process's WORK needs
// (`ExternalActionRepository`, `ApprovalRepository`, `ReceiptRepository`,
// `KillSwitchRepository`) are owned by `executeAction` and reach it through the injected
// `ports`, so instantiating them here would be a second, unused set.
import { Database } from "@remoteagent/database";
import {
  ProcessRuntime,
  StructuredLogger,
  type ProcessDefinition,
} from "@remoteagent/observability";

/** Env var names, documented so a deployment knows exactly what to set. */
export const EXECUTOR_ENV = {
  port: "RA_HEALTH_PORT",
  intervalMs: "RA_POLL_INTERVAL_MS",
  drainMs: "RA_DRAIN_MS",
  /** Max actions to attempt per pass. Bounds a single pass, not the rate. */
  batchSize: "RA_EXECUTOR_BATCH",
} as const;

export interface ExecutorConfig {
  readonly port: number;
  readonly intervalMs: number;
  readonly drainMs: number;
  readonly batchSize: number;
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

export function executorConfigFromEnv(env: Env = process.env): ExecutorConfig {
  return {
    port: positiveInt(env, EXECUTOR_ENV.port, 8080),
    // Slower than the worker's default: an external write is rate-limited by the provider,
    // and the backpressure limiter refuses rather than queues, so polling harder produces
    // refusals rather than throughput.
    intervalMs: positiveInt(env, EXECUTOR_ENV.intervalMs, 2_000),
    drainMs: positiveInt(env, EXECUTOR_ENV.drainMs, 20_000),
    // One at a time by default. The executor is a single task by design (see `infra/cdk`),
    // and a large batch would hold the process in one pass long past a shutdown signal.
    batchSize: positiveInt(env, EXECUTOR_ENV.batchSize, 1),
  };
}

/** What the executor needs supplied, so this file needs no provider adapter of its own. */
export interface ExecutorPortsInput {
  /** Performs one action. Supplied by the deployment; `executeAction` in RA-022. */
  runOneAction(actionId: string): Promise<void>;
}

export function createExecutorProcess(input: {
  readonly db: Database;
  readonly config: ExecutorConfig;
  readonly ports: ExecutorPortsInput;
  readonly logger?: StructuredLogger;
}): ProcessDefinition {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let responsive = true;
  const inFlight = new Set<Promise<void>>();

  /**
   * One pass: find executable actions, run each once.
   *
   * `APPROVED` and `PROPOSED` only. Deliberately NOT `EXECUTING` (already in flight or
   * abandoned — recovery's job) and NOT `AMBIGUOUS` (needs a provider read, never an
   * automatic retry). That state list is the whole safety of this loop.
   */
  const pass = async (): Promise<void> => {
    const rows = await input.db.query<{ action_id: string }>(
      `SELECT action_id FROM external_actions
        WHERE status IN ('PROPOSED', 'APPROVED')
        ORDER BY created_at ASC
        LIMIT $1`,
      [input.config.batchSize],
    );
    for (const row of rows.rows) {
      const work = input.ports.runOneAction(row.action_id);
      inFlight.add(work);
      try {
        await work;
      } catch (error) {
        // A failed action is `executeAction`'s business: it has already recorded a terminal
        // status or AMBIGUOUS. Logged and moved past, because throwing here would kill the
        // loop and stop every other action.
        input.logger?.error("action execution threw", { action_id: row.action_id, error });
      } finally {
        inFlight.delete(work);
      }
    }
  };

  const loop = async (): Promise<void> => {
    if (!running) return;
    try {
      await pass();
      responsive = true;
    } catch (error) {
      // A pass failure must not kill the loop; the next pass retries. But it DOES mean the
      // process could not read the queue, so responsiveness is not asserted.
      responsive = false;
      input.logger?.error("executor pass failed", { error });
    } finally {
      if (running) timer = setTimeout(() => void loop(), input.config.intervalMs);
    }
  };

  return {
    name: "executor",
    start: () => {
      running = true;
      timer = setTimeout(() => void loop(), input.config.intervalMs);
    },
    stopAcceptingWork: () => {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    drain: async () => {
      // THE most important drain in the system. An action in flight has already been moved
      // to EXECUTING and may have reached the provider; being killed here is what turns a
      // successful write into an unrecorded one. `allSettled` so one failure does not abort
      // the wait for the others.
      await Promise.allSettled([...inFlight]);
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

export function bootstrapExecutor(input: {
  readonly db: Database;
  readonly config: ExecutorConfig;
  readonly ports: ExecutorPortsInput;
  readonly logger?: StructuredLogger;
}): ProcessRuntime {
  return new ProcessRuntime(createExecutorProcess(input), {
    port: input.config.port,
    drainMs: input.config.drainMs,
    ...(input.logger !== undefined ? { logger: input.logger } : {}),
  });
}

/**
 * The deployment entry point.
 *
 * `runOneAction` throws by default, and that is deliberate rather than unfinished:
 * `executeAction` needs a `ProviderAdapter` per provider, and RA-027 composes existing
 * parts without adding domain logic. A no-op that returned successfully would leave actions
 * in PROPOSED forever while the process looked healthy — strictly worse than a loud refusal
 * that the DLQ and the logs both show.
 *
 * Recorded as a limitation in RA-027's handoff.
 */
export async function main(): Promise<void> {
  const config = executorConfigFromEnv();
  const logger = new StructuredLogger({
    sink: { log: (record) => console.log(JSON.stringify(record)) },
  });
  const db = Database.fromEnv();
  const runtime = bootstrapExecutor({
    db,
    config,
    ports: {
      runOneAction: async (actionId) => {
        throw new Error(
          `no provider adapter is wired, so action ${actionId} cannot be executed; ` +
            `RA-027 composes processes and does not add provider adapters`,
        );
      },
    },
    logger,
  });
  await runtime.start();
  logger.info("executor ready", { batch_size: config.batchSize });
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
