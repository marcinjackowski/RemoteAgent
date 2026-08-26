import { afterEach, beforeEach, expect, it } from "vitest";

import {
  engineeringArtifact,
  engineeringContextManifest,
  EngineeringStage,
  TrustLevel,
  canonicalDigest,
  type EngineeringArtifact,
  type WorkUnit,
} from "@remoteagent/contracts";
import { FakeTransport, createRuntimeConfig } from "@remoteagent/bedrock-runtime";
import {
  CaseRepository,
  ConnectionRepository,
  JobStore,
  OwnerRepository,
  WorkUnitRepository,
  productionRuntime,
  type Database,
} from "@remoteagent/database";
import { MetricName, MetricRegistry, StructuredLogger } from "@remoteagent/observability";

import { makeCheckpoint } from "../../../packages/database/test/fixtures.js";
import { createTestDatabase } from "../../../packages/database/test/harness.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import type { CompiledRoleContext } from "../src/context.js";
import {
  createBedrockEngineeringStageExecutor,
  createPostgresEngineeringRuntimePort,
  engineeringAuthorizationFromLease,
  type EngineeringStageExecutor,
} from "../src/engineering-workflow.js";
import { createWorkerHandlers } from "../src/handlers.js";
import { WorkerPersistence } from "../src/persistence.js";

const available = await ensurePostgres();
const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
const runtime = productionRuntime();

function manifest(stage: EngineeringStage, revision = 0) {
  const value = engineeringContextManifest.parse({
    schema_version: 1,
    artifact_kind: "ContextManifest",
    case_id: "case-1",
    run_id: "run-1",
    revision,
    authority: "SERVER_OWNED",
    sources: [
      {
        source_id: `source-${stage}`,
        kind: "RAW_EVIDENCE",
        ref: `source-${stage}`,
        revision: 0,
        observed_at: "2026-08-26T00:00:00.000Z",
        digest: sha("a"),
        trust: TrustLevel.UNTRUSTED_DATA,
        freshness: "pinned to run",
        inclusion_reason: "stage policy",
        byte_budget: 64,
        full_artifact_ref: `source-${stage}`,
      },
    ],
    total_byte_budget: 1024,
  });
  return {
    packet: `packet for ${stage}`,
    packetBytes: 32,
    estimatedInputTokens: 8,
    cacheState: "NOT_OBSERVED",
    snapshotDigest: canonicalDigest({ stage, revision }),
    compiled: { stage, manifest: value } as CompiledRoleContext["compiled"],
  } as CompiledRoleContext;
}

function modelArtifact(stage: EngineeringStage): EngineeringArtifact {
  const common = { schema_version: 1, case_id: "case-1", run_id: "run-1", revision: 0 };
  switch (stage) {
    case EngineeringStage.OUTCOME_DEFINITION:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "OutcomeContract",
        problem: "bounded problem",
        outcome: "verified outcome",
        non_goals: [],
        objective: "bounded engineering workflow",
        success_criteria: ["all gates pass"],
        constraints: ["no workspace writes in RA-041"],
        process_class: "LARGE_OR_HIGH_RISK",
        source_digest: sha("7"),
      });
    case EngineeringStage.SYSTEM_DESIGN:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "SystemDesign",
        boundaries: ["worker to durable control plane"],
        data: ["strict stage artifacts"],
        api: ["single-stage port"],
        integrations: ["PostgreSQL"],
        invariants: ["SupervisorRuntime is the sole driver"],
        architecture: "one runtime with a durable stage port",
        components: ["SupervisorRuntime", "EngineeringRuntimePort"],
        interfaces: ["recover, prepare, start, invoke-and-record"],
        data_flow: "context to stage to durable artifact",
        risks: [],
        source_digest: sha("7"),
      });
    case EngineeringStage.PROGRAM_DESIGN:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "ProgramDesign",
        call_flow: ["handler -> runtime -> port"],
        file_tree_delta: ["apps/agent-worker/src/engineering-workflow.ts"],
        key_types_and_signatures: ["EngineeringRuntimePort.open(): session"],
        uncertainty_review: ["none"],
        expected_tests: ["real PG workflow"],
        slice_order: ["slice-1"],
        source_digest: sha("7"),
      });
    case EngineeringStage.DESIGN_APPROVAL:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "DesignDecision",
        decision_id: "design-review-1",
        rationale: "all required designs are durable",
        decision: "APPROVE",
        artifact_digest: sha("8"),
        findings: [],
        required_changes: [],
      });
    case EngineeringStage.SLICE_PLANNING:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "SliceContract",
        slice_id: "slice-1",
        objective: "bounded slice",
        observable_result: "one observable result",
        allowed_paths: ["apps/agent-worker/src"],
        gate_ids: ["gate-1"],
        inspection_method: "inspect the durable receipt",
        stop_condition: "receipt is confirmed",
      });
    case EngineeringStage.SLICE_REVIEW:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "ReviewDecision",
        decision_id: "review-1",
        rationale: "evidence is sufficient",
        decision: "PASS",
        findings: [],
        reviewed_digest: sha("b"),
      });
    case EngineeringStage.MEMORY_PROJECTION:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "MemoryUpdate",
        source_watermark: sha("c"),
        evidence_digests: [sha("d")],
        trust: TrustLevel.UNTRUSTED_DATA,
        authority: "MODEL_PROJECTION",
        completed_requirements: ["requirement-1"],
        open_issues: [],
      });
    case EngineeringStage.FINAL_VERIFICATION:
      return engineeringArtifact.parse({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "verification-1",
        rationale: "all evidence is confirmed",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "criterion-1", status: "PASSED", evidence_digest: sha("d") },
        ],
        evidence_digest: sha("d"),
      });
    default:
      throw new Error(`unexpected model stage ${stage}`);
  }
}

