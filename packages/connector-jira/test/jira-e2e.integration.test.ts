/**
 * RA-016 end-to-end proof for the Jira connector.
 *
 * One fake Jira event travels the whole path against a REAL PostgreSQL:
 *
 *   signed webhook  ->  verified ingress (durable raw payload + ingress outbox)
 *                   ->  processJiraWebhook
 *                   ->  normalized event  +  durable issue snapshot
 *                   ->  case / external entity / Discord binding
 *                   ->  outbox row (aggregate='discord_case') routed to #jira
 *
 * Every assertion reads the durable state back out of the database; the value
 * returned by `processJiraWebhook` is never the only evidence. The suite also
 * covers duplicate delivery, sparse-webhook enrichment that must not clobber a
 * newer durable snapshot, the lost-event reconciliation path, two mutually
 * invisible owner/connection scopes and a restart that must not double-apply.
 *
 * No network, no real Jira, no real Discord, no real credentials: the REST
 * surface is `FakeJira` and Discord is the durable outbox the real dispatcher
 * consumes. All Jira-authored text stays UNTRUSTED_DATA.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import {
  ConnectionRepository,
  Database,
  JiraReconciliationRepository,
  OwnerRepository,
  type Transaction,
} from "@remoteagent/database";
import { ChannelRegistry } from "@remoteagent/discord";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { ingestJiraWebhook, type RawPayloadStore } from "../src/webhook/ingress.js";
import { processJiraWebhook, type JiraRuntimeOptions } from "../src/runtime.js";
import { correlateJiraIssueInTransaction } from "../src/correlation.js";
import { reconcileJiraIssues, type JiraReconciliationIssueContext } from "../src/reconciliation.js";
import { buildJiraIssueSnapshot } from "../src/enrichment.js";
import type { JiraRestClient } from "../src/rest/client.js";
import { FakeJira } from "./fake-jira.js";
import {
  E2E_ISSUE_UPDATED,
  E2E_ISSUE_UPDATED_NEWER,
  E2E_PROJECT_KEY,
  E2E_REST_STATUS,
  E2E_REST_SUMMARY,
  e2eIssue,
} from "./fixtures/e2e-issues.js";
import {
  E2E_WEBHOOK_ACTOR_ID,
  E2E_WEBHOOK_STATUS,
  E2E_WEBHOOK_SUMMARY,
  E2E_WEBHOOK_TIMESTAMP_MS,
  commentCreatedWebhook,
  issueCreatedWebhook,
  issueUpdatedWebhook,
} from "./fixtures/e2e-events.js";

const available = await ensurePostgres();

const OWNER_A = "owner-e2e-a";
const OWNER_B = "owner-e2e-b";
const CONN_A = "conn-e2e-a";
const CONN_B = "conn-e2e-b";
const ISSUER = "jira-e2e-test";
/** Obvious test secret; never a real Jira client secret. */
const SECRET = new TextEncoder().encode("jira-e2e-test-secret");
const CAPTURED_AT = "2026-08-20T00:00:00.000Z";
const JIRA_CHANNEL_ID = "channel-jira";

const channels = new ChannelRegistry({
  guildId: "guild-e2e",
  ownerId: OWNER_A,
  channels: {
    jira: JIRA_CHANNEL_ID,
    "gmail-private": "channel-gmail-private",
    "gmail-sondermind": "channel-gmail-sondermind",
    "calendar-private": "channel-calendar-private",
    "calendar-sondermind": "channel-calendar-sondermind",
    gitlab: "channel-gitlab",
    system: "channel-system",
  },
});

/**
 * The exact body Discord must receive for the untrusted REST summary: the
 * mass-mention and raw-mention syntax is neutralized with a zero-width space
 * (\u200b) so a crafted Jira summary can never ping the guild.
 */
const ZWSP = "\u200b";
const NEUTRALIZED_SUMMARY = E2E_REST_SUMMARY.replace("@everyone", `@${ZWSP}everyone`).replace(
  "<@1234567890>",
  `<@${ZWSP}1234567890>`,
);

interface OutboxRow {
  outbox_id: string;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  payload: { case_id: string; seq: number; body: string; title?: string; alias?: string };
  dispatch_status: string | null;
}

