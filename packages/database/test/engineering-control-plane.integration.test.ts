import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import { EngineeringControlStateError } from "../src/errors.js";
import { migrateDown, migrationStatus } from "../src/migrate.js";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  EngineeringControlPlaneRepository,
  OwnerRepository,
} from "../src/repositories/index.js";
import {
  JobStore,
  ManualClock,
  SequentialIdGenerator,
  StaleFencingTokenError,
  type JobLease,
} from "../src/queue/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();
const DIGEST = `sha256:${"a".repeat(64)}`;

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (Reflect.get(error, "code") as string | undefined)
    : undefined;
}

describeIntegration(
  "engineering control-plane schema",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    let clock: ManualClock;
    let controlPlane: EngineeringControlPlaneRepository;
    let jobs: JobStore;
    let lease: JobLease;
    let eventSequence = 0;

    const owners = new OwnerRepository();
    const connections = new ConnectionRepository();
    const cases = new CaseRepository();
    const checkpoints = new CheckpointRepository();

    beforeAll(async () => {
      const created = await createTestDatabase();
      db = created.db;
      dropDb = created.drop;
    });

    afterAll(async () => {
      await dropDb();
    });

    beforeEach(async () => {
      eventSequence = 0;
      clock = new ManualClock(Date.now());
      jobs = new JobStore({ clock, ids: new SequentialIdGenerator(), leaseTime: "db" });
      controlPlane = new EngineeringControlPlaneRepository(
        {
          clock,
          ids: new SequentialIdGenerator(),
          leaseTime: "db",
        },
        jobs,
      );
      await db.query(
        `TRUNCATE engineering_run_projections, engineering_stage_events,
                  engineering_artifact_revisions, engineering_operations,
                  job_reconciliations, job_completions, job_intents, job_attempts,
                  jobs, case_checkpoints, agent_runs, case_messages, cases,
                  events, raw_events, connections, owners
         RESTART IDENTITY CASCADE`,
      );

      await owners.insert(db, { ownerId: "owner-1", displayName: "owner" });
      await connections.insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
      await cases.insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await db.withTransaction((tx) =>
        checkpoints.ensureBaseline(tx, {
          caseId: "case-1",
          updatedAt: "2026-08-25T12:00:00.000Z",
        }),
      );
      await db.query(
        `INSERT INTO agent_runs (
           run_id, case_id, owner_id, work_unit_id, role, safety_state,
           checkpoint_revision)
         VALUES ('run-1', 'case-1', 'owner-1', 'wu-1', 'IMPLEMENTER', 'STARTED', 0)`,
      );
      await db.query(
        `INSERT INTO jobs (
           job_id, case_id, job_type, status, payload, lease_owner,
           lease_expires_at, fencing_token, attempts, serialization_key)
         VALUES (
           'job-1', 'case-1', 'engineering', 'LEASED', '{}'::jsonb, 'worker-1',
           now() + interval '1 hour', 1, 1, 'case-1')`,
      );
      await db.query(
        `INSERT INTO job_intents (
           intent_id, job_id, case_id, fencing_token, kind, descriptor,
           idempotency_key)
         VALUES (
           'intent-1', 'job-1', 'case-1', 1, 'MODEL_CALL', '{"prompt":"bounded"}'::jsonb,
           'operation-1')`,
      );
      lease = {
        jobId: "job-1",
        caseId: "case-1",
        jobType: "engineering",
        payload: {},
        provider: null,
        serializationKey: "case-1",
        attempts: 1,
        maxAttempts: 10,
        fencingToken: 1,
        leaseExpiresAtMs: clock.now() + 3_600_000,
        leaseOwner: "worker-1",
      };
    });

    function operationInput(
      operationId = "operation-1",
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        operationId,
        runId: "run-1",
        stage: "SLICE_IMPLEMENTATION",
        stageAttempt: 1,
        operationKind: "MODEL_CALL",
        effectClass: "MODEL_CALL",
        descriptor: { prompt: "bounded" },
        configDigest: DIGEST,
        schemaDigest: DIGEST,
        deadlineAt: new Date(clock.now() + 600_000).toISOString(),
        ...overrides,
      };
    }

    async function prepareRepositoryPath(): Promise<void> {
      // The schema-oriented fixtures below pre-seed an intent for direct SQL
      // tests. Repository tests remove it so bindOperationIntent must create the
      // intent itself and can prove the intent+binding transaction boundary.
      await db.query("TRUNCATE job_intents CASCADE");
    }

    async function bind(): Promise<void> {
      await prepareRepositoryPath();
      await controlPlane.bindOperationIntent(db, lease, operationInput());
    }

    const artifact = {
      schema_version: 1,
      artifact_kind: "SliceContract",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      slice_id: "slice-1",
      objective: "bounded objective",
      observable_result: "bounded result",
      allowed_paths: ["packages/database/src"],
      gate_ids: ["gate-1"],
      inspection_method: "manual inspection",
      stop_condition: "bounded condition",
    };

    async function appendRawEvent(
      eventType: string,
      payload: Record<string, unknown> = {},
      reconciliationId: string | null = null,
    ): Promise<void> {
      await db.query(
        `INSERT INTO engineering_stage_events (
           event_id, event_sequence, event_type, operation_id, intent_id, job_id,
           case_id, owner_id, run_id, stage, stage_attempt, checkpoint_revision,
           reconciliation_id, payload, payload_digest)
         SELECT $1, (SELECT coalesce(max(event_sequence), 0) + 1 FROM engineering_stage_events
                     WHERE run_id = o.run_id), $2, o.operation_id, o.intent_id, o.job_id,
                 o.case_id, o.owner_id, o.run_id, o.stage, o.stage_attempt, o.checkpoint_revision,
                 $3, $4::jsonb, $5
         FROM engineering_operations o WHERE o.operation_id = 'operation-1'`,
        [
          `raw-${eventType}-${eventSequence++}`,
          eventType,
          reconciliationId,
          JSON.stringify(payload),
          DIGEST,
        ],
      );
    }

    async function insertCompletion(
      completionId = "completion-1",
      outcome: "SUCCEEDED" | "FAILED" | "AMBIGUOUS" = "SUCCEEDED",
    ): Promise<void> {
      await db.query(
        `INSERT INTO job_completions (completion_id, intent_id, job_id, outcome, receipt)
         SELECT $1, intent_id, job_id, $2, '{"exact":true}'::jsonb
         FROM engineering_operations WHERE operation_id = 'operation-1'`,
        [completionId, outcome],
      );
    }

    async function insertReconciliation(
      resolution: "CONFIRMED" | "ABSENT" | "UNRESOLVED",
      reconciliationId = `reconciliation-${resolution.toLowerCase()}`,
    ): Promise<void> {
      await db.query(
        `INSERT INTO job_reconciliations
           (reconciliation_id, intent_id, job_id, resolution, evidence, attempt_key)
         SELECT $1, intent_id, job_id, $2, '{"observed":true}'::jsonb, $3
         FROM engineering_operations WHERE operation_id = 'operation-1'`,
        [reconciliationId, resolution, reconciliationId],
      );
    }

    async function prepare(): Promise<{
      classification: string;
      cancellation_requested: boolean;
      terminal_reason: string | null;
      projection_digest: string;
    }> {
      return controlPlane.prepareResume(db, { runId: "run-1" });
    }

    function operatorInput(projectionDigest: string, actionId: string, actorId = "owner-1") {
      return {
        actionId,
        operationId: "operation-1",
        actorId,
        reason: "operator test action",
        expectedProjectionDigest: projectionDigest,
      };
    }

    it("reads status owner-scoped without changing durable counts", async () => {
      await bind();
      await prepare();
      const before = await db.query<{ events: string; projections: string }>(
        `SELECT (SELECT count(*)::text FROM engineering_stage_events) AS events,
                (SELECT count(*)::text FROM engineering_run_projections) AS projections`,
      );
      const status = await controlPlane.readRunStatus(db, { runId: "run-1", ownerId: "owner-1" });
      expect(status?.run_id).toBe("run-1");
      expect(
        await controlPlane.readRunStatus(db, { runId: "run-1", ownerId: "other-owner" }),
      ).toBeNull();
      const after = await db.query<{ events: string; projections: string }>(
        `SELECT (SELECT count(*)::text FROM engineering_stage_events) AS events,
                (SELECT count(*)::text FROM engineering_run_projections) AS projections`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it("requires current digest and owner authorization for operator actions", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      await expect(
        controlPlane.acknowledgeOperation(
          db,
          operatorInput("sha256:" + "0".repeat(64), "ack-stale"),
        ),
      ).rejects.toThrow();
      await expect(
        controlPlane.acknowledgeOperation(db, operatorInput(digest, "ack-owner", "other-owner")),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS n FROM engineering_stage_events WHERE event_id IN ('ack-stale','ack-owner')",
          )
        ).rows[0]!.n,
      ).toBe("0");
    });

    it("acknowledge preserves classification, replays exactly, and conflicts on changed action content", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      const input = operatorInput(digest, "ack-1");
      const first = await controlPlane.acknowledgeOperation(db, input);
      expect(first.plan.classification).toBe("DIRTY");
      const replay = await controlPlane.acknowledgeOperation(db, input);
      expect(replay.event.event_id).toBe(first.event.event_id);
      await expect(
        controlPlane.acknowledgeOperation(db, { ...input, reason: "different" }),
      ).rejects.toThrow();
    });

    it("cancels before STARTED, blocks dispatch, and replays idempotently", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      const input = operatorInput(digest, "cancel-1");
      const first = await controlPlane.requestCancellation(db, input);
      expect(first.plan.classification).toBe("CANCELLED");
      await expect(
        controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" }),
      ).rejects.toThrow();
      const replay = await controlPlane.requestCancellation(db, input);
      expect(replay.event.event_id).toBe(first.event.event_id);
    });

    it("carries a run cancellation forward to the next operation before STARTED", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      await controlPlane.requestCancellation(db, operatorInput(digest, "cancel-run"));
      await db.query("DELETE FROM engineering_run_projections WHERE run_id = 'run-1'");
      await expect(
        controlPlane.readRunControlState(db, {
          runId: "run-1",
          caseId: "case-1",
          ownerId: "owner-1",
          checkpointRevision: 0,
        }),
      ).resolves.toEqual({ cancelled: true });
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-2", {
          stage: "GATE_EXECUTION",
          stageAttempt: 2,
          operationKind: "engineering.stage.gate_execution",
          effectClass: "COMMAND",
          descriptor: { gate: "required" },
        }),
      );

      await expect(
        controlPlane.commitOperationStarted(db, lease, { operationId: "operation-2" }),
      ).rejects.toThrow(/cancellation state/);
    });

    it("cancellation does not erase an unknown mutating write", async () => {
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", {
          operationKind: "MODEL_CALL",
          effectClass: "MUTATING_SIDE_EFFECT",
        }),
      );
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      const digest = (await prepare()).projection_digest;
      const result = await controlPlane.requestCancellation(
        db,
        operatorInput(digest, "cancel-unknown"),
      );
      expect(result.plan.classification).toBe("AMBIGUOUS");
    });

    it("issues deterministic retry only before STARTED and replays the same operation id", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      const input = operatorInput(digest, "retry-1");
      const first = await controlPlane.requestRetry(db, input);
      const replay = await controlPlane.requestRetry(db, input);
      expect(replay.retry_operation_id).toBe(first.retry_operation_id);
    });

    it("rejects retry after STARTED without terminal ABSENT", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      const startedDigest = (await prepare()).projection_digest;
      await expect(
        controlPlane.requestRetry(db, operatorInput(startedDigest, "retry-started")),
      ).rejects.toThrow();
    });

    it("reconciles only an AMBIGUOUS JobStore operation with ordered request/receipt events", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await prepare();
      const binding = await db.query<{ intent_id: string }>(
        "SELECT intent_id FROM engineering_operations WHERE operation_id = 'operation-1'",
      );
      await jobs.recordCompletion(db, {
        intentId: binding.rows[0]!.intent_id,
        jobId: "job-1",
        outcome: "AMBIGUOUS",
        lease,
      });
      const digest = (await prepare()).projection_digest;
      const input = {
        ...operatorInput(digest, "reconcile-1"),
        resolution: "CONFIRMED" as const,
        evidence: { observed: true },
      };
      const result = await controlPlane.reconcileOperation(db, input);
      expect(result.plan.classification).toBe("RECOVERED");
      const events = await db.query<{ event_type: string; event_sequence: string }>(
        `SELECT event_type, event_sequence::text FROM engineering_stage_events
         WHERE operation_id = 'operation-1' AND event_type IN ('OPERATOR_RECONCILE_REQUESTED','OPERATOR_RECONCILED')
         ORDER BY event_sequence`,
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "OPERATOR_RECONCILE_REQUESTED",
        "OPERATOR_RECONCILED",
      ]);
      const replay = await controlPlane.reconcileOperation(db, input);
      expect(replay.reconciliation_id).toBe(result.reconciliation_id);
      await expect(
        controlPlane.reconcileOperation(db, { ...input, resolution: "ABSENT" }),
      ).rejects.toThrow();
    });

    it("rejects reconciliation before the target job is AMBIGUOUS", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      await expect(
        controlPlane.reconcileOperation(db, {
          ...operatorInput(digest, "reconcile-too-early"),
          resolution: "CONFIRMED",
          evidence: { observed: false },
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS n FROM engineering_stage_events WHERE event_type = 'OPERATOR_RECONCILED'",
          )
        ).rows[0]!.n,
      ).toBe("0");
    });

    it("keeps UNRESOLVED ambiguous and permits retry only after terminal ABSENT", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      const binding = await db.query<{ intent_id: string }>(
        "SELECT intent_id FROM engineering_operations WHERE operation_id = 'operation-1'",
      );
      await jobs.recordCompletion(db, {
        intentId: binding.rows[0]!.intent_id,
        jobId: "job-1",
        outcome: "AMBIGUOUS",
        lease,
      });
      const ambiguousDigest = (await prepare()).projection_digest;
      const unresolved = await controlPlane.reconcileOperation(db, {
        ...operatorInput(ambiguousDigest, "reconcile-unresolved"),
        resolution: "UNRESOLVED",
        evidence: { probe: "inconclusive" },
      });
      expect(unresolved.plan.classification).toBe("AMBIGUOUS");

      const absent = await controlPlane.reconcileOperation(db, {
        ...operatorInput(unresolved.plan.projection_digest, "reconcile-absent"),
        resolution: "ABSENT",
        evidence: { probe: "not-found" },
      });
      expect(absent.plan.classification).toBe("DIRTY");
      const retry = await controlPlane.requestRetry(
        db,
        operatorInput(absent.plan.projection_digest, "retry-after-absent"),
      );
      expect(retry.retry_operation_id).toMatch(/^eng-retry-[0-9a-f]{32}$/);
    });

    it("rejects unsupported SUCCESS and caller-supplied receipt fields before any event", async () => {
      await bind();
      const digest = (await prepare()).projection_digest;
      await expect(
        controlPlane.reconcileOperation(db, {
          ...operatorInput(digest, "reconcile-success"),
          resolution: "SUCCESS",
        }),
      ).rejects.toThrow();
      await expect(
        controlPlane.acknowledgeOperation(db, {
          ...operatorInput(digest, "ack-receipt"),
          receipt: { forged: true },
        }),
      ).rejects.toThrow();
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS n FROM engineering_stage_events WHERE event_id IN ('reconcile-success','ack-receipt')",
          )
        ).rows[0]!.n,
      ).toBe("0");
    });

    async function insertOperation(overrides: Record<string, unknown> = {}): Promise<void> {
      const value = {
        operationId: "operation-1",
        intentId: "intent-1",
        idempotencyKey: "operation-1",
        jobId: "job-1",
        caseId: "case-1",
        ownerId: "owner-1",
        runId: "run-1",
        stage: "SLICE_IMPLEMENTATION",
        stageAttempt: 1,
        checkpointRevision: 0,
        operationKind: "MODEL_CALL",
        effectClass: "MODEL_CALL",
        integrationScopeDigest: DIGEST,
        inputDigest: DIGEST,
        configDigest: DIGEST,
        schemaDigest: DIGEST,
        ...overrides,
      };
      await db.query(
        `INSERT INTO engineering_operations (
           operation_id, intent_id, idempotency_key, job_id, case_id, owner_id,
           run_id, stage, stage_attempt, checkpoint_revision, operation_kind,
           effect_class, integration_scope_digest, input_digest, config_digest,
           schema_digest, deadline_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 now() + interval '10 minutes')`,
        [
          value.operationId,
          value.intentId,
          value.idempotencyKey,
          value.jobId,
          value.caseId,
          value.ownerId,
          value.runId,
          value.stage,
          value.stageAttempt,
          value.checkpointRevision,
          value.operationKind,
          value.effectClass,
          value.integrationScopeDigest,
          value.inputDigest,
          value.configDigest,
          value.schemaDigest,
        ],
      );
    }

    async function insertArtifact(overrides: Record<string, unknown> = {}): Promise<void> {
      const value = {
        artifactRevisionId: "artifact-revision-1",
        artifactKey: "slice-1/contract",
        revision: 1,
        artifactKind: "SliceContract",
        operationId: "operation-1",
        intentId: "intent-1",
        jobId: "job-1",
        caseId: "case-1",
        ownerId: "owner-1",
        runId: "run-1",
        stage: "SLICE_IMPLEMENTATION",
        stageAttempt: 1,
        checkpointRevision: 0,
        ...overrides,
      };
      await db.query(
        `INSERT INTO engineering_artifact_revisions (
           artifact_revision_id, artifact_key, revision, artifact_kind, payload,
           payload_digest, operation_id, intent_id, job_id, case_id, owner_id,
           run_id, stage, stage_attempt, checkpoint_revision)
         VALUES ($1,$2,$3,$4,'{"schema_version":1}'::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          value.artifactRevisionId,
          value.artifactKey,
          value.revision,
          value.artifactKind,
          DIGEST,
          value.operationId,
          value.intentId,
          value.jobId,
          value.caseId,
          value.ownerId,
          value.runId,
          value.stage,
          value.stageAttempt,
          value.checkpointRevision,
        ],
      );
    }

    async function insertEvent(input: {
      eventId: string;
      eventType: string;
      artifactRevisionId?: string | null;
      completionId?: string | null;
      reconciliationId?: string | null;
      requestedSequence?: number;
    }): Promise<number> {
      const result = await db.query<{ event_sequence: string }>(
        `INSERT INTO engineering_stage_events (
           event_id, event_sequence, event_type, operation_id, intent_id, job_id,
           case_id, owner_id, run_id, stage, stage_attempt, checkpoint_revision,
           artifact_revision_id, completion_id, reconciliation_id, payload,
           payload_digest)
         VALUES ($1,$2,$3,'operation-1','intent-1','job-1','case-1','owner-1',
                 'run-1','SLICE_IMPLEMENTATION',1,0,$4,$5,$6,'{}'::jsonb,$7)
         RETURNING event_sequence::text`,
        [
          input.eventId,
          input.requestedSequence ?? 999,
          input.eventType,
          input.artifactRevisionId ?? null,
          input.completionId ?? null,
          input.reconciliationId ?? null,
          DIGEST,
        ],
      );
      return Number(result.rows[0]!.event_sequence);
    }

    it("binds intent and operation atomically, replays exactly, and rejects collisions/fences", async () => {
      await bind();
      const replay = await controlPlane.bindOperationIntent(db, lease, operationInput());
      expect(replay.operation_id).toBe("operation-1");
      expect((await db.query("SELECT count(*)::text AS n FROM job_intents")).rows[0]!.n).toBe("1");
      expect(
        (await db.query("SELECT count(*)::text AS n FROM engineering_stage_events")).rows[0]!.n,
      ).toBe("1");

      await expect(
        controlPlane.bindOperationIntent(db, lease, {
          ...operationInput(),
          configDigest: `sha256:${"b".repeat(64)}`,
        }),
      ).rejects.toThrow();
      const stale = { ...lease, fencingToken: 2 };
      await expect(
        controlPlane.bindOperationIntent(db, stale, operationInput("stale-op")),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);
    });

    it("binds LOCAL_COMMIT as an explicit mutating operation with attempt > 1 available", async () => {
      await prepareRepositoryPath();
      const operation = await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("local-commit-operation", {
          stage: "LOCAL_COMMIT",
          stageAttempt: 2,
          operationKind: "engineering.stage.local_commit",
          effectClass: "MUTATING_SIDE_EFFECT",
          descriptor: { verified: true },
        }),
      );
      expect(operation).toMatchObject({
        stage: "LOCAL_COMMIT",
        stage_attempt: 2,
        effect_class: "MUTATING_SIDE_EFFECT",
      });
      // Migration 036 is now the newest layer. Revert it first, then prove that the
      // load-bearing migration-035 guard still refuses to erase LOCAL_COMMIT provenance.
      await expect(migrateDown(db)).resolves.toEqual({ applied: [], reverted: [36] });
      await expect(migrateDown(db)).rejects.toThrow(/LOCAL_COMMIT rows exist/);
      expect(
        (await migrationStatus(db)).find((migration) => migration.version === 35),
      ).toMatchObject({ version: 35, applied: true });
    });

    it("rolls back the job intent when operation binding is fault-injected", async () => {
      await prepareRepositoryPath();
      await db.query(`
        CREATE OR REPLACE FUNCTION test_fail_engineering_operation() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'engineering operation fault'; END; $$;
        CREATE TRIGGER test_fail_engineering_operation_trigger
        BEFORE INSERT ON engineering_operations
        FOR EACH ROW EXECUTE FUNCTION test_fail_engineering_operation();
      `);
      try {
        await expect(controlPlane.bindOperationIntent(db, lease, operationInput())).rejects.toThrow(
          "engineering operation fault",
        );
      } finally {
        await db.query(
          "DROP TRIGGER test_fail_engineering_operation_trigger ON engineering_operations; DROP FUNCTION test_fail_engineering_operation();",
        );
      }
      expect((await db.query("SELECT count(*)::text AS n FROM job_intents")).rows[0]!.n).toBe("0");
      expect(
        (await db.query("SELECT count(*)::text AS n FROM engineering_operations")).rows[0]!.n,
      ).toBe("0");
    });

    it("locks the live job fence before run authority so recovery cannot deadlock", async () => {
      await prepareRepositoryPath();
      let releaseJobLock!: () => void;
      const jobLockReleased = new Promise<void>((resolve) => {
        releaseJobLock = resolve;
      });
      let jobLockHeld!: () => void;
      const jobLockReady = new Promise<void>((resolve) => {
        jobLockHeld = resolve;
      });
      const blocker = db.withTransaction(async (tx) => {
        await tx.query("SELECT 1 FROM jobs WHERE job_id = 'job-1' FOR UPDATE");
        jobLockHeld();
        await jobLockReleased;
      });

      await jobLockReady;
      const binding = controlPlane.bindOperationIntent(db, lease, operationInput());
      try {
        let bindingWaitsForJob = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await db.query<{ waiting: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database()
                 AND state = 'active' AND wait_event_type = 'Lock'
                 AND query LIKE '%FROM jobs%FOR UPDATE%'
             ) AS waiting`,
          );
          if (waiting.rows[0]!.waiting) {
            bindingWaitsForJob = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(bindingWaitsForJob).toBe(true);

        // With the required job→run order, the waiting bind has not acquired a
        // run lock. The inverse order times out here and proves the old cycle.
        await db.withTransaction(async (tx) => {
          await tx.query("SET LOCAL lock_timeout = '300ms'");
          await tx.query("SELECT 1 FROM agent_runs WHERE run_id = 'run-1' FOR UPDATE");
        });
      } finally {
        releaseJobLock();
      }

      await blocker;
      await expect(binding).resolves.toMatchObject({ operation_id: "operation-1" });
    });

    it("commits STARTED once and rejects a stale lease", async () => {
      await bind();
      const started = await controlPlane.commitOperationStarted(db, lease, {
        operationId: "operation-1",
      });
      expect(started.event_type).toBe("STARTED");
      await expect(
        controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" }),
      ).rejects.toBeInstanceOf(EngineeringControlStateError);
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS n FROM engineering_stage_events WHERE event_type = 'STARTED'",
          )
        ).rows[0]!.n,
      ).toBe("1");
      await expect(
        controlPlane.commitOperationStarted(
          db,
          { ...lease, fencingToken: 2 },
          { operationId: "operation-1" },
        ),
      ).rejects.toBeInstanceOf(StaleFencingTokenError);
    });

    it("strictly appends artifacts, replays exactly, and records one artifact event", async () => {
      await prepareRepositoryPath();
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", { stage: "SLICE_PLANNING" }),
      );
      const input = { operationId: "operation-1", artifactKey: "slice-1/contract", artifact };
      const first = await controlPlane.appendArtifactRevision(db, lease, input);
      const replay = await controlPlane.appendArtifactRevision(db, lease, input);
      expect(replay.artifact_revision_id).toBe(first.artifact_revision_id);
      await expect(
        controlPlane.appendArtifactRevision(db, lease, {
          ...input,
          artifact: { ...artifact, objective: "tampered" },
        }),
      ).rejects.toThrow();
      await expect(
        controlPlane.appendArtifactRevision(db, lease, {
          ...input,
          artifact: { ...artifact, revision: 1 },
        }),
      ).rejects.toThrow(/checkpoint/);
      await expect(
        controlPlane.appendArtifactRevision(db, lease, {
          ...input,
          artifact: {
            schema_version: 1,
            artifact_kind: "TerminalReason",
            case_id: "case-1",
            run_id: "run-1",
            revision: 0,
            reason: "BLOCKED",
            detail: "wrong stage kind",
          },
        }),
      ).rejects.toThrow(/stage kind/);
      await expect(
        controlPlane.appendArtifactRevision(db, lease, {
          ...input,
          artifact: { ...artifact, run_id: "run-foreign" },
        }),
      ).rejects.toThrow();
      expect(
        (await db.query("SELECT count(*)::text AS n FROM engineering_artifact_revisions")).rows[0]!
          .n,
      ).toBe("1");
      expect(
        (
          await db.query(
            "SELECT count(*)::text AS n FROM engineering_stage_events WHERE event_type = 'ARTIFACT_RECORDED'",
          )
        ).rows[0]!.n,
      ).toBe("1");
    });

    it("lists an exact metadata-only trace in event sequence order and isolates foreign scope", async () => {
      await prepareRepositoryPath();
      const operation = await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", {
          stage: "SLICE_PLANNING",
          descriptor: { prompt: "PROMPT_SECRET", host_path: "/private/secret" },
        }),
      );
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await controlPlane.appendArtifactRevision(db, lease, {
        operationId: "operation-1",
        artifactKey: "slice-1/contract",
        artifact: { ...artifact, objective: "PAYLOAD_SECRET" },
      });
      const completionId = await jobs.recordCompletion(db, {
        intentId: operation.intent_id,
        jobId: lease.jobId,
        outcome: "SUCCEEDED",
        receipt: { receipt_secret: "RECEIPT_SECRET", patch: "PATCH_SECRET" },
        lease,
      });
      await controlPlane.observeOperationCompletion(db, {
        operationId: "operation-1",
        completionId,
      });
      await db.query(
        "ALTER TABLE engineering_stage_events DISABLE TRIGGER engineering_stage_events_append_only",
      );
      try {
        await db.query(
          `UPDATE engineering_stage_events
              SET recorded_at = CASE WHEN event_sequence = 1 THEN now() + interval '1 day'
                                     ELSE now() - interval '1 day' END`,
        );
      } finally {
        await db.query(
          "ALTER TABLE engineering_stage_events ENABLE TRIGGER engineering_stage_events_append_only",
        );
      }

      const trace = await controlPlane.listRunTrace(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        runId: "run-1",
        checkpointRevision: 0,
      });
      expect(trace.map((event) => Number(event.event_sequence))).toEqual([1, 2, 3, 4]);
      expect(trace.map((event) => event.event_type)).toEqual([
        "INTENT_BOUND",
        "STARTED",
        "ARTIFACT_RECORDED",
        "COMPLETION_OBSERVED",
      ]);
      expect(trace[2]).toMatchObject({ artifact_kind: "SliceContract", stage: "SLICE_PLANNING" });
      expect(trace[3]).toMatchObject({
        operation_kind: "MODEL_CALL",
        effect_class: "MODEL_CALL",
        integration_scope_digest: expect.stringMatching(/^sha256:/),
        input_digest: expect.stringMatching(/^sha256:/),
        config_digest: DIGEST,
        schema_digest: DIGEST,
        completion_outcome: "SUCCEEDED",
        reconciliation_resolution: null,
      });
      expect(Object.keys(trace[0]!).sort()).toEqual(
        [
          "event_id",
          "event_sequence",
          "event_type",
          "case_id",
          "owner_id",
          "run_id",
          "checkpoint_revision",
          "operation_id",
          "operation_kind",
          "effect_class",
          "integration_scope_digest",
          "input_digest",
          "config_digest",
          "schema_digest",
          "stage",
          "stage_attempt",
          "artifact_revision_id",
          "artifact_kind",
          "completion_id",
          "completion_outcome",
          "reconciliation_id",
          "reconciliation_resolution",
          "payload_digest",
          "recorded_at",
        ].sort(),
      );
      expect(JSON.stringify(trace)).not.toMatch(
        /PROMPT_SECRET|PAYLOAD_SECRET|RECEIPT_SECRET|PATCH_SECRET|\/private\/secret/,
      );
      await expect(
        controlPlane.listRunTrace(db, {
          caseId: "case-1",
          ownerId: "owner-foreign",
          runId: "run-1",
          checkpointRevision: 0,
        }),
      ).resolves.toEqual([]);
      await expect(
        controlPlane.listRunTrace(db, {
          caseId: "case-1",
          ownerId: "owner-1",
          runId: "run-1",
          checkpointRevision: 1,
        }),
      ).resolves.toEqual([]);
    });

    it("fails closed when a historical artifact row is directly corrupted", async () => {
      await prepareRepositoryPath();
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", { stage: "SLICE_PLANNING" }),
      );
      await controlPlane.appendArtifactRevision(db, lease, {
        operationId: "operation-1",
        artifactKey: "slice-1/contract",
        artifact,
      });
      await db.query(
        "ALTER TABLE engineering_artifact_revisions DISABLE TRIGGER engineering_artifact_revisions_append_only",
      );
      try {
        await db.query(
          `UPDATE engineering_artifact_revisions
              SET artifact_kind = 'TerminalReason'
            WHERE operation_id = 'operation-1'`,
        );
      } finally {
        await db.query(
          "ALTER TABLE engineering_artifact_revisions ENABLE TRIGGER engineering_artifact_revisions_append_only",
        );
      }
      await expect(controlPlane.listRunArtifactRevisions(db, { runId: "run-1" })).rejects.toThrow(
        /ledger binding is corrupted/,
      );
      await expect(
        controlPlane.readOperationRecovery(db, { operationId: "operation-1" }),
      ).rejects.toThrow(/ledger binding is corrupted/);
    });

    it("observes only the exact durable completion and never copies its receipt", async () => {
      await bind();
      await db.query(
        `INSERT INTO job_completions (completion_id, intent_id, job_id, outcome, receipt)
         SELECT 'completion-1', intent_id, job_id, 'SUCCEEDED', '{"secret":"no-event"}'::jsonb
         FROM engineering_operations WHERE operation_id = 'operation-1'`,
      );
      const observed = await controlPlane.observeOperationCompletion(db, {
        operationId: "operation-1",
        completionId: "completion-1",
      });
      expect(observed.payload).toEqual({ completion_id: "completion-1", outcome: "SUCCEEDED" });
      expect(JSON.stringify(observed.payload)).not.toContain("no-event");
      const replay = await controlPlane.observeOperationCompletion(db, {
        operationId: "operation-1",
        completionId: "completion-1",
      });
      expect(replay.event_id).toBe(observed.event_id);
      await expect(
        controlPlane.observeOperationCompletion(db, {
          operationId: "operation-1",
          completionId: "completion-wrong",
        }),
      ).rejects.toThrow();
    });

    it("reads the exact operation completion receipt and exact observation boundary", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await db.query(
        `INSERT INTO job_completions (completion_id, intent_id, job_id, outcome, receipt)
         SELECT 'completion-exact', intent_id, job_id, 'SUCCEEDED',
                '{"gate_id":"gate-1","durable":true}'::jsonb
           FROM engineering_operations WHERE operation_id = 'operation-1'`,
      );

      const before = await controlPlane.readOperationCompletion(db, {
        operationId: "operation-1",
      });
      expect(before).toMatchObject({
        started: true,
        completion_observed: false,
        completion: {
          completion_id: "completion-exact",
          outcome: "SUCCEEDED",
          receipt: { gate_id: "gate-1", durable: true },
        },
      });
      expect(before?.descriptor).toEqual({ prompt: "bounded" });
      expect(Object.keys(before!.operation).sort()).toEqual(
        [
          "operation_id",
          "intent_id",
          "idempotency_key",
          "job_id",
          "case_id",
          "owner_id",
          "run_id",
          "stage",
          "stage_attempt",
          "checkpoint_revision",
          "operation_kind",
          "effect_class",
          "integration_scope_digest",
          "input_digest",
          "config_digest",
          "schema_digest",
          "deadline_at",
          "recorded_at",
        ].sort(),
      );
      expect(before!.operation).not.toHaveProperty("descriptor");
      expect(before!.operation).not.toHaveProperty("completion_receipt");
      expect(before!.operation).not.toHaveProperty("completion_id");

      await controlPlane.observeOperationCompletion(db, {
        operationId: "operation-1",
        completionId: "completion-exact",
      });
      const after = await controlPlane.readOperationCompletion(db, {
        operationId: "operation-1",
      });
      expect(after?.completion_observed).toBe(true);
      expect(
        await controlPlane.readOperationCompletion(db, { operationId: "operation-foreign" }),
      ).toBeNull();
    });

    it("classifies intent-bound and retry-safe STARTED operations as DIRTY", async () => {
      await bind();
      expect((await prepare()).classification).toBe("DIRTY");
    });

    it("classifies a retry-safe STARTED operation as DIRTY", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      expect((await prepare()).classification).toBe("DIRTY");
    });

    it("classifies an unreceipted mutating STARTED operation as AMBIGUOUS", async () => {
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", {
          operationKind: "MODEL_CALL",
          effectClass: "MUTATING_SIDE_EFFECT",
        }),
      );
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      const plan = await prepare();
      expect(plan.classification).toBe("AMBIGUOUS");
      expect(plan.terminal_reason).toBe("AMBIGUOUS");
    });

    it("recovers exact SUCCESS and applies reconciliation precedence", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await insertCompletion();
      expect((await prepare()).classification).toBe("RECOVERED");
    });

    it("classifies unresolved then confirmed reconciliation as AMBIGUOUS then RECOVERED", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await insertCompletion("completion-ambiguous", "AMBIGUOUS");
      await insertReconciliation("UNRESOLVED");
      expect((await prepare()).classification).toBe("AMBIGUOUS");
      await insertReconciliation("CONFIRMED", "reconciliation-confirmed");
      expect((await prepare()).classification).toBe("RECOVERED");
    });

    it("classifies ABSENT reconciliation as DIRTY", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await insertCompletion("completion-ambiguous", "AMBIGUOUS");
      await insertReconciliation("ABSENT");
      expect((await prepare()).classification).toBe("DIRTY");
    });

    it("retains cancellation for clean work but AMBIGUOUS for an unknown write", async () => {
      await bind();
      await appendRawEvent("OPERATOR_CANCEL_REQUESTED", { cancellation_requested: true });
      const cancelled = await prepare();
      expect(cancelled.classification).toBe("CANCELLED");
      expect(cancelled.cancellation_requested).toBe(true);
    });

    it("retains AMBIGUOUS for cancellation alongside an unknown write", async () => {
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", {
          operationKind: "MODEL_CALL",
          effectClass: "MUTATING_SIDE_EFFECT",
        }),
      );
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      await appendRawEvent("OPERATOR_CANCEL_REQUESTED", { cancellation_requested: true });
      const unknown = await prepare();
      expect(unknown.classification).toBe("AMBIGUOUS");
      expect(unknown.cancellation_requested).toBe(true);
    });

    it("blocks an integration scope change", async () => {
      await bind();
      await connections.insert(db, {
        connectionId: "connection-2",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira-2",
      });
      await db.query(
        'UPDATE cases SET integration_scope = \'{"providers":["jira"],"connection_ids":["connection-1","connection-2"]}\'::jsonb WHERE case_id = \'case-1\'',
      );
      expect((await prepare()).classification).toBe("BLOCKED");
    });

    it("blocks a fencing change", async () => {
      await bind();
      await db.query("UPDATE jobs SET fencing_token = 2 WHERE job_id = 'job-1'");
      expect((await prepare()).classification).toBe("BLOCKED");
    });

    it("blocks an active applicable kill switch", async () => {
      await bind();
      await db.query(
        `INSERT INTO kill_switch_events (event_id, scope_level, enabled, reason, changed_by)
         VALUES ('kill-1', 'GLOBAL', true, 'maintenance', 'test')`,
      );
      expect((await prepare()).classification).toBe("BLOCKED");
    });

    it("blocks an expired retry-safe operation as terminal EXHAUSTED", async () => {
      await controlPlane.bindOperationIntent(
        db,
        lease,
        operationInput("operation-1", {
          deadlineAt: new Date(clock.now() + 1_000).toISOString(),
        }),
      );
      clock.advance(2_000);
      const exhausted = await prepare();
      expect(exhausted.classification).toBe("BLOCKED");
      expect(exhausted.terminal_reason).toBe("EXHAUSTED");
    });

    it("rebuilds an identical projection after deletion", async () => {
      await bind();
      await controlPlane.commitOperationStarted(db, lease, { operationId: "operation-1" });
      const first = await prepare();
      await db.query("DELETE FROM engineering_run_projections WHERE run_id = 'run-1'");
      const rebuilt = await prepare();
      expect(rebuilt.projection_digest).toBe(first.projection_digest);
      const row = await db.query<{ projection_digest: string }>(
        "SELECT projection_digest FROM engineering_run_projections WHERE run_id = 'run-1'",
      );
      expect(row.rows[0]!.projection_digest).toBe(first.projection_digest);
    });

    it("binds an operation to one exact intent/run/checkpoint scope", async () => {
      await expect(
        insertOperation({ operationId: "split", idempotencyKey: "operation-1" }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514");
      await expect(insertOperation({ stage: "MADE_UP" })).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === "23514",
      );
      await expect(insertOperation({ stageAttempt: 0 })).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === "23514",
      );
      await expect(insertOperation({ inputDigest: "not-a-digest" })).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === "23514",
      );
      await expect(insertOperation({ ownerId: "owner-foreign" })).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === "23503",
      );
      await expect(insertOperation({ operationKind: "COMMAND" })).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === "23503",
      );

      await insertOperation();
      const row = await db.query<{ operation_id: string; intent_id: string }>(
        "SELECT operation_id, intent_id FROM engineering_operations",
      );
      expect(row.rows).toEqual([{ operation_id: "operation-1", intent_id: "intent-1" }]);
    });

    it("keeps operation and artifact ledgers append-only with scoped revision identity", async () => {
      await insertOperation();
      await insertArtifact();

      for (const statement of [
        "UPDATE engineering_operations SET effect_class = 'READ_ONLY' WHERE operation_id = 'operation-1'",
        "DELETE FROM engineering_operations WHERE operation_id = 'operation-1'",
        "UPDATE engineering_artifact_revisions SET revision = 2 WHERE artifact_revision_id = 'artifact-revision-1'",
        "DELETE FROM engineering_artifact_revisions WHERE artifact_revision_id = 'artifact-revision-1'",
      ]) {
        const error = await db.query(statement).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(pgCode(error)).toBe("P0100");
      }

      await expect(insertArtifact({ artifactRevisionId: "artifact-revision-2" })).rejects.toSatisfy(
        (error: unknown) => pgCode(error) === "23505",
      );
      await expect(
        insertArtifact({ artifactRevisionId: "artifact-revision-x", runId: "run-foreign" }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23503");
    });

    it("allocates event sequence server-side and enforces typed singleton observations", async () => {
      await insertOperation();
      await insertArtifact();
      expect(
        await insertEvent({
          eventId: "event-intent",
          eventType: "INTENT_BOUND",
          requestedSequence: 44,
        }),
      ).toBe(1);
      expect(
        await insertEvent({
          eventId: "event-started",
          eventType: "STARTED",
          requestedSequence: 44,
        }),
      ).toBe(2);
      await expect(
        insertEvent({ eventId: "event-started-2", eventType: "STARTED" }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23505");
      await expect(
        insertEvent({ eventId: "event-bad-artifact", eventType: "ARTIFACT_RECORDED" }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514");

      expect(
        await insertEvent({
          eventId: "event-artifact",
          eventType: "ARTIFACT_RECORDED",
          artifactRevisionId: "artifact-revision-1",
        }),
      ).toBe(3);
      await expect(
        insertEvent({
          eventId: "event-artifact-2",
          eventType: "ARTIFACT_RECORDED",
          artifactRevisionId: "artifact-revision-1",
        }),
      ).rejects.toSatisfy((error: unknown) => pgCode(error) === "23505");

      await db.query(
        `INSERT INTO job_completions (
           completion_id, intent_id, job_id, outcome, receipt)
         VALUES ('completion-1','intent-1','job-1','SUCCEEDED','{"receipt":"r1"}'::jsonb)`,
      );
      expect(
        await insertEvent({
          eventId: "event-completion",
          eventType: "COMPLETION_OBSERVED",
          completionId: "completion-1",
        }),
      ).toBe(4);

      const error = await db
        .query("DELETE FROM engineering_stage_events WHERE event_id = 'event-intent'")
        .then(
          () => null,
          (reason: unknown) => reason,
        );
      expect(pgCode(error)).toBe("P0100");
    });

    it("allows a scoped materialized projection to be updated and rebuilt", async () => {
      await insertOperation();
      const sequence = await insertEvent({ eventId: "event-1", eventType: "INTENT_BOUND" });
      await db.query(
        `INSERT INTO engineering_run_projections (
           run_id, case_id, owner_id, checkpoint_revision, current_stage,
           stage_attempt, recovery_status, current_operation_id, last_event_id,
           last_event_sequence, projection, projection_digest)
         VALUES (
           'run-1','case-1','owner-1',0,'SLICE_IMPLEMENTATION',1,'READY',
           'operation-1','event-1',$1,'{"phase":"ready"}'::jsonb,$2)`,
        [sequence, DIGEST],
      );

      await db.query(
        `UPDATE engineering_run_projections
         SET recovery_status = 'DIRTY', projection = '{"phase":"dirty"}'::jsonb
         WHERE run_id = 'run-1'`,
      );
      const updated = await db.query<{ recovery_status: string; projection: { phase: string } }>(
        "SELECT recovery_status, projection FROM engineering_run_projections WHERE run_id = 'run-1'",
      );
      expect(updated.rows[0]).toMatchObject({
        recovery_status: "DIRTY",
        projection: { phase: "dirty" },
      });

      await db.query("DELETE FROM engineering_run_projections WHERE run_id = 'run-1'");
      const remaining = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM engineering_run_projections",
      );
      expect(remaining.rows[0]!.n).toBe("0");
    });
  },
  available,
);
