import { describe, expect, it } from "vitest";

import { CreateSecretCommand, DescribeSecretCommand } from "@aws-sdk/client-secrets-manager";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { ConnectionAlias, ConnectionHealth, ConnectionScopeKind } from "@remoteagent/contracts";

import {
  ConnectionBlockedError,
  AwsSecretsManagerCredentialVault,
  CredentialRefreshConflictError,
  CredentialRefreshCoordinator,
  CredentialRefreshIdentityError,
  CredentialRefreshLeaseLostError,
  CredentialUsageError,
  CredentialVaultUnavailableError,
  CredentialWriteAmbiguousError,
  InMemoryCredentialRefreshIntentStore,
  LocalCredentialVault,
  assertConnectionEffectAllowed,
  resolveConnectionScope,
} from "../src/index.js";
import type {
  CredentialMetadataPublisher,
  CredentialObjectStatus,
  CredentialVault,
  RefreshLease,
} from "../src/index.js";

const privateGitLab = {
  connectionId: "gitlab-private",
  ownerId: "owner-1",
  provider: "gitlab" as const,
  alias: ConnectionAlias.PRIVATE,
  capabilities: ["repo.read", "repo.write"],
  health: ConnectionHealth.HEALTHY,
  scopes: [{ kind: ConnectionScopeKind.REPOSITORY, value: "owner/private-repo" }],
};

const workGitLab = {
  ...privateGitLab,
  connectionId: "gitlab-work",
  alias: ConnectionAlias.SONDERMIND,
  scopes: [{ kind: ConnectionScopeKind.REPOSITORY, value: "work/service" }],
};

// A single connection configured with TWO repositories; the case is only granted
// one of them (AUDIT-01 HIGH-01: resource scope must be case-scoped).
const dualRepoGitLab = {
  connectionId: "gitlab-dual",
  ownerId: "owner-1",
  provider: "gitlab" as const,
  alias: ConnectionAlias.PRIVATE,
  capabilities: ["repo.read", "repo.write"],
  health: ConnectionHealth.HEALTHY,
  scopes: [
    { kind: ConnectionScopeKind.REPOSITORY, value: "owner/repo-a" },
    { kind: ConnectionScopeKind.REPOSITORY, value: "owner/repo-b" },
  ],
};

const privateGrant = {
  connectionId: privateGitLab.connectionId,
  kind: ConnectionScopeKind.REPOSITORY,
  value: "owner/private-repo",
};

