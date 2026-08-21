/**
 * Integration tests for the durable operation intent ledger, against a REAL
 * PostgreSQL (no SQL mock).
 *
 * Three things are proven here, each by observing behaviour rather than by
 * inspecting the implementation:
 *
 *   1. exactly-once across concurrent callers. The effect increments a call
 *      counter and sleeps, so the race window is real; the load-bearing assertion
 *      is on the COUNTER, not on a returned disposition;
 *   2. an operation without a receipt is durably AMBIGUOUS, and still is when read
 *      through a brand-new repository AND a brand-new connection pool over the same
 *      database (the "restart" case);
 *   3. scope isolation: a foreign case/workspace can neither read nor settle a row,
 *      and reusing a foreign `operation_id` is rejected instead of executing again.
 *
 * A fourth suite drives migration 027 down and back up to prove it is reversible.
 */
import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  WorkspaceRepository,
  migrateDown,
  migrateUp,
  resolvePoolConfig,
} from "@remoteagent/database";
import type { Transaction } from "@remoteagent/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import {
  AmbiguityReason,
  ClaimDisposition,
  OperationLedgerRepository,
  OperationScopeError,
  OperationStatus,
  ToolKind,
  ToolOutcome,
  runExactlyOnce,
} from "../src/index.js";
import type { ToolIdentity } from "../src/index.js";

const available = await ensurePostgres();

const digest = (byte: string): string => `sha256:${byte.repeat(64)}`;
const DIGEST_A = digest("a");
const DIGEST_B = digest("b");

/**
 * A stand-in for "another process": a second {@link Database} over the SAME test
 * database, sharing no in-memory state with the first — only PostgreSQL. Mirrors
 * the harness's own config resolution so it follows whatever the environment
 * selected (connection string or discrete variables).
 */
function peerDatabase(databaseName: string): Database {
  const base = resolvePoolConfig();
  if ("connectionString" in base && base.connectionString !== undefined) {
    const url = new URL(base.connectionString);
    url.pathname = `/${databaseName}`;
    return new Database({ connectionString: url.toString() });
  }
  return new Database({ ...base, database: databaseName });
}

/** A successful receipt with a real delay, so the concurrency window is genuine. */
function delayedSuccess() {
  return vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      outcome: ToolOutcome.SUCCEEDED,
      afterDigest: DIGEST_B,
      changedFiles: ["src/app.ts"],
    } as const;
  });
}

