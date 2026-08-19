import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { ConnectionHealth } from "@remoteagent/contracts";
import {
  CredentialRefreshCoordinator,
  CredentialRefreshLeaseLostError,
  CredentialWriteAmbiguousError,
  LocalCredentialVault,
  ScopeResolutionError,
  resolveConnectionScope,
} from "@remoteagent/policy";
import type {
  AuthoritativeConnection,
  CredentialMetadataPublisher,
  CredentialRefreshIntentStore,
  RefreshIntent,
  RefreshLease,
  RefreshLeaseAcquisition,
} from "@remoteagent/policy";

import { Database, IntegrityViolationError } from "../src/index.js";
import { CredentialRefreshIdentityError } from "../src/index.js";
import {
  ConnectionRepository,
  CredentialRefreshIntentRepository,
  OwnerRepository,
} from "../src/repositories/index.js";
import type {
  BeginRefreshIntent,
  ConnectionRow,
  ConnectionScopeRow,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

/** Adapt the DB-backed intent repository to the policy store interface. */
class DbRefreshIntentStore implements CredentialRefreshIntentStore {
  public constructor(
    private readonly db: Database,
    private readonly repo: CredentialRefreshIntentRepository,
  ) {}

  public async begin(input: BeginRefreshIntent): Promise<RefreshIntent> {
    return toIntent(await this.repo.begin(this.db, input));
  }
  public async acquireLease(
    operationId: string,
    holder: string,
    leaseDurationMs: number,
  ): Promise<RefreshLeaseAcquisition> {
    const claim = await this.repo.acquireLease(this.db, {
      operationId,
      holder,
      leaseDurationMs,
    });
    if (claim.acquired) {
      return {
        status: "ACQUIRED",
        intent: toIntent(claim.row),
        lease: { holder, fencingToken: claim.fencingToken! },
      };
    }
    return { status: "OBSERVER", intent: toIntent(claim.row) };
  }
  public async renewLease(
    operationId: string,
    lease: RefreshLease,
    leaseDurationMs: number,
  ): Promise<boolean> {
    return this.repo.renewLease(this.db, operationId, lease, leaseDurationMs);
  }
  public async releaseLease(operationId: string, lease: RefreshLease): Promise<void> {
    await this.repo.releaseLease(this.db, operationId, lease);
  }
  public async recordLifecycle(
    operationId: string,
    lifecycle: { expiresAt: Date; refreshAfter: Date },
    lease: RefreshLease,
  ): Promise<void> {
    this.#assertFenced(await this.repo.recordLifecycle(this.db, operationId, lifecycle, lease));
  }
  public async markAcquiring(operationId: string, lease: RefreshLease): Promise<void> {
    this.#assertFenced(await this.repo.setStatus(this.db, operationId, "ACQUIRING", lease));
  }
  public async markVaultWritten(operationId: string, lease: RefreshLease): Promise<void> {
    this.#assertFenced(await this.repo.setStatus(this.db, operationId, "VAULT_WRITTEN", lease));
  }
  public async markPublished(operationId: string, lease: RefreshLease): Promise<void> {
    this.#assertFenced(await this.repo.setStatus(this.db, operationId, "PUBLISHED", lease));
  }
  public async markAborted(operationId: string, lease: RefreshLease): Promise<void> {
    this.#assertFenced(await this.repo.setStatus(this.db, operationId, "ABORTED", lease));
  }
  public async markAmbiguous(operationId: string, lease: RefreshLease): Promise<void> {
    this.#assertFenced(await this.repo.setStatus(this.db, operationId, "AMBIGUOUS", lease));
  }

  /** A fenced write that affected no row means the lease was taken over. */
  #assertFenced(applied: boolean): void {
    if (!applied) throw new CredentialRefreshLeaseLostError();
  }
}

function toIntent(
  row: Awaited<ReturnType<CredentialRefreshIntentRepository["begin"]>>,
): RefreshIntent {
  return {
    operationId: row.operation_id,
    connectionId: row.connection_id,
    ownerId: row.owner_id,
    provider: row.provider,
    expectedRevision: BigInt(row.expected_revision),
    versionId: row.version_id,
    credentialSecretRef: row.credential_secret_ref,
    status: row.status,
    oauthExpiresAt: row.oauth_expires_at,
    oauthRefreshAfter: row.oauth_refresh_after,
  };
}