describe("server-side scope resolution", () => {
  it("rejects a model-supplied connection outside the case allowlist", () => {
    expect(() =>
      resolveConnectionScope({
        caseScope: {
          caseId: "case-private",
          ownerId: "owner-1",
          connectionIds: [privateGitLab.connectionId],
          resourceScopes: [privateGrant],
        },
        connections: [privateGitLab, workGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.PRIVATE,
        requiredCapability: "repo.read",
        requestedConnectionId: workGitLab.connectionId,
      }),
    ).toThrow("requested connection is outside authoritative case scope");
  });

  it("fails closed when the case holds no authoritative grant on the connection", () => {
    // Membership alone is not a policy context: without a resource grant the
    // connection cannot be selected, so no-target cannot silently widen.
    expect(() =>
      resolveConnectionScope({
        caseScope: {
          caseId: "case-private",
          ownerId: "owner-1",
          connectionIds: [privateGitLab.connectionId],
          resourceScopes: [],
        },
        connections: [privateGitLab, workGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.PRIVATE,
        requiredCapability: "repo.read",
      }),
    ).toThrow("no connection satisfies the authoritative case scope");
  });

  it("returns only the case-filtered scopes, never the connection's broader list", () => {
    // The connection is configured with two repos; the case grants only one.
    const resolved = resolveConnectionScope({
      caseScope: {
        caseId: "case-repo-a",
        ownerId: "owner-1",
        connectionIds: [dualRepoGitLab.connectionId],
        resourceScopes: [
          {
            connectionId: dualRepoGitLab.connectionId,
            kind: ConnectionScopeKind.REPOSITORY,
            value: "owner/repo-a",
          },
        ],
      },
      connections: [dualRepoGitLab],
      provider: "gitlab",
      alias: ConnectionAlias.PRIVATE,
      requiredCapability: "repo.read",
    });
    // No requestedTarget, yet the result carries ONLY the granted repo-a.
    expect(resolved.selectedTarget).toBeNull();
    expect(resolved.scopes).toEqual([{ kind: "repository", value: "owner/repo-a" }]);
  });

  it("rejects a cross-alias context selection without a requestedTarget (HIGH-01)", () => {
    // Mixed-alias case: membership spans both aliases, but only the private alias
    // is granted. Selecting the SonderMind alias — even with no target — must fail
    // because the case holds no authoritative context there.
    expect(() =>
      resolveConnectionScope({
        caseScope: {
          caseId: "case-mixed",
          ownerId: "owner-1",
          connectionIds: [privateGitLab.connectionId, workGitLab.connectionId],
          resourceScopes: [privateGrant],
        },
        connections: [privateGitLab, workGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.SONDERMIND,
        requiredCapability: "repo.read",
      }),
    ).toThrow("no connection satisfies the authoritative case scope");
  });

  it("rejects a second repository on the same connection when the case grants only one", () => {
    const caseScope = {
      caseId: "case-repo-a",
      ownerId: "owner-1",
      connectionIds: [dualRepoGitLab.connectionId],
      // The case is scoped to repo-a only, even though the connection can reach both.
      resourceScopes: [
        {
          connectionId: dualRepoGitLab.connectionId,
          kind: ConnectionScopeKind.REPOSITORY,
          value: "owner/repo-a",
        },
      ],
    };
    // repo-a (granted) resolves.
    const resolved = resolveConnectionScope({
      caseScope,
      connections: [dualRepoGitLab],
      provider: "gitlab",
      alias: ConnectionAlias.PRIVATE,
      requiredCapability: "repo.write",
      requestedTarget: { kind: ConnectionScopeKind.REPOSITORY, value: "owner/repo-a" },
    });
    expect(resolved.selectedTarget).toEqual({ kind: "repository", value: "owner/repo-a" });

    // repo-b (configured on the connection but NOT granted to this case) is rejected.
    expect(() =>
      resolveConnectionScope({
        caseScope,
        connections: [dualRepoGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.PRIVATE,
        requiredCapability: "repo.write",
        requestedTarget: { kind: ConnectionScopeKind.REPOSITORY, value: "owner/repo-b" },
      }),
    ).toThrow("requested provider resource is not allowlisted for this case");
  });

  it("rejects cross-alias target selection when the case grants only the private alias", () => {
    // Case membership spans BOTH aliases of the same owner, but only the private
    // repo is granted to the case. Selecting the SonderMind alias fails closed at
    // context selection: the case holds no authoritative policy context there.
    const caseScope = {
      caseId: "case-mixed",
      ownerId: "owner-1",
      connectionIds: [privateGitLab.connectionId, workGitLab.connectionId],
      resourceScopes: [
        {
          connectionId: privateGitLab.connectionId,
          kind: ConnectionScopeKind.REPOSITORY,
          value: "owner/private-repo",
        },
      ],
    };
    expect(() =>
      resolveConnectionScope({
        caseScope,
        connections: [privateGitLab, workGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.SONDERMIND,
        requiredCapability: "repo.read",
        requestedTarget: { kind: ConnectionScopeKind.REPOSITORY, value: "work/service" },
      }),
    ).toThrow("no connection satisfies the authoritative case scope");
  });

  it("keeps private and SonderMind policy contexts disjoint", () => {
    expect(() =>
      resolveConnectionScope({
        caseScope: {
          caseId: "case-private",
          ownerId: "owner-1",
          connectionIds: [privateGitLab.connectionId],
          resourceScopes: [],
        },
        connections: [privateGitLab, workGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.SONDERMIND,
        requiredCapability: "repo.read",
      }),
    ).toThrow("no connection satisfies the authoritative case scope");
  });

  it("does not honour a case grant that is not currently configured on the connection", () => {
    // AUDIT-03 MEDIUM-06: a stale grant whose resource is no longer configured on
    // the connection holds no live authoritative context, so the connection is
    // never a candidate and selection fails closed BEFORE any target check — even
    // though the request names that (stale) target.
    expect(() =>
      resolveConnectionScope({
        caseScope: {
          caseId: "case-stale",
          ownerId: "owner-1",
          connectionIds: [privateGitLab.connectionId],
          resourceScopes: [
            {
              connectionId: privateGitLab.connectionId,
              kind: ConnectionScopeKind.REPOSITORY,
              value: "owner/removed-repo",
            },
          ],
        },
        connections: [privateGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.PRIVATE,
        requiredCapability: "repo.read",
        requestedTarget: { kind: ConnectionScopeKind.REPOSITORY, value: "owner/removed-repo" },
      }),
    ).toThrow("no connection satisfies the authoritative case scope");
  });

  it("fails closed for a stale grant with an empty intersection and NO requested target", () => {
    // AUDIT-03 MEDIUM-06: the no-target path must also fail closed. A membership +
    // stale repository grant whose intersection with the configured scopes is
    // empty must NOT surface a credential-bearing connection with scopes=[].
    expect(() =>
      resolveConnectionScope({
        caseScope: {
          caseId: "case-stale-no-target",
          ownerId: "owner-1",
          connectionIds: [privateGitLab.connectionId],
          resourceScopes: [
            {
              connectionId: privateGitLab.connectionId,
              kind: ConnectionScopeKind.REPOSITORY,
              value: "owner/removed-repo",
            },
          ],
        },
        connections: [privateGitLab],
        provider: "gitlab",
        alias: ConnectionAlias.PRIVATE,
        requiredCapability: "repo.read",
      }),
    ).toThrow("no connection satisfies the authoritative case scope");
  });
});

function acquire(value: string) {
  return async () => ({
    secret: new TextEncoder().encode(value),
    expiresAt: new Date("2026-08-20T00:00:00Z"),
    refreshAfter: new Date("2026-08-19T23:00:00Z"),
  });
}

/**
 * Value-free reconciliation is now a mandatory part of the publisher contract
 * (AUDIT-05 HIGH-10). These happy-path publishers never reach the reconcile
 * path (their CAS commits or the test asserts a pre-publish failure), but must
 * still provide it. `NOT_PUBLISHED` is the safe default: on a lost CAS with no
 * throw it lets a loser clean up ONLY its own unpublished ref.
 */
const NOT_PUBLISHED: CredentialMetadataPublisher["reconcile"] = async () => "NOT_PUBLISHED";

function okPublisher(): CredentialMetadataPublisher {
  return { publish: async () => true, reconcile: NOT_PUBLISHED };
}

const refreshBase = {
  connectionId: "conn-1",
  ownerId: "owner-1",
  provider: "gitlab" as const,
  expectedRevision: 0n,
};

describe("credential vault and refresh", () => {
  it("configures AWS Secrets Manager with the required customer KMS key", async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return {};
      },
    } as unknown as SecretsManagerClient;
    const vault = new AwsSecretsManagerCredentialVault(client, {
      kmsKeyId: "alias/remoteagent-connections",
      secretNamePrefix: "remoteagent/test",
    });
    await vault.put("connections/conn-1/credentials/v1", new Uint8Array([1, 2, 3]), {
      versionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(commands[0]).toBeInstanceOf(CreateSecretCommand);
    expect((commands[0] as CreateSecretCommand).input).toMatchObject({
      Name: "remoteagent/test/connections/conn-1/credentials/v1",
      KmsKeyId: "alias/remoteagent-connections",
      ClientRequestToken: "00000000-0000-4000-8000-000000000001",
    });
  });

  it("does not retain a provider error that echoes secret material", async () => {
    const client = {
      send: async () => {
        throw new Error("provider echoed canary-secret-value");
      },
    } as unknown as SecretsManagerClient;
    const vault = new AwsSecretsManagerCredentialVault(client, {
      kmsKeyId: "alias/remoteagent-connections",
      secretNamePrefix: "remoteagent/test",
    });
    let caught: unknown;
    try {
      await vault.put(
        "connections/conn-1/credentials/v1",
        new TextEncoder().encode("canary-secret-value"),
        { versionId: "00000000-0000-4000-8000-000000000001" },
      );
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain("canary-secret-value");
    expect((caught as Error).cause).toBeUndefined();
  });

  it("wipes transient credential bytes after callback use", async () => {
    const vault = new LocalCredentialVault();
    const original = new TextEncoder().encode("canary-secret-value");
    await vault.put("ref-1", original, { versionId: "version-1" });
    let transient: Uint8Array | undefined;
    await vault.withCredential("ref-1", (value) => {
      transient = value;
      expect(new TextDecoder().decode(value)).toBe("canary-secret-value");
    });
    expect(transient).toBeDefined();
    expect(transient?.every((byte) => byte === 0)).toBe(true);
    expect(new TextDecoder().decode(original)).toBe("canary-secret-value");
  });

  it("wraps a callback error without echoing secret material (local and AWS)", async () => {
    const local = new LocalCredentialVault();
    await local.put("ref-1", new TextEncoder().encode("audit-canary-secret"), {
      versionId: "version-1",
    });
    let caught: unknown;
    try {
      await local.withCredential("ref-1", () => {
        throw new Error("provider echoed audit-canary-secret");
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CredentialUsageError);
    expect(String(caught)).not.toContain("audit-canary-secret");
    expect((caught as Error).cause).toBeUndefined();

    const client = {
      send: async () => ({ SecretString: "audit-canary-secret" }),
    } as unknown as SecretsManagerClient;
    const aws = new AwsSecretsManagerCredentialVault(client, {
      kmsKeyId: "alias/remoteagent-connections",
      secretNamePrefix: "remoteagent/test",
    });
    let awsCaught: unknown;
    try {
      await aws.withCredential("connections/conn-1/credentials/v1", () => {
        throw new Error("downstream leaked audit-canary-secret");
      });
    } catch (error) {
      awsCaught = error;
    }
    expect(awsCaught).toBeInstanceOf(CredentialUsageError);
    expect(String(awsCaught)).not.toContain("audit-canary-secret");
    expect((awsCaught as Error).cause).toBeUndefined();
  });

  it("fails closed on a definite vault write failure without publishing metadata", async () => {
    const vault = new LocalCredentialVault();
    vault.failNext("write");
    let publishCalls = 0;
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async () => {
          publishCalls += 1;
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      store,
    );
    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-1",
        acquire: acquire("refresh-canary"),
      }),
    ).rejects.toBeInstanceOf(CredentialVaultUnavailableError);
    expect(publishCalls).toBe(0);
    expect(vault.has("connections/conn-1/credentials/00000000-0000-4000-8000-000000000001")).toBe(
      false,
    );
  });

  it("allows only one publisher to win a token refresh race", async () => {
    const vault = new LocalCredentialVault();
    let revision = 0n;
    const publisher = {
      publish: async (input: { expectedRevision: bigint }) => {
        await Promise.resolve();
        if (input.expectedRevision !== revision) return false;
        revision += 1n;
        return true;
      },
      reconcile: async (input: { expectedRevision: bigint }) =>
        input.expectedRevision < revision
          ? ("PUBLISHED_OTHER" as const)
          : ("NOT_PUBLISHED" as const),
    };
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => ids.shift()!,
    });
    const attempt = (operationId: string, value: string) =>
      coordinator.refresh({ ...refreshBase, operationId, acquire: acquire(value) });
    const results = await Promise.allSettled([
      attempt("op-a", "token-a"),
      attempt("op-b", "token-b"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      CredentialRefreshConflictError,
    );
    expect(revision).toBe(1n);
    // Exactly one ref survives; the loser revoked its own unpublished object.
    const survivors = ids.length; // both consumed
    void survivors;
    const aliveRefs = [
      "connections/conn-1/credentials/00000000-0000-4000-8000-000000000001",
      "connections/conn-1/credentials/00000000-0000-4000-8000-000000000002",
    ].filter((ref) => vault.has(ref));
    expect(aliveRefs).toHaveLength(1);
  });

  it("reconciles a create-then-timeout instead of orphaning a second version", async () => {
    const vault = new LocalCredentialVault();
    vault.timeoutAfterNextWrite();
    let publishCalls = 0;
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async () => {
          publishCalls += 1;
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      store,
      { uuid: () => "00000000-0000-4000-8000-000000000009" },
    );
    const ref = await coordinator.refresh({
      ...refreshBase,
      operationId: "op-timeout",
      acquire: acquire("token-timeout"),
    });
    expect(ref).toBe("connections/conn-1/credentials/00000000-0000-4000-8000-000000000009");
    expect(publishCalls).toBe(1);
    // Only the single reconciled object exists — no orphaned second version.
    expect(vault.has(ref)).toBe(true);
  });

  it("recovers a crash between vault write and publish without re-acquiring", async () => {
    const vault = new LocalCredentialVault();
    let acquireCalls = 0;
    const recordingAcquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("token-crash"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };
    let publishAttempts = 0;
    const publisher = {
      publish: async () => {
        publishAttempts += 1;
        if (publishAttempts === 1) throw new Error("process crashed during CAS");
        return true;
      },
      reconcile: NOT_PUBLISHED,
    };
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => "00000000-0000-4000-8000-00000000000a",
    });

    await expect(
      coordinator.refresh({ ...refreshBase, operationId: "op-crash", acquire: recordingAcquire }),
    ).rejects.toThrow("process crashed during CAS");

    // Recovery run reuses the durable intent: same ref, no second acquire, one object.
    const ref = await coordinator.refresh({
      ...refreshBase,
      operationId: "op-crash",
      acquire: recordingAcquire,
    });
    expect(ref).toBe("connections/conn-1/credentials/00000000-0000-4000-8000-00000000000a");
    expect(acquireCalls).toBe(1);
    expect(publishAttempts).toBe(2);
    expect(vault.has(ref)).toBe(true);
  });

  it("returns AMBIGUOUS instead of replaying when the reconciliation probe is unavailable", async () => {
    const vault = new LocalCredentialVault();
    vault.timeoutAfterNextWrite();
    vault.failNext("head");
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(vault, okPublisher(), store, {
      uuid: () => "00000000-0000-4000-8000-00000000000b",
    });
    await expect(
      coordinator.refresh({ ...refreshBase, operationId: "op-ambig", acquire: acquire("x") }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
  });
});

/** A fully controllable vault for reconciliation/identity fault injection. */
class FakeVault implements CredentialVault {
  public putBehaviour: "ok" | "ambiguous" | "unavailable" = "ok";
  public headResult: CredentialObjectStatus | "throw" = { exists: false };
  public readonly stored = new Map<string, string>();

  public async put(
    secretRef: string,
    _secret: Uint8Array,
    options: { versionId: string },
  ): Promise<void> {
    if (this.putBehaviour === "ambiguous") {
      throw new CredentialWriteAmbiguousError("fake write ambiguous");
    }
    if (this.putBehaviour === "unavailable") {
      throw new CredentialVaultUnavailableError("fake write failed");
    }
    this.stored.set(secretRef, options.versionId);
  }

  public async head(): Promise<CredentialObjectStatus> {
    if (this.headResult === "throw") {
      throw new CredentialWriteAmbiguousError("fake probe unavailable");
    }
    return this.headResult;
  }

  public async withCredential<T>(): Promise<T> {
    throw new Error("withCredential is unused in these tests");
  }

  public async revoke(secretRef: string): Promise<void> {
    this.stored.delete(secretRef);
  }
}

function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function awsClientFor(handlers: {
  create?: () => unknown;
  describe?: () => unknown;
}): SecretsManagerClient {
  return {
    send: async (command: unknown) => {
      if (command instanceof CreateSecretCommand) {
        return handlers.create ? handlers.create() : {};
      }
      if (command instanceof DescribeSecretCommand) {
        return handlers.describe ? handlers.describe() : {};
      }
      throw new Error("unexpected AWS command in test");
    },
  } as unknown as SecretsManagerClient;
}

const awsOptions = {
  kmsKeyId: "alias/remoteagent-connections",
  secretNamePrefix: "remoteagent/test",
} as const;

describe("AWS credential vault fault classification (HIGH-02)", () => {
  it("classifies a transport timeout after the request as AMBIGUOUS, not a clean failure", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        create: () => {
          throw awsError("TimeoutError");
        },
      }),
      awsOptions,
    );
    await expect(
      vault.put("connections/conn-1/credentials/v1", new Uint8Array([1]), {
        versionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
  });

  it("classifies a definite pre-write failure as unavailable (safe to retry)", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        create: () => {
          throw awsError("AccessDeniedException");
        },
      }),
      awsOptions,
    );
    await expect(
      vault.put("connections/conn-1/credentials/v1", new Uint8Array([1]), {
        versionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(CredentialVaultUnavailableError);
  });

  it("treats ResourceExistsException as ambiguous so the exact version is reconciled", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        create: () => {
          throw awsError("ResourceExistsException");
        },
      }),
      awsOptions,
    );
    await expect(
      vault.put("connections/conn-1/credentials/v1", new Uint8Array([1]), {
        versionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
  });

  it("reports the AWSCURRENT version regardless of VersionIdsToStages key order", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        describe: () => ({
          VersionIdsToStages: {
            "older-version": ["AWSPREVIOUS"],
            "current-version": ["AWSCURRENT"],
          },
        }),
      }),
      awsOptions,
    );
    await expect(vault.head("connections/conn-1/credentials/v1")).resolves.toEqual({
      exists: true,
      versionId: "current-version",
    });
  });

  it("reports no version when nothing is staged AWSCURRENT (identity unconfirmable)", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        describe: () => ({ VersionIdsToStages: { "pending-version": ["AWSPENDING"] } }),
      }),
      awsOptions,
    );
    await expect(vault.head("connections/conn-1/credentials/v1")).resolves.toEqual({
      exists: true,
    });
  });
});

