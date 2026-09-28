import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineeringStage } from "@remoteagent/contracts";
import {
  EngineeringRecoveryRepository,
  OutboxRepository,
  Scheduler,
  productionRuntime,
} from "@remoteagent/database";
import { afterEach, expect, it } from "vitest";

import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { createStructuredPreCommitReviewSessionFactory } from "../src/engineering-workflow.js";
import { createConfiguredEngineeringStageExecutor } from "../src/engineering-execution.js";
import { createProductionEngineeringRecoveryCoordinator } from "../src/engineering-recovery.js";
import {
  EngineeringDebugJournal,
  runWithEngineeringDebugJournal,
} from "../src/engineering-debug-journal.js";
import {
  createEngineeringQualificationFixture,
  EngineeringQualificationTransport,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const available = await ensurePostgres();

const stageDiagnosticsEnabled = process.env.RA_ENGINEERING_STAGE_DIAGNOSTICS === "1";
const stageDiagnosticsStartedAt = Date.now();
function stageDiagnostic(stage: string, transport?: EngineeringQualificationTransport): void {
  if (!stageDiagnosticsEnabled) return;
  process.stderr.write(
    `${JSON.stringify({
      stage,
      elapsed_ms: Date.now() - stageDiagnosticsStartedAt,
      ...(transport === undefined ? {} : { transport_requests: transport.requests.length }),
    })}\n`,
  );
}

async function aroundStage<T>(
  stage: string,
  operation: () => Promise<T>,
  transport?: EngineeringQualificationTransport,
): Promise<T> {
  stageDiagnostic(`${stage}:start`, transport);
  try {
    return await operation();
  } finally {
    stageDiagnostic(`${stage}:end`, transport);
  }
}

const largeRiskFacts = Object.freeze({
  authority: "SERVER_OWNED" as const,
  security_or_policy: false,
  migration: false,
  irreversible_side_effect: false,
  broad_public_contract_change: false,
  multi_module: true,
  new_architecture: false,
  deterministic_oracle: false,
  user_data: false,
  concurrency: true,
  external_side_effect: false,
});

function runtimeIdentity(fixture: EngineeringQualificationFixture) {
  return {
    unit: {
      workUnit: {
        schema_version: 1 as const,
        work_unit_id: fixture.ids.workUnitId,
        case_id: fixture.ids.caseId,
        role: "IMPLEMENTER" as const,
        status: "DISPATCHED" as const,
        objective: "cross-fence production qualification",
        authoritative_scope: {
          connection_ids: [],
          repo_allowlist: [fixture.ids.repositoryId],
          can_write_workspace: true as const,
        },
        run_id: fixture.ids.runId,
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
    },
    run: { runId: fixture.ids.runId, checkpointRevision: 0 },
  };
}

function discoveryBinding(fixture: EngineeringQualificationFixture) {
  return {
    caseId: fixture.ids.caseId,
    workUnitId: fixture.ids.workUnitId,
    runId: fixture.ids.runId,
    checkpointRevision: 0,
    stage: EngineeringStage.DISCOVERY,
    attempt: 1,
  } as const;
}

function recoveryCoordinator(
  fixture: EngineeringQualificationFixture,
  transport: EngineeringQualificationTransport,
  owner: string,
) {
  const stageExecutor = createConfiguredEngineeringStageExecutor({
    transport,
    modelConfig: fixture.modelConfig,
    executionConfig: fixture.config,
  });
  const reviewer = createStructuredPreCommitReviewSessionFactory({
    transport,
    config: fixture.modelConfig,
  });
  return createProductionEngineeringRecoveryCoordinator({
    db: fixture.db,
    jobs: fixture.jobs,
    owner,
    config: fixture.config,
    transport,
    modelConfig: fixture.modelConfig,
    readContext: fixture.readContext,
    stageExecutor,
    createReviewerSession: reviewer.createSession,
  });
}

describeIntegration(
  "production engineering cross-fence coordinator",
  () => {
    let fixture: EngineeringQualificationFixture | null = null;
    let diagnosticJournal: EngineeringDebugJournal | null = null;

    afterEach(async () => {
      try {
        await aroundStage("fixture.drop", async () => fixture?.drop());
      } finally {
        fixture = null;
        if (diagnosticJournal !== null) {
          await diagnosticJournal.close();
          diagnosticJournal = null;
        }
      }
    });

    it("parks an expired writer, claims one dedicated continuation, and completes through the existing handler", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "cross-fence-coordinator" });
      const approvalId = "cross-fence-approval";
      await fixture.grantWriteApproval({
        approvalId,
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const original = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const transport = new EngineeringQualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-one", "slice-two", "slice-three"],
        implementationPaths: ["src/change-1.ts", "src/change-2.ts", "src/change-3.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const crashed = fixture.makeProduction(original, {
        transport,
        policy: { riskFacts: largeRiskFacts },
      });
      const discovery = discoveryBinding(fixture);
      await aroundStage(
        "crashed.port.open",
        () => crashed.port.open(runtimeIdentity(fixture!)),
        transport,
      );
      await aroundStage(
        "crashed.port.prepareContext",
        () => crashed.port.prepareContext(discovery),
        transport,
      );
      await aroundStage(
        "crashed.port.commitStarted",
        () => crashed.port.commitStarted(discovery),
        transport,
      );
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [original.jobId],
      );
      const stageExecutor = createConfiguredEngineeringStageExecutor({
        transport,
        modelConfig: fixture.modelConfig,
        executionConfig: fixture.config,
      });
      const reviewer = createStructuredPreCommitReviewSessionFactory({
        transport,
        config: fixture.modelConfig,
      });
      const coordinator = createProductionEngineeringRecoveryCoordinator({
        db: fixture.db,
        jobs: fixture.jobs,
        owner: "cross-fence-worker",
        config: fixture.config,
        transport,
        modelConfig: fixture.modelConfig,
        readContext: fixture.readContext,
        stageExecutor,
        createReviewerSession: reviewer.createSession,
      });
      const scheduler = new Scheduler({
        db: fixture.db,
        jobs: fixture.jobs,
        outbox: new OutboxRepository(productionRuntime()),
        clock: productionRuntime().clock,
        sink: async () => undefined,
        continuation: coordinator,
        claim: { owner: "cross-fence-worker", leaseMs: 120_000 },
        handler: async (lease, heartbeat) => {
          stageDiagnostic("handler:enter", transport);
          const production = fixture!.makeProduction(lease, {
            transport,
            policy: { riskFacts: largeRiskFacts },
          });
          try {
            const runHandler = () => production.handler(lease, heartbeat);
            if (diagnosticJournal !== null) {
              await runWithEngineeringDebugJournal(diagnosticJournal, runHandler);
            } else {
              await runHandler();
            }
          } finally {
            stageDiagnostic("handler:exit", transport);
          }
        },
        relay: { aggregates: [] },
      });

      if (stageDiagnosticsEnabled) {
        const journalRoot = await mkdtemp(join(tmpdir(), "ra055-cross-fence-journal-"));
        diagnosticJournal = await EngineeringDebugJournal.create({
          artifactRoot: journalRoot,
          invocationId: "cross-fence-coordinator",
        });
      }
      const result = await aroundStage(
        "coordinator.prepare_claim.scheduler.tick",
        () => scheduler.tick(),
        transport,
      );
      stageDiagnostic("posttick.assertions:start", transport);
      expect(result).toMatchObject({
        claimedJobId: original.jobId,
        jobOutcome: "SUCCEEDED",
      });
      const source = await fixture.jobs.findById(fixture.db, original.jobId);
      expect(source).toMatchObject({
        status: "SUCCEEDED",
        fencing_token: String(original.fencingToken + 1),
      });
      expect(transport.requests.length).toBeGreaterThan(0);

      const durable = await fixture.db.query<{
        recoveries: string;
        continued: string;
        local_commits: string;
        run_completions: string;
        discovery_operations: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_recoveries
             WHERE source_job_id=$1) AS recoveries,
           (SELECT count(*)::text FROM engineering_recoveries
             WHERE source_job_id=$1 AND status='CONTINUED'
               AND continuation_fencing_token=$2) AS continued,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$3 AND artifact_kind='LocalCommitReceipt') AS local_commits,
           (SELECT count(*)::text FROM run_completions
             WHERE run_id=$3 AND status='COMPLETED') AS run_completions,
           (SELECT count(*)::text FROM engineering_operations
             WHERE run_id=$3 AND stage='DISCOVERY' AND stage_attempt=1)
             AS discovery_operations`,
        [original.jobId, original.fencingToken + 1, fixture.ids.runId],
      );
      expect(durable.rows[0]).toEqual({
        recoveries: "1",
        continued: "1",
        local_commits: "1",
        run_completions: "1",
        discovery_operations: "2",
      });
      expect(
        await new EngineeringRecoveryRepository(productionRuntime()).findContinuationForLease(
          fixture.db,
          {
            ...original,
            fencingToken: original.fencingToken + 1,
            leaseOwner: "cross-fence-worker",
            leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
          },
        ),
      ).toBeNull();
      stageDiagnostic("posttick.assertions:end", transport);
    });

    it("suspends a failed continuation into a child recovery instead of generic PENDING retry", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "cross-fence-suspend" });
      const approvalId = "cross-fence-suspend-approval";
      await fixture.grantWriteApproval({
        approvalId,
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const original = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [original.jobId],
      );
      const transport = new EngineeringQualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-one", "slice-two", "slice-three"],
        implementationPaths: ["src/change-1.ts", "src/change-2.ts", "src/change-3.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const stageExecutor = createConfiguredEngineeringStageExecutor({
        transport,
        modelConfig: fixture.modelConfig,
        executionConfig: fixture.config,
      });
      const reviewer = createStructuredPreCommitReviewSessionFactory({
        transport,
        config: fixture.modelConfig,
      });
      const coordinator = createProductionEngineeringRecoveryCoordinator({
        db: fixture.db,
        jobs: fixture.jobs,
        owner: "cross-fence-suspend-worker",
        config: fixture.config,
        transport,
        modelConfig: fixture.modelConfig,
        readContext: fixture.readContext,
        stageExecutor,
        createReviewerSession: reviewer.createSession,
      });
      const scheduler = new Scheduler({
        db: fixture.db,
        jobs: fixture.jobs,
        outbox: new OutboxRepository(productionRuntime()),
        clock: productionRuntime().clock,
        sink: async () => undefined,
        continuation: coordinator,
        claim: { owner: "cross-fence-suspend-worker", leaseMs: 120_000 },
        handler: async (lease) => {
          const production = fixture!.makeProduction(lease, {
            transport,
            policy: { riskFacts: largeRiskFacts },
          });
          await production.port.open(runtimeIdentity(fixture!));
          const discovery = discoveryBinding(fixture!);
          await production.port.prepareContext(discovery);
          await production.port.commitStarted(discovery);
          throw new Error("controlled continuation failure");
        },
        relay: { aggregates: [] },
      });

      await expect(scheduler.tick()).resolves.toMatchObject({
        claimedJobId: original.jobId,
        jobOutcome: "RECONCILING",
      });
      expect(await fixture.jobs.findById(fixture.db, original.jobId)).toMatchObject({
        status: "RECONCILING",
      });
      expect(await fixture.jobs.claim(fixture.db, { owner: "generic-bypass" })).toBeNull();
      expect(
        await fixture.db.query<{
          status: string;
          count: string;
          source_operation_count: string;
        }>(
          `SELECT status,count(*)::text AS count,
                  count(source_operation_id)::text AS source_operation_count
             FROM engineering_recoveries
            WHERE source_job_id=$1 GROUP BY status ORDER BY status`,
          [original.jobId],
        ),
      ).toMatchObject({
        rows: [
          { status: "CONTINUED", count: "1", source_operation_count: "0" },
          { status: "PENDING", count: "1", source_operation_count: "1" },
        ],
      });
      expect(transport.requests).toHaveLength(0);
    });

    it("does not copy an old-fence operation when continuation fails before binding a new intent", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "cross-fence-pre-intent" });
      const approvalId = "cross-fence-pre-intent-approval";
      await fixture.grantWriteApproval({
        approvalId,
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const original = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId,
      });
      const transport = new EngineeringQualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-one", "slice-two", "slice-three"],
        implementationPaths: ["src/change-1.ts", "src/change-2.ts", "src/change-3.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const crashed = fixture.makeProduction(original, {
        transport,
        policy: { riskFacts: largeRiskFacts },
      });
      await crashed.port.open(runtimeIdentity(fixture));
      const discovery = discoveryBinding(fixture);
      await crashed.port.prepareContext(discovery);
      await crashed.port.commitStarted(discovery);
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [original.jobId],
      );
      const scheduler = new Scheduler({
        db: fixture.db,
        jobs: fixture.jobs,
        outbox: new OutboxRepository(productionRuntime()),
        clock: productionRuntime().clock,
        sink: async () => undefined,
        continuation: recoveryCoordinator(fixture, transport, "pre-intent-worker"),
        claim: { owner: "pre-intent-worker", leaseMs: 120_000 },
        handler: async () => {
          throw new Error("fail before new intent");
        },
        relay: { aggregates: [] },
      });

      await expect(scheduler.tick()).resolves.toMatchObject({
        claimedJobId: original.jobId,
        jobOutcome: "RECONCILING",
      });
      expect(
        await fixture.db.query<{ source_operation_id: string | null; status: string }>(
          `SELECT source_operation_id,status FROM engineering_recoveries
            WHERE source_job_id=$1 ORDER BY created_at,recovery_id`,
          [original.jobId],
        ),
      ).toMatchObject({
        rows: [
          { source_operation_id: expect.any(String), status: "CONTINUED" },
          { source_operation_id: null, status: "PENDING" },
        ],
      });
      expect(transport.requests).toHaveLength(0);
    });
  },
  available,
);
