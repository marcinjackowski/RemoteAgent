/**
 * RA-022-WU-05 — the action executor, against a REAL PostgreSQL and a FAKE provider.
 *
 * **No live external write happens anywhere in this suite.** Every provider call goes
 * to an in-process adapter that records what it was asked to do, which is what lets the
 * ambiguous-write cases be provoked deliberately instead of waited for.
 *
 * The four criteria this unit carries are all about ORDER and ATOMICITY, so the
 * assertions are mostly about what is durable AFTER a step, not about return values:
 *
 *  * AC3 — policy is re-evaluated immediately before the side effect, and must AGREE
 *    with the proposal-time evaluation.
 *  * AC4 — an unconfirmed provider result is AMBIGUOUS, never SUCCEEDED, and is never
 *    blind-retried.
 *  * AC6 — a kill switch flipped between approval and execute still stops the write,
 *    because it is read in the transaction that consumes the approval.
 *  * AC7 — a receipt binds action, provider result and external entity version.
 */
import { canonicalDigest } from "@remoteagent/contracts";

// Relative import for the package-cycle reason recorded in WU-01.
import {
  ApprovalRepository,
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  Database,
  ExternalActionRepository,
  KillSwitchRepository,
  OwnerRepository,
  ReceiptRepository,
} from "../../database/src/index.js";
import type { Transaction } from "../../database/src/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executeAction, reconcileAmbiguousAction } from "../src/action-executor.js";
import type {
  ExecutorPorts,
  ProviderAdapter,
  ProviderOutcome,
  ProviderReceipt,
} from "../src/action-executor.js";
import { evaluatePolicy, toPolicyKillSwitches } from "../src/policy-engine.js";
import type { PolicyEvaluation } from "../src/policy-engine.js";
import { ingestApprovalClick } from "../src/approval-ingestion.js";
import { createTestDatabase } from "../../database/test/harness.js";
import { describeIntegration, ensurePostgres } from "../../database/test/integration-base.js";

const available = await ensurePostgres();

const PAYLOAD = { issue: "MOBL-7", body: "the comment the owner approved" };
const DIGEST = canonicalDigest(PAYLOAD);
const AUTO_PAYLOAD = { draft: "MOBL-7", body: "a draft nobody outside can see" };

const RECEIPT: ProviderReceipt = {
  externalId: "10042",
  entityVersion: "2026-08-21T12:00:00.000+0000",
  entityVersionField: "fields.updated",
  status: "created",
};

