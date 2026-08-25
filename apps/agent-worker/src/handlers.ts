import type { AgentCompletion } from "@remoteagent/contracts";
import {
  FairScheduler,
  SupervisorRuntime,
  WRITER_JOB_TYPE,
  WriterLeaseGuard,
  prepareCompletion,
  type RuntimeRoles,
} from "@remoteagent/agent-orchestrator";
import {
  JobType,
  type Database,
  type JobLease,
  type JobStore,
  type JobTypeHandlers,
} from "@remoteagent/database";
import type { StructuredLogger } from "@remoteagent/observability";

import { projectCompletionReply } from "./completion-reply.js";
import type { WorkerPersistence } from "./persistence.js";

/**
 * The `job_type` handlers (RA-028-WU-03..WU-05).
 *
 * This is the seam RA-027 left open at `worker.ts:204` (`handlers: {}`), and closing it is
 * what turns a process that STARTS into a process that DOES WORK.
 *
 * WHY THE COMPLETION BRIDGE LIVES HERE. `RuntimePersistence.persistCompletion` receives a
 * raw `AgentCompletion`, but `RunCompletionRepository.apply()` — the audited transactional
 * path — requires a PREPARED value: completion plus the advanced checkpoint, the run's
 * terminal safety state and the outbox payload, all mutually consistent. `prepareCompletion`
 * (pure, in the orchestrator) produces exactly that. So this module reads the current
 * checkpoint, prepares, and hands the result to the adapter.
 *
 * The alternative — persisting the completion with a plain INSERT, as the promoted harness
 * code did — silently drops the checkpoint advance and the outbox event. The run would be
 * recorded and nothing downstream would ever learn it finished.
 */

export interface HandlerDependencies {
  readonly persistence: WorkerPersistence;
  readonly roles: RuntimeRoles;
  readonly logger: StructuredLogger;
  /** Needed only by the implementer path, to assert the durable writer lease. */
  readonly db: Database;
  readonly jobs: JobStore;
  /** Bounded per pump pass; a runaway role cannot hold a job lease indefinitely. */
  readonly maxSteps?: number;
}

/**
 * One `SupervisorRuntime` per pass rather than one per process.
 *
 * The runtime holds in-memory unit state rebuilt by `recover()`. Sharing one instance
 * across jobs would carry another case's state into this job's pass, and `pumpOnce()` is
 * single-flight — so two concurrent jobs would silently serialise on the same promise,
 * with the second observing the first's result as its own.
 */
function runtimeFor(deps: HandlerDependencies, writerLease?: JobLease): SupervisorRuntime {
  const scheduler = new FairScheduler({ globalLimit: 1 });
  const guard = new WriterLeaseGuard<Database>({
    assertCurrentLease: (query, lease) => deps.jobs.assertCurrentLease(query, lease),
  });
  return new SupervisorRuntime({
    persistence: {
      listCaseIds: () => deps.persistence.listCaseIds(),
      recover: (caseId) => deps.persistence.recover(caseId),
      claim: (input) => deps.persistence.claim(input),
      start: (input) => deps.persistence.start(input),
      persistCompletion: async (input) =>
        persistThroughAuditedPath(deps, input.completion, input.run.runId),
      finalize: (input) => deps.persistence.finalize(input),
      markAmbiguous: (input) => deps.persistence.markAmbiguous(input),
    },
    roles: deps.roles,
    scheduler: {
      enqueue: (unit) => {
        scheduler.enqueue(unit);
      },
      acquire: () => scheduler.acquire(),
    },
    makeRunId: () => deps.persistence.nextRunId(),
    // AC3. Supplied ONLY when this pass runs under an `agent.implementer` job lease. A
    // `case.resume` pass has no writer lease, so an IMPLEMENTER unit reached from it fails
    // closed with "IMPLEMENTER requires writer authority" rather than writing without a
    // fence. That is the correct outcome: the writer must run under its own durable lease.
    ...(writerLease === undefined
      ? {}
      : {
          writerAuthority: {
            acquire: async (input) => {
              const result = await guard.acquire(deps.db, {
                workUnit: input.unit,
                lease: {
                  jobId: writerLease.jobId,
                  caseId: writerLease.caseId,
                  leaseOwner: writerLease.leaseOwner,
                  fencingToken: writerLease.fencingToken,
                  jobType: writerLease.jobType,
                  payload: writerLease.payload,
                },
              });
              if (result.kind !== "WRITE") {
                throw new Error("writer lease did not grant write authority");
              }
              // `assertCurrent` is re-checked immediately before each mutation, so a lease
              // lost mid-pass (expiry, reap, a newer holder) stops the writer instead of
              // letting two processes write one workspace.
              return { assertCurrent: () => result.fence.assertCurrent(deps.db) };
            },
          },
        }),
  });
}

