/**
 * SQL expression builder for authoritative lease time and backoff scheduling
 * (RA-004 MEDIUM-07 / AUDIT-02 MEDIUM-03).
 *
 * Two clocks must be authoritative in production:
 *   1. Lease LIFETIME (expiry, claim eligibility, heartbeat/renewal deadlines,
 *      finalize gates, reap eligibility): PostgreSQL `clock_timestamp()` so two
 *      workers with skewed process clocks cannot reap each other's live lease.
 *   2. Backoff SCHEDULING (`available_at` writes on fail/retry): also
 *      `clock_timestamp()` in production, so a worker with a future-skewed
 *      process clock cannot publish a `available_at` far in the future and cannot
 *      claim early by comparing its skewed clock against a legitimately-set
 *      `available_at`.
 *
 * Tests opt into `'injected'` mode to drive both via ManualClock for determinism.
 *
 * Exports:
 *   - `now(injectedNowParam)`: current instant for comparisons.
 *   - `deadline(injectedNowParam, leaseMsParam)`: `now + leaseMs` for lease writes.
 *   - `scheduleBase(injectedNowParam)`: current instant for scheduling writes
 *     (used as the base of `available_at = scheduleBase + delay`).
 */
import type { LeaseTimeMode } from "./runtime.js";

export interface LeaseTimeSql {
  /**
   * SQL expression for the authoritative current instant.
   * Used in `lease_expires_at > now` / `available_at <= now` comparisons.
   *
   * @param injectedNowParam 1-based positional parameter carrying injected nowMs.
   *   In `'db'` mode the parameter is referenced (zero-cost term) so PG can infer
   *   its type; the actual comparison uses `clock_timestamp()`.
   */
  now(injectedNowParam: number): string;

  /**
   * SQL expression for a new lease deadline (`now + leaseMs`).
   *
   * @param injectedNowParam positional param carrying injected nowMs.
   * @param leaseMsParam positional param carrying the lease duration in ms.
   */
  deadline(injectedNowParam: number, leaseMsParam: number): string;

  /**
   * SQL expression for the scheduling base instant used when writing
   * `available_at` on backoff/retry.  In `'db'` mode this is
   * `clock_timestamp()` so a skewed process clock cannot place
   * `available_at` in a wrong future; in `'injected'` mode it is
   * `to_timestamp($n / 1000.0)` for deterministic test control.
   *
   * Usage: `available_at = ${lt.scheduleBase(1)} + make_interval(secs => $2 / 1000.0)`
   *
   * @param injectedNowParam positional param carrying injected nowMs.
   */
  scheduleBase(injectedNowParam: number): string;
}

/** Build the mode-specific lease-time SQL fragments. */
export function leaseTimeSql(mode: LeaseTimeMode): LeaseTimeSql {
  if (mode === "db") {
    // PostgreSQL server clock is authoritative for both lease lifetime and
    // backoff scheduling in production.
    //
    // The injected `nowMs` parameter is still PRESENT in every query (it feeds
    // non-lease bookkeeping columns such as `leased_at`, `recorded_at`, etc.).
    // We must reference it in expressions that only use the DB clock so that
    // PostgreSQL can infer its type. A zero-cost term (`$n::bigint * interval '0'`)
    // achieves this without affecting the result.
    return {
      now: (injectedNowParam) =>
        `(clock_timestamp() + ($${injectedNowParam}::bigint * interval '0 milliseconds'))`,
      deadline: (injectedNowParam, leaseMsParam) =>
        `(clock_timestamp() + make_interval(secs => $${leaseMsParam}::bigint / 1000.0)` +
        ` + ($${injectedNowParam}::bigint * interval '0 milliseconds'))`,
      scheduleBase: (injectedNowParam) =>
        `(clock_timestamp() + ($${injectedNowParam}::bigint * interval '0 milliseconds'))`,
    };
  }
  // Injected mode: deterministic tests drive both lease lifetime and scheduling
  // via the ManualClock.  Never use in production.
  return {
    now: (injectedNowParam) => `to_timestamp($${injectedNowParam} / 1000.0)`,
    deadline: (injectedNowParam, leaseMsParam) =>
      `to_timestamp(($${injectedNowParam}::bigint + $${leaseMsParam}::bigint) / 1000.0)`,
    scheduleBase: (injectedNowParam) => `to_timestamp($${injectedNowParam} / 1000.0)`,
  };
}
