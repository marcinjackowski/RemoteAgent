/**
 * Two-worker concurrency + fault-injection integration tests (RA-004).
 *
 * These exercise the required verification directly:
 *   - two workers claiming concurrently (no double-claim, per-case serialization);
 *   - fault injection at commit / publish / start / complete boundaries;
 *   - stale fencing after lease expiry and re-claim;
 *   - the deterministic scheduler tick loop.
 *
 * Concurrency is driven against a REAL PostgreSQL with real connection-pool
 * parallelism (Promise.all of independent transactions), not a simulation.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import {
  JobStore,
  OutboxRepository,
  Scheduler,
  ManualClock,
  SystemClock,
  SequentialIdGenerator,
  UuidGenerator,
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
  "queue concurrency and fault injection",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;

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

    it("two workers never double-claim the same job (real parallelism)", async () => {
      // Use the production (system clock / uuid) runtime here: this test is about
      // real concurrent claims, not deterministic time.
      const jobs = new JobStore({ clock: new SystemClock(), ids: new UuidGenerator() });
      // 20 distinct cases, one job each, so all are independently claimable.
      const N = 20;
      for (let i = 0; i < N; i += 1) {
        await seedCase(`case-${i}`, `owner-${i}`, `conn-${i}`);
        await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: `case-${i}` });
      }
      // Two workers hammer claim() concurrently until the queue drains.
      const claimedByWorker = async (owner: string): Promise<string[]> => {
        const got: string[] = [];
        for (;;) {
          const lease = await jobs.claim(db, { owner, leaseMs: 60_000 });
          if (lease === null) break;
          got.push(lease.jobId);
          await jobs.complete(db, lease);
        }
        return got;
      };
      const [a, b] = await Promise.all([claimedByWorker("A"), claimedByWorker("B")]);
      const all = [...a, ...b];
      // Every job claimed exactly once (no duplicates, none lost).
      expect(new Set(all).size).toBe(N);
      expect(all).toHaveLength(N);
      const succeeded = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM jobs WHERE status = 'SUCCEEDED'",
      );
      expect(succeeded.rows[0]!.n).toBe(String(N));
    });

    it("two workers contending for one case: only one active at a time", async () => {
      const jobs = new JobStore({ clock: new SystemClock(), ids: new UuidGenerator() });
      await seedCase("case-1");
      // Many jobs for ONE case.
      for (let i = 0; i < 10; i += 1) {
        await jobs.enqueue(db, { jobType: "w", payload: { i }, caseId: "case-1" });
      }
      // Two workers try to claim concurrently, repeatedly. At no instant may two
      // be active for case-1; we verify the invariant after each concurrent round.
      let processed = 0;
      for (let round = 0; round < 10; round += 1) {
        const [la, lb] = await Promise.all([
          jobs.claim(db, { owner: "A", leaseMs: 60_000 }),
          jobs.claim(db, { owner: "B", leaseMs: 60_000 }),
        ]);
        const active = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM jobs
           WHERE serialization_key = 'case-1' AND status IN ('LEASED','RECONCILING')`,
        );
        // At most one active job for the case at any time.
        expect(Number(active.rows[0]!.n)).toBeLessThanOrEqual(1);
        // Exactly one of the two workers can win each round (the other gets null).
        const winners = [la, lb].filter((l) => l !== null);
        expect(winners.length).toBeLessThanOrEqual(1);
        for (const w of winners) {
          await jobs.complete(db, w!);
          processed += 1;
        }
      }
      expect(processed).toBe(10);
    });

    it("fault injection at COMMIT: a crash before commit persists nothing", async () => {
      const jobs = new JobStore({
        clock: new ManualClock(1000),
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      const outbox = new OutboxRepository({
        clock: new ManualClock(1000),
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await seedCase("case-1");
      const boom = new Error("crash before commit");
      await expect(
        db.withTransaction(async (tx) => {
          await jobs.enqueue(tx, { jobType: "w", payload: {}, caseId: "case-1" });
          await outbox.enqueue(tx, {
            aggregate: "case",
            aggregateId: "case-1",
            eventType: "e",
            payload: {},
          });
          throw boom; // crash between the writes and COMMIT
        }),
      ).rejects.toBe(boom);
      const jobN = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM jobs");
      const obN = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM outbox");
      expect(jobN.rows[0]!.n).toBe("0");
      expect(obN.rows[0]!.n).toBe("0");
    });

    it("fault injection at PUBLISH: a failed publish keeps the message for retry", async () => {
      const clock = new ManualClock(1000);
      const outbox = new OutboxRepository({
        clock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await seedCase("case-1");
      const ob = await db.withTransaction((tx) =>
        outbox.enqueue(tx, {
          aggregate: "case",
          aggregateId: "case-1",
          eventType: "e",
          payload: {},
          maxAttempts: 5,
        }),
      );
      // The sink "crashes" mid-publish: the message must remain and be retried,
      // never silently dropped and never marked PUBLISHED.
      const r = await outbox.relayOnce(db, async () => {
        throw new Error("publish crash");
      });
      expect(r.retried).toContain(ob.outbox_id);
      const status = await outbox.dispatchStatus(db, ob.outbox_id);
      expect(status!.status).toBe("PENDING");
      expect(status!.attempts).toBe(1);
    });

    it("fault injection at START: intent recorded, worker dies before completion", async () => {
      const clock = new ManualClock(1000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W", leaseMs: 5000 });
      // START: record intent then die (no completion).
      await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: {},
        idempotencyKey: "k-start",
      });
      clock.advance(10_000); // lease expires
      const reaped = await jobs.reapExpired(db);
      expect(reaped.reconciling).toContain(lease!.jobId);
      // No automatic replay: not claimable.
      expect(await jobs.claim(db, { owner: "W2" })).toBeNull();
    });

    it("fault injection at COMPLETE: stale worker's completion is rejected after re-claim", async () => {
      const clock = new ManualClock(1000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const first = await jobs.claim(db, { owner: "W1", leaseMs: 5000 });
      clock.advance(10_000);
      await jobs.reapExpired(db); // requeued (no intent)
      const second = await jobs.claim(db, { owner: "W2", leaseMs: 5000 });
      expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
      // The stale first worker's COMPLETE lands after re-claim: rejected.
      await expect(jobs.complete(db, first!)).rejects.toBeInstanceOf(StaleFencingTokenError);
      // The fencing DB guard also forbids lowering the token by a direct write.
      await expect(
        db.query("UPDATE jobs SET fencing_token = 0 WHERE job_id = $1", [first!.jobId]),
      ).rejects.toMatchObject({ code: "P0110" });
    });

    it("scheduler.tick reaps, relays and runs one job deterministically", async () => {
      const clock = new ManualClock(1000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      const outbox = new OutboxRepository({
        clock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const publishedIds: string[] = [];
      await db.withTransaction((tx) =>
        outbox.enqueue(tx, {
          aggregate: "case",
          aggregateId: "case-1",
          eventType: "e",
          payload: {},
        }),
      );
      const ran: string[] = [];
      const scheduler = new Scheduler({
        db,
        jobs,
        outbox,
        clock,
        sink: async (m) => {
          publishedIds.push(m.outbox_id);
        },
        handler: async (lease) => {
          ran.push(lease.jobId);
        },
        claim: { owner: "sched", leaseMs: 30_000 },
      });
      const result = await scheduler.tick();
      expect(result.claimedJobId).not.toBeNull();
      expect(result.jobOutcome).toBe("SUCCEEDED");
      expect(ran).toHaveLength(1);
      expect(result.relay.published).toHaveLength(1);
      expect(publishedIds).toHaveLength(1);
      const job = await jobs.findById(db, result.claimedJobId!);
      expect(job!.status).toBe("SUCCEEDED");
    });

    it("scheduler.tick routes a throwing handler through bounded retry", async () => {
      const clock = new ManualClock(1000);
      const jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
      const outbox = new OutboxRepository({
        clock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await seedCase("case-1");
      await jobs.enqueue(db, {
        jobType: "w",
        payload: {},
        caseId: "case-1",
        maxAttempts: 1,
      });
      const scheduler = new Scheduler({
        db,
        jobs,
        outbox,
        clock,
        sink: async () => undefined,
        handler: async () => {
          throw new Error("handler failed");
        },
        claim: { owner: "sched", leaseMs: 30_000 },
      });
      const result = await scheduler.tick();
      // maxAttempts=1 and this was attempt 1 => straight to DLQ.
      expect(result.jobOutcome).toBe("DEAD_LETTER");
      const dlq = await jobs.listDeadLettered(db);
      expect(dlq).toHaveLength(1);
    });

    it("DB partial unique index is the hard backstop for per-case serialization", async () => {
      const jobs = new JobStore({
        clock: new ManualClock(1000),
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      await seedCase("case-1");
      const j1 = await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const j2 = await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      // Force the first job LEASED by direct write (bypassing claim logic).
      await db.query(
        `UPDATE jobs SET status = 'LEASED', lease_owner = 'x', fencing_token = fencing_token + 1,
                lease_expires_at = now() + interval '1 minute'
         WHERE job_id = $1`,
        [j1.job_id],
      );
      // Attempting to also activate the second job for the SAME serialization key
      // is rejected by the partial unique index, independent of claim logic.
      await expect(
        db.query(
          `UPDATE jobs SET status = 'LEASED', lease_owner = 'y', fencing_token = fencing_token + 1,
                  lease_expires_at = now() + interval '1 minute'
           WHERE job_id = $1`,
          [j2.job_id],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  },
  available,
);