/**
 * Prepare and apply a completion through `RunCompletionRepository.apply()`.
 *
 * `apply()` is idempotent by identity: a replay of the same completion returns
 * `replayed: true` rather than conflicting, which is what makes a job retry after a lost
 * lease safe.
 */
async function persistThroughAuditedPath(
  deps: HandlerDependencies,
  completion: AgentCompletion,
  runId: string,
): Promise<{ replayed: boolean }> {
  let current = await deps.persistence.latestCheckpoint(completion.case_id);
  if (current === null) {
    // CTF-020: nothing in production ever wrote a case's FIRST checkpoint, so the first completion
    // of any run on a fresh case threw here — silently breaking the reply loop (RA-031/032) and the
    // implementer loop (RA-034). Create the revision-0 baseline lazily and advance from it, rather
    // than failing the whole pass. Idempotent; leaves `cases.checkpoint_revision` at 0 so the run
    // (claimed at 0) still satisfies `apply()`'s `run.checkpoint_revision === checkpoint.revision-1`.
    current = await deps.persistence.ensureBaselineCheckpoint(completion.case_id);
  }
  const prepared = prepareCompletion({
    completion,
    current,
    system: {
      completionId: deps.persistence.nextCompletionId(),
      runId,
      caseId: completion.case_id,
      expectedRevision: (current as { revision: number }).revision,
      finishedAt: deps.persistence.nowIso(),
    },
  });
  const result = await deps.persistence.persistPrepared(prepared);
  // RA-032: deliver the agent's reply to the case's Discord thread (idempotent on run id;
  // no-op when the case has no thread). Separate from the completion commit — see the note in
  // `completion-reply.ts` on the (LOW, recoverable) crash window.
  await projectCompletionReply({
    db: deps.db,
    caseId: completion.case_id,
    runId,
    body: completion.summary,
  });
  return result;
}

/**
 * `case.resume` — an owner answered a decision, or recovery found unfinished work.
 *
 * THE EXPLICIT `recover()` IS FOR THE HEARTBEAT, NOT FOR CORRECTNESS. My first comment here
 * claimed it was required because a fresh runtime knows nothing about the case until recovery
 * reads it — and a mutation deleting the call stayed GREEN, which proved the claim false:
 * `pumpOnce()` calls `recover()` itself, and it is single-flight, so the work happens either
 * way.
 *
 * What the explicit call buys is a heartbeat between recovery and the pump. Recovery reads
 * every unfinished case, which on a loaded database is the slow part; extending the job lease
 * before the model call means a slow recovery cannot cause the lease to be reaped while the
 * pass is still legitimately running. Kept for that reason, stated honestly, rather than
 * removed — but it is a latency guard, not an invariant.
 */
