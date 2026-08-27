import { afterEach, beforeEach, expect, it } from "vitest";

import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  createJobDispatch,
  type Database,
  type JobLease,
} from "@remoteagent/database";
import { StructuredLogger } from "@remoteagent/observability";

import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { createRenewalHandler, createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";
import { createRoles } from "../src/roles.js";

const available = await ensurePostgres();

/**
 * The `job_type` handlers, against a REAL database (RA-028-WU-03..WU-06).
 *
 * THE ASSERTIONS READ THE DATABASE, NOT THE RETURN VALUE. RA-027 §4.1 is the specific
 * mistake this suite is written against: twelve mutations survived there because the tests
 * proved processes start and asserted nothing about what they do. The analogue here would
 * be asserting that a handler resolved — which stays true if it silently does nothing at
 * all, the exact failure `UnknownJobTypeError` exists to prevent.
 *
 * NO TEST HERE REACHES AWS (AC6). `FakeTransport` is passed into the same `createRoles`
 * the production path uses, so what runs is the production code with a different driver.
 */

const owners = new OwnerRepository();
const connections = new ConnectionRepository();
const cases = new CaseRepository();
const units = new WorkUnitRepository();

const FIXED_MS = Date.parse("2026-08-22T12:00:00.000Z");

const config = createRuntimeConfig({
  model: { provider: "bedrock", model_id: "test-model" },
  timeoutMs: 30_000,
  toolLimits: { maxIterations: 4, maxCalls: 8 },
});

/** A completion the contract accepts, scripted as the model's single reply. */
function completionJson(caseId: string, runId: string): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: runId,
    case_id: caseId,
    status: "COMPLETED",
    summary: "did the work",
    completed_steps: [],
    evidence: [],
    checkpoint_patch: {},
    next_actions: [],
  };
}