function systemArtifact(stage: EngineeringStage): EngineeringArtifact {
  const common = { schema_version: 1, case_id: "case-1", run_id: "run-1", revision: 0 };
  if (stage === EngineeringStage.GATE_EXECUTION) {
    return engineeringArtifact.parse({
      ...common,
      artifact_kind: "EvidenceBundle",
      authority: "SERVER_OWNED",
      tree_digest: sha("e"),
      config_digests: [sha("f")],
      command_receipts: ["receipt-1"],
      diff_digest: sha("1"),
      review_findings: [],
      decisions: [],
      items: [
        {
          kind: "no-write-test",
          digest: sha("2"),
          summary: "fake gate",
          trust: TrustLevel.TRUSTED,
        },
      ],
      context_digest: sha("3"),
      test_first_evidence: [],
    });
  }
  return engineeringArtifact.parse({
    ...common,
    artifact_kind: "EngineeringPhase",
    stage,
    process_class: "SMALL",
    checkpoint_revision: 0,
    stage_attempt: 1,
    active_slice_id: "slice-1",
    context_manifest_digest: sha("4"),
    artifact_digests: [],
  });
}

function runtimeIdentity() {
  const workUnit: WorkUnit = {
    schema_version: 1,
    work_unit_id: "unit-1",
    case_id: "case-1",
    role: "IMPLEMENTER",
    status: "DISPATCHED",
    objective: "bounded engineering workflow",
    authoritative_scope: {
      connection_ids: [],
      repo_allowlist: ["repo-1"],
      can_write_workspace: true,
    },
    run_id: "run-1",
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
  };
  return {
    unit: { workUnit },
    run: { runId: "run-1", checkpointRevision: 0 },
  } as const;
}

it("derives an owner grant only from an exact causal decision-answer lease", () => {
  const baseLease = {
    jobId: "job-1",
    caseId: "case-1",
    jobType: "agent.implementer",
    payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
    provider: null,
    serializationKey: "case-1",
    attempts: 0,
    maxAttempts: 3,
    fencingToken: 1,
    leaseExpiresAtMs: Date.now() + 30_000,
    leaseOwner: "worker-1",
  } as const;
  expect(engineeringAuthorizationFromLease(baseLease)).toBeUndefined();
  expect(
    engineeringAuthorizationFromLease({
      ...baseLease,
      payload: {
        ...baseLease.payload,
        reason: "decision_answer",
        decisionId: "decision-1",
        checkpointRevision: 4,
      },
    }),
  ).toEqual({
    authority: "OWNER_DECISION",
    authorizationId: "decision-1",
    checkpointRevision: 4,
  });
  expect(() =>
    engineeringAuthorizationFromLease({
      ...baseLease,
      payload: { ...baseLease.payload, reason: "decision_answer", checkpointRevision: 4 },
    }),
  ).toThrow(/authorization binding/);
});