describeIntegration(
  "implementation-tool operation ledger",
  () => {
    let db: Database;
    let databaseName: string;
    let drop: () => Promise<void>;
    let ledger: OperationLedgerRepository;

    const scopeA: ToolIdentity = { case_id: "case-a", workspace_id: "ws-a" };
    const scopeB: ToolIdentity = { case_id: "case-b", workspace_id: "ws-b" };

    const inTx = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => db.withTransaction(fn);

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      databaseName = created.name;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      ledger = new OperationLedgerRepository();
      await db.query(
        "TRUNCATE implementation_tool_operations, workspaces, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      const owners = new OwnerRepository();
      const connections = new ConnectionRepository();
      const cases = new CaseRepository();
      const workspaces = new WorkspaceRepository();
      for (const [owner, connection, caseId, workspaceId] of [
        ["owner-a", "conn-a", scopeA.case_id, scopeA.workspace_id],
        ["owner-b", "conn-b", scopeB.case_id, scopeB.workspace_id],
      ] as const) {
        await owners.insert(db, { ownerId: owner, displayName: owner });
        await connections.insert(db, {
          connectionId: connection,
          ownerId: owner,
          provider: "gitlab",
          alias: "private",
          displayName: connection,
        });
        await cases.insert(db, {
          caseId,
          ownerId: owner,
          status: "IMPLEMENTING",
          integrationScope: { providers: ["gitlab"], connection_ids: [connection] },
          discordThreadId: `thread-${caseId}`,
        });
        await workspaces.recordIntent(db, {
          workspaceId,
          caseId,
          repo: "git@example.com:acme/repo.git",
          baseSha: "0".repeat(40),
          branchName: `ra/${caseId}`,
        });
      }
    });

    const claim = (operationId: string, identity: ToolIdentity = scopeA) => ({
      operationId,
      identity,
      kind: ToolKind.APPLY_PATCH,
      beforeDigest: DIGEST_A,
      changedFiles: ["src/app.ts"],
    });

    describe("criterion 1: intent before the side effect, exactly-once cross-process", () => {
      it("commits the intent BEFORE the effect runs", async () => {
        const observed: (string | null)[] = [];
        await runExactlyOnce(inTx, ledger, claim("op-order"), async () => {
          // A SEPARATE pooled connection: it can only see the claim if the claim's
          // transaction has already committed.
          const seen = await ledger.find(db, "op-order", scopeA);
          observed.push(seen?.status ?? null);
          return {
            outcome: ToolOutcome.SUCCEEDED,
            afterDigest: DIGEST_B,
            changedFiles: ["src/app.ts"],
          };
        });
        expect(observed).toEqual([OperationStatus.INTENT_RECORDED]);
      });

      it.each([2, 5, 12])(
        "runs the effect exactly once for %i concurrent callers of one operation_id",
        async (concurrency) => {
          const effect = delayedSuccess();
          const operationId = `op-concurrent-${String(concurrency)}`;

          const results = await Promise.all(
            Array.from({ length: concurrency }, () =>
              runExactlyOnce(inTx, ledger, claim(operationId), effect),
            ),
          );

          // The load-bearing assertion: the EFFECT ran once, counted in the effect.
          expect(effect).toHaveBeenCalledTimes(1);
          expect(results.filter((result) => result.executed)).toHaveLength(1);
          expect(results.filter((result) => !result.executed)).toHaveLength(concurrency - 1);

          const rows = await db.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM implementation_tool_operations WHERE operation_id = $1",
            [operationId],
          );
          expect(rows.rows[0]?.count).toBe("1");
        },
      );

      it("grants CLAIMED to exactly one of many concurrent claims", async () => {
        const attempts = await Promise.all(
          Array.from({ length: 8 }, () => inTx(async (tx) => ledger.claim(tx, claim("op-single")))),
        );
        const winners = attempts.filter(
          (attempt) => attempt.disposition === ClaimDisposition.CLAIMED,
        );
        expect(winners).toHaveLength(1);
        expect(
          attempts.filter((a) => a.disposition === ClaimDisposition.ALREADY_CLAIMED),
        ).toHaveLength(7);
      });

      it("does not re-run the effect for a replay after the operation settled", async () => {
        const effect = delayedSuccess();
        const first = await runExactlyOnce(inTx, ledger, claim("op-replay"), effect);
        const second = await runExactlyOnce(inTx, ledger, claim("op-replay"), effect);

        expect(effect).toHaveBeenCalledTimes(1);
        expect(first.executed).toBe(true);
        expect(second.executed).toBe(false);
        expect(second.record.status).toBe(OperationStatus.SUCCEEDED);
        expect(second.record.afterDigest).toBe(DIGEST_B);
      });

      it("survives a fresh pool: another process may not re-run a claimed effect", async () => {
        const effect = delayedSuccess();
        await runExactlyOnce(inTx, ledger, claim("op-cross-process"), effect);

        const peer = peerDatabase(databaseName);
        try {
          const outcome = await runExactlyOnce(
            (fn) => peer.withTransaction(fn),
            new OperationLedgerRepository(),
            claim("op-cross-process"),
            effect,
          );
          expect(outcome.executed).toBe(false);
          expect(effect).toHaveBeenCalledTimes(1);
        } finally {
          await peer.close();
        }
      });

      it("rejects a SUCCEEDED row with no verified post-state at the database level", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-no-digest")));
        await expect(
          db.query(
            "UPDATE implementation_tool_operations SET status = 'SUCCEEDED', settled_at = now() WHERE operation_id = $1",
            ["op-no-digest"],
          ),
        ).rejects.toThrow(/implementation_tool_operations_succeeded_digest_chk/);
      });
    });

    describe("criterion 2: no receipt means a durable AMBIGUOUS, never SUCCEEDED", () => {
      it("leaves an interrupted operation unsettled and requiring reconciliation", async () => {
        // Claim, then "crash": never settle.
        await inTx(async (tx) => ledger.claim(tx, claim("op-interrupted")));

        const record = await ledger.find(db, "op-interrupted", scopeA);
        expect(record?.status).toBe(OperationStatus.INTENT_RECORDED);
        expect(record?.requiresReconciliation).toBe(true);
        expect(record?.afterDigest).toBeNull();
      });

      it("resolves an abandoned claim to AMBIGUOUS that persists across a restart", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-abandoned")));
        const resolved = await inTx(async (tx) =>
          ledger.markAbandonedAmbiguous(tx, "op-abandoned", scopeA, AmbiguityReason.INTERRUPTED),
        );
        expect(resolved).toBe(true);

        // "Restart": a brand-new repository instance AND a brand-new pool.
        const peer = peerDatabase(databaseName);
        try {
          const record = await new OperationLedgerRepository().find(peer, "op-abandoned", scopeA);
          expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
          expect(record?.ambiguityReason).toBe(AmbiguityReason.INTERRUPTED);
          expect(record?.requiresReconciliation).toBe(true);
          expect(record?.afterDigest).toBeNull();
        } finally {
          await peer.close();
        }
      });

      it("settles a throwing effect as AMBIGUOUS rather than leaving it dangling", async () => {
        const outcome = await runExactlyOnce(inTx, ledger, claim("op-throws"), async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("patch applied partially");
        });
        expect(outcome.record.status).toBe(OperationStatus.AMBIGUOUS);
        expect(outcome.record.ambiguityReason).toBe(AmbiguityReason.PARTIAL_WRITE);
        expect(outcome.record.requiresReconciliation).toBe(true);
      });

      it("cannot upgrade a settled AMBIGUOUS to SUCCEEDED", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-no-upgrade")));
        await inTx(async (tx) => ledger.markAbandonedAmbiguous(tx, "op-no-upgrade", scopeA));

        const upgraded = await inTx(async (tx) =>
          ledger.settle(tx, "op-no-upgrade", scopeA, {
            outcome: ToolOutcome.SUCCEEDED,
            afterDigest: DIGEST_B,
            changedFiles: ["src/app.ts"],
          }),
        );
        expect(upgraded).toBe(false);
        const record = await ledger.find(db, "op-no-upgrade", scopeA);
        expect(record?.status).toBe(OperationStatus.AMBIGUOUS);
      });

      it("records a clean FAILED with no changed files, distinct from AMBIGUOUS", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-failed")));
        const settled = await inTx(async (tx) =>
          ledger.settle(tx, "op-failed", scopeA, {
            outcome: ToolOutcome.FAILED,
            failureCode: "PATH_DENIED",
          }),
        );
        expect(settled).toBe(true);
        const record = await ledger.find(db, "op-failed", scopeA);
        expect(record?.status).toBe(OperationStatus.FAILED);
        expect(record?.failureCode).toBe("PATH_DENIED");
        expect(record?.changedFiles).toEqual([]);
        expect(record?.requiresReconciliation).toBe(false);
      });

      it("lists unsettled claims and AMBIGUOUS rows as the reconciliation work list", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-pending")));
        await inTx(async (tx) => ledger.claim(tx, claim("op-ambiguous")));
        await inTx(async (tx) => ledger.markAbandonedAmbiguous(tx, "op-ambiguous", scopeA));
        await inTx(async (tx) => ledger.claim(tx, claim("op-done")));
        await inTx(async (tx) =>
          ledger.settle(tx, "op-done", scopeA, {
            outcome: ToolOutcome.SUCCEEDED,
            afterDigest: DIGEST_B,
            changedFiles: [],
          }),
        );

        const pending = await ledger.listRequiringReconciliation(db, scopeA);
        expect(pending.map((record) => record.operationId).sort()).toEqual([
          "op-ambiguous",
          "op-pending",
        ]);
      });
    });

    describe("criterion 3: scope isolation by case_id / workspace_id", () => {
      it("returns null only for an operation_id that exists in no scope at all", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-scoped-a")));
        expect(await ledger.find(db, "op-never-used", scopeA)).toBeNull();
        expect(await ledger.find(db, "op-never-used", scopeB)).toBeNull();
      });

      it("rejects a partially-matching scope (right case, wrong workspace)", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-scoped-partial")));
        // `operation_id` is globally unique, so a scope that does not own the row
        // must be REJECTED rather than told `null` — a `null` here would read as
        // "unused, safe to execute" and would produce a second execution.
        await expect(
          ledger.find(db, "op-scoped-partial", {
            case_id: scopeA.case_id,
            workspace_id: scopeB.workspace_id,
          }),
        ).rejects.toBeInstanceOf(OperationScopeError);
      });

      it("scopes the raw row to its own case/workspace only", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-scoped-row")));
        // The scope fence in SQL, independent of the repository's rejection logic:
        // a foreign scope predicate matches zero rows.
        const foreign = await db.query(
          "SELECT operation_id FROM implementation_tool_operations WHERE operation_id = $1 AND case_id = $2 AND workspace_id = $3",
          ["op-scoped-row", scopeB.case_id, scopeB.workspace_id],
        );
        expect(foreign.rowCount).toBe(0);
        const own = await db.query(
          "SELECT operation_id FROM implementation_tool_operations WHERE operation_id = $1 AND case_id = $2 AND workspace_id = $3",
          ["op-scoped-row", scopeA.case_id, scopeA.workspace_id],
        );
        expect(own.rowCount).toBe(1);
      });

      it("rejects a foreign scope reading another case's operation instead of sharing it", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-foreign-read")));
        await expect(ledger.find(db, "op-foreign-read", scopeB)).rejects.toBeInstanceOf(
          OperationScopeError,
        );
      });

      it("rejects reuse of a foreign operation_id rather than executing a second time", async () => {
        const effect = delayedSuccess();
        await runExactlyOnce(inTx, ledger, claim("op-shared-id", scopeA), effect);

        // `operation_id` is globally unique, so scope B addressing A's id must be
        // rejected outright: a silent second execution is the failure mode.
        await expect(
          runExactlyOnce(inTx, ledger, claim("op-shared-id", scopeB), effect),
        ).rejects.toBeInstanceOf(OperationScopeError);
        expect(effect).toHaveBeenCalledTimes(1);
      });

      it("cannot settle another scope's operation", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-foreign-settle")));
        const settled = await inTx(async (tx) =>
          ledger.settle(tx, "op-foreign-settle", scopeB, {
            outcome: ToolOutcome.SUCCEEDED,
            afterDigest: DIGEST_B,
            changedFiles: [],
          }),
        );
        expect(settled).toBe(false);
        const record = await ledger.find(db, "op-foreign-settle", scopeA);
        expect(record?.status).toBe(OperationStatus.INTENT_RECORDED);
      });

      it("keeps each scope's reconciliation list separate", async () => {
        await inTx(async (tx) => ledger.claim(tx, claim("op-list-a", scopeA)));
        await inTx(async (tx) => ledger.claim(tx, claim("op-list-b", scopeB)));

        const listA = await ledger.listRequiringReconciliation(db, scopeA);
        const listB = await ledger.listRequiringReconciliation(db, scopeB);
        expect(listA.map((record) => record.operationId)).toEqual(["op-list-a"]);
        expect(listB.map((record) => record.operationId)).toEqual(["op-list-b"]);
      });

      it("rejects a workspace that belongs to a different case at the database level", async () => {
        // The composite FK pins (workspace_id, case_id): a forged pair cannot exist.
        await expect(
          inTx(async (tx) =>
            ledger.claim(
              tx,
              claim("op-forged-scope", {
                case_id: scopeA.case_id,
                workspace_id: scopeB.workspace_id,
              }),
            ),
          ),
        ).rejects.toThrow(/implementation_tool_operations_workspace_case_fk/);
      });
    });
  },
  available,
);

