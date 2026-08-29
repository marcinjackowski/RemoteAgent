import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  EngineeringControlPlaneRepository,
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
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";
import {
  createEngineeringQualificationFixture,
  EngineeringQualificationTransport,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const available = await ensurePostgres();
const run = promisify(execFile);
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

class CrashOuterArtifactOnce extends EngineeringControlPlaneRepository {
  public crashed = false;

  public constructor(private readonly artifactKind: "EvidenceBundle" | "LocalCommitReceipt") {
    super(productionRuntime());
  }

  public override async appendArtifactRevision(
    ...args: Parameters<EngineeringControlPlaneRepository["appendArtifactRevision"]>
  ): ReturnType<EngineeringControlPlaneRepository["appendArtifactRevision"]> {
    if (!this.crashed && args[2].artifact.artifact_kind === this.artifactKind) {
      this.crashed = true;
      throw new Error(`injected ${this.artifactKind} outer artifact crash`);
    }
    return super.appendArtifactRevision(...args);
  }
}

function transportFor(fixture: EngineeringQualificationFixture) {
  return new EngineeringQualificationTransport({
    caseId: fixture.ids.caseId,
    runId: fixture.ids.runId,
    sliceIds: ["slice-one", "slice-two", "slice-three"],
    implementationPaths: ["src/change-1.ts", "src/change-2.ts", "src/change-3.ts"],
    processClass: "LARGE_OR_HIGH_RISK",
  });
}

function coordinatorFor(
  fixture: EngineeringQualificationFixture,
  transport: EngineeringQualificationTransport,
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
    owner: "cross-fence-recovery-worker",
    config: fixture.config,
    transport,
    modelConfig: fixture.modelConfig,
    readContext: fixture.readContext,
    stageExecutor,
    createReviewerSession: reviewer.createSession,
  });
}

async function expire(lease: { jobId: string }, fixture: EngineeringQualificationFixture) {
  await fixture.db.query(
    "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
    [lease.jobId],
  );
}

function schedulerFor(
  fixture: EngineeringQualificationFixture,
  transport: EngineeringQualificationTransport,
) {
  return new Scheduler({
    db: fixture.db,
    jobs: fixture.jobs,
    outbox: new OutboxRepository(productionRuntime()),
    clock: productionRuntime().clock,
    sink: async () => undefined,
    continuation: coordinatorFor(fixture, transport),
    claim: { owner: "cross-fence-recovery-worker", leaseMs: 120_000 },
    handler: async (lease, heartbeat) => {
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: largeRiskFacts },
      });
      await production.handler(lease, heartbeat);
    },
    relay: { aggregates: [] },
  });
}

