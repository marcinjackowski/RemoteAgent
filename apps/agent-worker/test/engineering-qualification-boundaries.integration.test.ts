import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  RuntimeConfig,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeTransport,
} from "@remoteagent/bedrock-runtime";
import { canonicalDigest } from "@remoteagent/contracts";
import {
  EngineeringControlPlaneRepository,
  productionRuntime,
  type EngineeringControlArtifactRevisionRow,
} from "@remoteagent/database";
import { VerificationGateCatalog, VerificationGateDefinition } from "@remoteagent/test-evidence";
import { afterEach, expect, it } from "vitest";

import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";
import { verticalSliceWorkspaceId } from "../src/vertical-slice-executor.js";
import {
  createEngineeringQualificationFixture,
  qualificationModel,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";

const available = await ensurePostgres();
const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;
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

type ReviewDisposition = "CHANGES_REQUIRED" | "PASS";

class BoundaryTransport implements RuntimeTransport {
  readonly requests: RuntimeRequest[] = [];
  implementationAttempts = 0;
  reviewAttempts = 0;
  planningCalls = 0;
  #awaitingImplementationReport = false;

  public constructor(
    private readonly binding: { caseId: string; runId: string },
    private readonly scenario: {
      contents: readonly string[];
      reviews: readonly ReviewDisposition[];
      gateIds?: readonly string[];
      reviewEvidence?: string;
      sliceIds?: readonly string[];
    },
  ) {}

  public async converse(request: RuntimeRequest, _config: RuntimeConfig): Promise<RuntimeResponse> {
    this.requests.push(request);
    const name = request.outputSchema?.name;
    const common = {
      schema_version: 1,
      case_id: this.binding.caseId,
      run_id: this.binding.runId,
      revision: 0,
    } as const;
    const json = (value: unknown): RuntimeResponse => ({
      model: qualificationModel,
      content: [{ type: "json", value: value as never }],
    });
    if (name === "EngineeringSystemDesign_v1") {
      return json({
        ...common,
        artifact_kind: "SystemDesign",
        boundaries: ["worker", "PostgreSQL", "Git"],
        data: ["immutable correction attempts"],
        api: ["production runtime port"],
        integrations: ["PostgreSQL", "Git", "process gates"],
        invariants: ["review association is slice-local"],
        architecture: "bounded two-slice qualification",
        components: ["SupervisorRuntime", "PostgresEngineeringRuntimePort"],
        interfaces: ["stage intent", "artifact", "completion"],
        data_flow: "slice to implementation to fresh review",
        risks: ["historical rejection collision"],
        source_digest: sha("1"),
      });
    }
    if (name === "EngineeringProgramDesign_v1") {
      const sliceIds = this.scenario.sliceIds ?? ["slice-1"];
      return json({
        ...common,
        artifact_kind: "ProgramDesign",
        call_flow: [...sliceIds],
        file_tree_delta: ["src/change.ts"],
        key_types_and_signatures: ["bounded qualification value"],
        uncertainty_review: ["review every slice independently"],
        expected_tests: ["qualification"],
        slice_order: [...sliceIds],
        source_digest: sha("2"),
      });
    }
    if (name === "EngineeringSliceContract_v1") {
      const sliceId = (this.scenario.sliceIds ?? ["slice-1"])[this.planningCalls];
      if (sliceId === undefined) throw new Error("unexpected extra slice planning attempt");
      this.planningCalls += 1;
      return json({
        ...common,
        artifact_kind: "SliceContract",
        slice_id: sliceId,
        objective: "exercise the exact production boundary",
        observable_result: "the durable terminal or accepted correction is exact",
        allowed_paths: ["src"],
        gate_ids: [...(this.scenario.gateIds ?? ["qualification"])],
        inspection_method: "inspect immutable attempts and receipts",
        stop_condition: "server-derived review or terminal state is durable",
      });
    }
    if (name === "SliceImplementationReport_v1") {
      const content = this.scenario.contents[this.implementationAttempts];
      if (content === undefined) throw new Error("unexpected extra implementation attempt");
      if (!this.#awaitingImplementationReport) {
        this.#awaitingImplementationReport = true;
        return {
          model: qualificationModel,
          content: [
            {
              type: "tool-use",
              id: `write-${String(this.implementationAttempts + 1)}`,
              name: "write",
              input: { relative_path: "src/change.ts", content },
            },
          ],
        };
      }
      this.#awaitingImplementationReport = false;
      const changedFiles =
        this.implementationAttempts > 0 &&
        this.scenario.contents[this.implementationAttempts - 1] === content
          ? []
          : ["src/change.ts"];
      this.implementationAttempts += 1;
      return json({ schema_version: 1, changed_files: changedFiles });
    }
    if (name === "PreCommitReviewOutput_v1") {
      const disposition = this.scenario.reviews[this.reviewAttempts];
      if (disposition === undefined) throw new Error("unexpected extra review attempt");
      this.reviewAttempts += 1;
      return json(
        disposition === "PASS"
          ? { schema_version: 1, findings: [], lines_examined: 10 }
          : {
              schema_version: 1,
              findings: [
                {
                  severity: "MEDIUM",
                  summary: "The bounded implementation still needs correction.",
                  location: { relative_path: "src/change.ts", line: 1 },
                  evidence:
                    this.scenario.reviewEvidence ??
                    this.scenario.contents[this.reviewAttempts - 1]!.trim(),
                  required_fix: "replace it with the accepted value",
                },
              ],
              lines_examined: 10,
            },
      );
    }
    if (name === "EngineeringMemoryUpdate_v1") {
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
    }
    if (name === "EngineeringVerificationDecision_v1") {
      return json({
        ...common,
        artifact_kind: "VerificationDecision",
        decision_id: "boundary-verification",
        rationale: "the exact accepted attempt has fresh gate and review evidence",
        decision: "VERIFIED",
        criterion_outcomes: [
          { criterion_id: "boundary", status: "PASSED", evidence_digest: sha("6") },
        ],
        evidence_digest: sha("6"),
      });
    }
    throw new Error(`unexpected boundary schema ${String(name)}`);
  }
}

class CrashAfterModelStartedOnce extends EngineeringControlPlaneRepository {
  crashed = false;
  #started = 0;

  public override async commitOperationStarted(
    ...args: Parameters<EngineeringControlPlaneRepository["commitOperationStarted"]>
  ): ReturnType<EngineeringControlPlaneRepository["commitOperationStarted"]> {
    const result = await super.commitOperationStarted(...args);
    this.#started += 1;
    // SMALL begins with a zero-model DISCOVERY provenance stage. The second STARTED is the
    // retry-safe SLICE_PLANNING model intent this test is specifically qualifying.
    if (!this.crashed && this.#started === 2) {
      this.crashed = true;
      throw new Error("injected crash after retry-safe MODEL_CALL STARTED");
    }
    return result;
  }
}

class CorruptTreeAfterImplementationReceipt extends EngineeringControlPlaneRepository {
  corrupted = false;

  public constructor(private readonly changedPath: string) {
    super(productionRuntime());
  }

  public override async appendArtifactRevision(
    ...args: Parameters<EngineeringControlPlaneRepository["appendArtifactRevision"]>
  ): Promise<EngineeringControlArtifactRevisionRow> {
    const row = await super.appendArtifactRevision(...args);
    if (!this.corrupted && args[2].artifact.artifact_kind === "SliceImplementationReceipt") {
      this.corrupted = true;
      await writeFile(this.changedPath, "export const value = 'foreign-after-receipt';\n");
    }
    return row;
  }
}

class CrashOuterEvidenceOnce extends EngineeringControlPlaneRepository {
  crashed = false;

  public override async appendArtifactRevision(
    ...args: Parameters<EngineeringControlPlaneRepository["appendArtifactRevision"]>
  ): Promise<EngineeringControlArtifactRevisionRow> {
    if (!this.crashed && args[2].artifact.artifact_kind === "EvidenceBundle") {
      this.crashed = true;
      throw new Error("injected crash after durable gate receipt");
    }
    return super.appendArtifactRevision(...args);
  }
}

async function artifactAttempts(fixture: EngineeringQualificationFixture) {
  return (
    await fixture.db.query<{
      artifact_kind: string;
      stage_attempt: number;
      decision: string | null;
    }>(
      `SELECT artifact_kind, stage_attempt, payload->>'decision' AS decision
         FROM engineering_artifact_revisions
        WHERE run_id=$1 ORDER BY revision`,
      [fixture.ids.runId],
    )
  ).rows;
}

async function assertNoAcceptedWrite(fixture: EngineeringQualificationFixture): Promise<void> {
  const counts = await fixture.db.query<{ bundles: string; commits: string }>(
    `SELECT
       (SELECT count(*)::text FROM engineering_artifact_revisions
         WHERE run_id=$1 AND artifact_kind='EvidenceBundle') AS bundles,
       (SELECT count(*)::text FROM engineering_artifact_revisions
         WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt') AS commits`,
    [fixture.ids.runId],
  );
  expect(counts.rows[0]).toEqual({ bundles: "0", commits: "0" });
}

describeIntegration(
  "RA-044 production composition safety boundaries",
  () => {
    const active: EngineeringQualificationFixture[] = [];
    afterEach(async () => Promise.all(active.splice(0).map((fixture) => fixture.drop())));

    it.each([
      ["NO_PROGRESS", ["same", "same"], 2, 1],
      ["OSCILLATION", ["a", "b", "a", "b", "a", "b"], 6, 6],
    ] as const)(
      "persists exact %s terminal completion through the full production handler",
      async (terminal, values, expectedImplementationAttempts, expectedReviewAttempts) => {
        const fixture = await createEngineeringQualificationFixture({
          id: `progress-${terminal.toLowerCase()}`,
        });
        active.push(fixture);
        const transport = new BoundaryTransport(
          { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
          {
            contents: values.map((value) => `export const value = '${value}';\n`),
            reviews: values.map(() => "CHANGES_REQUIRED" as const),
          },
        );
        const lease = await fixture.claimImplementer();
        const production = fixture.makeProduction(lease, {
          transport,
          policy: { riskFacts: smallRiskFacts },
        });

        await production.handler(lease, async () => undefined);

        expect(transport.implementationAttempts).toBe(expectedImplementationAttempts);
        expect(transport.reviewAttempts).toBe(expectedReviewAttempts);
        const completion = await fixture.db.query<{ status: string; summary: string }>(
          `SELECT completion->>'status' AS status, completion->>'summary' AS summary
             FROM run_completions WHERE run_id=$1`,
          [fixture.ids.runId],
        );
        expect(completion.rows).toEqual([
          {
            status: "BLOCKED",
            summary:
              terminal === "NO_PROGRESS"
                ? expect.stringMatching(/^NO_PROGRESS:/u)
                : `engineering workflow stopped: ${terminal}`,
          },
        ]);
        if (terminal === "NO_PROGRESS") {
          const terminalArtifacts = await fixture.db.query<{
            reason: string;
            detail: string;
            stage_attempt: number;
          }>(
            `SELECT payload->>'reason' AS reason, payload->>'detail' AS detail, stage_attempt
               FROM engineering_artifact_revisions
              WHERE run_id=$1 AND artifact_kind='TerminalReason'`,
            [fixture.ids.runId],
          );
          expect(terminalArtifacts.rows).toEqual([
            {
              reason: "EXHAUSTED",
              detail: expect.stringMatching(/^NO_PROGRESS:/u),
              stage_attempt: 2,
            },
          ]);
        }
        expect(
          (await artifactAttempts(fixture)).filter(
            ({ artifact_kind }) => artifact_kind === "LocalCommitReceipt",
          ),
        ).toHaveLength(0);
      },
    );

    it("does not convert another typed review contract failure into NO_PROGRESS", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "review-contract-error" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        {
          contents: ["export const value = 'rejected';\n"],
          reviews: ["CHANGES_REQUIRED"],
          reviewEvidence: "evidence absent from the actual patch",
        },
      );
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });

      await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(transport.reviewAttempts).toBe(1);
      const terminalArtifacts = await fixture.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM engineering_artifact_revisions
          WHERE run_id=$1 AND artifact_kind='TerminalReason'`,
        [fixture.ids.runId],
      );
      expect(terminalArtifacts.rows[0]?.count).toBe("0");
      const commits = await fixture.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM engineering_artifact_revisions
          WHERE run_id=$1 AND artifact_kind='LocalCommitReceipt'`,
        [fixture.ids.runId],
      );
      expect(commits.rows[0]?.count).toBe("0");
    });

    it("opens a fresh reviewer when a new slice matches an older rejected patch", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "slice-local-review" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        {
          sliceIds: ["slice-1", "slice-2"],
          contents: [
            "export const value = 'historic-reject';\n",
            "export const value = 'accepted-correction';\n",
            "export const value = 'historic-reject';\n",
          ],
          reviews: ["CHANGES_REQUIRED", "PASS", "PASS"],
        },
      );
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: {
          riskFacts: { ...smallRiskFacts, multi_module: true },
          proposedProcessClass: "MEDIUM",
        },
      });

      await production.handler(lease, async () => undefined);

      expect(transport.planningCalls).toBe(2);
      expect(transport.implementationAttempts).toBe(3);
      expect(transport.reviewAttempts).toBe(3);
      const artifacts = await artifactAttempts(fixture);
      expect(
        artifacts
          .filter(({ artifact_kind }) => artifact_kind === "ReviewDecision")
          .map(({ stage_attempt, decision }) => [stage_attempt, decision]),
      ).toEqual([
        [1, "CHANGES_REQUIRED"],
        [2, "PASS"],
        [3, "PASS"],
      ]);
      expect(artifacts.some(({ artifact_kind }) => artifact_kind === "TerminalReason")).toBe(false);
      expect(
        artifacts.filter(({ artifact_kind }) => artifact_kind === "LocalCommitReceipt"),
      ).toHaveLength(1);
    });

    it("accepts only the corrected attempt after a fresh PASS review", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "fresh-correction" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        {
          contents: ["export const value = 'rejected';\n", "export const value = 'accepted';\n"],
          reviews: ["CHANGES_REQUIRED", "PASS"],
        },
      );
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });

      await production.handler(lease, async () => undefined);

      const artifacts = await artifactAttempts(fixture);
      expect(
        artifacts
          .filter(({ artifact_kind }) => artifact_kind === "SliceImplementationReceipt")
          .map(({ stage_attempt }) => stage_attempt),
      ).toEqual([1, 2]);
      expect(
        artifacts
          .filter(({ artifact_kind }) => artifact_kind === "ReviewDecision")
          .map(({ stage_attempt, decision }) => [stage_attempt, decision]),
      ).toEqual([
        [1, "CHANGES_REQUIRED"],
        [2, "PASS"],
      ]);
      expect(
        artifacts
          .filter(({ artifact_kind }) => artifact_kind === "MemoryUpdate")
          .map(({ stage_attempt }) => stage_attempt),
      ).toEqual([2]);
      const commit = await fixture.db.query<{ descriptor: { accepted: unknown[] } }>(
        `SELECT i.descriptor FROM engineering_operations o
           JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id=$1 AND o.stage='LOCAL_COMMIT'`,
        [fixture.ids.runId],
      );
      expect(commit.rows[0]?.descriptor.accepted).toEqual([
        expect.objectContaining({ slice_id: "slice-1", attempt: 2 }),
      ]);
      expect(JSON.stringify(commit.rows[0]?.descriptor.accepted)).not.toContain('"attempt":1');
    });

    it("re-enters the full handler on the same current lease after retry-safe MODEL_CALL STARTED", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "model-reentry" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        { contents: ["export const value = 'accepted';\n"], reviews: ["PASS"] },
      );
      const lease = await fixture.claimImplementer();
      const control = new CrashAfterModelStartedOnce(productionRuntime());
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
        descriptor: Record<string, unknown>;
        starts: string;
      }>(
        `SELECT i.descriptor,
           (SELECT count(*)::text FROM engineering_stage_events e
             WHERE e.operation_id=o.operation_id AND e.event_type='STARTED') AS starts
           FROM engineering_operations o JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id=$1 AND o.stage='SLICE_PLANNING'`,
        [fixture.ids.runId],
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]!.starts).toBe("1");
      expect(transport.planningCalls).toBe(0);

      await production.handler(lease, async () => undefined);

      const after = await fixture.db.query<{ descriptor: Record<string, unknown>; starts: string }>(
        `SELECT i.descriptor,
           (SELECT count(*)::text FROM engineering_stage_events e
             WHERE e.operation_id=o.operation_id AND e.event_type='STARTED') AS starts
           FROM engineering_operations o JOIN job_intents i ON i.intent_id=o.intent_id
          WHERE o.run_id=$1 AND o.stage='SLICE_PLANNING'`,
        [fixture.ids.runId],
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]!.starts).toBe("1");
      expect(after.rows[0]!.descriptor).toEqual(before.rows[0]!.descriptor);
      expect(transport.planningCalls).toBe(1);
    });

    it("rejects a stale tree after the implementation receipt before any success bundle", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "stale-tree" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        { contents: ["export const value = 'recorded';\n"], reviews: ["PASS"] },
      );
      const changedPath = join(
        fixture.config.workspaceConfig.workspaceRoot,
        fixture.ids.caseId,
        verticalSliceWorkspaceId(fixture.ids.caseId),
        "src/change.ts",
      );
      const control = new CorruptTreeAfterImplementationReceipt(changedPath);
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: control,
      });

      await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(control.corrupted).toBe(true);
      expect(transport.reviewAttempts).toBe(0);
      await assertNoAcceptedWrite(fixture);
    });

    it("rejects a durable gate receipt when deployment config changes before outer recovery", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "stale-config" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        { contents: ["export const value = 'recorded';\n"], reviews: ["PASS"] },
      );
      const lease = await fixture.claimImplementer();
      const crash = new CrashOuterEvidenceOnce(productionRuntime());
      const first = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        controlPlane: crash,
      });
      await expect(first.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(crash.crashed).toBe(true);

      const original = fixture.config.catalog.definitions[0]!;
      const changedDefinition = VerificationGateDefinition.parse({
        ...original,
        timeout_ms: original.timeout_ms - 1,
      });
      const changedCatalog = await VerificationGateCatalog.create({
        definitions: [changedDefinition],
        executable_allowlist: fixture.config.catalog.executable_allowlist,
      });
      const changedConfig = Object.freeze({
        ...fixture.config,
        catalog: changedCatalog,
        configDigest: canonicalDigest({
          prior: fixture.config.configDigest,
          changed_gate_config: changedCatalog.config_digest,
        }),
      });
      const fresh = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
        executionConfig: changedConfig,
      });
      await expect(fresh.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      const inner = await fixture.db.query<{ completions: string }>(
        `SELECT count(*)::text AS completions FROM job_completions c
          JOIN engineering_operations o ON o.intent_id=c.intent_id
         WHERE o.run_id=$1 AND o.operation_kind='engineering.verification.gate'`,
        [fixture.ids.runId],
      );
      expect(inner.rows[0]?.completions).toBe("1");
      expect(transport.reviewAttempts).toBe(0);
      await assertNoAcceptedWrite(fixture);
    });

    it("blocks a SliceContract missing the server-required gate", async () => {
      const fixture = await createEngineeringQualificationFixture({ id: "missing-gate" });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        {
          contents: ["export const value = 'not-accepted';\n"],
          reviews: ["PASS"],
          gateIds: ["unknown-gate"],
        },
      );
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
        /did not complete its work/,
      );
      expect(transport.implementationAttempts).toBe(1);
      expect(transport.reviewAttempts).toBe(0);
      await assertNoAcceptedWrite(fixture);
    });

    it("persists BLOCKED and no success bundle when the required gate fails", async () => {
      const fixture = await createEngineeringQualificationFixture({
        id: "failed-gate",
        gateFails: true,
      });
      active.push(fixture);
      const transport = new BoundaryTransport(
        { caseId: fixture.ids.caseId, runId: fixture.ids.runId },
        { contents: ["export const value = 'not-accepted';\n"], reviews: ["PASS"] },
      );
      const lease = await fixture.claimImplementer();
      const production = fixture.makeProduction(lease, {
        transport,
        policy: { riskFacts: smallRiskFacts },
      });
      await production.handler(lease, async () => undefined);

      const completion = await fixture.db.query<{ status: string; summary: string }>(
        `SELECT completion->>'status' AS status, completion->>'summary' AS summary
           FROM run_completions WHERE run_id=$1`,
        [fixture.ids.runId],
      );
      expect(completion.rows[0]).toMatchObject({
        status: "BLOCKED",
        summary: expect.stringContaining("required gates did not pass"),
      });
      await assertNoAcceptedWrite(fixture);
      expect(transport.reviewAttempts).toBe(0);
    });

    it.each([
      ["owner", { ownerId: "foreign-owner" }],
      ["integration", { connectionIds: ["foreign-connection"] }],
    ] as const)(
      "rejects a foreign approval %s scope before model or workspace",
      async (kind, patch) => {
        const fixture = await createEngineeringQualificationFixture({
          id: `foreign-approval-${kind}`,
        });
        active.push(fixture);
        const approvalId = `approval-foreign-${kind}`;
        await fixture.grantWriteApproval({
          approvalId,
          processClass: "LARGE_OR_HIGH_RISK",
          scopePatch: patch,
        });
        const lease = await fixture.claimImplementer({
          reason: "engineering_approval",
          approvalId,
          checkpointRevision: 0,
        });
        const transport: RuntimeTransport & { calls: number } = {
          calls: 0,
          async converse() {
            this.calls += 1;
            throw new Error("foreign approval must fail before model invocation");
          },
        };
        const production = fixture.makeProduction(lease, {
          transport,
          policy: { riskFacts: { ...smallRiskFacts, security_or_policy: true } },
        });
        await expect(production.handler(lease, async () => undefined)).rejects.toThrow(
          /did not complete its work/,
        );
        expect(transport.calls).toBe(0);
        const durable = await fixture.db.query<{
          consumed: boolean;
          operations: string;
          workspaces: string;
        }>(
          `SELECT consumed,
          (SELECT count(*)::text FROM engineering_operations WHERE run_id=$2) AS operations,
          (SELECT count(*)::text FROM workspaces WHERE case_id=$3) AS workspaces
         FROM approvals WHERE approval_id=$1`,
          [approvalId, fixture.ids.runId, fixture.ids.caseId],
        );
        expect(durable.rows[0]).toEqual({ consumed: false, operations: "0", workspaces: "0" });
        await assertNoAcceptedWrite(fixture);
      },
    );
  },
  available,
);