describe("exact-version reconciliation in the coordinator (HIGH-02)", () => {
  const versionId = "00000000-0000-4000-8000-0000000000c1";

  it("publishes when the reconciled object is the EXACT intent version", async () => {
    const vault = new FakeVault();
    vault.putBehaviour = "ambiguous";
    vault.headResult = { exists: true, versionId };
    let publishCalls = 0;
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async () => {
          publishCalls += 1;
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      new InMemoryCredentialRefreshIntentStore(),
      { uuid: () => versionId },
    );
    const ref = await coordinator.refresh({
      ...refreshBase,
      operationId: "op-match",
      acquire: acquire("v"),
    });
    expect(ref).toBe(`connections/conn-1/credentials/${versionId}`);
    expect(publishCalls).toBe(1);
  });

  it("stays AMBIGUOUS and never publishes when the reconciled version differs", async () => {
    const vault = new FakeVault();
    vault.putBehaviour = "ambiguous";
    // The object exists but under a DIFFERENT (foreign/stale) version.
    vault.headResult = { exists: true, versionId: "a-different-version" };
    let publishCalls = 0;
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async () => {
          publishCalls += 1;
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      new InMemoryCredentialRefreshIntentStore(),
      { uuid: () => versionId },
    );
    await expect(
      coordinator.refresh({ ...refreshBase, operationId: "op-mismatch", acquire: acquire("v") }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    expect(publishCalls).toBe(0);
  });

  it("reconciles an AWS ResourceExists with a MATCHING version and converges", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        create: () => {
          throw awsError("ResourceExistsException");
        },
        describe: () => ({ VersionIdsToStages: { [versionId]: ["AWSCURRENT"] } }),
      }),
      awsOptions,
    );
    let publishCalls = 0;
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async () => {
          publishCalls += 1;
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      new InMemoryCredentialRefreshIntentStore(),
      { uuid: () => versionId },
    );
    const ref = await coordinator.refresh({
      ...refreshBase,
      operationId: "op-aws-match",
      acquire: acquire("v"),
    });
    expect(ref).toBe(`connections/conn-1/credentials/${versionId}`);
    expect(publishCalls).toBe(1);
  });

  it("leaves an AWS ResourceExists with a MISMATCHED version ambiguous and unpublished", async () => {
    const vault = new AwsSecretsManagerCredentialVault(
      awsClientFor({
        create: () => {
          throw awsError("ResourceExistsException");
        },
        describe: () => ({ VersionIdsToStages: { "foreign-version": ["AWSCURRENT"] } }),
      }),
      awsOptions,
    );
    let publishCalls = 0;
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async () => {
          publishCalls += 1;
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      new InMemoryCredentialRefreshIntentStore(),
      { uuid: () => versionId },
    );
    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-aws-mismatch",
        acquire: acquire("v"),
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    expect(publishCalls).toBe(0);
  });
});

