import { canonicalDigest } from "@remoteagent/contracts";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { Database } from "../src/client.js";
import { ReconciliationConflictError } from "../src/queue/errors.js";
import { JobStore, ManualClock, SequentialIdGenerator } from "../src/queue/index.js";
import {
  CaseRepository,
  CheckpointRepository,
  ConnectionRepository,
  DiscordBindingRepository,
  EngineeringApprovalIngressRepository,
  EngineeringControlPlaneRepository,
  EngineeringRecoveryRepository,
  OwnerRepository,
  WorkUnitRepository,
} from "../src/repositories/index.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";
import type { JobLease } from "../src/queue/job-store.js";
import type { EngineeringRecoveryLease } from "../src/repositories/engineering-recovery.js";

const available = await ensurePostgres();
const NOW = Date.now() + 60_000;
const POLICY = Object.freeze({
  schema_version: 1 as const,
  purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY" as const,
  repository_id: "remote-agent",
  write_path_allowlist: ["apps/agent-worker", "packages/contracts"],
});

describeIntegration(
  "engineering cross-fence recovery authority",
  () => {
    let db: Database;
    let dropDb: () => Promise<void>;
    let clock: ManualClock;
    let jobs: JobStore;
    let recoveries: EngineeringRecoveryRepository;
    let control: EngineeringControlPlaneRepository;
    let ingressIds: SequentialIdGenerator;

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
        `TRUNCATE engineering_recovery_events, engineering_recoveries,
                  engineering_stage_events, engineering_artifact_revisions,
                  engineering_operations, engineering_write_proposals,
                  engineering_ingress_interactions, approvals,
                  job_reconciliations, job_completions, job_intents, job_attempts,
                  outbox_dispatch, outbox, jobs, work_units, case_checkpoints,
                  agent_runs, discord_case_bindings, case_messages, cases,
                  events, raw_events, connections, owners
         RESTART IDENTITY CASCADE`,
      );
      clock = new ManualClock(NOW);
      ingressIds = new SequentialIdGenerator();
      jobs = new JobStore({
        clock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      recoveries = new EngineeringRecoveryRepository({
        clock,
        ids: new SequentialIdGenerator(),
        leaseTime: "injected",
      });
      control = new EngineeringControlPlaneRepository(
        { clock, ids: new SequentialIdGenerator(), leaseTime: "injected" },
        jobs,
      );
    });

    async function createLeasedWriter(
      suffix: string,
      withSucceededIntent: boolean,
    ): Promise<JobLease> {
      const ownerId = `owner-${suffix}`;
      const caseId = `case-${suffix}`;
      const connectionId = `connection-${suffix}`;
      const threadId = `thread-${suffix}`;
      await new OwnerRepository().insert(db, { ownerId, displayName: ownerId });
      await new ConnectionRepository().insert(db, {
        connectionId,
        ownerId,
        provider: "jira",
        displayName: connectionId,
      });
      await new CaseRepository().insert(db, {
        caseId,
        ownerId,
        status: "NEW",
        integrationScope: { providers: ["jira"], connection_ids: [connectionId] },
        discordThreadId: threadId,
      });
      await db.withTransaction(async (tx) => {
        await new CheckpointRepository().ensureBaseline(tx, {
          caseId,
          updatedAt: new Date(NOW).toISOString(),
        });
        const bindings = new DiscordBindingRepository();
        await bindings.ensure(tx, { caseId, ownerId, channelId: `channel-${suffix}` });
        await bindings.setThread(tx, caseId, {
          threadId,
          rootMessageId: `root-${suffix}`,
        });
      });
      const ingress = new EngineeringApprovalIngressRepository({
        runtime: {
          clock,
          ids: ingressIds,
          leaseTime: "injected",
        },
        deploymentPolicy: POLICY,
        proposalTtlMs: 600_000,
      });
      const proposal = await ingress.propose(db, {
        caseId,
        actorId: `discord-${suffix}`,
        interactionId: `proposal-${suffix}`,
      });
      if (proposal.status !== "created") throw new Error("proposal fixture was not created");
      const grant = await ingress.respond(db, {
        caseId,
        actorId: `discord-${suffix}`,
        interactionId: `grant-${suffix}`,
        proposalId: proposal.proposal.proposal_id,
        checkpointRevision: 0,
        choice: "grant",
      });
      if (grant.status !== "granted") throw new Error("grant fixture was not created");
      await new WorkUnitRepository().start(db, {
        workUnitId: grant.workUnitId,
        runId: grant.runId,
      });
      await db.withTransaction(async (tx) => {
        await tx.query(
          `UPDATE agent_runs SET safety_state='STARTED',started_at=to_timestamp($2/1000.0)
            WHERE run_id=$1 AND safety_state='PLANNED'`,
          [grant.runId, NOW],
        );
        await tx.query(
          `UPDATE cases SET active_run_id=$2 WHERE case_id=$1 AND active_run_id IS NULL`,
          [caseId, grant.runId],
        );
      });
      const lease = await jobs.claim(db, { owner: `writer-${suffix}`, leaseMs: 1_000 });
      if (lease === null) throw new Error("writer fixture was not claimed");
      if (withSucceededIntent) {
        const intentId = await jobs.recordIntent(db, lease, {
          kind: "fixture.model",
          descriptor: { suffix },
          idempotencyKey: `fixture-${suffix}`,
        });
        await jobs.recordCompletion(db, {
          intentId,
          jobId: lease.jobId,
          outcome: "SUCCEEDED",
          receipt: { suffix },
          lease,
        });
      }
      return lease;
    }

    function continuationPlan(lease: EngineeringRecoveryLease): Record<string, unknown> {
      return {
        schema_version: 1,
        recovery_id: lease.recovery.recovery_id,
        root_recovery_id: lease.recovery.root_recovery_id,
        source_job_id: lease.recovery.source_job_id,
        source_fencing_token: Number(lease.recovery.source_fencing_token),
        recovery_job_id: lease.recovery.recovery_job_id,
        recovery_fencing_token: lease.job.fencingToken,
        case_id: lease.recovery.case_id,
        owner_id: lease.recovery.owner_id,
        work_unit_id: lease.recovery.work_unit_id,
        run_id: lease.recovery.run_id,
        checkpoint_revision: lease.recovery.checkpoint_revision,
        repository_id: lease.recovery.repository_id,
        workflow_deadline_at: lease.recovery.workflow_deadline_at.toISOString(),
        classification: "CONTINUE_NEXT_STAGE",
        operation: null,
        evidence_digest: canonicalDigest({ recovery: lease.recovery.recovery_id }),
        budget_reservation: {
          stage_attempts: 0,
          model_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
      };
    }

    function repairPlan(lease: EngineeringRecoveryLease): Record<string, unknown> {
      const operation = lease.recovery;
      if (
        operation.source_operation_id === null ||
        operation.source_intent_id === null ||
        operation.source_stage === null ||
        operation.source_stage_attempt === null ||
        operation.source_effect_class === null ||
        operation.source_input_digest === null ||
        operation.source_config_digest === null ||
        operation.source_schema_digest === null ||
        operation.source_scope_digest === null ||
        operation.source_deadline_at === null
      ) {
        throw new Error("repair fixture has no exact source operation");
      }
      return {
        ...continuationPlan(lease),
        classification: "REPAIR_ARTIFACT_COMPLETION",
        operation: {
          operation_id: operation.source_operation_id,
          intent_id: operation.source_intent_id,
          stage: operation.source_stage,
          stage_attempt: operation.source_stage_attempt,
          effect_class: operation.source_effect_class,
          input_digest: operation.source_input_digest,
          config_digest: operation.source_config_digest,
          schema_digest: operation.source_schema_digest,
          scope_digest: operation.source_scope_digest,
          deadline_at: operation.source_deadline_at.toISOString(),
          context_manifest_digest: canonicalDigest({ context: "manifest" }),
          context_snapshot_digest: canonicalDigest({ context: "snapshot" }),
          context_packet_digest: canonicalDigest({ context: "packet" }),
        },
        evidence_digest: canonicalDigest({ receipts: ["exact-repair"] }),
      };
    }

    it.each([false, true])(
      "parks unfinished engineering writer before generic reap (succeeded intent=%s)",
      async (withSucceededIntent) => {
        const lease = await createLeasedWriter(
          `park-${String(withSucceededIntent)}`,
          withSucceededIntent,
        );
        clock.advance(2_000);

        expect(await jobs.reapExpired(db)).toEqual({
          reconciling: [],
          requeued: [],
          succeeded: [],
        });
        expect((await jobs.findById(db, lease.jobId))?.status).toBe("LEASED");

        const [left, right] = await Promise.all([
          recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 }),
          recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 }),
        ]);
        const created = [...left.recoveries, ...right.recoveries];
        expect(created).toHaveLength(1);
        expect((await jobs.findById(db, lease.jobId))?.status).toBe("RECONCILING");
        expect(created[0]).toMatchObject({
          source_job_id: lease.jobId,
          source_fencing_token: String(lease.fencingToken),
          root_recovery_id: created[0]!.recovery_id,
          parent_recovery_id: null,
          status: "PENDING",
          last_recovery_fencing_token: "0",
        });
        expect(created[0]!.workflow_deadline_at.getTime()).toBeGreaterThan(NOW);
      },
    );

    it("uses one recovery winner, rejects generic reconciliation, and publishes one fresh continuation fence", async () => {
      const sourceLease = await createLeasedWriter("continuation", true);
      const intent = await db.query<{ intent_id: string }>(
        "SELECT intent_id FROM job_intents WHERE job_id=$1",
        [sourceLease.jobId],
      );
      clock.advance(2_000);
      const materialized = await recoveries.materializeExpired(db, {
        workflowDeadlineMs: 900_000,
      });
      expect(materialized.recoveries).toHaveLength(1);
      if (sourceLease.caseId === null) throw new Error("source writer lost its case binding");
      await jobs.enqueue(db, {
        jobType: "case.resume",
        payload: { reason: "same-case-must-wait" },
        caseId: sourceLease.caseId,
      });

      expect(await jobs.claim(db, { owner: "generic" })).toBeNull();
      const [a, b] = await Promise.all([
        recoveries.claimRecovery(db, { owner: "recovery-a", leaseMs: 1_000 }),
        recoveries.claimRecovery(db, { owner: "recovery-b", leaseMs: 1_000 }),
      ]);
      const recoveryLease = [a, b].find((value) => value !== null);
      expect([a, b].filter((value) => value !== null)).toHaveLength(1);
      if (recoveryLease === undefined || recoveryLease === null) {
        throw new Error("recovery lease was not claimed");
      }
      const firstPlan = await recoveries.bindPlan(
        db,
        recoveryLease,
        continuationPlan(recoveryLease),
      );
      await expect(
        jobs.reconcile(db, {
          jobId: sourceLease.jobId,
          intentId: intent.rows[0]!.intent_id,
          resolution: "CONFIRMED",
          attemptKey: "generic-bypass",
          evidence: { forbidden: true },
        }),
      ).rejects.toBeInstanceOf(ReconciliationConflictError);

      clock.advance(2_000);
      expect(await jobs.reapExpired(db)).toEqual({
        reconciling: [],
        requeued: [],
        succeeded: [],
      });
      expect((await jobs.findById(db, recoveryLease.job.jobId))?.status).toBe("LEASED");
      await expect(
        recoveries.publishContinuation(db, recoveryLease, firstPlan.planDigest),
      ).rejects.toThrow(/stale engineering recovery lease/);
      expect(await recoveries.reapExpiredRecovery(db)).toEqual([
        recoveryLease.recovery.recovery_id,
      ]);
      await expect(
        recoveries.publishContinuation(db, recoveryLease, firstPlan.planDigest),
      ).rejects.toThrow(/stale engineering recovery lease/);

      const current = await recoveries.claimRecovery(db, {
        owner: "recovery-current",
        leaseMs: 10_000,
      });
      if (current === null) throw new Error("recovery retry was not claimed");
      expect(current.job.fencingToken).toBeGreaterThan(recoveryLease.job.fencingToken);
      const currentPlan = await recoveries.bindPlan(db, current, continuationPlan(current));
      const published = await recoveries.publishContinuation(db, current, currentPlan.planDigest);
      expect(published.status).toBe("RECOVERY_PENDING");
      expect((await jobs.findById(db, sourceLease.jobId))?.status).toBe("RECOVERY_PENDING");
      expect(await jobs.claim(db, { owner: "generic-after-publish" })).toBeNull();
      const waiting = await db.query<{ job_id: string }>(
        `SELECT job_id FROM jobs
          WHERE case_id=$1 AND status='PENDING' AND job_type='case.resume'`,
        [sourceLease.caseId],
      );
      await expect(
        db.query("UPDATE jobs SET status='LEASED' WHERE job_id=$1", [waiting.rows[0]!.job_id]),
      ).rejects.toMatchObject({ code: "23505" });

      const [continuationA, continuationB] = await Promise.all([
        recoveries.claimContinuation(db, { owner: "continuation-a", leaseMs: 10_000 }),
        recoveries.claimContinuation(db, { owner: "continuation-b", leaseMs: 10_000 }),
      ]);
      const continuation = [continuationA, continuationB].find((value) => value !== null);
      expect([continuationA, continuationB].filter((value) => value !== null)).toHaveLength(1);
      expect(continuation?.job).toMatchObject({
        jobId: sourceLease.jobId,
        caseId: sourceLease.caseId,
        jobType: sourceLease.jobType,
      });
      expect(continuation!.job.fencingToken).toBeGreaterThan(sourceLease.fencingToken);
      expect((await recoveries.findById(db, published.recovery_id))?.status).toBe("CONTINUED");

      clock.advance(11_000);
      await expect(
        recoveries.materializeExpired(db, { workflowDeadlineMs: 901_000 }),
      ).rejects.toThrow(/predecessor binding is not exact/);
      const next = await recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 });
      expect(next.recoveries).toHaveLength(1);
      expect(next.recoveries[0]).toMatchObject({
        source_job_id: sourceLease.jobId,
        source_fencing_token: String(continuation!.job.fencingToken),
        parent_recovery_id: published.recovery_id,
        root_recovery_id: published.root_recovery_id,
        workflow_deadline_at: published.workflow_deadline_at,
      });
    });

    it("reconstructs queue success only from the exact durable outer run completion", async () => {
      const lease = await createLeasedWriter("completed", true);
      const proposal = await db.query<{ run_id: string; case_id: string }>(
        "SELECT run_id,case_id FROM engineering_write_proposals WHERE job_id=$1",
        [lease.jobId],
      );
      await db.query(
        `INSERT INTO run_completions (completion_id,run_id,case_id,status,completion)
         VALUES ('outer-completion',$1,$2,'COMPLETED',$3::jsonb)`,
        [proposal.rows[0]!.run_id, proposal.rows[0]!.case_id, JSON.stringify({ exact: true })],
      );
      clock.advance(2_000);
      const result = await recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 });
      expect(result).toEqual({ recoveries: [], succeededSourceJobIds: [lease.jobId] });
      expect((await jobs.findById(db, lease.jobId))?.status).toBe("SUCCEEDED");
      expect(
        (await db.query<{ count: string }>("SELECT count(*)::text FROM engineering_recoveries"))
          .rows[0]!.count,
      ).toBe("0");
    });

    it("repairs one exact STARTED operation without broadening the stale source fence", async () => {
      const sourceLease = await createLeasedWriter("repair", false);
      const payload = sourceLease.payload as Record<string, unknown>;
      const operation = await control.bindOperationIntent(db, sourceLease, {
        operationId: "repair-operation",
        runId: payload.runId,
        stage: "SLICE_PLANNING",
        stageAttempt: 1,
        operationKind: "engineering.stage.slice_planning",
        effectClass: "MODEL_CALL",
        descriptor: { context: "exact-repair" },
        configDigest: canonicalDigest({ config: "repair" }),
        schemaDigest: canonicalDigest({ schema: "repair" }),
        deadlineAt: new Date(clock.now() + 900_000).toISOString(),
      });
      await control.commitOperationStarted(db, sourceLease, {
        operationId: operation.operation_id,
      });
      clock.advance(2_000);
      expect(
        (await recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 })).recoveries,
      ).toHaveLength(1);
      const recoveryLease = await recoveries.claimRecovery(db, {
        owner: "repair-worker",
        leaseMs: 10_000,
      });
      if (recoveryLease === null) throw new Error("repair recovery was not claimed");
      const bound = await recoveries.bindPlan(db, recoveryLease, repairPlan(recoveryLease));
      const artifact = {
        schema_version: 1,
        artifact_kind: "SliceContract",
        case_id: recoveryLease.recovery.case_id,
        run_id: recoveryLease.recovery.run_id,
        revision: recoveryLease.recovery.checkpoint_revision,
        slice_id: "slice-repair",
        objective: "recover exact planning output",
        observable_result: "one durable slice contract",
        allowed_paths: ["packages/database/src"],
        gate_ids: ["gate-1"],
        inspection_method: "read the durable ledger",
        stop_condition: "one exact repair",
      };

      await expect(
        recoveries.repairStageDurability(db, recoveryLease, {
          planDigest: canonicalDigest({ wrong: true }),
          operationId: operation.operation_id,
          artifactKey: "slice-repair/contract",
          artifact,
        }),
      ).rejects.toThrow(/plan is not durably bound/);
      await expect(
        recoveries.repairStageDurability(db, recoveryLease, {
          planDigest: bound.planDigest,
          operationId: "foreign-operation",
          artifactKey: "slice-repair/contract",
          artifact,
        }),
      ).rejects.toThrow(/repair operation is not exact/);
      await expect(
        recoveries.repairStageDurability(db, recoveryLease, {
          planDigest: bound.planDigest,
          operationId: operation.operation_id,
          artifactKey: "slice-repair/contract",
          artifact: { ...artifact, case_id: "foreign-case" },
        }),
      ).rejects.toThrow(/crosses its operation/);
      expect(
        await db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM engineering_artifact_revisions",
        ),
      ).toMatchObject({ rows: [{ count: "0" }] });
      const repaired = await recoveries.repairStageDurability(db, recoveryLease, {
        planDigest: bound.planDigest,
        operationId: operation.operation_id,
        artifactKey: "slice-repair/contract",
        artifact,
      });
      const replay = await recoveries.repairStageDurability(db, recoveryLease, {
        planDigest: bound.planDigest,
        operationId: operation.operation_id,
        artifactKey: "slice-repair/contract",
        artifact,
      });
      expect(replay).toEqual(repaired);
      expect(
        await db.query<{ event_type: string; count: string }>(
          `SELECT event_type,count(*)::text AS count FROM engineering_stage_events
            WHERE operation_id=$1 AND event_type IN ('ARTIFACT_RECORDED','COMPLETION_OBSERVED')
            GROUP BY event_type ORDER BY event_type`,
          [operation.operation_id],
        ),
      ).toMatchObject({
        rows: [
          { event_type: "ARTIFACT_RECORDED", count: "1" },
          { event_type: "COMPLETION_OBSERVED", count: "1" },
        ],
      });
      expect(
        await db.query<{ event_type: string; count: string }>(
          `SELECT event_type,count(*)::text AS count FROM engineering_recovery_events
            WHERE recovery_id=$1 AND event_type LIKE '%REPAIRED'
            GROUP BY event_type ORDER BY event_type`,
          [recoveryLease.recovery.recovery_id],
        ),
      ).toMatchObject({
        rows: [
          { event_type: "ARTIFACT_REPAIRED", count: "1" },
          { event_type: "COMPLETION_REPAIRED", count: "1" },
          { event_type: "OBSERVATION_REPAIRED", count: "1" },
        ],
      });
      await expect(
        control.observeOperationCompletion(db, sourceLease, {
          operationId: operation.operation_id,
          completionId: repaired.completionId,
        }),
      ).rejects.toThrow(/stale|lease/iu);
    });

    it("persists only a bound terminal classification and keeps the source quarantined", async () => {
      const sourceLease = await createLeasedWriter("terminal", false);
      clock.advance(2_000);
      await recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 });
      const recoveryLease = await recoveries.claimRecovery(db, {
        owner: "terminal-worker",
        leaseMs: 10_000,
      });
      if (recoveryLease === null) throw new Error("terminal recovery was not claimed");
      const nonTerminal = await recoveries.bindPlan(
        db,
        recoveryLease,
        continuationPlan(recoveryLease),
      );
      await expect(
        recoveries.terminateRecovery(db, recoveryLease, nonTerminal.planDigest),
      ).rejects.toThrow(/plan is not terminal/);
      await expect(
        recoveries.bindPlan(db, recoveryLease, {
          ...continuationPlan(recoveryLease),
          classification: "AMBIGUOUS",
        }),
      ).rejects.toThrow(/plan is already bound/);
      await expect(
        db.query(
          `UPDATE engineering_recoveries
              SET plan=jsonb_set(plan,'{classification}','"AMBIGUOUS"'::jsonb)
            WHERE recovery_id=$1`,
          [recoveryLease.recovery.recovery_id],
        ),
      ).rejects.toMatchObject({ code: "P0103" });
      expect((await jobs.findById(db, recoveryLease.job.jobId))?.status).toBe("LEASED");

      await expect(recoveries.reapExpiredRecovery(db)).resolves.toEqual([]);
      clock.advance(11_000);
      await recoveries.reapExpiredRecovery(db);
      const current = await recoveries.claimRecovery(db, {
        owner: "terminal-current",
        leaseMs: 10_000,
      });
      if (current === null) throw new Error("terminal retry was not claimed");
      const terminalPlan = await recoveries.bindPlan(db, current, {
        ...continuationPlan(current),
        classification: "AMBIGUOUS",
      });
      const terminal = await recoveries.terminateRecovery(db, current, terminalPlan.planDigest);
      expect(terminal.status).toBe("AMBIGUOUS");
      expect((await jobs.findById(db, current.job.jobId))?.status).toBe("SUCCEEDED");
      expect((await jobs.findById(db, sourceLease.jobId))?.status).toBe("RECONCILING");
      expect(await jobs.claim(db, { owner: "generic-terminal" })).toBeNull();
      expect(
        await db.query<{ event_type: string }>(
          `SELECT event_type FROM engineering_recovery_events
            WHERE recovery_id=$1 ORDER BY event_sequence DESC LIMIT 1`,
          [current.recovery.recovery_id],
        ),
      ).toMatchObject({ rows: [{ event_type: "TERMINATED" }] });
    });

    it("refuses a conflicting completion receipt and rolls back the attempted artifact repair", async () => {
      const sourceLease = await createLeasedWriter("repair-conflict", false);
      const payload = sourceLease.payload as Record<string, unknown>;
      const operation = await control.bindOperationIntent(db, sourceLease, {
        operationId: "repair-conflict-operation",
        runId: payload.runId,
        stage: "SLICE_PLANNING",
        stageAttempt: 1,
        operationKind: "engineering.stage.slice_planning",
        effectClass: "MODEL_CALL",
        descriptor: { context: "repair-conflict" },
        configDigest: canonicalDigest({ config: "repair-conflict" }),
        schemaDigest: canonicalDigest({ schema: "repair-conflict" }),
        deadlineAt: new Date(clock.now() + 900_000).toISOString(),
      });
      await control.commitOperationStarted(db, sourceLease, {
        operationId: operation.operation_id,
      });
      await jobs.recordCompletion(db, {
        intentId: operation.intent_id,
        jobId: sourceLease.jobId,
        outcome: "SUCCEEDED",
        receipt: { foreign: true },
        lease: sourceLease,
      });
      clock.advance(2_000);
      await recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 });
      const recoveryLease = await recoveries.claimRecovery(db, {
        owner: "repair-conflict-worker",
        leaseMs: 10_000,
      });
      if (recoveryLease === null) throw new Error("conflict recovery was not claimed");
      const bound = await recoveries.bindPlan(db, recoveryLease, repairPlan(recoveryLease));
      await expect(
        recoveries.repairStageDurability(db, recoveryLease, {
          planDigest: bound.planDigest,
          operationId: operation.operation_id,
          artifactKey: "slice-conflict/contract",
          artifact: {
            schema_version: 1,
            artifact_kind: "SliceContract",
            case_id: recoveryLease.recovery.case_id,
            run_id: recoveryLease.recovery.run_id,
            revision: recoveryLease.recovery.checkpoint_revision,
            slice_id: "slice-conflict",
            objective: "must not commit",
            observable_result: "no partial repair",
            allowed_paths: ["packages/database/src"],
            gate_ids: ["gate-1"],
            inspection_method: "read ledger",
            stop_condition: "conflicting receipt",
          },
        }),
      ).rejects.toThrow(/completion conflicts/);
      expect(
        await db.query<{ artifacts: string; repairs: string }>(
          `SELECT
             (SELECT count(*)::text FROM engineering_artifact_revisions
               WHERE operation_id=$1) AS artifacts,
             (SELECT count(*)::text FROM engineering_recovery_events
               WHERE recovery_id=$2 AND event_type LIKE '%REPAIRED') AS repairs`,
          [operation.operation_id, recoveryLease.recovery.recovery_id],
        ),
      ).toMatchObject({ rows: [{ artifacts: "0", repairs: "0" }] });
    });

    it("rejects malformed recovery job scope and freezes code-owned payload", async () => {
      await expect(
        db.query(
          `INSERT INTO jobs (
             job_id,case_id,job_type,status,payload,provider,serialization_key,available_at)
           VALUES ('malformed-recovery',NULL,'agent.engineering_recovery','PENDING',
                   $1::jsonb,NULL,'wrong-key',now())`,
          [
            JSON.stringify({
              reason: "engineering_recovery",
              recoveryId: "malformed",
              sourceJobId: "source",
              sourceFencingToken: 1,
              caseId: "case",
              workUnitId: "unit",
              runId: "run",
              checkpointRevision: 0,
            }),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const source = await createLeasedWriter("immutable", false);
      clock.advance(2_000);
      const result = await recoveries.materializeExpired(db, { workflowDeadlineMs: 900_000 });
      const recoveryJobId = result.recoveries[0]!.recovery_job_id;
      await expect(
        db.query("UPDATE jobs SET payload=payload || '{\"extra\":true}'::jsonb WHERE job_id=$1", [
          recoveryJobId,
        ]),
      ).rejects.toMatchObject({ code: "P0103" });
      const authority = result.recoveries[0]!;
      await db.query(
        `INSERT INTO jobs (
           job_id,case_id,job_type,status,payload,provider,serialization_key,available_at)
         VALUES ('forged-fence-job',NULL,'agent.engineering_recovery','PENDING',
                 $1::jsonb,NULL,'engineering-recovery:forged-fence',now())`,
        [
          JSON.stringify({
            reason: "engineering_recovery",
            recoveryId: "forged-fence",
            sourceJobId: authority.source_job_id,
            sourceFencingToken: Number(authority.source_fencing_token) + 1,
            caseId: authority.case_id,
            workUnitId: authority.work_unit_id,
            runId: authority.run_id,
            checkpointRevision: authority.checkpoint_revision,
          }),
        ],
      );
      await expect(
        db.query(
          `INSERT INTO engineering_recoveries (
             recovery_id,root_recovery_id,parent_recovery_id,
             source_job_id,source_fencing_token,recovery_job_id,
             proposal_id,approval_id,case_id,owner_id,work_unit_id,run_id,
             checkpoint_revision,repository_id,source_payload_digest,workflow_deadline_at)
           VALUES ('forged-fence',$1,$2,$3,$4,'forged-fence-job',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            authority.root_recovery_id,
            authority.recovery_id,
            authority.source_job_id,
            Number(authority.source_fencing_token) + 1,
            authority.proposal_id,
            authority.approval_id,
            authority.case_id,
            authority.owner_id,
            authority.work_unit_id,
            authority.run_id,
            authority.checkpoint_revision,
            authority.repository_id,
            authority.source_payload_digest,
            authority.workflow_deadline_at,
          ],
        ),
      ).rejects.toMatchObject({ code: "P0103" });
      expect((await jobs.findById(db, source.jobId))?.status).toBe("RECONCILING");
    });

    it("rejects cross-run authority assembly and falsely fenced recovery events", async () => {
      const leaseA = await createLeasedWriter("authority-a", false);
      const leaseB = await createLeasedWriter("authority-b", false);
      clock.advance(2_000);
      const materialized = await recoveries.materializeExpired(db, {
        workflowDeadlineMs: 900_000,
        limit: 1,
      });
      expect(materialized.recoveries).toHaveLength(1);
      const foreign = materialized.recoveries[0]!;
      const unboundLease = [leaseA, leaseB].find((lease) => lease.jobId !== foreign.source_job_id)!;
      await db.query(
        `UPDATE jobs SET status='RECONCILING',lease_owner=NULL,lease_expires_at=NULL
          WHERE job_id=$1 AND status='LEASED'`,
        [unboundLease.jobId],
      );
      const source = await db.query<{
        case_id: string;
        owner_id: string;
        work_unit_id: string;
        run_id: string;
        checkpoint_revision: number;
        repository_id: string;
        run_created_at: Date;
      }>(
        `SELECT p.case_id,p.owner_id,p.work_unit_id,p.run_id,p.checkpoint_revision,
                p.repository_id,r.created_at AS run_created_at
           FROM engineering_write_proposals p
           JOIN agent_runs r ON r.run_id=p.run_id
          WHERE p.job_id=$1`,
        [unboundLease.jobId],
      );
      const sourceAuthority = source.rows[0]!;
      await db.query(
        `INSERT INTO jobs (
           job_id,case_id,job_type,status,payload,provider,serialization_key,available_at)
         VALUES ('mixed-recovery-job',NULL,'agent.engineering_recovery','PENDING',
                 $1::jsonb,NULL,'engineering-recovery:mixed-recovery',now())`,
        [
          JSON.stringify({
            reason: "engineering_recovery",
            recoveryId: "mixed-recovery",
            sourceJobId: unboundLease.jobId,
            sourceFencingToken: unboundLease.fencingToken,
            caseId: sourceAuthority.case_id,
            workUnitId: sourceAuthority.work_unit_id,
            runId: sourceAuthority.run_id,
            checkpointRevision: sourceAuthority.checkpoint_revision,
          }),
        ],
      );
      await expect(
        db.query(
          `INSERT INTO engineering_recoveries (
             recovery_id,root_recovery_id,parent_recovery_id,
             source_job_id,source_fencing_token,recovery_job_id,
             proposal_id,approval_id,case_id,owner_id,work_unit_id,run_id,
             checkpoint_revision,repository_id,source_payload_digest,workflow_deadline_at)
           VALUES ('mixed-recovery','mixed-recovery',NULL,$1,$2,'mixed-recovery-job',
                   $3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            unboundLease.jobId,
            unboundLease.fencingToken,
            foreign.proposal_id,
            foreign.approval_id,
            sourceAuthority.case_id,
            sourceAuthority.owner_id,
            sourceAuthority.work_unit_id,
            sourceAuthority.run_id,
            sourceAuthority.checkpoint_revision,
            sourceAuthority.repository_id,
            canonicalDigest(unboundLease.payload),
            new Date(sourceAuthority.run_created_at.getTime() + 900_000),
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });

      await expect(
        db.query(
          `INSERT INTO engineering_recovery_events (
             event_id,recovery_id,event_type,authority_job_id,authority_fencing_token,
             payload,payload_digest)
           VALUES ('forged-event',$1,'CLAIMED',$2,999,'{}'::jsonb,$3)`,
          [foreign.recovery_id, foreign.recovery_job_id, canonicalDigest({})],
        ),
      ).rejects.toMatchObject({ code: "P0103" });
    });

    it("rejects an operation tuple assembled from a foreign engineering run", async () => {
      const foreignLease = await createLeasedWriter("operation-foreign", true);
      const sourceLease = await createLeasedWriter("operation-source", true);
      const foreign = await db.query<{
        intent_id: string;
        idempotency_key: string;
        case_id: string;
        owner_id: string;
        run_id: string;
        checkpoint_revision: number;
        run_created_at: Date;
      }>(
        `SELECT i.intent_id,i.idempotency_key,p.case_id,p.owner_id,p.run_id,
                p.checkpoint_revision,r.created_at AS run_created_at
           FROM job_intents i
           JOIN engineering_write_proposals p ON p.job_id=i.job_id
           JOIN agent_runs r ON r.run_id=p.run_id
          WHERE i.job_id=$1`,
        [foreignLease.jobId],
      );
      const foreignAuthority = foreign.rows[0]!;
      const scopeDigest = canonicalDigest({ scope: "foreign" });
      const inputDigest = canonicalDigest({ input: "foreign" });
      const configDigest = canonicalDigest({ config: "foreign" });
      const schemaDigest = canonicalDigest({ schema: "foreign" });
      const deadline = new Date(foreignAuthority.run_created_at.getTime() + 900_000);
      await db.query(
        `INSERT INTO engineering_operations (
           operation_id,intent_id,idempotency_key,job_id,case_id,owner_id,run_id,
           stage,stage_attempt,checkpoint_revision,operation_kind,effect_class,
           integration_scope_digest,input_digest,config_digest,schema_digest,deadline_at)
         VALUES ($1,$2,$1,$3,$4,$5,$6,'DISCOVERY',1,$7,'fixture.model','MODEL_CALL',
                 $8,$9,$10,$11,$12)`,
        [
          foreignAuthority.idempotency_key,
          foreignAuthority.intent_id,
          foreignLease.jobId,
          foreignAuthority.case_id,
          foreignAuthority.owner_id,
          foreignAuthority.run_id,
          foreignAuthority.checkpoint_revision,
          scopeDigest,
          inputDigest,
          configDigest,
          schemaDigest,
          deadline,
        ],
      );
      await db.query(
        `UPDATE jobs SET status='RECONCILING',lease_owner=NULL,lease_expires_at=NULL
          WHERE job_id=$1 AND status='LEASED'`,
        [sourceLease.jobId],
      );
      const source = await db.query<{
        proposal_id: string;
        approval_id: string;
        case_id: string;
        owner_id: string;
        work_unit_id: string;
        run_id: string;
        checkpoint_revision: number;
        repository_id: string;
        intent_id: string;
      }>(
        `SELECT p.proposal_id,p.approval_id,p.case_id,p.owner_id,p.work_unit_id,p.run_id,
                p.checkpoint_revision,p.repository_id,i.intent_id
           FROM engineering_write_proposals p
           JOIN job_intents i ON i.job_id=p.job_id
          WHERE p.job_id=$1`,
        [sourceLease.jobId],
      );
      const sourceAuthority = source.rows[0]!;
      await db.query(
        `INSERT INTO jobs (
           job_id,case_id,job_type,status,payload,provider,serialization_key,available_at)
         VALUES ('foreign-operation-recovery-job',NULL,'agent.engineering_recovery','PENDING',
                 $1::jsonb,NULL,'engineering-recovery:foreign-operation-recovery',now())`,
        [
          JSON.stringify({
            reason: "engineering_recovery",
            recoveryId: "foreign-operation-recovery",
            sourceJobId: sourceLease.jobId,
            sourceFencingToken: sourceLease.fencingToken,
            caseId: sourceAuthority.case_id,
            workUnitId: sourceAuthority.work_unit_id,
            runId: sourceAuthority.run_id,
            checkpointRevision: sourceAuthority.checkpoint_revision,
          }),
        ],
      );
      await expect(
        db.query(
          `INSERT INTO engineering_recoveries (
             recovery_id,root_recovery_id,parent_recovery_id,
             source_job_id,source_fencing_token,recovery_job_id,
             proposal_id,approval_id,case_id,owner_id,work_unit_id,run_id,
             checkpoint_revision,repository_id,source_payload_digest,workflow_deadline_at,
             source_operation_id,source_intent_id,source_stage,source_stage_attempt,
             source_effect_class,source_input_digest,source_config_digest,
             source_schema_digest,source_scope_digest,source_deadline_at)
           VALUES ('foreign-operation-recovery','foreign-operation-recovery',NULL,$1,$2,
                   'foreign-operation-recovery-job',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                   $13,$14,'DISCOVERY',1,'MODEL_CALL',$15,$16,$17,$18,$12)`,
          [
            sourceLease.jobId,
            sourceLease.fencingToken,
            sourceAuthority.proposal_id,
            sourceAuthority.approval_id,
            sourceAuthority.case_id,
            sourceAuthority.owner_id,
            sourceAuthority.work_unit_id,
            sourceAuthority.run_id,
            sourceAuthority.checkpoint_revision,
            sourceAuthority.repository_id,
            canonicalDigest(sourceLease.payload),
            deadline,
            foreignAuthority.idempotency_key,
            sourceAuthority.intent_id,
            inputDigest,
            configDigest,
            schemaDigest,
            scopeDigest,
          ],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    });
  },
  available,
);
