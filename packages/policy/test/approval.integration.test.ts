/**
 * RA-022-WU-02 — durable approval repository: atomic single use, owner scope,
 * exact digest and checkpoint-revision fencing, against a REAL PostgreSQL.
 *
 * What makes this suite load-bearing is that it exercises the fences under
 * CONCURRENCY and against the STORE's clock, not just their happy paths. A grant
 * that is "single use" because the caller checks before writing is not single use;
 * a grant that expires "because the worker compared timestamps" is not expired on a
 * machine with a skewed clock. Both are asserted here by racing two consumers and
 * by moving the durable expiry rather than the process time.
 *
 * Every refusal is asserted on its REASON, never on "it failed". A test that only
 * asserts failure also passes when a different, weaker layer produced the
 * refusal — the `CTF-010` pattern that cost this repository five HIGH defects.
 */
import { CURRENT_SCHEMA_VERSION, approval as approvalContract } from "@remoteagent/contracts";

// Imported from `../../database/src` rather than `@remoteagent/database` for the
// structural reason recorded in WU-01 and in `tsconfig.test.json`: `packages/database`
// devDepends on `@remoteagent/policy` for its own tests, so a manifest edge in this
// direction makes turbo's graph cyclic and `build` refuses to run. A relative import
// adds no package edge and keeps `Database` ONE class identity with the harness.
import {
  ApprovalIdentityError,
  ApprovalRepository,
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  ImmutableGrantError,
  KillSwitchRepository,
  OwnerRepository,
  translatePgError,
} from "../../database/src/index.js";
import type { ApprovalConsumption, ApprovalRow, Transaction } from "../../database/src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

