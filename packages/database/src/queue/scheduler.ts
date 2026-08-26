/**
 * Scheduler / polling interface for the durable queue (RA-004).
 *
 * The concrete Discord/provider worker is out of scope for RA-004; this module
 * provides the deterministic polling loop the scheduler app (a later task) drives.
 * A {@link Scheduler} periodically:
 *   1. reaps expired leases ({@link JobStore.reapExpired}) so crashed workers'
 *      jobs are recovered (RECONCILING or requeued);
 *   2. relays pending outbox messages ({@link OutboxRepository.relayOnce});
 *   3. optionally claims and runs one job through a supplied handler.
 *
 * Everything is driven by the injected {@link Clock}, and {@link tick} performs a
 * single, awaited pass so tests advance time and step the loop deterministically
 * (no real timers). {@link run}/{@link stop} provide a production loop on top of
 * `setTimeout`, but the core logic under test is `tick`.
 */
import type { Queryable, Transaction } from "../client.js";
import type { JobStore, JobLease, JobStatus, ClaimOptions, ReapResult } from "./job-store.js";
import type { OutboxRepository, OutboxSink, RelayResult } from "./outbox.js";
import type { Clock } from "./runtime.js";

/**
 * A job handler runs the claimed work. It receives the lease and a `heartbeat`
 * callback it SHOULD call periodically during long work to renew the lease
 * (audit RA-004 MEDIUM-07), so a slow-but-live worker is not reaped. A thrown
 * handler is treated as failed work (bounded retry); a successful return leads
 * to completion.
 */
export type JobHandler = (lease: JobLease, heartbeat: () => Promise<void>) => Promise<void>;

/** Code-owned lane for jobs that generic claim/reap deliberately cannot touch. */
export interface SchedulerContinuationLane {
  /** Materialize/classify at most one recovery before generic reap. */
  readonly prepare: () => Promise<void>;
  /** Dedicated claim of one already-classified continuation. */
  readonly claim: () => Promise<JobLease | null>;
  /** Fail closed without routing the continuation through generic PENDING retry. */
  readonly suspend: (lease: JobLease, error: string) => Promise<void>;
}

export interface SchedulerDeps {
  db: Queryable & { withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> };
  jobs: JobStore;
  outbox: OutboxRepository;
  clock: Clock;
  sink: OutboxSink;
  handler: JobHandler;
  continuation?: SchedulerContinuationLane;
  claim?: ClaimOptions;
  /**
   * Relay pass options. `aggregates` (ADR-0009) scopes this process's relay to the outbox
   * aggregates it can deliver; omit to relay everything. `tick` forwards it to `relayOnce`.
   */
  relay?: { batchSize?: number; leaseMs?: number; aggregates?: readonly string[] };
  reap?: { limit?: number };
  /** Poll interval for the production loop (ms). */
  intervalMs?: number;
}

export interface TickResult {
  reaped: ReapResult;
  relay: RelayResult;
  claimedJobId: string | null;
  jobOutcome: JobStatus | "SUCCEEDED" | "RECONCILING" | null;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Perform exactly one scheduler pass and return what happened. Deterministic:
   * no timers, no hidden clock reads. When a job is claimed the handler is run;
   * a thrown handler is turned into a bounded retry / DLQ via
   * {@link JobStore.fail}, so a single tick never leaves a claimed job leaked.
   */
  public async tick(): Promise<TickResult> {
    const { db, jobs, outbox, sink, handler } = this.deps;

    await this.deps.continuation?.prepare();
    const reaped = await jobs.reapExpired(db, this.deps.reap);
    const relay = await outbox.relayOnce(db, sink, this.deps.relay);

    const continuationLease = (await this.deps.continuation?.claim()) ?? null;
    const lease = continuationLease ?? (await jobs.claim(db, this.deps.claim));
    if (lease === null) {
      return { reaped, relay, claimedJobId: null, jobOutcome: null };
    }

    let jobOutcome: JobStatus | "SUCCEEDED" = "SUCCEEDED";
    // Separate a HANDLER failure (the work itself failed → bounded retry is safe)
    // from a FINALIZATION failure (the work SUCCEEDED but persisting completion
    // failed → the side effect may already have happened, so retry would replay
    // it). Only a handler failure is routed to `fail`; a finalization failure is
    // surfaced (never turned into a retry), leaving lease expiry + reconciliation
    // to recover it safely (audit HIGH-02).
    let handlerSucceeded = false;
    try {
      // The handler may renew its lease during long work (audit MEDIUM-07).
      const heartbeat = async (): Promise<void> => {
        await jobs.heartbeat(db, lease);
      };
      await handler(lease, heartbeat);
      handlerSucceeded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (continuationLease !== null && this.deps.continuation !== undefined) {
        await this.deps.continuation.suspend(lease, message);
        jobOutcome = "RECONCILING";
      } else {
        jobOutcome = await jobs.fail(db, lease, message);
      }
      return { reaped, relay, claimedJobId: lease.jobId, jobOutcome };
    }
    // Handler succeeded: finalize. A failure here must NOT retry the handler; the
    // work already ran, so a `complete` error is FINALIZATION ambiguity. Route it
    // to a lease-conditioned recovery that resolves the ambiguity by observing
    // durable state (SUCCEEDED if the completion committed, else RECONCILING),
    // never PENDING and never a bounded retry (audit HIGH-02).
    if (handlerSucceeded) {
      try {
        await jobs.complete(db, lease);
        jobOutcome = "SUCCEEDED";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        jobOutcome = await jobs.holdFinalizationAmbiguous(db, lease, message);
      }
    }
    return { reaped, relay, claimedJobId: lease.jobId, jobOutcome };
  }

  /** Start a production polling loop. Idempotent. */
  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const interval = this.deps.intervalMs ?? 1000;
    const loop = async (): Promise<void> => {
      if (!this.running) {
        return;
      }
      try {
        await this.tick();
      } catch {
        // A tick failure must not kill the loop; the next pass retries. Concrete
        // observability/alerting is layered by the scheduler app (later task).
      } finally {
        if (this.running) {
          this.timer = setTimeout(() => void loop(), interval);
        }
      }
    };
    this.timer = setTimeout(() => void loop(), interval);
  }

  /** Stop the production polling loop. */
  public stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
