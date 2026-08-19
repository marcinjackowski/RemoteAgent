import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prepareCompletion, prepareDecisionRequest } from "@remoteagent/agent-orchestrator";
import {
  Database,
  ContractViolationError,
  DecisionWaitingConflictError,
  DecisionWaitingRepository,
  DecisionWaitingStateError,
  RunCompletionRepository,
} from "../src/index.js";
import { OutboxRepository, SequentialIdGenerator, SystemClock } from "../src/queue/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
import { makeCheckpoint } from "./fixtures.js";

const available = await ensurePostgres();

describeIntegration(
  "durable decision waiting materialization",
  () => {
    let db: Database;
    let drop: () => Promise<void>;
    let repo: DecisionWaitingRepository;
    const sourceRunId = "run-source";
    const request = (decisionId = "decision-1", caseId = "case-1", revision = 1) => ({
      schema_version: 1,
      decision_id: decisionId,
      case_id: caseId,
      question: "Which path?",
      why_now: "The next step is ambiguous.",
      options: [
        { id: "safe", label: "Safe", consequences: "Slower" },
        { id: "fast", label: "Fast", consequences: "Riskier" },
      ],
      recommendation: "safe",
      blocked_scope: "implementation",
      checkpoint_revision: revision,
    });

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      repo = new DecisionWaitingRepository(
        db,
        new OutboxRepository({ clock: new SystemClock(), ids: new SequentialIdGenerator() }),
      );
    });
    afterAll(async () => drop());

    async function seed(
      options: {
        status?: string;
        active?: string | null;
        completion?: unknown;
        revision?: number;
        checkpointLastRun?: string | null;
      } = {},
    ) {
      const revision = options.revision ?? 1;
      const checkpoint = {
        ...makeCheckpoint("case-1", revision),
        last_run_id:
          options.checkpointLastRun === undefined ? sourceRunId : options.checkpointLastRun,
      };
      const completion = options.completion ?? {
        schema_version: 1,
        run_id: sourceRunId,
        case_id: "case-1",
        status: "WAITING_FOR_USER",
        summary: "waiting",
        completed_steps: [],
        evidence: [],
        checkpoint_patch: {},
        next_actions: [],
        decision_request: request("decision-1", "case-1", revision),
      };
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, decisions, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await db.query("INSERT INTO owners (owner_id, display_name) VALUES ('owner-1', 'owner')");
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-1', 'owner-1', 'jira', 'jira', 'unconfigured://conn-1')",
      );
      await db.query(
        "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id, checkpoint_revision) VALUES ('case-1','owner-1',$1,'{\"providers\":[\"jira\"],\"connection_ids\":[\"conn-1\"]}','thread-1',$2)",
        [options.status ?? "IMPLEMENTING", revision],
      );
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, work_unit_id, role, safety_state, checkpoint_revision, owner_id, finished_at) VALUES ($1,'case-1','wu','IMPLEMENTER','SUCCEEDED',$2,'owner-1','2026-08-20T11:00:00Z')",
        [sourceRunId, revision - 1],
      );
      if (options.active !== undefined)
        await db.query("UPDATE cases SET active_run_id = $1 WHERE case_id = 'case-1'", [
          options.active,
        ]);
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint, last_run_id) VALUES ('case-1','owner-1',$1,$2,$3)",
        [revision, JSON.stringify(checkpoint), sourceRunId],
      );
      await db.query(
        "INSERT INTO run_completions (completion_id, run_id, case_id, status, completion) VALUES ('completion-1',$1,'case-1','WAITING_FOR_USER',$2)",
        [sourceRunId, JSON.stringify(completion)],
      );
    }

    beforeEach(async () => seed());

    it("materializes complete redacted state", async () => {
      const result = await repo.apply({ sourceRunId, request: request() });
      expect(result.replayed).toBe(false);
      expect(
        (
          await db.query(
            "SELECT decision_id, case_id, question, why_now, options, recommendation, blocked_scope, checkpoint_revision, expires_at FROM decisions",
          )
        ).rows,
      ).toEqual([
        {
          decision_id: "decision-1",
          case_id: "case-1",
          question: "Which path?",
          why_now: "The next step is ambiguous.",
          options: request().options,
          recommendation: "safe",
          blocked_scope: "implementation",
          checkpoint_revision: 1,
          expires_at: null,
        },
      ]);
      expect((await db.query("SELECT status FROM cases")).rows[0]!.status).toBe("WAITING_FOR_USER");
      const outbox = (await db.query("SELECT aggregate, event_type, payload FROM outbox")).rows[0]!;
      expect(outbox).toEqual({
        aggregate: "case",
        event_type: "decision.requested",
        payload: { decisionId: "decision-1", caseId: "case-1", checkpointRevision: 1, sourceRunId },
      });
      expect(JSON.stringify(outbox.payload)).not.toContain("Which path");
      expect((await db.query("SELECT count(*)::int AS n FROM outbox_dispatch")).rows[0]!.n).toBe(1);
    });

    it("accepts the prepared WU04B to WU05A pipeline", async () => {
      await db.query(
        "TRUNCATE outbox_dispatch, outbox, decisions, run_completions, agent_runs, case_checkpoints, cases, connections, owners RESTART IDENTITY CASCADE",
      );
      await db.query("INSERT INTO owners (owner_id, display_name) VALUES ('owner-1', 'owner')");
      await db.query(
        "INSERT INTO connections (connection_id, owner_id, provider, display_name, credential_secret_ref) VALUES ('conn-1', 'owner-1', 'jira', 'jira', 'unconfigured://conn-1')",
      );
      await db.query(
        "INSERT INTO cases (case_id, owner_id, status, integration_scope, discord_thread_id) VALUES ('case-1','owner-1','IMPLEMENTING','{\"providers\":[\"jira\"],\"connection_ids\":[\"conn-1\"]}','thread-1')",
      );
      await db.query(
        "INSERT INTO agent_runs (run_id, case_id, work_unit_id, role, safety_state, checkpoint_revision, owner_id) VALUES ($1,'case-1','wu','IMPLEMENTER','STARTED',0,'owner-1')",
        [sourceRunId],
      );
      await db.query("UPDATE cases SET active_run_id = $1 WHERE case_id = 'case-1'", [sourceRunId]);
      const current = makeCheckpoint("case-1", 0);
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',0,$1)",
        [JSON.stringify(current)],
      );
      const preparedCompletion = prepareCompletion({
        completion: {
          schema_version: 1,
          run_id: sourceRunId,
          case_id: "case-1",
          status: "WAITING_FOR_USER",
          summary: "waiting",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
          decision_request: request("decision-pipeline", "case-1", 0),
        },
        current,
        system: {
          completionId: "completion-pipeline",
          runId: sourceRunId,
          caseId: "case-1",
          expectedRevision: 0,
          finishedAt: "2026-08-20T11:00:00Z",
        },
      });
      await new RunCompletionRepository(
        db,
        new OutboxRepository({ clock: new SystemClock(), ids: new SequentialIdGenerator() }),
      ).apply(preparedCompletion);
      const preparedRequest = prepareDecisionRequest({
        completion: preparedCompletion.completion,
        currentCheckpoint: preparedCompletion.checkpoint,
      });
      const result = await repo.apply({ sourceRunId, request: preparedRequest });
      expect(result.replayed).toBe(false);
      expect(
        (await db.query("SELECT decision_id, case_id, checkpoint_revision FROM decisions")).rows[0],
      ).toEqual({
        decision_id: "decision-pipeline",
        case_id: "case-1",
        checkpoint_revision: 1,
      });
    });

    it("replays exactly after dispatch publication without writes", async () => {
      const before = (
        await db.query(
          "SELECT status, active_run_id, checkpoint_revision, updated_at FROM cases WHERE case_id='case-1'",
        )
      ).rows[0]!;
      const first = await repo.apply({ sourceRunId, request: request() });
      await db.query(
        "UPDATE outbox_dispatch SET status='PUBLISHED', attempts=1, published_at=now() WHERE outbox_id=$1",
        [first.outboxId],
      );
      const beforeReplay = (
        await db.query(
          "SELECT (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM outbox_dispatch) dispatch, status, active_run_id, checkpoint_revision, updated_at FROM cases WHERE case_id='case-1'",
        )
      ).rows[0]!;
      const replay = await repo.apply({ sourceRunId, request: request() });
      expect(replay).toEqual({ ...first, replayed: true });
      const afterReplay = (
        await db.query(
          "SELECT (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM outbox_dispatch) dispatch, status, active_run_id, checkpoint_revision, updated_at FROM cases WHERE case_id='case-1'",
        )
      ).rows[0]!;
      expect(beforeReplay).toEqual({
        decisions: "1",
        outbox: "1",
        dispatch: "1",
        status: "WAITING_FOR_USER",
        active_run_id: null,
        checkpoint_revision: 1,
        updated_at: beforeReplay.updated_at,
      });
      expect(afterReplay).toEqual(beforeReplay);
      expect(before.status).toBe("IMPLEMENTING");
    });

    it("rejects collisions and malformed/foreign/stale inputs", async () => {
      await expect(
        repo.apply({ sourceRunId, request: request("decision-1", "case-1", 0) }),
      ).rejects.toBeInstanceOf(DecisionWaitingStateError);
      await repo.apply({ sourceRunId, request: request() });
      await expect(repo.apply({ sourceRunId, request: request() })).resolves.toMatchObject({
        replayed: true,
      });
      await expect(
        repo.apply({ sourceRunId, request: { ...request(), question: "different" } }),
      ).rejects.toBeInstanceOf(DecisionWaitingConflictError);
      await expect(
        repo.apply({ sourceRunId, request: { ...request(), extra: true } }),
      ).rejects.toBeInstanceOf(ContractViolationError);
      await expect(
        repo.apply({ sourceRunId: "other-run", request: request("decision-2") }),
      ).rejects.toBeInstanceOf(DecisionWaitingStateError);
    });

    it("rejects invalid completion, run and case states", async () => {
      await seed({ completion: { nope: true } });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed({ status: "PLANNING", active: "run-source" });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed({ status: "WAITING_FOR_USER" });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed();
      await db.query("UPDATE agent_runs SET finished_at = NULL WHERE run_id = $1", [sourceRunId]);
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed({
        completion: {
          schema_version: 1,
          run_id: "wrong-run",
          case_id: "case-1",
          status: "WAITING_FOR_USER",
          summary: "waiting",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
          decision_request: request(),
        },
      });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed({
        completion: {
          schema_version: 1,
          run_id: sourceRunId,
          case_id: "case-1",
          status: "COMPLETED",
          summary: "done",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
        },
      });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed();
      await db.query("UPDATE agent_runs SET safety_state = 'FAILED' WHERE run_id = $1", [
        sourceRunId,
      ]);
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed({ checkpointLastRun: "other-run" });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed({
        completion: {
          schema_version: 1,
          run_id: sourceRunId,
          case_id: "other-case",
          status: "WAITING_FOR_USER",
          summary: "waiting",
          completed_steps: [],
          evidence: [],
          checkpoint_patch: {},
          next_actions: [],
          decision_request: request(),
        },
      });
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingStateError,
      );
      await seed();
      await repo.apply({ sourceRunId, request: request() });
      await db.query("UPDATE agent_runs SET safety_state = 'FAILED' WHERE run_id = $1", [
        sourceRunId,
      ]);
      await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(
        DecisionWaitingConflictError,
      );
    });

    it("serializes concurrent exact calls", async () => {
      const results = await Promise.all([
        repo.apply({ sourceRunId, request: request() }),
        repo.apply({ sourceRunId, request: request() }),
      ]);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        (
          await db.query(
            "SELECT (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM outbox_dispatch) dispatch",
          )
        ).rows[0],
      ).toEqual({ decisions: "1", outbox: "1", dispatch: "1" });
    });

    for (const [table, event] of [
      ["decisions", "decision_waiting_decision_fault"],
      ["cases", "decision_waiting_case_fault"],
      ["outbox", "decision_waiting_outbox_fault"],
      ["outbox_dispatch", "decision_waiting_dispatch_fault"],
    ] as const) {
      it(`rolls back when ${table} write faults`, async () => {
        await db.query(
          `CREATE OR REPLACE FUNCTION ${event}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fault'; END $$`,
        );
        await db.query(
          `CREATE TRIGGER ${event}_trigger BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${event}()`,
        );
        await expect(repo.apply({ sourceRunId, request: request() })).rejects.toBeInstanceOf(Error);
        await db.query(`DROP TRIGGER ${event}_trigger ON ${table}`);
        await db.query(`DROP FUNCTION ${event}()`);
        const counts = await db.query(
          "SELECT (SELECT count(*) FROM decisions) decisions, (SELECT count(*) FROM outbox) outbox, (SELECT count(*) FROM outbox_dispatch) dispatch, (SELECT status FROM cases) status",
        );
        expect(counts.rows[0]).toMatchObject({
          decisions: "0",
          outbox: "0",
          dispatch: "0",
          status: "IMPLEMENTING",
        });
      });
    }
  },
  available,
);