describeIntegration(
  "worker job handlers",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let jobs: JobStore;
    let persistence: WorkerPersistence;

    // Counted PER PREFIX, so `run-1` is the first run id regardless of how many completion
    // ids were drawn. A single shared counter makes the run id depend on unrelated draws,
    // and the scripted completion's `run_id` must match the id the runtime actually minted —
    // the runtime rejects a completion whose binding disagrees.
    const counters = new Map<string, number>();
    const runtime = {
      clock: { now: () => FIXED_MS },
      ids: {
        next: (prefix?: string) => {
          const key = prefix ?? "id";
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return `${key}-${String(next)}`;
        },
      },
    };

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      counters.clear();
      // 'injected' so the lease clock matches the fixed test clock; the production default
      // is the DB server clock.
      jobs = new JobStore({ ...runtime, leaseTime: "injected" });
      persistence = new WorkerPersistence(db, runtime);
    });

    afterEach(async () => {
      await drop();
    });

    async function seed(
      caseId: string,
      unitId: string,
      role: "REVIEWER" | "IMPLEMENTER" = "REVIEWER",
    ): Promise<void> {
      await owners.insert(db, { ownerId: `owner-${caseId}`, displayName: "owner" });
      await connections.insert(db, {
        connectionId: `connection-${caseId}`,
        ownerId: `owner-${caseId}`,
        provider: "jira",
        displayName: "connection",
      });
      await cases.insert(db, {
        caseId,
        ownerId: `owner-${caseId}`,
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: [`connection-${caseId}`] },
        discordThreadId: `thread-${caseId}`,
      });
      await units.insert(db, {
        workUnitId: unitId,
        caseId,
        role,
        objective: `objective for ${unitId}`,
        authoritativeScope:
          role === "IMPLEMENTER"
            ? { connection_ids: [], repo_allowlist: [], can_write_workspace: true }
            : { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
      });
      // A base checkpoint must exist: a completion ADVANCES a revision, and letting a
      // completion define its own baseline would make the model the author of the case's
      // starting state. Inserted directly because `CheckpointRepository.append` only ever
      // writes `expectedRevision + 1`, so revision 0 is not reachable through it — the same
      // approach `completion-apply.integration.test.ts` uses.
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ($1, $2, 0, $3::jsonb)",
        [caseId, `owner-${caseId}`, JSON.stringify(makeCheckpoint(caseId, 0))],
      );
    }

    async function claimSeededWriter(unitId: string, runId = "run-1"): Promise<void> {
      await units.claim(db, { workUnitId: unitId, runId, checkpointRevision: 0 });
    }

    function handlersWith(
      transport: FakeTransport,
      overrides: {
        readonly maxSteps?: number;
        readonly heartbeatIntervalMs?: number;
        readonly engineeringInvocation?: {
          run<T>(lease: JobLease, work: () => Promise<T>): Promise<T>;
        };
      } = {},
    ) {
      return createWorkerHandlers({
        persistence,
        roles: createRoles(["REVIEWER", "IMPLEMENTER"], { transport, config }),
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
        db,
        jobs,
        ...overrides,
      });
    }

    /** A lease shaped exactly as `Scheduler` hands one to a handler. */
    function lease(overrides: Partial<JobLease> = {}): JobLease {
      return {
        jobId: "job-1",
        caseId: "case-1",
        jobType: "case.resume",
        payload: {},
        provider: null,
        serializationKey: "case-1",
        attempts: 0,
        maxAttempts: 10,
        fencingToken: 1,
        leaseExpiresAtMs: FIXED_MS + 60_000,
        leaseOwner: "worker-1",
        ...overrides,
      };
    }

    const noop = async (): Promise<void> => undefined;

    // ---- AC1: the handler actually carries the case forward ----------------------

    it("case.resume runs the unit and PERSISTS the completion, checkpoint and outbox", async () => {
      // The load-bearing test of RA-028. Before this task the same call reached an empty
      // handler map and dead-lettered the job.
      await seed("case-1", "unit-1");
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-1", "run-1") }],
        },
      ]);
      // `makeRunId` draws from the injected id generator, so the run id is deterministic.
      const handlers = handlersWith(transport);
      await handlers["case.resume"]!(lease(), noop);

      const completion = await db.query<{ status: string; case_id: string }>(
        "SELECT status, case_id FROM run_completions",
      );
      expect(completion.rows).toHaveLength(1);
      expect(completion.rows[0]?.case_id).toBe("case-1");

      // The checkpoint advanced. The promoted harness code wrote the completion with a
      // plain INSERT and skipped this entirely, so nothing downstream learned the run
      // finished.
      const revision = await db.query<{ checkpoint_revision: number }>(
        "SELECT checkpoint_revision FROM cases WHERE case_id = 'case-1'",
      );
      expect(revision.rows[0]?.checkpoint_revision).toBe(1);

      // And the outbox event exists, which is what actually notifies the rest of the system.
      const outbox = await db.query<{ event_type: string }>(
        "SELECT event_type FROM outbox WHERE aggregate_id = 'case-1'",
      );
      expect(outbox.rows.map((row) => row.event_type)).toContain("agent.completion.recorded");

      // The work unit reached a terminal state rather than being left RUNNING.
      const unit = await db.query<{ status: string }>(
        "SELECT status FROM work_units WHERE work_unit_id = 'unit-1'",
      );
      expect(unit.rows[0]?.status).toBe("COMPLETED");
    });

    it("HEARTBEATS before reaching the model, so a slow recovery cannot lose the lease", async () => {
      // Pins the explicit `recover()` call, which a mutation otherwise deletes with every test
      // still green — `pumpOnce()` recovers internally, so the work happens either way. What
      // would silently regress is the lease extension: recovery reads every unfinished case,
      // and without a heartbeat before the model call a slow recovery can have its job reaped
      // mid-pass. Asserted as ORDER, because "heartbeat was called" stays true if it happens
      // afterwards, when it is useless.
      await seed("case-hb", "unit-hb");
      const order: string[] = [];
      const inner = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-hb", "run-1") }],
        },
      ]);
      // Wrapped rather than using a getter on the scripted response: `FakeTransport` deep-copies
      // its script in the constructor, so a getter fires at construction time and records the
      // wrong moment. This records the actual `converse` call.
      const transport = {
        requests: inner.requests,
        converse: async (
          request: Parameters<typeof inner.converse>[0],
          cfg: Parameters<typeof inner.converse>[1],
        ) => {
          order.push("model");
          return inner.converse(request, cfg);
        },
      } as unknown as FakeTransport;
      await handlersWith(transport)["case.resume"]!(lease({ caseId: "case-hb" }), async () => {
        order.push("heartbeat");
      });
      expect(order).toEqual(["heartbeat", "model"]);
    });

    it("keeps heartbeating while a model call is in flight", async () => {
      await seed("case-heartbeat-loop", "unit-heartbeat-loop");
      let resolveModel!: (
        value: ReturnType<FakeTransport["converse"]> extends Promise<infer T> ? T : never,
      ) => void;
      const inner = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-heartbeat-loop", "run-1") }],
        },
      ]);
      const blocked = new Promise<Awaited<ReturnType<FakeTransport["converse"]>>>((resolve) => {
        resolveModel = resolve;
      });
      const transport = {
        requests: inner.requests,
        converse: async () => blocked,
      } as unknown as FakeTransport;
      let heartbeats = 0;
      const running = handlersWith(transport, { heartbeatIntervalMs: 2 })["case.resume"]!(
        lease({ caseId: "case-heartbeat-loop" }),
        async () => {
          heartbeats += 1;
        },
      );
      const deadline = Date.now() + 1_000;
      while (heartbeats < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(heartbeats).toBeGreaterThanOrEqual(3);
      resolveModel({
        model: config.model,
        content: [{ type: "json", value: completionJson("case-heartbeat-loop", "run-1") }],
      });
      await running;
    });

    it("uses the INJECTED transport exactly once and never reaches AWS", async () => {
      // AC6, structurally: counting calls proves the seam is real. A handler that
      // constructed its own transport would leave this at zero while still passing every
      // "did it persist?" assertion above — and would try to reach Bedrock in CI.
      await seed("case-2", "unit-2");
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-2", "run-1") }],
        },
      ]);
      await handlersWith(transport)["case.resume"]!(lease({ caseId: "case-2" }), noop);
      expect(transport.requests).toHaveLength(1);
      // The objective, not a hardcoded prompt: the instruction is supervisor-authored.
      expect(JSON.stringify(transport.requests[0])).toContain("objective for unit-2");
    });

    // ---- AC2: fail-closed survives having handlers ------------------------------

    it("an unregistered job_type STILL fails closed after three are registered", async () => {
      // Regression on RA-027's D1/D2. Registering handlers must not open a silent path for
      // a fourth type — the shape of `CTF-010` finding 4, treating no declaration as consent.
      await seed("case-3", "unit-3");
      const transport = new FakeTransport([]);
      const dispatch = createJobDispatch(handlersWith(transport));
      await expect(dispatch(lease({ jobType: "jira.issue.delete" }), noop)).rejects.toThrow(
        /no handler registered for job_type jira\.issue\.delete/,
      );
    });

    it("a deployment CAN register jira.webhook.renewal, and it heartbeats first", async () => {
      // The renewal handler is injected because `runWorker` needs a Jira config and a live
      // token. What is proven here is the wiring: an injected runner is reached through
      // dispatch, and the heartbeat happens BEFORE the remote call — a renewal that talks to
      // Jira without extending its lease can have the lease reaped mid-request, leaving the
      // job claimable while the external effect is in flight.
      const order: string[] = [];
      const handlers = createWorkerHandlers(
        {
          persistence,
          roles: createRoles(["REVIEWER"], { transport: new FakeTransport([]), config }),
          logger: new StructuredLogger({ sink: { log: () => undefined } }),
          db,
          jobs,
        },
        {
          "jira.webhook.renewal": createRenewalHandler(async () => {
            order.push("run");
          }),
        },
      );
      await createJobDispatch(handlers)(lease({ jobType: "jira.webhook.renewal" }), async () => {
        order.push("heartbeat");
      });
      expect(order).toEqual(["heartbeat", "run"]);
    });

    it("WITHOUT that registration the renewal job fails closed to the DLQ", async () => {
      // "Not configured" must be visible and alarmed, not a silent drop.
      const handlers = handlersWith(new FakeTransport([]));
      await expect(
        createJobDispatch(handlers)(lease({ jobType: "jira.webhook.renewal" }), noop),
      ).rejects.toThrow(/no handler registered for job_type jira\.webhook\.renewal/);
    });

    // ---- AC3: the writer runs only under its durable lease ---------------------

    it("an IMPLEMENTER unit reached WITHOUT a writer lease fails closed", async () => {
      // `case.resume` carries no writer lease, so a writer unit must not run under it. The
      // alternative — writing without a fence — is how two processes end up writing one
      // workspace (`AGENTS.md` §7).
      await seed("case-4", "unit-4", "IMPLEMENTER");
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-4", "run-1") }],
        },
      ]);
      // The handler WRAPS the runtime's inner error, because `pumpOnce` never rethrows it —
      // so the assertion is that the job FAILS with the unit named, not on the inner text.
      // The durable evidence of the reason is the `AMBIGUOUS` safety state, asserted below.
      await expect(
        handlersWith(transport)["case.resume"]!(lease({ caseId: "case-4" }), noop),
      ).rejects.toThrow(/unit-4/);
      // No completion was written: failing closed must not half-apply.
      const completion = await db.query("SELECT 1 FROM run_completions");
      expect(completion.rows).toHaveLength(0);
      // AC5, the durable half. The run is marked AMBIGUOUS, so `recover()` reports the case
      // writer-blocked and a retry re-reports it instead of re-invoking the model. Without
      // this row a retry would be a blind replay of an effect nobody confirmed.
      const run = await db.query<{ safety_state: string }>(
        "SELECT safety_state FROM agent_runs WHERE case_id = 'case-4'",
      );
      expect(run.rows[0]?.safety_state).toBe("AMBIGUOUS");
      expect((await persistence.recover("case-4")).writerBlocked).toBe(true);
    });

    it("a case.resume lease can NEVER grant write authority, even if wired in by mistake", async () => {
      // H4/H5 defence-in-depth, made explicit. `createCaseResumeHandler` passes the writer
      // lease only when invoked as the writer, and a mutation removing that condition stays
      // green — because `WriterLeaseGuard` independently rejects a lease whose `jobType` is not
      // `agent.implementer`. This test pins the guard's half, so the redundancy is DOCUMENTED
      // rather than being an unexplained mutation survivor.
      await seed("case-dd", "unit-dd", "IMPLEMENTER");
      await jobs.enqueue(db, {
        caseId: "case-dd",
        jobType: "agent.implementer",
        payload: { workUnitId: "unit-dd", runId: "run-1" },
      });
      const claimed = await jobs.claim(db, { owner: "worker-1" });
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-dd", "run-1") }],
        },
      ]);
      // A lease that is live and correct in every way EXCEPT its job type.
      await expect(
        handlersWith(transport)["agent.implementer"]!(
          { ...claimed!, jobType: "case.resume" },
          noop,
        ),
      ).rejects.toThrow();
      expect((await db.query("SELECT 1 FROM run_completions")).rows).toHaveLength(0);
    });

    it("agent.implementer rejects a lease whose job_type is not the writer type", async () => {
      await seed("case-5", "unit-5", "IMPLEMENTER");
      const transport = new FakeTransport([]);
      await expect(
        handlersWith(transport)["agent.implementer"]!(
          lease({ caseId: "case-5", jobType: "case.resume" }),
          noop,
        ),
      ).rejects.toThrow(/job_type case\.resume/);
    });

    it("agent.implementer runs the writer under a REAL, live job lease", async () => {
      // The positive half of AC3: with a genuine `agent.implementer` lease the writer runs
      // and its completion is persisted. `WriterLeaseGuard` re-asserts the lease against
      // the `jobs` row, so this only passes if the lease is actually live.
      await seed("case-6", "unit-6", "IMPLEMENTER");
      await claimSeededWriter("unit-6");
      const enqueued = await jobs.enqueue(db, {
        caseId: "case-6",
        jobType: "agent.implementer",
        payload: { caseId: "case-6", workUnitId: "unit-6", runId: "run-1" },
      });
      const claimed = await jobs.claim(db, { owner: "worker-1" });
      expect(claimed?.jobId).toBe(enqueued.job_id);
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-6", "run-1") }],
        },
      ]);
      await handlersWith(transport)["agent.implementer"]!(claimed!, noop);
      const completion = await db.query<{ case_id: string }>("SELECT case_id FROM run_completions");
      expect(completion.rows[0]?.case_id).toBe("case-6");
    });

    it("wraps every implementer handler call in the injected invocation journal boundary", async () => {
      await seed("case-journal", "unit-journal", "IMPLEMENTER");
      await claimSeededWriter("unit-journal");
      await jobs.enqueue(db, {
        caseId: "case-journal",
        jobType: "agent.implementer",
        payload: {
          caseId: "case-journal",
          workUnitId: "unit-journal",
          runId: "run-1",
        },
      });
      const claimed = await jobs.claim(db, { owner: "worker-1" });
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-journal", "run-1") }],
        },
      ]);
      const order: string[] = [];
      const handlers = handlersWith(transport, {
        engineeringInvocation: {
          async run(_lease, work) {
            order.push("journal-start");
            const result = await work();
            order.push("journal-complete");
            return result;
          },
        },
      });

      await handlers["agent.implementer"]!(claimed!, noop);
      expect(order).toEqual(["journal-start", "journal-complete"]);
      expect(transport.requests).toHaveLength(1);
    });

    it("rejects unclaimed, foreign-run, and other-case writer targets before the model", async () => {
      await seed("case-8", "unit-8", "IMPLEMENTER");
      const enqueued = await jobs.enqueue(db, {
        caseId: "case-8",
        jobType: "agent.implementer",
        payload: { caseId: "case-8", workUnitId: "unit-8", runId: "run-1" },
      });
      const claimed = await jobs.claim(db, { owner: "worker-1" });
      expect(claimed?.jobId).toBe(enqueued.job_id);
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-8", "run-1") }],
        },
      ]);
      const handler = handlersWith(transport)["agent.implementer"]!;

      await expect(handler(claimed!, noop)).rejects.toThrow(/execution target run binding/);
      await claimSeededWriter("unit-8");
      await expect(
        handler({ ...claimed!, payload: { ...claimed!.payload, runId: "run-foreign" } }, noop),
      ).rejects.toThrow(/execution target run binding/);
      await expect(
        handler({ ...claimed!, payload: { ...claimed!.payload, caseId: "case-foreign" } }, noop),
      ).rejects.toThrow(/exact claimed work-unit\/run binding/);
      expect(transport.requests).toHaveLength(0);
    });

    it("the writer is refused once its lease is no longer current", async () => {
      // A lease lost mid-pass (expiry, reap, a newer holder) must stop the writer. Asserted
      // by presenting a stale fencing token, which is what a superseded holder would carry.
      await seed("case-7", "unit-7", "IMPLEMENTER");
      await claimSeededWriter("unit-7");
      await jobs.enqueue(db, {
        caseId: "case-7",
        jobType: "agent.implementer",
        payload: { caseId: "case-7", workUnitId: "unit-7", runId: "run-1" },
      });
      const claimed = await jobs.claim(db, { owner: "worker-1" });
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-7", "run-1") }],
        },
      ]);
      await expect(
        handlersWith(transport)["agent.implementer"]!(
          { ...claimed!, fencingToken: claimed!.fencingToken + 1 },
          noop,
        ),
      ).rejects.toThrow();
      const completion = await db.query("SELECT 1 FROM run_completions");
      expect(completion.rows).toHaveLength(0);
    });

    // ---- AC4: a failing handler does not strand the job ------------------------

    it("a model that returns an invalid completion THROWS rather than persisting nothing quietly", async () => {
      // The job must fail so `Scheduler` can retry it and eventually dead-letter it. A
      // handler that swallowed this would mark the job done having performed no work.
      await seed("case-8", "unit-8");
      const transport = new FakeTransport([
        { model: config.model, content: [{ type: "json", value: { not: "a completion" } }] },
      ]);
      await expect(
        handlersWith(transport)["case.resume"]!(lease({ caseId: "case-8" }), noop),
      ).rejects.toThrow();
      const completion = await db.query("SELECT 1 FROM run_completions");
      expect(completion.rows).toHaveLength(0);
    });

    it("a case with NO checkpoint gets a SYSTEM baseline (revision 0), then advances (CTF-020)", async () => {
      // Nothing in production ever wrote a case's first checkpoint, so the first completion threw
      // "has no checkpoint to advance" — silently breaking the reply loop. The fix creates a
      // revision-0 baseline lazily. The ORIGINAL concern (the MODEL must not author the case's
      // starting state) still holds: the baseline is SYSTEM-authored, and the model's completion
      // advances FROM it to revision 1.
      await owners.insert(db, { ownerId: "owner-9", displayName: "owner" });
      await connections.insert(db, {
        connectionId: "connection-9",
        ownerId: "owner-9",
        provider: "jira",
        displayName: "connection",
      });
      await cases.insert(db, {
        caseId: "case-9",
        ownerId: "owner-9",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-9"] },
        discordThreadId: "thread-9",
      });
      await units.insert(db, {
        workUnitId: "unit-9",
        caseId: "case-9",
        role: "REVIEWER",
        objective: "objective for unit-9",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: [],
          can_write_workspace: false,
        },
      });
      const transport = new FakeTransport([
        {
          model: config.model,
          content: [{ type: "json", value: completionJson("case-9", "run-1") }],
        },
      ]);
      await handlersWith(transport)["case.resume"]!(lease({ caseId: "case-9" }), noop);

      // The completion persisted and the case advanced from the system baseline (0) to 1.
      expect((await db.query("SELECT 1 FROM run_completions")).rows).toHaveLength(1);
      const checkpoints = await db.query<{ revision: number; checkpoint: { goal: string } }>(
        "SELECT revision, checkpoint FROM case_checkpoints WHERE case_id = 'case-9' ORDER BY revision",
      );
      expect(checkpoints.rows.map((r) => r.revision)).toEqual([0, 1]);
      // The revision-0 baseline is SYSTEM-authored — NOT defined by the model's completion.
      expect(checkpoints.rows[0]?.checkpoint.goal).toBe("Initial case state (system baseline)");
    });

    // ---- idempotency: a retry after a lost lease is safe ----------------------

    it("re-running the same completion is a REPLAY, not a duplicate or a conflict", async () => {
      // A worker killed between persisting and acknowledging will have its job retried.
      // `RunCompletionRepository.apply()` is idempotent by identity, so the retry must not
      // write a second completion nor advance the revision twice.
      await seed("case-10", "unit-10");
      const scripted = {
        model: config.model,
        content: [{ type: "json" as const, value: completionJson("case-10", "run-1") }],
      };
      await handlersWith(new FakeTransport([scripted]))["case.resume"]!(
        lease({ caseId: "case-10" }),
        noop,
      );
      const first = await db.query<{ checkpoint_revision: number }>(
        "SELECT checkpoint_revision FROM cases WHERE case_id = 'case-10'",
      );
      expect(first.rows[0]?.checkpoint_revision).toBe(1);

      // Second pass: the unit is terminal, so recovery replays the stored completion rather
      // than calling the model again.
      const replayTransport = new FakeTransport([scripted]);
      await handlersWith(replayTransport)["case.resume"]!(lease({ caseId: "case-10" }), noop);
      const completions = await db.query("SELECT 1 FROM run_completions");
      expect(completions.rows).toHaveLength(1);
      const second = await db.query<{ checkpoint_revision: number }>(
        "SELECT checkpoint_revision FROM cases WHERE case_id = 'case-10'",
      );
      expect(second.rows[0]?.checkpoint_revision).toBe(1);
      expect(replayTransport.requests).toHaveLength(0);
    });
  },
  available,
);
