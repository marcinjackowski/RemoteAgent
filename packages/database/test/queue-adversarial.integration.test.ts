/**
 * Adversarial integration tests for RA-004 audit findings (AUDIT-01).
 *
 * Each test reproduces the exact attack the auditor used and asserts the fix:
 *   - HIGH-01: an AMBIGUOUS completion is never auto-requeued/replayed.
 *   - HIGH-02: a finalization (complete) failure after a successful handler is
 *     not turned into a bounded retry that replays the handler.
 *   - HIGH-03: a stale outbox relay cannot roll a PUBLISHED row back to PENDING.
 *   - HIGH-04: an idempotency key belonging to another job fails closed; the
 *     intent insert is atomically lease-gated.
 *   - HIGH-05: a cased job cannot disable per-case serialization via a
 *     null/other serializationKey.
 *   - MEDIUM-06: an UNRESOLVED reconciliation can later be closed CONFIRMED/ABSENT.
 *   - MEDIUM-07: transition+attempt is atomic; the reaper records LEASE_LOST.
 *
 * All tests run against a REAL PostgreSQL with deterministic clock/id.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database, type Transaction } from "../src/client.js";
import {
  JobStore,
  OutboxRepository,
  Scheduler,
  ManualClock,
  SystemClock,
  SequentialIdGenerator,
  UuidGenerator,
  StaleFencingTokenError,
  IdempotencyConflictError,
  CompletionConflictError,
  ReconciliationConflictError,
  type TxDb,
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
  "queue adversarial (AUDIT-01 findings)",
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
      jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });
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

    // ----- HIGH-01: AMBIGUOUS completion must not be auto-replayed -----
    it("HIGH-01: AMBIGUOUS completion holds the job in RECONCILING, never requeued", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "http.post",
        descriptor: { url: "u" },
        idempotencyKey: "idem-amb",
      });
      // Side effect result is AMBIGUOUS: recording it moves the job to RECONCILING
      // immediately (not SUCCEEDED, not retried).
      await jobs.recordCompletion(db, {
        intentId,
        jobId: lease!.jobId,
        outcome: "AMBIGUOUS",
        lease: lease!,
      });
      let job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("RECONCILING");

      // Lease expires; the reaper must NOT requeue an AMBIGUOUS job.
      clock.advance(20_000);
      const reaped = await jobs.reapExpired(db);
      expect(reaped.requeued).not.toContain(lease!.jobId);

      // A RECONCILING job is not claimable: automatic replay stays halted.
      expect(await jobs.claim(db, { owner: "W2" })).toBeNull();
      job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("RECONCILING");
    });

    it("HIGH-01: reaper treats a missing-completion intent AND an AMBIGUOUS completion identically", async () => {
      // Second variant: reap an expired job whose intent has an AMBIGUOUS
      // completion recorded WITHOUT the job having been moved (simulate a crash
      // right after inserting the completion row but before the status update).
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: {},
        idempotencyKey: "idem-amb2",
      });
      // Insert an AMBIGUOUS completion directly, leaving the job LEASED.
      await db.query(
        `INSERT INTO job_completions (completion_id, intent_id, job_id, outcome, recorded_at)
         VALUES ('c-amb2', $1, $2, 'AMBIGUOUS', now())`,
        [intentId, lease!.jobId],
      );
      clock.advance(20_000);
      const reaped = await jobs.reapExpired(db);
      expect(reaped.reconciling).toContain(lease!.jobId);
      expect(reaped.requeued).not.toContain(lease!.jobId);
    });

    // ----- HIGH-02: finalize failure after successful handler must not replay -----
    it("HIGH-02: a complete() persistence error after a successful handler never replays the side effect", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1", maxAttempts: 5 });

      let handlerRuns = 0;
      // A JobStore whose complete() throws BEFORE its transition can commit,
      // simulating a persistence/commit error that surfaces after the work
      // already ran. holdFinalizationAmbiguous still works (it is a separate
      // transaction that observes state and moves the still-LEASED job to
      // RECONCILING), so recovery is exercised end to end.
      const flakyJobs = new (class extends JobStore {
        public override async complete(): Promise<void> {
          throw new Error("persist completion failed before commit");
        }
      })({ clock, ids: new SequentialIdGenerator(), leaseTime: "injected" });

      const scheduler = new Scheduler({
        db,
        jobs: flakyJobs,
        outbox,
        clock,
        sink: async () => undefined,
        handler: async () => {
          handlerRuns += 1;
        },
        claim: { owner: "sched", leaseMs: 30_000 },
      });

      // Tick 1: handler runs once, complete() throws, recovery holds the job in
      // RECONCILING (never PENDING, never a bounded retry).
      const t1 = await scheduler.tick();
      expect(handlerRuns).toBe(1);
      expect(t1.jobOutcome).toBe("RECONCILING");
      let job = await flakyJobs.findById(db, "job-1");
      expect(job!.status).toBe("RECONCILING");

      // Advance WELL beyond the original lease and run reap + another tick. A
      // RECONCILING job must not be reaped/requeued and must not be claimable, so
      // the handler must NOT run a second time (no replay of the side effect).
      clock.advance(120_000);
      const reaped = await flakyJobs.reapExpired(db);
      expect(reaped.requeued).not.toContain("job-1");
      expect(reaped.reconciling).not.toContain("job-1"); // reap only touches LEASED
      const t2 = await scheduler.tick();
      expect(handlerRuns).toBe(1);
      expect(t2.claimedJobId).toBeNull();

      // Final state: still RECONCILING, definitely not PENDING/claimable.
      job = await flakyJobs.findById(db, "job-1");
      expect(job!.status).toBe("RECONCILING");
      expect(await flakyJobs.claim(db, { owner: "other" })).toBeNull();
    });

    // ----- HIGH-03: stale outbox relay cannot roll back PUBLISHED -----
    it("HIGH-03: a stale relay's late finalize cannot revert a PUBLISHED row", async () => {
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

      // Relay A claims (dispatch_token 1) but its publish crashes; because it
      // still holds the lease this is a legitimate retry.
      let capturedTokenA: string | undefined;
      let capturedOwnerA: string | undefined;
      const relayA = await outbox.relayOnce(
        db,
        async (m) => {
          capturedTokenA = m.dispatch_token;
          capturedOwnerA = m.lease_owner;
          throw new Error("A is slow / crashes mid-publish");
        },
        { leaseMs: 5_000 },
      );
      expect(relayA.retried).toContain(ob.outbox_id);

      // Advance past A's lease; relay B re-claims (token 2) and publishes.
      clock.advance(10_000);
      const relayB = await outbox.relayOnce(db, async () => undefined, { leaseMs: 5_000 });
      expect(relayB.published).toContain(ob.outbox_id);
      expect(await outbox.dispatchStatus(db, ob.outbox_id).then((s) => s!.status)).toBe(
        "PUBLISHED",
      );

      // The STALE relay A tries to finalize with its OLD token: fencing-gated
      // UPDATE matches zero rows and leaves PUBLISHED intact.
      const staleFail = await db.withTransaction(async (tx) => {
        const r = await tx.query(
          `UPDATE outbox_dispatch
           SET status = 'PENDING', attempts = attempts + 1,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE outbox_id = $1 AND lease_owner = $2 AND dispatch_token = $3
             AND status = 'PENDING' AND lease_expires_at > to_timestamp($4 / 1000.0)`,
          [ob.outbox_id, capturedOwnerA ?? "?", capturedTokenA ?? "0", clock.now()],
        );
        return r.rowCount ?? 0;
      });
      expect(staleFail).toBe(0);
      expect(await outbox.dispatchStatus(db, ob.outbox_id).then((s) => s!.status)).toBe(
        "PUBLISHED",
      );

      // The DB guard also forbids lowering the dispatch token by a direct write.
      await expect(
        db.query("UPDATE outbox_dispatch SET dispatch_token = 0 WHERE outbox_id = $1", [
          ob.outbox_id,
        ]),
      ).rejects.toMatchObject({ code: "P0111" });
    });

    it("HIGH-03: concurrent takeover — blocked relay A cannot revert B's PUBLISHED, reports no retry/DLQ", async () => {
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

      // Relay A's sink BLOCKS after claim until we release it, using a deferred.
      let reachedResolve: (() => void) | undefined;
      const reached = new Promise<void>((r) => {
        reachedResolve = r;
      });
      let releaseA: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        releaseA = r;
      });

      const aSink = async (): Promise<void> => {
        reachedResolve!();
        await gate;
        throw new Error("A releases and fails AFTER B took over");
      };

      // Start relay A (leaseMs 5s). It claims token 1, renews, then blocks in sink.
      const relayAPromise = outbox.relayOnce(db, aSink, { leaseMs: 5_000 });
      await reached; // A has claimed and is parked inside the sink.

      // While A is parked, advance the clock beyond A's (renewed) lease so B can
      // legally take over, then run relay B which claims token 2 and publishes.
      clock.advance(10_000);
      const relayB = await outbox.relayOnce(db, async () => undefined, { leaseMs: 5_000 });
      expect(relayB.published).toContain(ob.outbox_id);
      expect(await outbox.dispatchStatus(db, ob.outbox_id).then((s) => s!.status)).toBe(
        "PUBLISHED",
      );

      // Release A: its sink throws. A's fencing-gated failure finalize must match
      // ZERO rows (B owns the row with token 2 / it is PUBLISHED), so A reports
      // NO retry and NO dead-letter, and the row stays PUBLISHED.
      releaseA!();
      const relayA = await relayAPromise;
      expect(relayA.retried).not.toContain(ob.outbox_id);
      expect(relayA.deadLettered).not.toContain(ob.outbox_id);
      expect(relayA.published).not.toContain(ob.outbox_id);
      expect(await outbox.dispatchStatus(db, ob.outbox_id).then((s) => s!.status)).toBe(
        "PUBLISHED",
      );
    });

    it("HIGH-03: concurrent takeover — late A SUCCESS cannot double-publish or disturb B", async () => {
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

      let reachedResolve: (() => void) | undefined;
      const reached = new Promise<void>((r) => {
        reachedResolve = r;
      });
      let releaseA: (() => void) | undefined;
      const gate = new Promise<void>((r) => {
        releaseA = r;
      });

      let aPublishCount = 0;
      const aSink = async (): Promise<void> => {
        aPublishCount += 1;
        reachedResolve!();
        await gate; // A "succeeds" but only returns after B took over
      };

      const relayAPromise = outbox.relayOnce(db, aSink, { leaseMs: 5_000 });
      await reached;

      clock.advance(10_000);
      const relayB = await outbox.relayOnce(db, async () => undefined, { leaseMs: 5_000 });
      expect(relayB.published).toContain(ob.outbox_id);

      // A returns success late: its fencing-gated PUBLISHED finalize matches zero
      // rows (B already owns/published), so A does NOT report a second publish.
      releaseA!();
      const relayA = await relayAPromise;
      expect(relayA.published).not.toContain(ob.outbox_id);
      // The sink itself ran once for A and once for B (each is a distinct claim);
      // but the durable row is PUBLISHED exactly once (single dispatch row).
      expect(aPublishCount).toBe(1);
      const status = await outbox.dispatchStatus(db, ob.outbox_id);
      expect(status!.status).toBe("PUBLISHED");
      // attempts incremented exactly once (by B's publish), not twice.
      expect(status!.attempts).toBe(1);
    });

    // ----- HIGH-04: cross-job idempotency + atomic lease-gated intent -----
    it("HIGH-04: an idempotency key from another job fails closed (no cross-job intent)", async () => {
      await seedCase("case-1");
      await seedCase("case-2");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-2" });
      const l1 = await jobs.claim(db, { owner: "A", leaseMs: 30_000 });
      const l2 = await jobs.claim(db, { owner: "B", leaseMs: 30_000 });
      const first = l1!.caseId === "case-1" ? l1! : l2!;
      const second = l1!.caseId === "case-1" ? l2! : l1!;

      const intent1 = await jobs.recordIntent(db, first, {
        kind: "http.post",
        descriptor: { url: "a" },
        idempotencyKey: "shared-key",
      });
      // Job 2 reuses the SAME idempotency key with a different descriptor: reject.
      await expect(
        jobs.recordIntent(db, second, {
          kind: "http.post",
          descriptor: { url: "b" },
          idempotencyKey: "shared-key",
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);

      // The ledger still attributes the intent to job 1 only.
      const owner = await db.query<{ job_id: string }>(
        `SELECT job_id FROM job_intents WHERE idempotency_key = 'shared-key'`,
      );
      expect(owner.rows[0]!.job_id).toBe(first.jobId);
      expect(intent1).toBeDefined();
    });

    it("HIGH-04: identical replay (same job/kind/descriptor) is an idempotent no-op", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "A", leaseMs: 30_000 });
      const a = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { x: 1 },
        idempotencyKey: "same-key",
      });
      const b = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { x: 1 },
        idempotencyKey: "same-key",
      });
      expect(b).toBe(a);
    });

    it("HIGH-04: a stale worker cannot record an intent after takeover", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const first = await jobs.claim(db, { owner: "W1", leaseMs: 5_000 });
      clock.advance(10_000);
      await jobs.reapExpired(db); // requeued (no intent yet)
      const second = await jobs.claim(db, { owner: "W2", leaseMs: 5_000 });
      expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
      // The stale W1 tries to record an intent: atomic lease-gate rejects it.
      await expect(
        jobs.recordIntent(db, first!, {
          kind: "op",
          descriptor: {},
          idempotencyKey: "stale-intent",
        }),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);
      const n = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM job_intents WHERE idempotency_key = 'stale-intent'",
      );
      expect(n.rows[0]!.n).toBe("0");
    });

    // ----- AUDIT-04 HIGH-01 / MEDIUM-02: intent lock fencing and JSONB equality -----

    it("AUDIT-04 HIGH-01: paused fresh intent holds the job lock through insert before any takeover", async () => {
      await seedCase("case-intent-race");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-intent-race" });
      const lease1 = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      expect(lease1).not.toBeNull();

      let releaseInsert!: () => void;
      const insertRelease = new Promise<void>((resolve) => {
        releaseInsert = resolve;
      });
      let announceInsertGate!: () => void;
      const insertGate = new Promise<void>((resolve) => {
        announceInsertGate = resolve;
      });
      const pausedDb = {
        withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
          return db.withTransaction(async (tx) => {
            const query = tx.query.bind(tx);
            let paused = false;
            const proxy = new Proxy(tx, {
              get(target, property, receiver) {
                if (property !== "query") {
                  return Reflect.get(target, property, receiver);
                }
                return async (text: string, values?: readonly unknown[]) => {
                  if (!paused && text.includes("INSERT INTO job_intents")) {
                    paused = true;
                    announceInsertGate();
                    await insertRelease;
                  }
                  return query(text, values);
                };
              },
            }) as Transaction;
            return fn(proxy);
          });
        },
      } satisfies TxDb;

      const oldIntent = jobs.recordIntent(pausedDb, lease1!, {
        kind: "http.post",
        descriptor: { destination: "user-1" },
        idempotencyKey: "intent-race",
      });
      await insertGate;
      clock.advance(20_000);

      const whileLocked = await jobs.reapExpired(db);
      expect(whileLocked.reconciling).not.toContain(lease1!.jobId);
      expect(whileLocked.requeued).not.toContain(lease1!.jobId);
      expect(await jobs.claim(db, { owner: "W2-early", leaseMs: 30_000 })).toBeNull();
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM job_intents WHERE idempotency_key = $1",
            ["intent-race"],
          )
        ).rows[0]!.count,
      ).toBe("0");

      releaseInsert();
      const intentId = await oldIntent;
      expect((await jobs.reapExpired(db)).reconciling).toContain(lease1!.jobId);
      await jobs.reconcile(db, {
        intentId,
        jobId: lease1!.jobId,
        resolution: "ABSENT",
        attemptKey: "intent-race-absent",
      });
      const lease2 = await jobs.claim(db, { owner: "W2", leaseMs: 30_000 });
      expect(lease2!.fencingToken).toBe(2);
      const intent = await db.query<{ recorded_at: Date }>(
        "SELECT recorded_at FROM job_intents WHERE intent_id = $1",
        [intentId],
      );
      expect(intent.rows[0]!.recorded_at.getTime()).toBeLessThan(
        (await jobs.findById(db, lease2!.jobId))!.leased_at!.getTime(),
      );
    });

    it("AUDIT-04 HIGH-01: stale exact replay and current-token adoption both fail after ABSENT takeover", async () => {
      await seedCase("case-intent-replay");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-intent-replay" });
      const lease1 = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const input = {
        kind: "http.post",
        descriptor: { destination: "user-1" },
        idempotencyKey: "intent-replay",
      };
      const intentId = await jobs.recordIntent(db, lease1!, input);
      clock.advance(20_000);
      await jobs.reapExpired(db);
      await jobs.reconcile(db, {
        intentId,
        jobId: lease1!.jobId,
        resolution: "ABSENT",
        attemptKey: "intent-replay-absent",
      });
      const lease2 = await jobs.claim(db, { owner: "W2", leaseMs: 30_000 });
      expect(lease2!.fencingToken).toBe(2);

      await expect(jobs.recordIntent(db, lease1!, input)).rejects.toBeInstanceOf(
        StaleFencingTokenError,
      );
      await expect(jobs.recordIntent(db, lease2!, input)).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
    });

    it("AUDIT-04 MEDIUM-02: intent descriptor replay uses semantic JSONB equality", async () => {
      await seedCase("case-descriptor");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-descriptor" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      const first = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { b: 2, a: 1 },
        idempotencyKey: "descriptor-jsonb",
      });
      const exact = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { b: 2, a: 1 },
        idempotencyKey: "descriptor-jsonb",
      });
      const reordered = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { a: 1, b: 2 },
        idempotencyKey: "descriptor-jsonb",
      });
      expect(exact).toBe(first);
      expect(reordered).toBe(first);
      await expect(
        jobs.recordIntent(db, lease!, {
          kind: "op",
          descriptor: { a: 1, b: 3 },
          idempotencyKey: "descriptor-jsonb",
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it("RA-038 WU-02: transaction-scoped intent composes and rolls back atomically", async () => {
      await seedCase("case-intent-tx");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-intent-tx" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      const input = {
        kind: "op",
        descriptor: { destination: "tx" },
        idempotencyKey: "intent-tx-rollback",
      };

      await expect(
        db.withTransaction(async (tx) => {
          await jobs.recordIntentInTransaction(tx, lease!, input);
          await tx.query(
            `INSERT INTO job_attempts
               (job_id, attempt_number, lease_owner, fencing_token, outcome, error,
                started_at, finished_at)
             VALUES ($1, $2, $3, $4, 'FAILED', $5, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))`,
            [lease!.jobId, 99, lease!.leaseOwner, lease!.fencingToken, "rollback", clock.now()],
          );
          throw new Error("rollback intent transaction");
        }),
      ).rejects.toThrow("rollback intent transaction");

      const rolledBack = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM job_intents WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      expect(rolledBack.rows[0]!.count).toBe("0");

      const wrapperInput = { ...input, idempotencyKey: "intent-wrapper-parity" };
      const wrapperId = await jobs.recordIntent(db, lease!, wrapperInput);
      const replayId = await db.withTransaction((tx) =>
        jobs.recordIntentInTransaction(tx, lease!, wrapperInput),
      );
      expect(replayId).toBe(wrapperId);
    });

    // ----- HIGH-05: cased job cannot disable per-case serialization -----
    it("HIGH-05: serializationKey=null on a cased job is forced to the case_id", async () => {
      await seedCase("case-x");
      const j1 = await jobs.enqueue(db, {
        jobType: "w",
        payload: {},
        caseId: "case-x",
        serializationKey: null,
      });
      const j2 = await jobs.enqueue(db, {
        jobType: "w",
        payload: {},
        caseId: "case-x",
        serializationKey: "some-other-key",
      });
      const rows = await db.query<{ serialization_key: string | null }>(
        "SELECT serialization_key FROM jobs WHERE job_id = ANY($1) ORDER BY job_id",
        [[j1.job_id, j2.job_id]],
      );
      expect(rows.rows.every((r) => r.serialization_key === "case-x")).toBe(true);

      // Two workers cannot both claim a job of case-x.
      const a = await jobs.claim(db, { owner: "A", leaseMs: 30_000 });
      const b = await jobs.claim(db, { owner: "B", leaseMs: 30_000 });
      const winners = [a, b].filter((l) => l !== null);
      expect(winners).toHaveLength(1);
    });

    it("HIGH-05: DB CHECK rejects a direct write giving a cased job a mismatched key", async () => {
      await seedCase("case-y");
      const j = await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-y" });
      await expect(
        db.query("UPDATE jobs SET serialization_key = 'mismatch' WHERE job_id = $1", [j.job_id]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    // ----- MEDIUM-06: UNRESOLVED can later be closed -----
    it("MEDIUM-06: an UNRESOLVED reconciliation can later be closed CONFIRMED", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: {},
        idempotencyKey: "idem-unres",
      });
      clock.advance(20_000);
      await jobs.reapExpired(db);

      const r1 = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "UNRESOLVED",
        attemptKey: "att-1",
      });
      expect(r1.jobStatus).toBe("RECONCILING");

      const r2 = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "CONFIRMED",
        attemptKey: "att-2",
        evidence: { found: true },
      });
      expect(r2.resolution).toBe("CONFIRMED");
      expect(r2.jobStatus).toBe("SUCCEEDED");

      const all = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM job_reconciliations WHERE intent_id = $1",
        [intentId],
      );
      expect(all.rows[0]!.n).toBe("2");
    });

    it("MEDIUM-06: two concurrent terminal reconciliations resolve deterministically", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "sideeffect", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: {},
        idempotencyKey: "idem-conc",
      });
      clock.advance(20_000);
      await jobs.reapExpired(db);

      const [a, b] = await Promise.all([
        jobs.reconcile(db, {
          intentId,
          jobId: lease!.jobId,
          resolution: "CONFIRMED",
          attemptKey: "c-a",
        }),
        jobs.reconcile(db, {
          intentId,
          jobId: lease!.jobId,
          resolution: "ABSENT",
          attemptKey: "c-b",
        }),
      ]);
      expect(a.resolution).toBe(b.resolution);
      const terminal = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM job_reconciliations
         WHERE intent_id = $1 AND resolution IN ('CONFIRMED','ABSENT')`,
        [intentId],
      );
      expect(terminal.rows[0]!.n).toBe("1");
    });

    // ----- MEDIUM-07: atomic transition+attempt, LEASE_LOST -----
    it("MEDIUM-07: reapExpired records a LEASE_LOST attempt for the lost lease", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 5_000 });
      clock.advance(10_000);
      await jobs.reapExpired(db);
      const history = await jobs.attemptHistory(db, lease!.jobId);
      expect(history.some((h) => h.outcome === "LEASE_LOST")).toBe(true);
    });

    it("MEDIUM-07: complete() writes the SUCCEEDED transition and attempt atomically", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      await jobs.complete(db, lease!);
      const job = await jobs.findById(db, lease!.jobId);
      const history = await jobs.attemptHistory(db, lease!.jobId);
      expect(job!.status).toBe("SUCCEEDED");
      expect(history.filter((h) => h.outcome === "SUCCEEDED")).toHaveLength(1);
    });

    it("MEDIUM-07: a long handler renews its lease via heartbeat and is not reaped", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const scheduler = new Scheduler({
        db,
        jobs,
        outbox,
        clock,
        sink: async () => undefined,
        handler: async (_lease, heartbeat) => {
          // A heartbeat must preserve the scheduler's configured lease duration. The old
          // default-only call silently shortened this 120s lease to 30s under a slow suite.
          clock.advance(20_000);
          await heartbeat();
          clock.advance(40_000);
          // A concurrent reap now must NOT steal this still-live lease.
          const reaped = await jobs.reapExpired(db);
          expect(reaped.reconciling).toHaveLength(0);
          expect(reaped.requeued).toHaveLength(0);
        },
        claim: { owner: "sched", leaseMs: 120_000 },
      });
      const result = await scheduler.tick();
      expect(result.jobOutcome).toBe("SUCCEEDED");
      const job = await jobs.findById(db, result.claimedJobId!);
      expect(job!.status).toBe("SUCCEEDED");
    });

    it("MEDIUM-07: DB-time authority — a wildly skewed second worker cannot reap/take over a fresh live lease", async () => {
      await seedCase("case-1");
      // Worker 1: real system clock, DEFAULT lease-time mode ('db'). It claims a
      // fresh, generously long lease measured by the PostgreSQL server clock.
      const worker1 = new JobStore({
        clock: new SystemClock(),
        ids: new UuidGenerator(),
        // leaseTime defaults to 'db' (authoritative PostgreSQL clock).
      });
      await worker1.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const live = await worker1.claim(db, { owner: "W1", leaseMs: 60_000 });
      expect(live).not.toBeNull();

      // Worker 2: a ManualClock set FAR in the future (year+), also DEFAULT 'db'
      // mode. Its process clock is wildly skewed, but because lease lifetime is
      // measured against clock_timestamp() on the server, its skew is irrelevant.
      const skewed = new ManualClock(Date.now() + 365 * 24 * 3_600_000);
      const worker2 = new JobStore({ clock: skewed, ids: new UuidGenerator() });

      // The skewed worker's reap must find NOTHING to reap: the lease is still
      // live on the server despite the client's year-ahead clock.
      const reaped = await worker2.reapExpired(db);
      expect(reaped.reconciling).toHaveLength(0);
      expect(reaped.requeued).toHaveLength(0);

      // And it cannot claim the case's job either (case-1 already has a live lease).
      const stolen = await worker2.claim(db, { owner: "W2", leaseMs: 60_000 });
      expect(stolen).toBeNull();

      // The original lease is intact and still owned by W1.
      const job = await worker1.findById(db, live!.jobId);
      expect(job!.status).toBe("LEASED");
      expect(job!.lease_owner).toBe("W1");

      // Sanity: the SAME skewed worker in 'injected' mode WOULD have (wrongly)
      // reaped, proving the DB-time authority is what prevents the theft.
      const skewedInjected = new JobStore({
        clock: new ManualClock(Date.now() + 365 * 24 * 3_600_000),
        ids: new UuidGenerator(),
        leaseTime: "injected",
      });
      const reapedInjected = await skewedInjected.reapExpired(db);
      // In injected mode the skewed clock is treated as authoritative, so it sees
      // the lease as long expired and reaps it. (This is exactly why 'injected'
      // is opt-in and never the production default.)
      expect(reapedInjected.requeued).toContain(live!.jobId);
    });

    // ----- AUDIT-02 HIGH-01: recordCompletion must require lease; mismatched replay must be typed conflict -----

    it("AUDIT-02 HIGH-01: stale worker with old fencing token cannot overwrite new owner via recordCompletion", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const lease1 = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      expect(lease1).not.toBeNull();

      // W1 records an intent.
      const intentId = await jobs.recordIntent(db, lease1!, {
        kind: "http.post",
        descriptor: { url: "https://api.example.com/msg" },
        idempotencyKey: "msg-123",
      });

      // Lease expires; reaper moves the job to RECONCILING (intent is unconfirmed).
      clock.advance(20_000);
      const reaped = await jobs.reapExpired(db);
      expect(reaped.reconciling).toContain(lease1!.jobId);

      // Reconcile ABSENT: side effect did NOT happen, return job to PENDING.
      await jobs.reconcile(db, {
        intentId,
        jobId: lease1!.jobId,
        resolution: "ABSENT",
        attemptKey: "recon-absent",
      });
      const jobAfterRecon = await jobs.findById(db, lease1!.jobId);
      expect(jobAfterRecon!.status).toBe("PENDING");

      // W2 claims the now-PENDING job; fencing token advances to 2.
      const lease2 = await jobs.claim(db, { owner: "W2", leaseMs: 30_000 });
      expect(lease2).not.toBeNull();
      expect(lease2!.fencingToken).toBe(2);

      // W2 records a new intent (fresh work).
      const intentId2 = await jobs.recordIntent(db, lease2!, {
        kind: "http.post",
        descriptor: { url: "https://api.example.com/msg2" },
        idempotencyKey: "msg-456",
      });

      // Stale W1 tries to record completion for intentId with its old (token=1) lease.
      // Must be rejected: lease gate checks owner + token + LEASED + alive.
      await expect(
        jobs.recordCompletion(db, {
          intentId: intentId2,
          jobId: lease1!.jobId,
          outcome: "SUCCEEDED",
          lease: lease1!, // stale: token=1, W1 no longer holds the lease
        }),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);

      // W2's lease must be intact.
      const job = await jobs.findById(db, lease1!.jobId);
      expect(job!.lease_owner).toBe("W2");
      expect(Number(job!.fencing_token)).toBe(2);
    });

    it("AUDIT-02 HIGH-01: mismatched outcome replay on same intent is typed conflict", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      expect(lease).not.toBeNull();

      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "http.post",
        descriptor: { dest: "user-1" },
        idempotencyKey: "send-123",
      });

      // First recording: SUCCEEDED with receipt { code: 200 }.
      await jobs.recordCompletion(db, {
        intentId,
        jobId: lease!.jobId,
        outcome: "SUCCEEDED",
        receipt: { code: 200 },
        lease: lease!,
      });

      // Replay with a DIFFERENT outcome (FAILED) must fail with a typed conflict.
      await expect(
        jobs.recordCompletion(db, {
          intentId,
          jobId: lease!.jobId,
          outcome: "FAILED",
          receipt: { code: 500 },
          lease: lease!,
        }),
      ).rejects.toThrow(/IdempotencyConflictError/);
    });

    // ----- AUDIT-03 HIGH-01 / MEDIUM-03: completion lock fencing and JSONB equality -----

    it("AUDIT-03 HIGH-01: completion row lock prevents reap and token-2 takeover from overtaking its insert", async () => {
      await seedCase("case-race");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-race" });
      const lease1 = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      expect(lease1).not.toBeNull();
      const intentId = await jobs.recordIntent(db, lease1!, {
        kind: "http.post",
        descriptor: { url: "https://example.test/race" },
        idempotencyKey: "completion-race",
      });

      let releaseInsert!: () => void;
      const insertRelease = new Promise<void>((resolve) => {
        releaseInsert = resolve;
      });
      let announceInsertGate!: () => void;
      const insertGate = new Promise<void>((resolve) => {
        announceInsertGate = resolve;
      });

      // Pause exactly before INSERT. recordCompletion has already locked the
      // currently live job row FOR UPDATE, so reap/takeover must wait.
      const pausedDb = {
        withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
          return db.withTransaction(async (tx) => {
            const query = tx.query.bind(tx);
            let paused = false;
            const proxy = new Proxy(tx, {
              get(target, property, receiver) {
                if (property !== "query") {
                  return Reflect.get(target, property, receiver);
                }
                return async (text: string, values?: readonly unknown[]) => {
                  if (!paused && text.includes("INSERT INTO job_completions")) {
                    paused = true;
                    announceInsertGate();
                    await insertRelease;
                  }
                  return query(text, values);
                };
              },
            }) as Transaction;
            return fn(proxy);
          });
        },
      } satisfies TxDb;

      const oldCompletion = jobs.recordCompletion(pausedDb, {
        intentId,
        jobId: lease1!.jobId,
        outcome: "SUCCEEDED",
        receipt: { externalId: "receipt-1" },
        lease: lease1!,
      });
      await insertGate;
      clock.advance(20_000);

      // Reap and claim use SKIP LOCKED: neither may process/take over this job
      // while recordCompletion holds its row lock.
      const reapedWhileLocked = await jobs.reapExpired(db);
      expect(reapedWhileLocked.reconciling).not.toContain(lease1!.jobId);
      expect(reapedWhileLocked.requeued).not.toContain(lease1!.jobId);
      expect(await jobs.claim(db, { owner: "W2-early", leaseMs: 30_000 })).toBeNull();
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM job_completions WHERE intent_id = $1",
            [intentId],
          )
        ).rows[0]!.count,
      ).toBe("0");

      releaseInsert();
      const completionId = await oldCompletion;
      const reaped = await jobs.reapExpired(db);
      expect(reaped.succeeded).toContain(lease1!.jobId);
      expect(reaped.requeued).not.toContain(lease1!.jobId);

      const lease2 = await jobs.claim(db, { owner: "W2", leaseMs: 30_000 });
      expect(lease2).toBeNull();
      const completion = await db.query<{ completion_id: string }>(
        `SELECT completion_id FROM job_completions WHERE intent_id = $1`,
        [intentId],
      );
      expect(completion.rows[0]!.completion_id).toBe(completionId);
      const job = await jobs.findById(db, lease1!.jobId);
      expect(job!.status).toBe("SUCCEEDED");
      expect(Number(job!.fencing_token)).toBe(1);
    });

    it("AUDIT-03 MEDIUM-03: completion receipt replay uses semantic JSONB equality", async () => {
      await seedCase("case-receipt");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-receipt" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "http.post",
        descriptor: { destination: "user-1" },
        idempotencyKey: "receipt-jsonb",
      });

      const first = await jobs.recordCompletion(db, {
        intentId,
        jobId: lease!.jobId,
        outcome: "SUCCEEDED",
        receipt: { a: 1, b: 2 },
        lease: lease!,
      });
      const identical = await jobs.recordCompletion(db, {
        intentId,
        jobId: lease!.jobId,
        outcome: "SUCCEEDED",
        receipt: { a: 1, b: 2 },
        lease: lease!,
      });
      const reordered = await jobs.recordCompletion(db, {
        intentId,
        jobId: lease!.jobId,
        outcome: "SUCCEEDED",
        receipt: { b: 2, a: 1 },
        lease: lease!,
      });
      expect(identical).toBe(first);
      expect(reordered).toBe(first);

      await expect(
        jobs.recordCompletion(db, {
          intentId,
          jobId: lease!.jobId,
          outcome: "SUCCEEDED",
          receipt: { a: 1, b: 3 },
          lease: lease!,
        }),
      ).rejects.toBeInstanceOf(CompletionConflictError);
    });

    it("AUDIT-04 MEDIUM-03: completion rejects a same-owner same-token lease from another job", async () => {
      await seedCase("case-completion-a");
      await seedCase("case-completion-b");
      await jobs.enqueue(db, { jobType: "a", payload: {}, caseId: "case-completion-a" });
      await jobs.enqueue(db, { jobType: "b", payload: {}, caseId: "case-completion-b" });
      const leaseA = await jobs.claim(db, { owner: "shared-worker", leaseMs: 30_000 });
      const leaseB = await jobs.claim(db, { owner: "shared-worker", leaseMs: 30_000 });
      expect(leaseA!.fencingToken).toBe(leaseB!.fencingToken);
      const intentA = await jobs.recordIntent(db, leaseA!, {
        kind: "op",
        descriptor: { job: "a" },
        idempotencyKey: "completion-cross-job",
      });

      await expect(
        jobs.recordCompletion(db, {
          intentId: intentA,
          jobId: leaseA!.jobId,
          outcome: "SUCCEEDED",
          lease: leaseB!,
        }),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM job_completions WHERE intent_id = $1",
            [intentA],
          )
        ).rows[0]!.count,
      ).toBe("0");
    });

    // ----- AUDIT-02 HIGH-02: reconcile must require RECONCILING state; attempt_key is per-intent -----

    it("AUDIT-02 HIGH-02: reconcile on a still-LEASED job is fail-closed", async () => {
      await seedCase("case-1");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      expect(lease).not.toBeNull();

      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "rpc",
        descriptor: { id: "tx-1" },
        idempotencyKey: "tx-1",
      });

      // Job is still LEASED (W1 has not finished or lost lease).
      // reconcile must fail closed rather than silently move the job.
      await expect(
        jobs.reconcile(db, {
          intentId,
          jobId: lease!.jobId,
          resolution: "CONFIRMED",
          attemptKey: "recon-1",
        }),
      ).rejects.toThrow(/job_intent_reconciling/);

      // Job must still be LEASED with W1 as owner (no side effects from reconcile).
      const job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("LEASED");
      expect(job!.lease_owner).toBe("W1");
    });

    it("AUDIT-02 HIGH-02: attempt_key scoped per-intent — same key on two intents resolves independently", async () => {
      await seedCase("case-1");
      await seedCase("case-2");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-1" });
      await jobs.enqueue(db, { jobType: "x", payload: {}, caseId: "case-2" });

      const lease1 = await jobs.claim(db, { owner: "W1", leaseMs: 30_000 });
      expect(lease1).not.toBeNull();
      const lease2 = await jobs.claim(db, { owner: "W2", leaseMs: 30_000 });
      expect(lease2).not.toBeNull();

      const intent1 = await jobs.recordIntent(db, lease1!, {
        kind: "op",
        descriptor: { id: "op1" },
        idempotencyKey: "intent-a1",
      });
      const intent2 = await jobs.recordIntent(db, lease2!, {
        kind: "op",
        descriptor: { id: "op2" },
        idempotencyKey: "intent-a2",
      });

      // Both workers record AMBIGUOUS completions → both jobs go to RECONCILING.
      await jobs.recordCompletion(db, {
        intentId: intent1,
        jobId: lease1!.jobId,
        outcome: "AMBIGUOUS",
        lease: lease1!,
      });
      await jobs.recordCompletion(db, {
        intentId: intent2,
        jobId: lease2!.jobId,
        outcome: "AMBIGUOUS",
        lease: lease2!,
      });

      // Reconcile both with the SAME attempt key.
      const recon1 = await jobs.reconcile(db, {
        intentId: intent1,
        jobId: lease1!.jobId,
        resolution: "UNRESOLVED",
        attemptKey: "shared-key",
      });
      const recon2 = await jobs.reconcile(db, {
        intentId: intent2,
        jobId: lease2!.jobId,
        resolution: "CONFIRMED",
        attemptKey: "shared-key", // same key — different intent
      });

      // Results must be independent: different reconciliation IDs, correct outcomes.
      expect(recon1.reconciliationId).not.toBe(recon2.reconciliationId);
      expect(recon1.resolution).toBe("UNRESOLVED");
      expect(recon2.resolution).toBe("CONFIRMED");

      const job1 = await jobs.findById(db, lease1!.jobId);
      const job2 = await jobs.findById(db, lease2!.jobId);
      expect(job1!.status).toBe("RECONCILING");
      expect(job2!.status).toBe("SUCCEEDED");
    });

    // ----- AUDIT-03 HIGH-02: reconciliation replay provenance and semantics -----

    it("AUDIT-03 HIGH-02: same reconciliation key rejects mismatched resolution or evidence", async () => {
      await seedCase("case-reconcile");
      await jobs.enqueue(db, { jobType: "w", payload: {}, caseId: "case-reconcile" });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "rpc",
        descriptor: { operation: "lookup" },
        idempotencyKey: "reconcile-semantics",
      });
      clock.advance(20_000);
      await jobs.reapExpired(db);

      const first = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "UNRESOLVED",
        attemptKey: "same-key",
        evidence: { checked: true, result: { found: false } },
      });
      const reordered = await jobs.reconcile(db, {
        intentId,
        jobId: lease!.jobId,
        resolution: "UNRESOLVED",
        attemptKey: "same-key",
        evidence: { result: { found: false }, checked: true },
      });
      expect(reordered.reconciliationId).toBe(first.reconciliationId);

      await expect(
        jobs.reconcile(db, {
          intentId,
          jobId: lease!.jobId,
          resolution: "CONFIRMED",
          attemptKey: "same-key",
          evidence: { checked: true, result: { found: true } },
        }),
      ).rejects.toBeInstanceOf(ReconciliationConflictError);
      await expect(
        jobs.reconcile(db, {
          intentId,
          jobId: lease!.jobId,
          resolution: "UNRESOLVED",
          attemptKey: "same-key",
          evidence: { checked: true, result: { found: true } },
        }),
      ).rejects.toBeInstanceOf(ReconciliationConflictError);
    });

    it("AUDIT-03 HIGH-02: reconciliation replay rejects an unrelated input job before early return", async () => {
      await seedCase("case-reconcile-a");
      await seedCase("case-reconcile-b");
      await jobs.enqueue(db, { jobType: "a", payload: {}, caseId: "case-reconcile-a" });
      await jobs.enqueue(db, { jobType: "b", payload: {}, caseId: "case-reconcile-b" });
      const leaseA = await jobs.claim(db, { owner: "WA", leaseMs: 10_000 });
      const leaseB = await jobs.claim(db, { owner: "WB", leaseMs: 30_000 });
      const intentA = await jobs.recordIntent(db, leaseA!, {
        kind: "rpc",
        descriptor: { operation: "lookup-a" },
        idempotencyKey: "reconcile-job-a",
      });
      clock.advance(20_000);
      await jobs.reapExpired(db);
      await jobs.reconcile(db, {
        intentId: intentA,
        jobId: leaseA!.jobId,
        resolution: "UNRESOLVED",
        attemptKey: "same-key",
        evidence: { checked: true },
      });

      await expect(
        jobs.reconcile(db, {
          intentId: intentA,
          jobId: leaseB!.jobId,
          resolution: "UNRESOLVED",
          attemptKey: "same-key",
          evidence: { checked: true },
        }),
      ).rejects.toThrow(/job_intent/);
      expect((await jobs.findById(db, leaseB!.jobId))!.status).toBe("LEASED");
    });

    // ----- AUDIT-02 MEDIUM-03: backoff available_at base and due predicate both use DB clock -----

    it("AUDIT-02 MEDIUM-03: db-time mode sets available_at from DB clock; skewed worker cannot claim early", async () => {
      await seedCase("case-3");

      // Use a db-time store with real SystemClock for W1.
      const w1 = new JobStore({
        clock: new SystemClock(),
        ids: new UuidGenerator(),
        leaseTime: "db",
      });
      await w1.enqueue(db, { jobType: "w", payload: {}, caseId: "case-3" });

      // W1 claims and fails → available_at = clock_timestamp() + backoff.
      const lease1 = await w1.claim(db, { owner: "W1-db", leaseMs: 5_000 });
      expect(lease1).not.toBeNull();
      const fs = await w1.fail(db, lease1!, "transient");
      expect(fs).toBe("PENDING");

      // Immediately after fail, the job's available_at is DB-now + ~1h.
      // A worker with a process clock 1 year ahead (db-time mode) should NOT be
      // able to claim because available_at check uses clock_timestamp() on the DB,
      // which is still before the stored available_at.
      const futureMs = Date.now() + 365 * 24 * 3_600_000;
      const w2 = new JobStore({
        clock: new ManualClock(futureMs),
        ids: new UuidGenerator(),
        leaseTime: "db",
      });
      const stolen = await w2.claim(db, { owner: "W2-skewed", leaseMs: 30_000 });
      expect(stolen).toBeNull();
    });

    // ----- AUDIT-04 MEDIUM-04: initial availability follows the clock mode -----

    it("AUDIT-04 MEDIUM-04: DB-time job enqueue is immediately claimable despite future process clock", async () => {
      await seedCase("case-db-immediate");
      await seedCase("case-db-explicit");
      const futureClock = new ManualClock(Date.now() + 365 * 24 * 3_600_000);
      const dbJobs = new JobStore({ clock: futureClock, ids: new UuidGenerator() });
      const immediate = await dbJobs.enqueue(db, {
        jobType: "immediate",
        payload: {},
        caseId: "case-db-immediate",
      });
      expect(await dbJobs.claim(db, { owner: "db-worker", leaseMs: 30_000 })).toMatchObject({
        jobId: immediate.job_id,
      });

      const explicitFuture = Date.now() + 3_600_000;
      await dbJobs.enqueue(db, {
        jobType: "scheduled",
        payload: {},
        caseId: "case-db-explicit",
        availableAtMs: explicitFuture,
      });
      expect(await dbJobs.claim(db, { owner: "db-worker-2", leaseMs: 30_000 })).toBeNull();
    });

    it("AUDIT-04 MEDIUM-04: injected job enqueue remains deterministic", async () => {
      await seedCase("case-injected-immediate");
      const injectedClock = new ManualClock(5_000_000);
      const injectedJobs = new JobStore({
        clock: injectedClock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      const row = await injectedJobs.enqueue(db, {
        jobType: "immediate",
        payload: {},
        caseId: "case-injected-immediate",
      });
      expect(row.available_at.getTime()).toBe(injectedClock.now());
      expect(await injectedJobs.claim(db, { owner: "injected-worker" })).toMatchObject({
        jobId: row.job_id,
      });
    });

    it("AUDIT-04 MEDIUM-04: DB-time outbox dispatch is immediately relayable despite future process clock", async () => {
      const futureClock = new ManualClock(Date.now() + 365 * 24 * 3_600_000);
      const dbOutbox = new OutboxRepository({ clock: futureClock, ids: new UuidGenerator() });
      let outboxId = "";
      await db.withTransaction(async (tx) => {
        outboxId = (
          await dbOutbox.enqueue(tx, {
            aggregate: "case",
            aggregateId: "case-db-outbox",
            eventType: "created",
            payload: {},
          })
        ).outbox_id;
      });
      const published: string[] = [];
      const result = await dbOutbox.relayOnce(db, async (message) => {
        published.push(message.outbox_id);
      });
      expect(result.published).toEqual([outboxId]);
      expect(published).toEqual([outboxId]);
    });

    // ----- AUDIT-05 HIGH-01: semantic completion recovery after lease loss -----

    it("AUDIT-05 HIGH-01: crash after SUCCEEDED receipt reconstructs success without token-2 replay", async () => {
      await seedCase("case-recover-success");
      await jobs.enqueue(db, {
        jobType: "sideeffect",
        payload: {},
        caseId: "case-recover-success",
      });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const intentId = await jobs.recordIntent(db, lease!, {
        kind: "http.post",
        descriptor: { destination: "user-1" },
        idempotencyKey: "recover-success-1",
      });
      await jobs.recordCompletion(db, {
        intentId,
        jobId: lease!.jobId,
        outcome: "SUCCEEDED",
        receipt: { externalId: "R-1" },
        lease: lease!,
      });
      // Crash before jobs.complete(); only the durable receipt remains.
      clock.advance(20_000);
      const recovered = await jobs.reapExpired(db);
      expect(recovered.succeeded).toEqual([lease!.jobId]);
      expect(recovered.requeued).toHaveLength(0);
      expect(recovered.reconciling).toHaveLength(0);

      const job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("SUCCEEDED");
      expect(job!.lease_owner).toBeNull();
      expect(job!.lease_expires_at).toBeNull();
      expect(job!.finished_at).not.toBeNull();
      expect(Number(job!.fencing_token)).toBe(1);
      expect(await jobs.claim(db, { owner: "W2", leaseMs: 30_000 })).toBeNull();
      const intents = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM job_intents WHERE job_id = $1",
        [lease!.jobId],
      );
      expect(intents.rows[0]!.count).toBe("1");
      expect(await jobs.attemptHistory(db, lease!.jobId)).toEqual([
        expect.objectContaining({
          outcome: "SUCCEEDED",
          error: expect.stringContaining("reconstructed success"),
        }),
      ]);
    });

    it("AUDIT-05 HIGH-01: all-success multi-intent ledger reconstructs success", async () => {
      await jobs.enqueue(db, { jobType: "multi", payload: {} });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      for (const suffix of ["a", "b"]) {
        const intentId = await jobs.recordIntent(db, lease!, {
          kind: "op",
          descriptor: { suffix },
          idempotencyKey: `all-success-${suffix}`,
        });
        await jobs.recordCompletion(db, {
          intentId,
          jobId: lease!.jobId,
          outcome: "SUCCEEDED",
          receipt: { suffix },
          lease: lease!,
        });
      }
      clock.advance(20_000);
      const recovered = await jobs.reapExpired(db);
      expect(recovered.succeeded).toEqual([lease!.jobId]);
      expect((await jobs.findById(db, lease!.jobId))!.status).toBe("SUCCEEDED");
    });

    it.each(["FAILED", "MISSING", "AMBIGUOUS"] as const)(
      "AUDIT-05 HIGH-01: SUCCEEDED plus %s multi-intent state fails closed",
      async (secondState) => {
        await jobs.enqueue(db, { jobType: `partial-${secondState}`, payload: {} });
        const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
        const succeededIntent = await jobs.recordIntent(db, lease!, {
          kind: "op",
          descriptor: { step: 1 },
          idempotencyKey: `partial-success-${secondState}`,
        });
        await jobs.recordCompletion(db, {
          intentId: succeededIntent,
          jobId: lease!.jobId,
          outcome: "SUCCEEDED",
          lease: lease!,
        });
        const secondIntent = await jobs.recordIntent(db, lease!, {
          kind: "op",
          descriptor: { step: 2 },
          idempotencyKey: `partial-second-${secondState}`,
        });
        if (secondState === "FAILED") {
          await jobs.recordCompletion(db, {
            intentId: secondIntent,
            jobId: lease!.jobId,
            outcome: "FAILED",
            lease: lease!,
          });
        } else if (secondState === "AMBIGUOUS") {
          // Simulate a crash after the ledger insert but before AMBIGUOUS moved
          // the job to RECONCILING, leaving the reaper to classify the ledger.
          await db.query(
            `INSERT INTO job_completions
               (completion_id, intent_id, job_id, outcome, recorded_at)
             VALUES ($1, $2, $3, 'AMBIGUOUS', to_timestamp($4 / 1000.0))`,
            [`partial-ambiguous-${secondState}`, secondIntent, lease!.jobId, clock.now()],
          );
        }

        clock.advance(20_000);
        const recovered = await jobs.reapExpired(db);
        expect(recovered.reconciling).toEqual([lease!.jobId]);
        expect(recovered.requeued).toHaveLength(0);
        expect(recovered.succeeded).toHaveLength(0);
        expect((await jobs.findById(db, lease!.jobId))!.status).toBe("RECONCILING");
        expect(await jobs.claim(db, { owner: "W2" })).toBeNull();
        expect(await jobs.attemptHistory(db, lease!.jobId)).toEqual([
          expect.objectContaining({
            outcome: "LEASE_LOST",
            error: expect.stringContaining("reconciliation required"),
          }),
        ]);
      },
    );

    it("AUDIT-05 HIGH-01: no-intent and FAILED-only expired jobs safely requeue", async () => {
      await jobs.enqueue(db, { jobType: "no-intent", payload: {} });
      await jobs.enqueue(db, { jobType: "failed-only", payload: {} });
      const first = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const second = await jobs.claim(db, { owner: "W2", leaseMs: 10_000 });
      const noIntent = first!.jobType === "no-intent" ? first! : second!;
      const failedOnly = first!.jobType === "failed-only" ? first! : second!;
      const failedIntent = await jobs.recordIntent(db, failedOnly, {
        kind: "op",
        descriptor: { result: "failed" },
        idempotencyKey: "failed-only",
      });
      await jobs.recordCompletion(db, {
        intentId: failedIntent,
        jobId: failedOnly.jobId,
        outcome: "FAILED",
        lease: failedOnly,
      });

      clock.advance(20_000);
      const recovered = await jobs.reapExpired(db);
      expect(recovered.requeued).toEqual(
        expect.arrayContaining([noIntent.jobId, failedOnly.jobId]),
      );
      expect(recovered.reconciling).toHaveLength(0);
      expect(recovered.succeeded).toHaveLength(0);
      expect((await jobs.findById(db, noIntent.jobId))!.status).toBe("PENDING");
      expect((await jobs.findById(db, failedOnly.jobId))!.status).toBe("PENDING");
    });

    // ----- AUDIT-06 HIGH-01: reconciliation uses the global effective-state matrix -----

    it("AUDIT-06 HIGH-01: success plus missing resolved ABSENT stays RECONCILING without token 2", async () => {
      await jobs.enqueue(db, { jobType: "success-absent", payload: {} });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const succeededIntent = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { step: 1 },
        idempotencyKey: "matrix-success",
      });
      await jobs.recordCompletion(db, {
        intentId: succeededIntent,
        jobId: lease!.jobId,
        outcome: "SUCCEEDED",
        receipt: { externalId: "R-1" },
        lease: lease!,
      });
      const missingIntent = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { step: 2 },
        idempotencyKey: "matrix-missing",
      });
      clock.advance(20_000);
      expect((await jobs.reapExpired(db)).reconciling).toContain(lease!.jobId);

      const resolved = await jobs.reconcile(db, {
        intentId: missingIntent,
        jobId: lease!.jobId,
        resolution: "ABSENT",
        attemptKey: "matrix-missing-absent",
        evidence: { checked: true },
      });
      expect(resolved.jobStatus).toBe("RECONCILING");
      const job = await jobs.findById(db, lease!.jobId);
      expect(job!.status).toBe("RECONCILING");
      expect(Number(job!.fencing_token)).toBe(1);
      expect(await jobs.claim(db, { owner: "W2", leaseMs: 30_000 })).toBeNull();
    });

    it("AUDIT-06 HIGH-01: confirming one of two missing intents stays RECONCILING, then all-success closes", async () => {
      await jobs.enqueue(db, { jobType: "two-missing", payload: {} });
      const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
      const firstIntent = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { step: 1 },
        idempotencyKey: "matrix-confirm-1",
      });
      const secondIntent = await jobs.recordIntent(db, lease!, {
        kind: "op",
        descriptor: { step: 2 },
        idempotencyKey: "matrix-confirm-2",
      });
      clock.advance(20_000);
      await jobs.reapExpired(db);

      const first = await jobs.reconcile(db, {
        intentId: firstIntent,
        jobId: lease!.jobId,
        resolution: "CONFIRMED",
        attemptKey: "matrix-confirm-attempt-1",
      });
      expect(first.jobStatus).toBe("RECONCILING");
      expect((await jobs.findById(db, lease!.jobId))!.status).toBe("RECONCILING");

      const second = await jobs.reconcile(db, {
        intentId: secondIntent,
        jobId: lease!.jobId,
        resolution: "CONFIRMED",
        attemptKey: "matrix-confirm-attempt-2",
      });
      expect(second.jobStatus).toBe("SUCCEEDED");
      expect((await jobs.findById(db, lease!.jobId))!.status).toBe("SUCCEEDED");
      const completions = await db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM job_completions WHERE job_id = $1",
        [lease!.jobId],
      );
      expect(completions.rows[0]!.count).toBe("0");
    });

    it.each([
      { completion: "SUCCEEDED", resolution: "ABSENT" },
      { completion: "FAILED", resolution: "CONFIRMED" },
    ] as const)(
      "AUDIT-06 HIGH-01: existing $completion completion conflicts with $resolution resolution",
      async ({ completion, resolution }) => {
        await jobs.enqueue(db, { jobType: `conflict-${completion}`, payload: {} });
        const lease = await jobs.claim(db, { owner: "W1", leaseMs: 10_000 });
        const conflictingIntent = await jobs.recordIntent(db, lease!, {
          kind: "op",
          descriptor: { step: 1 },
          idempotencyKey: `completion-conflict-${completion}`,
        });
        await jobs.recordCompletion(db, {
          intentId: conflictingIntent,
          jobId: lease!.jobId,
          outcome: completion,
          lease: lease!,
        });
        await jobs.recordIntent(db, lease!, {
          kind: "op",
          descriptor: { step: 2 },
          idempotencyKey: `completion-conflict-missing-${completion}`,
        });
        clock.advance(20_000);
        await jobs.reapExpired(db);

        await expect(
          jobs.reconcile(db, {
            intentId: conflictingIntent,
            jobId: lease!.jobId,
            resolution,
            attemptKey: `completion-conflict-attempt-${completion}`,
          }),
        ).rejects.toBeInstanceOf(ReconciliationConflictError);
        expect((await jobs.findById(db, lease!.jobId))!.status).toBe("RECONCILING");
        const reconciliation = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM job_reconciliations WHERE intent_id = $1",
          [conflictingIntent],
        );
        expect(reconciliation.rows[0]!.count).toBe("0");
      },
    );
  },
  available,
);
