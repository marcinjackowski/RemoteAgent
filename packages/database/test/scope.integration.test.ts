/**
 * Scoped referential integrity integration tests (RA-003, migration 010).
 *
 * AUDIT-01 HIGH-01 reproduced cross-owner / cross-case writes on a freshly
 * migrated database. These tests assert that every scoped edge now fails closed
 * on a plain write (raw SQL) and, where a repository exists, through the repo:
 *
 *   * cases.integration_scope cannot reference a foreign/unknown connection, nor
 *     a provider absent from the scope's providers[];
 *   * a normalized event cannot claim raw provenance of another owner/connection/
 *     provider;
 *   * external_actions cannot use a foreign-owner connection or an approval of
 *     another case;
 *   * run_intents / run_completions cannot reference a run of a different case;
 *   * artifacts / reviews cannot reference a run of a different case.
 *
 * Enforcement is deterministic in the database (composite FKs + a constraint
 * trigger), never in model/application code (AGENTS.md §6).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import {
  ContractViolationError,
  IntegrityViolationError,
  ProtectedTableError,
  ScopeViolationError,
} from "../src/errors.js";
import { translatePgError } from "../src/client.js";
import {
  CaseRepository,
  ConnectionRepository,
  OwnerRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

/** Run a write and return the thrown error (or null if it unexpectedly succeeds). */
async function attempt(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => null,
    (error: unknown) => error,
  );
}

