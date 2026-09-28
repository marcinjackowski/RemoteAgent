import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { EngineeringStage } from "@remoteagent/contracts";
import type {
  RuntimeConfig,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeTransport,
} from "@remoteagent/model-runtime";
import {
  CaseRepository,
  EngineeringControlPlaneRepository,
  productionRuntime,
  WorkUnitRepository,
} from "@remoteagent/database";
import { afterEach, expect, it } from "vitest";

import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import {
  createEngineeringQualificationFixture,
  qualificationModel,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";

const available = await ensurePostgres();
const run = promisify(execFile);
const smallRiskFacts = Object.freeze({
  authority: "SERVER_OWNED" as const,
  security_or_policy: false,
  migration: false,
  irreversible_side_effect: false,
  broad_public_contract_change: false,
  multi_module: false,
  new_architecture: false,
  deterministic_oracle: true,
  user_data: false,
  concurrency: false,
  external_side_effect: false,
});

function gateBinding(fixture: EngineeringQualificationFixture) {
  return {
    caseId: fixture.ids.caseId,
    workUnitId: fixture.ids.workUnitId,
    runId: fixture.ids.runId,
    checkpointRevision: 0,
    stage: EngineeringStage.GATE_EXECUTION,
    attempt: 1,
  } as const;
}

function identityFor(fixture: EngineeringQualificationFixture, objective: string) {
  return {
    unit: {
      workUnit: {
        schema_version: 1 as const,
        work_unit_id: fixture.ids.workUnitId,
        case_id: fixture.ids.caseId,
        role: "IMPLEMENTER" as const,
        status: "DISPATCHED" as const,
        objective,
        authoritative_scope: {
          connection_ids: [],
          repo_allowlist: [fixture.ids.repositoryId],
          can_write_workspace: true,
        },
        run_id: fixture.ids.runId,
        created_at: "2026-08-26T00:00:00.000Z",
        updated_at: "2026-08-26T00:00:00.000Z",
      },
    },
    run: { runId: fixture.ids.runId, checkpointRevision: 0 },
  };
}

class RejectingTransport implements RuntimeTransport {
  public calls = 0;
  public async converse(
    _request: RuntimeRequest,
    _config: RuntimeConfig,
  ): Promise<RuntimeResponse> {
    this.calls += 1;
    return { model: qualificationModel, content: [] };
  }
}

class BarrierTransport implements RuntimeTransport {
  public readonly entered: Promise<void>;
  readonly #release: Promise<void>;
  #markEntered!: () => void;
  public constructor(release: Promise<void>) {
    this.#release = release;
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
  }
  public async converse(): Promise<RuntimeResponse> {
    this.#markEntered();
    await this.#release;
    throw new Error("qualification barrier released");
  }
}

class LeaseReplayTransport implements RuntimeTransport {
  public calls = 0;
  public readonly firstInvoked: Promise<void>;
  readonly #releaseFirst: Promise<void>;
  #markFirst!: () => void;
  public constructor(
    private readonly caseId: string,
    private readonly runId: string,
    releaseFirst: Promise<void>,
  ) {
    this.#releaseFirst = releaseFirst;
    this.firstInvoked = new Promise((resolve) => {
      this.#markFirst = resolve;
    });
  }
  public async converse(): Promise<RuntimeResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      this.#markFirst();
      await this.#releaseFirst;
    }
    return {
      model: qualificationModel,
      content: [
        {
          type: "json",
          value: {
            schema_version: 1,
            artifact_kind: "SystemDesign",
            case_id: this.caseId,
            run_id: this.runId,
            revision: 0,
            boundaries: ["worker", "durable ledger"],
            data: ["immutable intent"],
            api: ["recoverStage"],
            integrations: ["PostgreSQL"],
            invariants: ["one durable artifact", "one STARTED event"],
            architecture: "retry-safe stage behind a fencing barrier",
            components: ["SupervisorRuntime", "EngineeringRuntimePort"],
            interfaces: ["prepare", "start", "invoke"],
            data_flow: "intent to model to fenced artifact",
            risks: ["lease loss"],
            source_digest: sha("9"),
          },
        },
      ],
    };
  }
}

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