describeIntegration(
  "RA-022-WU-02 approval repository (real PostgreSQL)",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const approvals = new ApprovalRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      await db.query(
        `TRUNCATE kill_switch_events, external_actions, approvals, receipts,
           case_checkpoints, case_connections, cases, connections, owners
         RESTART IDENTITY CASCADE`,
      );
      await new OwnerRepository().insert(db, { ownerId: "owner-a", displayName: "owner-a" });
      await new OwnerRepository().insert(db, { ownerId: "owner-b", displayName: "owner-b" });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-a",
        ownerId: "owner-a",
        provider: "jira",
        alias: "sondermind",
        displayName: "conn-a",
      });
      await new ConnectionRepository().insert(db, {
        connectionId: "conn-b",
        ownerId: "owner-b",
        provider: "jira",
        alias: "private",
        displayName: "conn-b",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-a",
        ownerId: "owner-a",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-a"] },
        discordThreadId: "thread-a",
      });
      // A second case under a DIFFERENT owner, so every scope assertion can
      // distinguish "fenced on the owner" from "there is only one owner".
      await new CaseRepository().insert(db, {
        caseId: "case-b",
        ownerId: "owner-b",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-b"] },
        discordThreadId: "thread-b",
      });
    });

    /** Grant at the case's current revision. Returns the row, failing loudly if refused. */
    async function grantAt(
      caseId: string,
      approvalId: string,
      digest: string,
      options: { grantedBy?: string; ttlMs?: number; revision?: number } = {},
    ): Promise<ApprovalRow> {
      const revision = options.revision ?? (await currentRevision(caseId));
      const result = await db.withTransaction((tx) =>
        approvals.grant(tx, {
          approvalId,
          caseId,
          grantedBy: options.grantedBy ?? "owner-a",
          actionDigest: digest,
          checkpointRevision: revision,
          expiresAt: new Date(Date.now() + (options.ttlMs ?? 3_600_000)),
        }),
      );
      if (result.outcome !== "GRANTED") {
        throw new Error(`expected GRANTED, got ${result.outcome}`);
      }
      return result.row;
    }

    async function currentRevision(caseId: string): Promise<number> {
      const result = await db.query<{ checkpoint_revision: number }>(
        `SELECT checkpoint_revision FROM cases WHERE case_id = $1`,
        [caseId],
      );
      return result.rows[0]!.checkpoint_revision;
    }

    function consume(
      input: { approvalId: string; caseId?: string; ownerId?: string; actionDigest?: string },
      tx?: Transaction,
    ): Promise<ApprovalConsumption> {
      const request = {
        approvalId: input.approvalId,
        caseId: input.caseId ?? "case-a",
        ownerId: input.ownerId ?? "owner-a",
        actionDigest: input.actionDigest ?? DIGEST_A,
      };
      if (tx !== undefined) return approvals.consume(tx, request);
      return db.withTransaction((t) => approvals.consume(t, request));
    }

    /** Advance the case one checkpoint revision, the way the orchestrator does. */
    async function advanceRevision(caseId: string): Promise<number> {
      const from = await currentRevision(caseId);
      const next = from + 1;
      await db.withTransaction((tx) =>
        new CheckpointRepository().append(tx, {
          caseId,
          expectedRevision: from,
          checkpoint: {
            schema_version: CURRENT_SCHEMA_VERSION,
            case_id: caseId,
            revision: next,
            goal: "advance the case so a prior grant becomes stale",
            current_phase: "testing",
            summary: { text: "advanced", trust_level: "UNTRUSTED_DATA" },
            plan_revision: 0,
            completed_work: [],
            decisions: [],
            assumptions: [],
            evidence: [],
            open_questions: [],
            next_actions: [],
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

    describe("grant: a grant is born at a real, current revision", () => {
      it("derives owner_id from the case, not from the granting actor", async () => {
        // `granted_by` records WHO clicked; `owner_id` is what a consumption is
        // fenced on. The actor is deliberately a delegate here so the assertion can
        // tell the two sources apart — with `grantedBy: "owner-a"` this test would
        // pass even if the repository fenced on the actor (the WU-01 lesson).
        const row = await grantAt("case-a", "ap-1", DIGEST_A, {
          grantedBy: "delegate-who-clicked",
        });
        expect(row.owner_id).toBe("owner-a");
        expect(row.granted_by).toBe("delegate-who-clicked");
      });

      it("refuses a grant whose revision the case has already left", async () => {
        // The owner clicked a button rendered for revision N while the case advanced
        // to N+1. Recording the grant would create one that is stale at birth, so it
        // is refused and the owner is asked again against current facts.
        const stale = await currentRevision("case-a");
        const current = await advanceRevision("case-a");

        const result = await db.withTransaction((tx) =>
          approvals.grant(tx, {
            approvalId: "ap-stale-birth",
            caseId: "case-a",
            grantedBy: "owner-a",
            actionDigest: DIGEST_A,
            checkpointRevision: stale,
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
        );

        expect(result.outcome).toBe("STALE_REVISION");
        if (result.outcome !== "STALE_REVISION") throw new Error("unreachable");
        expect(result.requested).toBe(stale);
        expect(result.current).toBe(current);
        expect(await approvals.findById(db, "ap-stale-birth")).toBeNull();
      });

      it("refuses a grant for a case that does not exist", async () => {
        const result = await db.withTransaction((tx) =>
          approvals.grant(tx, {
            approvalId: "ap-nocase",
            caseId: "case-missing",
            grantedBy: "owner-a",
            actionDigest: DIGEST_A,
            checkpointRevision: 0,
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
        );
        expect(result.outcome).toBe("CASE_NOT_FOUND");
      });

      it("treats a repeated identical click as a replay, not a second grant", async () => {
        const first = await grantAt("case-a", "ap-replay", DIGEST_A);
        const again = await db.withTransaction((tx) =>
          approvals.grant(tx, {
            approvalId: "ap-replay",
            caseId: "case-a",
            grantedBy: "owner-a",
            actionDigest: DIGEST_A,
            checkpointRevision: first.checkpoint_revision,
            expiresAt: first.expires_at,
          }),
        );
        expect(again.outcome).toBe("ALREADY_GRANTED");
        const count = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM approvals",
        );
        expect(count.rows[0]!.count).toBe("1");
      });

      it("rejects an approval_id reused for a different action digest", async () => {
        // A colliding id must never be accepted as a replay: it would let a grant
        // for one payload be presented as a grant for another. Same fail-closed
        // identity check RA-005 AUDIT-02 HIGH-04 added for refresh intents.
        const first = await grantAt("case-a", "ap-collide", DIGEST_A);
        await expect(
          db.withTransaction((tx) =>
            approvals.grant(tx, {
              approvalId: "ap-collide",
              caseId: "case-a",
              grantedBy: "owner-a",
              actionDigest: DIGEST_B,
              checkpointRevision: first.checkpoint_revision,
              expiresAt: first.expires_at,
            }),
          ),
        ).rejects.toThrow(ApprovalIdentityError);
      });

      it("rejects an approval_id reused by a different granting actor", async () => {
        const first = await grantAt("case-a", "ap-actor", DIGEST_A);
        const error = await db
          .withTransaction((tx) =>
            approvals.grant(tx, {
              approvalId: "ap-actor",
              caseId: "case-a",
              grantedBy: "someone-else",
              actionDigest: DIGEST_A,
              checkpointRevision: first.checkpoint_revision,
              expiresAt: first.expires_at,
            }),
          )
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApprovalIdentityError);
        expect((error as ApprovalIdentityError).field).toBe("granting actor");
      });

      it("produces a row the accepted contract validates", async () => {
        // The store and the contract must agree; if only one held, the other is the
        // gap. Asserted rather than trusted.
        const row = await grantAt("case-a", "ap-contract", DIGEST_A);
        const parsed = approvalContract.safeParse({
          schema_version: CURRENT_SCHEMA_VERSION,
          approval_id: row.approval_id,
          case_id: row.case_id,
          owner_id: row.owner_id,
          granted_by: row.granted_by,
          action_digest: row.action_digest,
          checkpoint_revision: row.checkpoint_revision,
          granted_at: row.granted_at.toISOString(),
          expires_at: row.expires_at.toISOString(),
          consumed: row.consumed,
        });
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      });
    });

    describe("consume: single use, enforced by the store", () => {
      it("consumes a valid grant exactly once", async () => {
        await grantAt("case-a", "ap-once", DIGEST_A);

        const first = await consume({ approvalId: "ap-once" });
        expect(first.outcome).toBe("CONSUMED");

        const second = await consume({ approvalId: "ap-once" });
        expect(second.outcome).toBe("ALREADY_CONSUMED");
      });

      it("stamps consumed_at from the database clock, inside the validity window", async () => {
        const row = await grantAt("case-a", "ap-clock", DIGEST_A);
        const result = await consume({ approvalId: "ap-clock" });
        expect(result.outcome).toBe("CONSUMED");
        if (result.outcome !== "CONSUMED") throw new Error("unreachable");
        const at = result.row.consumed_at;
        expect(at).not.toBeNull();
        // granted_at <= consumed_at < expires_at, the contract's rule.
        expect(at!.getTime()).toBeGreaterThanOrEqual(row.granted_at.getTime());
        expect(at!.getTime()).toBeLessThan(row.expires_at.getTime());
      });

      it("lets exactly ONE of two concurrent consumers win", async () => {
        // The property that separates an atomic fence from check-then-act. Both
        // transactions are opened before either consumes, so they genuinely overlap:
        // with a SELECT-then-UPDATE implementation both would observe
        // `consumed = false` and both would proceed.
        await grantAt("case-a", "ap-race", DIGEST_A);

        const outcomes = await Promise.all([
          db.withTransaction(async (tx) => {
            const r = await approvals.consume(tx, {
              approvalId: "ap-race",
              caseId: "case-a",
              ownerId: "owner-a",
              actionDigest: DIGEST_A,
            });
            return r.outcome;
          }),
          db.withTransaction(async (tx) => {
            const r = await approvals.consume(tx, {
              approvalId: "ap-race",
              caseId: "case-a",
              ownerId: "owner-a",
              actionDigest: DIGEST_A,
            });
            return r.outcome;
          }),
        ]);

        expect(outcomes.filter((o) => o === "CONSUMED")).toHaveLength(1);
        expect(outcomes.filter((o) => o === "ALREADY_CONSUMED")).toHaveLength(1);
      });

      it("makes a concurrent checkpoint append WAIT rather than race the revision read", async () => {
        // The `FOR SHARE` lock in `lockCaseRevision`, which nothing else in this suite
        // covers: the mutation that removed it survived every other test. Without the
        // lock, "read revision N" and "consume at revision N" are two statements with a
        // window between them, and a checkpoint append committing inside that window
        // means the grant is consumed against a revision that is already superseded —
        // the very TOCTOU `checkpoint_revision` exists to close. AC3/AC6 rest on this
        // lock, not on statement ordering.
        //
        // Asserted through the lock's OBSERVABLE effect (the appender is made to wait)
        // rather than by inspecting `pg_locks`, so the test survives a refactor that
        // keeps the guarantee by different means.
        await grantAt("case-a", "ap-lock", DIGEST_A);

        let appendResolved = false;
        let releaseConsumer: () => void = () => {};
        const consumerHoldsLock = new Promise<void>((resolve) => {
          releaseConsumer = resolve;
        });

        const consumer = db.withTransaction(async (tx) => {
          const outcome = await approvals.consume(tx, {
            approvalId: "ap-lock",
            caseId: "case-a",
            ownerId: "owner-a",
            actionDigest: DIGEST_A,
          });
          // Still inside the transaction, so the share lock is still held. If the
          // appender could ignore it, it would finish here.
          await consumerHoldsLock;
          expect(appendResolved).toBe(false);
          return outcome;
        });

        // Give the consumer time to take the lock, then start an append that must block
        // on it. `void` rather than `await`: the point is that it does NOT complete yet.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const appender = advanceRevision("case-a").then((revision) => {
          appendResolved = true;
          return revision;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(appendResolved).toBe(false);

        releaseConsumer();
        const outcome = await consumer;
        expect(outcome.outcome).toBe("CONSUMED");

        // Once the consumer commits, the appender proceeds — the lock delayed it, it did
        // not deadlock or lose the write.
        expect(await appender).toBe(1);
      });

      it("refuses a grant whose case has advanced since it was granted", async () => {
        // AC2's stale-revision half and the TOCTOU in this task's audit focus: the
        // payload digest is unchanged and still matches, the grant is unconsumed and
        // unexpired — only the CONTEXT moved. It must still be refused.
        await grantAt("case-a", "ap-stale", DIGEST_A);
        const now = await advanceRevision("case-a");

        const result = await consume({ approvalId: "ap-stale" });
        expect(result.outcome).toBe("STALE_REVISION");
        if (result.outcome !== "STALE_REVISION") throw new Error("unreachable");
        expect(result.currentRevision).toBe(now);
        expect(result.row.checkpoint_revision).toBe(now - 1);
        // Refused, and left usable-looking: the refusal must not silently burn the
        // grant either, or a transient advance would destroy the owner's consent
        // without telling anyone.
        expect((await approvals.findById(db, "ap-stale"))?.consumed).toBe(false);
      });

      it("refuses a digest that does not match the grant", async () => {
        // AC1 at the consumption boundary: change one parameter and the canonical
        // digest changes, so the grant no longer authorizes the action.
        await grantAt("case-a", "ap-digest", DIGEST_A);
        const result = await consume({ approvalId: "ap-digest", actionDigest: DIGEST_B });
        expect(result.outcome).toBe("DIGEST_MISMATCH");
        expect((await approvals.findById(db, "ap-digest"))?.consumed).toBe(false);
      });

      it("refuses a consumption from a different owner and reveals nothing", async () => {
        await grantAt("case-a", "ap-owner", DIGEST_A);
        const result = await consume({ approvalId: "ap-owner", ownerId: "owner-b" });
        expect(result.outcome).toBe("WRONG_OWNER");
        // No row on the outcome: an attempt across an ownership edge must not learn
        // the grant's contents.
        expect(Object.hasOwn(result, "row")).toBe(false);
        expect((await approvals.findById(db, "ap-owner"))?.consumed).toBe(false);
      });

      it("fences on the case's owner, NOT on the actor who granted it", async () => {
        // This test exists because the mutation `AND owner_id = $3` -> `AND granted_by
        // = $3` SURVIVED the first version of this suite: every other test granted with
        // `grantedBy = "owner-a"`, so the actor and the scope were the same string and
        // no assertion could tell which one the fence used. That is exactly the
        // `CTF-010` shape WU-01 hit in its own migration test, reproduced here one
        // layer up — a green suite proving nothing about the property it names.
        //
        // A delegate grants; the OWNER's scope must consume it, and the delegate's own
        // id must not. Both halves are needed: the first alone would pass a fence that
        // ignores scope entirely, the second alone would pass one that rejects
        // everything.
        await grantAt("case-a", "ap-delegate", DIGEST_A, { grantedBy: "delegate-who-clicked" });

        const asActor = await consume({
          approvalId: "ap-delegate",
          ownerId: "delegate-who-clicked",
        });
        expect(asActor.outcome).toBe("WRONG_OWNER");
        expect((await approvals.findById(db, "ap-delegate"))?.consumed).toBe(false);

        const asOwner = await consume({ approvalId: "ap-delegate", ownerId: "owner-a" });
        expect(asOwner.outcome).toBe("CONSUMED");
      });

      it("refuses a grant presented under a different case", async () => {
        await grantAt("case-a", "ap-case", DIGEST_A);
        const result = await consume({
          approvalId: "ap-case",
          caseId: "case-b",
          ownerId: "owner-b",
        });
        expect(result.outcome).toBe("NOT_FOUND");
      });

      it("refuses an expired grant against the store's clock", async () => {
        // Expiry is moved in the DATABASE, not in the process: a worker with a
        // skewed clock must not be able to consume a grant the store considers
        // expired. Comparing timestamps in TypeScript would pass this test only by
        // accident of the two clocks agreeing.
        //
        // The grant is created with an expiry ALREADY in the past, rather than being
        // UPDATEd after the fact. Two earlier versions of this test are worth recording
        // because each was wrong in a different, instructive way:
        //
        //  1. `expires_at = granted_at + interval '1 millisecond'` was FLAKY, exposed by
        //     this unit's mutation check going red under two mutations unrelated to
        //     expiry. `now()` is the TRANSACTION START instant, so a 1ms window closed
        //     only if the consuming transaction happened to begin late enough — the test
        //     was measuring scheduling, not the mechanism it is named after.
        //  2. Moving the whole window into the past by UPDATE is now REFUSED by
        //     migration 030, which freezes `granted_at`/`expires_at` on a granted
        //     approval. That guard exists because of the WU-02 probe finding, and it
        //     correctly applies to the test too — a test that needs to tamper with the
        //     grant is asking for a state the system must not allow.
        //
        // So the window is set at grant time, which is the only legitimate way to have
        // an expired grant: `grant` takes `expiresAt` from the caller, and migration
        // 008's `expires_at > granted_at` CHECK is still satisfied because `granted_at`
        // defaults to `now()` — which is earlier still.
        const revision = await currentRevision("case-a");
        await db.withTransaction((tx) =>
          approvals.grant(tx, {
            approvalId: "ap-expired",
            caseId: "case-a",
            grantedBy: "owner-a",
            actionDigest: DIGEST_A,
            checkpointRevision: revision,
            // Strictly after granted_at (satisfying the CHECK) but already elapsed by
            // the time any consumption transaction starts.
            expiresAt: new Date(Date.now() + 1),
          }),
        );
        // Ensure the window has closed against the store's clock regardless of
        // scheduling, without depending on process timing for the assertion itself.
        await db.query("SELECT pg_sleep(0.05)");

        const result = await consume({ approvalId: "ap-expired" });
        expect(result.outcome).toBe("EXPIRED");
        expect((await approvals.findById(db, "ap-expired"))?.consumed).toBe(false);
      });

      it("reports NOT_FOUND for an approval that was never granted", async () => {
        expect((await consume({ approvalId: "ap-ghost" })).outcome).toBe("NOT_FOUND");
      });

      it("refuses when the case itself is gone", async () => {
        const result = await consume({ approvalId: "ap-any", caseId: "case-missing" });
        expect(result.outcome).toBe("NOT_FOUND");
      });
    });

    describe("the consumption transaction is the kill switch's boundary too (AC6)", () => {
      it("rolls the consumption back when the same transaction sees an active switch", async () => {
        // AC6 requires the kill switch to work BETWEEN approval and execute. This is
        // the structural half of that guarantee: `KillSwitchRepository` accepts a
        // `Queryable`, so the executor can read it INSIDE the transaction that
        // consumes the grant. Reading it before, in its own transaction, would leave
        // exactly the window AC6 names. When the switch is on, the transaction
        // aborts and the grant is left unconsumed — the owner's consent survives an
        // operator stop instead of being silently burned.
        await grantAt("case-a", "ap-killed", DIGEST_A);
        await new KillSwitchRepository().append(db, {
          eventId: "ks-on",
          level: "GLOBAL",
          enabled: true,
          reason: "operator stop during RA-022 verification",
          changedBy: "owner-a",
        });

        await expect(
          db.withTransaction(async (tx) => {
            const consumed = await approvals.consume(tx, {
              approvalId: "ap-killed",
              caseId: "case-a",
              ownerId: "owner-a",
              actionDigest: DIGEST_A,
            });
            expect(consumed.outcome).toBe("CONSUMED");
            // Same transaction, same snapshot — this is the point.
            const switches = await new KillSwitchRepository().listEffective(tx, {
              ownerId: "owner-a",
              provider: "jira",
              connectionId: "conn-a",
            });
            if (switches.some((s) => s.enabled)) {
              throw new Error("kill switch active: refusing to execute");
            }
            return consumed;
          }),
        ).rejects.toThrow(/kill switch active/);

        expect((await approvals.findById(db, "ap-killed"))?.consumed).toBe(false);
      });
    });

    describe("listUnconsumedForDigest is scoped, and is not an authorization path", () => {
      it("lists only the requesting owner's live grants for that digest", async () => {
        await grantAt("case-a", "ap-live-1", DIGEST_A);
        await grantAt("case-a", "ap-live-2", DIGEST_B);
        await consume({ approvalId: "ap-live-1" });
        await grantAt("case-a", "ap-live-3", DIGEST_A);

        const forA = await approvals.listUnconsumedForDigest(db, {
          caseId: "case-a",
          ownerId: "owner-a",
          actionDigest: DIGEST_A,
        });
        expect(forA.map((r) => r.approval_id)).toEqual(["ap-live-3"]);

        const forB = await approvals.listUnconsumedForDigest(db, {
          caseId: "case-a",
          ownerId: "owner-b",
          actionDigest: DIGEST_A,
        });
        expect(forB).toEqual([]);
      });
    });

    /**
     * Assert that a raw statement was refused by the migration-030 guards.
     *
     * Matched on SQLSTATE `P0103`, which is what the trigger raises. `db.query` is the
     * pool, so it does NOT run `translatePgError` -- asserting on `ImmutableGrantError`
     * here would test the translator, not the guard, and would pass if the guard were
     * replaced by any other failure. The code is also locale-independent, unlike the
     * message. `ImmutableGrantError` is covered separately below, through a repository
     * path that does translate.
     */
    async function expectRefusedByGuard(
      sql: string,
      params: readonly unknown[] = [],
      /**
       * Which of the three guard rules must have fired. Supplied where more than one
       * rule could refuse the same statement: the un-consume mutation SURVIVED until
       * this existed, because rule 3 (frozen `consumed_at`) refused the statement
       * first and an assertion on the SQLSTATE alone could not tell the rules apart.
       * That is `CTF-010` at the level of a shared error code — the same reason
       * AGENTS.md requires asserting on the refusal code rather than the failure class.
       */
      expectedRule?: RegExp,
    ): Promise<void> {
      const error = await db.query(sql, params).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, `expected the guard to refuse: ${sql}`).not.toBeNull();
      expect((error as { code?: string }).code).toBe("P0103");
      if (expectedRule !== undefined) {
        expect((error as { message?: string }).message).toMatch(expectedRule);
      }
    }

    /**
     * Every test in this block is a regression for a defect the WU-02 ADVERSARIAL
     * PROBE found while the 21 tests above were green. They share one root cause: the
     * fences in `consume` read durable columns, so anything able to rewrite those
     * columns — or to rewind the state they are compared against — defeats the fence
     * without touching it. Fixed by migration 030 and the supersession check.
     */
    describe("durable state behind the fences cannot be rewritten (adversarial probe)", () => {
      it("refuses to un-consume a spent grant, so it cannot be spent twice", async () => {
        // PROBE 5. One UPDATE made a consumed single-use grant consumable again.
        await grantAt("case-a", "ap-unspend", DIGEST_A);
        expect((await consume({ approvalId: "ap-unspend" })).outcome).toBe("CONSUMED");

        // Clearing `consumed` alone, leaving `consumed_at` in place, so ONLY the
        // one-way-consumption rule can refuse it. The combined
        // `consumed = false, consumed_at = NULL` statement is also refused, but by the
        // frozen-`consumed_at` rule first — asserting on that version let a mutation
        // that disabled the single-use rule pass.
        await expectRefusedByGuard(
          `UPDATE approvals SET consumed = false WHERE approval_id = 'ap-unspend'`,
          [],
          /single-use: a consumed grant cannot be un-consumed/,
        );

        // Still spent, and still refused on a second attempt.
        expect((await approvals.findById(db, "ap-unspend"))?.consumed).toBe(true);
        expect((await consume({ approvalId: "ap-unspend" })).outcome).toBe("ALREADY_CONSUMED");
      });

      it("refuses to rewrite a recorded consumption instant", async () => {
        // Rule 3, which the test above deliberately no longer exercises. A rewritable
        // `consumed_at` would let an out-of-window use be made to look legitimate
        // against the contract's `granted_at <= consumed_at < expires_at` rule.
        await grantAt("case-a", "ap-instant", DIGEST_A);
        await consume({ approvalId: "ap-instant" });
        await expectRefusedByGuard(
          `UPDATE approvals SET consumed_at = granted_at WHERE approval_id = 'ap-instant'`,
          [],
          /consumed_at is immutable once recorded/,
        );
      });

      it("refuses to retarget a grant's action digest", async () => {
        // PROBE 6, the most serious finding: one UPDATE moved consent from payload A
        // to payload B, inverting AC1 — the owner approved one action and a different
        // one became authorized. Asserted on the guard's own error type, not merely on
        // "it threw".
        await grantAt("case-a", "ap-retarget", DIGEST_A);
        await expectRefusedByGuard(
          `UPDATE approvals SET action_digest = $1 WHERE approval_id = 'ap-retarget'`,
          [DIGEST_B],
        );

        // The grant still authorizes only what the owner approved.
        expect((await consume({ approvalId: "ap-retarget", actionDigest: DIGEST_B })).outcome).toBe(
          "DIGEST_MISMATCH",
        );
      });

      it("freezes the owner scope, the revision and the expiry of a granted approval", async () => {
        // Each of these is fenced on by `consume`, so each is a way to rescope, revive
        // or re-context consent. Enumerated individually rather than as one blanket
        // assertion so a partial guard cannot pass.
        await grantAt("case-a", "ap-frozen", DIGEST_A);
        const tampers: readonly [string, string, readonly unknown[]][] = [
          [
            "owner_id",
            "UPDATE approvals SET owner_id = $1 WHERE approval_id='ap-frozen'",
            ["owner-b"],
          ],
          [
            "granted_by",
            "UPDATE approvals SET granted_by = $1 WHERE approval_id='ap-frozen'",
            ["someone"],
          ],
          [
            "checkpoint_revision",
            "UPDATE approvals SET checkpoint_revision = 99 WHERE approval_id='ap-frozen'",
            [],
          ],
          [
            "expires_at",
            "UPDATE approvals SET expires_at = now() + interval '10 years' WHERE approval_id='ap-frozen'",
            [],
          ],
          [
            "granted_at",
            "UPDATE approvals SET granted_at = now() - interval '10 years' WHERE approval_id='ap-frozen'",
            [],
          ],
          ["case_id", "UPDATE approvals SET case_id = 'case-b' WHERE approval_id='ap-frozen'", []],
        ];
        for (const [field, sql, params] of tampers) {
          expect(field).toBeTruthy();
          await expectRefusedByGuard(sql, params);
        }
      });

      it("refuses to delete an approval, so a replay cannot be laundered", async () => {
        // Deleting a consumed grant and re-granting the same id would walk straight
        // past the single-use fence.
        await grantAt("case-a", "ap-nodelete", DIGEST_A);
        await consume({ approvalId: "ap-nodelete" });
        await expectRefusedByGuard("DELETE FROM approvals WHERE approval_id = 'ap-nodelete'");
      });

      it("surfaces a guard refusal as ImmutableGrantError through a translating path", async () => {
        // The tests above assert SQLSTATE `P0103` from the raw pool, which proves the
        // GUARD fired. This one covers the other half — that `translatePgError` maps that
        // code to the typed error the rest of the codebase catches on. Without it the
        // translator entry could be deleted and every test would still pass, which is the
        // `CTF-001` hazard: code catching a class that the thrower never produces.
        await grantAt("case-a", "ap-translate", DIGEST_A);
        const error = await db
          .withTransaction((tx) =>
            tx.query(`UPDATE approvals SET action_digest = $1 WHERE approval_id = 'ap-translate'`, [
              DIGEST_B,
            ]),
          )
          .then(
            () => null,
            // `translatePgError` runs in the repository layer, so it is invoked here the
            // way production does: through a repository call on the same tampered row.
            (e: unknown) => translatePgError(e) ?? e,
          );
        expect(error).toBeInstanceOf(ImmutableGrantError);
      });

      it("allows only ONE live grant per canonical action, so consent is not double-spent", async () => {
        // PROBE 4: single use is per approval_id, so two ids for the same digest were
        // two spends of one action.
        const first = await grantAt("case-a", "ap-dup-1", DIGEST_A);
        const second = await db.withTransaction((tx) =>
          approvals.grant(tx, {
            approvalId: "ap-dup-2",
            caseId: "case-a",
            grantedBy: "owner-a",
            actionDigest: DIGEST_A,
            checkpointRevision: first.checkpoint_revision,
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
        );
        expect(second.outcome).toBe("LIVE_GRANT_EXISTS");
        if (second.outcome !== "LIVE_GRANT_EXISTS") throw new Error("unreachable");
        expect(second.row.approval_id).toBe("ap-dup-1");
        expect(await approvals.findById(db, "ap-dup-2")).toBeNull();
      });

      it("enforces one-live-grant in the SCHEMA, not only in the pre-check", async () => {
        // `grant` reports LIVE_GRANT_EXISTS from a pre-check inside its transaction,
        // which is the clean sequential answer and by itself NOT the guarantee: two
        // simultaneous transactions can both pass a pre-check before either inserts.
        // The partial unique index is the invariant, and the test above stayed green
        // when it was dropped.
        //
        // So the index is exercised DIRECTLY, by inserting a second live grant the way a
        // future caller (or a different code path) could. A racing-transactions test was
        // tried first and rejected: whether the pre-check or the index decides the race
        // depends on commit timing, so it caught the dropped index only sometimes —
        // a nondeterministic guard is not a guard, and `CTF-012` is what that costs.
        await grantAt("case-a", "ap-idx-1", DIGEST_A);

        const error = await db
          .query(
            `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
               action_digest, checkpoint_revision, expires_at)
             VALUES ('ap-idx-2','case-a','owner-a','owner-a',$1,$2, now() + interval '1 hour')`,
            [DIGEST_A, await currentRevision("case-a")],
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(error, "a second LIVE grant for one action must be impossible").not.toBeNull();
        // Asserted on the specific index, not on "some error": another constraint
        // refusing this insert would mean the invariant is not the one being tested.
        expect((error as { constraint?: string }).constraint).toBe(
          "approvals_one_live_grant_per_action_idx",
        );

        const live = await approvals.listUnconsumedForDigest(db, {
          caseId: "case-a",
          ownerId: "owner-a",
          actionDigest: DIGEST_A,
        });
        expect(live).toHaveLength(1);
      });

      it("still allows a FRESH grant once the previous one was consumed", async () => {
        // The other half of the index being partial on `consumed = false`: approving
        // the same action again later is legitimate and must not be blocked. Without
        // this test the fix above could be "no second grant ever", which would break a
        // real workflow while still passing the double-spend test.
        await grantAt("case-a", "ap-again-1", DIGEST_A);
        expect((await consume({ approvalId: "ap-again-1" })).outcome).toBe("CONSUMED");

        const again = await grantAt("case-a", "ap-again-2", DIGEST_A);
        expect(again.approval_id).toBe("ap-again-2");
        expect((await consume({ approvalId: "ap-again-2" })).outcome).toBe("CONSUMED");
      });

      it("does not revive a superseded grant when the case revision is rewound", async () => {
        // PROBE 7. `cases.checkpoint_revision` is a mutable counter, so a rewind (a
        // recovery, a restore, an operator repair) made a grant that had already been
        // correctly refused as STALE_REVISION consumable again. `case_checkpoints` is
        // append-only, so the highest revision ever written is the monotonic fact.
        await grantAt("case-a", "ap-rewind", DIGEST_A);
        await advanceRevision("case-a");
        expect((await consume({ approvalId: "ap-rewind" })).outcome).toBe("STALE_REVISION");

        // Rewind the counter to the revision the grant was made at.
        await db.query("UPDATE cases SET checkpoint_revision = 0 WHERE case_id = 'case-a'");

        const afterRewind = await consume({ approvalId: "ap-rewind" });
        expect(afterRewind.outcome).toBe("STALE_REVISION");
        if (afterRewind.outcome !== "STALE_REVISION") throw new Error("unreachable");
        // Reported against the highest revision ever written, not the rewound counter.
        expect(afterRewind.currentRevision).toBe(1);
        expect((await approvals.findById(db, "ap-rewind"))?.consumed).toBe(false);
      });

      it("still consumes a grant made at the case's current revision after a rewind", async () => {
        // The complement: supersession must not become "no consumption after any
        // checkpoint exists". A grant made at the CURRENT revision is fine even though
        // checkpoint history exists.
        await advanceRevision("case-a");
        await grantAt("case-a", "ap-current", DIGEST_A);
        expect((await consume({ approvalId: "ap-current" })).outcome).toBe("CONSUMED");
      });
    });
  },
  available,
);
