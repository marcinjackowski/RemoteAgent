/**
 * WU-03 — the durable tool-call ledger, against a REAL PostgreSQL (no SQL mock).
 *
 * Four things are proven by observing behaviour rather than by reading the
 * implementation:
 *
 *   1. AC6: every recorded call carries intent, validated-arguments digest, result
 *      digest, latency and trace — and the row is committed BEFORE dispatch, seen
 *      from a separate pooled connection;
 *   2. AC5: a dispatched call with no receipt resolves to `AMBIGUOUS`, and is still
 *      `AMBIGUOUS` when read through a brand-new repository over a brand-new pool
 *      (the restart case). `SUCCEEDED` without a result digest is rejected by the
 *      database itself, not merely by application code;
 *   3. scope isolation: a foreign case/owner can neither read nor settle a row, and
 *      a cross-owner row cannot be inserted at all;
 *   4. migration 028 is reversible.
 *
 * The database-level assertions matter more than they look. A CHECK constraint that
 * makes an unsafe state unrepresentable holds regardless of what this package's code
 * does next year; an `if` in TypeScript holds only until someone edits it.
 */
import {
  CaseRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
  migrateDown,
  migrateUp,
  resolvePoolConfig,
} from "@remoteagent/database";
import { RiskTier } from "@remoteagent/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";
import { McpAmbiguityReason, RefusalCode, ToolCallOutcome } from "../src/contracts.js";
import {
  ToolCallLedgerError,
  ToolCallLedgerRepository,
  ToolCallScopeError,
  ToolCallStatus,
  digestOf,
} from "../src/ledger.js";
import type { DispatchInput, ToolCallScope } from "../src/ledger.js";

const available = await ensurePostgres();

const digest = (byte: string): string => `sha256:${byte.repeat(64)}`;
const ARGS_DIGEST = digest("a");
const RESULT_DIGEST = digest("b");

const scopeA: ToolCallScope = { caseId: "case-a", ownerId: "owner-a" };
const scopeB: ToolCallScope = { caseId: "case-b", ownerId: "owner-b" };

