import { afterEach, beforeEach, expect, it } from "vitest";

import { CaseRepository, ConnectionRepository, OwnerRepository } from "@remoteagent/database";
import { WorkUnitRepository } from "@remoteagent/database";
import type { Database } from "@remoteagent/database";

import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { WorkerPersistence } from "../src/persistence.js";

const available = await ensurePostgres();

/**
 * The promoted persistence adapter (RA-028-WU-01), against a REAL database.
 *
 * WHY EVERY ASSERTION READS THE DATABASE. RA-027 §4.1 is the warning this suite is built
 * against: twelve mutations survived there because the tests proved a process *starts*
 * and asserted nothing about what it *does*. The analogous mistake here is asserting that
 * `start()` returned a work unit — which stays true if the method never touches
 * `agent_runs` at all. So each test below reads back the rows the method was supposed to
 * write.
 *
 * The three defects this suite exists to pin are the three test artifacts the harness
 * version carried: a hardcoded timestamp, a bypassed completion path, and a
 * constructor-supplied `provider`.
 */

const owners = new OwnerRepository();
const connections = new ConnectionRepository();
const cases = new CaseRepository();
const units = new WorkUnitRepository();

/** A fixed instant, so an assertion about the stored timestamp is exact rather than a range. */
const FIXED_MS = Date.parse("2026-08-22T11:22:33.000Z");

