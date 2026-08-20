import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { SignJWT } from "jose";
import { ConnectionRepository, Database, OwnerRepository } from "@remoteagent/database";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { ingestJiraWebhook, type RawPayloadStore } from "../src/webhook/ingress.js";
import {
  JiraRawPayloadReadError,
  readVerifiedJiraPayload,
  readVerifiedJiraPayloadWithMetadata,
  type RawPayloadReader,
} from "../src/webhook/payload.js";

const available = await ensurePostgres();
const body = new TextEncoder().encode('{"safe":"payload"}');
const secret = new TextEncoder().encode("payload-test-secret");
describeIntegration(
  "Jira verified raw payload",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let store: RawPayloadStore;
    let stored: Uint8Array;
    let rawEventId: string;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, raw_events, connections, owners RESTART IDENTITY CASCADE",
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
      stored = body;
      store = {
        putIfAbsent: async ({ body: input }) => ({
          ref: "opaque-ref",
          digest: `sha256:${createHash("sha256").update(input).digest("hex")}`,
        }),
      };
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("jira-test")
        .setIssuedAt()
        .setExpirationTime("5m")
        .setJti("payload-delivery")
        .sign(secret);
      const ingress = await ingestJiraWebhook(
        { authorization: `Bearer ${jwt}`, body },
        {
          db,
          rawPayloadStore: store,
          ownerId: "owner-1",
          connectionId: "conn-1",
          issuer: "jira-test",
          getClientSecret: async () => secret,
        },
      );
      rawEventId = ingress.rawEventId;
    });
    it("reads exact scoped bytes and returns a copy", async () => {
      let calls = 0;
      const reader: RawPayloadReader = {
        get: async (ref) => {
          calls += 1;
          expect(ref).toBe("opaque-ref");
          return new Uint8Array(stored);
        },
      };
      const result = await readVerifiedJiraPayload({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        rawEventId,
        reader,
      });
      expect(result).toEqual(body);
      expect(result).not.toBe(body);
      expect(calls).toBe(1);
    });
    it("returns exact trusted metadata from the same lookup", async () => {
      const receivedAt = (
        await db.query<{ received_at: Date }>(
          "SELECT received_at FROM raw_events WHERE raw_event_id=$1",
          [rawEventId],
        )
      ).rows[0]?.received_at.toISOString();
      expect(receivedAt).toBeDefined();
      const result = await readVerifiedJiraPayloadWithMetadata({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        rawEventId,
        reader: { get: async () => body },
      });
      expect(result.metadata).toEqual({
        rawEventId,
        ownerId: "owner-1",
        connectionId: "conn-1",
        receivedAt,
        traceId: `jira_trace_${createHash("sha256").update(rawEventId).digest("hex")}`,
        payloadRef: {
          ref: "opaque-ref",
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
          size_bytes: body.byteLength,
        },
      });
      expect(result.bytes).toEqual(body);
    });
    it("returns the same durable context across separate reads and ignores forged context fields", async () => {
      const reader: RawPayloadReader = { get: async () => body };
      const first = await readVerifiedJiraPayloadWithMetadata({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        rawEventId,
        reader,
      });
      const second = await readVerifiedJiraPayloadWithMetadata({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        rawEventId,
        reader,
      });
      expect(second.metadata).toEqual(first.metadata);
      expect(second.metadata.traceId).toBe(
        `jira_trace_${createHash("sha256").update(rawEventId).digest("hex")}`,
      );
      const forgedInput = Object.assign(
        { db, ownerId: "owner-1", connectionId: "conn-1", rawEventId, reader },
        { traceId: "forged-trace", receivedAt: "2026-01-01T00:00:00.000Z" },
      );
      await expect(readVerifiedJiraPayloadWithMetadata(forgedInput)).resolves.toEqual(second);
    });
    it("rejects missing/foreign/tampered/size mismatch without leaking details", async () => {
      let calls = 0;
      const reader: RawPayloadReader = {
        get: async () => {
          calls += 1;
          return body;
        },
      };
      const expectReadFailure = async (promise: Promise<unknown>) => {
        const error = await promise.catch((value: unknown) => value);
        expect(error).toBeInstanceOf(JiraRawPayloadReadError);
        expect(error).toMatchObject({ code: "JIRA_RAW_PAYLOAD_READ_REJECTED" });
        expect(String(error)).toBe("JiraRawPayloadReadError: jira raw payload read rejected");
        for (const secretValue of [
          "opaque-ref",
          '{"safe":"payload"}',
          "Bearer",
          "payload-test-secret",
        ])
          expect(String(error)).not.toContain(secretValue);
      };
      for (const input of [
        { ownerId: "owner-1", connectionId: "conn-1", rawEventId: "missing" },
        { ownerId: "owner-foreign", connectionId: "conn-1", rawEventId },
      ])
        await expectReadFailure(readVerifiedJiraPayload({ db, ...input, reader }));
      const tampered = new Uint8Array(body);
      tampered[0] ^= 1;
      const tamperedReader: RawPayloadReader = {
        get: async () => tampered,
      };
      await expectReadFailure(
        readVerifiedJiraPayload({
          db,
          ownerId: "owner-1",
          connectionId: "conn-1",
          rawEventId,
          reader: tamperedReader,
        }),
      );
      await expectReadFailure(
        readVerifiedJiraPayload({
          db,
          ownerId: "owner-1",
          connectionId: "conn-1",
          rawEventId,
          reader: { get: async () => body.slice(0, -1) },
        }),
      );
      await expectReadFailure(
        readVerifiedJiraPayload({
          db,
          ownerId: "owner-1",
          connectionId: "conn-1",
          rawEventId,
          reader: {
            get: async () => {
              throw new Error("opaque-ref payload Bearer payload-test-secret");
            },
          },
        }),
      );
      expect(calls).toBe(0);
    });
    it("rejects invalid or oversized ingress before any reader call", async () => {
      let calls = 0;
      const reader: RawPayloadReader = {
        get: async () => {
          calls += 1;
          return body;
        },
      };
      await expect(
        ingestJiraWebhook(
          { authorization: undefined, body },
          {
            db,
            rawPayloadStore: store,
            ownerId: "owner-1",
            connectionId: "conn-1",
            issuer: "jira-test",
            getClientSecret: async () => secret,
          },
        ),
      ).rejects.toThrow();
      const invalid = await readVerifiedJiraPayload({
        db,
        ownerId: "owner-1",
        connectionId: "conn-1",
        rawEventId: "missing",
        reader,
      }).catch((error: unknown) => error);
      expect(String(invalid)).not.toContain("opaque-ref");
      expect(calls).toBe(0);
      await expect(
        ingestJiraWebhook(
          {
            authorization: `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setIssuer("jira-test").setIssuedAt().setExpirationTime("5m").setJti("oversized-delivery").sign(secret)}`,
            body,
          },
          {
            db,
            rawPayloadStore: store,
            ownerId: "owner-1",
            connectionId: "conn-1",
            issuer: "jira-test",
            getClientSecret: async () => secret,
            maxBodyBytes: 1,
          },
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect((await db.query("SELECT count(*) FROM raw_events")).rows[0].count).toBe("1");
    });
    it("does not persist plaintext in raw ledger or outbox", async () => {
      const rows = await db.query<{ body: string | null; payload: string }>(
        "SELECT r.payload_bytes AS body, o.payload::text AS payload FROM raw_events r JOIN outbox o ON o.aggregate_id=r.raw_event_id",
      );
      expect(rows.rows[0]?.body).toBeNull();
      expect(rows.rows[0]?.payload).not.toContain(new TextDecoder().decode(body));
    });
  },
  available,
);
