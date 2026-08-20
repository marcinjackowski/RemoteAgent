import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { ConnectionRepository, Database, OwnerRepository } from "@remoteagent/database";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  reconcileJiraIssues as reconcileJiraIssuesImpl,
  type JiraReconciliationIssueContext,
  type JiraReconciliationOptions,
} from "../src/reconciliation.js";
import { JiraReconciliationRepository } from "@remoteagent/database";
import {
  adaptJiraSnapshotRepository,
  buildJiraIssueSnapshot,
  enrichJiraIssue,
} from "../src/enrichment.js";

const available = await ensurePostgres();
const capturedAt = "2026-08-20T00:00:00.000Z";
const reconcileJiraIssues = (
  input: Parameters<typeof reconcileJiraIssuesImpl>[0],
  options: Omit<JiraReconciliationOptions, "capturedAt">,
) => reconcileJiraIssuesImpl(input, { ...options, capturedAt });
describeIntegration(
  "jira lost-event reconciliation",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE jira_issue_snapshots, jira_reconciliation_watermarks, outbox_dispatch, outbox, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
    });
    const issue = (key: string, updated = "2030-01-01T00:00:00.000Z") => ({
      id: key,
      key,
      fields: { project: { key: "PROJ" }, labels: [], updated },
    });
    const search = (issues: ReturnType<typeof issue>[]) => ({ searchJql: async () => issues });
    const applyIssue = async (
      tx: Parameters<NonNullable<Parameters<typeof reconcileJiraIssues>[1]>["applyIssue"]>[0],
      context: JiraReconciliationIssueContext,
    ) => {
      await tx.query(
        "INSERT INTO outbox(outbox_id,aggregate,aggregate_id,event_type,payload) VALUES($1,'jira_reconciliation',$2,'jira.reconciled',$3::jsonb)",
        [
          `outbox-${context.eventId}`,
          context.issue.key,
          JSON.stringify({
            eventId: context.eventId,
            issueKey: context.issue.key,
            updated: context.issue.fields.updated,
          }),
        ],
      );
      await tx.query("INSERT INTO outbox_dispatch(outbox_id) VALUES($1)", [
        `outbox-${context.eventId}`,
      ]);
    };
    it("applies a lost issue and advances scoped watermark atomically", async () => {
      const result = await reconcileJiraIssues(
        { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" },
        { db, search: search([issue("PROJ-1")]), applyIssue },
      );
      expect(result.applied).toBe(1);
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("1");
    });
    it("exact retry is write-free and fault before commit rolls back", async () => {
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      await reconcileJiraIssues(input, { db, search: search([issue("PROJ-1")]), applyIssue });
      const before = await db.query(
        "SELECT watermark_ms, revision FROM jira_reconciliation_watermarks",
      );
      const snapshotsBefore = await db.query(
        "SELECT owner_id, connection_id, project_key, issue_key, issue_version_ms, snapshot FROM jira_issue_snapshots ORDER BY issue_key",
      );
      const replay = await reconcileJiraIssues(input, {
        db,
        search: search([issue("PROJ-1")]),
        applyIssue,
      });
      expect(replay.replay).toBe(true);
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("1");
      await expect(
        reconcileJiraIssues(input, {
          db,
          search: search([issue("PROJ-2")]),
          applyIssue,
          fault: "before_commit",
        }),
      ).rejects.toThrow("rollback");
      expect(
        (await db.query("SELECT watermark_ms, revision FROM jira_reconciliation_watermarks"))
          .rows[0],
      ).toEqual(before.rows[0]);
      expect(
        (
          await db.query(
            "SELECT owner_id, connection_id, project_key, issue_key, issue_version_ms, snapshot FROM jira_issue_snapshots ORDER BY issue_key",
          )
        ).rows,
      ).toEqual(snapshotsBefore.rows);
    });
    it("keeps two owner/connection scopes isolated and after-commit retry is idempotent", async () => {
      await new OwnerRepository().insert(db, { ownerId: "owner-2", displayName: "owner two" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-2",
        ownerId: "owner-2",
        provider: "jira",
        displayName: "jira two",
      });
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      await expect(
        reconcileJiraIssues(input, {
          db,
          search: search([issue("PROJ-1")]),
          applyIssue,
          fault: "after_commit",
        }),
      ).rejects.toThrow("committed");
      const second = await reconcileJiraIssues(input, {
        db,
        search: search([issue("PROJ-1")]),
        applyIssue,
      });
      expect(second.replay).toBe(true);
      await reconcileJiraIssues(
        { ownerId: "owner-2", connectionId: "conn-2", projectKey: "PROJ" },
        { db, search: search([issue("PROJ-1")]), applyIssue },
      );
      expect(
        (await db.query("SELECT count(*) FROM jira_reconciliation_watermarks")).rows[0].count,
      ).toBe("2");
    });
    it("retains same-timestamp late arrivals with the composite cursor", async () => {
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      await reconcileJiraIssues(input, {
        db,
        search: search([issue("PROJ-1")]),
        applyIssue,
      });
      await reconcileJiraIssues(input, {
        db,
        search: search([issue("PROJ-1"), issue("PROJ-2")]),
        applyIssue,
      });
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("2");
      const cursor = await db.query(
        "SELECT watermark_ms, last_issue_key FROM jira_reconciliation_watermarks",
      );
      expect(cursor.rows[0].last_issue_key).toBe("PROJ-2");
    });
    it("rejects foreign projects and conflicting duplicate results before writes", async () => {
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      await expect(
        reconcileJiraIssues(input, {
          db,
          search: search([
            {
              ...issue("OTHER-1"),
              fields: { ...issue("OTHER-1").fields, project: { key: "OTHER" } },
            },
          ]),
          applyIssue,
        }),
      ).rejects.toThrow("response rejected");
      await expect(
        reconcileJiraIssues(input, {
          db,
          search: search([issue("PROJ-1"), { ...issue("PROJ-1"), id: "different" }]),
          applyIssue,
        }),
      ).rejects.toThrow("duplicate conflict");
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("0");
    });
    it("skips a search result older than the durable issue snapshot", async () => {
      const snapshotStore = adaptJiraSnapshotRepository(new JiraReconciliationRepository(), db);
      await enrichJiraIssue(
        { getIssue: async () => issue("PROJ-1", "2031-01-01T00:00:00.000Z") } as never,
        snapshotStore,
        "conn-1",
        "PROJ-1",
        "owner-1",
      );
      let callbacks = 0;
      await reconcileJiraIssues(
        { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" },
        {
          db,
          search: search([issue("PROJ-1")]),
          applyIssue: async (...args) => {
            callbacks += 1;
            await applyIssue(...args);
          },
        },
      );
      expect(callbacks).toBe(0);
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("0");
      expect(
        (await db.query("SELECT issue_version_ms FROM jira_issue_snapshots")).rows[0]
          .issue_version_ms,
      ).toBe(String(Date.parse("2031-01-01T00:00:00.000Z")));
    });
    it("serializes concurrent old and new versions without an older overwrite", async () => {
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      const oldIssue = issue("PROJ-1", "2030-01-01T00:00:00.000Z");
      const newIssue = issue("PROJ-1", "2031-01-01T00:00:00.000Z");
      const calls: string[] = [];
      const apply = async (...args: Parameters<typeof applyIssue>) => {
        calls.push(args[1].issue.fields.updated);
        await applyIssue(...args);
      };
      await Promise.all([
        reconcileJiraIssues(input, { db, search: search([oldIssue]), applyIssue: apply }),
        reconcileJiraIssues(input, { db, search: search([newIssue]), applyIssue: apply }),
      ]);
      expect(calls).toContain(newIssue.fields.updated);
      expect(
        (await db.query("SELECT issue_version_ms FROM jira_issue_snapshots")).rows[0]
          .issue_version_ms,
      ).toBe(String(Date.parse(newIssue.fields.updated)));
    });
    it("keeps the newest snapshot during concurrent enrichment without reconciliation locks", async () => {
      const repo = new JiraReconciliationRepository();
      const oldIssue = issue("PROJ-1", "2030-01-01T00:00:00.000Z");
      const newIssue = issue("PROJ-1", "2031-01-01T00:00:00.000Z");
      await Promise.all([
        enrichJiraIssue(
          { getIssue: async () => oldIssue } as never,
          adaptJiraSnapshotRepository(repo, db),
          "conn-1",
          "PROJ-1",
          "owner-1",
          capturedAt,
        ),
        enrichJiraIssue(
          { getIssue: async () => newIssue } as never,
          adaptJiraSnapshotRepository(repo, db),
          "conn-1",
          "PROJ-1",
          "owner-1",
          capturedAt,
        ),
      ]);
      const row = await db.query<{ issue_version_ms: string }>(
        "SELECT issue_version_ms FROM jira_issue_snapshots WHERE owner_id=$1 AND connection_id=$2 AND project_key=$3 AND issue_key=$4",
        ["owner-1", "conn-1", "PROJ", "PROJ-1"],
      );
      expect(row.rows[0].issue_version_ms).toBe(String(Date.parse(newIssue.fields.updated)));
      const newest = await adaptJiraSnapshotRepository(repo, db).get({
        owner_id: "owner-1",
        connection_id: "conn-1",
        project_key: "PROJ",
        issue_key: "PROJ-1",
      });
      expect(newest?.issue_version).toBe(Date.parse(newIssue.fields.updated));
    });
    it("rejects a non-adjacent conflicting duplicate before any write", async () => {
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      await expect(
        reconcileJiraIssues(input, {
          db,
          search: search([
            issue("PROJ-1", "2030-01-01T00:00:00.000Z"),
            issue("PROJ-2", "2030-01-02T00:00:00.000Z"),
            issue("PROJ-1", "2030-01-03T00:00:00.000Z"),
          ]),
          applyIssue,
        }),
      ).rejects.toThrow("duplicate conflict");
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0].count).toBe("0");
      expect((await db.query("SELECT count(*) FROM jira_issue_snapshots")).rows[0].count).toBe("0");
    });
    it("reads the exact project snapshot when issue keys collide across projects", async () => {
      const repo = new JiraReconciliationRepository();
      const store = adaptJiraSnapshotRepository(repo, db);
      const projectIssue = issue("PROJ-1");
      const otherIssue = {
        ...projectIssue,
        fields: { ...projectIssue.fields, project: { key: "OTHER" } },
      };
      await repo.putSnapshotIfNewer(db, {
        ownerId: "owner-1",
        connectionId: "conn-1",
        projectKey: "PROJ",
        issueKey: "PROJ-1",
        issueVersionMs: Date.parse(projectIssue.fields.updated),
        snapshot: buildJiraIssueSnapshot(projectIssue as never, "conn-1", "owner-1", capturedAt),
      });
      await repo.putSnapshotIfNewer(db, {
        ownerId: "owner-1",
        connectionId: "conn-1",
        projectKey: "OTHER",
        issueKey: "PROJ-1",
        issueVersionMs: Date.parse(otherIssue.fields.updated),
        snapshot: buildJiraIssueSnapshot(otherIssue as never, "conn-1", "owner-1", capturedAt),
      });
      const exact = await store.get({
        owner_id: "owner-1",
        connection_id: "conn-1",
        project_key: "PROJ",
        issue_key: "PROJ-1",
      });
      expect(exact?.project_key).toBe("PROJ");
    });
    it("uses bytewise ordering for same-timestamp tie keys", async () => {
      const input = { ownerId: "owner-1", connectionId: "conn-1", projectKey: "PROJ" };
      const left = issue("A-");
      const right = issue("A_");
      await reconcileJiraIssues(input, { db, search: search([right, left]), applyIssue });
      const expected =
        Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)) > 0 ? left.key : right.key;
      expect(
        (await db.query("SELECT last_issue_key FROM jira_reconciliation_watermarks")).rows[0]
          .last_issue_key,
      ).toBe(expected);
    });
  },
  available,
);