describe("operation-id identity binding (HIGH-04)", () => {
  it("never crosses a credential reference to a different connection on id reuse", async () => {
    const vault = new LocalCredentialVault();
    const store = new InMemoryCredentialRefreshIntentStore();
    const publishTargets: string[] = [];
    const ids = ["00000000-0000-4000-8000-0000000000d1", "00000000-0000-4000-8000-0000000000d2"];
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      {
        publish: async (input) => {
          publishTargets.push(input.connectionId);
          return true;
        },
        reconcile: NOT_PUBLISHED,
      },
      store,
      { uuid: () => ids.shift()! },
    );

    const first = await coordinator.refresh({
      operationId: "shared-op",
      connectionId: "conn-a",
      ownerId: "owner-1",
      provider: "gitlab",
      expectedRevision: 0n,
      acquire: acquire("token-a"),
    });
    expect(first).toBe("connections/conn-a/credentials/00000000-0000-4000-8000-0000000000d1");

    // Reusing the SAME operation id for a DIFFERENT connection must fail closed
    // before any publish, and must never publish conn-a's ref onto conn-b.
    await expect(
      coordinator.refresh({
        operationId: "shared-op",
        connectionId: "conn-b",
        ownerId: "owner-1",
        provider: "gitlab",
        expectedRevision: 0n,
        acquire: acquire("token-b"),
      }),
    ).rejects.toBeInstanceOf(CredentialRefreshIdentityError);
    expect(publishTargets).toEqual(["conn-a"]);
  });

  it.each([
    { field: "owner", ownerId: "owner-2", provider: "gitlab" as const, expectedRevision: 0n },
    { field: "provider", ownerId: "owner-1", provider: "jira" as const, expectedRevision: 0n },
    { field: "revision", ownerId: "owner-1", provider: "gitlab" as const, expectedRevision: 5n },
  ])("rejects an id reused with a different $field", async (variant) => {
    const store = new InMemoryCredentialRefreshIntentStore();
    await store.begin({
      operationId: "op-x",
      connectionId: "conn-a",
      ownerId: "owner-1",
      provider: "gitlab",
      expectedRevision: 0n,
      versionId: "00000000-0000-4000-8000-0000000000e1",
      credentialSecretRef: "connections/conn-a/credentials/00000000-0000-4000-8000-0000000000e1",
    });
    await expect(
      store.begin({
        operationId: "op-x",
        connectionId: "conn-a",
        ownerId: variant.ownerId,
        provider: variant.provider,
        expectedRevision: variant.expectedRevision,
        versionId: "00000000-0000-4000-8000-0000000000e2",
        credentialSecretRef: "connections/conn-a/credentials/00000000-0000-4000-8000-0000000000e2",
      }),
    ).rejects.toBeInstanceOf(CredentialRefreshIdentityError);
  });
});