describeIntegration(
  "production cross-fence gate and commit recovery",
  () => {
    let fixture: EngineeringQualificationFixture | null = null;

    afterEach(async () => {
      await fixture?.drop();
      fixture = null;
    });

    async function approvedLease(id: string) {
      fixture = await createEngineeringQualificationFixture({ id });
      const approvalId = `${id}-approval`;
      await fixture.grantWriteApproval({
        approvalId,
        processClass: "LARGE_OR_HIGH_RISK",
      });
      return fixture.claimImplementer({ reason: "engineering_approval", approvalId });
    }

    it("rebuilds the outer EvidenceBundle from the exact durable gate receipt without command replay", async () => {
      const lease = await approvedLease("cross-fence-gate-receipt");
      const transport = transportFor(fixture!);
      const crashingControl = new CrashOuterArtifactOnce("EvidenceBundle");
      const first = fixture!.makeProduction(lease, {
        transport,
        policy: { riskFacts: largeRiskFacts },
        controlPlane: crashingControl,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/u,
      );
      expect(crashingControl.crashed).toBe(true);
      const receipt = await fixture!.db.query<{ completion_id: string }>(
        `SELECT c.completion_id FROM job_completions c JOIN engineering_operations o
           ON o.intent_id=c.intent_id
          WHERE o.operation_kind='engineering.verification.gate'`,
      );
      expect(receipt.rows).toHaveLength(1);
      await expire(lease, fixture!);

      await expect(schedulerFor(fixture!, transport).tick()).resolves.toMatchObject({
        claimedJobId: lease.jobId,
        jobOutcome: "SUCCEEDED",
      });
      const durable = await fixture!.db.query<{
        inner_operations: string;
        inner_completions: string;
        original_completion_count: string;
        bundles: string;
        local_commits: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations
             WHERE operation_kind='engineering.verification.gate') AS inner_operations,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate') AS inner_completions,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate'
               AND c.completion_id=$2) AS original_completion_count,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='EvidenceBundle') AS bundles,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS local_commits`,
        [fixture!.ids.runId, receipt.rows[0]!.completion_id],
      );
      expect(durable.rows[0]).toEqual({
        inner_operations: "3",
        inner_completions: "3",
        original_completion_count: "1",
        bundles: "3",
        local_commits: "1",
      });
    });

    it("recovers LOCAL_COMMIT by observing exact Git state and never creates a second commit", async () => {
      const lease = await approvedLease("cross-fence-local-commit");
      const transport = transportFor(fixture!);
      const crashingControl = new CrashOuterArtifactOnce("LocalCommitReceipt");
      const first = fixture!.makeProduction(lease, {
        transport,
        policy: { riskFacts: largeRiskFacts },
        controlPlane: crashingControl,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/u,
      );
      expect(crashingControl.crashed).toBe(true);
      const workspacePath = join(
        fixture!.config.workspaceConfig.workspaceRoot,
        fixture!.ids.caseId,
        verticalSliceWorkspaceId(fixture!.ids.caseId),
      );
      expect(
        (
          await run("git", [
            "-C",
            workspacePath,
            "rev-list",
            "--count",
            `${fixture!.baseSha}..HEAD`,
          ])
        ).stdout.trim(),
      ).toBe("1");
      const callsBefore = transport.requests.length;
      await expire(lease, fixture!);

      await expect(schedulerFor(fixture!, transport).tick()).resolves.toMatchObject({
        claimedJobId: lease.jobId,
        jobOutcome: "SUCCEEDED",
      });
      expect(transport.requests).toHaveLength(callsBefore);
      expect(
        (
          await run("git", [
            "-C",
            workspacePath,
            "rev-list",
            "--count",
            `${fixture!.baseSha}..HEAD`,
          ])
        ).stdout.trim(),
      ).toBe("1");
      expect(
        await fixture!.db.query<{ commits: string; run_completions: string }>(
          `SELECT
             (SELECT count(*)::text FROM engineering_artifact_revisions
               WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits,
             (SELECT count(*)::text FROM run_completions
               WHERE run_id=$1 AND status='COMPLETED') AS run_completions`,
          [fixture!.ids.runId],
        ),
      ).toMatchObject({ rows: [{ commits: "1", run_completions: "1" }] });
    });

    it("terminalizes an inner STARTED gate without a receipt and dispatches no replacement command", async () => {
      const lease = await approvedLease("cross-fence-gate-unknown");
      await fixture!.db.query(`
        CREATE FUNCTION cross_fence_crash_inner_completion() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM engineering_operations
             WHERE intent_id=NEW.intent_id AND operation_kind='engineering.verification.gate'
          ) THEN
            RAISE EXCEPTION 'injected inner completion crash';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER cross_fence_crash_inner_completion
          BEFORE INSERT ON job_completions
          FOR EACH ROW EXECUTE FUNCTION cross_fence_crash_inner_completion();
      `);
      const transport = transportFor(fixture!);
      const first = fixture!.makeProduction(lease, {
        transport,
        policy: { riskFacts: largeRiskFacts },
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/u,
      );
      await fixture!.db.query("DROP TRIGGER cross_fence_crash_inner_completion ON job_completions");
      await expire(lease, fixture!);

      await expect(schedulerFor(fixture!, transport).tick()).resolves.toMatchObject({
        claimedJobId: null,
        jobOutcome: null,
      });
      expect(
        await fixture!.db.query<{
          inner_operations: string;
          inner_completions: string;
          bundles: string;
          terminal_recoveries: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM engineering_operations
               WHERE operation_kind='engineering.verification.gate') AS inner_operations,
             (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
               ON o.intent_id=c.intent_id
               WHERE o.operation_kind='engineering.verification.gate') AS inner_completions,
             (SELECT count(*)::text FROM engineering_artifact_revisions
               WHERE run_id=$1 AND artifact_kind='EvidenceBundle') AS bundles,
             (SELECT count(*)::text FROM engineering_recoveries
               WHERE run_id=$1 AND status='AMBIGUOUS') AS terminal_recoveries`,
          [fixture!.ids.runId],
        ),
      ).toMatchObject({
        rows: [
          {
            inner_operations: "1",
            inner_completions: "0",
            bundles: "0",
            terminal_recoveries: "1",
          },
        ],
      });
    });

    it("terminalizes an outer STARTED gate when the required inner operation is missing", async () => {
      const lease = await approvedLease("cross-fence-gate-missing");
      await fixture!.db.query(`
        CREATE FUNCTION cross_fence_crash_inner_intent() RETURNS trigger AS $$
        BEGIN
          IF NEW.operation_kind='engineering.verification.gate' THEN
            RAISE EXCEPTION 'injected crash before inner gate operation';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER cross_fence_crash_inner_intent
          BEFORE INSERT ON engineering_operations
          FOR EACH ROW EXECUTE FUNCTION cross_fence_crash_inner_intent();
      `);
      const transport = transportFor(fixture!);
      const first = fixture!.makeProduction(lease, {
        transport,
        policy: { riskFacts: largeRiskFacts },
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/u,
      );
      await fixture!.db.query(
        "DROP TRIGGER cross_fence_crash_inner_intent ON engineering_operations",
      );
      await expire(lease, fixture!);

      await expect(schedulerFor(fixture!, transport).tick()).resolves.toMatchObject({
        claimedJobId: null,
        jobOutcome: null,
      });
      expect(
        await fixture!.db.query<{
          inner_operations: string;
          bundles: string;
          terminal_recoveries: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM engineering_operations
               WHERE operation_kind='engineering.verification.gate') AS inner_operations,
             (SELECT count(*)::text FROM engineering_artifact_revisions
               WHERE run_id=$1 AND artifact_kind='EvidenceBundle') AS bundles,
             (SELECT count(*)::text FROM engineering_recoveries
               WHERE run_id=$1 AND status='AMBIGUOUS') AS terminal_recoveries`,
          [fixture!.ids.runId],
        ),
      ).toMatchObject({
        rows: [{ inner_operations: "0", bundles: "0", terminal_recoveries: "1" }],
      });
    });
  },
  available,
);
