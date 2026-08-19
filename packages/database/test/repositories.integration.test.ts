/**
 * Repository integration tests against a REAL PostgreSQL (RA-003).
 *
 * Covers acceptance criteria:
 *   2. re-inserting the same provider event does not create a duplicate;
 *   3. two updates of the same checkpoint revision cannot both win (CAS);
 *   4. an entity/connection cannot be linked to another owner scope by a plain
 *      write;
 *   5. append-only records have no public update/delete API and the DB rejects
 *      mutation;
 * plus the required verification: transaction interruption leaves no partial
 * state, and concurrent writers.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import { translatePgError } from "../src/client.js";
import {
  AppendOnlyViolationError,
  CheckpointConflictError,
  IntegrityViolationError,
  PersistenceError,
} from "../src/errors.js";
import {
  AuditLogRepository,
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  EventRepository,
  ExternalEntityRepository,
  OwnerRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
import { makeCheckpoint } from "./fixtures.js";

const available = await ensurePostgres();

describeIntegration(
  "repositories",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;

    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const events = new EventRepository();
    const cases = new CaseRepository();
    const entities = new ExternalEntityRepository();
    const checkpoints = new CheckpointRepository();
    const audit = new AuditLogRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

    // Truncate mutable/ledger tables between tests for isolation.
    beforeEach(async () => {
      await db.query(
        `TRUNCATE audit_log, case_checkpoints, external_entities, case_messages,
                  cases, events, raw_events, connections, owners RESTART IDENTITY CASCADE`,
      );
    });

    async function seedOwnerAndConnection(ownerId: string, connectionId: string): Promise<void> {
      await owners.insert(db, { ownerId, displayName: `owner ${ownerId}` });
      await connections.insert(db, {
        connectionId,
        ownerId,
        provider: "jira",
        displayName: "jira conn",
      });
    }

    it("deduplicates a re-delivered provider event (criterion 2)", async () => {
      await seedOwnerAndConnection("owner-1", "conn-1");

      const base = {
        provider: "jira" as const,
        connectionId: "conn-1",
        ownerId: "owner-1",
        externalEventId: "EVT-1",
        eventType: "issue_updated",
        dedupeKey: "jira:conn-1:EVT-1",
        entityProvider: "jira" as const,
        entityKind: "jira_issue",
        entityExternalId: "PROJ-1",
        traceId: "trace-1",
        sensitivity: "internal" as const,
        occurredAt: new Date("2026-01-01T00:00:00Z"),
      };

      const first = await events.insertEvent(db, { ...base, eventId: "e-1" });
      expect(first.inserted).toBe(true);

      // Same dedupe key, different event_id → no new row, returns existing.
      const second = await events.insertEvent(db, { ...base, eventId: "e-2" });
      expect(second.inserted).toBe(false);
      expect(second.event.event_id).toBe("e-1");

      const count = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM events");
      expect(count.rows[0]?.n).toBe("1");
    });

    it("rejects concurrent updates of the same checkpoint revision (criterion 3)", async () => {
      await owners.insert(db, { ownerId: "owner-1", displayName: "o" });
      await connections.insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "c",
      });
      await cases.insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
        discordThreadId: "thread-1",
      });

      // Two writers both read revision 0 and try to append revision 1.
      const attempt = (): Promise<unknown> =>
        db.withTransaction((tx) =>
          checkpoints.append(tx, {
            caseId: "case-1",
            expectedRevision: 0,
            checkpoint: makeCheckpoint("case-1", 1),
          }),
        );

      const results = await Promise.allSettled([attempt(), attempt()]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CheckpointConflictError);

      // Exactly one revision-1 row exists and the case advanced to 1.
      const rows = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM case_checkpoints WHERE case_id = 'case-1'",
      );
      expect(rows.rows[0]?.n).toBe("1");
      const current = await cases.findById(db, "case-1");
      expect(current?.checkpoint_revision).toBe(1);
    });

    it("prevents linking an entity to another owner's connection (criterion 4)", async () => {
      await seedOwnerAndConnection("owner-A", "conn-A");
      await seedOwnerAndConnection("owner-B", "conn-B");

      await cases.insert(db, {
        caseId: "case-A",
        ownerId: "owner-A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-A"] },
        discordThreadId: "thread-A",
      });

      // Owner A's case tries to link owner B's connection: fails closed.
      await expect(
        entities.insert(db, {
          entityId: "ent-1",
          caseId: "case-A",
          ownerId: "owner-A",
          connectionId: "conn-B", // belongs to owner-B
          provider: "jira",
          kind: "jira_issue",
          externalId: "PROJ-9",
        }),
      ).rejects.toBeInstanceOf(IntegrityViolationError);

      // The matching-owner link succeeds.
      const ok = await entities.insert(db, {
        entityId: "ent-2",
        caseId: "case-A",
        ownerId: "owner-A",
        connectionId: "conn-A",
        provider: "jira",
        kind: "jira_issue",
        externalId: "PROJ-1",
      });
      expect(ok.entity_id).toBe("ent-2");
    });

    it("denies UPDATE/DELETE on append-only tables at the DB level (criterion 5)", async () => {
      await audit.record(db, { actor: "system", action: "test.event", outcome: "SUCCESS" });

      // The DB trigger raises the custom SQLSTATE P0100 for any mutation, and
      // translatePgError maps that to AppendOnlyViolationError. Assert both: the
      // raw guard fires, and the mapping is correct.
      const updateErr = await db.query("UPDATE audit_log SET action = 'tampered'").then(
        () => null,
        (e: unknown) => e,
      );
      expect((updateErr as { code?: string }).code).toBe("P0100");
      expect(translatePgError(updateErr)).toBeInstanceOf(AppendOnlyViolationError);

      const deleteErr = await db.query("DELETE FROM audit_log").then(
        () => null,
        (e: unknown) => e,
      );
      expect((deleteErr as { code?: string }).code).toBe("P0100");
      expect(translatePgError(deleteErr)).toBeInstanceOf(AppendOnlyViolationError);

      // The repository exposes no update/delete method — verified structurally
      // by the DB guard above plus the class surface (record + reads only).
      const rows = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_log");
      expect(rows.rows[0]?.n).toBe("1");
    });

    it("rolls back a transaction leaving no partial state", async () => {
      await seedOwnerAndConnection("owner-1", "conn-1");

      const boom = new Error("intentional failure after a write");
      await expect(
        db.withTransaction(async (tx) => {
          await cases.insert(tx, {
            caseId: "case-rollback",
            ownerId: "owner-1",
            status: "NEW",
            integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
            discordThreadId: "thread-rollback",
          });
          // The row is visible inside the transaction...
          const inside = await cases.findById(tx, "case-rollback");
          expect(inside).not.toBeNull();
          throw boom;
        }),
      ).rejects.toBe(boom);

      // ...but not after rollback.
      const after = await cases.findById(db, "case-rollback");
      expect(after).toBeNull();
    });

    it("keeps the checkpoint atomic when the second step fails (public API)", async () => {
      await owners.insert(db, { ownerId: "owner-1", displayName: "o" });
      await connections.insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "c",
      });
      await cases.insert(db, {
        caseId: "case-atomic",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
        discordThreadId: "thread-atomic",
      });

      // AUDIT-01 HIGH-02: `append` now requires a branded Transaction, so the CAS
      // bump and the checkpoint insert share one boundary. When step 2 fails on a
      // bad last_event_id FK, `withTransaction` rolls back the CAS too: the case
      // must remain at revision 0 with zero checkpoint rows. (A plain Database no
      // longer type-checks as the argument, which is the compile-time guarantee.)
      const err = await db
        .withTransaction((tx) =>
          checkpoints.append(tx, {
            caseId: "case-atomic",
            expectedRevision: 0,
            checkpoint: makeCheckpoint("case-atomic", 1),
            lastEventId: "does-not-exist",
          }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(IntegrityViolationError);

      const rows = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM case_checkpoints WHERE case_id = 'case-atomic'",
      );
      expect(rows.rows[0]?.n).toBe("0");
      const current = await cases.findById(db, "case-atomic");
      expect(current?.checkpoint_revision).toBe(0);
    });

    it("rejects a checkpoint payload whose case_id/revision disagree with the row", async () => {
      await owners.insert(db, { ownerId: "owner-1", displayName: "o" });
      await connections.insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "c",
      });
      await cases.insert(db, {
        caseId: "case-consistent",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
        discordThreadId: "thread-consistent",
      });

      // Payload case_id disagrees with the target case.
      const caseErr = await db
        .withTransaction((tx) =>
          checkpoints.append(tx, {
            caseId: "case-consistent",
            expectedRevision: 0,
            checkpoint: makeCheckpoint("other-case", 1),
          }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(caseErr).toBeInstanceOf(PersistenceError);

      // Payload revision disagrees with expectedRevision + 1.
      const revErr = await db
        .withTransaction((tx) =>
          checkpoints.append(tx, {
            caseId: "case-consistent",
            expectedRevision: 0,
            checkpoint: makeCheckpoint("case-consistent", 5),
          }),
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(revErr).toBeInstanceOf(PersistenceError);

      // Nothing was written and the case is still at revision 0.
      const rows = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM case_checkpoints WHERE case_id = 'case-consistent'",
      );
      expect(rows.rows[0]?.n).toBe("0");
      const current = await cases.findById(db, "case-consistent");
      expect(current?.checkpoint_revision).toBe(0);
    });

    it("advances multiple sequential checkpoint revisions via CAS", async () => {
      await owners.insert(db, { ownerId: "owner-1", displayName: "o" });
      await connections.insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "c",
      });
      await cases.insert(db, {
        caseId: "case-seq",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-1"] },
        discordThreadId: "thread-seq",
      });

      for (let rev = 0; rev < 5; rev += 1) {
        await db.withTransaction((tx) =>
          checkpoints.append(tx, {
            caseId: "case-seq",
            expectedRevision: rev,
            checkpoint: makeCheckpoint("case-seq", rev + 1),
          }),
        );
      }

      const latest = await checkpoints.latest(db, "case-seq");
      expect(latest?.revision).toBe(5);
      const current = await cases.findById(db, "case-seq");
      expect(current?.checkpoint_revision).toBe(5);
    });
  },
  available,
);