describeIntegration(
  "worker EngineeringRuntimePort",
  () => {
    let db: Database;
    let drop: () => Promise<void>;

    beforeEach(async () => {
      const created = await createTestDatabase();
      db = created.db;
      drop = created.drop;
      await new OwnerRepository().insert(db, { ownerId: "owner-1", displayName: "owner" });
      await new ConnectionRepository().insert(db, {
        connectionId: "connection-1",
        ownerId: "owner-1",
        provider: "jira",
        displayName: "jira",
      });
      await new CaseRepository().insert(db, {
        caseId: "case-1",
        ownerId: "owner-1",
        status: "IMPLEMENTING",
        integrationScope: { providers: ["jira"], connection_ids: ["connection-1"] },
        discordThreadId: "thread-1",
      });
      await db.query(
        "INSERT INTO case_checkpoints (case_id, owner_id, revision, checkpoint) VALUES ('case-1','owner-1',0,$1::jsonb)",
        [JSON.stringify(makeCheckpoint("case-1", 0))],
      );
      const units = new WorkUnitRepository();
      await units.insert(db, {
        workUnitId: "unit-1",
        caseId: "case-1",
        role: "IMPLEMENTER",
        objective: "bounded engineering workflow",
        authoritativeScope: {
          connection_ids: [],
          repo_allowlist: ["repo-1"],
          can_write_workspace: true,
        },
      });
      await units.claim(db, { workUnitId: "unit-1", runId: "run-1", checkpointRevision: 0 });
    });

    afterEach(async () => drop());

    it("runs the production handler through PG intent/STARTED/artifact boundaries", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const calls: EngineeringStage[] = [];
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => {
          calls.push(binding.stage);
          return { kind: "ARTIFACT", artifact: modelArtifact(binding.stage), modelCalls: 1 };
        },
      };
      const persistence = new WorkerPersistence(db, runtime);
      const metrics = new MetricRegistry();
      const handler = createWorkerHandlers({
        persistence,
        roles: {},
        logger: new StructuredLogger({ sink: { log: () => undefined } }),
        db,
        jobs,
        engineering: (writerLease) =>
          createPostgresEngineeringRuntimePort({
            db,
            lease: writerLease,
            jobs,
            readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
            executor,
            metrics,
            executeSystemStage: async ({ binding }) => systemArtifact(binding.stage),
            policy: {
              riskFacts: {
                authority: "SERVER_OWNED",
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
              },
            },
          }),
      })["agent.implementer"]!;

      await handler(lease!, async () => undefined);
      expect(calls).toEqual([
        EngineeringStage.SLICE_PLANNING,
        EngineeringStage.SLICE_REVIEW,
        EngineeringStage.MEMORY_PROJECTION,
        EngineeringStage.FINAL_VERIFICATION,
      ]);
      expect((await db.query("SELECT 1 FROM run_completions")).rows).toHaveLength(1);
      expect((await db.query("SELECT 1 FROM engineering_operations")).rows).toHaveLength(7);
      expect((await db.query("SELECT 1 FROM engineering_artifact_revisions")).rows).toHaveLength(7);
      expect(
        (
          await db.query<{ event_type: string }>(
            "SELECT event_type FROM engineering_stage_events ORDER BY event_sequence",
          )
        ).rows.filter((row) => row.event_type === "STARTED"),
      ).toHaveLength(7);
      expect(metrics.counter(MetricName.ENGINEERING_STAGE_TRANSITIONS)).toBe(14);
      expect(metrics.counter(MetricName.ENGINEERING_TERMINALS)).toBe(1);
      const telemetry = JSON.stringify(metrics.snapshot().counters);
      expect(telemetry).not.toMatch(/case-1|owner-1|unit-1|run-1|packet for/u);
      expect(
        metrics
          .snapshot()
          .counters.every((sample) =>
            Object.keys(sample.labels).every((key) => key === "kind" || key === "outcome"),
          ),
      ).toBe(true);
    });

    it("recovers a durable stage artifact without context or executor replay", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      let contextReads = 0;
      let executorCalls = 0;
      const runCreated = await db.query<{ created_at: Date }>(
        "SELECT created_at FROM agent_runs WHERE run_id='run-1'",
      );
      const expectedDeadline = runCreated.rows[0]!.created_at.getTime() + 5_000;
      const options = {
        db,
        lease: lease!,
        jobs,
        workflowDeadlineMs: 5_000,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => {
          contextReads += 1;
          return manifest(stage);
        },
        executor: {
          configDigest: sha("5"),
          schemaDigest: () => sha("6"),
          execute: async () => {
            executorCalls += 1;
            throw new Error("discovery must be assembled by server code");
          },
        } satisfies EngineeringStageExecutor,
        policy: {
          riskFacts: {
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
          },
        },
      };
      const binding = {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.DISCOVERY,
        attempt: 1,
      } as const;
      const first = createPostgresEngineeringRuntimePort(options);
      const firstSession = await first.open(runtimeIdentity());
      expect(firstSession).toMatchObject({
        stageCalls: 0,
        modelCalls: 0,
        deadlineMs: expectedDeadline,
      });
      expect(await first.recoverStage(binding)).toEqual({ status: "NOT_STARTED" });
      const context = await first.prepareContext(binding);
      await first.commitStarted(binding);
      expect(
        await first.invokeAndRecord({
          binding,
          context,
          definition: {
            role: "PLANNER",
            input_artifacts: ["EngineeringContextManifest"],
            output_artifacts: [],
            completion_contract: null,
            workspace_access: "READ_ONLY",
          },
        }),
      ).toMatchObject({ status: "COMPLETED" });
      expect(contextReads).toBe(1);
      expect(executorCalls).toBe(0);

      const recovered = createPostgresEngineeringRuntimePort(options);
      const recoveredSession = await recovered.open(runtimeIdentity());
      expect(recoveredSession).toMatchObject({
        stageCalls: 1,
        modelCalls: 0,
        deadlineMs: expectedDeadline,
      });
      expect(await recovered.recoverStage(binding)).toMatchObject({ status: "RECOVERED" });
      expect(contextReads).toBe(1);
      expect(executorCalls).toBe(0);
    });

    it("requires an exact answered owner decision before a high-risk design can implement", async () => {
      const jobs = new JobStore(runtime);
      await jobs.enqueue(db, {
        caseId: "case-1",
        jobType: "agent.implementer",
        payload: { caseId: "case-1", workUnitId: "unit-1", runId: "run-1" },
      });
      const lease = await jobs.claim(db, { owner: "worker-1", leaseMs: 120_000 });
      expect(lease).not.toBeNull();
      const policy = {
        riskFacts: {
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
        },
        ownerEscalation: {
          authority: "OWNER_DECISION" as const,
          decisionId: "owner-grant-1",
          checkpointRevision: 0,
          processClass: "LARGE_OR_HIGH_RISK" as const,
        },
        authorization: {
          authority: "OWNER_DECISION" as const,
          authorizationId: "owner-grant-1",
          checkpointRevision: 0,
        },
      };
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async ({ binding }) => ({
          kind: "ARTIFACT",
          artifact: modelArtifact(binding.stage),
          modelCalls: 1,
        }),
      };
      const ungranted = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage),
        policy,
      });
      await expect(ungranted.open(runtimeIdentity())).rejects.toThrow(/exact durable answer/);

      await db.query(
        `INSERT INTO decisions (
           decision_id, case_id, question, why_now, options, recommendation,
           blocked_scope, checkpoint_revision)
         VALUES ('owner-grant-1','case-1','Use high-risk process?','Before design',
                 '[{"id":"grant","label":"Grant","consequences":"Full design"},{"id":"deny","label":"Deny","consequences":"Stop"}]'::jsonb,
                 'grant','engineering workflow',0)`,
      );
      await db.query(
        `INSERT INTO decision_answers (
           answer_id, decision_id, case_id, checkpoint_revision, selected_option_id,
           answered_by, answered_at)
         VALUES ('answer-grant-1','owner-grant-1','case-1',0,'grant','owner-1',now())`,
      );
      const granted = createPostgresEngineeringRuntimePort({
        db,
        lease: lease!,
        jobs,
        readContext: async ({ stage = EngineeringStage.DISCOVERY }) => manifest(stage),
        executor,
        executeSystemStage: async ({ binding }) => systemArtifact(binding.stage),
        policy,
      });
      expect(await granted.open(runtimeIdentity())).toMatchObject({
        plan: { processClass: "LARGE_OR_HIGH_RISK", ownerDecisionId: "owner-grant-1" },
      });
    });
  },
  available,
);

it("binds a structured stage to its server-owned Bedrock schema", async () => {
  const config = createRuntimeConfig({
    model: { provider: "bedrock", model_id: "test-model" },
    timeoutMs: 1_000,
    toolLimits: { maxIterations: 2, maxCalls: 2 },
  });
  const artifact = modelArtifact(EngineeringStage.SLICE_PLANNING);
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: artifact }] },
  ]);
  const executor = createBedrockEngineeringStageExecutor({ transport, config });
  const result = await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.SLICE_PLANNING,
      attempt: 1,
    },
    objective: "bounded slice",
    context: manifest(EngineeringStage.SLICE_PLANNING),
  });
  expect(result).toEqual({ kind: "ARTIFACT", artifact, modelCalls: 1 });
  expect(transport.requests).toHaveLength(1);
  expect(executor.schemaDigest(EngineeringStage.SLICE_PLANNING)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(
    transport.requests[0]!.messages.flatMap((message) => message.content)
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n"),
  ).toContain("Execute only engineering stage SLICE_PLANNING");
});