describe("single-executor lease and fencing (HIGH-05)", () => {
  const versionId = "00000000-0000-4000-8000-0000000000f1";
  const ref = `connections/conn-1/credentials/${versionId}`;

  it("runs exactly one acquire/write/publish for parallel retries of the same operation id", async () => {
    const vault = new LocalCredentialVault();
    let acquireCalls = 0;
    const recordingAcquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("winner-token"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };
    let publishCalls = 0;
    const publisher = {
      publish: async () => {
        publishCalls += 1;
        return true;
      },
      reconcile: NOT_PUBLISHED,
    };
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => versionId,
      observerPollMs: 1,
    });

    // Two concurrent retries of the SAME operation id and identity.
    const [a, b] = await Promise.all([
      coordinator.refresh({ ...refreshBase, operationId: "op-race", acquire: recordingAcquire }),
      coordinator.refresh({ ...refreshBase, operationId: "op-race", acquire: recordingAcquire }),
    ]);

    // Exactly one executor acquired/wrote/published; the other observed the winner.
    expect(acquireCalls).toBe(1);
    expect(publishCalls).toBe(1);
    // Both callers return the winner's ref, and the winner's credential survives:
    // the loser never revoked the shared object.
    expect(a).toBe(ref);
    expect(b).toBe(ref);
    expect(vault.has(ref)).toBe(true);
  });

  it("fences out a stale executor from mutating status after takeover", async () => {
    let clock = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => clock });
    await store.begin({
      operationId: "op-fence",
      ...refreshBase,
      versionId,
      credentialSecretRef: ref,
    });
    const first = await store.acquireLease("op-fence", "holder-1", 1_000);
    expect(first.status).toBe("ACQUIRED");

    // The first holder's lease expires (store clock advances); a second executor
    // takes over.
    clock = new Date("2026-08-19T00:01:00Z");
    const second = await store.acquireLease("op-fence", "holder-2", 1_000);
    expect(second.status).toBe("ACQUIRED");

    // The stale holder is fenced out of every mutation, so it cannot corrupt the
    // status the taking-over executor now owns.
    const staleLease = (first as { lease: { holder: string; fencingToken: bigint } }).lease;
    await expect(store.markVaultWritten("op-fence", staleLease)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseLostError,
    );
    await expect(store.markPublished("op-fence", staleLease)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseLostError,
    );
    // The current holder mutates normally.
    const freshLease = (second as { lease: { holder: string; fencingToken: bigint } }).lease;
    await expect(store.markVaultWritten("op-fence", freshLease)).resolves.toBeUndefined();
  });

  it("takes over a crashed holder after the lease expires and publishes without re-acquiring", async () => {
    const vault = new LocalCredentialVault();
    let clock = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => clock });
    await store.begin({
      operationId: "op-takeover",
      ...refreshBase,
      versionId,
      credentialSecretRef: ref,
    });

    // Simulate a crashed executor that wrote the vault object and recorded the
    // lifecycle but died BEFORE publishing, leaving its lease held (not released).
    const crashed = await store.acquireLease("op-takeover", "holder-crashed", 1_000);
    const crashedLease = (crashed as { lease: { holder: string; fencingToken: bigint } }).lease;
    await store.recordLifecycle(
      "op-takeover",
      {
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      },
      crashedLease,
    );
    await vault.put(ref, new TextEncoder().encode("crashed-token"), { versionId });
    await store.markVaultWritten("op-takeover", crashedLease);

    let acquireCalls = 0;
    const acquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("should-not-run"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };
    let publishCalls = 0;
    const publisher = {
      publish: async () => {
        publishCalls += 1;
        return true;
      },
      reconcile: NOT_PUBLISHED,
    };
    // The store clock advances past the crashed lease deadline, so a recovered
    // coordinator takes over.
    clock = new Date("2026-08-19T00:05:00Z");
    const recovered = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => versionId,
      holderId: "holder-recovered",
      now: () => clock,
      renewIntervalMs: 0,
    });
    const result = await recovered.refresh({
      ...refreshBase,
      operationId: "op-takeover",
      acquire,
    });

    expect(result).toBe(ref);
    // The vault object already existed as VAULT_WRITTEN: no re-acquire, one publish.
    expect(acquireCalls).toBe(0);
    expect(publishCalls).toBe(1);
    expect(vault.has(ref)).toBe(true);
  });

  it("keeps a live foreign lease read-only: an observer never re-acquires", async () => {
    const vault = new LocalCredentialVault();
    const now = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => now });
    // A live (non-expired) lease is held by another executor.
    await store.begin({
      operationId: "op-busy",
      ...refreshBase,
      versionId,
      credentialSecretRef: ref,
    });
    await store.acquireLease("op-busy", "holder-live", 60_000);

    let acquireCalls = 0;
    const acquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("x"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };
    const observer = new CredentialRefreshCoordinator(vault, okPublisher(), store, {
      uuid: () => versionId,
      holderId: "holder-observer",
      now: () => now, // never past the live lease deadline
      observerPollMs: 1,
      observerMaxAttempts: 3,
      renewIntervalMs: 0,
    });
    // The observer cannot acquire a live lease and gives up without side effects.
    await expect(
      observer.refresh({ ...refreshBase, operationId: "op-busy", acquire }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    expect(acquireCalls).toBe(0);
    expect(vault.has(ref)).toBe(false);
  });
});

