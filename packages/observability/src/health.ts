/**
 * Health and readiness (RA-024-WU-06).
 *
 * THE TWO ARE NOT THE SAME CHECK, and conflating them is the actual failure mode
 * this module exists to prevent. An orchestrator restarts a container that reports
 * unhealthy and merely stops sending it work when it reports not-ready. So:
 *
 *   - **liveness** answers "is this process wedged?" and must NOT depend on
 *     PostgreSQL. A database outage that reported unhealthy would make every worker
 *     restart-loop during the exact incident when their in-flight leases and their
 *     logs are the only evidence available — turning a recoverable outage into
 *     evidence loss (`EVIDENCE_LOSS` in the threat model);
 *   - **readiness** answers "should this process receive work?" and MUST depend on
 *     PostgreSQL, because a worker that cannot reach the system of record cannot
 *     claim a lease, cannot record a receipt, and must not start an external effect
 *     it would be unable to record.
 *
 * A kill switch deliberately affects NEITHER. It stops external effects while
 * preserving reads and evidence (AC6); reporting unready during a kill switch would
 * stop the reconciliation and audit reads an operator needs mid-incident.
 */

export const HealthState = {
  /** The process is functioning. */
  UP: "UP",
  /** The process is running but should not be given work. */
  DEGRADED: "DEGRADED",
  /** The process cannot function and should be replaced. */
  DOWN: "DOWN",
} as const;

export type HealthState = (typeof HealthState)[keyof typeof HealthState];

/** One dependency's observed state. */
export interface DependencyCheck {
  readonly name: string;
  readonly state: HealthState;
  /** Why, for an operator. Redacted by the caller before it reaches a response body. */
  readonly detail?: string;
}

export interface HealthReport {
  readonly state: HealthState;
  readonly checks: readonly DependencyCheck[];
}

/** What the two probes are computed from. */
export interface HealthInput {
  /** Whether the process's own event loop and workers are responsive. */
  readonly processResponsive: boolean;
  /** Whether the system of record is reachable. */
  readonly databaseReachable: boolean;
  /**
   * Whether an operator kill switch is active.
   *
   * Recorded in the report so an operator can see it, but deliberately NOT allowed
   * to change either verdict — see the module comment.
   */
  readonly killSwitchActive: boolean;
  /**
   * Whether this process still holds leases it has not finished.
   *
   * Makes readiness drain gracefully: a shutting-down worker reports unready while
   * it finishes, instead of being handed new work it will abandon.
   */
  readonly draining?: boolean;
}

/**
 * Liveness. Deliberately narrow: only the process's own responsiveness.
 *
 * Returning `DOWN` here asks an orchestrator to KILL this process, so anything that
 * a restart cannot fix must not appear in it. A database outage is not fixed by a
 * restart; a wedged event loop is.
 */
export function liveness(input: HealthInput): HealthReport {
  const checks: DependencyCheck[] = [
    {
      name: "process",
      state: input.processResponsive ? HealthState.UP : HealthState.DOWN,
      ...(input.processResponsive ? {} : { detail: "worker loop is not responsive" }),
    },
  ];
  // Reported, never load-bearing: an operator reading /health during an incident
  // needs to know a stop is active, and hiding it would make the report misleading.
  if (input.killSwitchActive) {
    checks.push({
      name: "kill_switch",
      state: HealthState.UP,
      detail: "a kill switch is active; external effects are stopped, reads continue",
    });
  }
  return {
    state: input.processResponsive ? HealthState.UP : HealthState.DOWN,
    checks,
  };
}

/**
 * Readiness. Depends on the system of record, and on not draining.
 *
 * `DEGRADED` rather than `DOWN` when the database is unreachable: the process is
 * fine and will recover on its own once the database returns, so it must not be
 * killed — only starved of new work.
 */
export function readiness(input: HealthInput): HealthReport {
  const checks: DependencyCheck[] = [
    {
      name: "process",
      state: input.processResponsive ? HealthState.UP : HealthState.DOWN,
    },
    {
      name: "postgres",
      state: input.databaseReachable ? HealthState.UP : HealthState.DEGRADED,
      ...(input.databaseReachable
        ? {}
        : { detail: "system of record unreachable; no lease may be claimed" }),
    },
  ];
  if (input.draining === true) {
    checks.push({
      name: "drain",
      state: HealthState.DEGRADED,
      detail: "finishing held leases; not accepting new work",
    });
  }
  if (input.killSwitchActive) {
    checks.push({
      name: "kill_switch",
      state: HealthState.UP,
      detail: "a kill switch is active; external effects are stopped, reads continue",
    });
  }

  if (!input.processResponsive) return { state: HealthState.DOWN, checks };
  if (!input.databaseReachable || input.draining === true) {
    return { state: HealthState.DEGRADED, checks };
  }
  return { state: HealthState.UP, checks };
}
