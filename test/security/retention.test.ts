import { AuditLogRepository, ConnectionRepository, OwnerRepository } from "@remoteagent/database";
import { beforeEach, expect, it } from "vitest";

import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();

/**
 * AC5: "retention/delete does not destroy the required minimum audit receipts
 * without a rule" (RA-024-WU-07).
 *
 * WHAT A PROBE FOUND FIRST. Migration 002 gave `raw_events` a `retain_until` column
 * and an index commented "the hot path for the retention job", and put an
 * unconditional append-only trigger on the same table. Measured against a real
 * database:
 *
 *     DELETE expired raw_event          rows=1  REFUSED (P0100)
 *     UPDATE raw payload_bytes -> NULL  rows=1  REFUSED (P0100)
 *
 * The documented retention mechanism could not run at all. Migration 032 makes it
 * possible, narrowly, and this suite is what keeps it narrow — the risk of adding a
 * deletion path is that it becomes a general one.
 *
 * A METHODOLOGICAL NOTE WORTH KEEPING. The first version of that probe reported
 * `DELETE FROM audit_log: ALLOWED`, which would have been a severe finding. It was
 * wrong: the table was empty, and a `FOR EACH ROW` trigger never fires on zero rows,
 * so the probe measured "deleted nothing". Every test below therefore inserts a row
 * before asserting that deleting it is refused, and several assert the row is STILL
 * THERE afterwards. "Refused" on an empty table is not evidence.
 */
describeIntegration(
  "AC5 retention preserves the minimum audit trail",
  () => {
    let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
    let drop: () => Promise<void>;

    const DIGEST = `sha256:${"a".repeat(64)}`;

    async function seed(): Promise<void> {
      await new OwnerRepository().insert(db, { ownerId: "o1", displayName: "retention" });
      await new ConnectionRepository().insert(db, {
        connectionId: "c1",
        ownerId: "o1",
        provider: "jira",
        alias: "private",
        displayName: "retention",
      });
      await new AuditLogRepository().record(db, {
        actor: "system",
        action: "case.opened",
        outcome: "SUCCESS",
        ownerId: "o1",
        caseId: "case-1",
      });
      await db.withTransaction(async (tx) => {
        // One EXPIRED payload and one that is still within its retention window, so
        // every test can check that the cutoff is honoured rather than ignored.
        await tx.query(
          `INSERT INTO raw_events
             (raw_event_id, provider, connection_id, owner_id, payload_ref, payload_digest,
              payload_bytes, sensitivity, retain_until)
           VALUES
             ('expired','jira','c1','o1','ref://expired',$1,'\\x0102'::bytea,'restricted',
              now() - interval '1 day'),
             ('fresh','jira','c1','o1','ref://fresh',$1,'\\x0304'::bytea,'restricted',
              now() + interval '30 days'),
             ('forever','jira','c1','o1','ref://forever',$1,'\\x0506'::bytea,'internal', NULL)`,
          [DIGEST],
        );
      });
    }

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      await seed();
      return async () => {
        await drop();
      };
    });

    async function purge(actor = "operator-1"): Promise<number> {
      const result = await db.query<{ purged: string }>(
        `SELECT ra_retention_purge_raw_payload($1)::text AS purged`,
        [actor],
      );
      return Number(result.rows[0]!.purged);
    }

    async function payloadOf(id: string): Promise<Buffer | null> {
      const result = await db.query<{ payload_bytes: Buffer | null }>(
        `SELECT payload_bytes FROM raw_events WHERE raw_event_id = $1`,
        [id],
      );
      return result.rows[0]!.payload_bytes;
    }

    it("purges an EXPIRED payload's bytes", async () => {
      expect(await payloadOf("expired")).not.toBeNull();
      expect(await purge()).toBe(1);
      expect(await payloadOf("expired")).toBeNull();
    });

    it("does NOT purge a payload still inside its window, or one with no deadline", async () => {
      await purge();
      expect(await payloadOf("fresh")).not.toBeNull();
      expect(await payloadOf("forever")).not.toBeNull();
    });

    it("keeps the raw event's ENVELOPE, so the audit trail survives the purge", async () => {
      // The bytes are the sensitive part; who/when/digest/sensitivity is the audit
      // trail. Keeping `payload_digest` means a later restore can still prove whether
      // a payload it holds is the one this row referred to.
      await purge();
      const row = await db.query<{
        payload_ref: string;
        payload_digest: string;
        sensitivity: string;
        owner_id: string;
        received_at: Date;
      }>(
        `SELECT payload_ref, payload_digest, sensitivity, owner_id, received_at
         FROM raw_events WHERE raw_event_id = 'expired'`,
      );
      expect(row.rows[0]).toMatchObject({
        payload_ref: "ref://expired",
        payload_digest: DIGEST,
        sensitivity: "restricted",
        owner_id: "o1",
      });
      expect(row.rows[0]!.received_at).toBeInstanceOf(Date);
    });

    it("never DELETES a raw event row, only clears its bytes", async () => {
      await purge();
      const count = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM raw_events`);
      expect(count.rows[0]!.n).toBe("3");
    });

    it("is idempotent: a second purge affects nothing", async () => {
      expect(await purge()).toBe(1);
      // A purge that re-counted already-cleared rows would make the audit record of
      // "rows affected" meaningless, and would grow the retention log without bound.
      expect(await purge()).toBe(0);
    });

    it("writes an audit_log entry and a retention_runs row in the SAME transaction", async () => {
      await purge("operator-7");
      const audit = await db.query<{ actor: string; action: string; detail: unknown }>(
        `SELECT actor, action, detail FROM audit_log
         WHERE action = 'retention.purge.raw_event_payload'`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.actor).toBe("operator-7");
      expect(audit.rows[0]!.detail).toMatchObject({ rows_affected: 1 });

      const runs = await db.query<{ data_class: string; rows_affected: string; actor: string }>(
        `SELECT data_class, rows_affected::text, actor FROM retention_runs`,
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({
        data_class: "raw_event_payload",
        rows_affected: "1",
        actor: "operator-7",
      });
    });

    it("refuses an unattributed purge, rather than recording it as 'unknown'", async () => {
      // A destructive operation with no actor is not auditable. Both empty and blank
      // are checked, because `''` and `'  '` are the two ways this arrives.
      for (const actor of ["", "   "]) {
        await expect(purge(actor)).rejects.toThrow(/requires an actor/);
      }
      expect(await payloadOf("expired")).not.toBeNull();
    });

    it("performs no purge and writes no audit row when the actor is refused", async () => {
      await expect(purge("")).rejects.toThrow();
      const runs = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM retention_runs`);
      expect(runs.rows[0]!.n).toBe("0");
    });
  },
  available,
);

