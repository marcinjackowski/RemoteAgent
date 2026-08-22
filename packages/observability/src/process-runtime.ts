/**
 * The shared process bootstrap: signals, graceful shutdown, health server
 * (RA-027-WU-01/WU-02).
 *
 * WHY THIS IS ONE MODULE AND NOT SIX COPIES. Six processes need to shut down cleanly, and
 * "cleanly" has a precise meaning here that is easy to get subtly wrong: a worker holding
 * a job lease must finish or release it, and an executor that has called a provider must
 * not be killed between the call and recording the receipt. Implemented per process, that
 * logic would be written six times and correct in fewer.
 *
 * SHUTDOWN IS A SEQUENCE, NOT A SIGNAL HANDLER. On `SIGTERM` the order is:
 *
 *   1. **stop reporting ready** — the load balancer and ECS stop sending new work
 *      immediately, before anything in flight is disturbed;
 *   2. **stop accepting new work** — the scheduler loop stops claiming;
 *   3. **await work in flight**, up to a deadline;
 *   4. **close the database**, last, because steps 2 and 3 need it.
 *
 * Reversing 1 and 2 is the interesting mistake: stopping the loop first leaves the process
 * reporting ready while doing nothing, so a load balancer keeps routing to it.
 *
 * THE DEADLINE IS REAL AND BOUNDED. ECS sends `SIGKILL` 30s after `SIGTERM` by default, so
 * an unbounded drain is a lie — the process will be killed mid-work anyway, just without
 * having recorded that it was shutting down. A bounded drain that reports what it
 * abandoned is strictly more useful, and the durable lease/reaper machinery is what makes
 * abandonment recoverable.
 *
 * LIVENESS DOES NOT TOUCH THE DATABASE. That is the RA-024 finding, applied here because
 * this is where it becomes load-bearing: ECS restarts a task whose health check fails, so
 * a liveness probe that consulted PostgreSQL would restart-loop every worker during a
 * database outage — exactly when their in-flight leases and logs are the only evidence
 * available.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { liveness, readiness, HealthState, type HealthReport } from "./health.js";
import { SecretRedactor } from "./redaction.js";
import { StructuredLogger } from "./tracing.js";

/** What the runtime needs from the process it is hosting. */
export interface ProcessDefinition {
  /** Process name, used in logs and in the health payload. `worker`, `executor`, … */
  readonly name: string;
  /**
   * Start doing work. Returns once started, not once finished.
   *
   * Must not block: a `start` that never returns would leave the health server unbound and
   * the task would fail its health check while working perfectly.
   */
  start(): Promise<void> | void;
  /**
   * Stop accepting NEW work. Must return promptly.
   *
   * Separate from {@link drain} on purpose — the two happen at different points in the
   * shutdown sequence, and collapsing them means new work can be claimed while draining.
   */
  stopAcceptingWork(): Promise<void> | void;
  /**
   * Await work already in flight. Called after {@link stopAcceptingWork}.
   *
   * Should resolve when idle. The runtime applies its own deadline, so an implementation
   * that waits forever is contained rather than fatal.
   */
  drain?(): Promise<void>;
  /** Release resources. Called last. */
  close?(): Promise<void>;
  /** Whether the process's own loop is responsive; feeds liveness. */
  isResponsive(): boolean;
  /** Whether the system of record is reachable; feeds readiness only. */
  isDatabaseReachable(): Promise<boolean> | boolean;
  /** Whether an operator kill switch is active. Reported, never load-bearing. */
  isKillSwitchActive?(): Promise<boolean> | boolean;
}

export interface ProcessRuntimeOptions {
  /** Health server port. `0` picks a free port, which is what tests use. */
  readonly port?: number;
  /**
   * How long to await in-flight work after `SIGTERM`, in ms.
   *
   * Default 20s, under ECS's 30s `SIGKILL` deadline with room for the database close. A
   * longer value would not buy time — it would just mean being killed before finishing the
   * sequence, losing the shutdown log line that says what was abandoned.
   */
  readonly drainMs?: number;
  readonly logger?: StructuredLogger;
  /** Injected so a test can drive shutdown without signalling its own process. */
  readonly signals?: NodeJS.Signals[];
}