class OneSliceTransport implements RuntimeTransport {
  public calls = 0;
  public implementationCalls = 0;
  public planningCalls = 0;
  public reviewCalls = 0;
  #toolIssued = false;
  public constructor(
    private readonly caseId: string,
    private readonly runId: string,
  ) {}
  public async converse(request: RuntimeRequest): Promise<RuntimeResponse> {
    this.calls += 1;
    const name = request.outputSchema?.name;
    const common = {
      schema_version: 1,
      case_id: this.caseId,
      run_id: this.runId,
      revision: 0,
    };
    const json = (value: unknown): RuntimeResponse => ({
      model: qualificationModel,
      content: [{ type: "json", value: value as never }],
    });
    if (name === "EngineeringOutcomeContract_v1")
      return json({
        ...common,
        artifact_kind: "OutcomeContract",
        problem: "recover a crash",
        outcome: "durable evidence",
        non_goals: [],
        objective: "one slice",
        success_criteria: ["gate passes"],
        constraints: ["one repository"],
        process_class: "SMALL",
        source_digest: sha("1"),
      });
    if (name === "EngineeringSliceContract_v2") {
      this.planningCalls += 1;
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "SliceContract",
        slice_id: "slice-1",
        objective: "write one file",
        observable_result: "file is present",
        allowed_paths: ["src"],
        test_paths: ["src"],
        gate_ids: ["qualification"],
        inspection_method: "inspect durable evidence",
        stop_condition: "gate passes",
      });
    }
    if (name === "SliceImplementationReport_v1") {
      this.implementationCalls += 1;
      if (!this.#toolIssued) {
        this.#toolIssued = true;
        return {
          model: qualificationModel,
          content: [
            {
              type: "tool-use",
              id: "write-1",
              name: "write",
              input: {
                relative_path: "src/change.ts",
                content: "export const changed = true;\n",
              },
            },
          ],
        };
      }
      return json({ schema_version: 1, changed_files: ["src/change.ts"] });
    }
    if (name === "PreCommitReviewOutput_v1") {
      this.reviewCalls += 1;
      return json({ schema_version: 1, findings: [], lines_examined: 20 });
    }
    if (name === "EngineeringMemoryUpdate_v1")
      return json({
        ...common,
        artifact_kind: "MemoryUpdate",
        source_watermark: sha("4"),
        evidence_digests: [sha("5")],
        trust: "UNTRUSTED_DATA",
        authority: "MODEL_PROJECTION",
        completed_requirements: ["slice-1"],
        open_issues: [],
      });
    if (name === "EngineeringVerificationDecision_v1")
      return json({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "recovery-verified",
        rationale: "the recovered gate receipt remains exact and complete",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "recovery", status: "PASSED", evidence_digest: sha("6") },
        ],
        evidence_digest: sha("6"),
      });
    throw new Error(`unexpected schema before gate crash: ${String(name)}`);
  }
}

class CrashOuterGateArtifactOnce extends EngineeringControlPlaneRepository {
  public crashed = false;
  public override async appendArtifactRevision(
    ...args: Parameters<EngineeringControlPlaneRepository["appendArtifactRevision"]>
  ): ReturnType<EngineeringControlPlaneRepository["appendArtifactRevision"]> {
    const artifact = args[2].artifact;
    if (!this.crashed && artifact.artifact_kind === "EvidenceBundle") {
      this.crashed = true;
      throw new Error("injected crash after inner receipts before outer artifact");
    }
    return super.appendArtifactRevision(...args);
  }
}

class CrashAfterPlanningIntentOnce extends EngineeringControlPlaneRepository {
  public crashed = false;
  public override async bindOperationIntent(
    ...args: Parameters<EngineeringControlPlaneRepository["bindOperationIntent"]>
  ): ReturnType<EngineeringControlPlaneRepository["bindOperationIntent"]> {
    const operation = await super.bindOperationIntent(...args);
    if (!this.crashed && operation.stage === EngineeringStage.SLICE_PLANNING) {
      this.crashed = true;
      throw new Error("injected crash after durable planning intent");
    }
    return operation;
  }
}

class CrashOuterLocalCommitArtifactOnce extends EngineeringControlPlaneRepository {
  public crashed = false;
  public override async appendArtifactRevision(
    ...args: Parameters<EngineeringControlPlaneRepository["appendArtifactRevision"]>
  ): ReturnType<EngineeringControlPlaneRepository["appendArtifactRevision"]> {
    const artifact = args[2].artifact;
    if (!this.crashed && artifact.artifact_kind === "LocalCommitReceipt") {
      this.crashed = true;
      throw new Error("injected crash after local commit before outer artifact");
    }
    return super.appendArtifactRevision(...args);
  }
}

class CrashAfterDurableArtifactOnce extends EngineeringControlPlaneRepository {
  public crashed = false;
  public constructor(
    runtime: ConstructorParameters<typeof EngineeringControlPlaneRepository>[0],
    private readonly artifactKind: string,
  ) {
    super(runtime);
  }

  public override async appendArtifactRevision(
    ...args: Parameters<EngineeringControlPlaneRepository["appendArtifactRevision"]>
  ): ReturnType<EngineeringControlPlaneRepository["appendArtifactRevision"]> {
    const result = await super.appendArtifactRevision(...args);
    if (!this.crashed && args[2].artifact.artifact_kind === this.artifactKind) {
      this.crashed = true;
      throw new Error(`injected crash after durable ${this.artifactKind}`);
    }
    return result;
  }
}

