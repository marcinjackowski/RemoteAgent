import { createHash } from "node:crypto";

import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "@remoteagent/database";
import { ConnectionRepository, OwnerRepository } from "@remoteagent/database";
import { ingestJiraWebhook, type RawPayloadStore } from "../src/index.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();
const secret = new TextEncoder().encode("test-client-secret");
const body = new TextEncoder().encode('{"webhookEvent":"jira:issue_updated"}');

async function token(overrides: { exp?: number; jti?: string } = {}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("jira-test")
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? "5m")
    .setJti(overrides.jti ?? "delivery-1")
    .sign(secret);
}

describeIntegration(
  "Jira webhook ingress",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let stores: { calls: number; putIfAbsent: RawPayloadStore["putIfAbsent"] };

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
      stores = {
        calls: 0,
        putIfAbsent: async ({ body: input }) => {
          stores.calls += 1;
          return {
            ref: "vault://jira/delivery-1",
            digest: `sha256:${createHash("sha256").update(input).digest("hex")}`,
          };
        },
      };
    });

    function options(store = stores) {
      return {
        db,
        rawPayloadStore: store,
        connectionId: "conn-1",
        ownerId: "owner-1",
        issuer: "jira-test",
        getClientSecret: async () => secret,
      };
    }
    async function counts() {
      return (
        await db.query<{ raw: string; outbox: string; dispatch: string }>(
          "SELECT (SELECT count(*)::text FROM raw_events) raw, (SELECT count(*)::text FROM outbox) outbox, (SELECT count(*)::text FROM outbox_dispatch) dispatch",
        )
      ).rows[0]!;
    }

    it("verifies and durably enqueues without plaintext", async () => {
      const jwt = await token();
      const authorization = `Bearer ${jwt}`;
      const result = await ingestJiraWebhook({ authorization, body }, options());
      expect(result.accepted).toBe(true);
      expect(await counts()).toEqual({ raw: "1", outbox: "1", dispatch: "1" });
      const rows = await db.query<{
        payload_ref: string;
        payload_bytes: Buffer | null;
        payload: string;
      }>(
        "SELECT r.payload_ref, r.payload_bytes, o.payload::text AS payload FROM raw_events r CROSS JOIN outbox o",
      );
      expect(rows.rows[0]?.payload_bytes).toBeNull();
      const bodyText = new TextDecoder().decode(body);
      expect(rows.rows[0]?.payload).not.toContain(bodyText);
      expect(rows.rows[0]?.payload).not.toContain(jwt);
      expect(rows.rows[0]?.payload).not.toContain("test-client-secret");
    });

    it("rejects missing, tampered and expired authorization before storage", async () => {
      const invalid = [
        undefined,
        `Bearer ${await token()}x`,
        `Bearer ${await token({ exp: Math.floor(Date.now() / 1000) - 10 })}`,
      ];
      for (const authorization of invalid) {
        const rejection = ingestJiraWebhook({ authorization, body }, options());
        await expect(rejection).rejects.toThrow();
        await rejection.catch((error: unknown) => {
          expect(String(error)).not.toContain("test-client-secret");
          expect(String(error)).not.toContain("Bearer");
        });
      }
      expect(stores.calls).toBe(0);
      expect(await counts()).toEqual({ raw: "0", outbox: "0", dispatch: "0" });
    });

    it("rejects oversized bodies without storage", async () => {
      await expect(
        ingestJiraWebhook(
          { authorization: `Bearer ${await token()}`, body: new Uint8Array(100) },
          { ...options(), maxBodyBytes: 10 },
        ),
      ).rejects.toThrow();
      expect(stores.calls).toBe(0);
      expect(await counts()).toEqual({ raw: "0", outbox: "0", dispatch: "0" });
    });

    it("deduplicates exact and concurrent replay, but rejects same jti with changed body", async () => {
      const authorization = `Bearer ${await token()}`;
      await ingestJiraWebhook({ authorization, body }, options());
      await ingestJiraWebhook({ authorization, body }, options());
      await expect(
        ingestJiraWebhook(
          { authorization, body: new TextEncoder().encode("different") },
          options(),
        ),
      ).rejects.toThrow();
      await Promise.all(
        Array.from({ length: 8 }, () => ingestJiraWebhook({ authorization, body }, options())),
      );
      expect(await counts()).toEqual({ raw: "1", outbox: "1", dispatch: "1" });
    });
  },
  available,
);