describeIntegration(
  "migration 027 reversibility",
  () => {
    it("reverts 027 and re-applies it on an isolated database", async () => {
      const created = await createTestDatabase();
      try {
        const tableExists = async (): Promise<boolean> => {
          const result = await created.db.query<{ present: boolean }>(
            "SELECT to_regclass('implementation_tool_operations') IS NOT NULL AS present",
          );
          return result.rows[0]?.present === true;
        };
        const constraintExists = async (): Promise<boolean> => {
          const result = await created.db.query<{ present: boolean }>(
            "SELECT count(*) > 0 AS present FROM pg_constraint WHERE conname = 'workspaces_id_case_key'",
          );
          return result.rows[0]?.present === true;
        };

        expect(await tableExists()).toBe(true);
        expect(await constraintExists()).toBe(true);

        // Migrating down to 26 necessarily reverts EVERY migration above 26, so
        // this asserts that 027 was among them rather than that it was the only
        // one. Exact list equality made the test a tripwire on the migration
        // counter: adding migration 028 (RA-021) broke it while 027's
        // reversibility — the thing under test — was unaffected.
        const down = await migrateDown(created.db, { to: 26 });
        expect(down.reverted).toContain(27);
        // Both objects 027 created are gone: the revert is complete, not partial.
        expect(await tableExists()).toBe(false);
        expect(await constraintExists()).toBe(false);

        const up = await migrateUp(created.db);
        expect(up.applied).toContain(27);
        expect(await tableExists()).toBe(true);
        expect(await constraintExists()).toBe(true);
      } finally {
        await created.drop();
      }
    });
  },
  available,
);
