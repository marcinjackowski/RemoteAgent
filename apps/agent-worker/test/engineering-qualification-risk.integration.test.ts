import {
  canonicalDigest,
  engineeringArtifactDigest,
  EngineeringStage,
} from "@remoteagent/contracts";
import {
  type RuntimeConfig,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeTransport,
} from "@remoteagent/bedrock-runtime";
import {
  ExternalActionRepository,
  ReceiptRepository,
  WorkUnitRepository,
} from "@remoteagent/database";
import { afterEach, expect, it } from "vitest";

import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import {
  createEngineeringQualificationFixture,
  qualificationModel,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const available = await ensurePostgres();
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

class QualificationTransport implements RuntimeTransport {
  readonly requests: RuntimeRequest[] = [];
  readonly #caseId: string;
  readonly #runId: string;
  readonly #sliceIds: readonly string[];
  readonly #implementationPaths: readonly string[];
  readonly #processClass: "SMALL" | "MEDIUM" | "LARGE_OR_HIGH_RISK";
  #planning = 0;
  #implementation = 0;
  #awaitingImplementationReport = false;
  #memory = 0;

  public constructor(input: {
    caseId: string;
    runId: string;
    sliceIds: readonly string[];
    implementationPaths: readonly string[];
    processClass: "SMALL" | "MEDIUM" | "LARGE_OR_HIGH_RISK";
  }) {
    this.#caseId = input.caseId;
    this.#runId = input.runId;
    this.#sliceIds = input.sliceIds;
    this.#implementationPaths = input.implementationPaths;
    this.#processClass = input.processClass;
  }

  public async converse(request: RuntimeRequest, _config: RuntimeConfig): Promise<RuntimeResponse> {
    this.requests.push(request);
    const name = request.outputSchema?.name;
    const json = (value: unknown): RuntimeResponse => ({
      model: qualificationModel,
      content: [{ type: "json", value: value as never }],
    });
    const common = {
      schema_version: 1,
      case_id: this.#caseId,
      run_id: this.#runId,
      revision: 0,
    };
    if (name === "EngineeringOutcomeContract_v1") {
      return json({
        ...common,
        artifact_kind: "OutcomeContract",
        problem: "qualify the production engineering path",
        outcome: "durable reviewed implementation",
        non_goals: [],
        objective: "execute bounded slices",
        success_criteria: ["required gates pass"],
        constraints: ["one server-owned repository"],
        process_class: this.#processClass,
        source_digest: sha("1"),
      });
    }
    if (name === "EngineeringSystemDesign_v1") {
      return json({
        ...common,
        artifact_kind: "SystemDesign",
        boundaries: ["worker", "PostgreSQL", "Git"],
        data: ["immutable engineering artifacts"],
        api: ["production runtime port"],
        integrations: ["PostgreSQL", "Git", "process gates"],
        invariants: ["single writer", "exact durable evidence"],
        architecture: "durable production engineering loop",
        components: ["SupervisorRuntime", "PostgresEngineeringRuntimePort"],
        interfaces: ["stage intent", "artifact", "completion"],
        data_flow: "context to slice to gates to review",
        risks: [],
        source_digest: sha("2"),
      });
    }
    if (name === "EngineeringProgramDesign_v2") {
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "ProgramDesign",
        call_flow: [...this.#sliceIds],
        file_tree_delta: [...this.#implementationPaths],
        key_types_and_signatures: ["bounded qualification files"],
        uncertainty_review: ["review every slice"],
        expected_tests: ["qualification"],
        slice_order: [...this.#sliceIds],
        slice_blueprints: this.#sliceIds.map((sliceId) => ({
          slice_id: sliceId,
          objective: `implement ${sliceId}`,
          observable_result: `${sliceId} is present in Git evidence`,
          allowed_paths: ["src"],
          test_paths: ["src"],
          gate_ids: ["qualification"],
          inspection_method: "inspect exact durable evidence",
          stop_condition: "fresh pre-commit review passes",
        })),
        source_digest: sha("3"),
      });
    }
    if (name === "EngineeringDesignDecision_v1") {
      const prompt = request.messages
        .flatMap((message) => message.content)
        .map((content) => (content.type === "text" ? content.text : ""))
        .join("\n");
      const reviewedDigest = /exact durable digest (sha256:[0-9a-f]{64})/u.exec(prompt)?.[1];
      if (reviewedDigest === undefined) throw new Error("reviewed ProgramDesign digest absent");
      return json({
        ...common,
        artifact_kind: "DesignDecision",
        decision_id: "design-approved",
        rationale: "the exact durable program design is approved",
        decision: "APPROVE",
        artifact_digest: reviewedDigest,
        findings: [],
        required_changes: [],
      });
    }
    if (name === "EngineeringSliceContract_v2") {
      const sliceId = this.#sliceIds[this.#planning++];
      if (sliceId === undefined) throw new Error("unexpected extra slice planning call");
      return json({
        ...common,
        schema_version: 2,
        artifact_kind: "SliceContract",
        slice_id: sliceId,
        objective: `implement ${sliceId}`,
        observable_result: `${sliceId} is present in Git evidence`,
        allowed_paths: ["src"],
        test_paths: ["src"],
        gate_ids: ["qualification"],
        inspection_method: "inspect exact durable evidence",
        stop_condition: "fresh pre-commit review passes",
      });
    }
    if (name === "SliceImplementationReport_v1") {
      const index = this.#implementation;
      const path = this.#implementationPaths[index];
      if (path === undefined) throw new Error("unexpected extra implementation call");
      if (!this.#awaitingImplementationReport) {
        this.#awaitingImplementationReport = true;
        return {
          model: qualificationModel,
          content: [
            {
              type: "tool-use",
              id: `write-${String(index)}`,
              name: "write",
              input: {
                relative_path: path,
                content:
                  path === "src/qualified.ts"
                    ? "export const qualification = 'qualified-green';\n"
                    : `export const slice${String(index + 1)} = true;\n`,
              },
            },
          ],
        };
      }
      this.#awaitingImplementationReport = false;
      this.#implementation += 1;
      return json({ schema_version: 1, changed_files: [path] });
    }
    if (name === "PreCommitReviewOutput_v1") {
      return json({ schema_version: 1, findings: [], lines_examined: 20 });
    }
    if (name === "EngineeringMemoryUpdate_v1") {
      this.#memory += 1;
      return json({
        ...common,
        artifact_kind: "MemoryUpdate",
        source_watermark: sha("4"),
        evidence_digests: [sha("5")],
        trust: "UNTRUSTED_DATA",
        authority: "MODEL_PROJECTION",
        completed_requirements: [`slice-${String(this.#memory)}`],
        open_issues: [],
      });
    }
    if (name === "EngineeringVerificationDecision_v1") {
      return json({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "qualification-verified",
        rationale: "all exact gate and review evidence is durable",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "all-slices", status: "PASSED", evidence_digest: sha("6") },
        ],
        evidence_digest: sha("6"),
      });
    }
    throw new Error(`unexpected qualification schema ${String(name)}`);
  }
}

