/**
 * Migration lifecycle integration tests (RA-003 acceptance criterion 1,
 * required verification: migrate up/down/up on a clean database).
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  DiscordBindingRepository,
  EngineeringApprovalIngressRepository,
  EngineeringRecoveryRepository,
  OwnerRepository,
  WorkUnitRepository,
} from "../src/repositories/index.js";
import { JobStore, ManualClock, SequentialIdGenerator } from "../src/queue/index.js";
import { loadMigrations, migrateDown, migrateUp, migrationStatus } from "../src/migrate.js";
import { createEmptyDatabase } from "./harness.js";
import type { Database } from "../src/client.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

const ROLLBACK_POLICY = Object.freeze({
  schema_version: 1 as const,
  purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY" as const,
  repository_id: "rollback-repository",
  write_path_allowlist: ["src"],
});

async function seedEngineeringIngress(db: Database, status: "PENDING" | "GRANTED"): Promise<void> {
  const now = Date.now();
  const ownerId = `rollback-${status.toLowerCase()}-owner`;
  const connectionId = `rollback-${status.toLowerCase()}-connection`;
  const caseId = `rollback-${status.toLowerCase()}-case`;
  const owners = new OwnerRepository();
  const connections = new ConnectionRepository();
  const cases = new CaseRepository();
  const checkpoints = new CheckpointRepository();
  const bindings = new DiscordBindingRepository();
  await owners.insert(db, { ownerId, displayName: ownerId });
  await connections.insert(db, {
    connectionId,
    ownerId,
    provider: "jira",
    displayName: connectionId,
  });
  await cases.insert(db, {
    caseId,
    ownerId,
    status: "NEW",
    integrationScope: { providers: ["jira"], connection_ids: [connectionId] },
    discordThreadId: `rollback-${status.toLowerCase()}-thread`,
  });
  await db.withTransaction(async (tx) => {
    await checkpoints.ensureBaseline(tx, {
      caseId,
      updatedAt: new Date(now).toISOString(),
    });
    await bindings.ensure(tx, { caseId, ownerId, channelId: "rollback-channel" });
    await bindings.setThread(tx, caseId, {
      threadId: `rollback-${status.toLowerCase()}-thread`,
      rootMessageId: `rollback-${status.toLowerCase()}-root`,
    });
  });
  const ingress = new EngineeringApprovalIngressRepository({
    runtime: {
      clock: new ManualClock(now),
      ids: new SequentialIdGenerator(),
      leaseTime: "db",
    },
    deploymentPolicy: ROLLBACK_POLICY,
    proposalTtlMs: 300_000,
  });
  const proposed = await ingress.propose(db, {
    caseId,
    actorId: "discord-audit-actor",
    interactionId: `rollback-${status.toLowerCase()}-propose`,
  });
  if (proposed.status !== "created") throw new Error("rollback proposal fixture was not created");
  if (status === "GRANTED") {
    const granted = await ingress.respond(db, {
      caseId,
      actorId: "discord-audit-actor",
      interactionId: "rollback-granted-grant",
      proposalId: proposed.proposal.proposal_id,
      checkpointRevision: 0,
      choice: "grant",
    });
    if (granted.status !== "granted") throw new Error("rollback grant fixture was not created");
  }
}

async function engineeringIngressSnapshot(db: Database): Promise<unknown> {
  const counts = await db.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM engineering_write_proposals)::text proposals,
       (SELECT count(*) FROM engineering_ingress_interactions)::text interactions,
       (SELECT count(*) FROM approvals)::text approvals,
       (SELECT count(*) FROM work_units)::text work_units,
       (SELECT count(*) FROM agent_runs)::text runs,
       (SELECT count(*) FROM jobs)::text jobs,
       (SELECT count(*) FROM outbox)::text outbox`,
  );
  const proposals = await db.query<{
    proposal_id: string;
    status: string;
    approval_id: string | null;
    work_unit_id: string;
    run_id: string;
    job_id: string | null;
  }>(
    `SELECT proposal_id,status,approval_id,work_unit_id,run_id,job_id
       FROM engineering_write_proposals ORDER BY proposal_id`,
  );
  const interactions = await db.query<{
    interaction_id: string;
    proposal_id: string | null;
    interaction_kind: string;
  }>(
    `SELECT interaction_id,proposal_id,interaction_kind
       FROM engineering_ingress_interactions ORDER BY interaction_id`,
  );
  const authority = await db.query<{ kind: string; id: string }>(
    `SELECT 'approval' kind, approval_id id FROM approvals
     UNION ALL SELECT 'work_unit', work_unit_id FROM work_units
     UNION ALL SELECT 'run', run_id FROM agent_runs
     UNION ALL SELECT 'job', job_id FROM jobs
     ORDER BY kind,id`,
  );
  return {
    counts: counts.rows[0],
    proposals: proposals.rows,
    interactions: interactions.rows,
    authority: authority.rows,
  };
}

async function waitForBlockedByWriter(
  db: Database,
  writerPid: number,
  cancelled: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !cancelled()) {
    const waiting = await db.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname=current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type='Lock'
            AND $1 = ANY(pg_blocking_pids(pid))
       ) AS waiting`,
      [writerPid],
    );
    if (waiting.rows[0]?.waiting === true) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

describeIntegration(
  "migration lifecycle",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;

    beforeAll(async () => {
      const created = await createEmptyDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

    it("migrates an empty database from zero", async () => {
      const result = await migrateUp(db);
      expect(result.applied.length).toBeGreaterThan(0);
      const status = await migrationStatus(db);
      expect(status.every((s) => s.applied)).toBe(true);
      const stageChecks = await db.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conname IN (
            'engineering_operations_stage_check',
            'engineering_run_projections_current_stage_check')
          ORDER BY conname`,
      );
      expect(stageChecks.rows).toHaveLength(2);
      expect(stageChecks.rows.every((row) => row.definition.includes("LOCAL_COMMIT"))).toBe(true);

      const ingressSchema = await db.query<{
        proposals: string | null;
        interactions: string | null;
      }>(
        `SELECT to_regclass('public.engineering_write_proposals')::text AS proposals,
                to_regclass('public.engineering_ingress_interactions')::text AS interactions`,
      );
      expect(ingressSchema.rows[0]).toEqual({
        proposals: "engineering_write_proposals",
        interactions: "engineering_ingress_interactions",
      });
      const ingressTriggers = await db.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
          WHERE tgrelid IN (
            'engineering_write_proposals'::regclass,
            'engineering_ingress_interactions'::regclass)
            AND NOT tgisinternal
          ORDER BY tgname`,
      );
      expect(ingressTriggers.rows.map((row) => row.tgname)).toEqual([
        "engineering_ingress_interactions_append_only",
        "engineering_write_proposals_guard_update",
        "engineering_write_proposals_no_delete",
        "engineering_write_proposals_touch_updated_at",
      ]);

      const ingressForeignKeys = await db.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid='engineering_write_proposals'::regclass
            AND contype='f'`,
      );
      expect(
        ingressForeignKeys.rows.filter((row) =>
          row.definition.includes("engineering_ingress_interactions"),
        ),
      ).toHaveLength(2);
      expect(ingressForeignKeys.rows.some((row) => row.definition.includes("approvals"))).toBe(
        true,
      );
    });

    it("supports up/down/up returning to a fully-migrated state", async () => {
      const down = await migrateDown(db, { to: 0 });
      expect(down.reverted.length).toBeGreaterThan(0);
      const afterDown = await migrationStatus(db);
      expect(afterDown.every((s) => !s.applied)).toBe(true);

      const gone = await db.query<{ exists: boolean }>(
        "SELECT to_regclass('public.cases') IS NOT NULL AS exists",
      );
      expect(gone.rows[0]?.exists).toBe(false);

      const up = await migrateUp(db);
      expect(up.applied.length).toBe((await loadMigrations()).length);
      const afterUp = await migrationStatus(db);
      expect(afterUp.every((s) => s.applied)).toBe(true);
    });

    it("reverts exactly one migration when no target is given", async () => {
      const before = await migrationStatus(db);
      const appliedCount = before.filter((s) => s.applied).length;

      const down = await migrateDown(db);
      expect(down.reverted).toEqual([appliedCount]);

      const after = await migrationStatus(db);
      expect(after.filter((s) => s.applied).length).toBe(appliedCount - 1);

      // Restore full state for a clean teardown.
      await migrateUp(db);
    });

    it.each(["PENDING", "GRANTED"] as const)(
      "refuses to revert 036 with a %s proposal and preserves exact ingress authority",
      async (proposalStatus) => {
        const created = await createEmptyDatabase();
        const rollbackDb = created.db;
        try {
          await migrateUp(rollbackDb);
          await seedEngineeringIngress(rollbackDb, proposalStatus);
          const before = await engineeringIngressSnapshot(rollbackDb);

          await expect(migrateDown(rollbackDb, { to: 35 })).rejects.toThrow(
            /cannot revert migration 036 while engineering ingress rows exist/,
          );

          expect(
            (await migrationStatus(rollbackDb)).find((row) => row.version === 36)?.applied,
          ).toBe(true);
          expect(await engineeringIngressSnapshot(rollbackDb)).toEqual(before);
        } finally {
          await created.drop();
        }
      },
    );

    it("refuses to revert 036 while a concurrent ingress writer can still commit", async () => {
      const created = await createEmptyDatabase();
      const rollbackDb = created.db;
      let releaseWriter!: () => void;
      const writerMayCommit = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let writerLocked!: (pid: number) => void;
      const writerHasLock = new Promise<number>((resolve) => {
        writerLocked = resolve;
      });
      let cancelLockObservation = false;
      let writer: Promise<void> | null = null;
      try {
        await migrateUp(rollbackDb);
        // Remove 037 while empty so this controlled race remains load-bearing
        // specifically for the 036 ingress rollback lock.
        expect((await migrateDown(rollbackDb)).reverted).toEqual([37]);
        await new OwnerRepository().insert(rollbackDb, {
          ownerId: "rollback-race-owner",
          displayName: "rollback-race-owner",
        });
        await new ConnectionRepository().insert(rollbackDb, {
          connectionId: "rollback-race-connection",
          ownerId: "rollback-race-owner",
          provider: "jira",
          displayName: "rollback-race-connection",
        });
        await new CaseRepository().insert(rollbackDb, {
          caseId: "rollback-race-case",
          ownerId: "rollback-race-owner",
          status: "NEW",
          integrationScope: {
            providers: ["jira"],
            connection_ids: ["rollback-race-connection"],
          },
          discordThreadId: "rollback-race-thread",
        });

        writer = rollbackDb.withTransaction(async (tx) => {
          await tx.query("LOCK TABLE engineering_ingress_interactions IN ROW EXCLUSIVE MODE");
          const backend = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          writerLocked(backend.rows[0]!.pid);
          await writerMayCommit;
          await tx.query(
            `INSERT INTO engineering_ingress_interactions (
               interaction_id, case_id, owner_id, proposal_id, checkpoint_revision,
               interaction_kind)
             VALUES ('rollback-race-interaction','rollback-race-case','rollback-race-owner',
                     'rollback-race-proposal',0,'PROPOSE')`,
          );
        });
        const writerPid = await writerHasLock;

        const down = migrateDown(rollbackDb, { to: 35 });
        const downSettled = down.then(
          () => true,
          () => true,
        );
        const firstBoundary = await Promise.race([
          downSettled.then(() => "down-settled" as const),
          waitForBlockedByWriter(rollbackDb, writerPid, () => cancelLockObservation).then(
            (blocked) => (blocked ? ("drop-blocked" as const) : ("observation-cancelled" as const)),
          ),
        ]);
        cancelLockObservation = true;
        releaseWriter();
        await writer;
        const downOutcome = await down.then(
          (result) => ({ status: "resolved" as const, result }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );

        expect(firstBoundary).toBe("down-settled");
        expect(downOutcome.status).toBe("rejected");
        if (downOutcome.status !== "rejected") throw new Error("migration unexpectedly reverted");
        expect(downOutcome.error).toBeInstanceOf(Error);
        expect((downOutcome.error as Error).message).toMatch(/could not obtain lock/i);
        expect((await migrationStatus(rollbackDb)).find((row) => row.version === 36)?.applied).toBe(
          true,
        );
        expect(await engineeringIngressSnapshot(rollbackDb)).toEqual({
          counts: {
            proposals: "0",
            interactions: "1",
            approvals: "0",
            work_units: "0",
            runs: "0",
            jobs: "0",
            outbox: "0",
          },
          proposals: [],
          interactions: [
            {
              interaction_id: "rollback-race-interaction",
              proposal_id: "rollback-race-proposal",
              interaction_kind: "PROPOSE",
            },
          ],
          authority: [],
        });
      } finally {
        cancelLockObservation = true;
        releaseWriter();
        await writer?.catch(() => undefined);
        await created.drop();
      }
    });

    it("refuses to revert 037 with durable recovery authority and preserves its source chain", async () => {
      const created = await createEmptyDatabase();
      const rollbackDb = created.db;
      try {
        await migrateUp(rollbackDb);
        await seedEngineeringIngress(rollbackDb, "GRANTED");
        const proposal = await rollbackDb.query<{
          case_id: string;
          work_unit_id: string;
          run_id: string;
          job_id: string;
        }>(
          `SELECT case_id,work_unit_id,run_id,job_id
             FROM engineering_write_proposals WHERE status='GRANTED'`,
        );
        const authority = proposal.rows[0]!;
        await new WorkUnitRepository().start(rollbackDb, {
          workUnitId: authority.work_unit_id,
          runId: authority.run_id,
        });
        const clock = new ManualClock(Date.now() + 60_000);
        await rollbackDb.query(
          `UPDATE agent_runs SET safety_state='STARTED',started_at=to_timestamp($2/1000.0)
            WHERE run_id=$1`,
          [authority.run_id, clock.now()],
        );
        const jobs = new JobStore({
          clock,
          ids: new SequentialIdGenerator(),
          leaseTime: "injected",
        });
        const lease = await jobs.claim(rollbackDb, { owner: "rollback-writer", leaseMs: 1_000 });
        if (lease === null || lease.jobId !== authority.job_id) {
          throw new Error("rollback recovery writer fixture was not claimed");
        }
        clock.advance(2_000);
        const recoveries = new EngineeringRecoveryRepository({
          clock,
          ids: new SequentialIdGenerator(),
          leaseTime: "injected",
        });
        const materialized = await recoveries.materializeExpired(rollbackDb, {
          workflowDeadlineMs: 900_000,
        });
        expect(materialized.recoveries).toHaveLength(1);
        const before = await rollbackDb.query<Record<string, string>>(
          `SELECT
             (SELECT count(*) FROM engineering_recoveries)::text recoveries,
             (SELECT count(*) FROM engineering_recovery_events)::text events,
             (SELECT count(*) FROM jobs WHERE job_type='agent.engineering_recovery')::text jobs,
             (SELECT count(*) FROM jobs WHERE status='RECONCILING')::text sources`,
        );

        await expect(migrateDown(rollbackDb)).rejects.toThrow(
          /cannot revert migration 037 while engineering recovery rows exist/,
        );
        expect((await migrationStatus(rollbackDb)).find((row) => row.version === 37)?.applied).toBe(
          true,
        );
        expect(
          await rollbackDb.query<Record<string, string>>(
            `SELECT
               (SELECT count(*) FROM engineering_recoveries)::text recoveries,
               (SELECT count(*) FROM engineering_recovery_events)::text events,
               (SELECT count(*) FROM jobs WHERE job_type='agent.engineering_recovery')::text jobs,
               (SELECT count(*) FROM jobs WHERE status='RECONCILING')::text sources`,
          ),
        ).toMatchObject({ rows: before.rows });
      } finally {
        await created.drop();
      }
    });

    it("refuses to revert 037 while a concurrent recovery writer holds a table lock", async () => {
      const created = await createEmptyDatabase();
      const rollbackDb = created.db;
      let releaseWriter!: () => void;
      const writerMayFinish = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      let writerLocked!: (pid: number) => void;
      const writerHasLock = new Promise<number>((resolve) => {
        writerLocked = resolve;
      });
      let cancelLockObservation = false;
      let writer: Promise<void> | null = null;
      try {
        await migrateUp(rollbackDb);
        writer = rollbackDb.withTransaction(async (tx) => {
          await tx.query("LOCK TABLE engineering_recovery_events IN ROW EXCLUSIVE MODE");
          const backend = await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          writerLocked(backend.rows[0]!.pid);
          await writerMayFinish;
        });
        const writerPid = await writerHasLock;
        const down = migrateDown(rollbackDb);
        const downSettled = down.then(
          () => true,
          () => true,
        );
        const firstBoundary = await Promise.race([
          downSettled.then(() => "down-settled" as const),
          waitForBlockedByWriter(rollbackDb, writerPid, () => cancelLockObservation).then(
            (blocked) => (blocked ? ("drop-blocked" as const) : ("observation-cancelled" as const)),
          ),
        ]);
        cancelLockObservation = true;
        releaseWriter();
        await writer;
        const outcome = await down.then(
          (result) => ({ status: "resolved" as const, result }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        expect(firstBoundary).toBe("down-settled");
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") throw new Error("migration unexpectedly reverted");
        expect((outcome.error as Error).message).toMatch(/could not obtain lock/i);
        expect((await migrationStatus(rollbackDb)).find((row) => row.version === 37)?.applied).toBe(
          true,
        );
      } finally {
        cancelLockObservation = true;
        releaseWriter?.();
        await writer?.catch(() => undefined);
        await created.drop();
      }
    });

    it("rejects checksum drift on an already-applied migration", async () => {
      await db.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
      await expect(migrateUp(db)).rejects.toThrow(/checksum drift/i);

      const migrations = await loadMigrations();
      const first = migrations.find((m) => m.version === 1)!;
      await db.query("UPDATE schema_migrations SET checksum = $1 WHERE version = 1", [
        first.checksum,
      ]);
    });

    it("aborts the scope migration (010) atomically when pre-existing data is invalid", async () => {
      // Revert to before the scope-integrity migration, so case_connections and
      // the composite FKs are gone and a scope-violating case can be written the
      // "old" way (AUDIT-02 HIGH-01: upgrade must validate existing rows).
      await migrateDown(db, { to: 9 });

      await db.query(`INSERT INTO owners (owner_id, display_name) VALUES ('A','A'),('B','B')`);
      await db.query(
        `INSERT INTO connections (connection_id, owner_id, provider, display_name)
         VALUES ('cA','A','jira','x'),('cB','B','jira','y')`,
      );
      // Owner A's case references owner B's connection — invalid scope at v9.
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('caseBad','A','NEW','{"providers":["jira"],"connection_ids":["cB"]}','tBad')`,
      );

      // Re-applying 010 must fail on the backfill and leave the DB at version 9.
      await expect(migrateUp(db)).rejects.toThrow();
      const status = await migrationStatus(db);
      const applied = status.filter((s) => s.applied).map((s) => s.version);
      expect(Math.max(...applied)).toBe(9);
      const has010 = status.find((s) => s.version === 10)?.applied;
      expect(has010).toBe(false);

      // Clean up the invalid row and restore full state for teardown.
      await db.query("DELETE FROM cases WHERE case_id = 'caseBad'");
      await db.query("DELETE FROM connections WHERE connection_id IN ('cA','cB')");
      await db.query("DELETE FROM owners WHERE owner_id IN ('A','B')");
      await migrateUp(db);
    });

    it("aborts the contract migration (011) when a legacy scope violates the runtime shape", async () => {
      // Revert to version 10, where an empty integration_scope was still accepted
      // by the sync trigger (arrays, but no min-length check). Write such a case
      // the "old" way, then re-apply 011 and confirm it fails closed.
      await migrateDown(db, { to: 10 });

      await db.query(`INSERT INTO owners (owner_id, display_name) VALUES ('A','A')`);
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('caseEmpty','A','NEW','{"providers":[],"connection_ids":[]}'::jsonb,'tEmpty')`,
      );

      await expect(migrateUp(db)).rejects.toThrow();
      const status = await migrationStatus(db);
      expect(status.find((s) => s.version === 11)?.applied).toBe(false);
      expect(Math.max(...status.filter((s) => s.applied).map((s) => s.version))).toBe(10);

      // Clean up and restore full state for teardown.
      await db.query("DELETE FROM cases WHERE case_id = 'caseEmpty'");
      await db.query("DELETE FROM owners WHERE owner_id = 'A'");
      await migrateUp(db);
    });

    it("upgrades 010→011 with an existing valid checkpoint and keeps it append-only", async () => {
      // AUDIT-04 HIGH: the 011 backfill UPDATEs case_checkpoints.owner_id, which is
      // an append-only ledger. Revert to v10, write a valid case + one checkpoint
      // (the way v10 allowed), then upgrade and confirm it succeeds AND the
      // append-only guard is restored (UPDATE/DELETE still raise P0100).
      await migrateDown(db, { to: 10 });

      await db.query(`INSERT INTO owners (owner_id, display_name) VALUES ('A','A')`);
      await db.query(
        `INSERT INTO connections (connection_id, owner_id, provider, display_name)
         VALUES ('cA','A','jira','x')`,
      );
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('caseCk','A','NEW','{"providers":["jira"],"connection_ids":["cA"]}'::jsonb,'tCk')`,
      );
      // Valid v10 checkpoint (no owner_id column yet).
      await db.query(
        `INSERT INTO case_checkpoints (case_id, revision, checkpoint) VALUES ('caseCk',1,'{}'::jsonb)`,
      );

      // The upgrade must succeed and backfill owner_id.
      const result = await migrateUp(db);
      expect(result.applied).toContain(11);
      const backfilled = await db.query<{ owner_id: string }>(
        "SELECT owner_id FROM case_checkpoints WHERE case_id = 'caseCk' AND revision = 1",
      );
      expect(backfilled.rows[0]?.owner_id).toBe("A");

      // Append-only guard must be back in place after the migration.
      const updateErr = await db
        .query("UPDATE case_checkpoints SET revision = 2 WHERE case_id = 'caseCk'")
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((updateErr as { code?: string }).code).toBe("P0100");

      const deleteErr = await db
        .query("DELETE FROM case_checkpoints WHERE case_id = 'caseCk'")
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((deleteErr as { code?: string }).code).toBe("P0100");

      // Clean up: append-only forbids DELETE, so revert the whole schema instead,
      // dropping the tables, then restore full state for teardown.
      await migrateDown(db, { to: 0 });
      await migrateUp(db);
    });

    it("upgrades 021→022 backfilling legacy in-flight (STARTED) intents to AMBIGUOUS", async () => {
      // AUDIT-04 MEDIUM-22: migration 022 adds an ownership fence + lease. A legacy
      // row written by 021 has neither, so a pre-existing STARTED intent would be
      // unrecoverable (no owner to complete it; no lease for the expiry-fenced
      // recovery). Revert to v21, write one intent per status the pre-022 way, then
      // upgrade and confirm the deterministic, fail-closed backfill.
      await migrateDown(db, { to: 21 });

      await db.query(`INSERT INTO owners (owner_id, display_name) VALUES ('OW','OW')`);
      await db.query(
        `INSERT INTO connections (
           connection_id, owner_id, provider, alias, display_name, capabilities,
           credential_secret_ref, health_status)
         VALUES ('cW','OW','jira','private','conn', ARRAY[]::text[],
                 'unconfigured://cW','ERROR')`,
      );
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('ckCase','OW','NEW','{"providers":["jira"],"connection_ids":["cW"]}'::jsonb,'tW')`,
      );
      const legacy: [string, string][] = [
        ["k-started", "STARTED"],
        ["k-succeeded", "SUCCEEDED"],
        ["k-ambiguous", "AMBIGUOUS"],
        ["k-retryable", "RETRYABLE"],
      ];
      for (const [key, status] of legacy) {
        await db.query(
          `INSERT INTO discord_send_intents (idempotency_key, case_id, outbox_id, step, status)
           VALUES ($1, 'ckCase', 'o1', $1, $2)`,
          [key, status],
        );
      }

      const result = await migrateUp(db);
      expect(result.applied).toContain(22);

      const rows = await db.query<{
        idempotency_key: string;
        status: string;
        owner_token: string | null;
        lease_expires_at: Date | null;
        last_error: string | null;
      }>(
        `SELECT idempotency_key, status, owner_token, lease_expires_at, last_error
         FROM discord_send_intents WHERE case_id = 'ckCase' ORDER BY idempotency_key`,
      );
      const byKey = new Map(rows.rows.map((r) => [r.idempotency_key, r]));
      // The in-flight STARTED intent fails closed to the conservative terminal.
      expect(byKey.get("k-started")?.status).toBe("AMBIGUOUS");
      expect(byKey.get("k-started")?.last_error).toContain("migration 022");
      // Terminal / re-ownable statuses are untouched.
      expect(byKey.get("k-succeeded")?.status).toBe("SUCCEEDED");
      expect(byKey.get("k-ambiguous")?.status).toBe("AMBIGUOUS");
      expect(byKey.get("k-retryable")?.status).toBe("RETRYABLE");
      // The new fence columns exist and are NULL for every legacy row.
      for (const r of rows.rows) {
        expect(r.owner_token).toBeNull();
        expect(r.lease_expires_at).toBeNull();
      }

      // Clean up and restore full state for teardown.
      await migrateDown(db, { to: 0 });
      await migrateUp(db);
    });
  },
  available,
);