describeIntegration(
  "AC5 the minimum audit trail is structurally out of retention's reach",
  () => {
    let db: Awaited<ReturnType<typeof createTestDatabase>>["db"];
    let drop: () => Promise<void>;

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      await new OwnerRepository().insert(db, { ownerId: "o1", displayName: "retention" });
      await new AuditLogRepository().record(db, {
        actor: "system",
        action: "action.executed",
        outcome: "SUCCESS",
        ownerId: "o1",
        caseId: "case-1",
      });
      return async () => {
        await drop();
      };
    });

    async function refused(sql: string): Promise<string> {
      try {
        await db.withTransaction((tx) => tx.query(sql));
        return "ALLOWED";
      } catch (error) {
        return `REFUSED:${(error as { code?: string }).code ?? "?"}`;
      }
    }

    it("audit_log cannot be deleted, and the row is still there afterwards", async () => {
      // NON-EMPTY table, asserted. The probe that reported ALLOWED on this table was
      // measuring an empty one.
      const before = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log`);
      expect(before.rows[0]!.n).toBe("1");
      expect(await refused(`DELETE FROM audit_log WHERE true`)).toBe("REFUSED:P0100");
      const after = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log`);
      expect(after.rows[0]!.n).toBe("1");
    });

    it("audit_log cannot be updated", async () => {
      expect(await refused(`UPDATE audit_log SET outcome = 'FAILURE'`)).toBe("REFUSED:P0100");
    });

    it("the retention log itself cannot be deleted or rewritten", async () => {
      // The record that data was destroyed must outlive the data.
      await db.query(
        `INSERT INTO retention_runs (data_class, rows_affected, cutoff, actor)
         VALUES ('raw_event_payload', 1, now(), 'operator-1')`,
      );
      expect(await refused(`DELETE FROM retention_runs WHERE true`)).toBe("REFUSED:P0100");
      expect(await refused(`UPDATE retention_runs SET rows_affected = 0`)).toBe("REFUSED:P0100");
    });

    it("there is exactly ONE retention function, and it only reaches raw payloads", async () => {
      // The structural half of AC5: `audit_log`, `receipts`, `external_actions` and
      // `approvals` are not merely protected by a check the caller could get wrong —
      // no function exists that can reach them. Asserted against the catalogue so
      // adding a second retention function is a failing test, not a review comment.
      const functions = await db.query<{ proname: string }>(
        `SELECT proname FROM pg_proc
         WHERE proname LIKE 'ra_retention%' ORDER BY proname`,
      );
      expect(functions.rows.map((row) => row.proname)).toEqual([
        "ra_retention_in_progress",
        "ra_retention_purge_raw_payload",
      ]);
    });

    it("a caller cannot set the retention flag and then rewrite an envelope", async () => {
      // The obvious bypass: mimic the function's flag and do the UPDATE directly. The
      // trigger checks the COLUMNS, not just the flag, so the flag alone buys nothing.
      await new ConnectionRepository().insert(db, {
        connectionId: "c1",
        ownerId: "o1",
        provider: "jira",
        alias: "private",
        displayName: "retention",
      });
      await db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO raw_events
             (raw_event_id, provider, connection_id, owner_id, payload_ref, payload_digest,
              payload_bytes, sensitivity, retain_until)
           VALUES ('r1','jira','c1','o1','ref://1',$1,'\\x01'::bytea,'restricted',
                   now() - interval '1 day')`,
          [`sha256:${"a".repeat(64)}`],
        ),
      );

      const attempt = async (sql: string): Promise<string> => {
        try {
          await db.withTransaction(async (tx) => {
            await tx.query(`SELECT set_config('ra.retention_purge', 'on', true)`);
            await tx.query(sql);
          });
          return "ALLOWED";
        } catch (error) {
          return `REFUSED:${(error as { code?: string }).code ?? "?"}`;
        }
      };

      // Rewriting the digest would let a purged row be re-associated with a different
      // payload, which destroys the reconciliation value of keeping the envelope.
      expect(
        await attempt(`UPDATE raw_events SET payload_digest = 'sha256:${"b".repeat(64)}'`),
      ).toBe("REFUSED:P0101");
      // Extending the deadline would defeat the cutoff.
      expect(
        await attempt(`UPDATE raw_events SET retain_until = now() + interval '99 years'`),
      ).toBe("REFUSED:P0101");
      // Downgrading sensitivity would change the data class after the fact.
      expect(await attempt(`UPDATE raw_events SET sensitivity = 'public'`)).toBe("REFUSED:P0101");
      // Deletion is refused whatever the flag says.
      expect(await attempt(`DELETE FROM raw_events WHERE true`)).toBe("REFUSED:P0100");
      // And the flag cannot be used to WRITE bytes back in.
      expect(await attempt(`UPDATE raw_events SET payload_bytes = '\\x99'::bytea`)).toBe(
        "REFUSED:P0101",
      );
    });

    it("an ordinary writer is still refused with no flag set", async () => {
      // The exception must not have become the rule for every other writer.
      //
      // This test FAILED on first run with `ALLOWED`, for the same reason the original
      // probe did: `raw_events` was empty in this describe block, so the FOR EACH ROW
      // trigger never fired and "deleted nothing" read as "permitted". Seeding a row
      // and asserting it survives is the only version of this assertion that means
      // anything — and being caught by it twice is why every case here does so.
      await new ConnectionRepository().insert(db, {
        connectionId: "c-ordinary",
        ownerId: "o1",
        provider: "jira",
        alias: "private",
        displayName: "retention",
      });
      await db.withTransaction((tx) =>
        tx.query(
          `INSERT INTO raw_events
             (raw_event_id, provider, connection_id, owner_id, payload_ref, payload_digest,
              payload_bytes, sensitivity, retain_until)
           VALUES ('ordinary','jira','c-ordinary','o1','ref://ordinary',$1,'\\x01'::bytea,
                   'restricted', now() - interval '1 day')`,
          [`sha256:${"a".repeat(64)}`],
        ),
      );

      expect(await refused(`UPDATE raw_events SET payload_bytes = NULL`)).toBe("REFUSED:P0100");
      expect(await refused(`DELETE FROM raw_events WHERE true`)).toBe("REFUSED:P0100");

      // And the bytes are still there, so the refusal was real rather than a no-op.
      const row = await db.query<{ payload_bytes: Buffer | null }>(
        `SELECT payload_bytes FROM raw_events WHERE raw_event_id = 'ordinary'`,
      );
      expect(row.rows[0]!.payload_bytes).not.toBeNull();
    });
  },
  available,
);