const riskFacts = {
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
};

async function artifactRows(fixture: EngineeringQualificationFixture) {
  return (
    await fixture.db.query<{
      artifact_kind: string;
      stage: string;
      stage_attempt: number;
      payload: Record<string, unknown>;
      payload_digest: string;
    }>(
      `SELECT a.artifact_kind, a.stage, a.stage_attempt, a.payload, a.payload_digest
       FROM engineering_artifact_revisions a
       JOIN engineering_stage_events e
         ON e.artifact_revision_id=a.artifact_revision_id
        AND e.event_type='ARTIFACT_RECORDED'
      WHERE a.run_id=$1
      ORDER BY e.event_sequence`,
      [fixture.ids.runId],
    )
  ).rows;
}

async function assertContextAndBundleBindings(
  fixture: EngineeringQualificationFixture,
  expectedDecisionIds: readonly string[],
) {
  const descriptors = await fixture.db.query<{
    stage: string;
    stage_attempt: number;
    descriptor: Record<string, unknown>;
  }>(
    `SELECT o.stage, o.stage_attempt, i.descriptor
       FROM engineering_operations o
       JOIN job_intents i ON i.intent_id=o.intent_id AND i.job_id=o.job_id
      WHERE o.run_id=$1 AND o.operation_kind LIKE 'engineering.stage.%'
      ORDER BY o.recorded_at`,
    [fixture.ids.runId],
  );
  expect(descriptors.rows.length).toBeGreaterThan(0);
  for (const row of descriptors.rows) {
    const manifest = row.descriptor.context_manifest;
    expect(manifest).toMatchObject({
      artifact_kind: "ContextManifest",
      case_id: fixture.ids.caseId,
      run_id: fixture.ids.runId,
      revision: 0,
      authority: "SERVER_OWNED",
    });
    expect(row.descriptor.context_manifest_digest).toBe(engineeringArtifactDigest(manifest));
    expect(JSON.stringify(manifest)).not.toMatch(/qualification-model|\/Users\//u);
  }
  const localCommitDescriptor = descriptors.rows.find(({ stage }) => stage === "LOCAL_COMMIT");
  expect(localCommitDescriptor?.descriptor).toHaveProperty("commit.operation_id");
  const bundles = (await artifactRows(fixture)).filter(
    ({ artifact_kind }) => artifact_kind === "EvidenceBundle",
  );
  for (const bundle of bundles) {
    const descriptor = descriptors.rows.find(
      (row) =>
        row.stage === EngineeringStage.GATE_EXECUTION && row.stage_attempt === bundle.stage_attempt,
    )?.descriptor;
    expect(bundle.payload.context_digest).toBe(descriptor?.context_manifest_digest);
    expect(bundle.payload.decisions).toEqual(expectedDecisionIds);
  }
}

describeIntegration(
  "RA-044 production engineering qualification by risk class",
  () => {
    const active: EngineeringQualificationFixture[] = [];
    afterEach(async () => {
      await Promise.all(active.splice(0).map((fixture) => fixture.drop()));
    });

    it("runs SMALL with real baseline-red/current-green evidence and rejects a vacuous green baseline", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "small", testFirst: true });
      active.push(fixture);
      const transport = new QualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-1"],
        implementationPaths: ["src/qualified.ts"],
        processClass: "SMALL",
      });
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, { transport, policy: { riskFacts } });
      await production.handler(lease, async () => undefined);

      const rows = await artifactRows(fixture);
      expect(rows.slice(0, 2).map(({ artifact_kind }) => artifact_kind)).toEqual([
        "ContextManifest",
        "SliceContract",
      ]);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "SystemDesign")).toBe(false);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "ProgramDesign")).toBe(false);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "DesignDecision")).toBe(false);
      expect(rows.filter(({ artifact_kind }) => artifact_kind === "EvidenceBundle")).toHaveLength(
        1,
      );
      expect(
        rows.find(({ artifact_kind }) => artifact_kind === "EvidenceBundle")?.payload
          .test_first_evidence,
      ).toEqual([
        expect.objectContaining({ baseline_outcome: "FAILED", current_outcome: "PASSED" }),
      ]);
      await assertContextAndBundleBindings(fixture, []);

      const vacuous = await createEngineeringQualificationFixture({
        id: "small-vacuous",
        testFirst: true,
        baselineQualified: true,
      });
      active.push(vacuous);
      const vacuousTransport = new QualificationTransport({
        caseId: vacuous.ids.caseId,
        runId: vacuous.ids.runId,
        sliceIds: ["slice-1"],
        implementationPaths: ["src/change.ts"],
        processClass: "SMALL",
      });
      const vacuousLease = await vacuous.claimImplementer();
      await vacuous
        .makeProduction(vacuousLease, {
          transport: vacuousTransport,
          policy: { riskFacts },
        })
        .handler(vacuousLease, async () => undefined);
      expect(
        (await artifactRows(vacuous)).filter(
          ({ artifact_kind }) => artifact_kind === "EvidenceBundle",
        ),
      ).toHaveLength(0);
    });

    it("runs MEDIUM through two independently gated and reviewed slices", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "medium" });
      active.push(fixture);
      const transport = new QualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-1", "slice-2"],
        implementationPaths: ["src/one.ts", "src/two.ts"],
        processClass: "MEDIUM",
      });
      const lease = await fixture.claimImplementer();
      await fixture
        .makeProduction(lease, {
          transport,
          policy: { riskFacts: { ...riskFacts, multi_module: true } },
        })
        .handler(lease, async () => undefined);

      const rows = await artifactRows(fixture);
      expect(rows.slice(0, 3).map(({ artifact_kind }) => artifact_kind)).toEqual([
        "ContextManifest",
        "SystemDesign",
        "ProgramDesign",
      ]);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "SystemDesign")).toBe(true);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "ProgramDesign")).toBe(true);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "OutcomeContract")).toBe(false);
      expect(rows.some(({ artifact_kind }) => artifact_kind === "DesignDecision")).toBe(false);
      expect(
        rows
          .filter(({ artifact_kind }) => artifact_kind === "SliceContract")
          .map(({ payload }) => payload.slice_id),
      ).toEqual(["slice-1", "slice-2"]);
      expect(rows.filter(({ artifact_kind }) => artifact_kind === "EvidenceBundle")).toHaveLength(
        2,
      );
      expect(
        rows.filter(
          ({ artifact_kind, payload }) =>
            artifact_kind === "ReviewDecision" && payload.decision === "PASS",
        ),
      ).toHaveLength(2);
      await assertContextAndBundleBindings(fixture, []);
    });

    it("runs LARGE only after process escalation and an exact durable write approval", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "large" });
      active.push(fixture);
      const transport = new QualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-1"],
        implementationPaths: ["src/large.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const lease = await fixture.claimImplementer({
        reason: "engineering_approval",
        approvalId: "approval-missing",
        checkpointRevision: 0,
      });
      const policy = {
        riskFacts: { ...riskFacts, security_or_policy: true },
        ownerEscalation: {
          authority: "OWNER_DECISION" as const,
          decisionId: "decision-z-escalation",
          checkpointRevision: 0,
          processClass: "LARGE_OR_HIGH_RISK" as const,
        },
      };
      const production = fixture.makeProduction(lease, { transport, policy });
      const unit = await new WorkUnitRepository().findById(fixture.db, fixture.ids.workUnitId);
      if (unit === null) throw new Error("expected durable qualification work unit");
      await expect(
        production.port.open({
          unit: { workUnit: unit },
          run: { runId: fixture.ids.runId, checkpointRevision: 0 },
        }),
      ).rejects.toThrow(/exact durable answer/);
      expect(transport.requests).toHaveLength(0);
      expect(
        (
          await fixture.db.query("SELECT 1 FROM engineering_operations WHERE run_id=$1", [
            fixture.ids.runId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [fixture.ids.caseId]))
          .rowCount,
      ).toBe(0);

      await fixture.seedAnsweredDecision("decision-z-escalation");
      await expect(
        production.port.open({
          unit: { workUnit: unit },
          run: { runId: fixture.ids.runId, checkpointRevision: 0 },
        }),
      ).rejects.toThrow(/exact worker materialization/);
      expect(transport.requests).toHaveLength(0);
      expect(
        (
          await fixture.db.query("SELECT 1 FROM engineering_operations WHERE run_id=$1", [
            fixture.ids.runId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [fixture.ids.caseId]))
          .rowCount,
      ).toBe(0);
      const approvedFixture = await createEngineeringQualificationFixture({ id: "large-approved" });
      active.push(approvedFixture);
      await approvedFixture.seedAnsweredDecision("decision-z-escalation");
      await approvedFixture.grantWriteApproval({
        approvalId: "approval-a-write",
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const approvedLease = await approvedFixture.claimImplementer({
        reason: "engineering_approval",
        approvalId: "approval-a-write",
        checkpointRevision: 0,
      });
      const approvedTransport = new QualificationTransport({
        caseId: approvedFixture.ids.caseId,
        runId: approvedFixture.ids.runId,
        sliceIds: ["slice-1", "slice-2", "slice-3"],
        implementationPaths: ["src/large-1.ts", "src/large-2.ts", "src/large-3.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const approvedProduction = approvedFixture.makeProduction(approvedLease, {
        transport: approvedTransport,
        policy,
      });
      const approvedUnit = await new WorkUnitRepository().findById(
        approvedFixture.db,
        approvedFixture.ids.workUnitId,
      );
      if (approvedUnit === null) throw new Error("expected approved qualification work unit");
      await expect(
        approvedProduction.port.open({
          unit: { workUnit: approvedUnit },
          run: { runId: approvedFixture.ids.runId, checkpointRevision: 0 },
        }),
      ).resolves.toMatchObject({
        plan: {
          minimumProcessClass: "LARGE_OR_HIGH_RISK",
          processClass: "LARGE_OR_HIGH_RISK",
        },
      });
      const consumed = await approvedFixture.db.query<{
        consumed: boolean;
        consumed_at: Date | null;
      }>("SELECT consumed, consumed_at FROM approvals WHERE approval_id='approval-a-write'");
      expect(consumed.rows[0]?.consumed).toBe(true);
      expect(consumed.rows[0]?.consumed_at).toBeInstanceOf(Date);
      const consumedAt = consumed.rows[0]!.consumed_at!.getTime();
      // The handler re-opens after the direct open consumed the grant, proving exact
      // ALREADY_CONSUMED recovery for the same immutable run scope.
      await approvedProduction.handler(approvedLease, async () => undefined);
      const replayed = await approvedFixture.db.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM approvals WHERE approval_id='approval-a-write'",
      );
      expect(replayed.rows[0]?.consumed_at?.getTime()).toBe(consumedAt);

      const rows = await artifactRows(approvedFixture);
      expect(rows.slice(0, 5).map(({ artifact_kind }) => artifact_kind)).toEqual([
        "ContextManifest",
        "OutcomeContract",
        "SystemDesign",
        "ProgramDesign",
        "DesignDecision",
      ]);
      expect(rows.map(({ artifact_kind }) => artifact_kind)).toEqual(
        expect.arrayContaining([
          "OutcomeContract",
          "SystemDesign",
          "ProgramDesign",
          "DesignDecision",
          "SliceImplementationReceipt",
        ]),
      );
      const program = rows.find(({ artifact_kind }) => artifact_kind === "ProgramDesign");
      const approval = rows.find(({ artifact_kind }) => artifact_kind === "DesignDecision");
      const designIndex = rows.findIndex(({ artifact_kind }) => artifact_kind === "DesignDecision");
      const writeIndex = rows.findIndex(
        ({ artifact_kind }) => artifact_kind === "SliceImplementationReceipt",
      );
      expect(designIndex).toBeGreaterThanOrEqual(0);
      expect(writeIndex).toBeGreaterThan(designIndex);
      expect(approval?.payload.artifact_digest).toBe(program?.payload_digest);
      const approvalRequest = approvedTransport.requests.find(
        ({ outputSchema }) => outputSchema?.name === "EngineeringDesignDecision_v1",
      );
      expect(JSON.stringify(approvalRequest)).toContain(program?.payload_digest);
      await assertContextAndBundleBindings(approvedFixture, [
        "approval-a-write",
        "decision-z-escalation",
      ]);
    });

    it.each(["grant", "deny"] as const)(
      "rejects durable DecisionAnswer model option %s and its generic approval before engineering work",
      async (selectedOptionId) => {
        const fixture = await createEngineeringQualificationFixture({
          id: `large-decision-${selectedOptionId}`,
        });
        active.push(fixture);
        await fixture.seedAnsweredDecision("decision-z-escalation");
        const decisionId = `decision-generic-${selectedOptionId}`;
        await fixture.seedAnsweredDecision(decisionId, selectedOptionId);
        // The generic Approval deliberately shares the DecisionAnswer identity and exact write
        // digest. Only the dedicated proposal/materialization channel may make it authoritative.
        await fixture.grantWriteApproval({
          approvalId: decisionId,
          processClass: "LARGE_OR_HIGH_RISK",
        });
        const lease = await fixture.claimImplementer({
          reason: "decision_answer",
          decisionId,
          checkpointRevision: 0,
        });
        const transport = new QualificationTransport({
          caseId: fixture.ids.caseId,
          runId: fixture.ids.runId,
          sliceIds: ["slice-1"],
          implementationPaths: ["src/decision-bypass.ts"],
          processClass: "LARGE_OR_HIGH_RISK",
        });
        const production = fixture.makeProduction(lease, {
          transport,
          policy: {
            riskFacts: { ...riskFacts, security_or_policy: true },
            ownerEscalation: {
              authority: "OWNER_DECISION",
              decisionId: "decision-z-escalation",
              checkpointRevision: 0,
              processClass: "LARGE_OR_HIGH_RISK",
            },
          },
        });
        const unit = await new WorkUnitRepository().findById(fixture.db, fixture.ids.workUnitId);
        if (unit === null) throw new Error("expected generic decision work unit");

        await expect(
          production.port.open({
            unit: { workUnit: unit },
            run: { runId: fixture.ids.runId, checkpointRevision: 0 },
          }),
        ).rejects.toThrow(/durable write approval/);
        expect(transport.requests).toHaveLength(0);
        expect(
          (
            await fixture.db.query("SELECT 1 FROM engineering_operations WHERE run_id=$1", [
              fixture.ids.runId,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [
              fixture.ids.caseId,
            ])
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await fixture.db.query<{ consumed: boolean }>(
              "SELECT consumed FROM approvals WHERE approval_id=$1",
              [decisionId],
            )
          ).rows[0]?.consumed,
        ).toBe(false);
        expect((await fixture.db.query("SELECT 1 FROM engineering_write_proposals")).rowCount).toBe(
          0,
        );
      },
    );

    it("rejects a receipted external action and its generic approval before engineering work", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "large-external-action" });
      active.push(fixture);
      await fixture.seedAnsweredDecision("decision-z-escalation");

      const actionId = "generic-external-action";
      const approvalId = "generic-external-approval";
      const receiptId = "generic-external-receipt";
      const canonicalPayload = {
        schema_version: 2,
        purpose: "ENGINEERING_WORKFLOW_WRITE",
        case_id: fixture.ids.caseId,
        owner_id: fixture.ids.ownerId,
        checkpoint_revision: 0,
        work_unit_id: fixture.ids.workUnitId,
        run_id: fixture.ids.runId,
        process_class: "LARGE_OR_HIGH_RISK",
        authoritative_scope: {
          connection_ids: [],
          repo_allowlist: [fixture.ids.repositoryId],
          can_write_workspace: true,
        },
        repository_id: fixture.ids.repositoryId,
        write_path_allowlist: fixture.config.writeDeploymentPolicy.write_path_allowlist,
        deployment_policy_digest: canonicalDigest(fixture.config.writeDeploymentPolicy),
      } as const;
      const actionDigest = await fixture.grantWriteApproval({
        approvalId,
        processClass: "LARGE_OR_HIGH_RISK",
      });
      expect(canonicalDigest(canonicalPayload)).toBe(actionDigest);
      await fixture.db.withTransaction(async (tx) => {
        expect(
          await new ExternalActionRepository().propose(tx, {
            actionId,
            caseId: fixture.ids.caseId,
            toolName: "jira.comment",
            connectionId: fixture.ids.connectionId,
            canonicalPayload,
            actionDigest,
            riskTier: "R3",
            policyDecision: "REQUIRES_APPROVAL",
            idempotencyKey: "generic-external-action-key",
          }),
        ).toMatchObject({ outcome: "PROPOSED" });
        expect(
          await new ExternalActionRepository().attachApproval(tx, { actionId, approvalId }),
        ).toBe(true);
        expect(
          await new ExternalActionRepository().advanceStatus(tx, {
            actionId,
            from: "APPROVED",
            to: "EXECUTING",
          }),
        ).toBe(true);
        expect(
          await new ExternalActionRepository().advanceStatus(tx, {
            actionId,
            from: "EXECUTING",
            to: "SUCCEEDED",
          }),
        ).toBe(true);
        await new ReceiptRepository().record(tx, {
          receiptId,
          actionId,
          externalId: "jira-comment-1",
          entityVersion: "1",
          entityVersionField: "version",
          status: "SUCCEEDED",
        });
      });
      const lease = await fixture.claimImplementer({
        reason: "external_action",
        actionId,
        approvalId,
        receiptId,
        checkpointRevision: 0,
      });
      const transport = new QualificationTransport({
        caseId: fixture.ids.caseId,
        runId: fixture.ids.runId,
        sliceIds: ["slice-1"],
        implementationPaths: ["src/external-bypass.ts"],
        processClass: "LARGE_OR_HIGH_RISK",
      });
      const production = fixture.makeProduction(lease, {
        transport,
        policy: {
          riskFacts: { ...riskFacts, security_or_policy: true },
          ownerEscalation: {
            authority: "OWNER_DECISION",
            decisionId: "decision-z-escalation",
            checkpointRevision: 0,
            processClass: "LARGE_OR_HIGH_RISK",
          },
        },
      });
      const unit = await new WorkUnitRepository().findById(fixture.db, fixture.ids.workUnitId);
      if (unit === null) throw new Error("expected external-action qualification work unit");

      await expect(
        production.port.open({
          unit: { workUnit: unit },
          run: { runId: fixture.ids.runId, checkpointRevision: 0 },
        }),
      ).rejects.toThrow(/durable write approval/);
      expect(transport.requests).toHaveLength(0);
      expect(
        (
          await fixture.db.query("SELECT 1 FROM engineering_operations WHERE run_id=$1", [
            fixture.ids.runId,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await fixture.db.query("SELECT 1 FROM workspaces WHERE case_id=$1", [fixture.ids.caseId]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await fixture.db.query<{ consumed: boolean }>(
            "SELECT consumed FROM approvals WHERE approval_id=$1",
            [approvalId],
          )
        ).rows[0]?.consumed,
      ).toBe(false);
      expect(
        (
          await fixture.db.query<{ status: string; receipt_id: string }>(
            `SELECT a.status, r.receipt_id
               FROM external_actions a
               JOIN receipts r ON r.action_id=a.action_id
              WHERE a.action_id=$1`,
            [actionId],
          )
        ).rows[0],
      ).toEqual({ status: "SUCCEEDED", receipt_id: receiptId });
      expect((await fixture.db.query("SELECT 1 FROM engineering_write_proposals")).rowCount).toBe(
        0,
      );
    });
  },
  available,
);