describeIntegration(
  "Jira connector end-to-end",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    /** Stands in for durable blob storage; survives a simulated restart. */
    const payloads = new Map<string, Uint8Array>();
    let store: RawPayloadStore;
    let ids = 0;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      ids = 0;
      payloads.clear();
      await db.query(
        "TRUNCATE jira_issue_snapshots, jira_reconciliation_watermarks, jira_projection_receipts, events, outbox_dispatch, outbox, discord_case_bindings, external_entities, cases, raw_events, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: OWNER_A, displayName: "owner a" });
      await new OwnerRepository().insert(db, { ownerId: OWNER_B, displayName: "owner b" });
      await new ConnectionRepository().insert(db, {
        connectionId: CONN_A,
        ownerId: OWNER_A,
        provider: "jira",
        alias: "private",
        displayName: "jira a",
      });
      await new ConnectionRepository().insert(db, {
        connectionId: CONN_B,
        ownerId: OWNER_B,
        provider: "jira",
        alias: "sondermind",
        displayName: "jira b",
      });
      store = {
        putIfAbsent: async ({ key, body }) => {
          const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
          const ref = `blob-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
          if (!payloads.has(ref)) payloads.set(ref, new Uint8Array(body));
          return { ref, digest };
        },
      };
    });

    const config = (ownerId: string, connectionId: string) => ({
      schema_version: 1,
      owner_id: ownerId,
      connection_id: connectionId,
      provider: "jira" as const,
      project_allowlist: [E2E_PROJECT_KEY],
    });

    /** A bearer token Jira would present; only the fixture secret can sign it. */
    const bearer = async (deliveryId: string) =>
      `Bearer ${await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime("5m")
        .setJti(deliveryId)
        .sign(SECRET)}`;

    /** Verified ingress of one webhook delivery. */
    const deliver = async (
      payload: unknown,
      deliveryId: string,
      ownerId = OWNER_A,
      connectionId = CONN_A,
      authorization?: string,
    ) => {
      const body = new TextEncoder().encode(JSON.stringify(payload));
      return {
        body,
        result: await ingestJiraWebhook(
          { authorization: authorization ?? (await bearer(deliveryId)), body },
          {
            db,
            rawPayloadStore: store,
            ownerId,
            connectionId,
            issuer: ISSUER,
            getClientSecret: async () => SECRET,
          },
        ),
      };
    };

    /**
     * Runtime wiring. `FakeJira` implements the methods the connector calls, but
     * `JiraRuntimeOptions.restClient` is the concrete class (it carries a private
     * member, so it is nominal); the cast is the only way to inject a fake
     * without editing production code, and it is exactly what the existing
     * runtime suite does.
     */
    const runtime = (
      jira: FakeJira,
      ownerId = OWNER_A,
      connectionId = CONN_A,
    ): JiraRuntimeOptions => ({
      db,
      ownerId,
      connectionId,
      reader: {
        get: async (ref) => {
          const bytes = payloads.get(ref);
          if (bytes === undefined) throw new Error("raw payload missing");
          return new Uint8Array(bytes);
        },
      },
      config: config(ownerId, connectionId),
      restClient: jira as unknown as JiraRestClient,
      channelRegistry: channels,
      ids: {
        caseId: () => `case-e2e-${++ids}`,
        entityId: () => `entity-e2e-${++ids}`,
        outboxId: () => `outbox-e2e-${++ids}`,
      },
    });

    const count = async (sql: string, params: unknown[] = []): Promise<string> =>
      (await db.query<{ count: string }>(`SELECT count(*)::text AS count ${sql}`, params)).rows[0]!
        .count;

    const discordOutbox = async (caseId?: string): Promise<OutboxRow[]> =>
      (
        await db.query<OutboxRow>(
          `SELECT o.outbox_id, o.aggregate, o.aggregate_id, o.event_type, o.payload, d.status AS dispatch_status
           FROM outbox o LEFT JOIN outbox_dispatch d ON d.outbox_id = o.outbox_id
           WHERE o.aggregate='discord_case' AND ($1::text IS NULL OR o.aggregate_id=$1)
           ORDER BY o.outbox_id`,
          [caseId ?? null],
        )
      ).rows;

    /** Reconciliation apply step: the lost issue takes the same Discord path. */
    const applyLostIssue = async (tx: Transaction, context: JiraReconciliationIssueContext) => {
      await correlateJiraIssueInTransaction(
        tx,
        {
          eventId: context.eventId,
          issueKey: context.issue.key,
          status: context.issue.fields.status?.value,
          summary: context.issue.fields.summary?.value,
        },
        {
          ownerId: context.ownerId,
          connectionId: context.connectionId,
          channelRegistry: channels,
          ids: {
            caseId: () => `case-lost-${++ids}`,
            entityId: () => `entity-lost-${++ids}`,
            outboxId: () => `outbox-lost-${++ids}`,
          },
        },
      );
    };

    it("carries a verified webhook all the way to a #jira Discord outbox row", async () => {
      const issueKey = `${E2E_PROJECT_KEY}-1`;
      const jira = new FakeJira([e2eIssue({ key: issueKey })]);

      // An unverifiable delivery never reaches durable storage at all.
      await expect(
        deliver(
          issueCreatedWebhook({ issueKey }),
          "delivery-forged",
          OWNER_A,
          CONN_A,
          "Bearer x.y.z",
        ),
      ).rejects.toMatchObject({ name: "JiraContractError" });
      expect(await count("FROM raw_events")).toBe("0");

      const { body, result: ingress } = await deliver(
        issueCreatedWebhook({ issueKey }),
        "delivery-1",
      );
      expect(ingress.accepted).toBe(true);

      // 1. Verified ingress persisted the raw payload durably and unmodified.
      const rawEvent = (
        await db.query<{
          raw_event_id: string;
          provider: string;
          owner_id: string;
          connection_id: string;
          payload_ref: string;
          payload_digest: string;
          payload_size_bytes: string;
          sensitivity: string;
        }>("SELECT * FROM raw_events")
      ).rows;
      expect(rawEvent).toHaveLength(1);
      expect(rawEvent[0]).toMatchObject({
        raw_event_id: ingress.rawEventId,
        provider: "jira",
        owner_id: OWNER_A,
        connection_id: CONN_A,
        payload_digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        payload_size_bytes: String(body.byteLength),
        sensitivity: "restricted",
      });
      expect(payloads.get(rawEvent[0]!.payload_ref)).toEqual(new Uint8Array(body));
      expect(
        await count("FROM outbox WHERE aggregate='jira_webhook' AND outbox_id=$1", [
          ingress.outboxId,
        ]),
      ).toBe("1");

      const applied = await processJiraWebhook({ rawEventId: ingress.rawEventId }, runtime(jira));
      expect(applied.status).toBe("APPLIED");
      expect(jira.getIssueCalls).toEqual([issueKey]);

      // 2. Normalized event, bound to the durable raw event and to this scope.
      const events = (
        await db.query<{
          event_id: string;
          provider: string;
          owner_id: string;
          connection_id: string;
          event_type: string;
          dedupe_key: string;
          raw_event_id: string;
          entity_provider: string;
          entity_kind: string;
          entity_external_id: string;
          correlation_keys: string[];
          actor: { external_actor_id?: string };
          sensitivity: string;
          occurred_at: Date;
        }>("SELECT * FROM events")
      ).rows;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event_id: ingress.rawEventId,
        provider: "jira",
        owner_id: OWNER_A,
        connection_id: CONN_A,
        event_type: "issue_created",
        dedupe_key: ingress.rawEventId,
        raw_event_id: ingress.rawEventId,
        entity_provider: "jira",
        entity_kind: "jira_issue",
        entity_external_id: issueKey,
        sensitivity: "restricted",
      });
      expect(events[0]!.correlation_keys).toEqual([E2E_PROJECT_KEY, issueKey]);
      expect(events[0]!.actor.external_actor_id).toBe(E2E_WEBHOOK_ACTOR_ID);
      expect(events[0]!.occurred_at.toISOString()).toBe(
        new Date(E2E_WEBHOOK_TIMESTAMP_MS).toISOString(),
      );

      // 3. Enrichment wrote the authoritative issue snapshot, still untrusted.
      const snapshots = (
        await db.query<{
          owner_id: string;
          connection_id: string;
          project_key: string;
          issue_key: string;
          issue_version_ms: string;
          snapshot: { summary: { trust: string; value: string }; status: { value: string } };
        }>("SELECT * FROM jira_issue_snapshots")
      ).rows;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        owner_id: OWNER_A,
        connection_id: CONN_A,
        project_key: E2E_PROJECT_KEY,
        issue_key: issueKey,
        issue_version_ms: String(Date.parse(E2E_ISSUE_UPDATED)),
      });
      expect(snapshots[0]!.snapshot.summary).toEqual({
        trust: "UNTRUSTED_DATA",
        value: E2E_REST_SUMMARY,
      });

      // 4. Case + external entity, both scoped to this owner and connection.
      const entity = (
        await db.query<{
          entity_id: string;
          case_id: string;
          owner_id: string;
          connection_id: string;
          provider: string;
          kind: string;
          external_id: string;
        }>("SELECT * FROM external_entities")
      ).rows;
      expect(entity).toHaveLength(1);
      expect(entity[0]).toMatchObject({
        owner_id: OWNER_A,
        connection_id: CONN_A,
        provider: "jira",
        kind: "jira_issue",
        external_id: issueKey,
      });
      const caseRow = (
        await db.query<{
          case_id: string;
          owner_id: string;
          status: string;
          integration_scope: { providers: string[]; connection_ids: string[] };
        }>("SELECT * FROM cases")
      ).rows;
      expect(caseRow).toHaveLength(1);
      expect(caseRow[0]).toMatchObject({
        case_id: entity[0]!.case_id,
        owner_id: OWNER_A,
        status: "NEW",
      });
      expect(caseRow[0]!.integration_scope).toEqual({
        providers: ["jira"],
        connection_ids: [CONN_A],
      });

      // 5. Discord routing: the case's binding points at #jira, seq reserved.
      const binding = (
        await db.query<{ case_id: string; owner_id: string; channel_id: string; next_seq: string }>(
          "SELECT case_id, owner_id, channel_id, next_seq::text FROM discord_case_bindings",
        )
      ).rows;
      expect(binding).toEqual([
        {
          case_id: caseRow[0]!.case_id,
          owner_id: OWNER_A,
          channel_id: channels.channelId("jira"),
          next_seq: "2",
        },
      ]);
      expect(binding[0]!.channel_id).toBe(JIRA_CHANNEL_ID);

      // 6. Exactly one pending Discord outbox row, carrying the sanitized,
      //    still-untrusted projection of the enriched issue.
      const outbox = await discordOutbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        aggregate: "discord_case",
        aggregate_id: caseRow[0]!.case_id,
        event_type: "discord.root_thread",
        dispatch_status: "PENDING",
      });
      expect(outbox[0]!.payload.seq).toBe(1);
      expect(outbox[0]!.payload.alias).toBe("private");
      expect(outbox[0]!.payload.title).toBe(`Jira ${issueKey}`);
      // The authoritative REST snapshot wins over the thinner webhook text, and
      // the untrusted mass-mention is neutralized before it can reach Discord.
      expect(outbox[0]!.payload.body).toContain(NEUTRALIZED_SUMMARY);
      expect(outbox[0]!.payload.body).not.toContain("@everyone");
      expect(outbox[0]!.payload.body).toContain(E2E_REST_STATUS);
      expect(outbox[0]!.payload.body).not.toContain(E2E_WEBHOOK_SUMMARY);
      expect(outbox[0]!.payload.body).not.toContain(E2E_WEBHOOK_STATUS);

      // 7. The projection receipt closes the loop event -> case -> outbox.
      expect(
        (
          await db.query<{ event_id: string; case_id: string; outbox_id: string }>(
            "SELECT event_id, case_id, outbox_id FROM jira_projection_receipts",
          )
        ).rows,
      ).toEqual([
        {
          event_id: ingress.rawEventId,
          case_id: caseRow[0]!.case_id,
          outbox_id: outbox[0]!.outbox_id,
        },
      ]);
    });

    it("collapses a duplicate delivery into one event and one projection", async () => {
      const issueKey = `${E2E_PROJECT_KEY}-2`;
      const jira = new FakeJira([e2eIssue({ key: issueKey })]);
      const payload = commentCreatedWebhook({ issueKey });

      // Jira redelivers the identical webhook (same jti, same bytes).
      const first = await deliver(payload, "delivery-dup");
      const second = await deliver(payload, "delivery-dup");
      expect(second.result.rawEventId).toBe(first.result.rawEventId);
      expect(await count("FROM raw_events")).toBe("1");

      const applied = await processJiraWebhook(
        { rawEventId: first.result.rawEventId },
        runtime(jira),
      );
      const replayed = await processJiraWebhook(
        { rawEventId: second.result.rawEventId },
        runtime(jira),
      );
      expect(applied.status).toBe("APPLIED");
      expect(replayed.status).toBe("REPLAYED");
      // The duplicate is recognized before any second enriching REST call.
      expect(jira.getIssueCalls).toEqual([issueKey]);

      expect(await count("FROM events")).toBe("1");
      expect(await count("FROM cases")).toBe("1");
      expect(await count("FROM external_entities")).toBe("1");
      expect(await count("FROM jira_issue_snapshots")).toBe("1");
      expect(await count("FROM jira_projection_receipts")).toBe("1");
      expect(await discordOutbox()).toHaveLength(1);
      expect(
        (await db.query<{ next_seq: string }>("SELECT next_seq::text FROM discord_case_bindings"))
          .rows[0]!.next_seq,
      ).toBe("2");
    });

    it("enriches a sparse webhook from REST and never overwrites a newer snapshot", async () => {
      const sparseKey = `${E2E_PROJECT_KEY}-3`;
      const staleKey = `${E2E_PROJECT_KEY}-4`;
      const jira = new FakeJira([
        e2eIssue({ key: sparseKey }),
        e2eIssue({ key: staleKey, updated: E2E_ISSUE_UPDATED }),
      ]);

      // A sparse delivery has no summary and no status at all.
      const sparse = await deliver(
        issueUpdatedWebhook({ issueKey: sparseKey, sparse: true }),
        "delivery-sparse",
      );
      const sparseResult = await processJiraWebhook(
        { rawEventId: sparse.result.rawEventId },
        runtime(jira),
      );
      expect(sparseResult.status).toBe("APPLIED");
      const sparseSnapshot = (
        await db.query<{ snapshot: { summary: { value: string }; status: { value: string } } }>(
          "SELECT snapshot FROM jira_issue_snapshots WHERE issue_key=$1",
          [sparseKey],
        )
      ).rows[0]!.snapshot;
      expect(sparseSnapshot.summary.value).toBe(E2E_REST_SUMMARY);
      expect(sparseSnapshot.status.value).toBe(E2E_REST_STATUS);
      const sparseOutbox = await discordOutbox(sparseResult.correlation!.caseId);
      expect(sparseOutbox).toHaveLength(1);
      // The gap was filled from REST, not invented and not left blank.
      expect(sparseOutbox[0]!.payload.body).toContain(NEUTRALIZED_SUMMARY);
      expect(sparseOutbox[0]!.payload.body).toContain(E2E_REST_STATUS);
      expect(sparseOutbox[0]!.payload.body).not.toContain("(empty)");
      expect(sparseOutbox[0]!.payload.body).not.toContain(E2E_WEBHOOK_STATUS);

      // A NEWER durable snapshot already exists for the second issue: the older
      // REST view behind this webhook must not clobber it and must not project.
      const newer = buildJiraIssueSnapshot(
        e2eIssue({ key: staleKey, updated: E2E_ISSUE_UPDATED_NEWER }),
        CONN_A,
        OWNER_A,
        CAPTURED_AT,
      );
      await new JiraReconciliationRepository().putSnapshotIfNewer(db, {
        ownerId: OWNER_A,
        connectionId: CONN_A,
        projectKey: E2E_PROJECT_KEY,
        issueKey: staleKey,
        issueVersionMs: newer.issue_version,
        snapshot: newer,
      });
      const stale = await deliver(issueUpdatedWebhook({ issueKey: staleKey }), "delivery-stale");
      const staleResult = await processJiraWebhook(
        { rawEventId: stale.result.rawEventId },
        runtime(jira),
      );
      expect(staleResult.status).toBe("STALE");
      expect(
        (
          await db.query<{ issue_version_ms: string }>(
            "SELECT issue_version_ms::text FROM jira_issue_snapshots WHERE issue_key=$1",
            [staleKey],
          )
        ).rows[0]!.issue_version_ms,
      ).toBe(String(Date.parse(E2E_ISSUE_UPDATED_NEWER)));
      expect(await count("FROM cases")).toBe("1");
      expect(await count("FROM jira_projection_receipts")).toBe("1");
      expect(await discordOutbox()).toHaveLength(1);
    });

    it("recovers a lost webhook through reconciliation onto the same Discord path", async () => {
      const lostKey = `${E2E_PROJECT_KEY}-5`;
      // The webhook for this issue never arrived: nothing is durable yet.
      const jira = new FakeJira([e2eIssue({ key: lostKey })]);
      expect(await count("FROM raw_events")).toBe("0");

      const scope = { ownerId: OWNER_A, connectionId: CONN_A, projectKey: E2E_PROJECT_KEY };
      const first = await reconcileJiraIssues(scope, {
        db,
        search: jira,
        applyIssue: applyLostIssue,
        capturedAt: CAPTURED_AT,
      });
      expect(first.applied).toBe(1);
      expect(first.replay).toBe(false);
      expect(jira.searchCalls).toHaveLength(1);

      // The recovered issue produced the same durable projection a webhook would.
      const caseId = (await db.query<{ case_id: string }>("SELECT case_id FROM external_entities"))
        .rows[0]!.case_id;
      const outbox = await discordOutbox(caseId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({
        aggregate: "discord_case",
        event_type: "discord.root_thread",
        dispatch_status: "PENDING",
      });
      expect(outbox[0]!.payload.body).toContain(NEUTRALIZED_SUMMARY);
      expect(
        (
          await db.query<{ channel_id: string }>(
            "SELECT channel_id FROM discord_case_bindings WHERE case_id=$1",
            [caseId],
          )
        ).rows[0]!.channel_id,
      ).toBe(channels.channelId("jira"));
      expect(await count("FROM jira_issue_snapshots WHERE issue_key=$1", [lostKey])).toBe("1");
      expect(await count("FROM jira_projection_receipts")).toBe("1");
      expect(
        (
          await db.query<{ watermark_ms: string; last_issue_key: string }>(
            "SELECT watermark_ms::text, last_issue_key FROM jira_reconciliation_watermarks",
          )
        ).rows,
      ).toEqual([{ watermark_ms: String(Date.parse(E2E_ISSUE_UPDATED)), last_issue_key: lostKey }]);

      // A second sweep finds nothing new and writes nothing new.
      const second = await reconcileJiraIssues(scope, {
        db,
        search: jira,
        applyIssue: applyLostIssue,
        capturedAt: CAPTURED_AT,
      });
      expect(second.replay).toBe(true);
      expect(second.applied).toBe(0);
      expect(await count("FROM cases")).toBe("1");
      expect(await discordOutbox()).toHaveLength(1);
    });

    it("keeps two owner/connection scopes mutually invisible", async () => {
      const issueKey = `${E2E_PROJECT_KEY}-6`;
      const payload = issueCreatedWebhook({ issueKey });
      const jiraA = new FakeJira([e2eIssue({ key: issueKey })]);
      const jiraB = new FakeJira([e2eIssue({ key: issueKey })]);

      // Provider-identical deliveries (same jti, same bytes, same issue key)
      // arriving on two different connections must not collide.
      const deliveryA = await deliver(payload, "delivery-scope", OWNER_A, CONN_A);
      const deliveryB = await deliver(payload, "delivery-scope", OWNER_B, CONN_B);
      expect(deliveryB.result.rawEventId).not.toBe(deliveryA.result.rawEventId);

      const resultA = await processJiraWebhook(
        { rawEventId: deliveryA.result.rawEventId },
        runtime(jiraA),
      );
      const resultB = await processJiraWebhook(
        { rawEventId: deliveryB.result.rawEventId },
        runtime(jiraB, OWNER_B, CONN_B),
      );
      expect(resultA.status).toBe("APPLIED");
      expect(resultB.status).toBe("APPLIED");
      expect(resultA.correlation!.caseId).not.toBe(resultB.correlation!.caseId);

      // Neither scope can read the other's case, entity, snapshot or receipt.
      for (const [ownerId, connectionId, caseId] of [
        [OWNER_A, CONN_A, resultA.correlation!.caseId],
        [OWNER_B, CONN_B, resultB.correlation!.caseId],
      ] as const) {
        expect(await count("FROM cases WHERE owner_id=$1", [ownerId])).toBe("1");
        expect(
          await count(
            "FROM external_entities WHERE owner_id=$1 AND connection_id=$2 AND external_id=$3",
            [ownerId, connectionId, issueKey],
          ),
        ).toBe("1");
        expect(
          await count("FROM jira_issue_snapshots WHERE owner_id=$1 AND connection_id=$2", [
            ownerId,
            connectionId,
          ]),
        ).toBe("1");
        expect(
          await count("FROM jira_projection_receipts WHERE owner_id=$1 AND connection_id=$2", [
            ownerId,
            connectionId,
          ]),
        ).toBe("1");
        expect(await discordOutbox(caseId)).toHaveLength(1);
      }
      // No row of one scope references the other scope's owner or connection.
      expect(
        await count(
          "FROM external_entities WHERE (owner_id=$1 AND connection_id<>$2) OR (owner_id=$3 AND connection_id<>$4)",
          [OWNER_A, CONN_A, OWNER_B, CONN_B],
        ),
      ).toBe("0");
      expect(await count("FROM events")).toBe("2");
      expect(await count("FROM cases")).toBe("2");
      expect(await discordOutbox()).toHaveLength(2);
      // Each scope's projection carries its own connection alias route.
      const aliases = (
        await db.query<{ alias: string | null }>(
          "SELECT payload->>'alias' AS alias FROM outbox WHERE aggregate='discord_case' ORDER BY payload->>'alias'",
        )
      ).rows.map((row) => row.alias);
      expect(aliases).toEqual(["private", "sondermind"]);
    });

    it("re-processing the same raw event after a restart applies nothing twice", async () => {
      const issueKey = `${E2E_PROJECT_KEY}-7`;
      const jira = new FakeJira([e2eIssue({ key: issueKey })]);
      const delivery = await deliver(issueCreatedWebhook({ issueKey }), "delivery-restart");
      const applied = await processJiraWebhook(
        { rawEventId: delivery.result.rawEventId },
        runtime(jira),
      );
      expect(applied.status).toBe("APPLIED");
      const before = (
        await db.query<{
          events: string;
          cases: string;
          entities: string;
          snapshots: string;
          receipts: string;
          outbox: string;
          dispatch: string;
          next_seq: string;
        }>(
          `SELECT (SELECT count(*) FROM events)::text events,
                  (SELECT count(*) FROM cases)::text cases,
                  (SELECT count(*) FROM external_entities)::text entities,
                  (SELECT count(*) FROM jira_issue_snapshots)::text snapshots,
                  (SELECT count(*) FROM jira_projection_receipts)::text receipts,
                  (SELECT count(*) FROM outbox WHERE aggregate='discord_case')::text outbox,
                  (SELECT count(*) FROM outbox_dispatch)::text dispatch,
                  (SELECT next_seq::text FROM discord_case_bindings) next_seq`,
        )
      ).rows[0];

      // "Restart": brand-new REST client, reader and id generator; only the
      // database and the durable blob store carry state across the boundary.
      const afterRestart = new FakeJira([e2eIssue({ key: issueKey })]);
      const replay = await processJiraWebhook(
        { rawEventId: delivery.result.rawEventId },
        runtime(afterRestart),
      );
      expect(replay.status).toBe("REPLAYED");
      expect(replay.correlation!.caseId).toBe(applied.correlation!.caseId);
      expect(replay.correlation!.outboxId).toBe(applied.correlation!.outboxId);
      // A replay must not re-enrich, so the restarted client is never called.
      expect(afterRestart.getIssueCalls).toEqual([]);
      expect(
        (
          await db.query<{
            events: string;
            cases: string;
            entities: string;
            snapshots: string;
            receipts: string;
            outbox: string;
            dispatch: string;
            next_seq: string;
          }>(
            `SELECT (SELECT count(*) FROM events)::text events,
                    (SELECT count(*) FROM cases)::text cases,
                    (SELECT count(*) FROM external_entities)::text entities,
                    (SELECT count(*) FROM jira_issue_snapshots)::text snapshots,
                    (SELECT count(*) FROM jira_projection_receipts)::text receipts,
                    (SELECT count(*) FROM outbox WHERE aggregate='discord_case')::text outbox,
                    (SELECT count(*) FROM outbox_dispatch)::text dispatch,
                    (SELECT next_seq::text FROM discord_case_bindings) next_seq`,
          )
        ).rows[0],
      ).toEqual(before);
    });
  },
  available,
);