describeIntegration(
  "RA-022-WU-05 action executor (real PostgreSQL, fake provider)",
  () => {
    let db: Database;
    let drop: () => Promise<void>;

    const approvals = new ApprovalRepository();
    const actions = new ExternalActionRepository();
    const receipts = new ReceiptRepository();
    const killSwitches = new KillSwitchRepository();

    /** Real repositories behind the structural ports; see the WU-04 suite's note. */
    const ports: ExecutorPorts = {
      approvals,
      actions,
      receipts,
      killSwitches,
      now: async (tx) => {
        const r = (await tx.query("SELECT now() AS n")) as { rows: { n: Date }[] };
        return r.rows[0]!.n;
      },
    };

    const runInTransaction = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
      db.withTransaction(fn);

    /** Records every call, so "was the provider even asked?" is assertable. */
    interface FakeProvider {
      adapter: ProviderAdapter;
      calls: { toolName: string; idempotencyKey: string }[];
    }

    function fakeProvider(
      outcome: ProviderOutcome | (() => Promise<ProviderOutcome>),
    ): FakeProvider {
      const calls: { toolName: string; idempotencyKey: string }[] = [];
      return {
        calls,
        adapter: async (input) => {
          calls.push({ toolName: input.toolName, idempotencyKey: input.idempotencyKey });
          return typeof outcome === "function" ? outcome() : outcome;
        },
      };
    }

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => drop());

    beforeEach(async () => {
      await db.query(
        `TRUNCATE kill_switch_events, receipts, external_actions, approvals,
           case_checkpoints, case_connections, cases, connections, owners
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

    async function currentRevision(): Promise<number> {
      const r = await db.query<{ checkpoint_revision: number }>(
        `SELECT checkpoint_revision FROM cases WHERE case_id = 'case-a'`,
      );
      return r.rows[0]!.checkpoint_revision;
    }

    /** The policy snapshot, evaluated the way the proposal path does. */
    async function evaluateNow(
      overrides: {
        toolName?: string;
        killSwitchRows?: Parameters<typeof toPolicyKillSwitches>[0];
      } = {},
    ): Promise<PolicyEvaluation> {
      const rows =
        overrides.killSwitchRows ??
        (await killSwitches.listEffective(db, {
          ownerId: "owner-a",
          provider: "jira",
          connectionId: "conn-a",
        }));
      const now = await db.query<{ n: Date }>("SELECT now() AS n").then((r) => r.rows[0]!.n);
      return evaluatePolicy({
        toolName: overrides.toolName ?? "jira.issue.comment",
        caseId: "case-a",
        ownerId: "owner-a",
        provider: "jira",
        connectionId: "conn-a",
        caseConnectionIds: ["conn-a"],
        connectionHealth: "HEALTHY",
        credentialExpiresAt: null,
        killSwitches: toPolicyKillSwitches(rows as Parameters<typeof toPolicyKillSwitches>[0]),
        now,
      });
    }

    /** Propose an R3 action and grant its approval, i.e. the state before execute. */
    async function proposeAndApprove(
      options: { actionId?: string; approvalId?: string } = {},
    ): Promise<void> {
      const actionId = options.actionId ?? "act-1";
      const result = await actions.propose(db, {
        actionId,
        caseId: "case-a",
        toolName: "jira.issue.comment",
        connectionId: "conn-a",
        canonicalPayload: PAYLOAD,
        actionDigest: DIGEST,
        riskTier: "R3",
        policyDecision: "REQUIRES_APPROVAL",
        idempotencyKey: `idem-${actionId}`,
      });
      if (result.outcome !== "PROPOSED") throw new Error(result.outcome);

      const revision = await currentRevision();
      const granted = await db.withTransaction((tx: Transaction) =>
        ingestApprovalClick(
          tx,
          { approvals, actions },
          {
            caseId: "case-a",
            actorId: "owner-a",
            actionId,
            click: {
              approvalId: options.approvalId ?? "ap-1",
              checkpointRevision: revision,
              choice: "grant",
            },
            grantTtlMs: 900_000,
            now: new Date(),
          },
        ),
      );
      if (granted.outcome !== "GRANTED") throw new Error(granted.outcome);
    }

    /** Propose an R2 AUTO_ALLOW action, which executes without an approval. */
    async function proposeAutoAllow(actionId = "act-auto"): Promise<void> {
      const result = await actions.propose(db, {
        actionId,
        caseId: "case-a",
        toolName: "gmail.draft.create",
        connectionId: "conn-a",
        canonicalPayload: AUTO_PAYLOAD,
        actionDigest: canonicalDigest(AUTO_PAYLOAD),
        riskTier: "R2",
        policyDecision: "AUTO_ALLOW",
        idempotencyKey: `idem-${actionId}`,
      });
      if (result.outcome !== "PROPOSED") throw new Error(result.outcome);
    }

    function execute(input: {
      actionId?: string;
      provider?: FakeProvider;
      evaluationAtProposal: PolicyEvaluation;
      caseConnectionIds?: readonly string[];
      connectionHealth?: "HEALTHY" | "EXPIRED" | "REVOKED" | "ERROR";
      credentialExpiresAt?: Date | null;
      receiptId?: string;
    }): Promise<Awaited<ReturnType<typeof executeAction>>> {
      const provider = input.provider ?? fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });
      return executeAction(runInTransaction, ports, provider.adapter, {
        actionId: input.actionId ?? "act-1",
        provider: "jira",
        caseConnectionIds: input.caseConnectionIds ?? ["conn-a"],
        connectionHealth: input.connectionHealth ?? "HEALTHY",
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        evaluationAtProposal: input.evaluationAtProposal,
        receiptId: input.receiptId ?? "rc-1",
      });
    }

    describe("the happy path binds a receipt to the action and the entity version (AC7)", () => {
      it("consumes the approval, writes once, and records a complete receipt", async () => {
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const provider = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });

        const result = await execute({ evaluationAtProposal: atProposal, provider });

        expect(result.outcome).toBe("SUCCEEDED");
        // Called exactly once. A second call would be a double external write.
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.idempotencyKey).toBe("idem-act-1");

        expect((await actions.findById(db, "act-1"))?.status).toBe("SUCCEEDED");
        // AC2: the grant is spent, so it cannot authorize a second execution.
        expect((await approvals.findById(db, "ap-1"))?.consumed).toBe(true);

        // AC7: the receipt binds action, provider result AND entity version.
        const receipt = await receipts.findByAction(db, "act-1");
        expect(receipt?.action_id).toBe("act-1");
        expect(receipt?.external_id).toBe(RECEIPT.externalId);
        expect(receipt?.entity_version).toBe(RECEIPT.entityVersion);
        expect(receipt?.entity_version_field).toBe(RECEIPT.entityVersionField);
      });

      it("executes an AUTO_ALLOW action with no approval at all", async () => {
        // R2 takes the PROPOSED -> EXECUTING shortcut. Asserted because the executor
        // must not demand an approval that policy never required — that would make
        // auto-allow unusable and push callers toward bypassing the executor.
        await proposeAutoAllow();
        const atProposal = await evaluateNow({ toolName: "gmail.draft.create" });
        const provider = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });

        const result = await executeAction(runInTransaction, ports, provider.adapter, {
          actionId: "act-auto",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: atProposal,
          receiptId: "rc-auto",
        });

        expect(result.outcome).toBe("SUCCEEDED");
        expect((await actions.findById(db, "act-auto"))?.status).toBe("SUCCEEDED");
        const count = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM approvals",
        );
        expect(count.rows[0]!.count).toBe("0");
      });
    });

    describe("a kill switch between approval and execute stops the write (AC6)", () => {
      it("refuses, does not call the provider, and leaves the grant UNSPENT", async () => {
        // The AC6 race, exactly: the approval is granted, THEN the operator stops the
        // system, THEN execution is attempted. The switch is read in the same
        // transaction that would consume the grant, so the whole thing rolls back.
        //
        // "Grant unspent" is the load-bearing half. If the consumption committed and
        // only the write was skipped, the owner's consent would be destroyed by an
        // operator stop and they would have to approve again for no reason.
        await proposeAndApprove();
        const atProposal = await evaluateNow();

        await killSwitches.append(db, {
          eventId: "ks-stop",
          level: "GLOBAL",
          enabled: true,
          reason: "operator stop between approval and execute",
          changedBy: "owner-a",
        });

        const provider = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });
        const result = await execute({ evaluationAtProposal: atProposal, provider });

        expect(result.outcome).toBe("POLICY_DENIED");
        if (result.outcome !== "POLICY_DENIED") throw new Error("unreachable");
        expect(result.evaluation.refusalCode).toBe("KILL_SWITCH_ACTIVE");

        // Nothing was sent, nothing was spent, nothing moved.
        expect(provider.calls).toHaveLength(0);
        expect((await approvals.findById(db, "ap-1"))?.consumed).toBe(false);
        expect((await actions.findById(db, "act-1"))?.status).toBe("APPROVED");
        expect(await receipts.findByAction(db, "act-1")).toBeNull();
      });

      it("still executes after the switch is withdrawn, but reports the policy change first", async () => {
        // A stop that was appended and then lifted leaves an append-only trail, so the
        // pre-execute snapshot differs from the proposal-time one even though both
        // permit. AC3 says that is a policy CHANGE and execution must stop — the owner
        // consented under different circumstances.
        await proposeAndApprove();
        const atProposal = await evaluateNow();

        await killSwitches.append(db, {
          eventId: "ks-on",
          level: "GLOBAL",
          enabled: true,
          reason: "stop",
          changedBy: "owner-a",
        });
        await killSwitches.append(db, {
          eventId: "ks-off",
          level: "GLOBAL",
          enabled: false,
          reason: "resume",
          changedBy: "owner-a",
        });

        const provider = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });
        const result = await execute({ evaluationAtProposal: atProposal, provider });

        expect(result.outcome).toBe("POLICY_CHANGED");
        expect(provider.calls).toHaveLength(0);
        expect((await approvals.findById(db, "ap-1"))?.consumed).toBe(false);

        // Re-proposing against the CURRENT snapshot then works: the mechanism refuses a
        // changed world, not the action itself.
        const fresh = await evaluateNow();
        const retried = await execute({ evaluationAtProposal: fresh, provider });
        expect(retried.outcome).toBe("SUCCEEDED");
      });
    });

    describe("policy is re-decided immediately before the side effect (AC3)", () => {
      it("refuses when the credential was revoked after the approval", async () => {
        await proposeAndApprove();
        const atProposal = await evaluateNow();

        const result = await execute({
          evaluationAtProposal: atProposal,
          connectionHealth: "REVOKED",
        });
        expect(result.outcome).toBe("POLICY_DENIED");
        if (result.outcome !== "POLICY_DENIED") throw new Error("unreachable");
        expect(result.evaluation.refusalCode).toBe("CONNECTION_BLOCKED");
        expect((await approvals.findById(db, "ap-1"))?.consumed).toBe(false);
      });

      it("refuses when the connection left the case's scope after the approval", async () => {
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const result = await execute({ evaluationAtProposal: atProposal, caseConnectionIds: [] });
        expect(result.outcome).toBe("POLICY_DENIED");
        if (result.outcome !== "POLICY_DENIED") throw new Error("unreachable");
        expect(result.evaluation.refusalCode).toBe("CONNECTION_OUT_OF_SCOPE");
      });

      it("refuses when the credential expires against the DATABASE clock", async () => {
        // The executor reads `now()` from the store rather than the process, which is
        // where `PolicyInput.now`'s documented gap is closed. A worker with a skewed
        // clock cannot make an expired credential look live.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const dbNow = await db.query<{ n: Date }>("SELECT now() AS n").then((r) => r.rows[0]!.n);

        const result = await execute({
          evaluationAtProposal: atProposal,
          credentialExpiresAt: new Date(dbNow.getTime() - 60_000),
        });
        expect(result.outcome).toBe("POLICY_DENIED");
        if (result.outcome !== "POLICY_DENIED") throw new Error("unreachable");
        expect(result.evaluation.refusalCode).toBe("CONNECTION_BLOCKED");
      });

      it("refuses when the case advanced, because the grant is then stale", async () => {
        // AC2 at the execution boundary: the grant was made at revision N and the case
        // is at N+1, so `consume` refuses and the executor reports the store's own code
        // rather than proceeding.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const from = await currentRevision();
        await db.withTransaction((tx) =>
          new CheckpointRepository().append(tx, {
            caseId: "case-a",
            expectedRevision: from,
            checkpoint: {
              schema_version: "1.0.0",
              case_id: "case-a",
              revision: from + 1,
              goal: "advance after approval",
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

        const provider = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });
        const result = await execute({ evaluationAtProposal: atProposal, provider });

        expect(result.outcome).toBe("APPROVAL_REFUSED");
        if (result.outcome !== "APPROVAL_REFUSED") throw new Error("unreachable");
        expect(result.reason).toBe("STALE_REVISION");
        expect(provider.calls).toHaveLength(0);
        expect((await approvals.findById(db, "ap-1"))?.consumed).toBe(false);
      });
    });

    describe("an unconfirmed write is AMBIGUOUS and is never replayed (AC4)", () => {
      it("records AMBIGUOUS with no receipt when the provider times out", async () => {
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const provider = fakeProvider({ kind: "UNCONFIRMED", reason: "socket timeout after send" });

        const result = await execute({ evaluationAtProposal: atProposal, provider });

        expect(result.outcome).toBe("AMBIGUOUS");
        expect((await actions.findById(db, "act-1"))?.status).toBe("AMBIGUOUS");
        // No receipt: the contract forbids one outside SUCCEEDED, and inventing one
        // would assert a version nobody observed.
        expect(await receipts.findByAction(db, "act-1")).toBeNull();
        // The grant IS spent: the write may have happened, so the consent has been
        // used. Leaving it live would permit a second attempt.
        expect((await approvals.findById(db, "ap-1"))?.consumed).toBe(true);
      });

      it("treats an adapter that THREW as ambiguous, not as failed", async () => {
        // A thrown error says nothing about whether the request left the process.
        // Reporting FAILED would license a retry of a write that may already exist —
        // the single most expensive mistake available in this module.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const provider = fakeProvider(() => Promise.reject(new Error("ECONNRESET")));

        const result = await execute({ evaluationAtProposal: atProposal, provider });

        expect(result.outcome).toBe("AMBIGUOUS");
        if (result.outcome !== "AMBIGUOUS") throw new Error("unreachable");
        expect(result.reason).toMatch(/ECONNRESET/);
        expect((await actions.findById(db, "act-1"))?.status).toBe("AMBIGUOUS");
      });

      it("refuses to execute an AMBIGUOUS action again", async () => {
        // The no-blind-replay rule. A second execute attempt must not reach the
        // provider, because the first may already have landed.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        await execute({
          evaluationAtProposal: atProposal,
          provider: fakeProvider({ kind: "UNCONFIRMED", reason: "timeout" }),
        });

        const retry = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });
        const second = await execute({ evaluationAtProposal: atProposal, provider: retry });

        expect(second.outcome).toBe("NOT_EXECUTABLE");
        if (second.outcome !== "NOT_EXECUTABLE") throw new Error("unreachable");
        expect(second.status).toBe("AMBIGUOUS");
        expect(retry.calls).toHaveLength(0);
      });

      it("records AMBIGUOUS when the write succeeded but the receipt could not be stored", async () => {
        // The WU-05 probe finding, and the worst state the executor could produce: the
        // action was left in EXECUTING. `reconcileAmbiguousAction` only accepts
        // AMBIGUOUS, so nothing would ever settle it, and an operator seeing "executing"
        // for hours would reasonably re-run the action — repeating an external write
        // that had already succeeded.
        //
        // Provoked here with a receipt port that throws, which is what a real malformed
        // receipt does: migration 031's CHECK rejects an empty entity version, and the
        // probe hit exactly that path with an adapter returning `entityVersion: ""`.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const failingReceipts: ExecutorPorts = {
          ...ports,
          receipts: { record: () => Promise.reject(new Error("receipt rejected by CHECK")) },
        };

        const result = await executeAction(
          runInTransaction,
          failingReceipts,
          async () => ({ kind: "CONFIRMED", receipt: RECEIPT }),
          {
            actionId: "act-1",
            provider: "jira",
            caseConnectionIds: ["conn-a"],
            connectionHealth: "HEALTHY",
            credentialExpiresAt: null,
            evaluationAtProposal: atProposal,
            receiptId: "rc-fails",
          },
        );

        expect(result.outcome).toBe("AMBIGUOUS");
        if (result.outcome !== "AMBIGUOUS") throw new Error("unreachable");
        expect(result.reason).toMatch(/receipt could not be recorded/);
        // AMBIGUOUS, never left EXECUTING — this is the assertion the probe forced.
        expect((await actions.findById(db, "act-1"))?.status).toBe("AMBIGUOUS");
        expect(await receipts.findByAction(db, "act-1")).toBeNull();
        // And it is now reconcilable, which EXECUTING never was.
        const settled = await reconcileAmbiguousAction(
          runInTransaction,
          ports,
          () =>
            Promise.resolve({
              found: true,
              receipt: RECEIPT,
              matchedIdempotencyKey: "idem-act-1",
            }),
          { actionId: "act-1", receiptId: "rc-settled" },
        );
        expect(settled.outcome).toBe("RECONCILED_SUCCEEDED");
      });

      it("records AMBIGUOUS when the adapter returns an unusable entity version", async () => {
        // The concrete shape the probe used: an adapter that confirms but supplies an
        // empty version. Migration 031's CHECK refuses the receipt, so there is no proof
        // of a write that did happen — ambiguous by definition, and asserted through the
        // REAL receipt repository rather than a stub.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const result = await executeAction(
          runInTransaction,
          ports,
          async () => ({
            kind: "CONFIRMED",
            receipt: { externalId: "10042", entityVersion: "", entityVersionField: "" },
          }),
          {
            actionId: "act-1",
            provider: "jira",
            caseConnectionIds: ["conn-a"],
            connectionHealth: "HEALTHY",
            credentialExpiresAt: null,
            evaluationAtProposal: atProposal,
            receiptId: "rc-empty",
          },
        );

        expect(result.outcome).toBe("AMBIGUOUS");
        expect((await actions.findById(db, "act-1"))?.status).toBe("AMBIGUOUS");
      });

      it("records FAILED, not AMBIGUOUS, for a definite provider refusal", async () => {
        // A refusal BEFORE any effect is safe to retry, and must be distinguishable
        // from an ambiguous one — collapsing the two would either forbid safe retries
        // or permit unsafe ones.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const provider = fakeProvider({ kind: "REFUSED", reason: "400 invalid issue key" });

        const result = await execute({ evaluationAtProposal: atProposal, provider });
        expect(result.outcome).toBe("FAILED");
        expect((await actions.findById(db, "act-1"))?.status).toBe("FAILED");
        expect(await receipts.findByAction(db, "act-1")).toBeNull();
      });
    });

    describe("the intent is committed BEFORE the side effect", () => {
      it("has already durably recorded EXECUTING by the time the provider is called", async () => {
        // The ordering that makes a crash recoverable. If the provider were called
        // first and the status written afterwards, a crash in between would lose the
        // write entirely — the action would still look APPROVED, an operator would
        // re-run it, and the external effect would happen twice with nothing recording
        // the first attempt.
        //
        // Asserted by READING the action from a SEPARATE connection while the adapter
        // is executing. A separate connection sees only COMMITTED data, so observing
        // EXECUTING there proves transaction 1 committed before the call — which is why
        // the executor uses two transactions with the provider strictly between them.
        await proposeAndApprove();
        const atProposal = await evaluateNow();

        let statusDuringCall: string | undefined;
        const adapter: ProviderAdapter = async () => {
          statusDuringCall = (await actions.findById(db, "act-1"))?.status;
          return { kind: "CONFIRMED", receipt: RECEIPT };
        };

        const result = await executeAction(runInTransaction, ports, adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: atProposal,
          receiptId: "rc-order",
        });

        expect(result.outcome).toBe("SUCCEEDED");
        expect(statusDuringCall).toBe("EXECUTING");
      });

      it("has already consumed the approval by the time the provider is called", async () => {
        // Same boundary, for the grant: the consent must be spent BEFORE the write, so
        // a crash mid-call cannot leave a live grant that would authorize a second
        // attempt at a write that may already exist.
        await proposeAndApprove();
        const atProposal = await evaluateNow();

        let consumedDuringCall: boolean | undefined;
        const adapter: ProviderAdapter = async () => {
          consumedDuringCall = (await approvals.findById(db, "ap-1"))?.consumed;
          return { kind: "CONFIRMED", receipt: RECEIPT };
        };

        await executeAction(runInTransaction, ports, adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: atProposal,
          receiptId: "rc-order2",
        });

        expect(consumedDuringCall).toBe(true);
      });

      it("does not hold a transaction open across the provider call", async () => {
        // A provider's latency must not pin a database connection: a slow provider
        // would otherwise become a pool exhaustion, i.e. a database outage caused by
        // someone else's server. Proven by doing real database work from another
        // connection while the adapter is in flight — it must complete promptly rather
        // than block on a lock held by the executor.
        await proposeAndApprove();
        const atProposal = await evaluateNow();

        let concurrentWorkSucceeded = false;
        const adapter: ProviderAdapter = async () => {
          await db.withTransaction(async (tx: Transaction) => {
            await tx.query("SELECT count(*) FROM external_actions");
          });
          concurrentWorkSucceeded = true;
          return { kind: "CONFIRMED", receipt: RECEIPT };
        };

        const result = await executeAction(runInTransaction, ports, adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: atProposal,
          receiptId: "rc-order3",
        });

        expect(result.outcome).toBe("SUCCEEDED");
        expect(concurrentWorkSucceeded).toBe(true);
      });
    });

    describe("reconciliation resolves an ambiguous write by READING the provider", () => {
      async function makeAmbiguous(): Promise<void> {
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        await execute({
          evaluationAtProposal: atProposal,
          provider: fakeProvider({ kind: "UNCONFIRMED", reason: "timeout" }),
        });
      }

      it("confirms SUCCEEDED and writes the receipt when the effect is found", async () => {
        await makeAmbiguous();
        const result = await reconcileAmbiguousAction(
          runInTransaction,
          ports,
          () =>
            Promise.resolve({
              found: true,
              receipt: RECEIPT,
              matchedIdempotencyKey: "idem-act-1",
            }),
          { actionId: "act-1", receiptId: "rc-reconciled" },
        );

        expect(result.outcome).toBe("RECONCILED_SUCCEEDED");
        expect((await actions.findById(db, "act-1"))?.status).toBe("SUCCEEDED");
        const receipt = await receipts.findByAction(db, "act-1");
        // The version is what makes the reconciliation meaningful: it records WHICH
        // state of the entity this action produced, not merely that it exists.
        expect(receipt?.entity_version).toBe(RECEIPT.entityVersion);
      });

      it("confirms FAILED when the provider proves the effect does not exist", async () => {
        await makeAmbiguous();
        const result = await reconcileAmbiguousAction(
          runInTransaction,
          ports,
          () => Promise.resolve({ found: false }),
          { actionId: "act-1", receiptId: "rc-none" },
        );
        expect(result.outcome).toBe("RECONCILED_FAILED");
        expect((await actions.findById(db, "act-1"))?.status).toBe("FAILED");
        expect(await receipts.findByAction(db, "act-1")).toBeNull();
      });

      it("leaves the action AMBIGUOUS when the lookup itself fails", async () => {
        // "I could not check" is not evidence of absence. Resolving it either way would
        // reintroduce the blind retry AC4 forbids.
        await makeAmbiguous();
        const result = await reconcileAmbiguousAction(
          runInTransaction,
          ports,
          () => Promise.reject(new Error("provider unreachable")),
          { actionId: "act-1", receiptId: "rc-x" },
        );
        expect(result.outcome).toBe("STILL_AMBIGUOUS");
        expect((await actions.findById(db, "act-1"))?.status).toBe("AMBIGUOUS");
      });

      it("refuses to settle on an object that is not THIS action's write", async () => {
        // The WU-05 probe finding: a lookup returning an arbitrary receipt had it
        // written straight through, so a buggy or hostile adapter could mark an
        // ambiguous write SUCCEEDED against a completely unrelated object — the
        // reconciler manufacturing the evidence it exists to gather.
        await makeAmbiguous();
        const result = await reconcileAmbiguousAction(
          runInTransaction,
          ports,
          () =>
            Promise.resolve({
              found: true,
              receipt: {
                externalId: "UNRELATED-999",
                entityVersion: "v9",
                entityVersionField: "x",
              },
              matchedIdempotencyKey: "idem-some-other-action",
            }),
          { actionId: "act-1", receiptId: "rc-wrong" },
        );

        expect(result.outcome).toBe("STILL_AMBIGUOUS");
        if (result.outcome !== "STILL_AMBIGUOUS") throw new Error("unreachable");
        expect(result.reason).toMatch(/does not match this action/);
        // Nothing settled, nothing recorded: a mismatched match is no more informative
        // than no match at all.
        expect((await actions.findById(db, "act-1"))?.status).toBe("AMBIGUOUS");
        expect(await receipts.findByAction(db, "act-1")).toBeNull();
      });

      it("refuses to reconcile an action that is not AMBIGUOUS", async () => {
        // Otherwise this path could rewrite a settled outcome — turning a FAILED action
        // into a SUCCEEDED one on the strength of an unrelated provider object.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        await execute({ evaluationAtProposal: atProposal });

        const result = await reconcileAmbiguousAction(
          runInTransaction,
          ports,
          () =>
            Promise.resolve({
              found: true,
              receipt: RECEIPT,
              matchedIdempotencyKey: "idem-act-1",
            }),
          { actionId: "act-1", receiptId: "rc-dup" },
        );
        expect(result.outcome).toBe("NOT_AMBIGUOUS");
        if (result.outcome !== "NOT_AMBIGUOUS") throw new Error("unreachable");
        expect(result.status).toBe("SUCCEEDED");
      });
    });

    describe("the receipt is append-only evidence", () => {
      it("cannot be rewritten or deleted once recorded", async () => {
        await proposeAndApprove();
        await execute({ evaluationAtProposal: await evaluateNow() });

        // Migration 008's `ra_deny_mutation`. Asserted on the SQLSTATE the trigger
        // raises rather than on any error, so a different failure cannot pass for it.
        for (const sql of [
          "UPDATE receipts SET external_id = 'forged' WHERE action_id = 'act-1'",
          "DELETE FROM receipts WHERE action_id = 'act-1'",
        ]) {
          const error = await db.query(sql).then(
            () => null,
            (e: unknown) => e,
          );
          expect(error, sql).not.toBeNull();
          expect((error as { code?: string }).code).toBe("P0100");
        }
      });

      it("refuses a second receipt for one action", async () => {
        // Two confirmations of a single at-most-once effect is a contradiction, and
        // swallowing it would hide a double execution.
        await proposeAndApprove();
        await execute({ evaluationAtProposal: await evaluateNow() });
        await expect(
          receipts.record(db, {
            receiptId: "rc-second",
            actionId: "act-1",
            externalId: "10099",
            entityVersion: "v2",
            entityVersionField: "fields.updated",
            status: null,
          }),
        ).rejects.toThrow();
      });

      it("refuses a receipt with a version but no field name (migration 031 CHECK)", async () => {
        // Either half alone records nothing a reconciler can compare, so the schema
        // rejects the half-populated shape rather than storing something that looks
        // more informative than it is.
        await proposeAndApprove();
        await db.withTransaction((tx: Transaction) =>
          actions.advanceStatus(tx, { actionId: "act-1", from: "APPROVED", to: "EXECUTING" }),
        );
        await expect(
          db.query(
            `INSERT INTO receipts (receipt_id, action_id, external_id, entity_version)
             VALUES ('rc-half','act-1','10042','v1')`,
          ),
        ).rejects.toThrow(/receipts_entity_version_complete|violates check constraint/);
      });
    });

    describe("execution cannot start from a state that forbids it", () => {
      it("refuses a PROPOSED action that requires an approval", async () => {
        // The REQUIRES_APPROVAL path must reach EXECUTING via APPROVED. A PROPOSED
        // action with no grant must not execute — this is the shortcut the contract's
        // transition guard forbids, asserted here against the durable row.
        const proposed = await actions.propose(db, {
          actionId: "act-noapproval",
          caseId: "case-a",
          toolName: "jira.issue.comment",
          connectionId: "conn-a",
          canonicalPayload: PAYLOAD,
          actionDigest: DIGEST,
          riskTier: "R3",
          policyDecision: "REQUIRES_APPROVAL",
          idempotencyKey: "idem-noapproval",
        });
        expect(proposed.outcome).toBe("PROPOSED");

        const provider = fakeProvider({ kind: "CONFIRMED", receipt: RECEIPT });
        const result = await execute({
          actionId: "act-noapproval",
          evaluationAtProposal: await evaluateNow(),
          provider,
        });

        expect(result.outcome).toBe("NOT_EXECUTABLE");
        if (result.outcome !== "NOT_EXECUTABLE") throw new Error("unreachable");
        expect(result.status).toBe("PROPOSED");
        expect(provider.calls).toHaveLength(0);
      });

      it("refuses an unknown action", async () => {
        const result = await execute({
          actionId: "act-ghost",
          evaluationAtProposal: await evaluateNow(),
        });
        expect(result.outcome).toBe("ACTION_NOT_FOUND");
      });

      it("lets only ONE of two concurrent executions reach the provider", async () => {
        // The at-most-once property under concurrency. Two workers pick up the same
        // approved action; the status fence must elect one, and the provider must see
        // exactly one call in total.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        const calls: string[] = [];
        const adapter: ProviderAdapter = async (i) => {
          calls.push(i.idempotencyKey);
          // Hold briefly so both attempts genuinely overlap.
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { kind: "CONFIRMED", receipt: RECEIPT };
        };

        const attempt = (receiptId: string): Promise<string> =>
          executeAction(runInTransaction, ports, adapter, {
            actionId: "act-1",
            provider: "jira",
            caseConnectionIds: ["conn-a"],
            connectionHealth: "HEALTHY",
            credentialExpiresAt: null,
            evaluationAtProposal: atProposal,
            receiptId,
          }).then(
            (r) => r.outcome,
            (e: unknown) => `THREW:${(e as Error).constructor.name}`,
          );

        const outcomes = await Promise.all([attempt("rc-a"), attempt("rc-b")]);
        expect(outcomes.filter((o) => o === "SUCCEEDED")).toHaveLength(1);
        // The assertion that matters: the external world was touched once.
        expect(calls).toHaveLength(1);

        const count = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM receipts",
        );
        expect(count.rows[0]!.count).toBe("1");
      });

      it("lets only ONE concurrent execution of an AUTO_ALLOW action reach the provider", async () => {
        // The test above is satisfied by the approval's single-use fence, so removing
        // the STATUS fence on the EXECUTING transition left it green — the mutation
        // survived. An AUTO_ALLOW action has no approval, so the status compare-and-set
        // is the ONLY thing preventing two workers from both writing. That makes this
        // the case where the fence is load-bearing on its own.
        await proposeAutoAllow("act-race");
        const atProposal = await evaluateNow({ toolName: "gmail.draft.create" });
        const calls: string[] = [];
        const adapter: ProviderAdapter = async (i) => {
          calls.push(i.idempotencyKey);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { kind: "CONFIRMED", receipt: RECEIPT };
        };

        const attempt = (receiptId: string): Promise<string> =>
          executeAction(runInTransaction, ports, adapter, {
            actionId: "act-race",
            provider: "jira",
            caseConnectionIds: ["conn-a"],
            connectionHealth: "HEALTHY",
            credentialExpiresAt: null,
            evaluationAtProposal: atProposal,
            receiptId,
          }).then(
            (r) => r.outcome,
            (e: unknown) => `THREW:${(e as Error).constructor.name}`,
          );

        const outcomes = await Promise.all([attempt("rc-x"), attempt("rc-y")]);
        expect(outcomes.filter((o) => o === "SUCCEEDED")).toHaveLength(1);
        // At most once against the provider — the whole point of the fence.
        expect(calls).toHaveLength(1);
        const count = await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM receipts WHERE action_id = 'act-race'",
        );
        expect(count.rows[0]!.count).toBe("1");
      });
    });
  },
  available,
);