export function createCaseResumeHandler(deps: HandlerDependencies, asWriter = false) {
  return async (lease: JobLease, heartbeat: () => Promise<void>): Promise<void> => {
    const runtime = runtimeFor(deps, asWriter ? lease : undefined);
    await runtime.recover();
    await heartbeat();
    const result = await runtime.pumpOnce();
    deps.logger.info("case.resume pass complete", {
      job_id: lease.jobId,
      case_id: lease.caseId,
      progressed: result.progressed,
      ambiguous: result.ambiguous.length,
      blocked: result.blocked.length,
      waiting: result.waiting.length,
    });

    // `SupervisorRuntime.pumpOnce()` DOES NOT THROW ON A FAILED UNIT. It catches every
    // error from a role invocation or a persistence call and reports the unit as
    // `ambiguous` or `blocked`. That is right for the runtime: it keeps the pass going and
    // leaves a durable marker, and it CANNOT know whether a failure after `start` left an
    // external effect behind — so it conservatively assumes it might have.
    //
    // It is NOT right for a job handler to resolve on that. Resolving tells `Scheduler` the
    // job SUCCEEDED, so the job is marked done and never retried while the work did not
    // happen — the silent-success shape this repository treats as worse than a crash. It is
    // exactly what these tests caught: the handler resolved and the database was empty.
    //
    // WHY THROWING HERE IS NOT A BLIND REPLAY (`AGENTS.md` §6). Throwing sends the job to
    // bounded retry and then the DLQ, where an alarm fires. The retry cannot re-run the
    // failed unit: `markAmbiguous` has recorded it durably, and `recover()` leaves a RUNNING
    // unit with no confirmed completion out of the scheduler entirely — so a retry re-reports
    // the same ambiguity and never re-invokes the model. The DLQ is where a human should
    // look, and getting there requires the job to fail.
    const unresolved = [...result.ambiguous, ...result.blocked];
    if (unresolved.length > 0) {
      deps.logger.warn("pass left unresolved work", {
        job_id: lease.jobId,
        ambiguous: result.ambiguous,
        blocked: result.blocked,
      });
      throw new Error(
        `case.resume did not complete its work; ambiguous: [${result.ambiguous.join(", ")}], ` +
          `blocked: [${result.blocked.join(", ")}]`,
      );
    }
  };
}

/**
 * `agent.implementer` — the writer unit.
 *
 * The single-writer invariant is NOT enforced here. `SupervisorRuntime` already refuses to
 * select a second IMPLEMENTER for a case whose writer is active or ambiguous, and the
 * durable `agent_runs` state is what `recover()` reads. Re-implementing the check in this
 * handler would create a second, divergent authority for the same invariant — and the
 * handler is the weaker of the two, since it cannot see other processes.
 */
export function createImplementerHandler(deps: HandlerDependencies) {
  const resume = createCaseResumeHandler(deps, true);
  return async (lease: JobLease, heartbeat: () => Promise<void>): Promise<void> => {
    // Fail closed on the job type before doing any work: `WriterLeaseGuard` requires the
    // lease to carry `WRITER_JOB_TYPE`, and reaching it with anything else would surface as
    // a confusing scope error rather than the actual problem.
    if (lease.jobType !== WRITER_JOB_TYPE) {
      throw new Error(`implementer handler received job_type ${lease.jobType}`);
    }
    await resume(lease, heartbeat);
  };
}

/**
 * `jira.webhook.renewal` — renews a Jira webhook registration before it expires.
 *
 * WHY THIS ONE IS INJECTED RATHER THAN BUILT HERE. `JiraWebhookRenewalService.runWorker`
 * requires a `JiraWebhookConfig` and a `JiraWebhookRegistrationClient` holding a live access
 * token — deployment configuration and a secret, neither of which this task owns. Building a
 * half-configured client here would fail at the first renewal with a confusing auth error.
 *
 * Passing it in means a deployment that HAS the config registers a working handler, and one
 * that does not registers nothing — so the job fails closed to the DLQ with
 * `UnknownJobTypeError`, exactly like any other unhandled type. That is a visible, alarmed
 * "not configured", not a silent drop.
 */
export function createRenewalHandler(
  run: (lease: JobLease) => Promise<void>,
): (lease: JobLease, heartbeat: () => Promise<void>) => Promise<void> {
  return async (lease, heartbeat) => {
    await heartbeat();
    await run(lease);
  };
}

/**
 * Build the handler map the worker's dispatch routes on.
 *
 * `extra` exists so `jira.webhook.renewal` can be added by a deployment that has the Jira
 * config, without this module depending on it.
 */
export function createWorkerHandlers(
  deps: HandlerDependencies,
  extra: JobTypeHandlers = {},
): JobTypeHandlers {
  return {
    [JobType.CASE_RESUME]: createCaseResumeHandler(deps),
    [JobType.AGENT_IMPLEMENTER]: createImplementerHandler(deps),
    ...extra,
  };
}
