import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { Database } from "../src/client.js";
import {
  OwnerRepository,
  ConnectionRepository,
  CaseRepository,
  ExternalEntityRepository,
  JiraCorrelationRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
const available = await ensurePostgres();
describeIntegration(
  "jira correlation receipts",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const owner = new OwnerRepository();
    const connection = new ConnectionRepository();
    const cases = new CaseRepository();
    const entities = new ExternalEntityRepository();
    const repo = new JiraCorrelationRepository();
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE jira_projection_receipts, outbox, external_entities, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await owner.insert(db, { ownerId: "o1", displayName: "owner" });
      await connection.insert(db, {
        connectionId: "c1",
        ownerId: "o1",
        provider: "jira",
        displayName: "jira",
      });
      await cases.insert(db, {
        caseId: "case1",
        ownerId: "o1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["c1"] },
        discordThreadId: "thread",
      });
      await entities.insert(db, {
        entityId: "ent1",
        caseId: "case1",
        ownerId: "o1",
        connectionId: "c1",
        provider: "jira",
        kind: "jira_issue",
        externalId: "PROJ-1",
      });
      await db.query(
        "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES('ob1','jira','case1','jira.webhook.received','{}')",
      );
    });
    it("records exact replay once and finds scoped entity", async () => {
      const input = {
        eventId: "ev1",
        ownerId: "o1",
        connectionId: "c1",
        issueKey: "PROJ-1",
        caseId: "case1",
        entityId: "ent1",
        outboxId: "ob1",
        canonicalDigest: `sha256:${"a".repeat(64)}`,
      };
      const first = await db.withTransaction((tx) => repo.record(tx, input));
      const second = await db.withTransaction((tx) => repo.record(tx, input));
      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(await repo.findScoped(db, "o1", "c1", "PROJ-1")).not.toBeNull();
      const reordered = {
        canonicalDigest: input.canonicalDigest,
        outboxId: input.outboxId,
        entityId: input.entityId,
        caseId: input.caseId,
        issueKey: input.issueKey,
        connectionId: input.connectionId,
        ownerId: input.ownerId,
        eventId: input.eventId,
      };
      expect((await db.withTransaction((tx) => repo.record(tx, reordered))).inserted).toBe(false);
    });
    it("rejects invalid scoped lookup before querying", async () => {
      let called = false;
      const q = {
        query: async () => {
          called = true;
          throw new Error("query");
        },
      };
      await expect(repo.findScoped(q, "", "c", "P-1")).rejects.toThrow();
      expect(called).toBe(false);
    });
    it("keeps same issue keys isolated by owner and connection", async () => {
      await owner.insert(db, { ownerId: "o2", displayName: "other" });
      await connection.insert(db, {
        connectionId: "c2",
        ownerId: "o2",
        provider: "jira",
        displayName: "other",
      });
      await cases.insert(db, {
        caseId: "case2",
        ownerId: "o2",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["c2"] },
        discordThreadId: "thread2",
      });
      await entities.insert(db, {
        entityId: "ent2",
        caseId: "case2",
        ownerId: "o2",
        connectionId: "c2",
        provider: "jira",
        kind: "jira_issue",
        externalId: "PROJ-1",
      });
      expect((await repo.findScoped(db, "o1", "c1", "PROJ-1"))?.owner_id).toBe("o1");
      expect((await repo.findScoped(db, "o2", "c2", "PROJ-1"))?.owner_id).toBe("o2");
      expect(await repo.findScoped(db, "o1", "c2", "PROJ-1")).toBeNull();
    });
    it("concurrent exact inserts have one winner", async () => {
      const input = {
        eventId: "ev-concurrent",
        ownerId: "o1",
        connectionId: "c1",
        issueKey: "PROJ-1",
        caseId: "case1",
        entityId: "ent1",
        outboxId: "ob1",
        canonicalDigest: `sha256:${"b".repeat(64)}`,
      };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => db.withTransaction((tx) => repo.record(tx, input))),
      );
      expect(results.filter((result) => result.inserted)).toHaveLength(1);
    });
    it("rejects conflicting replay and permits two events for one issue", async () => {
      const input = {
        eventId: "ev-conflict",
        ownerId: "o1",
        connectionId: "c1",
        issueKey: "PROJ-1",
        caseId: "case1",
        entityId: "ent1",
        outboxId: "ob1",
        canonicalDigest: `sha256:${"c".repeat(64)}`,
      };
      await db.withTransaction((tx) => repo.record(tx, input));
      await expect(
        db.withTransaction((tx) =>
          repo.record(tx, { ...input, canonicalDigest: `sha256:${"d".repeat(64)}` }),
        ),
      ).rejects.toThrow();
      await db.query(
        "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES('ob2','jira','case1','jira.webhook.received','{}')",
      );
      expect(
        (
          await db.withTransaction((tx) =>
            repo.record(tx, {
              ...input,
              eventId: "ev-second",
              outboxId: "ob2",
              canonicalDigest: `sha256:${"e".repeat(64)}`,
            }),
          )
        ).inserted,
      ).toBe(true);
    });
    it("rejects invalid input before querying", async () => {
      let called = false;
      const tx = {
        query: async () => {
          called = true;
          throw new Error("query");
        },
      } as never;
      await expect(
        repo.record(tx, {
          eventId: "",
          ownerId: "o",
          connectionId: "c",
          issueKey: "P",
          caseId: "case",
          entityId: "e",
          outboxId: "o",
          canonicalDigest: "bad",
        }),
      ).rejects.toThrow();
      expect(called).toBe(false);
    });
    it("rejects foreign entity and mismatched outbox", async () => {
      await db.query(
        "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES('ob-foreign','jira','other-case','jira.webhook.received','{}')",
      );
      const base = {
        eventId: "ev-foreign",
        ownerId: "o1",
        connectionId: "c1",
        issueKey: "PROJ-1",
        caseId: "case1",
        entityId: "ent-missing",
        outboxId: "ob1",
        canonicalDigest: `sha256:${"f".repeat(64)}`,
      };
      await expect(db.withTransaction((tx) => repo.record(tx, base))).rejects.toThrow();
      await expect(
        db.withTransaction((tx) =>
          repo.record(tx, { ...base, entityId: "ent1", outboxId: "ob-foreign" }),
        ),
      ).rejects.toThrow();
    });
  },
  available,
);
