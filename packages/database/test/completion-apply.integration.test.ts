import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prepareCompletion } from "@remoteagent/agent-orchestrator";
import {
  ContractViolationError,
  Database,
  RunCompletionConflictError,
  RunCompletionRepository,
  RunCompletionStateError,
} from "../src/index.js";
import { OutboxRepository, SequentialIdGenerator, SystemClock } from "../src/queue/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
import { makeCheckpoint } from "./fixtures.js";

const available = await ensurePostgres();

describeIntegration(
  "atomic completion persistence",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let repo: RunCompletionRepository;
    const prepared = (runId = "run-1", caseId = "case-1", completionId = "completion-1") =>
      prepareCompletion({
        completion: {
          schema_version: 1,
          run_id: runId,
          case_id: caseId,
          status: "COMPLETED",
          summary: "done",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
        },
        current: makeCheckpoint(caseId, 0),
        system: {
          completionId,
          runId,
          caseId,
          expectedRevision: 0,
          finishedAt: "2026-08-20T11:00:00Z",
        },
      });

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      repo = new RunCompletionRepository(
        db,
        new OutboxRepository({ clock: new SystemClock(), ids: new SequentialIdGenerator() }),
      );
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, run_completions, agent_runs, case_checkpoints, cases, owners RESTART IDENTITY CASCADE",
      );
      await db.query("INSERT INTO owners (owner_id, display_name) VALUES ('owner-1', 'owner')");
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-1', 'owner-1', 'jira', 'jira', 'unconfigured://conn-1')",
      );
    });
    async function seed(
      runId = "run-1",
      caseId = "case-1",
      revision = 0,
      active: string | null = runId,
    ) {
      await db.query(
        'INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id, checkpoint_revision) VALUES ($1, \'owner-1\', \'IMPLEMENTING\', \'{"providers":["jira"],"connection_ids":["conn-1"]}\', $2, $3)',
        [caseId, `thread-${caseId}`, revision],
      );
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, work_unit_id, role, safety_state, checkpoint_revision, owner_id) VALUES ($1,$2,'wu','IMPLEMENTER','STARTED',$3,'owner-1')",
        [runId, caseId, revision],
      );
      await db.query("UPDATE cases SET active_run_id = $2 WHERE case_id = $1", [caseId, active]);
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ($1,'owner-1',$2,$3)",
        [caseId, revision, JSON.stringify(makeCheckpoint(caseId, revision))],
      );
    }

    it("commits all state and exact replay is write-free", async () => {
      await seed();
      const input = prepared();
      const first = await repo.apply(input);
      expect(first.replayed).toBe(false);
      const reorder = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(reorder)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                  .reverse()
                  .map(([k, v]) => [k, reorder(v)]),
              )
            : value;
      const replay = await repo.apply(reorder(input));
      expect(replay).toEqual({ ...first, replayed: true });
      const counts = await db.query(
        "SELECT (SELECT count(*) FROM run_completions) completions, (SELECT count(*) FROM case_checkpoints) checkpoints, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM outbox_dispatch) dispatch",
      );
      expect(counts.rows[0]).toEqual({
        completions: "1",
        checkpoints: "2",
        outbox: "1",
        dispatch: "1",
      });
      const state = await db.query(
        "SELECT safety_state, finished_at FROM agent_runs WHERE run_id='run-1'",
      );
      expect(state.rows[0]!.safety_state).toBe("SUCCEEDED");
      expect(state.rows[0]!.finished_at.toISOString()).toBe("2026-08-20T11:00:00.000Z");
      expect(
        (await db.query("SELECT completion FROM run_completions WHERE run_id='run-1'")).rows[0]!
          .completion,
      ).toEqual(input.completion);
      expect(
        (await db.query("SELECT checkpoint FROM case_checkpoints WHERE revision=1")).rows[0]!
          .checkpoint,
      ).toEqual(input.checkpoint);
      expect((await db.query("SELECT payload FROM outbox")).rows[0]!.payload).toEqual(
        input.outbox.payload,
      );
      expect(
        (await db.query("SELECT revision, last_run_id FROM case_checkpoints WHERE revision=1"))
          .rows[0],
      ).toEqual({ revision: 1, last_run_id: "run-1" });
      expect(
        (
          await db.query(
            "SELECT checkpoint_revision, active_run_id FROM cases WHERE case_id='case-1'",
          )
        ).rows[0],
      ).toEqual({ checkpoint_revision: 1, active_run_id: null });
    });

    it("rejects malformed, conflicting and stale inputs without writes", async () => {
      await seed();
      const input = prepared();
      const before = await db.query(
        "SELECT (SELECT count(*) FROM run_completions) completions, (SELECT count(*) FROM case_checkpoints) checkpoints, (SELECT count(*) FROM outbox) outbox",
      );
      await expect(
        repo.apply({ ...input, checkpoint: { ...input.checkpoint, case_id: "other" } }),
      ).rejects.toBeInstanceOf(ContractViolationError);
      const after = await db.query(
        "SELECT (SELECT count(*) FROM run_completions) completions, (SELECT count(*) FROM case_checkpoints) checkpoints, (SELECT count(*) FROM outbox) outbox",
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      await repo.apply(input);
      await expect(
        repo.apply({ ...input, completion: { ...input.completion, summary: "different" } }),
      ).rejects.toBeInstanceOf(RunCompletionConflictError);
      await expect(
        repo.apply({ ...input, checkpoint: { ...input.checkpoint, goal: "different" } }),
      ).rejects.toBeInstanceOf(RunCompletionConflictError);
      await expect(
        repo.apply({
          ...input,
          outbox: { ...input.outbox, payload: { ...input.outbox.payload, completionId: "other" } },
        }),
      ).rejects.toBeInstanceOf(RunCompletionConflictError);
      expect(
        (
          await db.query(
            "SELECT (SELECT count(*) FROM run_completions) completions, (SELECT count(*) FROM case_checkpoints) checkpoints, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM outbox_dispatch) dispatch",
          )
        ).rows[0],
      ).toEqual({ completions: "1", checkpoints: "2", outbox: "1", dispatch: "1" });
      await expect(repo.apply(input)).resolves.toMatchObject({ replayed: true });
      expect((await db.query("SELECT count(*) FROM run_completions")).rows[0]!.count).toBe("1");
    });

    it("rejects inactive and cross-case runs", async () => {
      await seed("run-1", "case-1", 0, null);
      await expect(repo.apply(prepared())).rejects.toBeInstanceOf(RunCompletionStateError);
      await seed("run-2", "case-2");
      await expect(repo.apply(prepared("run-2", "case-1", "completion-2"))).rejects.toBeInstanceOf(
        RunCompletionStateError,
      );
      await seed("run-stale", "case-stale");
      await db.query("UPDATE cases SET checkpoint_revision = 1 WHERE case_id = 'case-stale'");
      await expect(
        repo.apply(prepared("run-stale", "case-stale", "completion-stale")),
      ).rejects.toBeInstanceOf(RunCompletionStateError);
    });

    it("allows exactly one concurrent winner", async () => {
      await seed("run-a", "case-1");
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, work_unit_id, role, safety_state, checkpoint_revision, owner_id) VALUES ('run-b','case-1','wu','IMPLEMENTER','STARTED',0,'owner-1')",
      );
      const results = await Promise.allSettled([
        repo.apply(prepared("run-a", "case-1", "ca")),
        repo.apply(prepared("run-b", "case-1", "cb")),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await db.query("SELECT count(*) FROM run_completions")).rows[0]!.count).toBe("1");
      expect(
        (await db.query("SELECT count(*) FROM case_checkpoints WHERE revision=1")).rows[0]!.count,
      ).toBe("1");
      expect((await db.query("SELECT count(*) FROM outbox")).rows[0]!.count).toBe("1");
    });

    it.each([
      ["run_completions", "INSERT"],
      ["case_checkpoints", "INSERT"],
      ["agent_runs", "UPDATE"],
      ["cases", "UPDATE"],
      ["outbox", "INSERT"],
      ["outbox_dispatch", "INSERT"],
    ] as const)("rolls back completely after fault at %s %s", async (table, operation) => {
      await seed();
      await db.query(
        "CREATE OR REPLACE FUNCTION ra_test_completion_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'completion fault'; END $$",
      );
      const whenClause =
        table === "cases" ? " WHEN (OLD.active_run_id IS DISTINCT FROM NEW.active_run_id)" : "";
      await db.query(
        `CREATE TRIGGER ra_test_completion_fault_trigger AFTER ${operation} ON ${table} FOR EACH ROW${whenClause} EXECUTE FUNCTION ra_test_completion_fault()`,
      );
      await expect(repo.apply(prepared())).rejects.toThrow("completion fault");
      await db.query(`DROP TRIGGER ra_test_completion_fault_trigger ON ${table}`);
      await db.query("DROP FUNCTION ra_test_completion_fault()");
      const state = await db.query<{
        completions: string;
        checkpoints: string;
        outbox: string;
        dispatch: string;
        run_state: string;
        active: string | null;
        revision: string;
      }>(
        `SELECT (SELECT count(*)::text FROM run_completions) completions, (SELECT count(*)::text FROM case_checkpoints WHERE revision=1) checkpoints, (SELECT count(*)::text FROM outbox) outbox, (SELECT count(*)::text FROM outbox_dispatch) dispatch, (SELECT safety_state FROM agent_runs WHERE run_id='run-1') run_state, (SELECT active_run_id FROM cases WHERE case_id='case-1') active, (SELECT checkpoint_revision::text FROM cases WHERE case_id='case-1') revision`,
      );
      expect(state.rows[0]).toMatchObject({
        completions: "0",
        checkpoints: "0",
        outbox: "0",
        dispatch: "0",
        run_state: "STARTED",
        active: "run-1",
        revision: "0",
      });
    });
  },
  available,
);
