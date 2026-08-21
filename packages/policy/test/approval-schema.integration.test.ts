/**
 * RA-022-WU-01 — migration 029 and the extended `approval` contract, against a
 * REAL PostgreSQL.
 *
 * The load-bearing tests here are about the BACKFILL, not the columns. Adding a
 * column is trivial; the owner's decision (`CTF-005`) came with a condition —
 * pre-existing unconsumed approvals must be invalidated rather than grandfathered —
 * and that condition is the whole reason this migration is safe to apply to a live
 * database. So the suite applies migration 029 to a database that already holds
 * approvals in every relevant state and asserts what happened to each.
 *
 * Testing the backfill requires the PRE-migration shape, so these tests migrate
 * DOWN to 028 first, insert rows as the old schema allowed, then migrate up. That
 * is the only way to exercise the path a real deployment takes; inserting
 * post-migration rows and asserting their shape would prove nothing about the
 * upgrade.
 */
import { CURRENT_SCHEMA_VERSION, approval } from "@remoteagent/contracts";

// Imported from `../../database/src` rather than from `@remoteagent/database`, and
// the reason is structural: `packages/database` devDepends on `@remoteagent/policy`
// for its own tests, so a manifest edge in this direction makes turbo's graph
// cyclic and `build` refuses to run. A relative import into the sibling's source
// adds no package edge. It also keeps `Database` ONE class identity with the
// harness, which resolves the same way -- the src-vs-dist split in `CTF-004` is
// precisely what breaks when one side comes from `dist`.
import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  migrateDown,
  migrateUp,
  resolvePoolConfig,
} from "../../database/src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

interface ApprovalRow {
  approval_id: string;
  owner_id: string;
  checkpoint_revision: number | string;
  consumed: boolean;
  consumed_at: Date | null;
  granted_at: Date;
}

