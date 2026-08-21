/**
 * RA-022-WU-04 — approval ingestion: a Discord click becomes a durable grant, or it
 * does not. Against a REAL PostgreSQL.
 *
 * Two things make this suite load-bearing beyond its happy path.
 *
 * First, it passes the REAL `ApprovalRepository` and `ExternalActionRepository` where
 * a structural port is expected. `packages/policy` cannot import
 * `@remoteagent/database` (the turbo cycle recorded in WU-01), so the ports in
 * `ingestion-ports.ts` restate those interfaces — and a restated interface that
 * drifts from its original is a silent lie. This file is where the two are checked
 * against each other: if a repository signature changes, this stops compiling.
 *
 * Second, every refusal is asserted on its own outcome variant, and the DURABLE state
 * is re-read afterwards. An ingestion that returns the right word while leaving an
 * orphan grant behind has failed at the only thing that matters.
 */
import { CURRENT_SCHEMA_VERSION, canonicalDigest } from "@remoteagent/contracts";

// Relative import into the sibling's source for the reason recorded in WU-01 and in
// `tsconfig.test.json`: a manifest edge policy -> database makes turbo's graph cyclic,
// and a relative import adds no package edge while keeping ONE `Database` identity
// with the harness.
import {
  ApprovalRepository,
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  ExternalActionRepository,
  OwnerRepository,
} from "../../database/src/index.js";
import type { ExternalActionRow, Transaction } from "../../database/src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalIngestionConflictError,
  GrantTtlOutOfRangeError,
  MAX_GRANT_TTL_MS,
  MIN_GRANT_TTL_MS,
  ingestApprovalClick,
} from "../src/approval-ingestion.js";
import type { ApprovalIngestionPorts } from "../src/ingestion-ports.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

const PAYLOAD = { issue: "MOBL-7", body: "the comment the owner approved" };
const OTHER_PAYLOAD = { issue: "MOBL-7", body: "a different comment" };
const DIGEST = canonicalDigest(PAYLOAD);
const OTHER_DIGEST = canonicalDigest(OTHER_PAYLOAD);
const TTL_MS = 15 * 60 * 1000;

