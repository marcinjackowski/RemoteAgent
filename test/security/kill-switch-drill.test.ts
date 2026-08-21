import { canonicalDigest } from "@remoteagent/contracts";
import {
  ApprovalRepository,
  AuditLogRepository,
  CaseRepository,
  ConnectionRepository,
  ExternalActionRepository,
  KillSwitchRepository,
  OwnerRepository,
  ReceiptRepository,
  type Transaction,
} from "@remoteagent/database";
import {
  PolicyRefusalCode,
  evaluatePolicy,
  executeAction,
  ingestApprovalClick,
  toPolicyKillSwitches,
  type ExecutorPorts,
  type PolicyEvaluation,
  type ProviderAdapter,
  type ProviderReceipt,
} from "@remoteagent/policy";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../packages/database/test/integration-base.js";

const available = await ensurePostgres();

/**
 * AC6: "the kill switch drill stops effects while preserving reads and evidence"
 * (RA-024-WU-09).
 *
 * A DRILL, NOT A DECLARATION. The plan is explicit about this, and the reason is that
 * a kill switch is the control an operator reaches for when everything else has
 * already failed — so "the code path exists" is the weakest possible assurance. What
 * is exercised below is the REAL executor against a REAL PostgreSQL, with the switch
 * flipped at the worst available moments.
 *
 * The three properties, and why each is separate:
 *
 *   1. EFFECTS STOP. The provider adapter must not be called at all. Asserted by
 *      counting adapter invocations, not by reading the returned outcome — a refusal
 *      that still sent the request is the failure this exists to prevent, and it
 *      looks identical from the return value.
 *   2. READS SURVIVE. An operator mid-incident needs to see the audit log, the
 *      actions and the receipts. A switch that took the system offline entirely would
 *      destroy the evidence needed to decide what to do next, which is worse than the
 *      effects it stopped.
 *   3. EVIDENCE IS PRESERVED. The unspent approval, the append-only kill-switch
 *      event, and the durable action row all survive — so the operator can resume
 *      deliberately rather than re-deriving what was in flight.
 *
 * The hardest case is the TOCTOU one: the switch is flipped AFTER the approval was
 * granted and after the proposal-time policy evaluation, i.e. in the seconds a human
 * spends reading a Discord message. That window is why `executeAction` re-evaluates
 * policy and reads the switch in the SAME transaction that consumes the approval.
 */
/**
 * The `CTF-004` src-vs-dist bridge, in one place, exactly as
 * `test/golden-path/golden-path.integration.test.ts` documents it.
 *
 * The harness imports `../src/client.js`, so it returns the **src** `Database` and
 * the **src**-branded `Transaction`. Everything this suite exercises comes from
 * `@remoteagent/policy`, which resolves to `dist` and therefore declares the
 * **dist** types. `Database` differs by a private `pool` field and `Transaction` by
 * a `unique symbol` brand, so the two are mutually unassignable.
 *
 * Also bridged: `ReceiptRepository.record` returns the inserted row while
 * `ExecutorPorts.receipts.record` is declared `Promise<void>`. That is a widening,
 * not a mismatch — a caller expecting `void` cannot misuse a returned row — but
 * `exactOptionalPropertyTypes` still rejects it, so it is converted here rather than
 * by loosening the port.
 *
 * Casting is the honest shape: the brand exists only in `.d.ts` and no runtime field
 * backs it, so the assertion is not false. Proving the two packages were built from
 * the same source is a different job, done by the build in the gate.
 */
type DrillDatabase = Awaited<ReturnType<typeof createTestDatabase>>["db"];

const PAYLOAD = { issue: "MOBL-7", body: "the comment the owner approved" };
const DIGEST = canonicalDigest(PAYLOAD);
const RECEIPT: ProviderReceipt = {
  externalId: "10042",
  entityVersion: "2026-08-21T12:00:00.000+0000",
  entityVersionField: "fields.updated",
  status: "created",
};

