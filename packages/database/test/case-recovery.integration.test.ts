import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { CaseRecoveryRepository, CaseRecoveryStateError, Database } from "../src/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
import { makeCheckpoint } from "./fixtures.js";

const available = await ensurePostgres();

describeIntegration(
  "case recovery snapshot",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let repo: CaseRecoveryRepository;
    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      repo = new CaseRecoveryRepository(db);
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, jobs, decision_answers, decisions, run_intents, run_completions, agent_runs, case_connections, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await db.query("INSERT INTO owners (owner_id, display_name) VALUES ('owner-1', 'Owner')");
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-1', 'owner-1', 'jira', 'Jira', 'unconfigured://conn-1')",
      );
      await db.query(
        "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ('case-1','owner-1','PLANNING',$1,'thread-1')",
        [JSON.stringify({ providers: ["jira"], connection_ids: ["conn-1"] })],
      );
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',0,$1)",
        [JSON.stringify(makeCheckpoint("case-1", 0))],
      );
    });

    it("returns the authoritative scope and distinguishes absent completion", async () => {
      const before = (await db.query("SELECT count(*)::int AS n FROM case_checkpoints")).rows[0]!.n;
      const snapshot = await repo.snapshot("case-1");
      expect(snapshot.case.ownerId).toBe("owner-1");
      expect(snapshot.bindings).toEqual([{ connectionId: "conn-1", provider: "jira" }]);
      expect(snapshot.checkpointCompletion).toEqual({ state: "ABSENT" });
      expect((await db.query("SELECT count(*)::int AS n FROM case_checkpoints")).rows[0]!.n).toBe(
        before,
      );
    });

    it("returns an active run with intents but no completion as an absent completion", async () => {
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision) VALUES ('active-run-1','case-1','owner-1','wu-active','IMPLEMENTER','STARTED',0)",
      );
      await db.query(
        "INSERT INTO run_intents (intent_id, run_id, case_id, kind, payload) VALUES ('active-intent-1','active-run-1','case-1','jira.read','{}')",
      );
      await db.query("UPDATE cases SET active_run_id='active-run-1' WHERE case_id='case-1'");
      const before = await durableRows();
      const snapshot = await repo.snapshot("case-1");
      expect(snapshot.activeRun?.runId).toBe("active-run-1");
      expect(snapshot.activeRun?.intents.map((intent) => intent.intentId)).toEqual([
        "active-intent-1",
      ]);
      expect(snapshot.activeRun?.completion).toBeNull();
      expect(snapshot.checkpointCompletion).toEqual({ state: "ABSENT" });
      expect(await durableRows()).toEqual(before);
    });

    it("fails closed when checkpoint points to a run without a completion", async () => {
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision) VALUES ('missing-completion-run','case-1','owner-1','wu-missing','IMPLEMENTER','SUCCEEDED',1)",
      );
      const checkpoint = { ...makeCheckpoint("case-1", 1), last_run_id: "missing-completion-run" };
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_run_id) VALUES ('case-1','owner-1',1,$1,'missing-completion-run')",
        [JSON.stringify(checkpoint)],
      );
      await db.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id='case-1'");
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });

    it("fails closed for malformed persisted completion JSON", async () => {
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision) VALUES ('malformed-completion-run','case-1','owner-1','wu-malformed','IMPLEMENTER','SUCCEEDED',1)",
      );
      const checkpoint = {
        ...makeCheckpoint("case-1", 1),
        last_run_id: "malformed-completion-run",
      };
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_run_id) VALUES ('case-1','owner-1',1,$1,'malformed-completion-run')",
        [JSON.stringify(checkpoint)],
      );
      await db.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id='case-1'");
      await db.query(
        "INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ('malformed-completion-1','malformed-completion-run','case-1','COMPLETED','{}')",
      );
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });

    it("fails closed for a runtime-invalid persisted decision request", async () => {
      await db.query(
        "INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision) VALUES ('invalid-decision-1','case-1','Question','needed',$1,'missing','implementation',0)",
        [JSON.stringify([{ id: "safe", label: "Safe", consequences: "slow" }])],
      );
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });

    it("fails closed when a persisted answer does not match its request", async () => {
      await db.query(
        "INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision) VALUES ('mismatched-decision-1','case-1','Question','needed',$1,'safe','implementation',0)",
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "slow" },
            { id: "fast", label: "Fast", consequences: "risky" },
          ]),
        ],
      );
      await db.query(
        "INSERT INTO decision_answers (answer_id, decision_id, case_id, checkpoint_revision, selected_option_id, answered_by, answered_at) VALUES ('mismatched-answer-1','mismatched-decision-1','case-1',0,'unknown','owner-1','2026-08-20T12:00:00Z')",
      );
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });

    it("fails closed for a resume job payload with an extra key", async () => {
      await db.query(
        "INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision) VALUES ('strict-decision-1','case-1','Question','needed',$1,'safe','implementation',0)",
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "slow" },
            { id: "fast", label: "Fast", consequences: "risky" },
          ]),
        ],
      );
      await db.query(
        "INSERT INTO decision_answers (answer_id, decision_id, case_id, checkpoint_revision, selected_option_id, answered_by, answered_at) VALUES ('strict-answer-1','strict-decision-1','case-1',0,'safe','owner-1','2026-08-20T12:00:00Z')",
      );
      await db.query(
        "INSERT INTO jobs (job_id, case_id, job_type, status, payload, serialization_key) VALUES ('strict-job-1','case-1','case.resume','PENDING',$1,'case-1')",
        [
          JSON.stringify({
            answerId: "strict-answer-1",
            decisionId: "strict-decision-1",
            caseId: "case-1",
            checkpointRevision: 0,
            extra: true,
          }),
        ],
      );
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });

    it("isolates case-1 snapshot from another case's durable recovery records", async () => {
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-2','owner-1','gmail','Gmail','unconfigured://conn-2')",
      );
      await db.query(
        "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ('case-2','owner-1','PLANNING',$1,'thread-2')",
        [JSON.stringify({ providers: ["gmail"], connection_ids: ["conn-2"] })],
      );
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-2','owner-1',0,$1)",
        [JSON.stringify(makeCheckpoint("case-2", 0))],
      );
      await db.query(
        "INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision) VALUES ('case-2-decision','case-2','Question','needed',$1,'safe','implementation',0)",
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "slow" },
            { id: "fast", label: "Fast", consequences: "risky" },
          ]),
        ],
      );
      await db.query(
        "INSERT INTO decision_answers (answer_id, decision_id, case_id, checkpoint_revision, selected_option_id, answered_by, answered_at) VALUES ('case-2-answer','case-2-decision','case-2',0,'safe','owner-1','2026-08-20T12:00:00Z')",
      );
      await db.query(
        "INSERT INTO jobs (job_id, case_id, job_type, status, payload, serialization_key) VALUES ('case-2-job','case-2','case.resume','PENDING',$1,'case-2')",
        [
          JSON.stringify({
            answerId: "case-2-answer",
            decisionId: "case-2-decision",
            caseId: "case-2",
            checkpointRevision: 0,
          }),
        ],
      );
      const snapshot = await repo.snapshot("case-1");
      expect(snapshot.decisions).toEqual([]);
      expect(snapshot.resumeJobs).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain("case-2");
      expect(JSON.stringify(snapshot)).not.toContain("conn-2");
    });

    it("fails closed for malformed persisted checkpoint and isolates cases", async () => {
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',1,'{\"case_id\":\"foreign\"}'::jsonb)",
      );
      await db.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id='case-1'");
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
      await expect(repo.snapshot("missing")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });

    const completion = {
      schema_version: 1,
      run_id: "run-1",
      case_id: "case-1",
      status: "COMPLETED",
      summary: "completed",
      completed_steps: [],
      evidence: [],
      checkpoint_patch: {},
      next_actions: [],
    };
    const request = (id: string, revision = 1) => ({
      schema_version: 1,
      decision_id: id,
      case_id: "case-1",
      question: `Question ${id}`,
      why_now: "needed",
      options: [
        { id: "safe", label: "Safe", consequences: "slow" },
        { id: "fast", label: "Fast", consequences: "risky" },
      ],
      recommendation: "safe",
      blocked_scope: "implementation",
      checkpoint_revision: revision,
    });

    async function seedFull() {
      const checkpoint = { ...makeCheckpoint("case-1", 1), last_run_id: "run-1" };
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision) VALUES ('run-1','case-1','owner-1','wu-1','IMPLEMENTER','STARTED',1)",
      );
      await db.query(
        "INSERT INTO run_intents (intent_id, run_id, case_id, kind, payload) VALUES ('intent-1','run-1','case-1','jira.read','{}'), ('intent-2','run-1','case-1','jira.write','{\"key\":\"RA-1\"}')",
      );
      await db.query(
        "INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ('completion-1','run-1','case-1','COMPLETED',$1)",
        [JSON.stringify(completion)],
      );
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_run_id) VALUES ('case-1','owner-1',1,$1,'run-1')",
        [JSON.stringify(checkpoint)],
      );
      await db.query(
        "UPDATE cases SET checkpoint_revision=1, active_run_id='run-1' WHERE case_id='case-1'",
      );
      for (const [id, answered] of [
        ["decision-1", true],
        ["decision-2", false],
      ] as const) {
        await db.query(
          "INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision) VALUES ($1,'case-1',$2,'needed',$3,'safe','implementation',1)",
          [id, `Question ${id}`, JSON.stringify(request(id).options)],
        );
        if (answered)
          await db.query(
            "INSERT INTO decision_answers (answer_id, decision_id, case_id, checkpoint_revision, selected_option_id, answered_by, answered_at) VALUES ('answer-1',$1,'case-1',1,'safe','owner-1','2026-08-20T12:00:00Z')",
            [id],
          );
      }
      await db.query(
        "INSERT INTO jobs (job_id, case_id, job_type, status, payload, serialization_key) VALUES ('job-1','case-1','case.resume','RECONCILING',$1,'case-1')",
        [
          JSON.stringify({
            answerId: "answer-1",
            decisionId: "decision-1",
            caseId: "case-1",
            checkpointRevision: 1,
          }),
        ],
      );
    }

    async function durableRows() {
      const tables = [
        "agent_runs",
        "run_intents",
        "run_completions",
        "case_checkpoints",
        "decisions",
        "decision_answers",
        "jobs",
        "outbox",
        "outbox_dispatch",
      ];
      return Promise.all(
        tables.map(
          async (table) =>
            [table, (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows] as const,
        ),
      );
    }

    it("returns the complete real-PG recovery projection and is read-only", async () => {
      await seedFull();
      const before = await durableRows();
      const snapshot = await repo.recover("case-1");
      const after = await durableRows();
      expect(after).toEqual(before);
      expect(snapshot.activeRun?.intents.map((x) => x.intentId)).toEqual(["intent-1", "intent-2"]);
      expect(snapshot.activeRun?.completion?.status).toBe("COMPLETED");
      expect(snapshot.checkpointCompletion.state).toBe("CONFIRMED");
      expect(snapshot.decisions.map((x) => x.request.decision_id)).toEqual([
        "decision-1",
        "decision-2",
      ]);
      expect(snapshot.decisions[0]?.answer?.answerId).toBe("answer-1");
      expect(snapshot.resumeJobs[0]?.payload).toEqual({
        answerId: "answer-1",
        decisionId: "decision-1",
        caseId: "case-1",
        checkpointRevision: 1,
      });
      expect(snapshot.resumeJobs[0]?.status).toBe("RECONCILING");
    });

    it.each(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "DEAD_LETTER", "RECONCILING"] as const)(
      "accepts legal resume job status %s",
      async (status) => {
        await seedFull();
        await db.query("UPDATE jobs SET status=$1 WHERE job_id='job-1'", [status]);
        expect((await repo.snapshot("case-1")).resumeJobs[0]?.status).toBe(status);
      },
    );

    it("fails closed for absent or malformed durable records and invalid input", async () => {
      await expect(repo.snapshot("not an id")).rejects.toBeInstanceOf(CaseRecoveryStateError);
      await db.query("UPDATE cases SET checkpoint_revision=1 WHERE case_id='case-1'");
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',1,'{}')",
      );
      await expect(repo.snapshot("case-1")).rejects.toBeInstanceOf(CaseRecoveryStateError);
    });
  },
  available,
);
