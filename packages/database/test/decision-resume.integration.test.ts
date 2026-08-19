import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import {
  Database,
  ContractViolationError,
  DecisionResumeConflictError,
  DecisionResumeRepository,
  DecisionResumeStateError,
  JobStore,
  SequentialIdGenerator,
  SystemClock,
} from "../src/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "atomic decision answer and resume",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let repo: DecisionResumeRepository;
    const answer = (selected = "safe") => ({
      schema_version: 1,
      decision_id: "decision-1",
      case_id: "case-1",
      checkpoint_revision: 3,
      selected_option_id: selected,
      answered_by: "owner-1",
      answered_at: "2026-08-20T12:00:00.000Z",
    });

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      repo = new DecisionResumeRepository(
        db,
        new JobStore({ clock: new SystemClock(), ids: new SequentialIdGenerator() }),
      );
    });
    afterAll(async () => drop());

    beforeEach(async () => {
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, jobs, decision_answers, decisions, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await db.query("INSERT INTO owners (owner_id, display_name) VALUES ('owner-1', 'Owner')");
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-1', 'owner-1', 'jira', 'Jira', 'unconfigured://conn-1')",
      );
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id, checkpoint_revision)
       VALUES ('case-1', 'owner-1', 'WAITING_FOR_USER', '{"providers":["jira"],"connection_ids":["conn-1"]}', 'thread-1', 3)`,
      );
      await db.query(
        `INSERT INTO decisions
       (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision, expires_at)
       VALUES ('decision-1', 'case-1', 'Choose', 'Now', $1::jsonb, 'safe', 'work', 3, '2026-08-21T00:00:00Z')`,
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "Slow" },
            { id: "fast", label: "Fast", consequences: "Risky" },
          ]),
        ],
      );
    });

    it("commits the answer and redacted pending per-case resume job", async () => {
      const result = await repo.answer({ answerId: "answer-1", answer: answer() });
      expect(result.replayed).toBe(false);
      expect(
        (
          await db.query(
            "SELECT status, provider, serialization_key, payload FROM jobs WHERE job_id = $1",
            [result.jobId],
          )
        ).rows[0],
      ).toEqual({
        status: "PENDING",
        provider: null,
        serialization_key: "case-1",
        payload: {
          answerId: "answer-1",
          decisionId: "decision-1",
          caseId: "case-1",
          checkpointRevision: 3,
        },
      });
      expect(
        (
          await db.query(
            "SELECT answer_id, decision_id, case_id, checkpoint_revision, selected_option_id, note, answered_by, answered_at FROM decision_answers",
          )
        ).rows[0],
      ).toEqual({
        answer_id: "answer-1",
        decision_id: "decision-1",
        case_id: "case-1",
        checkpoint_revision: 3,
        selected_option_id: "safe",
        note: null,
        answered_by: "owner-1",
        answered_at: new Date("2026-08-20T12:00:00.000Z"),
      });
      expect(
        (await db.query("SELECT status FROM cases WHERE case_id = 'case-1'")).rows[0]!.status,
      ).toBe("PLANNING");
      expect((await repo.answer({ answerId: "answer-1", answer: answer() })).replayed).toBe(true);
    });

    it("rejects stale and conflicting answers without writes", async () => {
      await expect(
        repo.answer({ answerId: "answer-1", answer: answer("unknown") }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      await repo.answer({ answerId: "answer-1", answer: answer() });
      await expect(repo.answer({ answerId: "answer-2", answer: answer() })).rejects.toBeInstanceOf(
        DecisionResumeConflictError,
      );
    });

    it("rejects malformed, foreign, unknown-option, and missing decisions", async () => {
      await expect(
        repo.answer({ answerId: "a", answer: answer(), extra: true }),
      ).rejects.toBeInstanceOf(ContractViolationError);
      await expect(
        repo.answer({ answerId: "b", answer: { ...answer(), case_id: "case-x" } }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      await expect(
        repo.answer({ answerId: "c", answer: answer("unknown") }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      await expect(
        repo.answer({ answerId: "d", answer: { ...answer(), decision_id: "missing" } }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        0,
      );
    });

    it("enforces both revision directions and case status", async () => {
      await expect(
        repo.answer({ answerId: "a", answer: { ...answer(), checkpoint_revision: 2 } }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      await db.query("UPDATE cases SET checkpoint_revision = 4 WHERE case_id = 'case-1'");
      await expect(repo.answer({ answerId: "b", answer: answer() })).rejects.toBeInstanceOf(
        DecisionResumeStateError,
      );
      await db.query(
        "UPDATE cases SET checkpoint_revision = 3, status = 'PLANNING' WHERE case_id = 'case-1'",
      );
      await expect(repo.answer({ answerId: "c", answer: answer() })).rejects.toBeInstanceOf(
        DecisionResumeStateError,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        0,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n).toBe(0);
    });

    it.each([
      ["answer revision 4", async () => ({ answer: { ...answer(), checkpoint_revision: 4 } })],
      [
        "case revision 2",
        async () => {
          await db.query("UPDATE cases SET checkpoint_revision = 2 WHERE case_id = 'case-1'");
          return { answer: answer() };
        },
      ],
      [
        "case revision 4",
        async () => {
          await db.query("UPDATE cases SET checkpoint_revision = 4 WHERE case_id = 'case-1'");
          return { answer: answer() };
        },
      ],
    ] as const)("rejects %s without writes", async (_name, prepare) => {
      const input = await prepare();
      await expect(repo.answer({ answerId: `revision-${_name}`, ...input })).rejects.toBeInstanceOf(
        DecisionResumeStateError,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        0,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n).toBe(0);
      expect(
        (await db.query("SELECT status FROM cases WHERE case_id = 'case-1'")).rows[0]!.status,
      ).toBe("WAITING_FOR_USER");
    });

    it("applies a strict expiry boundary", async () => {
      await db.query(
        `INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision, expires_at)
         VALUES ('decision-boundary', 'case-1', 'Q', 'N', $1::jsonb, 'safe', 'work', 3, '2026-08-20T12:00:00.001Z')`,
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "Slow" },
            { id: "fast", label: "Fast", consequences: "Risky" },
          ]),
        ],
      );
      const boundaryAnswer = (answered_at: string) => ({
        ...answer(),
        decision_id: "decision-boundary",
        answered_at,
      });
      expect(
        (
          await repo.answer({
            answerId: "before",
            answer: boundaryAnswer("2026-08-20T12:00:00.000Z"),
          })
        ).replayed,
      ).toBe(false);
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, jobs, decision_answers RESTART IDENTITY CASCADE",
      );
      await db.query("UPDATE cases SET status = 'WAITING_FOR_USER'");
      await expect(
        repo.answer({
          answerId: "exact",
          answer: boundaryAnswer("2026-08-20T12:00:00.001Z"),
        }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      await expect(
        repo.answer({
          answerId: "after",
          answer: boundaryAnswer("2026-08-20T12:00:00.002Z"),
        }),
      ).rejects.toBeInstanceOf(DecisionResumeStateError);
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        0,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n).toBe(0);
    });

    it("detects answer-id collisions across decisions", async () => {
      await db.query(
        `INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision)
         VALUES ('decision-2', 'case-1', 'Q', 'N', $1::jsonb, 'safe', 'work', 3)`,
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "Slow" },
            { id: "fast", label: "Fast", consequences: "Risky" },
          ]),
        ],
      );
      await db.query(
        `INSERT INTO decision_answers (answer_id, decision_id, case_id, checkpoint_revision, selected_option_id, answered_by, answered_at)
         VALUES ('taken', 'decision-2', 'case-1', 3, 'safe', 'owner-1', '2026-08-20T11:00:00Z')`,
      );
      await expect(repo.answer({ answerId: "taken", answer: answer() })).rejects.toBeInstanceOf(
        DecisionResumeConflictError,
      );
    });

    it("replays without writes after a job becomes terminal", async () => {
      const first = await repo.answer({ answerId: "terminal", answer: answer() });
      await db.query("UPDATE jobs SET status = 'SUCCEEDED' WHERE job_id = $1", [first.jobId]);
      expect(await repo.answer({ answerId: "terminal", answer: answer() })).toEqual({
        replayed: true,
        answerId: "terminal",
        jobId: first.jobId,
      });
    });

    it("rejects a resume job with a non-null provider", async () => {
      const first = await repo.answer({ answerId: "provider", answer: answer() });
      await db.query("UPDATE jobs SET provider = 'discord' WHERE job_id = $1", [first.jobId]);
      await expect(repo.answer({ answerId: "provider", answer: answer() })).rejects.toBeInstanceOf(
        DecisionResumeConflictError,
      );
    });

    it("rejects an existing answer when its resume job is missing", async () => {
      const first = await repo.answer({ answerId: "missing-job", answer: answer() });
      await db.query("DELETE FROM jobs WHERE job_id = $1", [first.jobId]);
      await expect(
        repo.answer({ answerId: "missing-job", answer: answer() }),
      ).rejects.toBeInstanceOf(DecisionResumeConflictError);
    });

    it("rejects an active run before any new answer write", async () => {
      await db.query(
        `INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision)
         VALUES ('active-run', 'case-1', 'owner-1', 'wu', 'IMPLEMENTER', 'STARTED', 3)`,
      );
      await db.query("UPDATE cases SET active_run_id = 'active-run'");
      await expect(repo.answer({ answerId: "active", answer: answer() })).rejects.toBeInstanceOf(
        DecisionResumeStateError,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        0,
      );
    });
    it("serializes concurrent exact answers to one insert and one replay", async () => {
      const results = await Promise.all([
        repo.answer({ answerId: "concurrent", answer: answer() }),
        repo.answer({ answerId: "concurrent", answer: answer() }),
      ]);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        1,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n).toBe(1);
    });

    it("maps answer-id races across different decisions to a typed conflict", async () => {
      await db.query(
        `INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id, checkpoint_revision)
         VALUES ('case-2', 'owner-1', 'WAITING_FOR_USER', '{"providers":["jira"],"connection_ids":["conn-1"]}', 'thread-2', 3)`,
      );
      await db.query(
        `INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision)
         VALUES ('decision-2', 'case-2', 'Q', 'N', $1::jsonb, 'safe', 'work', 3)`,
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "Slow" },
            { id: "fast", label: "Fast", consequences: "Risky" },
          ]),
        ],
      );
      const results = await Promise.allSettled([
        repo.answer({ answerId: "cross-race", answer: answer() }),
        repo.answer({
          answerId: "cross-race",
          answer: { ...answer(), decision_id: "decision-2", case_id: "case-2" },
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === "rejected" && result.reason instanceof DecisionResumeConflictError,
        ),
      ).toHaveLength(1);
      expect((await db.query("SELECT count(*)::int AS n FROM decision_answers")).rows[0]!.n).toBe(
        1,
      );
      expect((await db.query("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n).toBe(1);
    });

    it.each(["null", "[]"])(
      "rejects malformed existing job payload %s as typed conflict",
      async (payload) => {
        await repo.answer({ answerId: "malformed-job", answer: answer() });
        await db.query("UPDATE jobs SET payload = $1::jsonb", [payload]);
        await expect(
          repo.answer({ answerId: "malformed-job", answer: answer() }),
        ).rejects.toBeInstanceOf(DecisionResumeConflictError);
      },
    );

    it("rejects duplicate resume jobs for an existing answer", async () => {
      const first = await repo.answer({ answerId: "duplicate-job", answer: answer() });
      await db.query(
        `INSERT INTO jobs (job_id, case_id, job_type, payload, provider, serialization_key)
         SELECT 'job-duplicate', case_id, job_type, payload, provider, serialization_key FROM jobs WHERE job_id = $1`,
        [first.jobId],
      );
      await expect(
        repo.answer({ answerId: "duplicate-job", answer: answer() }),
      ).rejects.toBeInstanceOf(DecisionResumeConflictError);
    });

    for (const [table, trigger] of [
      ["decision_answers", "decision_resume_answer_fault"],
      ["cases", "decision_resume_case_fault"],
      ["jobs", "decision_resume_job_fault"],
    ] as const) {
      it(`rolls back after ${table} write`, async () => {
        await db.query(
          `CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fault'; END $$`,
        );
        const triggerSql =
          table === "cases"
            ? `CREATE TRIGGER ${trigger}_trigger BEFORE UPDATE ON cases FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION ${trigger}()`
            : `CREATE TRIGGER ${trigger}_trigger BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${trigger}()`;
        await db.query(triggerSql);
        await expect(
          repo.answer({ answerId: `fault-${table}`, answer: answer() }),
        ).rejects.toBeInstanceOf(Error);
        await db.query(`DROP TRIGGER ${trigger}_trigger ON ${table}`);
        await db.query(`DROP FUNCTION ${trigger}()`);
        const state = await db.query(
          "SELECT (SELECT count(*)::int FROM decision_answers) answers, (SELECT count(*)::int FROM jobs) jobs, (SELECT status FROM cases) status",
        );
        expect(state.rows[0]).toEqual({ answers: 0, jobs: 0, status: "WAITING_FOR_USER" });
      });
    }
  },
  available,
);
