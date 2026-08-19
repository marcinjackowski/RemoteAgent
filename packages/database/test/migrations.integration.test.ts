/**
 * Migration lifecycle integration tests (RA-003 acceptance criterion 1,
 * required verification: migrate up/down/up on a clean database).
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import { loadMigrations, migrateDown, migrateUp, migrationStatus } from "../src/migrate.js";
import { createEmptyDatabase } from "./harness.js";
import type { Database } from "../src/client.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

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