describeIntegration(
  "scoped referential integrity",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;

    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();

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
        `TRUNCATE external_actions, approvals, receipts, artifacts, reviews,
                  run_completions, run_intents, agent_runs, case_checkpoints,
                  external_entities, case_messages, decisions, decision_answers,
                  case_connections, cases, events, raw_events, connections, owners
         RESTART IDENTITY CASCADE`,
      );
    });

    // Two isolated owners, each with one jira connection.
    async function seedTwoOwners(): Promise<void> {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await owners.insert(db, { ownerId: "B", displayName: "B" });
      await connections.insert(db, {
        connectionId: "cA",
        ownerId: "A",
        provider: "jira",
        displayName: "cA",
      });
      await connections.insert(db, {
        connectionId: "cB",
        ownerId: "B",
        provider: "jira",
        displayName: "cB",
      });
    }

    it("rejects a case scope referencing a foreign owner's connection", async () => {
      await seedTwoOwners();
      // The connection exists and shares the declared provider, so the durable
      // case_connections composite FK (owner mismatch) is what fails closed.
      await expect(
        cases.insert(db, {
          caseId: "caseX",
          ownerId: "A",
          status: "NEW",
          // connection_ids points at owner B's connection.
          integrationScope: { providers: ["jira"], connection_ids: ["cB"] },
          discordThreadId: "tX",
        }),
      ).rejects.toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a case scope referencing an unknown connection", async () => {
      await seedTwoOwners();
      await expect(
        cases.insert(db, {
          caseId: "caseY",
          ownerId: "A",
          status: "NEW",
          integrationScope: { providers: ["jira"], connection_ids: ["ghost"] },
          discordThreadId: "tY",
        }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it("rejects a case scope whose connection provider is not in providers[]", async () => {
      await seedTwoOwners();
      await expect(
        cases.insert(db, {
          caseId: "caseZ",
          ownerId: "A",
          status: "NEW",
          // cA is a jira connection but the scope only declares gitlab.
          integrationScope: { providers: ["gitlab"], connection_ids: ["cA"] },
          discordThreadId: "tZ",
        }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it("accepts a case scope wholly within the owner's connections", async () => {
      await seedTwoOwners();
      const ok = await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
      expect(ok.case_id).toBe("caseA");
    });

    it("rejects a normalized event claiming another owner's raw provenance", async () => {
      await seedTwoOwners();
      await db.query(
        `INSERT INTO raw_events (raw_event_id, provider, connection_id, owner_id,
           payload_ref, payload_digest, sensitivity)
         VALUES ('rawB','jira','cB','B','ref',$1,'internal')`,
        [ZERO_DIGEST],
      );

      // Event of owner A / connection cA points at owner B's raw event.
      const err = await attempt(() =>
        db.query(
          `INSERT INTO events (event_id, provider, connection_id, owner_id,
             external_event_id, event_type, dedupe_key, raw_event_id,
             entity_provider, entity_kind, entity_external_id, trace_id,
             sensitivity, occurred_at)
           VALUES ('evX','jira','cA','A','x','t','d','rawB','jira','k','x','tr','internal', now())`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("accepts a normalized event with matching raw provenance", async () => {
      await seedTwoOwners();
      await db.query(
        `INSERT INTO raw_events (raw_event_id, provider, connection_id, owner_id,
           payload_ref, payload_digest, sensitivity)
         VALUES ('rawA','jira','cA','A','ref',$1,'internal')`,
        [ZERO_DIGEST],
      );
      await db.query(
        `INSERT INTO events (event_id, provider, connection_id, owner_id,
           external_event_id, event_type, dedupe_key, raw_event_id,
           entity_provider, entity_kind, entity_external_id, trace_id,
           sensitivity, occurred_at)
         VALUES ('evOK','jira','cA','A','x','t','d','rawA','jira','k','x','tr','internal', now())`,
      );
      const n = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM events");
      expect(n.rows[0]?.n).toBe("1");
    });

    // Seed one case per owner plus a run under caseA, returning nothing.
    async function seedCasesAndRun(): Promise<void> {
      await seedTwoOwners();
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
      await cases.insert(db, {
        caseId: "caseB",
        ownerId: "B",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cB"] },
        discordThreadId: "tB",
      });
      await db.query(
        `INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision)
         VALUES ('runA','caseA','A','wu','PLANNER','PLANNED',0)`,
      );
    }

    it("rejects a run_intent whose case differs from its run's case", async () => {
      await seedCasesAndRun();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO run_intents (intent_id, run_id, case_id, kind, payload)
           VALUES ('i1','runA','caseB','k','{}'::jsonb)`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a run_completion whose case differs from its run's case", async () => {
      await seedCasesAndRun();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO run_completions (completion_id, run_id, case_id, status, completion)
           VALUES ('c1','runA','caseB','COMPLETED','{}'::jsonb)`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects an artifact referencing a run of a different case", async () => {
      await seedCasesAndRun();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO artifacts (artifact_id, case_id, run_id, kind, storage_ref, digest)
           VALUES ('a1','caseB','runA','log','ref',$1)`,
          [ZERO_DIGEST],
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a review referencing a run of a different case", async () => {
      await seedCasesAndRun();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO reviews (review_id, case_id, run_id, verdict)
           VALUES ('rv1','caseB','runA','PASS')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects an external_action routed through a foreign owner's connection", async () => {
      await seedCasesAndRun();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO external_actions (action_id, case_id, owner_id, tool_name,
             connection_id, canonical_payload, action_digest, risk_tier,
             policy_decision, idempotency_key, status)
           VALUES ('actX','caseA','A','tool','cB','{}'::jsonb,$1,'R0','AUTO_ALLOW','k1','PROPOSED')`,
          [`sha256:${"1".repeat(64)}`],
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects an external_action referencing an approval of another case", async () => {
      await seedCasesAndRun();
      const digest = `sha256:${"3".repeat(64)}`;
      await db.query(
        `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
           action_digest, checkpoint_revision, expires_at)
         VALUES ('apB','caseB','B','owner',$1, 0, now() + interval '1 hour')`,
        [digest],
      );
      const err = await attempt(() =>
        db.query(
          `INSERT INTO external_actions (action_id, case_id, owner_id, tool_name,
             connection_id, canonical_payload, action_digest, risk_tier,
             policy_decision, approval_id, idempotency_key, status)
           VALUES ('actZ','caseA','A','tool','cA','{}'::jsonb,$1,'R3','REQUIRES_APPROVAL','apB','k3','PROPOSED')`,
          [`sha256:${"4".repeat(64)}`],
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("accepts an external_action within its own owner/connection scope", async () => {
      await seedCasesAndRun();
      await db.query(
        `INSERT INTO external_actions (action_id, case_id, owner_id, tool_name,
           connection_id, canonical_payload, action_digest, risk_tier,
           policy_decision, idempotency_key, status)
         VALUES ('actOK','caseA','A','tool','cA','{}'::jsonb,$1,'R0','AUTO_ALLOW','k4','PROPOSED')`,
        [`sha256:${"5".repeat(64)}`],
      );
      const n = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM external_actions");
      expect(n.rows[0]?.n).toBe("1");
    });

    // --- AUDIT-02 HIGH-01: durable, bidirectional case↔connection integrity ---

    it("blocks changing a connection's owner while a case scope uses it", async () => {
      await seedTwoOwners();
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
      // A plain parent mutation that would orphan the case scope is rejected by
      // the case_connections composite FK (ON UPDATE RESTRICT).
      const err = await attempt(() =>
        db.query("UPDATE connections SET owner_id = 'B' WHERE connection_id = 'cA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("blocks changing a connection's provider while a case scope uses it", async () => {
      await seedTwoOwners();
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
      const err = await attempt(() =>
        db.query("UPDATE connections SET provider = 'gmail' WHERE connection_id = 'cA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("blocks deleting a connection while a case scope uses it", async () => {
      await seedTwoOwners();
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
      const err = await attempt(() =>
        db.query("DELETE FROM connections WHERE connection_id = 'cA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects updating a case scope to a foreign owner's connection", async () => {
      await seedTwoOwners();
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
      // Re-pointing the scope at owner B's connection fails closed.
      const err = await attempt(() =>
        db.query(
          `UPDATE cases
             SET integration_scope = '{"providers":["jira"],"connection_ids":["cB"]}'::jsonb
           WHERE case_id = 'caseA'`,
        ),
      );
      const translated = translatePgError(err);
      // Foreign connection surfaces via the case_connections FK (integrity).
      expect(translated).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a scope whose connection provider is not declared in providers[] (gmail vs jira)", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cGmailA",
        ownerId: "A",
        provider: "gmail",
        displayName: "g",
      });
      // cGmailA is a gmail connection but the scope only declares jira.
      await expect(
        cases.insert(db, {
          caseId: "caseP",
          ownerId: "A",
          status: "NEW",
          integrationScope: { providers: ["jira"], connection_ids: ["cGmailA"] },
          discordThreadId: "tP",
        }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it("materializes case_connections rows for a valid multi-connection scope", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cA",
        ownerId: "A",
        provider: "jira",
        displayName: "j",
      });
      await connections.insert(db, {
        connectionId: "cGmailA",
        ownerId: "A",
        provider: "gmail",
        displayName: "g",
      });
      await cases.insert(db, {
        caseId: "caseM",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira", "gmail"], connection_ids: ["cA", "cGmailA"] },
        discordThreadId: "tM",
      });
      const rows = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM case_connections WHERE case_id = 'caseM'",
      );
      expect(rows.rows[0]?.n).toBe("2");
    });

    // --- AUDIT-02 HIGH-02: remaining provider / cross-case edges ---

    it("rejects a raw event whose provider differs from its connection's provider", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cGmailA",
        ownerId: "A",
        provider: "gmail",
        displayName: "g",
      });
      // provider=jira through a gmail connection: cross-provider provenance.
      const err = await attempt(() =>
        db.query(
          `INSERT INTO raw_events (raw_event_id, provider, connection_id, owner_id,
             payload_ref, payload_digest, sensitivity)
           VALUES ('rw1','jira','cGmailA','A','ref',$1,'internal')`,
          [ZERO_DIGEST],
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects an external_entity whose provider differs from its connection's provider", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cGmailA",
        ownerId: "A",
        provider: "gmail",
        displayName: "g",
      });
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["gmail"], connection_ids: ["cGmailA"] },
        discordThreadId: "tA",
      });
      const err = await attempt(() =>
        db.query(
          `INSERT INTO external_entities (entity_id, case_id, owner_id, connection_id,
             provider, kind, external_id)
           VALUES ('e1','caseA','A','cGmailA','jira','k','x')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a checkpoint whose last_run_id belongs to another case", async () => {
      await seedCasesAndRun(); // runA belongs to caseA; caseB also exists
      // A caseB checkpoint pointing at caseA's run.
      const err = await attempt(() =>
        db.query(
          `INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_run_id)
           VALUES ('caseB','B',1,'{}'::jsonb,'runA')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a decision_answer whose decision belongs to another case", async () => {
      await seedCasesAndRun();
      await db.query(
        `INSERT INTO decisions (decision_id, case_id, question, why_now, options,
           recommendation, blocked_scope, checkpoint_revision)
         VALUES ('dB','caseB','q','w','[]'::jsonb,'r','s',0)`,
      );
      // An answer under caseA referencing caseB's decision.
      const err = await attempt(() =>
        db.query(
          `INSERT INTO decision_answers (answer_id, decision_id, case_id,
             checkpoint_revision, selected_option_id, answered_by)
           VALUES ('ansX','dB','caseA',0,'opt','me')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    // --- AUDIT-03 HIGH-01: case_connections is the authoritative allowlist ---

    // Owner A has two jira connections; only cA is in caseA's scope. cA2 is a
    // same-owner connection deliberately left OUT of the allowlist.
    async function seedCaseWithExtraConnection(): Promise<void> {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cA",
        ownerId: "A",
        provider: "jira",
        displayName: "cA",
      });
      await connections.insert(db, {
        connectionId: "cA2",
        ownerId: "A",
        provider: "jira",
        displayName: "cA2",
      });
      await cases.insert(db, {
        caseId: "caseA",
        ownerId: "A",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["cA"] },
        discordThreadId: "tA",
      });
    }

    it("rejects an external_entity via a same-owner connection outside the case allowlist", async () => {
      await seedCaseWithExtraConnection();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO external_entities (entity_id, case_id, owner_id, connection_id,
             provider, kind, external_id)
           VALUES ('e1','caseA','A','cA2','jira','k','x')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects an external_action via a same-owner connection outside the case allowlist", async () => {
      await seedCaseWithExtraConnection();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO external_actions (action_id, case_id, owner_id, tool_name,
             connection_id, canonical_payload, action_digest, risk_tier,
             policy_decision, idempotency_key, status)
           VALUES ('a1','caseA','A','tool','cA2','{}'::jsonb,$1,'R0','AUTO_ALLOW','k1','PROPOSED')`,
          [`sha256:${"1".repeat(64)}`],
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("accepts an external_entity via an in-scope connection", async () => {
      await seedCaseWithExtraConnection();
      const ok = await db.query(
        `INSERT INTO external_entities (entity_id, case_id, owner_id, connection_id,
           provider, kind, external_id)
         VALUES ('eOK','caseA','A','cA','jira','k','x') RETURNING entity_id`,
      );
      expect(ok.rows).toHaveLength(1);
    });

    it("forbids direct INSERT into case_connections (tamper guard)", async () => {
      await seedCaseWithExtraConnection();
      const err = await attempt(() =>
        db.query(
          `INSERT INTO case_connections (case_id, owner_id, connection_id, provider)
           VALUES ('caseA','A','cA2','jira')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(ProtectedTableError);
    });

    it("forbids direct UPDATE of case_connections (tamper guard)", async () => {
      await seedCaseWithExtraConnection();
      const err = await attempt(() =>
        db.query("UPDATE case_connections SET connection_id = 'cA2' WHERE case_id = 'caseA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(ProtectedTableError);
    });

    it("forbids direct DELETE from case_connections (tamper guard)", async () => {
      await seedCaseWithExtraConnection();
      const err = await attempt(() =>
        db.query("DELETE FROM case_connections WHERE case_id = 'caseA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(ProtectedTableError);
    });

    it("re-syncs case_connections only through the scope trigger (add a connection)", async () => {
      await seedCaseWithExtraConnection();
      // Widening the scope via the normal write path is the only way to add cA2.
      await db.query(
        `UPDATE cases
           SET integration_scope = '{"providers":["jira"],"connection_ids":["cA","cA2"]}'::jsonb
         WHERE case_id = 'caseA'`,
      );
      const rows = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM case_connections WHERE case_id = 'caseA'",
      );
      expect(rows.rows[0]?.n).toBe("2");
      // Now the previously-rejected entity via cA2 is allowed.
      const ok = await db.query(
        `INSERT INTO external_entities (entity_id, case_id, owner_id, connection_id,
           provider, kind, external_id)
         VALUES ('e2','caseA','A','cA2','jira','k','y') RETURNING entity_id`,
      );
      expect(ok.rows).toHaveLength(1);
    });

    // --- AUDIT-03 HIGH-02: recovery pointers are owner/case bound ---

    it("rejects setting a case's active_run_id to another case's run", async () => {
      await seedCasesAndRun(); // runA belongs to caseA; caseB exists
      await db.query(
        `INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision)
         VALUES ('runB','caseB','B','wu','PLANNER','PLANNED',0)`,
      );
      const err = await attempt(() =>
        db.query("UPDATE cases SET active_run_id = 'runB' WHERE case_id = 'caseA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("accepts setting a case's active_run_id to its own run", async () => {
      await seedCasesAndRun();
      await db.query("UPDATE cases SET active_run_id = 'runA' WHERE case_id = 'caseA'");
      const c = await cases.findById(db, "caseA");
      expect(c?.active_run_id).toBe("runA");
    });

    it("rejects a run trigger_event_id that belongs to another owner", async () => {
      await seedCasesAndRun();
      // An event owned by B (via caseB's connection cB).
      await db.query(
        `INSERT INTO events (event_id, provider, connection_id, owner_id, external_event_id,
           event_type, dedupe_key, entity_provider, entity_kind, entity_external_id,
           trace_id, sensitivity, occurred_at)
         VALUES ('evB','jira','cB','B','x','t','dB','jira','k','x','tr','internal', now())`,
      );
      const err = await attempt(() =>
        db.query("UPDATE agent_runs SET trigger_event_id = 'evB' WHERE run_id = 'runA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects a checkpoint last_event_id that belongs to another owner", async () => {
      await seedCasesAndRun();
      await db.query(
        `INSERT INTO events (event_id, provider, connection_id, owner_id, external_event_id,
           event_type, dedupe_key, entity_provider, entity_kind, entity_external_id,
           trace_id, sensitivity, occurred_at)
         VALUES ('evB','jira','cB','B','x','t','dB','jira','k','x','tr','internal', now())`,
      );
      // caseA (owner A) checkpoint referencing owner B's event.
      const err = await attempt(() =>
        db.query(
          `INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_event_id)
           VALUES ('caseA','A',1,'{}'::jsonb,'evB')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("rejects forging a run's owner_id away from its case", async () => {
      await seedCasesAndRun(); // runA is (caseA, owner A)
      const err = await attempt(() =>
        db.query("UPDATE agent_runs SET owner_id = 'B' WHERE run_id = 'runA'"),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    // --- AUDIT-03 HIGH-03: approval bound to the exact action digest ---

    it("rejects an approved action whose digest differs from the approval's digest", async () => {
      await seedCasesAndRun();
      const digestA = `sha256:${"a".repeat(64)}`;
      await db.query(
        `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
           action_digest, checkpoint_revision, expires_at)
         VALUES ('apA','caseA','A','owner',$1, 0, now() + interval '1 hour')`,
        [digestA],
      );
      const err = await attempt(() =>
        db.query(
          `INSERT INTO external_actions (action_id, case_id, owner_id, tool_name,
             connection_id, canonical_payload, action_digest, risk_tier,
             policy_decision, approval_id, idempotency_key, status)
           VALUES ('actBad','caseA','A','tool','cA','{}'::jsonb,$1,'R3','REQUIRES_APPROVAL','apA','kb','APPROVED')`,
          [`sha256:${"b".repeat(64)}`],
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(IntegrityViolationError);
    });

    it("accepts an approved action whose digest exactly matches the approval", async () => {
      await seedCasesAndRun();
      const digestA = `sha256:${"a".repeat(64)}`;
      await db.query(
        `INSERT INTO approvals (approval_id, case_id, owner_id, granted_by,
           action_digest, checkpoint_revision, expires_at)
         VALUES ('apA','caseA','A','owner',$1, 0, now() + interval '1 hour')`,
        [digestA],
      );
      const ok = await db.query(
        `INSERT INTO external_actions (action_id, case_id, owner_id, tool_name,
           connection_id, canonical_payload, action_digest, risk_tier,
           policy_decision, approval_id, idempotency_key, status)
         VALUES ('actOK','caseA','A','tool','cA','{}'::jsonb,$1,'R3','REQUIRES_APPROVAL','apA','kok','APPROVED')
         RETURNING action_id`,
        [digestA],
      );
      expect(ok.rows).toHaveLength(1);
    });

    // --- AUDIT-03 MEDIUM: runtime integration_scope contract enforcement ---

    it("rejects an empty integration_scope via the repository (contract)", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await expect(
        cases.insert(db, {
          caseId: "caseEmpty",
          ownerId: "A",
          status: "NEW",
          // Empty arrays violate the min(1) contract.
          integrationScope: { providers: [], connection_ids: [] } as never,
          discordThreadId: "tEmpty",
        }),
      ).rejects.toBeInstanceOf(ContractViolationError);
    });

    it("rejects an unknown provider in integration_scope via the repository (contract)", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cA",
        ownerId: "A",
        provider: "jira",
        displayName: "cA",
      });
      await expect(
        cases.insert(db, {
          caseId: "caseBadProv",
          ownerId: "A",
          status: "NEW",
          integrationScope: { providers: ["slack"], connection_ids: ["cA"] } as never,
          discordThreadId: "tBP",
        }),
      ).rejects.toBeInstanceOf(ContractViolationError);
    });

    it("rejects a mistyped integration_scope element via the repository (contract)", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await expect(
        cases.insert(db, {
          caseId: "caseBadType",
          ownerId: "A",
          status: "NEW",
          integrationScope: { providers: ["jira"], connection_ids: [123] } as never,
          discordThreadId: "tBT",
        }),
      ).rejects.toBeInstanceOf(ContractViolationError);
    });

    it("rejects a malformed integration_scope on a direct SQL insert (DB trigger)", async () => {
      await owners.insert(db, { ownerId: "A", displayName: "A" });
      await connections.insert(db, {
        connectionId: "cA",
        ownerId: "A",
        provider: "jira",
        displayName: "cA",
      });
      // Bypass the repository: a plain SQL insert must still be rejected by the
      // DB trigger (unexpected key here).
      const err = await attempt(() =>
        db.query(
          `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id)
           VALUES ('caseSql','A','NEW','{"providers":["jira"],"connection_ids":["cA"],"evil":1}'::jsonb,'tSql')`,
        ),
      );
      expect(translatePgError(err)).toBeInstanceOf(ScopeViolationError);
    });
  },
  available,
);