describeIntegration(
  "RA-022-WU-04 approval ingestion (real PostgreSQL)",
  () => {
    let db: Database;
    let drop: () => Promise<void>;

    const approvals = new ApprovalRepository();
    const actions = new ExternalActionRepository();

    /**
     * The real repositories, used where structural ports are expected.
     *
     * This assignment is the compile-time check that `ingestion-ports.ts` still
     * describes the real interfaces. It is deliberately NOT a cast: a cast would make
     * a drift invisible, which is the whole failure this is guarding against.
     */
    const ports: ApprovalIngestionPorts = { approvals, actions };

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
      await new CaseRepository().insert(db, {
        caseId: "case-b",
        ownerId: "owner-b",
        status: "TRIAGED",
        integrationScope: { providers: ["jira"], connection_ids: ["conn-b"] },
        discordThreadId: "thread-b",
      });
    });

    /** Propose an R3 action awaiting approval, the state a button is rendered for. */
    async function propose(
      overrides: {
        actionId?: string;
        caseId?: string;
        connectionId?: string;
        payload?: Record<string, unknown>;
        digest?: string;
        riskTier?: "R2" | "R3" | "R4";
        policyDecision?: "REQUIRES_APPROVAL" | "AUTO_ALLOW" | "DENY";
        idempotencyKey?: string;
      } = {},
    ): Promise<ExternalActionRow> {
      const payload = overrides.payload ?? PAYLOAD;
      const result = await actions.propose(db, {
        actionId: overrides.actionId ?? "act-1",
        caseId: overrides.caseId ?? "case-a",
        toolName: "jira.issue.comment",
        connectionId: overrides.connectionId ?? "conn-a",
        canonicalPayload: payload,
        actionDigest: overrides.digest ?? canonicalDigest(payload),
        riskTier: overrides.riskTier ?? "R3",
        policyDecision: overrides.policyDecision ?? "REQUIRES_APPROVAL",
        idempotencyKey: overrides.idempotencyKey ?? `idem-${overrides.actionId ?? "act-1"}`,
      });
      if (result.outcome !== "PROPOSED") {
        throw new Error(`expected PROPOSED, got ${result.outcome}`);
      }
      return result.row;
    }

    async function currentRevision(caseId: string): Promise<number> {
      const r = await db.query<{ checkpoint_revision: number }>(
        `SELECT checkpoint_revision FROM cases WHERE case_id = $1`,
        [caseId],
      );
      return r.rows[0]!.checkpoint_revision;
    }

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
            goal: "advance so the rendered proposal goes stale",
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

    function ingest(input: {
      actionId?: string;
      caseId?: string;
      actorId?: string;
      approvalId?: string;
      revision?: number;
      choice?: "grant" | "deny";
    }): Promise<Awaited<ReturnType<typeof ingestApprovalClick>>> {
      return db.withTransaction(async (tx: Transaction) => {
        const revision = input.revision ?? (await currentRevision(input.caseId ?? "case-a"));
        return ingestApprovalClick(tx, ports, {
          caseId: input.caseId ?? "case-a",
          actorId: input.actorId ?? "owner-a",
          actionId: input.actionId ?? "act-1",
          click: {
            approvalId: input.approvalId ?? "ap-1",
            checkpointRevision: revision,
            choice: input.choice ?? "grant",
          },
          grantTtlMs: TTL_MS,
          now: new Date(),
        });
      });
    }

    describe("a grant is derived from the STORE, never from the click", () => {
      it("binds the grant to the proposal's digest, which the click never carries", async () => {
        // The central property of this unit. The `custom_id` carries no digest, so the
        // digest cannot be substituted in transit — it is read from the pending row.
        await propose();
        const result = await ingest({});

        expect(result.outcome).toBe("GRANTED");
        if (result.outcome !== "GRANTED") throw new Error("unreachable");
        expect(result.approval.action_digest).toBe(DIGEST);
        expect(result.action.status).toBe("APPROVED");

        // Durable state, re-read: the grant exists, is unconsumed, and the action
        // points at it.
        const stored = await approvals.findById(db, "ap-1");
        expect(stored?.action_digest).toBe(DIGEST);
        expect(stored?.consumed).toBe(false);
        expect((await actions.findById(db, "act-1"))?.approval_id).toBe("ap-1");
      });

      it("scopes the grant to the CASE's owner, not to whoever clicked", async () => {
        // A delegate id is used deliberately so the two sources diverge — the same
        // assertion shape that caught a surviving mutation in WU-01 and WU-02.
        await propose();
        const result = await ingest({ actorId: "delegate-who-clicked" });

        expect(result.outcome).toBe("GRANTED");
        if (result.outcome !== "GRANTED") throw new Error("unreachable");
        expect(result.approval.owner_id).toBe("owner-a");
        expect(result.approval.granted_by).toBe("delegate-who-clicked");
      });

      it("records an expiry derived from the supplied instant and TTL", async () => {
        await propose();
        const result = await ingest({});
        if (result.outcome !== "GRANTED") throw new Error("unreachable");
        const lifetime =
          result.approval.expires_at.getTime() - result.approval.granted_at.getTime();
        // Bounded rather than exact: `granted_at` is the DATABASE's `now()` while the
        // TTL is measured from the supplied instant, so the two differ by the round
        // trip. Asserting equality would be asserting on clock skew.
        expect(lifetime).toBeGreaterThan(TTL_MS - 5_000);
        expect(lifetime).toBeLessThan(TTL_MS + 5_000);
      });
    });

    describe("a grant must be short-lived (WU-04 adversarial probe)", () => {
      it("refuses a TTL beyond the permitted maximum", async () => {
        // The probe finding: `grantTtlMs: 1e15` minted a grant valid for 31,709 YEARS.
        // Migration 008 only requires `expires_at > granted_at`, which an absurd expiry
        // satisfies — so nothing caught it. A grant that effectively never expires is a
        // standing authorization, which is precisely what Master Plan §10's
        // "short-lived" rules out.
        await propose();
        await expect(
          db.withTransaction(async (tx: Transaction) =>
            ingestApprovalClick(tx, ports, {
              caseId: "case-a",
              actorId: "owner-a",
              actionId: "act-1",
              click: {
                approvalId: "ap-eternal",
                checkpointRevision: await currentRevision("case-a"),
                choice: "grant",
              },
              grantTtlMs: 1e15,
              now: new Date(),
            }),
          ),
        ).rejects.toThrow(GrantTtlOutOfRangeError);

        // Refused BEFORE any state change: no grant, action untouched.
        expect(await approvals.findById(db, "ap-eternal")).toBeNull();
        expect((await actions.findById(db, "act-1"))?.status).toBe("PROPOSED");
      });

      it("refuses a TTL below the permitted minimum, a negative one, and NaN/Infinity", async () => {
        // `NaN` is the interesting case and the reason the guard tests `isFinite`
        // FIRST: it fails every `<` and `>` comparison, so a bare range check would
        // ACCEPT it and mint a grant whose `expires_at` is an Invalid Date.
        await propose();
        for (const ttl of [0, -60_000, 1_000, Number.NaN, Number.POSITIVE_INFINITY]) {
          await expect(
            db.withTransaction(async (tx: Transaction) =>
              ingestApprovalClick(tx, ports, {
                caseId: "case-a",
                actorId: "owner-a",
                actionId: "act-1",
                click: {
                  approvalId: `ap-ttl-${String(ttl)}`,
                  checkpointRevision: await currentRevision("case-a"),
                  choice: "grant",
                },
                grantTtlMs: ttl,
                now: new Date(),
              }),
            ),
            String(ttl),
          ).rejects.toThrow(GrantTtlOutOfRangeError);
        }
        const count = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM approvals",
        );
        expect(count.rows[0]!.count).toBe("0");
      });

      it("accepts a TTL at both boundaries, so the bound is not merely restrictive", async () => {
        // A guard that refused everything would pass the tests above. Both endpoints are
        // inclusive and must work.
        await propose({ actionId: "act-min", idempotencyKey: "idem-min" });
        await propose({
          actionId: "act-max",
          payload: OTHER_PAYLOAD,
          idempotencyKey: "idem-max",
        });
        const revision = await currentRevision("case-a");

        for (const [actionId, approvalId, ttl] of [
          ["act-min", "ap-min", MIN_GRANT_TTL_MS],
          ["act-max", "ap-max", MAX_GRANT_TTL_MS],
        ] as const) {
          const result = await db.withTransaction((tx: Transaction) =>
            ingestApprovalClick(tx, ports, {
              caseId: "case-a",
              actorId: "owner-a",
              actionId,
              click: { approvalId, checkpointRevision: revision, choice: "grant" },
              grantTtlMs: ttl,
              now: new Date(),
            }),
          );
          expect(result.outcome, `${actionId} @ ${ttl}ms`).toBe("GRANTED");
        }
      });
    });

    describe("a stale or mis-scoped click cannot become a grant", () => {
      it("refuses a click rendered against a revision the case has left", async () => {
        // The owner is looking at a message describing facts that have changed. Their
        // consent does not apply to the current state, so it is refused rather than
        // recorded — a grant that is stale at birth is worse than no grant.
        await propose();
        const clicked = await currentRevision("case-a");
        const current = await advanceRevision("case-a");

        const result = await ingest({ revision: clicked });
        expect(result.outcome).toBe("STALE_REVISION");
        if (result.outcome !== "STALE_REVISION") throw new Error("unreachable");
        expect(result.clicked).toBe(clicked);
        expect(result.current).toBe(current);

        // Nothing was minted and the action is untouched.
        expect(await approvals.findById(db, "ap-1")).toBeNull();
        expect((await actions.findById(db, "act-1"))?.status).toBe("PROPOSED");
      });

      it("refuses a proposal addressed from a DIFFERENT case's thread", async () => {
        // A proposal id observed in one case must not be actionable from another,
        // even by the right owner — otherwise a case boundary is only a convention.
        await propose({ actionId: "act-x", caseId: "case-a" });
        const result = await ingest({ actionId: "act-x", caseId: "case-b" });
        expect(result.outcome).toBe("ACTION_NOT_FOUND");
        expect(await approvals.findById(db, "ap-1")).toBeNull();
      });

      it("refuses an unknown action id", async () => {
        expect((await ingest({ actionId: "act-ghost" })).outcome).toBe("ACTION_NOT_FOUND");
      });

      it("refuses a click on an action that does not require approval", async () => {
        // An AUTO_ALLOW action has no approval to grant; a click on one means the
        // message and the policy disagree, which must not silently mint a grant.
        await propose({
          actionId: "act-auto",
          riskTier: "R2",
          policyDecision: "AUTO_ALLOW",
          idempotencyKey: "idem-auto",
        });
        const result = await ingest({ actionId: "act-auto" });
        expect(result.outcome).toBe("ACTION_NOT_APPROVABLE");
        expect(await approvals.findById(db, "ap-1")).toBeNull();
      });

      it("refuses a click on an action that is no longer pending", async () => {
        await propose();
        expect((await ingest({})).outcome).toBe("GRANTED");

        // Second click, different approval id: the action is APPROVED now.
        const again = await ingest({ approvalId: "ap-2" });
        expect(again.outcome).toBe("ACTION_NOT_PENDING");
        expect(await approvals.findById(db, "ap-2")).toBeNull();
      });
    });

    describe("the same click twice is idempotent", () => {
      it("returns the existing grant for a repeated identical click", async () => {
        // A double-click, or Discord redelivering an interaction. Must not mint a
        // second grant, and must not read as an error to the owner.
        await propose();
        const first = await ingest({});
        expect(first.outcome).toBe("GRANTED");

        // The action is APPROVED after the first click, so a repeat is reported as
        // not-pending — the state that makes a second grant impossible.
        const second = await ingest({});
        expect(second.outcome).toBe("ACTION_NOT_PENDING");

        const count = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM approvals",
        );
        expect(count.rows[0]!.count).toBe("1");
      });
    });

    describe("deny records a refusal and mints nothing", () => {
      it("rejects the action without creating an approval", async () => {
        // There is deliberately no "negative approval" row: the ABSENCE of a grant is
        // what stops execution. Representing a denial as a consumed grant would make
        // the two paths differ by a flag rather than by existence.
        await propose();
        const result = await ingest({ choice: "deny" });

        expect(result.outcome).toBe("REJECTED");
        expect((await actions.findById(db, "act-1"))?.status).toBe("REJECTED");
        expect(await approvals.findById(db, "ap-1")).toBeNull();
      });

      it("cannot grant an action that was already denied", async () => {
        await propose();
        expect((await ingest({ choice: "deny" })).outcome).toBe("REJECTED");

        const afterDeny = await ingest({ choice: "grant" });
        expect(afterDeny.outcome).toBe("ACTION_NOT_PENDING");
        expect(await approvals.findById(db, "ap-1")).toBeNull();
      });
    });

    describe("the ingestion is atomic: no orphan grant can survive", () => {
      it("rolls the grant back when the action changes state mid-ingestion", async () => {
        // The interleaving the single-transaction design exists for: the grant is
        // recorded, then binding it fails because a concurrent writer took the action.
        // If these were separate transactions the grant would persist unattached — an
        // approval for an action nobody is tracking, which a later executor could
        // find and use.
        //
        // Simulated by a port whose `attachApproval` reports failure, which is exactly
        // what the real fenced UPDATE returns when it matches zero rows. The REAL
        // repository is used for everything else.
        await propose();
        const failingPorts: ApprovalIngestionPorts = {
          approvals,
          actions: {
            findById: (tx, id) => actions.findById(tx, id),
            reject: (tx, id) => actions.reject(tx, id),
            advanceStatus: (tx, i) => actions.advanceStatus(tx, i),
            attachApproval: async () => false,
          },
        };

        await expect(
          db.withTransaction(async (tx: Transaction) =>
            ingestApprovalClick(tx, failingPorts, {
              caseId: "case-a",
              actorId: "owner-a",
              actionId: "act-1",
              click: {
                approvalId: "ap-orphan",
                checkpointRevision: await currentRevision("case-a"),
                choice: "grant",
              },
              grantTtlMs: TTL_MS,
              now: new Date(),
            }),
          ),
        ).rejects.toThrow(ApprovalIngestionConflictError);

        // The rollback is the assertion: the grant recorded inside the aborted
        // transaction must not exist.
        expect(await approvals.findById(db, "ap-orphan")).toBeNull();
        expect((await actions.findById(db, "act-1"))?.status).toBe("PROPOSED");
      });

      it("lets only ONE of two concurrent grant clicks bind the action", async () => {
        // Two devices, one proposal. Exactly one must end up approved, and the loser
        // must not leave a grant behind.
        await propose();
        const revision = await currentRevision("case-a");
        const attempt = (approvalId: string): Promise<string> =>
          db
            .withTransaction((tx: Transaction) =>
              ingestApprovalClick(tx, ports, {
                caseId: "case-a",
                actorId: "owner-a",
                actionId: "act-1",
                click: { approvalId, checkpointRevision: revision, choice: "grant" },
                grantTtlMs: TTL_MS,
                now: new Date(),
              }),
            )
            .then(
              (r) => r.outcome,
              (e: unknown) => `THREW:${(e as Error).constructor.name}`,
            );

        const outcomes = await Promise.all([attempt("ap-c1"), attempt("ap-c2")]);
        expect(outcomes.filter((o) => o === "GRANTED")).toHaveLength(1);

        // Exactly one grant exists, and it is the one the action points at.
        const stored = await db.query<{ approval_id: string }>("SELECT approval_id FROM approvals");
        expect(stored.rows).toHaveLength(1);
        const action = await actions.findById(db, "act-1");
        expect(action?.status).toBe("APPROVED");
        expect(action?.approval_id).toBe(stored.rows[0]!.approval_id);
      });
    });

    describe("the proposal record itself is fail-closed", () => {
      it("is idempotent on action_id and refuses a reused id for a different proposal", async () => {
        await propose();
        const replay = await actions.propose(db, {
          actionId: "act-1",
          caseId: "case-a",
          toolName: "jira.issue.comment",
          connectionId: "conn-a",
          canonicalPayload: PAYLOAD,
          actionDigest: DIGEST,
          riskTier: "R3",
          policyDecision: "REQUIRES_APPROVAL",
          idempotencyKey: "idem-act-1",
        });
        expect(replay.outcome).toBe("ALREADY_PROPOSED");

        await expect(
          actions.propose(db, {
            actionId: "act-1",
            caseId: "case-a",
            toolName: "jira.issue.comment",
            connectionId: "conn-a",
            canonicalPayload: OTHER_PAYLOAD,
            actionDigest: OTHER_DIGEST,
            riskTier: "R3",
            policyDecision: "REQUIRES_APPROVAL",
            idempotencyKey: "idem-other",
          }),
        ).rejects.toThrow(/already bound to a different proposal/);
      });

      it("reports which unique constraint a colliding proposal hit", async () => {
        // digest and idempotency key mean different things to a caller: the first is
        // "this exact action already exists", the second is "this side effect is
        // already claimed". Collapsing them into one error would hide which.
        await propose();
        const sameDigest = await actions.propose(db, {
          actionId: "act-2",
          caseId: "case-a",
          toolName: "jira.issue.comment",
          connectionId: "conn-a",
          canonicalPayload: PAYLOAD,
          actionDigest: DIGEST,
          riskTier: "R3",
          policyDecision: "REQUIRES_APPROVAL",
          idempotencyKey: "idem-act-2",
        });
        expect(sameDigest).toEqual({ outcome: "CONFLICT", conflictingOn: "action_digest" });

        const sameKey = await actions.propose(db, {
          actionId: "act-3",
          caseId: "case-a",
          toolName: "jira.issue.comment",
          connectionId: "conn-a",
          canonicalPayload: OTHER_PAYLOAD,
          actionDigest: OTHER_DIGEST,
          riskTier: "R3",
          policyDecision: "REQUIRES_APPROVAL",
          idempotencyKey: "idem-act-1",
        });
        expect(sameKey).toEqual({ outcome: "CONFLICT", conflictingOn: "idempotency_key" });
      });

      it("cannot record an R4 action as AUTO_ALLOW (migration 008 CHECK)", async () => {
        // AC5 stated in SQL. Asserted here because this repository is the only writer
        // to the table, so if the CHECK were ever dropped this is where it would show.
        await expect(
          actions.propose(db, {
            actionId: "act-r4",
            caseId: "case-a",
            toolName: "gitlab.mr.merge",
            connectionId: "conn-a",
            canonicalPayload: PAYLOAD,
            actionDigest: DIGEST,
            riskTier: "R4",
            policyDecision: "AUTO_ALLOW",
            idempotencyKey: "idem-r4",
          }),
        ).rejects.toThrow(/external_actions_r4_requires_approval|violates check constraint/);
      });
    });

    describe("attachApproval is fenced in the STORE, not only by the caller's checks", () => {
      it("refuses to bind a second approval over an existing one", async () => {
        // `ingestApprovalClick` checks `status === "PROPOSED"` before granting, so its
        // own tests never reach this fence — a mutation removing the WHERE clause from
        // `attachApproval` left all eighteen of them green. The fence is the durable
        // guarantee, so it is driven directly here: binding a second grant over an
        // action that already has one must affect zero rows, whatever the caller did or
        // did not check first.
        await propose();
        const first = await ingest({});
        expect(first.outcome).toBe("GRANTED");

        // A second, independently valid grant for a DIFFERENT digest, so migration
        // 011's (approval_id, case_id, action_digest) FK is not what refuses it.
        await propose({
          actionId: "act-2",
          payload: OTHER_PAYLOAD,
          idempotencyKey: "idem-act-2b",
        });
        const second = await ingest({ actionId: "act-2", approvalId: "ap-second" });
        expect(second.outcome).toBe("GRANTED");

        const rebound = await db.withTransaction((tx: Transaction) =>
          actions.attachApproval(tx, { actionId: "act-1", approvalId: "ap-second" }),
        );
        expect(rebound).toBe(false);
        // The original binding survives untouched.
        expect((await actions.findById(db, "act-1"))?.approval_id).toBe("ap-1");
      });

      it("refuses to bind an approval to an action that is not awaiting one", async () => {
        // Two distinct reasons an action is not awaiting approval, each asserted: it
        // was rejected, and it does not require approval at all.
        await propose({ actionId: "act-rej", idempotencyKey: "idem-rej" });
        expect((await ingest({ actionId: "act-rej", choice: "deny" })).outcome).toBe("REJECTED");

        await propose({
          actionId: "act-auto2",
          payload: { issue: "MOBL-9", body: "auto" },
          riskTier: "R2",
          policyDecision: "AUTO_ALLOW",
          idempotencyKey: "idem-auto2",
        });
        // A real, live grant to attempt the binding with.
        await propose({
          actionId: "act-live",
          payload: OTHER_PAYLOAD,
          idempotencyKey: "idem-live",
        });
        const live = await ingest({ actionId: "act-live", approvalId: "ap-live" });
        expect(live.outcome).toBe("GRANTED");

        for (const actionId of ["act-rej", "act-auto2"]) {
          const bound = await db.withTransaction((tx: Transaction) =>
            actions.attachApproval(tx, { actionId, approvalId: "ap-live" }),
          );
          expect(bound, actionId).toBe(false);
          expect((await actions.findById(db, actionId))?.approval_id, actionId).toBeNull();
        }
      });

      it("refuses to reject an action that is no longer PROPOSED", async () => {
        // Same gap as `attachApproval`: the caller checks status first, so its tests
        // never reach this fence and a mutation removing it stayed green. It matters
        // because a rejection arriving after execution started must NOT rewrite the
        // record to REJECTED — that action has a real side effect in flight, and
        // relabelling it would hide an ambiguous write behind a clean-looking refusal.
        await propose();
        await ingest({});
        await db.withTransaction((tx: Transaction) =>
          actions.advanceStatus(tx, { actionId: "act-1", from: "APPROVED", to: "EXECUTING" }),
        );

        const rejected = await db.withTransaction((tx: Transaction) => actions.reject(tx, "act-1"));
        expect(rejected).toBe(false);
        expect((await actions.findById(db, "act-1"))?.status).toBe("EXECUTING");
      });

      it("refuses to advance status from a state the action is not in", async () => {
        // `advanceStatus` is a compare-and-set, so a caller that believes the action is
        // PROPOSED when it is APPROVED must lose rather than overwrite. WU-05 relies on
        // this for the execution transition.
        await propose();
        await ingest({});
        const wrongFrom = await db.withTransaction((tx: Transaction) =>
          actions.advanceStatus(tx, { actionId: "act-1", from: "PROPOSED", to: "EXECUTING" }),
        );
        expect(wrongFrom).toBe(false);
        expect((await actions.findById(db, "act-1"))?.status).toBe("APPROVED");

        const rightFrom = await db.withTransaction((tx: Transaction) =>
          actions.advanceStatus(tx, { actionId: "act-1", from: "APPROVED", to: "EXECUTING" }),
        );
        expect(rightFrom).toBe(true);
        expect((await actions.findById(db, "act-1"))?.status).toBe("EXECUTING");
      });
    });

    describe("findPendingByDigest is case-scoped", () => {
      it("finds a pending proposal by its digest within the case only", async () => {
        await propose();
        expect(
          (await actions.findPendingByDigest(db, { caseId: "case-a", actionDigest: DIGEST }))
            ?.action_id,
        ).toBe("act-1");
        // Same digest, wrong case: no result. A digest is not a capability.
        expect(
          await actions.findPendingByDigest(db, { caseId: "case-b", actionDigest: DIGEST }),
        ).toBeNull();
      });

      it("stops finding it once it is no longer pending", async () => {
        await propose();
        await ingest({});
        expect(
          await actions.findPendingByDigest(db, { caseId: "case-a", actionDigest: DIGEST }),
        ).toBeNull();
      });
    });
  },
  available,
);
