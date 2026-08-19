/**
 * Durable queue integration tests against a REAL PostgreSQL (RA-004).
 *
 * Covers acceptance criteria with deterministic time/id:
 *   1. Commit of state + outbox message is atomic.
 *   2. Crash after intent, before completion, does not auto-replay the write.
 *   3. An expired worker cannot write a result after another worker re-claims.
 *   4. Two jobs of one case run sequentially; different cases run in parallel.
 *   5. Retry uses bounded exponential backoff and ends in an observable DLQ.
 *   6. Reconciliation is idempotent and auditable.
 *
 * Plus required verification: two workers, fault injection at
 * commit/publish/start/complete, lease expiry + stale fencing, retry + DLQ.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import {
  JobStore,
  OutboxRepository,
  ManualClock,
  SequentialIdGenerator,
  StaleFencingTokenError,
} from "../src/queue/index.js";
import {
  OwnerRepository,
  ConnectionRepository,
  CaseRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "durable queue",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    let clock: ManualClock;
    let jobs: JobStore;
    let outbox: OutboxRepository;

    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

    beforeEach(async () => {
      await db.query(
        `TRUNCATE job_reconciliations, job_completions, job_intents, job_attempts,
                  outbox_dispatch, outbox, jobs, case_checkpoints, external_entities,
                  case_messages, cases, events, raw_events, connections, owners
                  RESTART IDENTITY CASCADE`,
      );
      clock = new ManualClock(1_000_000);
      const ids = new SequentialIdGenerator();
      jobs = new JobStore({ clock, ids, leaseTime: "injected" });
      outbox = new OutboxRepository({
        clock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
    });

    async function seedCase(caseId: string, ownerId = "owner-1", connId = "conn-1"): Promise<void> {
      await owners.insert(db, { ownerId, displayName: "o" }).catch(() => undefined);
      await connections
        .insert(db, { connectionId: connId, ownerId, provider: "jira", displayName: "c" })
        .catch(() => undefined);
      await cases.insert(db, {
        caseId,
        ownerId,
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: [connId] },
        discordThreadId: `thread-${caseId}`,
      });
    }

    it("commits state and outbox message atomically (criterion 1)", async () => {
      await seedCase("case-1");
      // Enqueue a job AND an outbox message in ONE transaction with a state write.
      await db.withTransaction(async (tx) => {
        await cases.updateStatus(tx, "case-1", "TRIAGED");
        await jobs.enqueue(tx, { jobType: "work", payload: { a: 1 }, caseId: "case-1" });
        await outbox.enqueue(tx, {
          aggregate: "case",
          aggregateId: "case-1",
          eventType: "case.triaged",
          payload: { case_id: "case-1" },
        });
      });
      const jobCount = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM jobs");
      const obCount = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM outbox");
      expect(jobCount.rows[0]!.n).toBe("1");
      expect(obCount.rows[0]!.n).toBe("1");

      // A failing transaction rolls back BOTH the state change and the message.
      const boom = new Error("boom");
      await expect(
        db.withTransaction(async (tx) => {
          await cases.updateStatus(tx, "case-1", "PLANNING");
          await outbox.enqueue(tx, {
            aggregate: "case",
            aggregateId: "case-1",
            eventType: "case.planning",
            payload: {},
          });
          throw boom;
        }),
      ).rejects.toBe(boom);
      const obCount2 = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM outbox");
      expect(obCount2.rows[0]!.n).toBe("1"); // no new message
      const c = await cases.findById(db, "case-1");
      expect(c!.status).toBe("TRIAGED"); // unchanged
    });

    it("claims a job under a lease and completes it", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "work", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "w1", leaseMs: 30_000 });
      expect(lease).not.toBeNull();
      expect(lease!.fencingToken).toBe(1);
      await jobs.complete(db, lease!);
      const job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("SUCCEEDED");
      const history = await jobs.attemptHistory(db, lease!.jobId);
      expect(history).toHaveLength(1);
      expect(history[0]!.outcome).toBe("SUCCEEDED");
    });

    it("serializes two jobs of one case, parallelizes different cases (criterion 4)", async () => {
      await seedCase("case-1");
      await seedCase("case-2");
      // Two jobs for case-1, one for case-2.
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-2" });

      // Worker A and worker B both try to claim. They should get DIFFERENT cases;
      // the second case-1 job stays PENDING because case-1 already has an active job.
      const a = await jobs.claim(db, { owner: "A", leaseMs: 30_000 });
      const b = await jobs.claim(db, { owner: "B", leaseMs: 30_000 });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      const claimedCases = [a!.caseId, b!.caseId].sort();
      expect(claimedCases).toEqual(["case-1", "case-2"]);

      // A third claim finds nothing: case-1 busy, case-2 busy.
      const c = await jobs.claim(db, { owner: "C", leaseMs: 30_000 });
      expect(c).toBeNull();

      // The partial unique index is the hard backstop: only ONE active job per key.
      const active = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jobs
         WHERE serialization_key = 'case-1' AND status IN ('LEASED','RECONCILING')`,
      );
      expect(active.rows[0]!.n).toBe("1");
    });

    it("expired worker cannot complete after re-claim: stale fencing (criterion 3)", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1", maxAttempts: 5 });

      const first = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      expect(first!.fencingToken).toBe(1);

      // Lease expires; the reaper (no intent recorded) requeues the job.
      clock.advance(20_000);
      const reaped = await jobs.reapExpired(db);
      expect(reaped.requeued).toContain(first!.jobId);

      // A new worker re-claims: fencing token bumps to 2.
      const second = await jobs.claim(db, { owner: "W2", leaseMs: 10_000 });
      expect(second!.jobId).toBe(first!.jobId);
      expect(second!.fencingToken).toBe(2);

      // The original (now stale) worker tries to complete: fails closed.
      await expect(jobs.complete(db, first!)).rejects.toBeInstanceOf(StaleFencingTokenError);
      // Its heartbeat is also rejected.
      await expect(jobs.heartbeat(db, first!)).rejects.toBeInstanceOf(StaleFencingTokenError);

      // The current holder completes successfully.
      await jobs.complete(db, second!);
      const job = await jobs.findById(db, first!.jobId);
      expect(job!.status).toBe("SUCCEEDED");
    });

    it("retries with bounded exponential backoff and ends in the DLQ (criterion 5)", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, {
        jobType: "w",
        payload: {},
        caseId: "case-1",
        maxAttempts: 3,
        backoffBaseMs: 1000,
        backoffCapMs: 10_000,
      });

      // Attempt 1 fails -> PENDING, available_at advanced by base*2^0 = 1000ms.
      const l1 = await jobs.claim(db, { owner: "W", leaseMs: 5_000 });
      expect(l1!.attempts).toBe(1);
      const s1 = await jobs.fail(db, l1!, "err-1");
      expect(s1).toBe("PENDING");
      let job = await jobs.findById(db, l1!.jobId);
      expect(new Date(job!.available_at).getTime()).toBe(clock.now() + 1000);

      // Not yet available: claim finds nothing until we advance past backoff.
      expect(await jobs.claim(db, { owner: "W" })).toBeNull();
      clock.advance(1000);

      // Attempt 2 fails -> PENDING, backoff base*2^1 = 2000ms.
      const l2 = await jobs.claim(db, { owner: "W", leaseMs: 5_000 });
      expect(l2!.attempts).toBe(2);
      const s2 = await jobs.fail(db, l2!, "err-2");
      expect(s2).toBe("PENDING");
      job = await jobs.findById(db, l2!.jobId);
      expect(new Date(job!.available_at).getTime()).toBe(clock.now() + 2000);
      clock.advance(2000);

      // Attempt 3 (== maxAttempts) fails -> DEAD_LETTER (observable).
      const l3 = await jobs.claim(db, { owner: "W", leaseMs: 5_000 });
      expect(l3!.attempts).toBe(3);
      const s3 = await jobs.fail(db, l3!, "err-3");
      expect(s3).toBe("DEAD_LETTER");

      const dlq = await jobs.listDeadLettered(db);
      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.job_id).toBe(l3!.jobId);
      expect(dlq[0]!.dlq_reason).toBe("max attempts exceeded");

      const history = await jobs.attemptHistory(db, l3!.jobId);
      expect(history.map((h) => h.outcome)).toEqual(["FAILED", "FAILED", "DEAD_LETTER"]);
    });

    it("holds a job with an unfinished intent for reconciliation, never auto-replays (criterion 2)", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });

      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      // Intent-before-operation: recorded BEFORE the side effect.
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "http.post",
        descriptor: { url: "https://example/api" },
        idempotencyKey: "idem-1",
      });
      // Worker crashes here (no completion). Lease expires.
      clock.advance(20_000);
      const reaped = await jobs.reapExpired(db);
      // Because there is an unfinished intent, the job goes to RECONCILING,
      // NOT back to PENDING (no automatic replay of a possibly-executed write).
      expect(reaped.reconciling).toContain(lease!.jobId);
      expect(reaped.requeued).not.toContain(lease!.jobId);
      let job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("RECONCILING");

      // A RECONCILING job is not claimable (automatic replay stays halted).
      expect(await jobs.claim(db, { owner: "W2" })).toBeNull();

      // Reconcile: the external write turned out to be ABSENT -> safe to requeue.
      const r1 = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "ABSENT",
        attemptKey: "recon-attempt-1",
        evidence: { checked: true },
      });
      expect(r1.resolution).toBe("ABSENT");
      expect(r1.jobStatus).toBe("PENDING");
      job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("PENDING");
    });

    it("reconciliation is idempotent and auditable (criterion 6)", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "http.post",
        descriptor: { url: "u" },
        idempotencyKey: "idem-2",
      });
      clock.advance(20_000);
      await jobs.reapExpired(db);

      // First reconciliation: CONFIRMED -> job SUCCEEDED, confirming completion written.
      const first = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "CONFIRMED",
        attemptKey: "recon-2a",
        evidence: { receipt: "R-1" },
      });
      expect(first.resolution).toBe("CONFIRMED");
      expect(first.jobStatus).toBe("SUCCEEDED");

      // Replaying the SAME attempt key is an idempotent no-op returning the same result.
      const replay = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "CONFIRMED",
        attemptKey: "recon-2a",
        evidence: { receipt: "R-1" },
      });
      expect(replay.reconciliationId).toBe(first.reconciliationId);
      expect(replay.resolution).toBe("CONFIRMED");

      // A NEW terminal attempt after an existing terminal returns the existing
      // terminal outcome unchanged (the intent is already closed).
      const second = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "ABSENT",
        attemptKey: "recon-2b",
      });
      expect(second.reconciliationId).toBe(first.reconciliationId);
      expect(second.resolution).toBe("CONFIRMED");

      // Auditable: exactly one terminal reconciliation row. Reconciliation is
      // authoritative; it does not fabricate an append-only completion row.
      const recon = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM job_reconciliations
         WHERE intent_id = $1 AND resolution IN ('CONFIRMED','ABSENT')`,
        [intentId],
      );
      expect(recon.rows[0]!.n).toBe("1");
      const comp = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM job_completions WHERE intent_id = $1",
        [intentId],
      );
      expect(comp.rows[0]!.n).toBe("0");
    });

    it("enforces global and provider concurrency limits", async () => {
      await seedCase("case-1");
      await seedCase("case-2");
      await seedCase("case-3");
      for (const c of ["case-1", "case-2", "case-3"]) {
        await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: c, provider: "jira" });
      }
      // Global limit of 2: only two jobs can be active at once.
      const a = await jobs.claim(db, { owner: "A", globalLimit: 2 });
      const b = await jobs.claim(db, { owner: "B", globalLimit: 2 });
      const c = await jobs.claim(db, { owner: "C", globalLimit: 2 });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(c).toBeNull(); // global cap reached

      await jobs.complete(db, a!);
      // Provider limit of 1 for jira: one already active (b) blocks a new jira claim.
      const d = await jobs.claim(db, { owner: "D", provider: "jira", providerLimit: 1 });
      expect(d).toBeNull();
    });

    it("relays outbox messages exactly-once-effect and dead-letters on repeated failure", async () => {
      await seedCase("case-1");
      const ob = await db.withTransaction((tx) =>
        outbox.enqueue(tx, {
          aggregate: "case",
          aggregateId: "case-1",
          eventType: "case.created",
          payload: { case_id: "case-1" },
          maxAttempts: 2,
          backoffBaseMs: 1000,
          backoffCapMs: 10_000,
        }),
      );

      // First relay: sink throws -> retried with backoff.
      const published: string[] = [];
      const r1 = await outbox.relayOnce(db, async (m) => {
        throw new Error(`fail publish ${m.outbox_id}`);
      });
      expect(r1.retried).toContain(ob.outbox_id);
      expect(await outbox.dispatchStatus(db, ob.outbox_id).then((s) => s!.status)).toBe("PENDING");

      // Not yet available; advance past backoff.
      clock.advance(1000);
      // Second relay: fails again -> attempts == maxAttempts -> DEAD_LETTER.
      const r2 = await outbox.relayOnce(db, async () => {
        throw new Error("fail again");
      });
      expect(r2.deadLettered).toContain(ob.outbox_id);
      const dlq = await outbox.listDeadLettered(db);
      expect(dlq.map((d) => d.outbox_id)).toContain(ob.outbox_id);

      // A fresh message publishes successfully.
      const ok = await db.withTransaction((tx) =>
        outbox.enqueue(tx, {
          aggregate: "case",
          aggregateId: "case-1",
          eventType: "case.updated",
          payload: {},
        }),
      );
      const r3 = await outbox.relayOnce(db, async (m) => {
        published.push(m.outbox_id);
      });
      expect(r3.published).toContain(ok.outbox_id);
      expect(published).toContain(ok.outbox_id);
      expect(await outbox.dispatchStatus(db, ok.outbox_id).then((s) => s!.status)).toBe(
        "PUBLISHED",
      );
    });
  },
  available,
);