describeIntegration(
  "worker persistence adapter",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let store: WorkerPersistence;
    let issued = 0;

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      issued = 0;
      store = new WorkerPersistence(db, {
        clock: { now: () => FIXED_MS },
        ids: {
          next: (prefix) => {
            issued += 1;
            return `${prefix ?? "id"}-${String(issued)}`;
          },
        },
      });
    });

    afterEach(async () => {
      await drop();
    });

    async function seed(
      caseId: string,
      unitId: string,
      options: { readonly role?: "REVIEWER" | "IMPLEMENTER"; readonly providers?: string[] } = {},
    ): Promise<void> {
      const providers = options.providers ?? ["jira"];
      await owners.insert(db, { ownerId: `owner-${caseId}`, displayName: "owner" });
      for (const provider of providers) {
        await connections.insert(db, {
          connectionId: `connection-${caseId}-${provider}`,
          ownerId: `owner-${caseId}`,
          provider: provider as "jira",
          displayName: "connection",
        });
      }
      await cases.insert(db, {
        caseId,
        ownerId: `owner-${caseId}`,
        status: "NEW",
        integrationScope: {
          providers: providers as ["jira"],
          connection_ids: providers.map((p) => `connection-${caseId}-${p}`),
        },
        discordThreadId: `thread-${caseId}`,
      });
      // `can_write_workspace` is pinned per role by the contract's discriminated union:
      // IMPLEMENTER must be `true`, every read-only role must be `false`. That is the
      // single-writer invariant enforced structurally, so the fixture has to respect it.
      const role = options.role ?? "REVIEWER";
      await units.insert(db, {
        workUnitId: unitId,
        caseId,
        role,
        objective: unitId,
        authoritativeScope:
          role === "IMPLEMENTER"
            ? { connection_ids: [], repo_allowlist: [], can_write_workspace: true }
            : { connection_ids: [], repo_allowlist: [], can_write_workspace: false },
      });
      for (const provider of providers) {
        await db.query(
          `INSERT INTO external_entities
             (entity_id, case_id, owner_id, connection_id, provider, kind, external_id)
           VALUES ($1, $2, $3, $4, $5, 'issue', $6)`,
          [
            `entity-${caseId}-${provider}`,
            caseId,
            `owner-${caseId}`,
            `connection-${caseId}-${provider}`,
            provider,
            `EXT-${provider}`,
          ],
        );
      }
    }

    async function claimAndStart(unitId: string, runId: string): Promise<void> {
      await store.claim({ workUnitId: unitId, runId, checkpointRevision: 0 });
      await store.start({ workUnitId: unitId, runId });
    }

    // ---- artifact 1: the hardcoded timestamp -------------------------------------

    it("writes started_at from the INJECTED clock, not a hardcoded literal", async () => {
      // The harness wrote `started_at = '2026-08-20T10:00:00Z'` as a SQL literal. In
      // production every run would report the same instant, so duration and staleness —
      // the two things an operator reads during an incident — would be meaningless.
      await seed("case-clock", "unit-clock");
      await claimAndStart("unit-clock", "run-clock");
      const row = await db.query<{ started_at: Date; safety_state: string }>(
        "SELECT started_at, safety_state FROM agent_runs WHERE run_id = $1",
        ["run-clock"],
      );
      expect(row.rows[0]?.safety_state).toBe("STARTED");
      expect(row.rows[0]?.started_at.getTime()).toBe(FIXED_MS);
    });

    it("a second start() does NOT rewind started_at of a running run", async () => {
      // Recovery can legitimately call start() again. Without the `safety_state = 'PLANNED'`
      // guard the run's start time moves forward on every retry, so a stuck run looks
      // freshly started and never trips a staleness alert.
      await seed("case-again", "unit-again");
      await claimAndStart("unit-again", "run-again");
      const laterStore = new WorkerPersistence(db, {
        clock: { now: () => FIXED_MS + 600_000 },
        ids: { next: (p) => `${p ?? "id"}-x` },
      });
      await laterStore.start({ workUnitId: "unit-again", runId: "run-again" });
      const row = await db.query<{ started_at: Date }>(
        "SELECT started_at FROM agent_runs WHERE run_id = $1",
        ["run-again"],
      );
      expect(row.rows[0]?.started_at.getTime()).toBe(FIXED_MS);
    });

    // ---- artifact 3: provider derived, not supplied ------------------------------

    it("derives provider from external_entities", async () => {
      await seed("case-prov", "unit-prov", { providers: ["gitlab"] });
      const claimed = await store.claim({
        workUnitId: "unit-prov",
        runId: "run-prov",
        checkpointRevision: 0,
      });
      // Load-bearing: `fairness.ts` applies a per-provider concurrency limit only when
      // the unit carries a provider. A missing value silently means "unlimited", so the
      // rate-limit protection would be absent without anything failing.
      expect(claimed?.unit.provider).toBe("gitlab");
    });

    it("leaves provider UNDEFINED for a multi-provider case rather than picking one", async () => {
      // Charging a case that touches both Jira and GitLab against one provider's limit
      // would throttle the wrong provider, and which one would depend on row order.
      await seed("case-multi", "unit-multi", { providers: ["jira", "gitlab"] });
      const claimed = await store.claim({
        workUnitId: "unit-multi",
        runId: "run-multi",
        checkpointRevision: 0,
      });
      expect(claimed?.unit.provider).toBeUndefined();
    });

    // ---- listCaseIds scoping -----------------------------------------------------

    it("lists only cases with UNFINISHED work", async () => {
      // The harness selected DISTINCT over every work_units row ever written, so recovery
      // would re-walk every case the system has handled on each start.
      await seed("case-open", "unit-open");
      await seed("case-closed", "unit-closed");
      // Driven through the real transition path rather than a raw UPDATE: a
      // `work_units_status_binding_check` constraint forbids a terminal status without a
      // bound run, so a raw UPDATE both fails and would not represent a reachable state.
      await claimAndStart("unit-closed", "run-closed");
      await store.finalize({
        workUnitId: "unit-closed",
        runId: "run-closed",
        status: "COMPLETED",
      });
      expect(await store.listCaseIds()).toEqual(["case-open"]);
    });

    // ---- AC5: AMBIGUOUS is never replayed ---------------------------------------

    it("markAmbiguous sets AMBIGUOUS and recover() reports the writer BLOCKED", async () => {
      await seed("case-amb", "unit-amb", { role: "IMPLEMENTER" });
      await claimAndStart("unit-amb", "run-amb");
      await store.markAmbiguous({
        workUnitId: "unit-amb",
        runId: "run-amb",
        reason: "tool call outcome unknown",
      });
      const row = await db.query<{ safety_state: string }>(
        "SELECT safety_state FROM agent_runs WHERE run_id = $1",
        ["run-amb"],
      );
      expect(row.rows[0]?.safety_state).toBe("AMBIGUOUS");
      // The half that matters: an unconfirmed effect must block the case, not merely be
      // recorded. Otherwise recovery starts a second writer over an effect that may
      // already have landed externally.
      expect((await store.recover("case-amb")).writerBlocked).toBe(true);
    });

    it("markAmbiguous does NOT drag a finished run back into AMBIGUOUS", async () => {
      // Without the `safety_state = 'STARTED'` guard, a late ambiguity report would block
      // a case whose run already succeeded — permanently, since nothing clears it.
      await seed("case-done", "unit-done", { role: "IMPLEMENTER" });
      await claimAndStart("unit-done", "run-done");
      await db.query("UPDATE agent_runs SET safety_state = 'SUCCEEDED' WHERE run_id = $1", [
        "run-done",
      ]);
      await store.markAmbiguous({
        workUnitId: "unit-done",
        runId: "run-done",
        reason: "late report",
      });
      const row = await db.query<{ safety_state: string }>(
        "SELECT safety_state FROM agent_runs WHERE run_id = $1",
        ["run-done"],
      );
      expect(row.rows[0]?.safety_state).toBe("SUCCEEDED");
      expect((await store.recover("case-done")).writerBlocked).toBe(false);
    });

    // ---- recover() shape --------------------------------------------------------

    it("recover() returns the unit with its run and no completion before one exists", async () => {
      await seed("case-rec", "unit-rec");
      await claimAndStart("unit-rec", "run-rec");
      const snapshot = await store.recover("case-rec");
      expect(snapshot.caseId).toBe("case-rec");
      expect(snapshot.units).toHaveLength(1);
      expect(snapshot.units[0]?.run?.runId).toBe("run-rec");
      expect(snapshot.units[0]?.completion).toBeNull();
      expect(snapshot.units[0]?.workUnit.status).toBe("RUNNING");
    });

    it("finalize() moves the work unit to its terminal status", async () => {
      await seed("case-fin", "unit-fin");
      await claimAndStart("unit-fin", "run-fin");
      const result = await store.finalize({
        workUnitId: "unit-fin",
        runId: "run-fin",
        status: "COMPLETED",
      });
      expect(result.replayed).toBe(false);
      const row = await db.query<{ status: string }>(
        "SELECT status FROM work_units WHERE work_unit_id = $1",
        ["unit-fin"],
      );
      expect(row.rows[0]?.status).toBe("COMPLETED");
    });
  },
  available,
);
