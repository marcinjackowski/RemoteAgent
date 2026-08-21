/**
 * RA-023-WU-04 — a runtime session restart loses nothing, because Postgres is the
 * authority (AC6). Against a REAL PostgreSQL.
 *
 * The stop/resume cycle is SIMULATED, and that is the right call rather than a compromise.
 * ADR-0008 defers adopting AgentCore, so there is no Gateway or Runtime deployed; and what
 * AC6 actually requires proof of is that OUR state survives, not that AWS terminates a
 * microVM when it says it does. Discarding every in-memory value and re-reading from
 * Postgres is exactly what a recycled session does — the vendor docs say the microVM is
 * terminated and "memory is sanitized" — so the simulation exercises the same code path a
 * real restart would.
 *
 * What is NOT simulated is the durable side: every assertion below reads through a real
 * transaction against a real database, because that is the half where a defect would
 * actually cost something.
 */
import { CURRENT_SCHEMA_VERSION } from "@remoteagent/contracts";

// Relative import for the package-cycle reason recorded in RA-022-WU-01.
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  OwnerRepository,
} from "../../database/src/index.js";
import type { Transaction } from "../../database/src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  SessionRefusalCode,
  assertSessionCarriesNoAuthority,
  reconcileSession,
} from "../src/runtime-session.js";
import type { DurableCaseState } from "../src/runtime-session.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "RA-023-WU-04 runtime session is transport, Postgres is authority (real PostgreSQL)",
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
        `TRUNCATE case_checkpoints, case_connections, cases, connections, owners
         RESTART IDENTITY CASCADE`,
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-a", displayName: "owner-a" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-a",
        ownerId: "owner-a",
        provider: "jira",
        alias: "sondermind",
        displayName: "conn-a",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-a",
        ownerId: "owner-a",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-a"] },
        discordThreadId: "thread-a",
      });
    });

    /**
     * Read durable state the way a resuming worker must: inside a transaction, from
     * Postgres, with nothing carried over from before.
     */
    function readDurable(caseId = "case-a"): Promise<DurableCaseState> {
      return db.withTransaction(async (tx: Transaction) => {
        const result = await tx.query(
          `SELECT case_id, owner_id, checkpoint_revision FROM cases WHERE case_id = $1`,
          [caseId],
        );
        const row = (
          result as { rows: { case_id: string; owner_id: string; checkpoint_revision: number }[] }
        ).rows[0];
        if (row === undefined) throw new Error(`case ${caseId} not found`);
        return {
          caseId: row.case_id,
          ownerId: row.owner_id,
          checkpointRevision: row.checkpoint_revision,
          // This spike does not exercise the RA-009 lease table; the fence fields are
          // supplied by the caller in production. Null here means "no lease recorded",
          // which is itself an asserted case below.
          leaseOwner: null,
          fencingToken: null,
        } satisfies DurableCaseState;
      });
    }

    async function advanceRevision(caseId = "case-a"): Promise<number> {
      const from = (await readDurable(caseId)).checkpointRevision;
      const next = from + 1;
      await db.withTransaction((tx) =>
        new CheckpointRepository().append(tx, {
          caseId,
          expectedRevision: from,
          checkpoint: {
            schema_version: CURRENT_SCHEMA_VERSION,
            case_id: caseId,
            revision: next,
            goal: "work done while the session was alive",
            current_phase: "implementing",
            summary: { text: "progress", trust_level: "UNTRUSTED_DATA" },
            plan_revision: 0,
            completed_work: ["a step that must survive a restart"],
            decisions: [],
            assumptions: [],
            evidence: [],
            open_questions: [],
            next_actions: ["the step to resume with"],
            blockers: [],
            pending_approvals: [],
            workspace_state: { tree_digest: null, base_sha: null },
            branch_state: { branch_name: null, ahead: 0, behind: 0 },
            test_runs: [],
            snapshot_changes: [],
            review_findings: [],
            merge_request_state: { mr_ref: null, status: null },
            external_state_versions: [],
            last_event_id: null,
            last_run_id: null,
            updated_at: new Date().toISOString(),
          },
        }),
      );
      return next;
    }

    describe("a restart loses no case state (AC6)", () => {
      it("recovers goal, completed work and next actions from Postgres alone", () => {
        // The core AC6 claim. Work is committed, then EVERY in-memory value is dropped —
        // the variables holding the checkpoint go out of scope and the state is re-read
        // from the database, which is what a recycled microVM leaves a worker with.
        return (async () => {
          await advanceRevision();

          // Simulated restart: nothing from before this line is reused.
          const afterRestart = await db.withTransaction((tx: Transaction) =>
            new CheckpointRepository().latest(tx, "case-a"),
          );

          expect(afterRestart?.revision).toBe(1);
          expect(afterRestart?.checkpoint.goal).toBe("work done while the session was alive");
          expect(afterRestart?.checkpoint.completed_work).toEqual([
            "a step that must survive a restart",
          ]);
          expect(afterRestart?.checkpoint.next_actions).toEqual(["the step to resume with"]);
        })();
      });

      it("survives several restarts without drift", async () => {
        // Three cycles, because a single restart can pass by accident if state happens to
        // be cached. Each iteration re-reads from scratch.
        for (let expected = 1; expected <= 3; expected += 1) {
          const revision = await advanceRevision();
          expect(revision).toBe(expected);
          const durable = await readDurable();
          expect(durable.checkpointRevision).toBe(expected);
        }
      });

      it("lets a session with a matching revision resume", async () => {
        await advanceRevision();
        const durable = await readDurable();

        const result = reconcileSession(
          {
            sessionId: "sess-1",
            claimedCaseId: "case-a",
            claimedCheckpointRevision: durable.checkpointRevision,
          },
          durable,
        );

        expect(result.outcome).toBe("RESUMABLE");
        // Even on the happy path the returned state is the DURABLE one, so a caller cannot
        // propagate a session's belief by accident.
        expect(result.state).toEqual(durable);
      });
    });

    describe("a session's belief never becomes the system's belief", () => {
      it("refuses a session pointing at a DIFFERENT case", async () => {
        // Not staleness — the session is aimed at the wrong thing, and continuing would
        // apply one case's work to another. Checked first so later comparisons are never
        // made across cases.
        await new CaseRepository().insert(db, {
          caseId: "case-b",
          ownerId: "owner-a",
          status: "TRIAGED",
          integrationScope: { providers: ["jira"], connection_ids: ["conn-a"] },
          discordThreadId: "thread-b",
        });
        const durable = await readDurable("case-a");

        const result = reconcileSession({ sessionId: "sess-x", claimedCaseId: "case-b" }, durable);
        expect(result.outcome).toBe("REBUILD_REQUIRED");
        if (result.outcome !== "REBUILD_REQUIRED") throw new Error("unreachable");
        expect(result.code).toBe(SessionRefusalCode.CASE_MISMATCH);
        // The returned state is case-a's, never case-b's.
        expect(result.state.caseId).toBe("case-a");
      });

      it("refuses a session BEHIND durable state, and reports it as stale", async () => {
        // The ordinary recycled-session case: the case moved while the microVM was gone.
        await advanceRevision();
        await advanceRevision();
        const durable = await readDurable();

        const result = reconcileSession(
          { sessionId: "sess-1", claimedCaseId: "case-a", claimedCheckpointRevision: 1 },
          durable,
        );
        expect(result.outcome).toBe("REBUILD_REQUIRED");
        if (result.outcome !== "REBUILD_REQUIRED") throw new Error("unreachable");
        expect(result.code).toBe(SessionRefusalCode.STALE_REVISION);
        expect(result.state.checkpointRevision).toBe(2);
      });

      it("refuses a session AHEAD of durable state, distinctly from stale", async () => {
        // The dangerous one, and the reason the two codes are separate: a session ahead of
        // Postgres did work that was never committed. "Behind" means reload and continue;
        // "ahead" means work was lost and someone should look. A single MISMATCH code
        // would hide the second entirely.
        await advanceRevision();
        const durable = await readDurable();

        const result = reconcileSession(
          { sessionId: "sess-1", claimedCaseId: "case-a", claimedCheckpointRevision: 9 },
          durable,
        );
        expect(result.outcome).toBe("REBUILD_REQUIRED");
        if (result.outcome !== "REBUILD_REQUIRED") throw new Error("unreachable");
        expect(result.code).toBe(SessionRefusalCode.UNCOMMITTED_AHEAD);
        expect(result.reason).toMatch(/never committed/);
      });

      it("refuses a non-integer revision instead of coercing it", async () => {
        // `Number("3")` succeeding would let a string claim resume. Fail closed on an
        // uninterpretable value rather than guessing what it meant.
        const durable = await readDurable();
        for (const bogus of ["0", 1.5, null, {}, [], true, Number.NaN]) {
          const result = reconcileSession(
            {
              sessionId: "sess-1",
              claimedCaseId: "case-a",
              claimedCheckpointRevision: bogus,
            },
            durable,
          );
          expect(result.outcome, JSON.stringify(bogus)).toBe("REBUILD_REQUIRED");
        }
      });

      it("refuses a fencing token when durable state records no lease", async () => {
        // A session cannot hold what Postgres does not record. This is the single-writer
        // rule (`AGENTS.md` §7) at the session boundary.
        const durable = await readDurable();
        const result = reconcileSession(
          {
            sessionId: "sess-1",
            claimedCaseId: "case-a",
            claimedFencingToken: 7,
          },
          durable,
        );
        expect(result.outcome).toBe("REBUILD_REQUIRED");
        if (result.outcome !== "REBUILD_REQUIRED") throw new Error("unreachable");
        expect(result.code).toBe(SessionRefusalCode.NO_DURABLE_LEASE);
      });

      it("refuses a fencing token that was superseded", async () => {
        const durable = await readDurable();
        const held: DurableCaseState = { ...durable, leaseOwner: "worker-2", fencingToken: 5 };

        const result = reconcileSession(
          { sessionId: "sess-1", claimedCaseId: "case-a", claimedFencingToken: 4 },
          held,
        );
        expect(result.outcome).toBe("REBUILD_REQUIRED");
        if (result.outcome !== "REBUILD_REQUIRED") throw new Error("unreachable");
        expect(result.code).toBe(SessionRefusalCode.FENCE_LOST);
      });

      it("accepts a session that claims nothing at all", async () => {
        // A freshly-provisioned microVM carries no belief, so there is nothing to
        // contradict. Refusing it would make a cold start indistinguishable from a
        // corrupted one.
        const durable = await readDurable();
        const result = reconcileSession({ sessionId: "sess-fresh" }, durable);
        expect(result.outcome).toBe("RESUMABLE");
        expect(result.state).toEqual(durable);
      });
    });

    describe("assertSessionCarriesNoAuthority is a second statement of the rule", () => {
      it("passes for every reconciliation this suite produces", async () => {
        await advanceRevision();
        const durable = await readDurable();

        for (const claim of [
          { sessionId: "s1" },
          { sessionId: "s2", claimedCaseId: "case-a", claimedCheckpointRevision: 1 },
          { sessionId: "s3", claimedCaseId: "other", claimedCheckpointRevision: 99 },
        ]) {
          const result = reconcileSession(claim, durable);
          expect(() => assertSessionCarriesNoAuthority(result, durable)).not.toThrow();
        }
      });

      it("catches a result whose state diverges from durable state", async () => {
        // Hand-built rather than routed through `reconcileSession`, because the point is to
        // test the ASSERTION. Routed through the real function it would only ever see
        // correct input and would pass with its body deleted.
        const durable = await readDurable();
        const forged = { ...durable, checkpointRevision: durable.checkpointRevision + 1 };

        expect(() =>
          assertSessionCarriesNoAuthority({ outcome: "RESUMABLE", state: forged }, durable),
        ).toThrow(/AC6 violation.*revision/);

        expect(() =>
          assertSessionCarriesNoAuthority(
            { outcome: "RESUMABLE", state: { ...durable, ownerId: "owner-b" } },
            durable,
          ),
        ).toThrow(/AC6 violation.*owner/);

        expect(() =>
          assertSessionCarriesNoAuthority(
            { outcome: "RESUMABLE", state: { ...durable, caseId: "case-z" } },
            durable,
          ),
        ).toThrow(/AC6 violation.*case/);

        expect(() =>
          assertSessionCarriesNoAuthority(
            { outcome: "RESUMABLE", state: { ...durable, fencingToken: 3 } },
            durable,
          ),
        ).toThrow(/AC6 violation.*fencing token/);
      });
    });
  },
  available,
);