/**
 * A metadata publisher backed by an in-memory optimistic CAS with a value-free
 * `reconcile`. It can simulate a commit whose acknowledgement is lost (throw or
 * report false AFTER the revision advanced), which is the exact HIGH-07 hazard.
 */
class FakeMetadataPublisher implements CredentialMetadataPublisher {
  public revision: bigint;
  public ref: string | undefined;
  public publishCalls = 0;
  public reconcileCalls = 0;
  public throwAfterCommitOnce = false;
  public throwBeforeCommitOnce = false;
  public reconcileThrowsOnce = false;

  public constructor(startRevision = 0n, startRef?: string) {
    this.revision = startRevision;
    this.ref = startRef;
  }

  public async publish(input: {
    expectedRevision: bigint;
    credentialSecretRef: string;
  }): Promise<boolean> {
    this.publishCalls += 1;
    if (this.throwBeforeCommitOnce) {
      this.throwBeforeCommitOnce = false;
      throw new Error("publish crashed before CAS commit");
    }
    if (input.expectedRevision !== this.revision) {
      return false; // the CAS did not match the current revision
    }
    this.revision += 1n;
    this.ref = input.credentialSecretRef;
    if (this.throwAfterCommitOnce) {
      this.throwAfterCommitOnce = false;
      throw new Error("response lost after CAS commit");
    }
    return true;
  }

  public async reconcile(input: {
    expectedRevision: bigint;
    credentialSecretRef: string;
  }): Promise<"PUBLISHED_THIS" | "PUBLISHED_OTHER" | "NOT_PUBLISHED" | "UNKNOWN"> {
    this.reconcileCalls += 1;
    if (this.reconcileThrowsOnce) {
      this.reconcileThrowsOnce = false;
      throw new Error("reconcile probe unavailable");
    }
    if (this.ref === input.credentialSecretRef) return "PUBLISHED_THIS";
    if (this.revision > input.expectedRevision) return "PUBLISHED_OTHER";
    return "NOT_PUBLISHED";
  }
}

describe("ambiguous metadata CAS reconciliation (HIGH-07)", () => {
  const versionId = "00000000-0000-4000-8000-0000000000a7";
  const ref = `connections/conn-1/credentials/${versionId}`;

  it("keeps the credential when a commit-then-throw is reconciled as PUBLISHED_THIS", async () => {
    const vault = new LocalCredentialVault();
    const publisher = new FakeMetadataPublisher();
    publisher.throwAfterCommitOnce = true; // CAS commits, then the response is lost
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      publisher,
      new InMemoryCredentialRefreshIntentStore(),
      { uuid: () => versionId, renewIntervalMs: 0 },
    );

    const result = await coordinator.refresh({
      ...refreshBase,
      operationId: "op-commit-throw",
      acquire: acquire("winner"),
    });

    // The lost acknowledgement is reconciled INLINE to success: the connection
    // already points at this ref, so it is kept, never revoked.
    expect(result).toBe(ref);
    expect(publisher.revision).toBe(1n);
    expect(publisher.ref).toBe(ref);
    expect(vault.has(ref)).toBe(true);
  });

  it("reconciles a durable markPublished failure after a committed CAS on retry", async () => {
    const vault = new LocalCredentialVault();
    const publisher = new FakeMetadataPublisher();
    // The store fails to persist PUBLISHED once, AFTER the CAS already committed.
    class FailPublishOnceStore extends InMemoryCredentialRefreshIntentStore {
      public fail = true;
      public override async markPublished(operationId: string, lease: RefreshLease): Promise<void> {
        if (this.fail) {
          this.fail = false;
          throw new Error("durable markPublished write failed");
        }
        return super.markPublished(operationId, lease);
      }
    }
    const store = new FailPublishOnceStore();
    let acquireCalls = 0;
    const recordingAcquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("winner"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };
    const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => versionId,
      renewIntervalMs: 0,
    });

    // The committed CAS with a failed markPublished surfaces the store error.
    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-markpub-fail",
        acquire: recordingAcquire,
      }),
    ).rejects.toThrow("durable markPublished write failed");

    // The retry sees publish() report false (revision already advanced) and
    // reconciles to PUBLISHED_THIS instead of revoking the live credential.
    const result = await coordinator.refresh({
      ...refreshBase,
      operationId: "op-markpub-fail",
      acquire: recordingAcquire,
    });
    expect(result).toBe(ref);
    expect(acquireCalls).toBe(1); // no re-acquire on retry
    expect(publisher.revision).toBe(1n); // still exactly one commit
    expect(vault.has(ref)).toBe(true);
  });

  it("revokes only its own ref when reconciliation proves a foreign winner", async () => {
    const vault = new LocalCredentialVault();
    // A different operation already advanced the revision under a foreign ref.
    const publisher = new FakeMetadataPublisher(1n, "connections/conn-1/credentials/foreign");
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => versionId,
      renewIntervalMs: 0,
    });

    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-foreign",
        acquire: acquire("loser"),
      }),
    ).rejects.toBeInstanceOf(CredentialRefreshConflictError);

    // The loser revoked ONLY its own uniquely-keyed ref; the winner's is untouched.
    expect(vault.has(ref)).toBe(false);
    expect(publisher.ref).toBe("connections/conn-1/credentials/foreign");
  });

  it("stays AMBIGUOUS without revoking when reconciliation is unavailable", async () => {
    const vault = new LocalCredentialVault();
    const publisher = new FakeMetadataPublisher();
    publisher.throwAfterCommitOnce = true; // commit, then lose the response
    publisher.reconcileThrowsOnce = true; // and the reconcile probe is unavailable
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(vault, publisher, store, {
      uuid: () => versionId,
      renewIntervalMs: 0,
    });

    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-ambig-reconcile",
        acquire: acquire("winner"),
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);

    // The committed credential is preserved (never revoked); a later run reads the
    // recorded AMBIGUOUS outcome and refuses to auto-replay.
    expect(vault.has(ref)).toBe(true);
    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-ambig-reconcile",
        acquire: acquire("winner"),
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    expect(publisher.publishCalls).toBe(1); // never re-published
  });
});

