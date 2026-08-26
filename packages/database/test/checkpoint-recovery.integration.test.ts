import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  prepareCompletion,
  prepareDecisionAnswer,
  prepareDecisionRequest,
  buildRecoveryPlan,
} from "@remoteagent/agent-orchestrator";
import {
  CaseRecoveryRepository,
  Database,
  DecisionResumeRepository,
  DecisionWaitingRepository,
  JobStore,
  RunCompletionRepository,
} from "../src/index.js";
import { OutboxRepository, SequentialIdGenerator, SystemClock } from "../src/queue/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
import { makeCheckpoint } from "./fixtures.js";

const available = await ensurePostgres();

describeIntegration(
  "checkpoint recovery crash/resume matrix",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    const ids = new SequentialIdGenerator();
    const outbox = () => new OutboxRepository({ clock: new SystemClock(), ids });

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
    });
    afterAll(async () => drop());
    beforeEach(async () => {
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, jobs, decision_answers, decisions, run_intents, run_completions, agent_runs, case_connections, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await db.query("INSERT INTO owners (owner_id, display_name) VALUES ('owner-1','Owner')");
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-1','owner-1','jira','Jira','unconfigured://conn-1')",
      );
      await db.query(
        "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ('case-1','owner-1','IMPLEMENTING','{\"providers\":[\"jira\"],\"connection_ids\":[\"conn-1\"]}','thread-1')",
      );
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',0,$1)",
        [JSON.stringify(makeCheckpoint("case-1", 0))],
      );
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, owner_id, work_unit_id, role, safety_state, checkpoint_revision) VALUES ('run-1','case-1','owner-1','wu','IMPLEMENTER','STARTED',0)",
      );
      await db.query(
        "INSERT INTO run_intents (intent_id, run_id, case_id, kind, payload) VALUES ('intent-1','run-1','case-1','jira.read','{}')",
      );
      await db.query("UPDATE cases SET active_run_id='run-1' WHERE case_id='case-1'");
    });

    it("survives each committed boundary and exact replay without duplicate durable facts", async () => {
      const recovery = () => new CaseRecoveryRepository(db);
      const ledger = async () => {
        const tables = [
          "outbox_dispatch",
          "outbox",
          "jobs",
          "decision_answers",
          "decisions",
          "run_intents",
          "run_completions",
          "agent_runs",
          "case_checkpoints",
        ] as const;
        return Object.fromEntries(
          await Promise.all(
            tables.map(async (table) => [
              table,
              (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,
            ]),
          ),
        );
      };
      const beforeLedger = await ledger();
      const before = await recovery().snapshot("case-1");
      const beforePlan = buildRecoveryPlan({
        snapshot: before,
        budgetBytes: 100_000,
        toolNames: ["jira.read"],
      });
      expect(beforePlan).toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        automaticAction: { kind: "NONE" },
      });
      expect(JSON.stringify(beforePlan)).not.toContain("REPLAY_MODEL_CALL");
      expect(await ledger()).toEqual(beforeLedger);

      const current = makeCheckpoint("case-1", 0);
      const requestInput = {
        schema_version: 1,
        decision_id: "decision-1",
        case_id: "case-1",
        question: "Choose a path",
        why_now: "A decision is required",
        options: [
          { id: "safe", label: "Safe", consequences: "Slower" },
          { id: "fast", label: "Fast", consequences: "Riskier" },
        ],
        recommendation: "safe",
        blocked_scope: "implementation",
        checkpoint_revision: 0,
      };
      const completionPrepared = prepareCompletion({
        completion: {
          schema_version: 1,
          run_id: "run-1",
          case_id: "case-1",
          status: "WAITING_FOR_USER",
          summary: "waiting",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
          decision_request: requestInput,
        },
        current,
        system: {
          completionId: "completion-1",
          runId: "run-1",
          caseId: "case-1",
          expectedRevision: 0,
          finishedAt: "2026-08-20T11:00:00.000Z",
        },
      });
      const completionRepo = new RunCompletionRepository(db, outbox());
      const completionResult = await completionRepo.apply(completionPrepared);
      expect(completionResult.replayed).toBe(false);
      expect(await completionRepo.apply(structuredClone(completionPrepared))).toMatchObject({
        ...completionResult,
        replayed: true,
      });
      let snapshot = await recovery().snapshot("case-1");
      expect(snapshot.case.activeRunId).toBeNull();
      const preparedRequest = prepareDecisionRequest({
        completion:
          snapshot.checkpointCompletion.state === "CONFIRMED"
            ? snapshot.checkpointCompletion.value.completion
            : completionPrepared.completion,
        currentCheckpoint: snapshot.checkpoint,
      });
      const materializePlan = buildRecoveryPlan({
        snapshot,
        budgetBytes: 100_000,
        toolNames: ["jira.read"],
      });
      expect(materializePlan).toMatchObject({
        status: "MATERIALIZE_DECISION",
        automaticAction: { kind: "MATERIALIZE_DECISION" },
      });
      if (materializePlan.automaticAction.kind !== "MATERIALIZE_DECISION")
        throw new Error("expected materialization action");
      expect(preparedRequest).toEqual(materializePlan.automaticAction.preparedRequest);

      const waitingRepo = new DecisionWaitingRepository(db, outbox());
      const waitingResult = await waitingRepo.apply({
        sourceRunId: materializePlan.automaticAction.sourceRunId,
        request: materializePlan.automaticAction.preparedRequest,
      });
      expect(waitingResult.replayed).toBe(false);
      expect(
        await waitingRepo.apply(
          structuredClone({ sourceRunId: "run-1", request: preparedRequest }),
        ),
      ).toMatchObject({ ...waitingResult, replayed: true });
      snapshot = await recovery().snapshot("case-1");
      const waitingPlan = buildRecoveryPlan({
        snapshot,
        budgetBytes: 100_000,
        toolNames: ["jira.read"],
      });
      expect(waitingPlan.status).toBe("WAITING_FOR_USER");
      expect(snapshot.case.activeRunId).toBeNull();
      const waitingDecision = waitingPlan.context.fragments.find(
        (fragment) => fragment.fragment.kind === "decision",
      );
      expect(waitingDecision?.fragment.content).toContain("Choose a path");
      expect(waitingDecision?.fragment.provenance.origin).toBe("model");
      expect(waitingDecision?.fragment.trust).toBe("UNTRUSTED_DATA");
      expect(
        waitingPlan.context.omitted.filter((fragment) => fragment.fragment.kind === "decision"),
      ).toHaveLength(0);

      const answer = prepareDecisionAnswer({
        request: preparedRequest,
        selection: { decisionId: "decision-1", selectedOptionId: "safe", note: "approved" },
        system: {
          caseId: "case-1",
          currentRevision: 1,
          answeredBy: "owner-1",
          answeredAt: "2026-08-20T12:00:00.000Z",
        },
      });
      const resumeRepo = new DecisionResumeRepository(
        db,
        new JobStore({ clock: new SystemClock(), ids }),
        ids,
      );
      const answerResult = await resumeRepo.answer({ answerId: "answer-1", answer });
      expect(answerResult.replayed).toBe(false);
      expect(
        await resumeRepo.answer({ answerId: "answer-1", answer: structuredClone(answer) }),
      ).toMatchObject({ ...answerResult, replayed: true });
      snapshot = await recovery().snapshot("case-1");
      const plan = buildRecoveryPlan({ snapshot, budgetBytes: 100_000, toolNames: ["jira.read"] });
      expect(plan).toMatchObject({
        status: "RESUME_QUEUED",
        automaticAction: { kind: "NONE" },
        resumeJob: { jobId: answerResult.jobId },
      });
      expect(snapshot.case.activeRunId).toBeNull();
      const resumeDecision = plan.context.fragments.find(
        (fragment) => fragment.fragment.kind === "decision",
      );
      expect(resumeDecision?.fragment.content).toContain("Choose a path");
      expect(resumeDecision?.fragment.content).toContain("selected_option_id");
      expect(resumeDecision?.fragment.content).toContain("safe");
      expect(resumeDecision?.fragment.content).toContain("approved");
      expect(resumeDecision?.fragment.content).toContain("answer-1");
      expect(
        (
          await db.query(
            "SELECT (SELECT count(*) FROM run_intents) intents,(SELECT count(*) FROM run_completions) completions,(SELECT count(*) FROM case_checkpoints) checkpoints,(SELECT count(*) FROM decisions) decisions,(SELECT count(*) FROM decision_answers) answers,(SELECT count(*) FROM jobs) jobs,(SELECT count(*) FROM outbox) outbox,(SELECT count(*) FROM outbox_dispatch) dispatch",
          )
        ).rows[0],
      ).toEqual({
        intents: "1",
        completions: "1",
        checkpoints: "2",
        decisions: "1",
        answers: "1",
        jobs: "1",
        outbox: "2",
        dispatch: "2",
      });
    });

    it("keeps recovery snapshots isolated by case", async () => {
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-2','owner-1','gmail','Gmail','unconfigured://conn-2')",
      );
      await db.query(
        "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ('case-2','owner-1','PLANNING','{\"providers\":[\"gmail\"],\"connection_ids\":[\"conn-2\"]}','thread-2')",
      );
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-2','owner-1',0,$1)",
        [JSON.stringify(makeCheckpoint("case-2", 0))],
      );
      await db.query(
        "INSERT INTO decisions (decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision) VALUES ('case-2-decision','case-2','Case 2 question','Case 2 now',$1,'safe','implementation',0)",
        [
          JSON.stringify([
            { id: "safe", label: "Safe", consequences: "Slow" },
            { id: "fast", label: "Fast", consequences: "Risky" },
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
      const snapshot = await new CaseRecoveryRepository(db).snapshot("case-1");
      const case1Plan = buildRecoveryPlan({
        snapshot,
        budgetBytes: 100_000,
        toolNames: ["jira.read"],
      });
      expect(case1Plan).toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        automaticAction: { kind: "NONE" },
      });
      for (const value of [snapshot, case1Plan]) {
        const serialized = JSON.stringify(value);
        for (const forbidden of [
          "case-2-decision",
          "case-2-answer",
          "case-2-job",
          "case-2",
          "conn-2",
        ])
          expect(serialized).not.toContain(forbidden);
      }
      const beforeCase1 = await db.query(
        "SELECT status, active_run_id, checkpoint_revision FROM cases WHERE case_id='case-1'",
      );
      const beforeLedger = await db.query(
        "SELECT (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM decision_answers) answers, (SELECT count(*) FROM jobs) jobs, (SELECT count(*) FROM outbox) outbox",
      );
      await expect(
        new DecisionWaitingRepository(db, outbox()).apply({
          sourceRunId: "run-1",
          request: {
            schema_version: 1,
            decision_id: "foreign",
            case_id: "case-2",
            question: "foreign",
            why_now: "foreign",
            options: [
              { id: "x", label: "X", consequences: "x" },
              { id: "y", label: "Y", consequences: "y" },
            ],
            recommendation: "x",
            blocked_scope: "x",
            checkpoint_revision: 0,
          },
        }),
      ).rejects.toThrow();
      expect(
        await db.query(
          "SELECT status, active_run_id, checkpoint_revision FROM cases WHERE case_id='case-1'",
        ),
      ).toEqual(beforeCase1);
      expect(
        await db.query(
          "SELECT (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM decision_answers) answers, (SELECT count(*) FROM jobs) jobs, (SELECT count(*) FROM outbox) outbox",
        ),
      ).toEqual(beforeLedger);
    });
  },
  available,
);
