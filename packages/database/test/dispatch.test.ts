import { describe, expect, it } from "vitest";

import {
  JobType,
  UnknownJobTypeError,
  createJobDispatch,
  isKnownJobType,
} from "../src/queue/dispatch.js";
import type { JobLease } from "../src/queue/job-store.js";

/**
 * `job_type` dispatch (RA-027-WU-03).
 *
 * The property under test is what happens to an UNKNOWN type, because the two tempting
 * alternatives are both silent failures this repository has been burned by:
 *
 *   - ignoring it marks the job done without performing it — work vanishes with a green log
 *     line, which is `CTF-010` finding 4 (treating "no declaration" as consent);
 *   - retrying forever consumes a worker slot indefinitely and never reaches the DLQ, so no
 *     alarm fires. A silent hot loop is harder to notice than a dead-lettered job.
 *
 * Failing closed sends it to the DLQ, where the AC4 alarm sees it.
 */
function lease(jobType: string): JobLease {
  return {
    jobId: `job-${jobType}`,
    caseId: "case-1",
    jobType,
    payload: {},
    provider: null,
    serializationKey: null,
    attempts: 1,
    maxAttempts: 5,
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 60_000,
    leaseOwner: "worker-1",
  };
}

const noopHeartbeat = async (): Promise<void> => undefined;

describe("job dispatch routes by job_type", () => {
  it("calls the handler registered for the type", async () => {
    const seen: string[] = [];
    const dispatch = createJobDispatch({
      [JobType.CASE_RESUME]: async (claimed) => {
        seen.push(claimed.jobType);
      },
    });
    await dispatch(lease(JobType.CASE_RESUME), noopHeartbeat);
    expect(seen).toEqual(["case.resume"]);
  });

  it("passes the lease AND the heartbeat through", async () => {
    // The heartbeat is what keeps a long job from being reaped mid-work. A dispatch that
    // dropped it would make every slow job look like a dead worker.
    let beats = 0;
    const dispatch = createJobDispatch({
      [JobType.AGENT_IMPLEMENTER]: async (_claimed, heartbeat) => {
        await heartbeat();
        await heartbeat();
      },
    });
    await dispatch(lease(JobType.AGENT_IMPLEMENTER), async () => {
      beats += 1;
    });
    expect(beats).toBe(2);
  });

  it("routes each type to its OWN handler", async () => {
    // A dispatch that called the first registered handler for everything would pass a
    // single-type test.
    const calls: string[] = [];
    const dispatch = createJobDispatch({
      [JobType.CASE_RESUME]: async () => {
        calls.push("resume");
      },
      [JobType.JIRA_WEBHOOK_RENEWAL]: async () => {
        calls.push("renewal");
      },
    });
    await dispatch(lease(JobType.JIRA_WEBHOOK_RENEWAL), noopHeartbeat);
    await dispatch(lease(JobType.CASE_RESUME), noopHeartbeat);
    expect(calls).toEqual(["renewal", "resume"]);
  });

  it("propagates a handler's failure rather than swallowing it", async () => {
    // `Scheduler` turns a thrown handler into a bounded retry and then the DLQ. A dispatch
    // that caught the error would mark failed work as done.
    const dispatch = createJobDispatch({
      [JobType.CASE_RESUME]: async () => {
        throw new Error("handler exploded");
      },
    });
    await expect(dispatch(lease(JobType.CASE_RESUME), noopHeartbeat)).rejects.toThrow(
      /handler exploded/,
    );
  });
});

describe("an unknown job_type fails closed", () => {
  it("throws UnknownJobTypeError rather than returning quietly", async () => {
    // THE assertion of this suite. Returning would mark the job SUCCEEDED without doing it.
    const dispatch = createJobDispatch({});
    await expect(
      dispatch(lease("something.nobody.registered"), noopHeartbeat),
    ).rejects.toBeInstanceOf(UnknownJobTypeError);
  });

  it("names the type in the error, so the DLQ row is actionable", async () => {
    // An operator reading `attemptHistory` needs to know WHICH type had no handler.
    const dispatch = createJobDispatch({});
    await expect(dispatch(lease("mystery.type"), noopHeartbeat)).rejects.toThrow(/mystery\.type/);
  });

  it("reports its own class name, not the parent's", async () => {
    // `this.name` from a literal made a subclass indistinguishable from its parent in every
    // log line and every branch on `name` — the finding from `CTF-001`'s closure.
    const error = new UnknownJobTypeError("x");
    expect(error.name).toBe("UnknownJobTypeError");
    expect(error.jobType).toBe("x");
  });

  it("fails closed for a KNOWN type that this worker does not handle", async () => {
    // Not the same as an unknown type, and just as important: a deployment may run a worker
    // that handles only some types. A worker that cannot do the work must not claim it as
    // done.
    const dispatch = createJobDispatch({ [JobType.CASE_RESUME]: async () => undefined });
    await expect(dispatch(lease(JobType.AGENT_IMPLEMENTER), noopHeartbeat)).rejects.toBeInstanceOf(
      UnknownJobTypeError,
    );
  });
});

describe("the job type registry matches production", () => {
  it("recognises exactly the five types production enqueues", () => {
    // Verified by grep against production code, not invented: `case.resume`
    // (`decision-resume.ts`, `case-recovery.ts`), `jira.webhook.renewal`
    // (`connector-jira/src/webhook/*`), `agent.implementer` (`WRITER_JOB_TYPE`),
    // `jira.reconcile` (`apps/scheduler/src/jira-reconcile-task.ts`, RA-029), and
    // the case-less code-owned `agent.engineering_recovery` coordinator (RA-047).
    expect(Object.values(JobType).sort()).toEqual([
      "agent.engineering_recovery",
      "agent.implementer",
      "case.resume",
      "jira.reconcile",
      "jira.webhook.renewal",
    ]);
  });

  it("isKnownJobType accepts the five and rejects a plausible near-miss", () => {
    for (const known of Object.values(JobType)) {
      expect(isKnownJobType(known)).toBe(true);
    }
    // A closed set, not a pattern match. `jira.*` would silently absorb a future
    // `jira.issue.delete` at whatever handler the pattern happened to hit — the same
    // reasoning `ACTION_REGISTRY` uses.
    for (const unknown of ["jira.webhook", "jira.webhook.renewal.retry", "case.resumed", ""]) {
      expect(isKnownJobType(unknown), unknown).toBe(false);
    }
  });
});