/** Why the process stopped. */
export type ShutdownReason = "SIGTERM" | "SIGINT" | "REQUESTED" | "START_FAILED";

export interface ShutdownOutcome {
  readonly reason: ShutdownReason;
  /** Whether in-flight work finished within the deadline. */
  readonly drained: boolean;
  /** Whether every close step completed without throwing. */
  readonly clean: boolean;
}

/**
 * Host one process: bind health, start work, and shut down in the documented order.
 *
 * Returns a handle rather than blocking, so a test can start it, assert on health, trigger
 * shutdown and await the outcome — which is what makes AC1 verifiable without spawning a
 * child process and sending it real signals.
 */
export class ProcessRuntime {
  readonly #definition: ProcessDefinition;
  readonly #options: ProcessRuntimeOptions;
  readonly #logger: StructuredLogger;
  readonly #redactor: SecretRedactor;
  #server: Server | null = null;
  #shuttingDown = false;
  #outcome: ShutdownOutcome | null = null;
  #listeners: { signal: NodeJS.Signals; handler: () => void }[] = [];

  public constructor(definition: ProcessDefinition, options: ProcessRuntimeOptions = {}) {
    this.#definition = definition;
    this.#options = options;
    this.#logger =
      options.logger ?? new StructuredLogger({ ids: {}, sink: { log: () => undefined } });
    // No `knownSecrets`: this runtime is not given any. That is the case `CTF-006` made
    // load-bearing — the shared pattern table must make the unconfigured constructor safe,
    // not merely less unsafe.
    this.#redactor = new SecretRedactor();
  }

  /** The bound port, once the health server is listening. */
  public get port(): number | null {
    const address = this.#server?.address();
    return address !== null && typeof address === "object" ? address.port : null;
  }

  public get outcome(): ShutdownOutcome | null {
    return this.#outcome;
  }

  /**
   * Bind health FIRST, then start work.
   *
   * The order matters for a reason that is easy to miss: a process that starts work before
   * binding health can be doing useful work while ECS considers it unhealthy and kills it.
   * Binding first means the very first probe gets an answer — `readyz` will report not-ready
   * until work has started, which is correct rather than a lie.
   */
  public async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handleHealth(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(this.#options.port ?? 8080, () => resolve());
    });

    for (const signal of this.#options.signals ?? ["SIGTERM", "SIGINT"]) {
      const handler = (): void => {
        void this.shutdown(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      };
      process.on(signal, handler);
      this.#listeners.push({ signal, handler });
    }

    try {
      await this.#definition.start();
      this.#logger.info(`${this.#definition.name} started`, { port: this.port });
    } catch (error) {
      // A failed start must still shut down what was bound, or the port leaks and the next
      // task instance cannot bind. Reported as its own reason so an operator can tell
      // "never started" from "started and stopped".
      this.#logger.error(`${this.#definition.name} failed to start`, { error });
      await this.shutdown("START_FAILED");
      throw error;
    }
  }