class LeaseLostPlanningTransport extends OneSliceTransport {
  public readonly entered: Promise<void>;
  readonly #release: Promise<void>;
  #markEntered!: () => void;

  public constructor(caseId: string, runId: string, release: Promise<void>) {
    super(caseId, runId);
    this.#release = release;
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
  }

  public override async converse(request: RuntimeRequest): Promise<RuntimeResponse> {
    if (request.outputSchema?.name === "EngineeringSliceContract_v2") {
      this.#markEntered();
      await this.#release;
    }
    return super.converse(request);
  }
}

describeIntegration(
  "engineering qualification crash recovery",
  () => {
    let fixture: EngineeringQualificationFixture | undefined;
    afterEach(async () => fixture?.drop());

    it("enters the dedicated production gate recovery route without generic model replay", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "gate-recovery-route" });
      const lease = await fixture.claimImplementer();
      const transport = new RejectingTransport();
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      const binding = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.GATE_EXECUTION,
        attempt: 1,
      } as const;
      await first.open({
        unit: {
          workUnit: {
            schema_version: 1,
            work_unit_id: fixture.ids.workUnitId,
            case_id: fixture.ids.caseId,
            role: "IMPLEMENTER",
            status: "DISPATCHED",
            objective: "bounded recovery qualification",
            authoritative_scope: {
              connection_ids: [],
              repo_allowlist: [fixture.ids.repositoryId],
              can_write_workspace: true,
            },
            run_id: fixture.ids.runId,
            created_at: "2026-08-26T00:00:00.000Z",
            updated_at: "2026-08-26T00:00:00.000Z",
          },
        },
        run: { runId: fixture.ids.runId, checkpointRevision: 0 },
      });
      await first.prepareContext(binding);
      await first.commitStarted(binding);

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      await fresh.open({
        unit: {
          workUnit: {
            schema_version: 1,
            work_unit_id: fixture.ids.workUnitId,
            case_id: fixture.ids.caseId,
            role: "IMPLEMENTER",
            status: "DISPATCHED",
            objective: "bounded recovery qualification",
            authoritative_scope: {
              connection_ids: [],
              repo_allowlist: [fixture.ids.repositoryId],
              can_write_workspace: true,
            },
            run_id: fixture.ids.runId,
            created_at: "2026-08-26T00:00:00.000Z",
            updated_at: "2026-08-26T00:00:00.000Z",
          },
        },
        run: { runId: fixture.ids.runId, checkpointRevision: 0 },
      });
      await expect(fresh.recoverStage(binding)).rejects.toThrow(/SliceContract/);
      expect(transport.calls).toBe(0);
    });

    it("binds the gate deadline once and reuses the exact operation deadline on recovery", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "gate-recovery-deadline" });
      const lease = await fixture.claimImplementer();
      const transport = new RejectingTransport();
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      const binding = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.GATE_EXECUTION,
        attempt: 1,
      } as const;
      const identity = {
        unit: {
          workUnit: {
            schema_version: 1 as const,
            work_unit_id: fixture.ids.workUnitId,
            case_id: fixture.ids.caseId,
            role: "IMPLEMENTER" as const,
            status: "DISPATCHED" as const,
            objective: "bounded recovery qualification",
            authoritative_scope: {
              connection_ids: [],
              repo_allowlist: [fixture.ids.repositoryId],
              can_write_workspace: true,
            },
            run_id: fixture.ids.runId,
            created_at: "2026-08-26T00:00:00.000Z",
            updated_at: "2026-08-26T00:00:00.000Z",
          },
        },
        run: { runId: fixture.ids.runId, checkpointRevision: 0 },
      };
      await first.open(identity);
      await first.prepareContext(binding);
      await first.commitStarted(binding);
      const durable = await fixture.db.query<{
        deadline_at: Date;
        descriptor: Record<string, unknown>;
      }>(
        `SELECT o.deadline_at, i.descriptor
           FROM engineering_operations o JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id=$1 AND o.stage='GATE_EXECUTION'`,
        [fixture.ids.runId],
      );
      expect(durable.rows[0]!.descriptor.deadline_at).toBe(
        durable.rows[0]!.deadline_at.toISOString(),
      );
      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      await fresh.open(identity);
      await expect(fresh.recoverStage(binding)).rejects.toThrow(/SliceContract/);
      expect(transport.calls).toBe(0);
    });

    it("blocks a backdated run before recording a new STARTED stage", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "backdated-deadline" });
      await fixture.db.query(
        "UPDATE agent_runs SET created_at=now()-interval '1 hour' WHERE run_id=$1",
        [fixture.ids.runId],
      );
      const lease = await fixture.claimImplementer();
      const transport = new RejectingTransport();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        workflowDeadlineMs: 1,
      });
      await production.handler(lease, async () => undefined);
      const started = await fixture.db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM engineering_stage_events WHERE run_id=$1 AND event_type='STARTED'",
        [fixture.ids.runId],
      );
      expect(started.rows[0]!.count).toBe("0");
      expect(transport.calls).toBe(0);
    });

    it("marks an outer completion-only stage AMBIGUOUS through the full handler without replay", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "outer-completion-only" });
      const lease = await fixture.claimImplementer();
      const transport = new RejectingTransport();
      const seed = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      const binding = {
        ...gateBinding(fixture),
        stage: EngineeringStage.DISCOVERY,
      } as const;
      await seed.open(identityFor(fixture, "outer completion-only qualification"));
      await seed.prepareContext(binding);
      const operation = await fixture.db.query<{ intent_id: string }>(
        `SELECT intent_id FROM engineering_operations
          WHERE run_id=$1 AND stage='DISCOVERY' AND stage_attempt=1`,
        [fixture.ids.runId],
      );
      expect(operation.rows).toHaveLength(1);
      await fixture.jobs.recordCompletion(fixture.db, {
        intentId: operation.rows[0]!.intent_id,
        jobId: lease.jobId,
        outcome: "SUCCEEDED",
        receipt: { seeded_outer_completion_only: true },
        lease,
      });
      const before = await fixture.db.query<{
        starts: string;
        artifacts: string;
        completions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='DISCOVERY' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='DISCOVERY') AS artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='DISCOVERY') AS completions`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({ starts: "0", artifacts: "0", completions: "1" });

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await expect(fresh.handler(lease, async () => undefined)).rejects.toThrow(/ambiguous/u);

      expect(transport.calls).toBe(0);
      const after = await fixture.db.query<{
        starts: string;
        artifacts: string;
        completions: string;
        gate_operations: string;
        commits: string;
        workspaces: string;
        run_completions: string;
        safety_state: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='DISCOVERY' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='DISCOVERY') AS artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='DISCOVERY') AS completions,
           (SELECT count(*)::text FROM engineering_operations
             WHERE run_id=$1 AND stage='GATE_EXECUTION') AS gate_operations,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits,
           (SELECT count(*)::text FROM workspaces WHERE case_id=$2) AS workspaces,
           (SELECT count(*)::text FROM run_completions WHERE run_id=$1) AS run_completions,
           (SELECT safety_state FROM agent_runs WHERE run_id=$1) AS safety_state`,
        [fixture.ids.runId, fixture.ids.caseId],
      );
      expect(after.rows[0]).toEqual({
        starts: "0",
        artifacts: "0",
        completions: "1",
        gate_operations: "0",
        commits: "0",
        workspaces: "0",
        run_completions: "0",
        safety_state: "AMBIGUOUS",
      });
    });

    it("recovers an artifact-only planning stage through a fresh full handler without model replay", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "artifact-only-handler" });
      await fixture.db.query(`
        CREATE FUNCTION qualification_crash_planning_completion() RETURNS trigger AS $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM engineering_operations
             WHERE intent_id=NEW.intent_id AND stage='SLICE_PLANNING'
          ) THEN
            RAISE EXCEPTION 'injected planning completion crash';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER qualification_crash_planning_completion
          BEFORE INSERT ON job_completions
          FOR EACH ROW EXECUTE FUNCTION qualification_crash_planning_completion();
      `);
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      await fixture.db.query(
        "DROP TRIGGER qualification_crash_planning_completion ON job_completions",
      );
      await fixture.db.query("DROP FUNCTION qualification_crash_planning_completion()");
      const before = await fixture.db.query<{
        artifacts: string;
        completions: string;
        starts: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='SLICE_PLANNING') AS completions,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='SLICE_PLANNING' AND event_type='STARTED') AS starts`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({ artifacts: "1", completions: "0", starts: "1" });
      expect(transport.planningCalls).toBe(1);

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await fresh.handler(lease, async () => undefined);

      expect(transport.planningCalls).toBe(1);
      const after = await fixture.db.query<{
        artifacts: string;
        completions: string;
        starts: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='SLICE_PLANNING') AS completions,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='SLICE_PLANNING' AND event_type='STARTED') AS starts`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({ artifacts: "1", completions: "1", starts: "1" });
    });

    it("recovers an intent-only planning stage through the full handler before invoking the model", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "intent-only-handler" });
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const control = new CrashAfterPlanningIntentOnce(productionRuntime());
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(control.crashed).toBe(true);
      const before = await fixture.db.query<{ intents: string; starts: string; artifacts: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS intents,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='SLICE_PLANNING' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS artifacts`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({ intents: "1", starts: "0", artifacts: "0" });
      expect(transport.planningCalls).toBe(0);

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await fresh.handler(lease, async () => undefined);

      expect(transport.planningCalls).toBe(1);
      const after = await fixture.db.query<{ intents: string; starts: string; artifacts: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS intents,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='SLICE_PLANNING' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS artifacts`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({ intents: "1", starts: "1", artifacts: "1" });
    });

    it("recovers after a durable implementation receipt without repeating the side effect", async () => {
      fixture = await createEngineeringQualificationFixture({
        id: "implementation-receipt-recovery",
      });
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const control = new CrashAfterDurableArtifactOnce(
        productionRuntime(),
        "SliceImplementationReceipt",
      );
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(control.crashed).toBe(true);
      const implementationCalls = transport.implementationCalls;
      const before = await fixture.db.query<{ receipts: string; commits: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='SliceImplementationReceipt') AS receipts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({ receipts: "1", commits: "0" });

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await fresh.handler(lease, async () => undefined);
      expect(transport.implementationCalls).toBe(implementationCalls);
      const after = await fixture.db.query<{ receipts: string; commits: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='SliceImplementationReceipt') AS receipts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({ receipts: "1", commits: "1" });
    });

    it("recovers after a durable review decision without repeating review", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "review-decision-recovery" });
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const control = new CrashAfterDurableArtifactOnce(productionRuntime(), "ReviewDecision");
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(control.crashed).toBe(true);
      const reviewCalls = transport.reviewCalls;
      const before = await fixture.db.query<{ reviews: string; commits: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='ReviewDecision') AS reviews,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({ reviews: "1", commits: "0" });

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await fresh.handler(lease, async () => undefined);
      expect(transport.reviewCalls).toBe(reviewCalls);
      const after = await fixture.db.query<{ reviews: string; commits: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='ReviewDecision') AS reviews,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({ reviews: "1", commits: "1" });
    });

    it("re-enters with a fresh handler under the same current lease after the outer artifact append fails", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "inner-receipt-recovery" });
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const control = new CrashOuterGateArtifactOnce(productionRuntime());
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });
      await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(control.crashed).toBe(true);
      const before = await fixture.db.query<{
        inner_started: string;
        inner_completed: string;
        outer_artifacts: string;
        completion_id: string;
        outer_safety_state: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations
             WHERE operation_kind='engineering.verification.gate') AS inner_started,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate') AS inner_completed,
           (SELECT c.completion_id FROM job_completions c JOIN engineering_operations o ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate') AS completion_id,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='GATE_EXECUTION') AS outer_artifacts,
           (SELECT safety_state FROM agent_runs WHERE run_id=$1) AS outer_safety_state`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({
        inner_started: "1",
        inner_completed: "1",
        outer_artifacts: "0",
        completion_id: expect.any(String),
        outer_safety_state: "STARTED",
      });
      const implementationCalls = transport.implementationCalls;
      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await fresh.handler(lease, async () => undefined);
      expect(transport.implementationCalls).toBe(implementationCalls);
      const after = await fixture.db.query<{
        inner_started: string;
        inner_completed: string;
        outer_artifacts: string;
        completion_id: string;
        outer_safety_state: string;
        run_completions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations
             WHERE operation_kind='engineering.verification.gate') AS inner_started,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate') AS inner_completed,
           (SELECT c.completion_id FROM job_completions c JOIN engineering_operations o ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate') AS completion_id,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='GATE_EXECUTION') AS outer_artifacts,
           (SELECT safety_state FROM agent_runs WHERE run_id=$1) AS outer_safety_state,
           (SELECT count(*)::text FROM run_completions WHERE run_id=$1) AS run_completions`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({
        inner_started: "1",
        inner_completed: "1",
        outer_artifacts: "1",
        completion_id: before.rows[0]!.completion_id,
        outer_safety_state: "SUCCEEDED",
        run_completions: "1",
      });
    });

    it("recovers LOCAL_COMMIT by exact HEAD reconciliation through a fresh full handler", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "local-commit-handler" });
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const control = new CrashOuterLocalCommitArtifactOnce(productionRuntime());
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(control.crashed).toBe(true);
      const workspacePath = join(
        fixture.config.workspaceConfig.workspaceRoot,
        fixture.ids.caseId,
        verticalSliceWorkspaceId(fixture.ids.caseId),
      );
      expect(
        (
          await run("git", ["-C", workspacePath, "rev-list", "--count", `${fixture.baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");
      const before = await fixture.db.query<{
        artifacts: string;
        starts: string;
        completions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='LOCAL_COMMIT') AS artifacts,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='LOCAL_COMMIT' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='LOCAL_COMMIT') AS completions`,
        [fixture.ids.runId],
      );
      expect(before.rows[0]).toEqual({ artifacts: "0", starts: "1", completions: "0" });
      const callsBeforeRecovery = transport.calls;

      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await fresh.handler(lease, async () => undefined);

      expect(transport.calls).toBe(callsBeforeRecovery);
      expect(
        (
          await run("git", ["-C", workspacePath, "rev-list", "--count", `${fixture.baseSha}..HEAD`])
        ).stdout.trim(),
      ).toBe("1");
      const after = await fixture.db.query<{
        artifacts: string;
        starts: string;
        completions: string;
        run_completions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='LOCAL_COMMIT') AS artifacts,
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='LOCAL_COMMIT' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='LOCAL_COMMIT') AS completions,
           (SELECT count(*)::text FROM run_completions WHERE run_id=$1) AS run_completions`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({
        artifacts: "1",
        starts: "1",
        completions: "1",
        run_completions: "1",
      });
    });

    it("moves lease-lost partial gate evidence to RECONCILING without cross-fence writes", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "gate-lease-reconciliation" });
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const control = new CrashOuterGateArtifactOnce(productionRuntime());
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });
      await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      const before = await fixture.db.query<{ completion_id: string }>(
        `SELECT c.completion_id FROM job_completions c JOIN engineering_operations o
           ON o.intent_id=c.intent_id
          WHERE o.operation_kind='engineering.verification.gate'`,
      );
      expect(before.rows).toHaveLength(1);
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      expect((await fixture.jobs.reapExpired(fixture.db)).reconciling).toEqual([lease.jobId]);
      expect(
        await fixture.jobs.claim(fixture.db, {
          owner: "unsafe-cross-fence-contender",
          leaseMs: 120_000,
        }),
      ).toBeNull();
      const stale = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      await stale.open(identityFor(fixture, "stale partial gate"));
      await expect(stale.recoverStage(gateBinding(fixture))).rejects.toThrow();
      const after = await fixture.db.query<{
        completion_id: string;
        outer_artifacts: string;
        outer_completions: string;
      }>(
        `SELECT
           (SELECT c.completion_id FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.operation_kind='engineering.verification.gate') AS completion_id,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='GATE_EXECUTION') AS outer_artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.operation_kind='engineering.stage.gate_execution') AS outer_completions`,
        [fixture.ids.runId],
      );
      expect(after.rows[0]).toEqual({
        completion_id: before.rows[0]!.completion_id,
        outer_artifacts: "0",
        outer_completions: "0",
      });
    });

    it("keeps the outer gate AMBIGUOUS when an inner gate is STARTED without a receipt", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "inner-started-ambiguous" });
      await fixture.db.query(`
        CREATE FUNCTION qualification_crash_inner_completion() RETURNS trigger AS $$
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
        CREATE TRIGGER qualification_crash_inner_completion
          BEFORE INSERT ON job_completions
          FOR EACH ROW EXECUTE FUNCTION qualification_crash_inner_completion();
      `);
      const lease = await fixture.claimImplementer();
      const transport = new OneSliceTransport(fixture.ids.caseId, fixture.ids.runId);
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      await fixture.db.query(
        "DROP TRIGGER qualification_crash_inner_completion ON job_completions",
      );
      const state = await fixture.db.query<{ started: string; completed: string }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_operations
             WHERE operation_kind='engineering.verification.gate') AS started,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id WHERE o.operation_kind='engineering.verification.gate') AS completed`,
      );
      expect(state.rows[0]).toEqual({ started: "1", completed: "0" });
      expect(
        (
          await fixture.db.query<{ safety_state: string }>(
            "SELECT safety_state FROM agent_runs WHERE run_id=$1",
            [fixture.ids.runId],
          )
        ).rows[0]!.safety_state,
      ).toBe("STARTED");
      const implementationCalls = transport.implementationCalls;
      const durableControl = new EngineeringControlPlaneRepository(productionRuntime());
      const projection = await durableControl.prepareResume(fixture.db, {
        runId: fixture.ids.runId,
      });
      expect(
        (
          await durableControl.requestCancellation(fixture.db, {
            actionId: `${fixture.ids.runId}-cancel`,
            operationId: projection.operation_id,
            actorId: fixture.ids.ownerId,
            reason: "qualification cancellation after unknown gate write",
            expectedProjectionDigest: projection.projection_digest,
          })
        ).plan.classification,
      ).toBe("AMBIGUOUS");
      await fixture.db.query("DELETE FROM engineering_run_projections WHERE run_id=$1", [
        fixture.ids.runId,
      ]);
      await fixture.db.query(
        "UPDATE agent_runs SET created_at=now()-interval '1 hour' WHERE run_id=$1",
        [fixture.ids.runId],
      );
      const freshProduction = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        workflowDeadlineMs: 1,
      });
      await expect(freshProduction.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(transport.implementationCalls).toBe(implementationCalls);
      const outer = await fixture.db.query<{
        artifacts: string;
        inner_started: string;
        inner_completed: string;
        safety_state: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='GATE_EXECUTION') AS artifacts,
           (SELECT count(*)::text FROM engineering_operations
             WHERE operation_kind='engineering.verification.gate') AS inner_started,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
             WHERE o.operation_kind='engineering.verification.gate') AS inner_completed,
           (SELECT safety_state FROM agent_runs WHERE run_id=$1) AS safety_state`,
        [fixture.ids.runId],
      );
      expect(outer.rows[0]).toEqual({
        artifacts: "0",
        inner_started: "1",
        inner_completed: "0",
        safety_state: "AMBIGUOUS",
      });
    });

    it("fences a stale post-invoke model writer and stops the uncertain job in RECONCILING", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "lease-reclaim" });
      const staleLease = await fixture.claimImplementer();
      let releaseFirst!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const transport = new LeaseReplayTransport(fixture.ids.caseId, fixture.ids.runId, release);
      const policy = {
        riskFacts: { ...smallRiskFacts, multi_module: true },
        proposedProcessClass: "MEDIUM" as const,
      };
      const stale = fixture.makeProduction(staleLease, { transport, policy }).port;
      await stale.open(identityFor(fixture, "lease reclaim"));
      const binding = {
        ...gateBinding(fixture),
        stage: EngineeringStage.SYSTEM_DESIGN,
      } as const;
      const staleContext = await stale.prepareContext(binding);
      await stale.commitStarted(binding);
      const staleResult = stale
        .invokeAndRecord({
          binding,
          context: staleContext,
          definition: {
            role: "PRODUCT_MANAGER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await transport.firstInvoked;
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [staleLease.jobId],
      );
      const reaped = await fixture.jobs.reapExpired(fixture.db);
      expect(reaped).toEqual({ requeued: [], reconciling: [staleLease.jobId], succeeded: [] });
      expect(
        await fixture.jobs.claim(fixture.db, {
          owner: "fresh-model-writer",
          leaseMs: 120_000,
        }),
      ).toBeNull();
      releaseFirst();
      expect(await staleResult).toMatchObject({ name: expect.stringMatching(/Fenc|Stale/) });
      expect(transport.calls).toBe(1);
      const ledger = await fixture.db.query<{
        starts: string;
        artifacts: string;
        completions: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='SYSTEM_DESIGN' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='SYSTEM_DESIGN') AS artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id WHERE o.run_id=$1 AND o.stage='SYSTEM_DESIGN') AS completions`,
        [fixture.ids.runId],
      );
      expect(ledger.rows[0]).toEqual({ starts: "1", artifacts: "0", completions: "0" });
    });

    it("routes post-invoke lease loss through the full handler without a cross-fence write", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "handler-post-invoke-lease" });
      const lease = await fixture.claimImplementer();
      let releaseModel!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      const transport = new LeaseLostPlanningTransport(
        fixture.ids.caseId,
        fixture.ids.runId,
        release,
      );
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      const handlerResult = production
        .handler(lease, async () => undefined)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await transport.entered;
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [lease.jobId],
      );
      expect(await fixture.jobs.reapExpired(fixture.db)).toEqual({
        requeued: [],
        reconciling: [lease.jobId],
        succeeded: [],
      });
      releaseModel();
      expect(await handlerResult).toMatchObject({
        message: expect.stringMatching(/did not complete/),
      });
      expect(transport.planningCalls).toBe(1);
      const durable = await fixture.db.query<{
        starts: string;
        artifacts: string;
        completions: string;
        workspaces: string;
        commits: string;
        job_status: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM engineering_stage_events
             WHERE run_id=$1 AND stage='SLICE_PLANNING' AND event_type='STARTED') AS starts,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND stage='SLICE_PLANNING') AS artifacts,
           (SELECT count(*)::text FROM job_completions c JOIN engineering_operations o
             ON o.intent_id=c.intent_id
            WHERE o.run_id=$1 AND o.stage='SLICE_PLANNING') AS completions,
           (SELECT count(*)::text FROM workspaces WHERE case_id=$2) AS workspaces,
           (SELECT count(*)::text FROM engineering_artifact_revisions
             WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits,
           (SELECT status FROM jobs WHERE job_id=$3) AS job_status`,
        [fixture.ids.runId, fixture.ids.caseId, lease.jobId],
      );
      expect(durable.rows[0]).toEqual({
        starts: "1",
        artifacts: "0",
        completions: "0",
        workspaces: "0",
        commits: "0",
        job_status: "RECONCILING",
      });
    });

    it("reclaims a lease lost before intent while the stale writer cannot bind", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "lease-reclaim-clean" });
      const staleLease = await fixture.claimImplementer();
      await fixture.db.query(
        "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE job_id=$1",
        [staleLease.jobId],
      );
      expect((await fixture.jobs.reapExpired(fixture.db)).requeued).toEqual([staleLease.jobId]);
      const freshLease = await fixture.jobs.claim(fixture.db, {
        owner: "fresh-clean-writer",
        leaseMs: 120_000,
      });
      expect(freshLease).toMatchObject({ jobId: staleLease.jobId });
      if (freshLease === null) throw new Error("expected clean reclaimed lease");
      const transport = new RejectingTransport();
      const stale = fixture.makeProduction(staleLease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      await stale.open(identityFor(fixture, "clean reclaim"));
      const discovery = { ...gateBinding(fixture), stage: EngineeringStage.DISCOVERY } as const;
      await expect(stale.prepareContext(discovery)).rejects.toThrow();
      const fresh = fixture.makeProduction(freshLease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      }).port;
      await fresh.open(identityFor(fixture, "clean reclaim"));
      expect(await fresh.recoverStage(discovery)).toEqual({ status: "NOT_STARTED" });
      const context = await fresh.prepareContext(discovery);
      await fresh.commitStarted(discovery);
      await expect(
        fresh.invokeAndRecord({
          binding: discovery,
          context,
          definition: {
            role: "PLANNER",
            input_artifacts: [],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).resolves.toMatchObject({ status: "COMPLETED" });
      expect(transport.calls).toBe(0);
    });

    it("prevents a second same-case writer while two production handlers for different cases overlap", async () => {
      fixture = await createEngineeringQualificationFixture({ id: "writer-isolation" });
      const firstLease = await fixture.claimImplementer();
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const firstTransport = new BarrierTransport(barrier);
      const firstProduction = fixture.makeProduction(firstLease, {
        transport: firstTransport,
        policy: { riskFacts: smallRiskFacts },
      });
      const firstRun = firstProduction
        .handler(firstLease, async () => undefined)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await firstTransport.entered;

      await fixture.jobs.enqueue(fixture.db, {
        caseId: fixture.ids.caseId,
        jobType: "agent.implementer",
        payload: {
          caseId: fixture.ids.caseId,
          workUnitId: fixture.ids.workUnitId,
          runId: fixture.ids.runId,
        },
      });
      expect(
        await fixture.jobs.claim(fixture.db, {
          owner: "same-case-contender",
          leaseMs: 120_000,
        }),
      ).toBeNull();

      const secondCaseId = `${fixture.ids.caseId}-parallel`;
      const secondUnitId = `${fixture.ids.workUnitId}-parallel`;
      const secondRunId = `${fixture.ids.runId}-parallel`;
      await new CaseRepository().insert(fixture.db, {
        caseId: secondCaseId,
        ownerId: fixture.ids.ownerId,
        status: "IMPLEMENTING",
        integrationScope: { providers: ["jira"], connection_ids: [fixture.ids.connectionId] },
        discordThreadId: `${secondCaseId}-thread`,
      });
      await fixture.db.query(
        `INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint)
         VALUES ($1,$2,0,$3::jsonb)`,
        [secondCaseId, fixture.ids.ownerId, JSON.stringify(makeCheckpoint(secondCaseId, 0))],
      );
      const units = new WorkUnitRepository();
      await units.insert(fixture.db, {
        workUnitId: secondUnitId,
        caseId: secondCaseId,
        role: "IMPLEMENTER",
        objective: "parallel case qualification",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: [fixture.ids.repositoryId],
          can_write_workspace: true,
        },
      });
      await units.claim(fixture.db, {
        workUnitId: secondUnitId,
        runId: secondRunId,
        checkpointRevision: 0,
      });
      await fixture.jobs.enqueue(fixture.db, {
        caseId: secondCaseId,
        jobType: "agent.implementer",
        payload: { caseId: secondCaseId, workUnitId: secondUnitId, runId: secondRunId },
      });
      const secondLease = await fixture.jobs.claim(fixture.db, {
        owner: "parallel-case-writer",
        leaseMs: 120_000,
      });
      expect(secondLease).toMatchObject({ caseId: secondCaseId });
      if (secondLease === null) throw new Error("different case should be claimable");
      const secondTransport = new BarrierTransport(barrier);
      const secondProduction = fixture.makeProduction(secondLease, {
        transport: secondTransport,
        policy: { riskFacts: smallRiskFacts },
      });
      const secondRun = secondProduction
        .handler(secondLease, async () => undefined)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await secondTransport.entered;
      const active = await fixture.db.query<{ case_id: string }>(
        "SELECT case_id FROM jobs WHERE status='LEASED' ORDER BY case_id",
      );
      expect(active.rows.map(({ case_id }) => case_id)).toEqual([fixture.ids.caseId, secondCaseId]);
      const started = await fixture.db.query<{ case_id: string }>(
        `SELECT DISTINCT case_id
           FROM engineering_stage_events
          WHERE event_type='STARTED' AND case_id IN ($1,$2)
          ORDER BY case_id`,
        [fixture.ids.caseId, secondCaseId],
      );
      expect(started.rows.map(({ case_id }) => case_id)).toEqual([
        fixture.ids.caseId,
        secondCaseId,
      ]);
      releaseBarrier();
      expect(await firstRun).toMatchObject({ message: expect.stringMatching(/did not complete/) });
      expect(await secondRun).toMatchObject({ message: expect.stringMatching(/did not complete/) });
    });
  },
  available,
);