describe("lease heartbeat and secret lifetime (HIGH-08)", () => {
  const versionId = "00000000-0000-4000-8000-0000000000a8";
  const ref = `connections/conn-1/credentials/${versionId}`;

  it("zeroizes the secret even when recordLifecycle fails after acquire", async () => {
    class LifecycleFailsStore extends InMemoryCredentialRefreshIntentStore {
      public override async recordLifecycle(): Promise<void> {
        throw new CredentialRefreshLeaseLostError();
      }
    }
    const vault = new LocalCredentialVault();
    const secret = new TextEncoder().encode("zero-me-on-failure");
    const acquireLeaked = async () => ({
      secret,
      expiresAt: new Date("2026-08-20T00:00:00Z"),
      refreshAfter: new Date("2026-08-19T23:00:00Z"),
    });
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      okPublisher(),
      new LifecycleFailsStore(),
      { uuid: () => versionId, renewIntervalMs: 0 },
    );

    await expect(
      coordinator.refresh({ ...refreshBase, operationId: "op-zeroize", acquire: acquireLeaked }),
    ).rejects.toBeInstanceOf(CredentialRefreshLeaseLostError);

    // The secret buffer was wiped despite the lifecycle/fencing failure.
    expect([...secret].every((byte) => byte === 0)).toBe(true);
  });

  it("renews the lease during a long acquire so no second executor re-acquires", async () => {
    let clock = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => clock });
    const vault = new LocalCredentialVault();

    // A manual heartbeat scheduler so the test fires renewal deterministically.
    const timers: Array<{ id: number; cb: () => void }> = [];
    let nextTimerId = 1;
    const setTimer = (cb: () => void): ReturnType<typeof setTimeout> => {
      const id = nextTimerId++;
      timers.push({ id, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
      const idx = timers.findIndex((t) => t.id === (handle as unknown as number));
      if (idx >= 0) timers.splice(idx, 1);
    };
    const fireTimers = async (): Promise<void> => {
      const pending = timers.splice(0);
      for (const timer of pending) timer.cb();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    // The OAuth acquire blocks on a gate so the lease can expire mid-operation.
    let releaseAcquire!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseAcquire = resolve;
    });
    let acquireCalls = 0;
    const acquireGated = async () => {
      acquireCalls += 1;
      await gate;
      return {
        secret: new TextEncoder().encode("winner"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };

    const request = {
      ...refreshBase,
      operationId: "op-heartbeat",
      acquire: acquireGated,
    };
    const worker = new CredentialRefreshCoordinator(vault, okPublisher(), store, {
      uuid: () => versionId,
      holderId: "worker-A",
      now: () => clock,
      leaseDurationMs: 10_000,
      renewIntervalMs: 100,
      setTimer,
      clearTimer,
    });

    // Start A; it acquires the lease (deadline 00:00:10) and blocks inside acquire().
    const workerPromise = worker.refresh(request);
    while (acquireCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    // Time advances but stays BEFORE the deadline; A's heartbeat renews the still
    // live lease, extending the deadline to 00:00:15. A heartbeat firing AFTER the
    // deadline would lose — renewal never resurrects an expired lease (HIGH-11).
    clock = new Date("2026-08-19T00:00:05Z");
    await fireTimers();

    // A second worker whose clock is now PAST the original deadline (but before the
    // renewed one) must still see a live lease and refuse to take over — no second
    // OAuth acquire.
    clock = new Date("2026-08-19T00:00:12Z");
    const peer = new CredentialRefreshCoordinator(vault, okPublisher(), store, {
      uuid: () => versionId,
      holderId: "worker-B",
      now: () => clock,
      observerPollMs: 1,
      observerMaxAttempts: 3,
      renewIntervalMs: 0,
    });
    await expect(peer.refresh(request)).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    expect(acquireCalls).toBe(1); // the peer never ran a second OAuth acquire

    // A finishes; it remains the single writer and publishes its credential.
    releaseAcquire();
    const result = await workerPromise;
    expect(result).toBe(ref);
    expect(acquireCalls).toBe(1);
    expect(vault.has(ref)).toBe(true);
  });
});

describe("mandatory value-free reconciliation (HIGH-10)", () => {
  const versionId = "00000000-0000-4000-8000-0000000000b1";
  const ref = `connections/conn-1/credentials/${versionId}`;

  // A non-conforming publisher that omits the (now mandatory) reconcile method.
  // The coordinator must fail closed to AMBIGUOUS with no revoke and no replay —
  // never the old destructive revoke/abort fallback (AUDIT-05 HIGH-10).
  function publisherWithoutReconcile(publish: () => Promise<boolean>): CredentialMetadataPublisher {
    return { publish } as unknown as CredentialMetadataPublisher;
  }

  it("stays AMBIGUOUS without revoking when publish THROWS and reconcile is absent", async () => {
    const vault = new LocalCredentialVault();
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      publisherWithoutReconcile(async () => {
        throw new Error("response lost after CAS commit");
      }),
      store,
      { uuid: () => versionId, renewIntervalMs: 0 },
    );

    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-no-recon-throw",
        acquire: acquire("v"),
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);

    // The vault object was written before publish and is NEVER revoked; a later
    // run reads the recorded AMBIGUOUS outcome and refuses to auto-replay.
    expect(vault.has(ref)).toBe(true);
    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-no-recon-throw",
        acquire: acquire("v"),
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
  });

  it("stays AMBIGUOUS without revoking when publish reports FALSE and reconcile is absent", async () => {
    const vault = new LocalCredentialVault();
    const store = new InMemoryCredentialRefreshIntentStore();
    const coordinator = new CredentialRefreshCoordinator(
      vault,
      publisherWithoutReconcile(async () => false),
      store,
      { uuid: () => versionId, renewIntervalMs: 0 },
    );

    await expect(
      coordinator.refresh({
        ...refreshBase,
        operationId: "op-no-recon-false",
        acquire: acquire("v"),
      }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    // The old destructive fallback would have revoked this ref; it must survive.
    expect(vault.has(ref)).toBe(true);
  });
});

describe("durable ACQUIRING stage and safe takeover (HIGH-11)", () => {
  const versionId = "00000000-0000-4000-8000-0000000000b8";
  const ref = `connections/conn-1/credentials/${versionId}`;

  it("does not repeat the acquire on takeover of an expired ACQUIRING intent (no vault object)", async () => {
    let clock = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => clock });
    const vault = new LocalCredentialVault();

    // A crashed executor persisted ACQUIRING under a lease but never wrote the
    // vault object (crash during/after input.acquire, before the write).
    await store.begin({
      operationId: "op-acq",
      ...refreshBase,
      versionId,
      credentialSecretRef: ref,
    });
    const crashed = await store.acquireLease("op-acq", "holder-crashed", 1_000);
    const crashedLease = (crashed as { lease: RefreshLease }).lease;
    await store.markAcquiring("op-acq", crashedLease);

    let acquireCalls = 0;
    const acquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("should-not-run"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };

    // The lease expires; a recovered coordinator takes over.
    clock = new Date("2026-08-19T00:05:00Z");
    let publishCalls = 0;
    const recovered = new CredentialRefreshCoordinator(
      vault,
      { publish: async () => (publishCalls += 1) > 0, reconcile: NOT_PUBLISHED },
      store,
      { uuid: () => versionId, holderId: "holder-recovered", now: () => clock, renewIntervalMs: 0 },
    );

    await expect(
      recovered.refresh({ ...refreshBase, operationId: "op-acq", acquire }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    // The non-idempotent OAuth acquire is NEVER repeated, and nothing is published.
    expect(acquireCalls).toBe(0);
    expect(publishCalls).toBe(0);
    expect(vault.has(ref)).toBe(false);

    // The recorded AMBIGUOUS outcome is terminal: a later run never auto-replays.
    await expect(
      recovered.refresh({ ...refreshBase, operationId: "op-acq", acquire }),
    ).rejects.toBeInstanceOf(CredentialWriteAmbiguousError);
    expect(acquireCalls).toBe(0);
  });

  it("resumes to publish on takeover of an ACQUIRING intent whose exact write survived", async () => {
    let clock = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => clock });
    const vault = new LocalCredentialVault();

    // A crashed executor wrote the EXACT version and recorded the lifecycle but
    // died in ACQUIRING before it could advance to VAULT_WRITTEN.
    await store.begin({
      operationId: "op-acq-w",
      ...refreshBase,
      versionId,
      credentialSecretRef: ref,
    });
    const crashed = await store.acquireLease("op-acq-w", "holder-crashed", 1_000);
    const crashedLease = (crashed as { lease: RefreshLease }).lease;
    await store.markAcquiring("op-acq-w", crashedLease);
    await store.recordLifecycle(
      "op-acq-w",
      {
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      },
      crashedLease,
    );
    await vault.put(ref, new TextEncoder().encode("crashed-token"), { versionId });

    let acquireCalls = 0;
    const acquire = async () => {
      acquireCalls += 1;
      return {
        secret: new TextEncoder().encode("should-not-run"),
        expiresAt: new Date("2026-08-20T00:00:00Z"),
        refreshAfter: new Date("2026-08-19T23:00:00Z"),
      };
    };

    clock = new Date("2026-08-19T00:05:00Z");
    let publishCalls = 0;
    const recovered = new CredentialRefreshCoordinator(
      vault,
      { publish: async () => (publishCalls += 1) > 0, reconcile: NOT_PUBLISHED },
      store,
      { uuid: () => versionId, holderId: "holder-recovered", now: () => clock, renewIntervalMs: 0 },
    );

    const result = await recovered.refresh({ ...refreshBase, operationId: "op-acq-w", acquire });
    // The write survived, so the takeover resumes at publish WITHOUT re-acquiring.
    expect(result).toBe(ref);
    expect(acquireCalls).toBe(0);
    expect(publishCalls).toBe(1);
    expect(vault.has(ref)).toBe(true);
  });

  it("refuses to renew an already-expired lease so a peer can take over", async () => {
    let clock = new Date("2026-08-19T00:00:00Z");
    const store = new InMemoryCredentialRefreshIntentStore({ now: () => clock });
    await store.begin({
      operationId: "op-exp",
      ...refreshBase,
      versionId,
      credentialSecretRef: ref,
    });
    const held = await store.acquireLease("op-exp", "holder-1", 1_000);
    const lease = (held as { lease: RefreshLease }).lease;

    // The lease is live: it renews.
    expect(await store.renewLease("op-exp", lease, 1_000)).toBe(true);

    // Once the deadline passes, renewal fails closed — an expired lease is never
    // resurrected (AUDIT-05 HIGH-11).
    clock = new Date("2026-08-19T00:01:00Z");
    expect(await store.renewLease("op-exp", lease, 1_000)).toBe(false);

    // The lease is free, so a peer takes over authoritatively.
    const peer = await store.acquireLease("op-exp", "holder-2", 1_000);
    expect(peer.status).toBe("ACQUIRED");
  });
});