  /**
   * Shut down in order: unready, stop claiming, drain, close.
   *
   * Idempotent: a second `SIGTERM` (or a signal arriving during shutdown) must not start a
   * second sequence, which would close the database under a drain still in progress.
   */
  public async shutdown(reason: ShutdownReason = "REQUESTED"): Promise<ShutdownOutcome> {
    if (this.#shuttingDown) {
      return this.#outcome ?? { reason, drained: false, clean: false };
    }
    this.#shuttingDown = true;
    this.#logger.info(`${this.#definition.name} shutting down`, { reason });

    let clean = true;
    let drained = true;

    // 1. Stop reporting ready. Health stays BOUND so the probe gets a truthful
    //    not-ready answer rather than a connection refused, which an orchestrator may
    //    interpret as a crash.
    // (handled by #shuttingDown, which readiness consults)

    // 2. Stop accepting new work.
    try {
      await this.#definition.stopAcceptingWork();
    } catch (error) {
      clean = false;
      this.#logger.error("stopAcceptingWork threw", { error });
    }

    // 3. Await in flight, bounded.
    if (this.#definition.drain !== undefined) {
      const deadline = this.#options.drainMs ?? 20_000;
      const timer = new Promise<"TIMEOUT">((resolve) =>
        setTimeout(() => resolve("TIMEOUT"), deadline),
      );
      try {
        const result = await Promise.race([
          this.#definition.drain().then(() => "DRAINED" as const),
          timer,
        ]);
        if (result === "TIMEOUT") {
          drained = false;
          // Reported, not hidden. The durable lease and the reaper make abandoned work
          // recoverable; an unlogged abandonment is what makes it invisible.
          this.#logger.warn("drain deadline exceeded; work in flight was abandoned", {
            deadline_ms: deadline,
          });
        }
      } catch (error) {
        drained = false;
        clean = false;
        this.#logger.error("drain threw", { error });
      }
    }

    // 4. Close resources, then the health server last of all.
    try {
      await this.#definition.close?.();
    } catch (error) {
      clean = false;
      this.#logger.error("close threw", { error });
    }

    for (const { signal, handler } of this.#listeners) process.off(signal, handler);
    this.#listeners = [];

    if (this.#server !== null) {
      await new Promise<void>((resolve) => {
        this.#server!.close(() => resolve());
      });
      this.#server = null;
    }

    this.#outcome = { reason, drained, clean };
    this.#logger.info(`${this.#definition.name} stopped`, { reason, drained, clean });
    return this.#outcome;
  }

  async #handleHealth(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "/";
    // Only two paths. No metrics endpoint, no debug route: this server is reachable from
    // the load balancer, so every additional path is additional surface on the one
    // component an orchestrator must be able to reach.
    if (url !== "/livez" && url !== "/readyz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const responsive = this.#definition.isResponsive();
    const killSwitchActive = (await this.#definition.isKillSwitchActive?.()) ?? false;

    let report: HealthReport;
    if (url === "/livez") {
      // NO database call. Not an optimisation — see the module comment.
      report = liveness({
        processResponsive: responsive,
        // Passed as reachable because liveness must not depend on it; the value is
        // structurally ignored by `liveness`, and a test asserts `postgres` never appears
        // in its report.
        databaseReachable: true,
        killSwitchActive,
      });
    } else {
      report = readiness({
        processResponsive: responsive,
        databaseReachable: await this.#definition.isDatabaseReachable(),
        killSwitchActive,
        // A shutting-down process is draining: report not-ready so the load balancer stops
        // routing, while staying bound so the probe gets an answer.
        draining: this.#shuttingDown,
      });
    }

    // 200 for UP, 503 otherwise. `DEGRADED` is deliberately NOT a 200: a load balancer
    // reads the status code, not the body, so a degraded process returning 200 would keep
    // receiving traffic it cannot serve.
    const status = report.state === HealthState.UP ? 200 : 503;
    response.writeHead(status, { "content-type": "application/json" });
    // REDACTED, like every other output surface in this system.
    //
    // The first version emitted this body raw, on the reasoning that `HealthReport.detail`
    // is written by `health.ts` and carries no credential. A canary test caught it: the
    // health path is reachable from the LOAD BALANCER, so it is the most exposed output in
    // the system, and it was the only one not going through the redactor. That is exactly
    // the `CTF-006` shape — a surface exempted because its current contents happen to be
    // safe, which stops being true the moment someone interpolates an error into a detail.
    response.end(this.#redactor.serialize({ process: this.#definition.name, ...report }));
  }
}
