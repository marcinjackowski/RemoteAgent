/**
 * `job_type` → handler dispatch (RA-027-WU-03).
 *
 * The one piece of RA-027 that is not wiring. `Scheduler` already claims a job and calls a
 * `JobHandler`, but nothing decided WHICH work a given `job_type` means — so this is the
 * table that turns a durable row into an action.
 *
 * THE UNKNOWN TYPE IS THE INTERESTING CASE, and it is fail-closed. An unregistered
 * `job_type` is NOT silently ignored and NOT retried forever: it is a hard failure, which
 * `Scheduler` turns into a bounded retry and then the DLQ, where the AC4 alarm sees it.
 *
 * The alternatives are both worse, and both are shapes this repository has been burned by:
 *
 *   - **ignore it** — the job is claimed, marked done and never performed. Work vanishes
 *     with a green log line. That is `CTF-010` finding 4: treating "no declaration" as
 *     consent;
 *   - **retry forever** — the job is claimed and released in a loop, consuming a worker
 *     slot indefinitely and never reaching the DLQ, so no alarm fires. A silent hot loop is
 *     harder to notice than a dead-lettered job.
 *
 * So an unknown type reaches the DLQ, which is exactly where a human should look at it.
 *
 * THE REGISTRY IS CLOSED AND MATCHES PRODUCTION. Every key below is a `job_type` some
 * production code actually enqueues — verified by grep, not invented. Adding a pattern
 * match (`jira.*`) would silently absorb a future `jira.issue.delete` at whatever handler
 * the pattern happened to hit, which is the same reasoning `ACTION_REGISTRY` uses.
 */
import type { JobLease } from "./job-store.js";
import type { JobHandler } from "./scheduler.js";

/**
 * Job types this system enqueues.
 *
 * `case.resume` — `decision-resume.ts` and `case-recovery.ts`.
 * `jira.webhook.renewal` — `connector-jira/src/webhook/{registration,renewal}.ts`.
 * `agent.implementer` — `WRITER_JOB_TYPE` in `agent-orchestrator`.
 * `agent.engineering_recovery` — RA-047 case-less recovery coordinator.
 */
export const JobType = {
  /** An owner answered a decision; the case resumes from its checkpoint. */
  CASE_RESUME: "case.resume",
  /** A Jira webhook registration is due for renewal. */
  JIRA_WEBHOOK_RENEWAL: "jira.webhook.renewal",
  /** A Jira project is due for reconciliation (poll changed issues, correlate into cases). */
  JIRA_RECONCILE: "jira.reconcile",
  /** An agent implementation unit; holds the single-writer lease for its case. */
  AGENT_IMPLEMENTER: "agent.implementer",
  /** Case-less, read/repair-only classifier for one parked engineering fence. */
  AGENT_ENGINEERING_RECOVERY: "agent.engineering_recovery",
} as const;

export type JobType = (typeof JobType)[keyof typeof JobType];

/** Thrown for a `job_type` no handler claims. Distinct so a test can assert on it. */
export class UnknownJobTypeError extends Error {
  public constructor(public readonly jobType: string) {
    super(
      `no handler registered for job_type ${jobType}; failing closed so the job reaches ` +
        `the DLQ rather than being silently dropped or retried forever`,
    );
    // `new.target.name` rather than a literal, so a future subclass reports its own name.
    // A literal made a subclass indistinguishable from its parent in every log line — the
    // finding from `CTF-001`'s closure.
    this.name = new.target.name;
  }
}

/** One handler, plus the type it serves. */
export type JobTypeHandlers = Readonly<Partial<Record<JobType, JobHandler>>>;

/**
 * Build a `JobHandler` that routes by `job_type`.
 *
 * Takes a partial map on purpose: a deployment may run a worker that handles only some
 * types (the executor process handles none of these, for instance). An unregistered type
 * then fails closed exactly as an unknown one does, which is the correct behaviour — a
 * worker that cannot do the work should not claim it as done.
 */
export function createJobDispatch(handlers: JobTypeHandlers): JobHandler {
  return async (lease: JobLease, heartbeat: () => Promise<void>): Promise<void> => {
    const handler = handlers[lease.jobType as JobType];
    if (handler === undefined) {
      throw new UnknownJobTypeError(lease.jobType);
    }
    await handler(lease, heartbeat);
  };
}

/** Whether a string is a known job type. Exported so an enqueue site can check first. */
export function isKnownJobType(value: string): value is JobType {
  return (Object.values(JobType) as string[]).includes(value);
}