describe("health and kill switches", () => {
  const base = {
    connectionId: "conn-1",
    provider: "jira" as const,
    health: ConnectionHealth.HEALTHY,
    expiresAt: new Date("2026-08-20T00:00:00Z"),
    now: new Date("2026-08-19T00:00:00Z"),
  };

  it.each([
    { level: "GLOBAL", provider: null, connectionId: null },
    { level: "PROVIDER", provider: "jira" as const, connectionId: null },
    { level: "CONNECTION", provider: "jira" as const, connectionId: "conn-1" },
  ] as const)("blocks effects at $level level", (killSwitch) => {
    expect(() =>
      assertConnectionEffectAllowed({
        ...base,
        killSwitches: [{ ...killSwitch, enabled: true, reason: "operator stop" }],
      }),
    ).toThrow(ConnectionBlockedError);
  });

  it.each([ConnectionHealth.REVOKED, ConnectionHealth.EXPIRED, ConnectionHealth.ERROR])(
    "fails closed for %s health",
    (health) => {
      expect(() => assertConnectionEffectAllowed({ ...base, health, killSwitches: [] })).toThrow(
        ConnectionBlockedError,
      );
    },
  );

  it("fails closed when persisted health is stale but expiry has passed", () => {
    expect(() =>
      assertConnectionEffectAllowed({
        ...base,
        now: new Date("2026-08-21T00:00:00Z"),
        killSwitches: [],
      }),
    ).toThrow("connection credential is expired");
  });
});
