import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import {
  ConnectionRepository,
  Database,
  JiraReconciliationRepository,
  OwnerRepository,
} from "@remoteagent/database";
import { ChannelRegistry } from "@remoteagent/discord";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { ingestJiraWebhook, type RawPayloadStore } from "../src/webhook/ingress.js";
import { processJiraWebhook, type JiraRuntimeOptions } from "../src/runtime.js";
import type { JiraRestClient } from "../src/rest/client.js";
import { buildJiraIssueSnapshot } from "../src/enrichment.js";

const available = await ensurePostgres();
const secret = new TextEncoder().encode("runtime-test-secret");
const channels = new ChannelRegistry({
  guildId: "guild",
  ownerId: "owner-1",
  channels: {
    jira: "jira-channel",
    "gmail-private": "gmail-private",
    "gmail-sondermind": "gmail-sondermind",
    "calendar-private": "calendar-private",
    "calendar-sondermind": "calendar-sondermind",
    gitlab: "gitlab",
    system: "system",
  },
});

describeIntegration(
  "Jira runtime atomic processing",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let store: RawPayloadStore;
    const payloads = new Map<string, Uint8Array>();
    let sequence = 0;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      sequence = 0;
      payloads.clear();
      await db.query(
        "TRUNCATE jira_issue_snapshots, jira_projection_receipts, events, outbox_dispatch, outbox, discord_case_bindings, external_entities, cases, raw_events, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new OwnerRepository().insert(db, { ownerId: "owner-2", displayName: "owner two" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        alias: "private",
        displayName: "jira",
      });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-2",
        ownerId: "owner-2",
        provider: "jira",
        alias: "private",
        displayName: "jira two",
      });
      store = {
        putIfAbsent: async ({ body }) => {
          const ref = `opaque-${++sequence}`;
          payloads.set(ref, new Uint8Array(body));
          return { ref, digest: `sha256:${createHash("sha256").update(body).digest("hex")}` };
        },
      };
    });

    const config = (ownerId = "owner-1", connectionId = "conn-1") => ({
      schema_version: 1,
      owner_id: ownerId,
      connection_id: connectionId,
      provider: "jira" as const,
      project_allowlist: ["PROJ"],
    });
    const raw = (event: string, issueKey = "PROJ-1", project = "PROJ") =>
      JSON.stringify({
        webhookEvent: event,
        timestamp: 1_700_000_000_000,
        issue: {
          id: "10001",
          key: issueKey,
          fields: {
            project: { key: project },
            summary: "Summary",
            status: { name: "Open" },
            updated: "2026-01-01T00:00:00.000Z",
          },
        },
        ...(event.startsWith("comment_") ? { comment: { body: "Comment" } } : {}),
      });
    const deliver = async (
      event: string,
      issueKey = "PROJ-1",
      project = "PROJ",
      ownerId = "owner-1",
      connectionId = "conn-1",
      bodyOverride?: Uint8Array,
    ) => {
      const body = bodyOverride ?? new TextEncoder().encode(raw(event, issueKey, project));
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("jira-test")
        .setIssuedAt()
        .setExpirationTime("5m")
        .setJti(`runtime-${++sequence}`)
        .sign(secret);
      return ingestJiraWebhook(
        { authorization: `Bearer ${jwt}`, body },
        {
          db,
          rawPayloadStore: store,
          ownerId,
          connectionId,
          issuer: "jira-test",
          getClientSecret: async () => secret,
        },
      );
    };
    const restIssue = (
      issueKey = "PROJ-1",
      project = "PROJ",
      updated = "2026-01-01T00:00:00.000Z",
    ) => ({
      id: "10001",
      key: issueKey,
      fields: {
        project: { key: project },
        summary: { trust: "UNTRUSTED_DATA" as const, value: "Summary" },
        status: { trust: "UNTRUSTED_DATA" as const, value: "Open" },
        labels: [],
        updated,
      },
    });
    const options = (
      restClient: Pick<JiraRestClient, "getIssue">,
      ownerId = "owner-1",
      connectionId = "conn-1",
    ): JiraRuntimeOptions => ({
      db,
      ownerId,
      connectionId,
      reader: { get: async (ref) => new Uint8Array(payloads.get(ref) ?? []) },
      config: config(ownerId, connectionId),
      restClient: restClient as JiraRestClient,
      channelRegistry: channels,
      ids: {
        caseId: () => `case-runtime-${sequence}`,
        entityId: () => `entity-runtime-${sequence}`,
        outboxId: () => `outbox-runtime-${sequence}`,
      },
    });
    const expectRedacted = (error: unknown) => {
      const rendered = `${String(error)} ${JSON.stringify(error)}`;
      for (const marker of [
        "not-json",
        "runtime-payload-canary",
        "opaque-runtime-ref",
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Bearer runtime-token-canary",
        "runtime-test-secret",
        "runtime-rest-plaintext",
      ])
        expect(rendered).not.toContain(marker);
    };

    it("atomically applies a verified issue and exact replay skips REST", async () => {
      const delivery = await deliver("jira:issue_created");
      const getIssue = vi.fn().mockResolvedValue(restIssue());
      const first = await processJiraWebhook(
        { rawEventId: delivery.rawEventId },
        options({ getIssue }),
      );
      expect(first.status).toBe("APPLIED");
      expect(getIssue).toHaveBeenCalledTimes(1);
      const before = await db.query("SELECT count(*)::text AS count FROM events");
      const replay = await processJiraWebhook(
        { rawEventId: delivery.rawEventId },
        options({ getIssue }),
      );
      expect(replay.status).toBe("REPLAYED");
      expect(getIssue).toHaveBeenCalledTimes(1);
      expect((await db.query("SELECT count(*)::text AS count FROM events")).rows[0]?.count).toBe(
        before.rows[0]?.count,
      );
    });

    it("does not GET issue_deleted and keeps owner/connection scopes isolated", async () => {
      const firstDelivery = await deliver("jira:issue_deleted");
      const firstGet = vi.fn();
      const first = await processJiraWebhook(
        { rawEventId: firstDelivery.rawEventId },
        options({ getIssue: firstGet }),
      );
      expect(first.status).toBe("APPLIED");
      expect(firstGet).not.toHaveBeenCalled();
      const secondDelivery = await deliver(
        "jira:issue_deleted",
        "PROJ-1",
        "PROJ",
        "owner-2",
        "conn-2",
      );
      const second = await processJiraWebhook(
        { rawEventId: secondDelivery.rawEventId },
        options({ getIssue: vi.fn() }, "owner-2", "conn-2"),
      );
      expect(second.status).toBe("APPLIED");
      expect((await db.query("SELECT count(*)::text AS count FROM cases")).rows[0]?.count).toBe(
        "2",
      );
    });

    it("maps every supported Jira event type using durable ingress metadata", async () => {
      const eventTypes = [
        "jira:issue_created",
        "jira:issue_updated",
        "jira:issue_deleted",
        "comment_created",
        "comment_updated",
        "comment_deleted",
      ];
      for (const [index, eventType] of eventTypes.entries()) {
        const delivery = await deliver(eventType, `PROJ-${index + 1}`);
        const getIssue = vi.fn().mockResolvedValue(restIssue(`PROJ-${index + 1}`));
        const result = await processJiraWebhook(
          { rawEventId: delivery.rawEventId },
          options({ getIssue }),
        );
        expect(result.status).toBe("APPLIED");
        if (eventType === "jira:issue_deleted") expect(getIssue).not.toHaveBeenCalled();
        else expect(getIssue).toHaveBeenCalledOnce();
      }
    });

    it("rejects REST project mismatch before creating normalized state", async () => {
      const delivery = await deliver("jira:issue_created");
      await expect(
        processJiraWebhook(
          { rawEventId: delivery.rawEventId },
          options({ getIssue: vi.fn().mockResolvedValue(restIssue("PROJ-1", "OTHER")) }),
        ),
      ).rejects.toMatchObject({ code: "JIRA_RUNTIME_REJECTED", reason: "response_scope" });
      expect((await db.query("SELECT count(*)::text AS count FROM events")).rows[0]?.count).toBe(
        "0",
      );
    });

    it("rejects exact REST issue-key mismatch before creating normalized state", async () => {
      const delivery = await deliver("jira:issue_created");
      await expect(
        processJiraWebhook(
          { rawEventId: delivery.rawEventId },
          options({ getIssue: vi.fn().mockResolvedValue(restIssue("PROJ-999", "PROJ")) }),
        ),
      ).rejects.toMatchObject({ code: "JIRA_RUNTIME_REJECTED", reason: "response_scope" });
      expect((await db.query("SELECT count(*)::text AS count FROM events")).rows[0]?.count).toBe(
        "0",
      );
      expect((await db.query("SELECT count(*)::text AS count FROM cases")).rows[0]?.count).toBe(
        "0",
      );
    });

    it("redacts every REST client exception", async () => {
      const delivery = await deliver("jira:issue_created");
      const error = await processJiraWebhook(
        { rawEventId: delivery.rawEventId },
        options({
          getIssue: vi
            .fn()
            .mockRejectedValue(
              new Error(
                "runtime-rest-plaintext opaque-runtime-ref sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa Bearer runtime-token-canary runtime-test-secret",
              ),
            ),
        }),
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "JIRA_RUNTIME_REJECTED", reason: "rest_failure" });
      expectRedacted(error);
    });

    it("rejects malformed encoding, JSON, and foreign project without leaking payload details", async () => {
      const invalidUtf8 = await deliver(
        "jira:issue_created",
        "PROJ-1",
        "PROJ",
        "owner-1",
        "conn-1",
        new Uint8Array([0xff, 0xfe]),
      );
      const utf8Error = await processJiraWebhook(
        { rawEventId: invalidUtf8.rawEventId },
        options({ getIssue: vi.fn() }),
      ).catch((value: unknown) => value);
      expect(utf8Error).toMatchObject({
        code: "JIRA_RUNTIME_REJECTED",
        reason: "payload_encoding",
      });
      expectRedacted(utf8Error);
      const invalidJson = await deliver(
        "jira:issue_created",
        "PROJ-2",
        "PROJ",
        "owner-1",
        "conn-1",
        new TextEncoder().encode("runtime-payload-canary"),
      );
      const jsonError = await processJiraWebhook(
        { rawEventId: invalidJson.rawEventId },
        options({ getIssue: vi.fn() }),
      ).catch((value: unknown) => value);
      expect(jsonError).toMatchObject({ code: "JIRA_RUNTIME_REJECTED", reason: "payload_json" });
      expectRedacted(jsonError);
      const foreign = await deliver("jira:issue_created", "PROJ-3", "OTHER");
      const error = await processJiraWebhook(
        { rawEventId: foreign.rawEventId },
        options({ getIssue: vi.fn() }),
      ).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "JIRA_RUNTIME_REJECTED", reason: "payload_rejected" });
      expectRedacted(error);
    });

    it("deduplicates concurrent exact deliveries", async () => {
      const batches = 8;
      for (let index = 0; index < batches; index += 1) {
        const issueKey = `PROJ-${index + 1}`;
        const delivery = await deliver("jira:issue_created", issueKey);
        // A deliberately slow GET widens the race window: without a single
        // critical section that spans the replay probe AND the GET, every racing
        // delivery would enter `getIssue` before the winner committed.
        const getIssue = vi.fn().mockImplementation(async (key: string) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return restIssue(key);
        });
        // Start all deliveries first, then await, so they overlap for real.
        const inFlight = Array.from({ length: 4 }, () =>
          processJiraWebhook({ rawEventId: delivery.rawEventId }, options({ getIssue })),
        );
        const results = await Promise.all(inFlight);
        expect(results.filter((result) => result.status === "APPLIED")).toHaveLength(1);
        expect(results.filter((result) => result.status === "REPLAYED")).toHaveLength(3);
        // The enriching REST call must happen exactly once per event_id, no
        // matter how many concurrent deliveries carry that event_id.
        expect(getIssue).toHaveBeenCalledTimes(1);
      }
      expect((await db.query("SELECT count(*)::text AS count FROM events")).rows[0]?.count).toBe(
        String(batches),
      );
      expect(
        (await db.query("SELECT count(*)::text AS count FROM jira_projection_receipts")).rows[0]
          ?.count,
      ).toBe(String(batches));
      expect((await db.query("SELECT count(*)::text AS count FROM cases")).rows[0]?.count).toBe(
        String(batches),
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM outbox WHERE aggregate='discord_case'",
          )
        ).rows[0]?.count,
      ).toBe(String(batches));
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM outbox_dispatch d JOIN outbox o ON o.outbox_id=d.outbox_id WHERE o.aggregate='discord_case'",
          )
        ).rows[0]?.count,
      ).toBe(String(batches));
    });

    it("rolls back normalized event, snapshot and correlation on injected fault", async () => {
      const delivery = await deliver("jira:issue_updated");
      await expect(
        processJiraWebhook(
          { rawEventId: delivery.rawEventId },
          {
            ...options({ getIssue: vi.fn().mockResolvedValue(restIssue()) }),
            fault: (stage) => {
              if (stage === "snapshot") throw new Error("fault");
            },
          },
        ),
      ).rejects.toThrow("fault");
      const counts = await db.query(
        "SELECT (SELECT count(*) FROM events)::text events, (SELECT count(*) FROM jira_issue_snapshots)::text snapshots, (SELECT count(*) FROM cases)::text cases",
      );
      expect(counts.rows[0]).toEqual({ events: "0", snapshots: "0", cases: "0" });
    });

    it("rolls back every logical write boundary", async () => {
      await db.query(
        "TRUNCATE jira_issue_snapshots, jira_projection_receipts, events, outbox_dispatch, outbox, discord_case_bindings, external_entities, cases, raw_events RESTART IDENTITY CASCADE",
      );
      const stages = [
        "event",
        "snapshot",
        "case",
        "entity",
        "binding",
        "sequence",
        "outbox",
        "receipt",
        "correlation",
      ] as const;
      for (const stage of stages) {
        const delivery = await deliver("jira:issue_updated", `PROJ-${stage}`);
        await expect(
          processJiraWebhook(
            { rawEventId: delivery.rawEventId },
            {
              ...options({ getIssue: vi.fn().mockResolvedValue(restIssue(`PROJ-${stage}`)) }),
              fault: (current) => {
                if (current === stage) throw new Error("fault");
              },
            },
          ),
        ).rejects.toThrow("fault");
        const counts = await db.query(
          "SELECT (SELECT count(*) FROM events)::text events, (SELECT count(*) FROM jira_issue_snapshots)::text snapshots, (SELECT count(*) FROM cases)::text cases, (SELECT count(*) FROM external_entities)::text entities, (SELECT count(*) FROM discord_case_bindings)::text bindings, (SELECT count(*) FROM outbox WHERE aggregate='discord_case')::text outbox, (SELECT count(*) FROM outbox_dispatch d JOIN outbox o ON o.outbox_id=d.outbox_id WHERE o.aggregate='discord_case')::text dispatch, (SELECT count(*) FROM jira_projection_receipts)::text receipts",
        );
        expect(counts.rows[0]).toEqual({
          events: "0",
          snapshots: "0",
          cases: "0",
          entities: "0",
          bindings: "0",
          outbox: "0",
          dispatch: "0",
          receipts: "0",
        });
      }
    });

    it("returns STALE without projection when the durable snapshot is newer", async () => {
      const newer = buildJiraIssueSnapshot(
        restIssue("PROJ-1", "PROJ", "2027-01-01T00:00:00.000Z"),
        "conn-1",
        "owner-1",
        "2027-01-01T00:00:00.000Z",
      );
      await new JiraReconciliationRepository().putSnapshotIfNewer(db, {
        ownerId: "owner-1",
        connectionId: "conn-1",
        projectKey: "PROJ",
        issueKey: "PROJ-1",
        issueVersionMs: newer.issue_version,
        snapshot: newer,
      });
      const delivery = await deliver("jira:issue_updated");
      const result = await processJiraWebhook(
        { rawEventId: delivery.rawEventId },
        options({ getIssue: vi.fn().mockResolvedValue(restIssue()) }),
      );
      expect(result.status).toBe("STALE");
      expect((await db.query("SELECT count(*)::text AS count FROM cases")).rows[0]?.count).toBe(
        "0",
      );
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM outbox WHERE aggregate='discord_case'",
          )
        ).rows[0]?.count,
      ).toBe("0");
      expect(
        (await db.query("SELECT count(*)::text AS count FROM jira_projection_receipts")).rows[0]
          ?.count,
      ).toBe("0");
      expect(
        (await db.query("SELECT issue_version_ms::text FROM jira_issue_snapshots")).rows[0]
          ?.issue_version_ms,
      ).toBe(String(newer.issue_version));
    });
  },
  available,
);