describeIntegration(
  "brokered tool-call ledger (real PostgreSQL)",
  () => {
    let db: Database;
    let dbName: string;
    let drop: () => Promise<void>;
    let ledger: ToolCallLedgerRepository;

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dbName = created.name;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      ledger = new ToolCallLedgerRepository();
      await db.query(
        "TRUNCATE mcp_tool_calls, case_connections, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      const owners = new OwnerRepository();
      const connections = new ConnectionRepository();
      const cases = new CaseRepository();
      for (const [owner, connection, caseId] of [
        ["owner-a", "conn-a", "case-a"],
        ["owner-b", "conn-b", "case-b"],
      ] as const) {
        await owners.insert(db, { ownerId: owner, displayName: owner });
        await connections.insert(db, {
          connectionId: connection,
          ownerId: owner,
          provider: "jira",
          alias: "sondermind",
          displayName: connection,
        });
        await cases.insert(db, {
          caseId,
          ownerId: owner,
          status: "TRIAGED",
          integrationScope: { providers: ["jira"], connection_ids: [connection] },
          discordThreadId: `thread-${caseId}`,
        });
      }
    });

    function dispatch(callId: string, scope: ToolCallScope = scopeA): DispatchInput {
      return {
        callId,
        intentId: `intent-${callId}`,
        scope,
        role: "PLANNER",
        toolName: "jira.read_issue",
        toolVersion: 1,
        provider: "jira",
        riskTier: RiskTier.R0,
        validatedArgumentsDigest: ARGS_DIGEST,
        correlationId: `corr-${callId}`,
        traceId: `trace-${callId}`,
      };
    }

    describe("AC6: every call carries its full provenance", () => {
      it("records intent, digest, correlation and trace before dispatch", async () => {
        const record = await ledger.recordDispatch(db, dispatch("call-1"));
        expect(record).toMatchObject({
          intentId: "intent-call-1",
          status: ToolCallStatus.DISPATCHED,
          validatedArgumentsDigest: ARGS_DIGEST,
          correlationId: "corr-call-1",
          traceId: "trace-call-1",
          requiresReconciliation: true,
        });
      });

      it("commits the dispatch row BEFORE the request would be sent", async () => {
        // Read through a SEPARATE pooled connection inside a transaction that has
        // not committed: the row must be invisible there, and visible after commit.
        // This is what makes "recorded before dispatch" a fact rather than an
        // ordering claim in a comment.
        await db.withTransaction(async (tx) => {
          await ledger.recordDispatch(tx, dispatch("call-precommit"));
          const seenElsewhere = await ledger.find(db, "call-precommit", scopeA);
          expect(seenElsewhere).toBeNull();
        });
        const seenAfter = await ledger.find(db, "call-precommit", scopeA);
        expect(seenAfter?.status).toBe(ToolCallStatus.DISPATCHED);
      });

      it("records latency and result digest on settle", async () => {
        await ledger.recordDispatch(db, dispatch("call-2"));
        const settled = await ledger.settle(db, "call-2", scopeA, {
          outcome: ToolCallOutcome.SUCCEEDED,
          resultDigest: RESULT_DIGEST,
          latencyMs: 42,
        });
        expect(settled).toBe(true);
        expect(await ledger.find(db, "call-2", scopeA)).toMatchObject({
          status: ToolCallStatus.SUCCEEDED,
          resultDigest: RESULT_DIGEST,
          latencyMs: 42,
          requiresReconciliation: false,
        });
      });

      it("records a refusal as a terminal row with its own code", async () => {
        // A refusal that only appeared in a log would be invisible to the audit
        // question "did the model attempt a cross-scope call".
        const record = await ledger.recordRefusal(db, {
          ...dispatch("call-refused"),
          refusalCode: RefusalCode.SCOPE_IN_ARGUMENTS,
        });
        expect(record).toMatchObject({
          status: ToolCallStatus.REFUSED,
          refusalCode: RefusalCode.SCOPE_IN_ARGUMENTS,
          resultDigest: null,
          requiresReconciliation: false,
        });
      });

      it("computes a stable digest independent of key ordering", async () => {
        expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
        expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
      });

      it("refuses to dispatch the same call_id twice", async () => {
        await ledger.recordDispatch(db, dispatch("call-dup"));
        await expect(ledger.recordDispatch(db, dispatch("call-dup"))).rejects.toThrow(
          /already recorded/,
        );
      });
    });

    describe("AC5: no receipt means AMBIGUOUS, never a false success", () => {
      it("resolves an unreported dispatch to AMBIGUOUS with a reason", async () => {
        await ledger.recordDispatch(db, dispatch("call-crash"));
        const resolved = await ledger.reconcileUnresolved(db, scopeA);
        expect(resolved).toBe(1);
        expect(await ledger.find(db, "call-crash", scopeA)).toMatchObject({
          status: ToolCallStatus.AMBIGUOUS,
          ambiguityReason: McpAmbiguityReason.NO_RECEIPT,
          resultDigest: null,
          requiresReconciliation: true,
        });
      });

      it("still reads AMBIGUOUS through a new repository over a NEW pool", async () => {
        // The restart case. A conclusion that only holds inside the process that
        // reached it is not durable state.
        await ledger.recordDispatch(db, dispatch("call-restart"));
        await ledger.reconcileUnresolved(db, scopeA, McpAmbiguityReason.TIMEOUT_AFTER_DISPATCH);

        const reopened = new Database({ ...resolvePoolConfig(), database: dbName });
        try {
          const fresh = new ToolCallLedgerRepository();
          expect(await fresh.find(reopened, "call-restart", scopeA)).toMatchObject({
            status: ToolCallStatus.AMBIGUOUS,
            ambiguityReason: McpAmbiguityReason.TIMEOUT_AFTER_DISPATCH,
          });
        } finally {
          await reopened.close();
        }
      });

      it("rejects SUCCEEDED without a result digest AT THE DATABASE", async () => {
        // The load-bearing assertion of this suite. Application code could be
        // edited to allow this; the CHECK constraint cannot be edited by accident.
        await ledger.recordDispatch(db, dispatch("call-nodigest"));
        await expect(
          db.query(
            `UPDATE mcp_tool_calls SET status = 'SUCCEEDED', settled_at = now()
              WHERE call_id = 'call-nodigest'`,
          ),
        ).rejects.toThrow(/mcp_tool_calls_succeeded_digest_chk/);
      });

      it("rejects AMBIGUOUS without a reason at the database", async () => {
        await ledger.recordDispatch(db, dispatch("call-noreason"));
        await expect(
          db.query(
            `UPDATE mcp_tool_calls SET status = 'AMBIGUOUS', settled_at = now()
              WHERE call_id = 'call-noreason'`,
          ),
        ).rejects.toThrow(/mcp_tool_calls_ambiguous_chk/);
      });

      it("rejects a REFUSED row carrying a result digest at the database", async () => {
        await expect(
          db.query(
            `INSERT INTO mcp_tool_calls
               (call_id, intent_id, case_id, owner_id, role, tool_name, tool_version,
                provider, risk_tier, status, refusal_code, validated_arguments_digest,
                result_digest, latency_ms, correlation_id, trace_id, settled_at)
             VALUES ('call-bad', 'i', 'case-a', 'owner-a', 'PLANNER', 't', 1, 'jira', 'R0',
                     'REFUSED', 'OUT_OF_SCOPE', $1, $2, 0, 'c', 'tr', now())`,
            [ARGS_DIGEST, RESULT_DIGEST],
          ),
        ).rejects.toThrow(/mcp_tool_calls_refused_no_result_chk/);
      });

      it("does not let a straggler overwrite a resolved AMBIGUOUS", async () => {
        // The scenario: a reconciliation pass resolved the call, then the original
        // request's response finally arrives. Upgrading to SUCCEEDED here would
        // turn an unresolved read into a confident one after the fact.
        await ledger.recordDispatch(db, dispatch("call-late"));
        await ledger.reconcileUnresolved(db, scopeA);
        const late = await ledger.settle(db, "call-late", scopeA, {
          outcome: ToolCallOutcome.SUCCEEDED,
          resultDigest: RESULT_DIGEST,
          latencyMs: 10,
        });
        expect(late).toBe(false);
        expect(await ledger.find(db, "call-late", scopeA)).toMatchObject({
          status: ToolCallStatus.AMBIGUOUS,
          resultDigest: null,
        });
      });

      it("settles a dispatched call at most once", async () => {
        await ledger.recordDispatch(db, dispatch("call-once"));
        expect(
          await ledger.settle(db, "call-once", scopeA, {
            outcome: ToolCallOutcome.FAILED,
            latencyMs: 5,
          }),
        ).toBe(true);
        expect(
          await ledger.settle(db, "call-once", scopeA, {
            outcome: ToolCallOutcome.SUCCEEDED,
            resultDigest: RESULT_DIGEST,
            latencyMs: 5,
          }),
        ).toBe(false);
        expect((await ledger.find(db, "call-once", scopeA))?.status).toBe(ToolCallStatus.FAILED);
      });

      it("lists unresolved calls as the reconciliation queue", async () => {
        await ledger.recordDispatch(db, dispatch("call-open-1"));
        await ledger.recordDispatch(db, dispatch("call-open-2"));
        await ledger.recordDispatch(db, dispatch("call-closed"));
        await ledger.settle(db, "call-closed", scopeA, {
          outcome: ToolCallOutcome.SUCCEEDED,
          resultDigest: RESULT_DIGEST,
          latencyMs: 1,
        });
        const unresolved = await ledger.listUnresolved(db, scopeA);
        expect(unresolved.map((row) => row.callId)).toEqual(["call-open-1", "call-open-2"]);
      });

      it("rejects a receipt shape that claims success with no digest", async () => {
        await ledger.recordDispatch(db, dispatch("call-shape"));
        await expect(
          ledger.settle(db, "call-shape", scopeA, {
            outcome: ToolCallOutcome.SUCCEEDED,
            latencyMs: 1,
          } as never),
        ).rejects.toThrow(ToolCallLedgerError);
      });
    });

    describe("scope isolation", () => {
      it("returns null for a call in another scope, and throws on a foreign id", async () => {
        await ledger.recordDispatch(db, dispatch("call-a-only", scopeA));
        // A quiet null for a foreign id would read as "unused, safe to dispatch",
        // which is how one case would re-run another's call under its own scope.
        await expect(ledger.find(db, "call-a-only", scopeB)).rejects.toThrow(ToolCallScopeError);
        expect(await ledger.find(db, "call-never-existed", scopeB)).toBeNull();
      });

      it("cannot settle another scope's call", async () => {
        await ledger.recordDispatch(db, dispatch("call-fenced", scopeA));
        expect(
          await ledger.settle(db, "call-fenced", scopeB, {
            outcome: ToolCallOutcome.SUCCEEDED,
            resultDigest: RESULT_DIGEST,
            latencyMs: 1,
          }),
        ).toBe(false);
        expect((await ledger.find(db, "call-fenced", scopeA))?.status).toBe(
          ToolCallStatus.DISPATCHED,
        );
      });

      it("does not reconcile another scope's unresolved calls", async () => {
        await ledger.recordDispatch(db, dispatch("call-scope-a", scopeA));
        await ledger.recordDispatch(db, dispatch("call-scope-b", scopeB));
        expect(await ledger.reconcileUnresolved(db, scopeB)).toBe(1);
        expect((await ledger.find(db, "call-scope-a", scopeA))?.status).toBe(
          ToolCallStatus.DISPATCHED,
        );
      });

      it("cannot insert a row pairing a case with the wrong owner", async () => {
        // The composite FK to cases (case_id, owner_id) makes a cross-owner row
        // impossible, not merely unlikely.
        await expect(
          ledger.recordDispatch(
            db,
            dispatch("call-forged", { caseId: "case-a", ownerId: "owner-b" }),
          ),
        ).rejects.toThrow(/mcp_tool_calls_case_owner_fk|violates foreign key/);
      });
    });

    describe("provider health window feeds the breaker", () => {
      it("reports recent outcomes per provider across cases", async () => {
        // Deliberately NOT case-scoped: a breaker that only saw one case's calls
        // would keep hammering a failing provider once per case.
        await ledger.recordDispatch(db, dispatch("call-h1", scopeA));
        await ledger.settle(db, "call-h1", scopeA, {
          outcome: ToolCallOutcome.FAILED,
          latencyMs: 1,
        });
        await ledger.recordDispatch(db, dispatch("call-h2", scopeB));
        await ledger.settle(db, "call-h2", scopeB, {
          outcome: ToolCallOutcome.FAILED,
          latencyMs: 1,
        });
        const recent = await ledger.recentByProvider(db, "jira", 60_000);
        expect(recent).toHaveLength(2);
        expect(recent.every((row) => row.status === ToolCallStatus.FAILED)).toBe(true);
        expect(await ledger.recentByProvider(db, "gitlab", 60_000)).toEqual([]);
      });
    });

    describe("migration 028 is reversible", () => {
      it("drops and re-applies cleanly", async () => {
        const target = new Database({ ...resolvePoolConfig(), database: dbName });
        try {
          await migrateDown(target, { to: 27 });
          const gone = await target.query<{ exists: boolean }>(
            "SELECT to_regclass('public.mcp_tool_calls') IS NOT NULL AS exists",
          );
          expect(gone.rows[0]?.exists).toBe(false);
          await migrateUp(target);
          const back = await target.query<{ exists: boolean }>(
            "SELECT to_regclass('public.mcp_tool_calls') IS NOT NULL AS exists",
          );
          expect(back.rows[0]?.exists).toBe(true);
        } finally {
          await target.close();
        }
      });
    });
  },
  available,
);