function toAuthoritativeConnection(
  row: ConnectionRow,
  scopes: readonly ConnectionScopeRow[],
): AuthoritativeConnection {
  return {
    connectionId: row.connection_id,
    ownerId: row.owner_id,
    provider: row.provider,
    alias: row.alias,
    capabilities: row.capabilities,
    health: row.health_status,
    scopes: scopes.map((scope) => ({ kind: scope.scope_kind, value: scope.scope_value })),
  };
}

describeIntegration(
  "RA-005 case resource scope and durable credential refresh",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const intents = new CredentialRefreshIntentRepository();

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
        `TRUNCATE credential_refresh_intents, case_connection_scopes, kill_switch_events,
                  connection_scopes, case_connections, cases, connections, owners
         RESTART IDENTITY CASCADE`,
      );
    });

    async function seedDualRepoCase(): Promise<void> {
      await owners.insert(db, { ownerId: "owner-1", displayName: "Owner" });
      await connections.insert(db, {
        connectionId: "gitlab-dual",
        ownerId: "owner-1",
        provider: "gitlab",
        alias: "private",
        displayName: "Dual repo GitLab",
        capabilities: ["repo.read", "repo.write"],
        credentialSecretRef: "connections/gitlab-dual/credentials/v1",
        health: "HEALTHY",
        oauthExpiresAt: new Date("2026-08-20T00:00:00Z"),
        oauthRefreshAfter: new Date("2026-08-19T23:00:00Z"),
      });
      await db.withTransaction((tx) =>
        connections.replaceScopes(tx, "gitlab-dual", [
          { kind: "repository", value: "owner/repo-a" },
          { kind: "repository", value: "owner/repo-b" },
        ]),
      );
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
         VALUES ('case-repo-a', 'owner-1', 'NEW',
           '{"providers":["gitlab"],"connection_ids":["gitlab-dual"]}'::jsonb, 'thread-1')`,
      );
    }

    it("intersects a request with the case resource grant, not the whole connection", async () => {
      await seedDualRepoCase();
      await db.withTransaction((tx) =>
        connections.replaceCaseScopes(tx, {
          caseId: "case-repo-a",
          connectionId: "gitlab-dual",
          scopes: [{ kind: "repository", value: "owner/repo-a" }],
        }),
      );

      const caseScope = await connections.loadCaseScope(db, "case-repo-a");
      expect(caseScope).not.toBeNull();
      expect(caseScope?.resourceScopes).toEqual([
        { connectionId: "gitlab-dual", kind: "repository", value: "owner/repo-a" },
      ]);

      const row = (await connections.findById(db, "gitlab-dual"))!;
      const authConn = toAuthoritativeConnection(
        row,
        await connections.listScopes(db, "gitlab-dual"),
      );

      // repo-a (granted to the case) resolves.
      const resolved = resolveConnectionScope({
        caseScope: caseScope!,
        connections: [authConn],
        provider: "gitlab",
        alias: "private",
        requiredCapability: "repo.write",
        requestedTarget: { kind: "repository", value: "owner/repo-a" },
      });
      expect(resolved.selectedTarget).toEqual({ kind: "repository", value: "owner/repo-a" });

      // repo-b (on the same connection, NOT granted to this case) is rejected.
      expect(() =>
        resolveConnectionScope({
          caseScope: caseScope!,
          connections: [authConn],
          provider: "gitlab",
          alias: "private",
          requiredCapability: "repo.write",
          requestedTarget: { kind: "repository", value: "owner/repo-b" },
        }),
      ).toThrow(ScopeResolutionError);
    });

    it("rejects a case grant that is not a configured connection scope", async () => {
      await seedDualRepoCase();
      await expect(
        db.withTransaction((tx) =>
          connections.replaceCaseScopes(tx, {
            caseId: "case-repo-a",
            connectionId: "gitlab-dual",
            scopes: [{ kind: "repository", value: "owner/repo-c" }],
          }),
        ),
      ).rejects.toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a case grant for a connection outside the case membership", async () => {
      await seedDualRepoCase();
      await connections.insert(db, {
        connectionId: "gitlab-other",
        ownerId: "owner-1",
        provider: "gitlab",
        alias: "private",
        displayName: "Other GitLab",
        capabilities: ["repo.read"],
        credentialSecretRef: "connections/gitlab-other/credentials/v1",
        health: "HEALTHY",
      });
      await db.withTransaction((tx) =>
        connections.replaceScopes(tx, "gitlab-other", [
          { kind: "repository", value: "owner/repo-x" },
        ]),
      );
      await expect(
        db.withTransaction((tx) =>
          connections.replaceCaseScopes(tx, {
            caseId: "case-repo-a",
            connectionId: "gitlab-other",
            scopes: [{ kind: "repository", value: "owner/repo-x" }],
          }),
        ),
      ).rejects.toBeInstanceOf(IntegrityViolationError);
    });

    it("drops case resource grants when the connection scope is removed (fail-closed)", async () => {
      await seedDualRepoCase();
      await db.withTransaction((tx) =>
        connections.replaceCaseScopes(tx, {
          caseId: "case-repo-a",
          connectionId: "gitlab-dual",
          scopes: [{ kind: "repository", value: "owner/repo-a" }],
        }),
      );
      // Removing repo-a from the connection cascades to the case grant.
      await db.withTransaction((tx) =>
        connections.replaceScopes(tx, "gitlab-dual", [
          { kind: "repository", value: "owner/repo-b" },
        ]),
      );
      expect(await connections.listCaseScopes(db, "case-repo-a")).toEqual([]);
    });

    it("keeps a refresh intent idempotent across retries and recovers after a crash", async () => {
      await seedDualRepoCase();
      const store = new DbRefreshIntentStore(db, intents);
      const vault = new LocalCredentialVault();

      // A publisher backed by the real optimistic CAS rotation.
      let crashOnce = true;
      const publisher: CredentialMetadataPublisher = {
        publish: async (input) => {
          if (crashOnce) {
            crashOnce = false;
            throw new Error("process crashed during CAS");
          }
          const row = await connections.rotateCredentialMetadata(db, {
            connectionId: input.connectionId,
            expectedRevision: input.expectedRevision,
            credentialSecretRef: input.credentialSecretRef,
            health: ConnectionHealth.HEALTHY,
            oauthExpiresAt: input.oauthExpiresAt,
            oauthRefreshAfter: input.oauthRefreshAfter,
            checkedAt: input.checkedAt,
          });
          return row !== null;
        },
        // The crash occurs BEFORE the CAS commits, so a value-free read of the
        // connection shows nothing published for this intent yet.
        reconcile: async (input) => {
          const row = await connections.findById(db, "gitlab-dual");
          if (row === null) return "UNKNOWN";
          if (row.credential_secret_ref === input.credentialSecretRef) return "PUBLISHED_THIS";
          if (BigInt(row.credential_revision) > input.expectedRevision) return "PUBLISHED_OTHER";
          return "NOT_PUBLISHED";
        },
      };

      let acquireCalls = 0;
      const acquire = async () => {
        acquireCalls += 1;
        return {
          secret: new TextEncoder().encode("real-refresh-token"),
          expiresAt: new Date("2026-08-21T00:00:00Z"),
          refreshAfter: new Date("2026-08-20T23:00:00Z"),
        };
      };

      const first = new CredentialRefreshCoordinator(vault, publisher, store, {
        uuid: () => "00000000-0000-4000-8000-0000000000ff",
      });
      await expect(
        first.refresh({
          operationId: "op-real",
          connectionId: "gitlab-dual",
          ownerId: "owner-1",
          provider: "gitlab",
          expectedRevision: 0n,
          acquire,
        }),
      ).rejects.toThrow("process crashed during CAS");

      // The durable intent survived the crash as VAULT_WRITTEN.
      const persisted = await intents.findById(db, "op-real");
      expect(persisted?.status).toBe("VAULT_WRITTEN");
      const stableRef = persisted!.credential_secret_ref;

      // A fresh coordinator (process restart) recovers from the durable intent.
      const recovered = new CredentialRefreshCoordinator(vault, publisher, store, {
        uuid: () => "00000000-0000-4000-8000-000000000000", // must NOT be used
      });
      const ref = await recovered.refresh({
        operationId: "op-real",
        connectionId: "gitlab-dual",
        ownerId: "owner-1",
        provider: "gitlab",
        expectedRevision: 0n,
        acquire,
      });

      expect(ref).toBe(stableRef);
      expect(acquireCalls).toBe(1); // no re-acquire on recovery
      expect((await intents.findById(db, "op-real"))?.status).toBe("PUBLISHED");
      expect((await connections.findById(db, "gitlab-dual"))?.credential_revision).toBe("1");

      // Re-running a PUBLISHED operation is a no-op that returns the same ref.
      const again = await recovered.refresh({
        operationId: "op-real",
        connectionId: "gitlab-dual",
        ownerId: "owner-1",
        provider: "gitlab",
        expectedRevision: 0n,
        acquire,
      });
      expect(again).toBe(stableRef);
      expect(acquireCalls).toBe(1);
      expect((await connections.findById(db, "gitlab-dual"))?.credential_revision).toBe("1");
    });

    async function seedTwoConnections(): Promise<void> {
      await owners.insert(db, { ownerId: "owner-1", displayName: "Owner" });
      for (const connectionId of ["conn-a", "conn-b"]) {
        await connections.insert(db, {
          connectionId,
          ownerId: "owner-1",
          provider: "gitlab",
          alias: "private",
          displayName: connectionId,
          capabilities: ["repo.read"],
          credentialSecretRef: `connections/${connectionId}/credentials/v1`,
          health: "HEALTHY",
        });
      }
    }

    function beginInput(overrides: Partial<BeginRefreshIntent>): BeginRefreshIntent {
      return {
        operationId: "shared-op",
        connectionId: "conn-a",
        ownerId: "owner-1",
        provider: "gitlab",
        expectedRevision: 0n,
        versionId: "00000000-0000-4000-8000-0000000000a1",
        credentialSecretRef: "connections/conn-a/credentials/00000000-0000-4000-8000-0000000000a1",
        ...overrides,
      };
    }

    it("fails closed when an operation id is reused for a different connection", async () => {
      await seedTwoConnections();
      await intents.begin(db, beginInput({}));
      await expect(
        intents.begin(
          db,
          beginInput({
            connectionId: "conn-b",
            versionId: "00000000-0000-4000-8000-0000000000a2",
            credentialSecretRef:
              "connections/conn-b/credentials/00000000-0000-4000-8000-0000000000a2",
          }),
        ),
      ).rejects.toBeInstanceOf(CredentialRefreshIdentityError);
      // The stored intent is unchanged: still bound to conn-a's original ref.
      const persisted = await intents.findById(db, "shared-op");
      expect(persisted?.connection_id).toBe("conn-a");
      expect(persisted?.credential_secret_ref).toBe(
        "connections/conn-a/credentials/00000000-0000-4000-8000-0000000000a1",
      );
    });

    it("fails closed for a reused id with a different owner, provider or revision", async () => {
      await seedTwoConnections();
      await intents.begin(db, beginInput({}));
      await expect(intents.begin(db, beginInput({ ownerId: "owner-2" }))).rejects.toBeInstanceOf(
        CredentialRefreshIdentityError,
      );
      await expect(intents.begin(db, beginInput({ provider: "jira" }))).rejects.toBeInstanceOf(
        CredentialRefreshIdentityError,
      );
      await expect(intents.begin(db, beginInput({ expectedRevision: 7n }))).rejects.toBeInstanceOf(
        CredentialRefreshIdentityError,
      );
    });

    it("resolves a concurrent operation-id collision to exactly one identity", async () => {
      await seedTwoConnections();
      const results = await Promise.allSettled([
        intents.begin(db, beginInput({})),
        intents.begin(
          db,
          beginInput({
            connectionId: "conn-b",
            versionId: "00000000-0000-4000-8000-0000000000a2",
            credentialSecretRef:
              "connections/conn-b/credentials/00000000-0000-4000-8000-0000000000a2",
          }),
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      // Exactly one begin observes its own identity; the colliding one fails closed.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        CredentialRefreshIdentityError,
      );
      // Whichever won, exactly one durable intent exists for the shared id.
      const persisted = await intents.findById(db, "shared-op");
      expect(persisted).not.toBeNull();
      expect(["conn-a", "conn-b"]).toContain(persisted?.connection_id);
    });

    it("runs exactly one acquire/write/publish for two concurrent refreshes of the same operation id", async () => {
      await seedDualRepoCase();
      const store = new DbRefreshIntentStore(db, intents);
      const vault = new LocalCredentialVault();

      let acquireCalls = 0;
      const acquire = async () => {
        acquireCalls += 1;
        return {
          secret: new TextEncoder().encode("real-refresh-token"),
          expiresAt: new Date("2026-08-21T00:00:00Z"),
          refreshAfter: new Date("2026-08-20T23:00:00Z"),
        };
      };

      let publishCalls = 0;
      const publisher: CredentialMetadataPublisher = {
        publish: async (input) => {
          publishCalls += 1;
          const row = await connections.rotateCredentialMetadata(db, {
            connectionId: input.connectionId,
            expectedRevision: input.expectedRevision,
            credentialSecretRef: input.credentialSecretRef,
            health: ConnectionHealth.HEALTHY,
            oauthExpiresAt: input.oauthExpiresAt,
            oauthRefreshAfter: input.oauthRefreshAfter,
            checkedAt: input.checkedAt,
          });
          return row !== null;
        },
        reconcile: async (input) => {
          const row = await connections.findById(db, "gitlab-dual");
          if (row === null) return "UNKNOWN";
          if (row.credential_secret_ref === input.credentialSecretRef) return "PUBLISHED_THIS";
          if (BigInt(row.credential_revision) > input.expectedRevision) return "PUBLISHED_OTHER";
          return "NOT_PUBLISHED";
        },
      };

      // Two independent coordinators (distinct lease holders = two processes) race
      // the SAME operation id with a shared, stable versionId/ref.
      const options = {
        uuid: () => "00000000-0000-4000-8000-0000000000f5",
        observerPollMs: 5,
      } as const;
      const request = {
        operationId: "op-parallel",
        connectionId: "gitlab-dual",
        ownerId: "owner-1",
        provider: "gitlab" as const,
        expectedRevision: 0n,
        acquire,
      };
      const a = new CredentialRefreshCoordinator(vault, publisher, store, options);
      const b = new CredentialRefreshCoordinator(vault, publisher, store, options);
      const results = await Promise.allSettled([a.refresh(request), b.refresh(request)]);

      // Both callers succeed and return the winner's ref; nobody revoked it.
      const refs = results.map((r) =>
        r.status === "fulfilled" ? r.value : (r.reason as Error).message,
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const expectedRef =
        "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000f5";
      expect(refs).toEqual([expectedRef, expectedRef]);

      // Exactly one acquire and one publish happened despite the concurrency.
      expect(acquireCalls).toBe(1);
      expect(publishCalls).toBe(1);

      // Durable state is terminal and consistent with the single CAS winner.
      const persisted = await intents.findById(db, "op-parallel");
      expect(persisted?.status).toBe("PUBLISHED");
      expect(persisted?.credential_secret_ref).toBe(expectedRef);
      const connection = await connections.findById(db, "gitlab-dual");
      expect(connection?.credential_revision).toBe("1");
      expect(connection?.credential_secret_ref).toBe(expectedRef);
      // The winner's credential is preserved in the vault.
      expect(vault.has(expectedRef)).toBe(true);
    });

    it("fences a taken-over executor out of every durable mutation (real PostgreSQL)", async () => {
      await seedDualRepoCase();
      await intents.begin(
        db,
        beginInput({
          operationId: "op-fence",
          connectionId: "gitlab-dual",
          credentialSecretRef:
            "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000f6",
          versionId: "00000000-0000-4000-8000-0000000000f6",
        }),
      );

      // A zero-duration lease is immediately expired against the DB clock, so the
      // next claim takes over deterministically without a wall-clock wait.
      const first = await intents.acquireLease(db, {
        operationId: "op-fence",
        holder: "holder-1",
        leaseDurationMs: 0,
      });
      expect(first.acquired).toBe(true);

      // The first lease is already expired; a second executor takes over (fencing
      // token bumps) using the database's authoritative clock.
      const second = await intents.acquireLease(db, {
        operationId: "op-fence",
        holder: "holder-2",
        leaseDurationMs: 60_000,
      });
      expect(second.acquired).toBe(true);
      expect(second.fencingToken).toBe((first.fencingToken ?? 0n) + 1n);

      const staleLease = { holder: "holder-1", fencingToken: first.fencingToken! };
      const freshLease = { holder: "holder-2", fencingToken: second.fencingToken! };

      // Every fenced mutation by the stale holder affects zero rows.
      expect(
        await intents.recordLifecycle(
          db,
          "op-fence",
          {
            expiresAt: new Date("2026-08-20T00:00:00Z"),
            refreshAfter: new Date("2026-08-19T23:00:00Z"),
          },
          staleLease,
        ),
      ).toBe(false);
      expect(await intents.setStatus(db, "op-fence", "PUBLISHED", staleLease)).toBe(false);

      // The current holder mutates and reaches a terminal state that frees the lease.
      expect(await intents.setStatus(db, "op-fence", "PUBLISHED", freshLease)).toBe(true);
      const persisted = await intents.findById(db, "op-fence");
      expect(persisted?.status).toBe("PUBLISHED");

      // A terminal operation is never re-claimed, even once free.
      const afterTerminal = await intents.acquireLease(db, {
        operationId: "op-fence",
        holder: "holder-3",
        leaseDurationMs: 30_000,
      });
      expect(afterTerminal.acquired).toBe(false);
    });

    /** A CAS publisher backed by the real optimistic rotation with value-free reconcile. */
    function makeReconcilingPublisher(options: {
      throwAfterCommitOnce?: boolean;
    }): CredentialMetadataPublisher & { publishCalls: number } {
      let throwAfterCommit = options.throwAfterCommitOnce ?? false;
      const publisher = {
        publishCalls: 0,
        publish: async (input: {
          connectionId: string;
          expectedRevision: bigint;
          credentialSecretRef: string;
          health: typeof ConnectionHealth.HEALTHY;
          oauthExpiresAt: Date;
          oauthRefreshAfter: Date;
          checkedAt: Date;
        }) => {
          publisher.publishCalls += 1;
          const row = await connections.rotateCredentialMetadata(db, {
            connectionId: input.connectionId,
            expectedRevision: input.expectedRevision,
            credentialSecretRef: input.credentialSecretRef,
            health: ConnectionHealth.HEALTHY,
            oauthExpiresAt: input.oauthExpiresAt,
            oauthRefreshAfter: input.oauthRefreshAfter,
            checkedAt: input.checkedAt,
          });
          const committed = row !== null;
          if (committed && throwAfterCommit) {
            throwAfterCommit = false;
            // The CAS committed durably, but the acknowledgement is lost.
            throw new Error("response lost after CAS commit");
          }
          return committed;
        },
        reconcile: async (input: { expectedRevision: bigint; credentialSecretRef: string }) => {
          const row = await connections.findById(db, "gitlab-dual");
          if (row === null) return "UNKNOWN" as const;
          if (row.credential_secret_ref === input.credentialSecretRef) {
            return "PUBLISHED_THIS" as const;
          }
          if (BigInt(row.credential_revision) > input.expectedRevision) {
            return "PUBLISHED_OTHER" as const;
          }
          return "NOT_PUBLISHED" as const;
        },
      };
      return publisher;
    }

    it("reconciles a commit-then-lost CAS to PUBLISHED_THIS without revoking (real PostgreSQL)", async () => {
      await seedDualRepoCase();
      const store = new DbRefreshIntentStore(db, intents);
      const vault = new LocalCredentialVault();
      const publisher = makeReconcilingPublisher({ throwAfterCommitOnce: true });

      let acquireCalls = 0;
      const acquire = async () => {
        acquireCalls += 1;
        return {
          secret: new TextEncoder().encode("real-refresh-token"),
          expiresAt: new Date("2026-08-21T00:00:00Z"),
          refreshAfter: new Date("2026-08-20T23:00:00Z"),
        };
      };

      const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
        uuid: () => "00000000-0000-4000-8000-0000000000c7",
        renewIntervalMs: 0,
      });
      const expectedRef =
        "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000c7";

      // The CAS commits then the response is lost; reconciliation resolves it
      // INLINE to success rather than treating it as a lost race.
      const ref = await coordinator.refresh({
        operationId: "op-commit-lost",
        connectionId: "gitlab-dual",
        ownerId: "owner-1",
        provider: "gitlab",
        expectedRevision: 0n,
        acquire,
      });

      expect(ref).toBe(expectedRef);
      expect(acquireCalls).toBe(1);
      expect(publisher.publishCalls).toBe(1);
      // The connection still points at the committed ref: it was never revoked.
      const connection = await connections.findById(db, "gitlab-dual");
      expect(connection?.credential_revision).toBe("1");
      expect(connection?.credential_secret_ref).toBe(expectedRef);
      expect(vault.has(expectedRef)).toBe(true);
      expect((await intents.findById(db, "op-commit-lost"))?.status).toBe("PUBLISHED");
    });

    it("reconciles a durable markPublished failure after a committed CAS on retry (real PostgreSQL)", async () => {
      await seedDualRepoCase();
      // The store fails to persist PUBLISHED once, AFTER the CAS committed.
      class FailMarkPublishedOnce extends DbRefreshIntentStore {
        public fail = true;
        public override async markPublished(
          operationId: string,
          lease: RefreshLease,
        ): Promise<void> {
          if (this.fail) {
            this.fail = false;
            throw new Error("durable markPublished write failed");
          }
          return super.markPublished(operationId, lease);
        }
      }
      const store = new FailMarkPublishedOnce(db, intents);
      const vault = new LocalCredentialVault();
      const publisher = makeReconcilingPublisher({});

      let acquireCalls = 0;
      const acquire = async () => {
        acquireCalls += 1;
        return {
          secret: new TextEncoder().encode("real-refresh-token"),
          expiresAt: new Date("2026-08-21T00:00:00Z"),
          refreshAfter: new Date("2026-08-20T23:00:00Z"),
        };
      };
      const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
        uuid: () => "00000000-0000-4000-8000-0000000000c8",
        renewIntervalMs: 0,
      });
      const expectedRef =
        "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000c8";
      const request = {
        operationId: "op-markpub-fail",
        connectionId: "gitlab-dual",
        ownerId: "owner-1",
        provider: "gitlab" as const,
        expectedRevision: 0n,
        acquire,
      };

      // The committed CAS with a failed markPublished surfaces the store error.
      await expect(coordinator.refresh(request)).rejects.toThrow(
        "durable markPublished write failed",
      );

      // The retry sees publish() report false (revision already advanced) and
      // reconciles to PUBLISHED_THIS instead of revoking the live credential.
      const ref = await coordinator.refresh(request);
      expect(ref).toBe(expectedRef);
      expect(acquireCalls).toBe(1); // no re-acquire on retry
      expect(publisher.publishCalls).toBe(2);
      const connection = await connections.findById(db, "gitlab-dual");
      expect(connection?.credential_revision).toBe("1"); // exactly one commit
      expect(connection?.credential_secret_ref).toBe(expectedRef);
      expect(vault.has(expectedRef)).toBe(true);
      expect((await intents.findById(db, "op-markpub-fail"))?.status).toBe("PUBLISHED");
    });

    it("renews a live lease and fences renewal by a stale holder (real PostgreSQL)", async () => {
      await seedDualRepoCase();
      await intents.begin(
        db,
        beginInput({
          operationId: "op-renew",
          connectionId: "gitlab-dual",
          credentialSecretRef:
            "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000c9",
          versionId: "00000000-0000-4000-8000-0000000000c9",
        }),
      );

      // A live (non-expired) lease is renewed by its owner, pushing the deadline
      // out authoritatively via the database clock.
      const first = await intents.acquireLease(db, {
        operationId: "op-renew",
        holder: "holder-1",
        leaseDurationMs: 60_000,
      });
      expect(first.acquired).toBe(true);
      const lease = { holder: "holder-1", fencingToken: first.fencingToken! };
      expect(await intents.renewLease(db, "op-renew", lease, 60_000)).toBe(true);

      // The renewed lease is live, so a peer cannot take it over.
      const peer = await intents.acquireLease(db, {
        operationId: "op-renew",
        holder: "holder-2",
        leaseDurationMs: 60_000,
      });
      expect(peer.acquired).toBe(false);

      // A stale holder (wrong fencing token) cannot renew.
      expect(
        await intents.renewLease(
          db,
          "op-renew",
          { holder: "holder-1", fencingToken: 999n },
          60_000,
        ),
      ).toBe(false);
    });

    it("refuses to renew an already-expired lease (AUDIT-05 HIGH-11, real PostgreSQL)", async () => {
      await seedDualRepoCase();
      await intents.begin(
        db,
        beginInput({
          operationId: "op-renew-expired",
          connectionId: "gitlab-dual",
          credentialSecretRef:
            "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000ca",
          versionId: "00000000-0000-4000-8000-0000000000ca",
        }),
      );

      // A zero-duration lease is already expired against the DB clock. renewLease
      // must atomically require lease_expires_at > now(), so it cannot resurrect
      // an expired lease that a peer is free to take over.
      const first = await intents.acquireLease(db, {
        operationId: "op-renew-expired",
        holder: "holder-1",
        leaseDurationMs: 0,
      });
      expect(first.acquired).toBe(true);
      const lease = { holder: "holder-1", fencingToken: first.fencingToken! };
      expect(await intents.renewLease(db, "op-renew-expired", lease, 60_000)).toBe(false);

      // The lease is still free, so a peer takes over authoritatively.
      const peer = await intents.acquireLease(db, {
        operationId: "op-renew-expired",
        holder: "holder-2",
        leaseDurationMs: 60_000,
      });
      expect(peer.acquired).toBe(true);
    });

    it("does not repeat the OAuth acquire on takeover of an expired ACQUIRING intent (real PostgreSQL)", async () => {
      await seedDualRepoCase();
      const store = new DbRefreshIntentStore(db, intents);
      const vault = new LocalCredentialVault();
      const publisher = makeReconcilingPublisher({});

      // Simulate a crashed executor that persisted ACQUIRING under a now-expired
      // lease but never wrote the vault object (crash during/after input.acquire).
      await intents.begin(
        db,
        beginInput({
          operationId: "op-acquiring",
          connectionId: "gitlab-dual",
          credentialSecretRef:
            "connections/gitlab-dual/credentials/00000000-0000-4000-8000-0000000000cb",
          versionId: "00000000-0000-4000-8000-0000000000cb",
        }),
      );
      const crashed = await intents.acquireLease(db, {
        operationId: "op-acquiring",
        holder: "holder-crashed",
        leaseDurationMs: 0, // immediately expired
      });
      expect(crashed.acquired).toBe(true);
      expect(
        await intents.setStatus(db, "op-acquiring", "ACQUIRING", {
          holder: "holder-crashed",
          fencingToken: crashed.fencingToken!,
        }),
      ).toBe(true);

      let acquireCalls = 0;
      const acquire = async () => {
        acquireCalls += 1;
        return {
          secret: new TextEncoder().encode("should-not-run"),
          expiresAt: new Date("2026-08-21T00:00:00Z"),
          refreshAfter: new Date("2026-08-20T23:00:00Z"),
        };
      };

      const recovered = new CredentialRefreshCoordinator(vault, publisher, store, {
        uuid: () => "00000000-0000-4000-8000-0000000000cb",
        renewIntervalMs: 0,
      });

      // The takeover must NOT repeat the non-idempotent acquire and, with no vault
      // object present, must fail closed to AMBIGUOUS for manual reconciliation.
      await expect(
        recovered.refresh({
          operationId: "op-acquiring",
          connectionId: "gitlab-dual",
          ownerId: "owner-1",
          provider: "gitlab",
          expectedRevision: 0n,
          acquire,
        }),
      ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
      expect(acquireCalls).toBe(0);
      expect(publisher.publishCalls).toBe(0);
      expect((await intents.findById(db, "op-acquiring"))?.status).toBe("AMBIGUOUS");
      // The connection was never rotated and no credential was published.
      expect((await connections.findById(db, "gitlab-dual"))?.credential_revision).toBe("0");
    });
  },
  available,
);