describeIntegration(
  "migration 029: approvals bind to a checkpoint revision (real PostgreSQL)",
  () => {
    let db: Database;
    let dbName: string;
    let drop: () => Promise<void>;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dbName = created.name;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      // Fully applied state at the start of every test.
      await migrateUp(db);
      await db.query(
        "TRUNCATE external_actions, approvals, receipts, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-a", displayName: "owner-a" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-a",
        ownerId: "owner-a",
        provider: "jira",
        alias: "sondermind",
        displayName: "conn-a",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-a",
        ownerId: "owner-a",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-a"] },
        discordThreadId: "thread-a",
      });
    });

    /** Insert an approval as the PRE-029 schema allowed (no revision, no owner). */
    async function insertLegacyApproval(
      target: Database,
      id: string,
      digest: string,
      options: { consumed?: boolean } = {},
    ): Promise<void> {
      if (options.consumed === true) {
        await target.query(
          `INSERT INTO approvals (approval_id, case_id, granted_by, action_digest,
             expires_at, consumed, consumed_at)
           VALUES ($1, 'case-a', 'owner-a', $2, now() + interval '1 hour', true, now())`,
          [id, digest],
        );
        return;
      }
      await target.query(
        `INSERT INTO approvals (approval_id, case_id, granted_by, action_digest, expires_at)
         VALUES ($1, 'case-a', 'owner-a', $2, now() + interval '1 hour')`,
        [id, digest],
      );
    }

    async function readApproval(target: Database, id: string): Promise<ApprovalRow | undefined> {
      const result = await target.query<ApprovalRow>(
        `SELECT approval_id, owner_id, checkpoint_revision, consumed, consumed_at, granted_at
           FROM approvals WHERE approval_id = $1`,
        [id],
      );
      return result.rows[0];
    }

    describe("fail-closed backfill (the owner's condition on CTF-005)", () => {
      it("invalidates a pre-existing UNCONSUMED approval instead of grandfathering it", async () => {
        // The scenario the condition exists for: a grant that was live when the
        // upgrade ran. Its checkpoint context is unknowable, so it must not be
        // usable. Grandfathering it would authorize an external write under facts
        // nobody can reconstruct.
        await migrateDown(db, { to: 28 });
        await insertLegacyApproval(db, "ap-live", DIGEST_A);
        await migrateUp(db);

        const row = await readApproval(db, "ap-live");
        expect(row?.consumed).toBe(true);
        expect(row?.consumed_at).not.toBeNull();
        // -1 can never equal a live cases.checkpoint_revision (which is >= 0), so a
        // revision comparison also fails closed even if the consumed fence were
        // bypassed. Two independent mechanisms, on purpose.
        expect(Number(row?.checkpoint_revision)).toBe(-1);
      });

      it("stamps consumed_at at granted_at, not at now()", async () => {
        // A grant whose window has already closed would violate the contract's
        // `granted_at <= consumed_at < expires_at` rule if stamped with now().
        // granted_at is always strictly inside the window because migration 008
        // guarantees expires_at > granted_at.
        await migrateDown(db, { to: 28 });
        await insertLegacyApproval(db, "ap-window", DIGEST_A);
        await migrateUp(db);

        const row = await readApproval(db, "ap-window");
        expect(row?.consumed_at?.getTime()).toBe(row?.granted_at.getTime());
      });

      it("leaves an already-consumed approval untouched as a historical record", async () => {
        await migrateDown(db, { to: 28 });
        await insertLegacyApproval(db, "ap-used", DIGEST_B, { consumed: true });
        await migrateUp(db);

        const row = await readApproval(db, "ap-used");
        expect(row?.consumed).toBe(true);
        expect(Number(row?.checkpoint_revision)).toBe(-1);
      });

      it("derives owner_id from the case rather than from granted_by", async () => {
        // granted_by records WHO clicked; owner_id is the scope a consumption is
        // fenced on. An actor id is not a scope, so the migration must read the
        // owner from the CASE.
        //
        // The two values are deliberately made DIFFERENT here. A mutation probe
        // showed that with `granted_by = 'owner-a'` this test passed even when the
        // migration used `SET owner_id = granted_by`, because both sources produced
        // the same answer -- the assertion could not distinguish them, so it did not
        // test its own name (`CTF-010`). A delegate id makes the sources diverge.
        await migrateDown(db, { to: 28 });
        await db.query(
          `INSERT INTO approvals (approval_id, case_id, granted_by, action_digest, expires_at)
           VALUES ('ap-scope','case-a','delegate-who-clicked',$1, now() + interval '1 hour')`,
          [DIGEST_A],
        );
        await migrateUp(db);

        const row = await readApproval(db, "ap-scope");
        // The case's owner, NOT the actor who clicked.
        expect(row?.owner_id).toBe("owner-a");
        expect(row?.owner_id).not.toBe("delegate-who-clicked");
      });
    });

    describe("post-migration invariants are enforced by the database", () => {
      it("refuses a fresh grant with no checkpoint_revision", async () => {
        // NOT NULL with no DEFAULT: code that forgets the revision fails loudly at
        // insert time instead of silently recording a grant with no context.
        await expect(insertLegacyApproval(db, "ap-nodefault", DIGEST_A)).rejects.toThrow(
          /checkpoint_revision/,
        );
      });

      it("refuses an UNCONSUMED grant carrying the invalidation sentinel", async () => {
        await expect(
          db.query(
            `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
               action_digest, checkpoint_revision, expires_at)
             VALUES ('ap-sentinel','case-a','owner-a','owner-a',$1,-1, now() + interval '1 hour')`,
            [DIGEST_A],
          ),
        ).rejects.toThrow(/approvals_revision_valid/);
      });

      it("accepts revision 0, which is real for a freshly created case", async () => {
        // Zero is NOT "unset". This is exactly why the backfill sentinel is -1.
        await db.query(
          `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
             action_digest, checkpoint_revision, expires_at)
           VALUES ('ap-zero','case-a','owner-a','owner-a',$1, 0, now() + interval '1 hour')`,
          [DIGEST_A],
        );
        expect(Number((await readApproval(db, "ap-zero"))?.checkpoint_revision)).toBe(0);
      });

      it("makes a case/owner mismatch impossible to insert", async () => {
        await new OwnerRepository().insert(db, { ownerId: "owner-b", displayName: "owner-b" });
        await expect(
          db.query(
            `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
               action_digest, checkpoint_revision, expires_at)
             VALUES ('ap-forged','case-a','owner-b','owner-b',$1, 1, now() + interval '1 hour')`,
            [DIGEST_A],
          ),
        ).rejects.toThrow(/approvals_case_owner_fk|violates foreign key/);
      });
    });

    describe("the contract agrees with the schema", () => {
      it("requires both new fields", () => {
        const base = {
          schema_version: CURRENT_SCHEMA_VERSION,
          approval_id: "ap-1",
          case_id: "case-a",
          owner_id: "owner-a",
          granted_by: "owner-a",
          action_digest: DIGEST_A,
          checkpoint_revision: 2,
          granted_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-01-01T01:00:00Z",
        };
        expect(approval.safeParse(base).success).toBe(true);
        for (const field of ["checkpoint_revision", "owner_id"]) {
          const incomplete: Record<string, unknown> = { ...base };
          delete incomplete[field];
          expect(approval.safeParse(incomplete).success, field).toBe(false);
        }
      });

      it("mirrors the sentinel rule the database enforces", () => {
        // The contract and the CHECK must agree; if only one held, the other would
        // be the gap. Asserted here rather than trusted.
        const sentinelUnconsumed = {
          schema_version: CURRENT_SCHEMA_VERSION,
          approval_id: "ap-1",
          case_id: "case-a",
          owner_id: "owner-a",
          granted_by: "owner-a",
          action_digest: DIGEST_A,
          checkpoint_revision: -1,
          granted_at: "2026-01-01T00:00:00Z",
          expires_at: "2026-01-01T01:00:00Z",
        };
        expect(approval.safeParse(sentinelUnconsumed).success).toBe(false);
      });
    });

    describe("reversibility", () => {
      it("drops and re-applies 029 cleanly", async () => {
        const target = new Database({ ...resolvePoolConfig(), database: dbName });
        try {
          const columnExists = async (): Promise<boolean> => {
            const result = await target.query<{ present: boolean }>(
              `SELECT count(*) > 0 AS present FROM information_schema.columns
                WHERE table_name = 'approvals' AND column_name = 'checkpoint_revision'`,
            );
            return result.rows[0]?.present === true;
          };
          expect(await columnExists()).toBe(true);

          const down = await migrateDown(target, { to: 28 });
          expect(down.reverted).toContain(29);
          expect(await columnExists()).toBe(false);

          const up = await migrateUp(target);
          expect(up.applied).toContain(29);
          expect(await columnExists()).toBe(true);
        } finally {
          await target.close();
        }
      });

      it("re-applying after a down is idempotent for already-invalidated rows", async () => {
        // A second up must not disturb rows the first one invalidated: they are
        // already consumed, so the UPDATE's `WHERE consumed = false` matches nothing.
        await migrateDown(db, { to: 28 });
        await insertLegacyApproval(db, "ap-twice", DIGEST_A);
        await migrateUp(db);
        const first = await readApproval(db, "ap-twice");

        await migrateDown(db, { to: 28 });
        await migrateUp(db);
        const second = await readApproval(db, "ap-twice");

        expect(second?.consumed).toBe(true);
        expect(second?.consumed_at?.getTime()).toBe(first?.consumed_at?.getTime());
      });
    });
  },
  available,
);
