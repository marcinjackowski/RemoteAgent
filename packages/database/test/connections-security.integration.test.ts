import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { AppendOnlyViolationError, Database, translatePgError } from "../src/index.js";
import {
  ConnectionRepository,
  KillSwitchRepository,
  OwnerRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "RA-005 connection security persistence",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const switches = new KillSwitchRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

    beforeEach(async () => {
      await db.query(
        `TRUNCATE kill_switch_events, connection_scopes, case_connections,
                  cases, connections, owners RESTART IDENTITY CASCADE`,
      );
    });

    async function seedGitLabConnections(): Promise<void> {
      await owners.insert(db, { ownerId: "owner-1", displayName: "Owner" });
      await connections.insert(db, {
        connectionId: "private-gitlab",
        ownerId: "owner-1",
        provider: "gitlab",
        alias: "private",
        displayName: "Private GitLab",
        capabilities: ["repo.read", "repo.write"],
        credentialSecretRef: "connections/private-gitlab/credentials/v1",
        health: "HEALTHY",
        oauthExpiresAt: new Date("2026-08-20T00:00:00Z"),
        oauthRefreshAfter: new Date("2026-08-19T23:00:00Z"),
      });
      await connections.insert(db, {
        connectionId: "work-gitlab",
        ownerId: "owner-1",
        provider: "gitlab",
        alias: "sondermind",
        displayName: "Work GitLab",
        capabilities: ["repo.read"],
        credentialSecretRef: "connections/work-gitlab/credentials/v1",
        health: "HEALTHY",
      });
    }

    it("stores only an opaque credential reference and safe lifecycle metadata", async () => {
      await seedGitLabConnections();
      const row = await connections.findById(db, "private-gitlab");
      expect(row).toMatchObject({
        alias: "private",
        health_status: "HEALTHY",
        credential_secret_ref: "connections/private-gitlab/credentials/v1",
        capabilities: ["repo.read", "repo.write"],
      });

      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'connections'`,
      );
      expect(columns.rows.map((item) => item.column_name)).not.toEqual(
        expect.arrayContaining(["access_token", "refresh_token", "secret_value", "token"]),
      );
    });

    it("keeps private and SonderMind identities separate in case resolution", async () => {
      await seedGitLabConnections();
      await db.withTransaction((tx) =>
        connections.replaceScopes(tx, "private-gitlab", [
          { kind: "repository", value: "owner/private-repo" },
        ]),
      );
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('case-1', 'owner-1', 'NEW',
           '{"providers":["gitlab"],"connection_ids":["private-gitlab"]}'::jsonb,
           'thread-1')`,
      );
      const privateRows = await connections.listForCase(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        provider: "gitlab",
        alias: "private",
      });
      const workRows = await connections.listForCase(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        provider: "gitlab",
        alias: "sondermind",
      });
      expect(privateRows.map((row) => row.connection_id)).toEqual(["private-gitlab"]);
      expect(workRows).toEqual([]);
    });

    it("enforces provider-specific repository scopes in the database", async () => {
      await seedGitLabConnections();
      await db.withTransaction((tx) =>
        connections.replaceScopes(tx, "private-gitlab", [
          { kind: "repository", value: "owner/private-repo" },
        ]),
      );
      expect(await connections.listScopes(db, "private-gitlab")).toMatchObject([
        { scope_kind: "repository", scope_value: "owner/private-repo", provider: "gitlab" },
      ]);

      await expect(
        db.withTransaction((tx) =>
          connections.replaceScopes(tx, "private-gitlab", [
            { kind: "calendar", value: "calendar-id" },
          ]),
        ),
      ).rejects.toThrow();
    });

    it("allows only one database publisher to win a credential refresh race", async () => {
      await seedGitLabConnections();
      const rotate = (ref: string) =>
        connections.rotateCredentialMetadata(db, {
          connectionId: "private-gitlab",
          expectedRevision: 0n,
          credentialSecretRef: ref,
          health: "HEALTHY",
          oauthExpiresAt: new Date("2026-08-21T00:00:00Z"),
          oauthRefreshAfter: new Date("2026-08-20T23:00:00Z"),
          checkedAt: new Date("2026-08-19T12:00:00Z"),
        });
      const [first, second] = await Promise.all([
        rotate("connections/private-gitlab/credentials/v2a"),
        rotate("connections/private-gitlab/credentials/v2b"),
      ]);
      expect([first, second].filter((value) => value !== null)).toHaveLength(1);
      expect([first, second].filter((value) => value === null)).toHaveLength(1);
      expect((await connections.findById(db, "private-gitlab"))?.credential_revision).toBe("1");
    });

    it("does not rotate a revoked connection", async () => {
      await seedGitLabConnections();
      await connections.revoke(db, "private-gitlab", new Date("2026-08-19T12:00:00Z"));
      const rotated = await connections.rotateCredentialMetadata(db, {
        connectionId: "private-gitlab",
        expectedRevision: 0n,
        credentialSecretRef: "connections/private-gitlab/credentials/v2",
        health: "HEALTHY",
        oauthExpiresAt: null,
        oauthRefreshAfter: null,
        checkedAt: new Date("2026-08-19T13:00:00Z"),
      });
      expect(rotated).toBeNull();
      expect((await connections.findById(db, "private-gitlab"))?.health_status).toBe("REVOKED");
    });

    it("keeps kill-switch evidence append-only while latest state controls effects", async () => {
      await seedGitLabConnections();
      await switches.append(db, {
        eventId: "ks-on",
        level: "CONNECTION",
        ownerId: "owner-1",
        provider: "gitlab",
        connectionId: "private-gitlab",
        enabled: true,
        reason: "incident",
        changedBy: "owner-1",
      });
      await switches.append(db, {
        eventId: "ks-off",
        level: "CONNECTION",
        ownerId: "owner-1",
        provider: "gitlab",
        connectionId: "private-gitlab",
        enabled: false,
        reason: "incident resolved",
        changedBy: "owner-1",
      });
      const effective = await switches.listEffective(db, {
        ownerId: "owner-1",
        provider: "gitlab",
        connectionId: "private-gitlab",
      });
      expect(effective).toMatchObject([{ event_id: "ks-off", enabled: false }]);
      expect(
        (
          await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM kill_switch_events",
          )
        ).rows[0]?.count,
      ).toBe("2");

      let mutationError: unknown;
      try {
        await db.query("UPDATE kill_switch_events SET reason = 'hidden' WHERE event_id = 'ks-on'");
      } catch (error) {
        mutationError = error;
      }
      expect(translatePgError(mutationError)).toBeInstanceOf(AppendOnlyViolationError);
    });
  },
  available,
);
