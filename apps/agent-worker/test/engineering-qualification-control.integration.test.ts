import { afterEach, beforeEach, expect, it } from "vitest";

import {
  EngineeringStage,
  TrustLevel,
  canonicalDigest,
  engineeringArtifact,
  engineeringContextManifest,
} from "@remoteagent/contracts";
import { EngineeringControlPlaneRepository, WorkUnitRepository } from "@remoteagent/database";

import type { CompiledRoleContext } from "../src/context.js";
import {
  createPostgresEngineeringRuntimePort,
  type EngineeringStageExecutor,
} from "../src/engineering-workflow.js";
import {
  createEngineeringQualificationFixture,
  qualificationRuntime,
  type EngineeringQualificationFixture,
} from "./engineering-qualification-fixture.js";
import {
  describeIntegration,
  ensurePostgres,
} from "../../../packages/database/test/integration-base.js";

const available = await ensurePostgres();
const sha = (digit: string): string => `sha256:${digit.repeat(64)}`;

function planningArtifact(fixture: EngineeringQualificationFixture) {
  return engineeringArtifact.parse({
    schema_version: 1,
    artifact_kind: "SliceContract",
    case_id: fixture.ids.caseId,
    run_id: fixture.ids.runId,
    revision: 0,
    slice_id: "slice-1",
    objective: "bounded slice",
    observable_result: "a cancellation-safe boundary",
    allowed_paths: ["apps/agent-worker/src"],
    gate_ids: ["gate-1"],
    inspection_method: "inspect immutable control events",
    stop_condition: "the next stage is not started",
  });
}

function context(fixture: EngineeringQualificationFixture): CompiledRoleContext {
  const manifest = engineeringContextManifest.parse({
    schema_version: 1,
    artifact_kind: "ContextManifest",
    case_id: fixture.ids.caseId,
    run_id: fixture.ids.runId,
    revision: 0,
    authority: "SERVER_OWNED",
    sources: [
      {
        source_id: "control-source",
        kind: "RAW_EVIDENCE",
        ref: "control-source",
        revision: 0,
        observed_at: "2026-08-26T00:00:00.000Z",
        digest: sha("a"),
        trust: TrustLevel.UNTRUSTED_DATA,
        freshness: "pinned to run",
        inclusion_reason: "qualification control",
        byte_budget: 64,
        full_artifact_ref: "control-source",
      },
    ],
    total_byte_budget: 1024,
  });
  return {
    packet: "bounded control context",
    packetBytes: 24,
    estimatedInputTokens: 6,
    cacheState: "NOT_OBSERVED",
    snapshotDigest: canonicalDigest({ stage: EngineeringStage.SLICE_PLANNING }),
    compiled: { stage: EngineeringStage.SLICE_PLANNING, manifest },
  } as CompiledRoleContext;
}

describeIntegration(
  "engineering qualification dynamic control",
  () => {
    let fixture: EngineeringQualificationFixture;

    beforeEach(async () => {
      fixture = await createEngineeringQualificationFixture({ id: "control" });
    });

    afterEach(async () => fixture.drop());

    it("recovers before an immutable cancellation and starts no subsequent stage", async () => {
      const lease = await fixture.claimImplementer();
      const executor: EngineeringStageExecutor = {
        configDigest: sha("5"),
        schemaDigest: () => sha("6"),
        execute: async () => ({
          kind: "ARTIFACT",
          artifact: planningArtifact(fixture),
          modelCalls: 1,
        }),
      };
      const makePort = () =>
        createPostgresEngineeringRuntimePort({
          db: fixture.db,
          lease,
          jobs: fixture.jobs,
          readContext: async () => context(fixture),
          executor,
          writePathAllowlist: Object.freeze(["apps/agent-worker/src"]),
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
        });

      const seed = makePort();
      const unit = await new WorkUnitRepository().findById(fixture.db, fixture.ids.workUnitId);
      if (unit === null) throw new Error("expected control qualification work unit");
      await seed.open({
        unit: { workUnit: unit },
        run: { runId: fixture.ids.runId, checkpointRevision: 0 },
      });
      const planning = {
        caseId: fixture.ids.caseId,
        workUnitId: fixture.ids.workUnitId,
        runId: fixture.ids.runId,
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_PLANNING,
        attempt: 1,
      } as const;
      const prepared = await seed.prepareContext(planning);
      await seed.commitStarted(planning);
      await seed.invokeAndRecord({
        binding: planning,
        context: prepared,
        definition: {
          role: "PLANNER",
          input_artifacts: [],
          output_artifacts: ["SliceContract"],
          completion_contract: null,
          workspace_access: "READ_ONLY",
        },
      });

      const control = new EngineeringControlPlaneRepository(qualificationRuntime);
      const projection = await control.prepareResume(fixture.db, { runId: fixture.ids.runId });
      await control.requestCancellation(fixture.db, {
        actionId: "qualification-cancel",
        operationId: projection.operation_id,
        actorId: fixture.ids.ownerId,
        reason: "stop between stages",
        expectedProjectionDigest: projection.projection_digest,
      });
      await fixture.db.query("DELETE FROM engineering_run_projections WHERE run_id = $1", [
        fixture.ids.runId,
      ]);

      const handler = fixture.implementerHandler(() => makePort());
      await handler(lease, async () => undefined);

      const operations = await fixture.db.query<{ stage: string }>(
        "SELECT stage FROM engineering_operations ORDER BY recorded_at, operation_id",
      );
      expect(operations.rows.map((row) => row.stage)).toEqual([EngineeringStage.SLICE_PLANNING]);
      expect(
        (
          await fixture.db.query<{ event_type: string }>(
            "SELECT event_type FROM engineering_stage_events WHERE event_type = 'STARTED'",
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await fixture.db.query<{ status: string }>(
            "SELECT completion->>'status' AS status FROM run_completions WHERE run_id = $1",
            [fixture.ids.runId],
          )
        ).rows[0]?.status,
      ).toBe("CANCELLED");
    });
  },
  available,
);
