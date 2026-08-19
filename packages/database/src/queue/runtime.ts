/**
 * Deterministic runtime ports for the durable queue (RA-004).
 *
 * The job store, outbox relay, lease reaper and reconciliation logic must be
 * fully deterministic under test (task RA-004 scope: "deterministic clock/id
 * generator in tests" and audit focus: "clock assumptions"). All time and
 * identity therefore flow through two small ports instead of calling `Date.now`
 * / `randomUUID` directly:
 *
 *   - {@link Clock} yields the current instant. Production uses the system
 *     clock; tests use {@link ManualClock}, which only advances when the test
 *     advances it, so backoff windows, lease expiry and heartbeats are exact.
 *   - {@link IdGenerator} yields opaque ids. Production uses UUIDv4; tests use
 *     {@link SequentialIdGenerator}, so generated ids are reproducible.
 *
 * Time is represented as a millisecond epoch `number` at the port boundary and
 * converted to `timestamptz` in SQL via `to_timestamp(ms / 1000.0)`, so the
 * database never reads its own `now()` on a path that a test needs to control.
 *
 * AUTHORITATIVE TIME (audit RA-004 MEDIUM-07): lease expiry, heartbeat and reap
 * boundaries are all evaluated against the {@link Clock} instance passed to the
 * queue components. All workers sharing a queue MUST derive lease time from ONE
 * authoritative source, not from independent per-process wall clocks that may be
 * skewed. In production this means either (a) a single scheduler process (the
 * RA-004 delivery is a single deterministic loop; the concrete multi-process
 * worker is a later task), or (b) injecting a clock backed by the database's own
 * time. {@link SystemClock} is only safe when a single process owns reaping, or
 * when process clocks are tightly synchronized (e.g. NTP with a bounded skew
 * smaller than the lease). A future multi-process worker task MUST inject a
 * DB-backed clock so no worker can reap a peer's still-live lease due to skew.
 */
import { randomUUID } from "node:crypto";

/** A source of the current time. */
export interface Clock {
  /** Current time as milliseconds since the Unix epoch. */
  now(): number;
}

/** A source of opaque unique identifiers. */
export interface IdGenerator {
  /** A fresh identifier, optionally namespaced by `prefix` for readability. */
  next(prefix?: string): string;
}

/** Production clock backed by the system wall clock. */
export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }
}

/** Production id generator backed by UUIDv4. */
export class UuidGenerator implements IdGenerator {
  public next(prefix?: string): string {
    const id = randomUUID();
    return prefix === undefined ? id : `${prefix}_${id}`;
  }
}

/**
 * A manually-advanced clock for deterministic tests. Never moves on its own.
 */
export class ManualClock implements Clock {
  private current: number;

  public constructor(startMs = 0) {
    this.current = startMs;
  }

  public now(): number {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds and return the new instant. */
  public advance(ms: number): number {
    if (ms < 0) {
      throw new RangeError("ManualClock cannot move backwards");
    }
    this.current += ms;
    return this.current;
  }

  /** Set the clock to an absolute instant (must not move backwards). */
  public set(ms: number): number {
    if (ms < this.current) {
      throw new RangeError("ManualClock cannot move backwards");
    }
    this.current = ms;
    return this.current;
  }
}

/**
 * A deterministic, strictly-increasing id generator for tests. Ids are
 * `${prefix}-${n}` (or `id-${n}` with no prefix), so a test can assert exact
 * identifiers and ordering.
 */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  public next(prefix = "id"): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}

/**
 * Which time source is AUTHORITATIVE for lease LIFETIME comparisons — lease
 * expiry, claim eligibility, heartbeat/renewal deadlines, finalize gates and
 * reap eligibility (audit RA-004 MEDIUM-07).
 *
 *   - `'db'` (DEFAULT / production): the PostgreSQL server clock
 *     (`clock_timestamp()`) is the single authoritative source. All lease
 *     lifetime is measured against the DB, so two workers with wildly skewed
 *     process wall clocks can NEVER reap or take over each other's live lease.
 *     The injected {@link Clock} is still used for scheduling/backoff timestamps
 *     (available_at, recorded_at, attempt times), which are not safety-critical
 *     for mutual exclusion.
 *   - `'injected'` (OPT-IN, tests only): the injected {@link Clock} governs
 *     lease lifetime too, so a {@link ManualClock} can drive expiry
 *     deterministically. This MUST be requested explicitly; it is never the
 *     implicit default, so production cannot accidentally depend on process time
 *     for mutual exclusion.
 */
export type LeaseTimeMode = "db" | "injected";

/** Bundle of the deterministic ports a queue component depends on. */
export interface QueueRuntime {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Authoritative source for lease lifetime. Defaults to `'db'` (PostgreSQL
   * server clock). Tests that need deterministic lease expiry opt in with
   * `'injected'`.
   */
  readonly leaseTime?: LeaseTimeMode;
}

/** Build the production runtime (system clock + UUID ids, DB lease time). */
export function productionRuntime(): QueueRuntime {
  return { clock: new SystemClock(), ids: new UuidGenerator(), leaseTime: "db" };
}
