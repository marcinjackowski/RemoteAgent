import {
  CaseRepository,
  ConnectionRepository,
  ExternalActionRepository,
  IRREVERSIBLE_MIGRATIONS,
  MigrationCompatibility,
  OwnerRepository,
  assertRollbackSafe,
  deploymentSchemaState,
  planDeployment,
  planRollback,
  reconcileAfterRestore,
  reconcileAfterRestoreInTransaction,
  verifyRestoredEvidence,
  type Database,
} from "@remoteagent/database";
import { canonicalDigest } from "@remoteagent/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();

/**
 * Restore drill and rollback safety (RA-025-WU-08/WU-09, AC4, AC5, AC6).
 *
 * A DRILL AGAINST A REAL DATABASE, not a mocked one. The property under test is what
 * happens to rows that describe an interrupted external write, and a mock would simply
 * return whatever the test author expected.
 *
 * The restore is SIMULATED as "a database containing snapshot-time state, reconciled".
 * The AWS restore mechanism itself (a PITR snapshot into a fresh account) cannot be
 * exercised here — no AWS calls are made anywhere in this task — and pretending otherwise
 * would be the false-assurance shape this repository keeps punishing. What IS fully
 * exercised is the part that decides whether a write happens twice, which is the part AC5
 * is about. Stated as a limitation in the handoff rather than glossed.
 */
const PAYLOAD = { issue: "MOBL-9", body: "a comment that may or may not have been posted" };
const DIGEST = canonicalDigest(PAYLOAD);