describeIntegration(
  "AC6 kill switch drill",
  () => {
    let db: DrillDatabase;
    let drop: () => Promise<void>;

    const approvals = new ApprovalRepository();
    const actions = new ExternalActionRepository();
    const receipts = new ReceiptRepository();
    const killSwitches = new KillSwitchRepository();
    const audit = new AuditLogRepository();

    const ports: ExecutorPorts = {
      approvals,
      actions,
      // `record` returns the inserted row; the port declares `Promise<void>`. Awaited
      // and discarded, so the widening is explicit rather than cast away.
      receipts: {
        record: async (
          tx: Parameters<ExecutorPorts["receipts"]["record"]>[0],
          input: Parameters<ExecutorPorts["receipts"]["record"]>[1],
        ) => {
          await receipts.record(tx as unknown as Parameters<typeof receipts.record>[0], input);
        },
      },
      killSwitches,
      now: async (tx: Parameters<ExecutorPorts["now"]>[0]) => {
        const r = (await tx.query("SELECT now() AS n")) as { rows: { n: Date }[] };
        return r.rows[0]!.n;
      },
    } as unknown as ExecutorPorts;

    const runInTransaction = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
      (db.withTransaction as unknown as <U>(f: (tx: Transaction) => Promise<U>) => Promise<U>)(fn);

    /**
     * A provider that RECORDS whether it was called.
     *
     * The load-bearing instrument of this drill. "The executor returned
     * POLICY_DENIED" and "no request left the process" are different claims, and only
     * the second is what AC6 requires — so the count is asserted, never the outcome
     * alone.
     */
    function countingProvider(): { adapter: ProviderAdapter; calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        adapter: async (input) => {
          calls.push(input.toolName);
          return { kind: "CONFIRMED", receipt: RECEIPT };
        },
      };
    }

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });

    afterAll(async () => {
      await drop();
    });

    beforeEach(async () => {
      await db.query(
        `TRUNCATE kill_switch_events, receipts, external_actions, approvals, audit_log,
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
      await audit.record(db, {
        actor: "system",
        action: "case.opened",
        outcome: "SUCCESS",
        ownerId: "owner-a",
        caseId: "case-a",
      });
    });

    async function evaluateNow(): Promise<PolicyEvaluation> {
      const rows = await killSwitches.listEffective(db, {
        ownerId: "owner-a",
        provider: "jira",
        connectionId: "conn-a",
      });
      const now = await db.query<{ n: Date }>("SELECT now() AS n").then((r) => r.rows[0]!.n);
      return evaluatePolicy({
        toolName: "jira.issue.comment",
        caseId: "case-a",
        ownerId: "owner-a",
        provider: "jira",
        connectionId: "conn-a",
        caseConnectionIds: ["conn-a"],
        connectionHealth: "HEALTHY",
        credentialExpiresAt: null,
        killSwitches: toPolicyKillSwitches(rows),
        now,
      });
    }

    async function proposeAndApprove(actionId = "act-1"): Promise<void> {
      const proposed = await actions.propose(db, {
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
      if (proposed.outcome !== "PROPOSED") throw new Error(proposed.outcome);
      const revision = await db
        .query<{ checkpoint_revision: number }>(
          `SELECT checkpoint_revision FROM cases WHERE case_id = 'case-a'`,
        )
        .then((r) => r.rows[0]!.checkpoint_revision);
      const granted = await db.withTransaction((tx) =>
        ingestApprovalClick(
          tx,
          { approvals, actions },
          {
            caseId: "case-a",
            actorId: "owner-a",
            actionId,
            click: { approvalId: `ap-${actionId}`, checkpointRevision: revision, choice: "grant" },
            grantTtlMs: 900_000,
            now: new Date(),
          },
        ),
      );
      if (granted.outcome !== "GRANTED") throw new Error(granted.outcome);
    }

    /** Flip a switch at one of the three scope levels. */
    async function flip(
      level: "GLOBAL" | "PROVIDER" | "CONNECTION",
      enabled: boolean,
      eventId: string,
    ): Promise<void> {
      await killSwitches.append(db, {
        eventId,
        level,
        enabled,
        reason: "drill",
        changedBy: "operator-1",
        ...(level === "GLOBAL" ? {} : { provider: "jira" as const }),
        ...(level === "CONNECTION" ? { ownerId: "owner-a", connectionId: "conn-a" } : {}),
      } as Parameters<KillSwitchRepository["append"]>[1]);
    }

    describe("property 1 — effects stop", () => {
      it.each(["GLOBAL", "PROVIDER", "CONNECTION"] as const)(
        "a %s switch stops an approved R3 write before the provider is called",
        async (level) => {
          await proposeAndApprove();
          // Evaluated BEFORE the switch, which is the TOCTOU window: the owner
          // approved, then the operator stopped the system while the click was in
          // flight.
          const atProposal = await evaluateNow();
          await flip(level, true, `ks-${level}`);

          const provider = countingProvider();
          const outcome = await executeAction(runInTransaction, ports, provider.adapter, {
            actionId: "act-1",
            provider: "jira",
            caseConnectionIds: ["conn-a"],
            connectionHealth: "HEALTHY",
            credentialExpiresAt: null,
            evaluationAtProposal: atProposal,
            receiptId: "rc-1",
          });

          expect(outcome.outcome).toBe("POLICY_DENIED");
          expect(outcome.outcome === "POLICY_DENIED" && outcome.evaluation.refusalCode).toBe(
            PolicyRefusalCode.KILL_SWITCH_ACTIVE,
          );
          // THE ASSERTION THAT MATTERS. A refusal that still sent the request looks
          // identical from the return value.
          expect(provider.calls, "the provider must not be called at all").toEqual([]);
        },
      );

      it("no receipt is written, so nothing claims the effect happened", async () => {
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        await flip("GLOBAL", true, "ks-1");
        const provider = countingProvider();
        await executeAction(runInTransaction, ports, provider.adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: atProposal,
          receiptId: "rc-1",
        });
        const rows = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM receipts`);
        expect(rows.rows[0]!.n).toBe("0");
      });

      it("the action does NOT advance to EXECUTING, so nothing looks in flight", async () => {
        // If a stopped action were left EXECUTING, an operator would reasonably read it
        // as "the call may be in progress" and could re-run it after the stop was
        // lifted — the exact double-write the executor's ordering exists to prevent.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        await flip("GLOBAL", true, "ks-1");
        await executeAction(runInTransaction, ports, countingProvider().adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: atProposal,
          receiptId: "rc-1",
        });
        const row = await db.query<{ status: string }>(
          `SELECT status FROM external_actions WHERE action_id = 'act-1'`,
        );
        expect(row.rows[0]!.status).toBe("APPROVED");
      });
    });

    describe("property 2 — reads and evidence survive", () => {
      it("the audit log is readable while the switch is active", async () => {
        // An operator mid-incident needs this. A switch that took the system offline
        // would destroy the evidence needed to decide what to do next.
        await flip("GLOBAL", true, "ks-1");
        const rows = await audit.listByCase(db, "case-a");
        expect(rows).toHaveLength(1);
        expect(rows[0]!.action).toBe("case.opened");
      });

      it("actions, approvals and the switch history are all readable", async () => {
        await proposeAndApprove();
        await flip("GLOBAL", true, "ks-1");
        expect(await actions.findById(db, "act-1")).not.toBeNull();
        const switches = await killSwitches.listEffective(db, {
          ownerId: "owner-a",
          provider: "jira",
          connectionId: "conn-a",
        });
        expect(switches.some((row) => row.enabled)).toBe(true);
        const grants = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM approvals`);
        expect(grants.rows[0]!.n).toBe("1");
      });

      it("the owner's approval is NOT consumed, so the grant is not silently spent", async () => {
        // The whole first transaction rolls back on refusal. If the approval had been
        // consumed, the owner would have to be asked again for a write that never
        // happened — and would reasonably wonder whether it had.
        await proposeAndApprove();
        const atProposal = await evaluateNow();
        await flip("GLOBAL", true, "ks-1");
        await executeAction(runInTransaction, ports, countingProvider().adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          credentialExpiresAt: null,
          connectionHealth: "HEALTHY",
          evaluationAtProposal: atProposal,
          receiptId: "rc-1",
        });
        const row = await db.query<{ consumed: boolean }>(
          `SELECT consumed FROM approvals WHERE approval_id = 'ap-act-1'`,
        );
        expect(row.rows[0]!.consumed).toBe(false);
      });

      it("the kill-switch event itself cannot be deleted or rewritten", async () => {
        // The record that the system was stopped must outlive the incident, or a
        // post-mortem cannot establish when effects were suspended.
        await flip("GLOBAL", true, "ks-1");
        for (const sql of [
          `DELETE FROM kill_switch_events WHERE true`,
          `UPDATE kill_switch_events SET enabled = false`,
        ]) {
          await expect(db.withTransaction((tx) => tx.query(sql))).rejects.toMatchObject({
            code: "P0100",
          });
        }
      });

      it("an audit entry can still be WRITTEN during a stop", async () => {
        // Stopping external effects must not stop recording. Otherwise the drill
        // itself, and everything an operator does during it, goes unrecorded.
        await flip("GLOBAL", true, "ks-1");
        await audit.record(db, {
          actor: "operator-1",
          action: "killswitch.enabled",
          outcome: "SUCCESS",
          ownerId: "owner-a",
          caseId: "case-a",
        });
        const rows = await audit.listByCase(db, "case-a");
        expect(rows.map((row) => row.action)).toContain("killswitch.enabled");
      });
    });

    describe("property 3 — the stop is reversible and work resumes", () => {
      it("lifting the switch lets the SAME approved action execute", async () => {
        // A stop that could not be lifted would make operators reluctant to use it,
        // which is the practical failure of a safety control.
        await proposeAndApprove();
        await flip("GLOBAL", true, "ks-1");

        const denied = await executeAction(runInTransaction, ports, countingProvider().adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: await evaluateNow(),
          receiptId: "rc-1",
        });
        expect(denied.outcome).toBe("POLICY_DENIED");

        await flip("GLOBAL", false, "ks-2");
        const provider = countingProvider();
        const resumed = await executeAction(runInTransaction, ports, provider.adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          // Re-evaluated after the lift. Deliberately NOT the pre-stop snapshot: the
          // world changed twice, and AC3 requires the two evaluations to agree.
          evaluationAtProposal: await evaluateNow(),
          receiptId: "rc-1",
        });
        expect(resumed.outcome).toBe("SUCCEEDED");
        expect(provider.calls).toEqual(["jira.issue.comment"]);
      });

      it("a lift does not erase the record that a stop happened", async () => {
        await flip("GLOBAL", true, "ks-1");
        await flip("GLOBAL", false, "ks-2");
        const history = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM kill_switch_events`,
        );
        // Append-only: two events, not one row toggled.
        expect(history.rows[0]!.n).toBe("2");
      });

      it("a stale pre-stop evaluation is refused even after the lift", async () => {
        // The subtle one. After a stop and a lift, the DECISION is the same as it was
        // at proposal, so a decision-only comparison would allow execution. But the
        // world changed under the owner's consent, and the safe response is to
        // re-propose — which is why `policyEvaluationsAgree` compares the observed
        // kill-switch event ids and not just the verdict.
        await proposeAndApprove();
        const beforeAnySwitch = await evaluateNow();
        await flip("GLOBAL", true, "ks-1");
        await flip("GLOBAL", false, "ks-2");

        const provider = countingProvider();
        const outcome = await executeAction(runInTransaction, ports, provider.adapter, {
          actionId: "act-1",
          provider: "jira",
          caseConnectionIds: ["conn-a"],
          connectionHealth: "HEALTHY",
          credentialExpiresAt: null,
          evaluationAtProposal: beforeAnySwitch,
          receiptId: "rc-1",
        });
        expect(outcome.outcome).toBe("POLICY_CHANGED");
        expect(provider.calls).toEqual([]);
      });
    });
  },
  available,
);