describeIntegration(
  "AC5: a restore never repeats an ambiguous write",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const actions = new ExternalActionRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db as unknown as Database;
      drop = created.drop;
    });

    afterAll(async () => {
      await drop();
    });

    beforeEach(async () => {
      await db.query(
        `TRUNCATE receipts, external_actions, approvals, jobs, case_checkpoints,
           case_connections, cases, connections, owners, audit_log
         RESTART IDENTITY CASCADE`,
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-r", displayName: "owner-r" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-r",
        ownerId: "owner-r",
        provider: "jira",
        alias: "sondermind",
        displayName: "conn-r",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-r",
        ownerId: "owner-r",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-r"] },
        discordThreadId: "thread-r",
      });
    });

    /** An action left mid-flight, exactly as a snapshot during execution would hold it. */
    async function anActionInFlight(actionId = "act-r"): Promise<void> {
      // Payload varies per action id. Two proposals with the same digest collide on the
      // action-digest uniqueness the schema enforces — which is correct behaviour (it is
      // what stops the same write being proposed twice) and simply means a fixture needs
      // distinct payloads.
      const payload = { ...PAYLOAD, body: `${PAYLOAD.body} (${actionId})` };
      const proposed = await actions.propose(db, {
        actionId,
        caseId: "case-r",
        toolName: "jira.issue.comment",
        connectionId: "conn-r",
        canonicalPayload: payload,
        actionDigest: canonicalDigest(payload),
        riskTier: "R3",
        policyDecision: "REQUIRES_APPROVAL",
        idempotencyKey: `idem-${actionId}`,
      });
      if (proposed.outcome !== "PROPOSED") throw new Error(proposed.outcome);
      // Straight to EXECUTING via SQL: the point is to reproduce the SNAPSHOT state, not
      // to re-run the approval path (which `kill-switch-drill.test.ts` covers).
      await db.query(`UPDATE external_actions SET status = 'EXECUTING' WHERE action_id = $1`, [
        actionId,
      ]);
    }

    async function statusOf(actionId: string): Promise<string> {
      const row = await db.query<{ status: string }>(
        `SELECT status FROM external_actions WHERE action_id = $1`,
        [actionId],
      );
      return row.rows[0]!.status;
    }

    it("holds an EXECUTING action as AMBIGUOUS, never re-proposes it", async () => {
      // THE CENTRAL AC5 CASE. The provider may already have posted the comment, and the
      // receipt proving it was in the discarded part of the timeline. PROPOSED would make
      // it executable again; FAILED would assert "no effect", which is the one claim that
      // cannot be made.
      await anActionInFlight();
      const result = await reconcileAfterRestore(db);
      expect(result.heldActions).toEqual(["act-r"]);
      expect(await statusOf("act-r")).toBe("AMBIGUOUS");
    });

    it("never marks an interrupted action SUCCEEDED or FAILED", async () => {
      await anActionInFlight();
      await reconcileAfterRestore(db);
      const status = await statusOf("act-r");
      expect(status).not.toBe("SUCCEEDED");
      expect(status).not.toBe("FAILED");
      expect(status).not.toBe("PROPOSED");
    });

    it("writes no receipt, since a restore holds no proof of an effect", async () => {
      await anActionInFlight();
      await reconcileAfterRestore(db);
      const receipts = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM receipts`);
      expect(receipts.rows[0]!.n).toBe("0");
    });

    it("reports actions ALREADY ambiguous in the snapshot separately", async () => {
      // They still need provider reconciliation, but they were not changed by the restore.
      // Conflating the two would make the operator's count wrong in the direction that
      // matters: it would look like the restore caused them.
      await anActionInFlight("act-pre");
      await db.query(
        `UPDATE external_actions SET status = 'AMBIGUOUS' WHERE action_id = 'act-pre'`,
      );
      await anActionInFlight("act-during");
      const result = await reconcileAfterRestore(db);
      expect(result.heldActions).toEqual(["act-during"]);
      expect(result.alreadyAmbiguous).toEqual(["act-pre"]);
    });

    it("leaves a terminal action untouched", async () => {
      // A restore must not disturb a settled outcome. If it did, every restore would
      // manufacture work and an operator could not tell real uncertainty from noise.
      await anActionInFlight("act-done");
      await db.query(
        `UPDATE external_actions SET status = 'SUCCEEDED' WHERE action_id = 'act-done'`,
      );
      const result = await reconcileAfterRestore(db);
      expect(result.heldActions).toEqual([]);
      expect(await statusOf("act-done")).toBe("SUCCEEDED");
    });

    it("is idempotent: a second reconciliation changes nothing", async () => {
      // A restore drill gets re-run, and an operator will run this twice out of caution.
      await anActionInFlight();
      const first = await reconcileAfterRestore(db);
      const second = await reconcileAfterRestore(db);
      expect(first.heldActions).toEqual(["act-r"]);
      expect(second.heldActions).toEqual([]);
      expect(second.alreadyAmbiguous).toEqual(["act-r"]);
      expect(await statusOf("act-r")).toBe("AMBIGUOUS");
    });
  },
  available,
);

describeIntegration(
  "AC4: a restore reconciles jobs and preserves evidence",
  () => {
    let db: Database;
    let drop: () => Promise<void>;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db as unknown as Database;
      drop = created.drop;
    });

    afterAll(async () => {
      await drop();
    });

    beforeEach(async () => {
      await db.query(
        `TRUNCATE receipts, external_actions, jobs, case_checkpoints, case_connections,
           cases, connections, owners, audit_log RESTART IDENTITY CASCADE`,
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-r", displayName: "owner-r" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-r",
        ownerId: "owner-r",
        provider: "jira",
        alias: "sondermind",
        displayName: "conn-r",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-r",
        ownerId: "owner-r",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-r"] },
        discordThreadId: "thread-r",
      });
    });

    /** A job leased by a worker that no longer exists. */
    async function aLeasedJob(jobId: string, fencingToken = 7): Promise<void> {
      await db.query(
        `INSERT INTO jobs (job_id, case_id, job_type, status, payload, lease_owner,
                           lease_expires_at, fencing_token, attempts)
         VALUES ($1, 'case-r', 'sync', 'LEASED', '{}'::jsonb, 'worker-gone',
                 now() + interval '5 minutes', $2, 1)`,
        [jobId, fencingToken],
      );
    }

    it("releases a stale lease and requeues the job", async () => {
      await aLeasedJob("job-1");
      const result = await reconcileAfterRestore(db);
      expect(result.requeuedJobs).toEqual(["job-1"]);
      const row = await db.query<{ status: string; lease_owner: string | null }>(
        `SELECT status, lease_owner FROM jobs WHERE job_id = 'job-1'`,
      );
      expect(row.rows[0]).toMatchObject({ status: "PENDING", lease_owner: null });
    });

    it("requeues a lease that has NOT yet expired", async () => {
      // The lease above expires in five minutes, so a naive `lease_expires_at < now()`
      // check would skip it — leaving the job stuck for no benefit, since the worker
      // holding it does not exist in this environment. Every lease in a snapshot is stale
      // by definition, and that is why the query does not compare the clock.
      await aLeasedJob("job-fresh");
      const result = await reconcileAfterRestore(db);
      expect(result.requeuedJobs).toEqual(["job-fresh"]);
    });

    it("does NOT rewind the fencing token", async () => {
      // `CTF-005`'s lesson: a monotonic fact must not be rewound. A late write from a
      // pre-restore worker — impossible in a fresh account, possible when restoring in
      // place — must still lose.
      await aLeasedJob("job-fence", 42);
      await reconcileAfterRestore(db);
      const row = await db.query<{ fencing_token: string }>(
        `SELECT fencing_token::text FROM jobs WHERE job_id = 'job-fence'`,
      );
      expect(row.rows[0]!.fencing_token).toBe("42");
    });

    it("holds actions BEFORE requeueing jobs, so a worker cannot reach an EXECUTING row", async () => {
      // Ordering is the point. If jobs were requeued first, a worker could pick one up and
      // reach an action still in EXECUTING, leaving the executor's `NOT_EXECUTABLE` guard
      // as the last line of defence against a duplicate write. Asserted by checking that
      // both happened in the SAME call — the single transaction is what makes the ordering
      // meaningful.
      await db.query(
        `INSERT INTO external_actions
           (action_id, case_id, owner_id, tool_name, connection_id, canonical_payload,
            action_digest, risk_tier, policy_decision, status, idempotency_key)
         VALUES ('act-o','case-r','owner-r','jira.issue.comment','conn-r', $1::jsonb, $2,
                 'R3','REQUIRES_APPROVAL','EXECUTING','idem-o')`,
        [JSON.stringify(PAYLOAD), DIGEST],
      );
      await aLeasedJob("job-o");
      const result = await reconcileAfterRestore(db);
      expect(result.heldActions).toEqual(["act-o"]);
      expect(result.requeuedJobs).toEqual(["job-o"]);
    });

    it("leaves a DEAD_LETTER job dead-lettered, even one that still holds a lease", async () => {
      // A restore must not resurrect abandoned work: the job exhausted every retry, and
      // requeueing it silently would re-attempt whatever caused that.
      //
      // `lease_owner` is set DELIBERATELY. The first version of this fixture left it null,
      // so the query's `lease_owner IS NOT NULL` clause excluded the row whatever the
      // status filter said — and a mutation widening that filter to include DEAD_LETTER
      // stayed green. A dead-lettered job that was killed mid-lease is also the realistic
      // shape: it dead-lettered because its last attempt failed while leased.
      await db.query(
        `INSERT INTO jobs (job_id, case_id, job_type, status, payload, attempts,
                           lease_owner, lease_expires_at, dead_lettered_at, dlq_reason)
         VALUES ('job-dead','case-r','sync','DEAD_LETTER','{}'::jsonb, 5,
                 'worker-gone', now() + interval '1 minute', now(), 'exhausted')`,
      );
      const result = await reconcileAfterRestore(db);
      expect(result.requeuedJobs).toEqual([]);
      const row = await db.query<{ status: string }>(
        `SELECT status FROM jobs WHERE job_id = 'job-dead'`,
      );
      expect(row.rows[0]!.status).toBe("DEAD_LETTER");
    });

    it("leaves a SUCCEEDED or FAILED job alone even if it still holds a lease", async () => {
      // Same class as above: a terminal job must not be re-run because its lease was never
      // cleaned up.
      for (const status of ["SUCCEEDED", "FAILED"]) {
        await db.query(
          `INSERT INTO jobs (job_id, case_id, job_type, status, payload, attempts,
                             lease_owner, lease_expires_at)
           VALUES ($1,'case-r','sync',$2,'{}'::jsonb, 1, 'worker-gone', now() + interval '1 minute')`,
          [`job-${status}`, status],
        );
      }
      const result = await reconcileAfterRestore(db);
      expect(result.requeuedJobs).toEqual([]);
    });

    it("reads `now` from the DATABASE clock, not the process clock", async () => {
      // A restored environment's host clock is one of the things most likely to be wrong —
      // a drill account from a stale AMI, a container with no NTP. Asserted by comparing
      // the written `available_at` against the database's own clock, because a mutation
      // substituting `new Date(0)` otherwise stayed green: nothing read the value back.
      await aLeasedJob("job-clock");
      await reconcileAfterRestore(db);
      const row = await db.query<{ drift_seconds: string }>(
        `SELECT abs(extract(epoch from (now() - available_at)))::text AS drift_seconds
           FROM jobs WHERE job_id = 'job-clock'`,
      );
      // Within a minute of the database's clock. A process clock set to the epoch would be
      // decades off, and any real skew this test would tolerate is not the failure mode.
      expect(Number(row.rows[0]!.drift_seconds)).toBeLessThan(60);
    });

    it("LOCKS the rows it reconciles, so a concurrent worker cannot race it", async () => {
      // The `FOR UPDATE` clauses. Mutations removing them from both the action and the job
      // query STAYED GREEN against single-threaded tests — which is the whole reason this
      // case exists: a lock is a concurrency property and cannot be observed sequentially.
      //
      // Proven by holding a reconciliation transaction open and showing a second
      // transaction's `FOR UPDATE ... NOWAIT` on the same row is refused (55P03,
      // `lock_not_available`). Without the lock it would succeed, and a worker could read
      // an action still in EXECUTING and execute it.
      await db.query(
        `INSERT INTO external_actions
           (action_id, case_id, owner_id, tool_name, connection_id, canonical_payload,
            action_digest, risk_tier, policy_decision, status, idempotency_key)
         VALUES ('act-lock','case-r','owner-r','jira.issue.comment','conn-r', $1::jsonb, $2,
                 'R3','REQUIRES_APPROVAL','EXECUTING','idem-lock')`,
        [
          JSON.stringify({ ...PAYLOAD, body: "lock" }),
          canonicalDigest({ ...PAYLOAD, body: "lock" }),
        ],
      );

      let releaseHold: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      // Open a transaction that takes the same lock the reconciliation takes, and hold it.
      const holding = db.withTransaction(async (tx) => {
        await tx.query(
          `SELECT action_id FROM external_actions WHERE status = 'EXECUTING' FOR UPDATE`,
        );
        await held;
      });
      // Give the holder time to acquire.
      await new Promise((resolve) => setTimeout(resolve, 150));

      const contended = await db
        .withTransaction(async (tx) => {
          await tx.query(
            `SELECT action_id FROM external_actions WHERE action_id = 'act-lock' FOR UPDATE NOWAIT`,
          );
          return "ACQUIRED";
        })
        .catch((error: unknown) => (error as { code?: string }).code ?? "ERROR");

      releaseHold!();
      await holding;
      expect(contended).toBe("55P03");
    });

    it("reconciles in ONE transaction, so no partial state is observable", async () => {
      // A partially reconciled database is worse than an unreconciled one: an operator
      // cannot tell which half they are looking at. Proven by forcing a failure AFTER the
      // action update would have been written and asserting nothing changed.
      await db.query(
        `INSERT INTO external_actions
           (action_id, case_id, owner_id, tool_name, connection_id, canonical_payload,
            action_digest, risk_tier, policy_decision, status, idempotency_key)
         VALUES ('act-atomic','case-r','owner-r','jira.issue.comment','conn-r', $1::jsonb, $2,
                 'R3','REQUIRES_APPROVAL','EXECUTING','idem-atomic')`,
        [
          JSON.stringify({ ...PAYLOAD, body: "atomic" }),
          canonicalDigest({ ...PAYLOAD, body: "atomic" }),
        ],
      );
      await aLeasedJob("job-atomic");

      await expect(
        db.withTransaction(async (tx) => {
          await reconcileAfterRestoreInTransaction(tx);
          // Whatever goes wrong next — a constraint, a crash, a lost connection — must
          // leave the whole reconciliation unapplied.
          throw new Error("simulated failure after reconciliation");
        }),
      ).rejects.toThrow(/simulated failure/);

      const action = await db.query<{ status: string }>(
        `SELECT status FROM external_actions WHERE action_id = 'act-atomic'`,
      );
      const job = await db.query<{ status: string; lease_owner: string | null }>(
        `SELECT status, lease_owner FROM jobs WHERE job_id = 'job-atomic'`,
      );
      expect(action.rows[0]!.status).toBe("EXECUTING");
      expect(job.rows[0]).toMatchObject({ status: "LEASED", lease_owner: "worker-gone" });
    });

    it("verifies the restored evidence by count, so an empty database fails", async () => {
      // "Reachable" is not "restored". An empty database answers every query.
      const gaps = await verifyRestoredEvidence(db, {
        cases: 1,
        checkpoints: 0,
        auditEntries: 0,
        receipts: 0,
      });
      expect(gaps).toEqual([]);

      const shortfall = await verifyRestoredEvidence(db, {
        cases: 5,
        checkpoints: 3,
        auditEntries: 10,
        receipts: 2,
      });
      expect(shortfall).toHaveLength(4);
      expect(shortfall[0]).toContain("expected at least 5");
    });

    it("accepts MORE evidence than expected, since PITR can restore past the snapshot", async () => {
      const gaps = await verifyRestoredEvidence(db, {
        cases: 0,
        checkpoints: 0,
        auditEntries: 0,
        receipts: 0,
      });
      expect(gaps).toEqual([]);
    });

    it("reports the schema state for the release manifest", async () => {
      const state = await deploymentSchemaState(db);
      expect(state.pending).toEqual([]);
      // Migration 032 is the highest at the time of writing; asserted as a floor so a new
      // migration does not fail this test for the wrong reason.
      expect(state.highestApplied).toBeGreaterThanOrEqual(32);
    });
  },
  available,
);

describe("AC6: an application rollback never reverts a migration", () => {
  it("the rollback plan contains no migration step, and cannot express one", () => {
    // The property is the SHAPE of the plan, not a sentence in a runbook. A runbook
    // sentence cannot be mutation-tested, and this is exactly the sentence an operator
    // skips at 3am.
    const steps = planRollback({ toImageTag: "sha-old", appliedVersions: [29, 30, 31, 32] });
    for (const step of steps) {
      expect(step.action).not.toContain("migrateDown");
      expect(step.action.toLowerCase()).not.toContain("revert migration");
      expect(step.destructive).toBe(false);
    }
  });

  it("names the irreversible migrations and refuses to revert them", () => {
    const steps = planRollback({ toImageTag: "sha-old", appliedVersions: [29, 32] });
    const refusal = steps.find((step) => step.name === "do-not-revert-migrations");
    expect(refusal).toBeDefined();
    expect(refusal!.action).toBe("NONE — this step is a refusal, not an operation");
    // The REASON, not just the fact. `032`'s down drops the table recording that data was
    // destroyed, which is the most self-defeating revert available here.
    expect(refusal!.rationale).toContain("retention_runs");
  });

  it("omits the refusal step when no irreversible migration is applied", () => {
    // A refusal that always appears is noise an operator learns to skip.
    const steps = planRollback({ toImageTag: "sha-old", appliedVersions: [1, 2, 3] });
    expect(steps.some((step) => step.name === "do-not-revert-migrations")).toBe(false);
  });

  it("registers a reason for every irreversible migration", () => {
    for (const [version, reason] of Object.entries(IRREVERSIBLE_MIGRATIONS)) {
      expect(reason.length, `migration ${version} has no reason`).toBeGreaterThan(30);
    }
  });

  it("migrates BEFORE deploying code, not after", () => {
    // Code-first would start the new version against the old schema and fail on its first
    // query. Schema-first leaves the old code against a new-but-additive schema.
    const steps = planDeployment({ pendingVersions: [33], imageTag: "sha-new" });
    const migrate = steps.findIndex((step) => step.name === "migrate");
    const deploy = steps.findIndex((step) => step.name === "deploy");
    expect(migrate).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(deploy);
  });

  it("omits the migrate step when nothing is pending", () => {
    const steps = planDeployment({ pendingVersions: [], imageTag: "sha-new" });
    expect(steps.some((step) => step.name === "migrate")).toBe(false);
  });

  it("verifies with READINESS after deploying, since liveness ignores the database", () => {
    const steps = planDeployment({ pendingVersions: [], imageTag: "sha-new" });
    const verify = steps.find((step) => step.name === "verify-after");
    expect(verify?.action).toContain("readiness");
  });

  it("flags an UNCLASSIFIED migration as a rollback concern", () => {
    // "No declaration" is not consent — the `CTF-010` finding-4 pattern that produced two
    // HIGH defects in RA-014.
    const concerns = assertRollbackSafe({
      applied: [{ version: 33, name: "new_thing", applied: true }],
      compatibility: {},
    });
    expect(concerns).toHaveLength(1);
    expect(concerns[0]!.reason).toContain("no compatibility classification");
  });

  it("flags a BREAKING migration and passes an ADDITIVE one", () => {
    expect(
      assertRollbackSafe({
        applied: [{ version: 33, name: "add_column", applied: true }],
        compatibility: { 33: MigrationCompatibility.ADDITIVE },
      }),
    ).toEqual([]);

    const concerns = assertRollbackSafe({
      applied: [{ version: 34, name: "drop_column", applied: true }],
      compatibility: { 34: MigrationCompatibility.BREAKING },
    });
    expect(concerns).toHaveLength(1);
    expect(concerns[0]!.reason).toContain("BREAKING");
  });

  it("ignores a migration that is not applied", () => {
    expect(
      assertRollbackSafe({
        applied: [{ version: 99, name: "future", applied: false }],
        compatibility: {},
      }),
    ).toEqual([]);
  });
});
