import { expect, it } from "vitest";
import {
  canonicalDigest,
  engineeringContextManifest,
  engineeringSliceContract,
  EngineeringStage,
  TrustLevel,
} from "@remoteagent/contracts";
import { createRuntimeConfig, FakeTransport } from "@remoteagent/model-runtime";
import { createStructuredEngineeringStageExecutor } from "../src/engineering-workflow.js";
import type { CompiledRoleContext } from "../src/context.js";

const digest = (x: string) => `sha256:${x.repeat(64)}`;
const context = {
  packet: "bounded context",
  packetBytes: 16,
  estimatedInputTokens: 4,
  cacheState: "NOT_OBSERVED" as const,
  snapshotDigest: canonicalDigest({ stage: EngineeringStage.SLICE_PLANNING }),
  compiled: {
    stage: EngineeringStage.SLICE_PLANNING,
    manifest: engineeringContextManifest.parse({
      schema_version: 1,
      artifact_kind: "ContextManifest",
      case_id: "case-1",
      run_id: "run-1",
      revision: 0,
      authority: "SERVER_OWNED",
      sources: [
        {
          source_id: "source-1",
          kind: "RAW_EVIDENCE",
          ref: "source-1",
          revision: 0,
          observed_at: "2026-08-26T00:00:00.000Z",
          digest: digest("a"),
          trust: TrustLevel.UNTRUSTED_DATA,
          freshness: "pinned to run",
          inclusion_reason: "stage policy",
          byte_budget: 64,
          full_artifact_ref: "source-1",
        },
      ],
      total_byte_budget: 64,
    }),
  },
} as unknown as CompiledRoleContext;
const config = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 1, maxCalls: 1 },
});
const constraints = {
  allowedPaths: ["src/clamp.mjs", "src/clamp.test.mjs"],
  allowedTestPaths: ["src/clamp.test.mjs"],
  requiredGateIds: ["gate-1"],
} as const;
const artifact = (testPath: string) =>
  engineeringSliceContract.parse({
    schema_version: 2,
    artifact_kind: "SliceContract",
    case_id: "case-1",
    run_id: "run-1",
    revision: 0,
    slice_id: "slice-1",
    objective: "bounded",
    observable_result: "result",
    allowed_paths: ["src/clamp.mjs", "src/clamp.test.mjs"],
    test_paths: [testPath],
    gate_ids: ["gate-1"],
    inspection_method: "inspect receipt",
    stop_condition: "stop",
  });

it("captures containment guidance and disjoint source/test scope", async () => {
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: artifact("src/clamp.test.mjs") }] },
  ]);
  const executor = createStructuredEngineeringStageExecutor({
    transport,
    config,
    slicePlanningConstraints: constraints,
  });
  await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.SLICE_PLANNING,
      attempt: 1,
    },
    objective: "bounded",
    context,
    orderedArtifacts: [],
    processClass: "SMALL",
  });
  const text = transport.requests[0]!.messages.flatMap((m) => m.content)
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
  expect(text).toContain("every test_paths entry must be contained by an allowed_paths entry");
  expect(text).toContain("src/clamp.mjs");
  expect(text).toContain("src/clamp.test.mjs");
  expect(text).toContain("permission ceiling, not a requirement to edit");
  expect(text).toContain("Never broaden config or per-slice scope");
});

it("rejects an authorized test file omitted from allowed_paths instead of silently widening scope", async () => {
  const invalid = { ...artifact("src/clamp.test.mjs"), allowed_paths: ["src/clamp.mjs"] };
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: invalid }] },
    { model: config.model, content: [{ type: "json", value: invalid }] },
  ]);
  const executor = createStructuredEngineeringStageExecutor({
    transport,
    config,
    slicePlanningConstraints: constraints,
  });
  await expect(
    executor.execute({
      binding: {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.SLICE_PLANNING,
        attempt: 1,
      },
      objective: "bounded",
      context,
      orderedArtifacts: [],
      processClass: "SMALL",
    }),
  ).rejects.toMatchObject({
    name: "StructuredContractOutputError",
    detailCode: "STRUCTURED_SCHEMA_INVALID:custom:test_paths.0",
  });
  expect(invalid.allowed_paths).toEqual(["src/clamp.mjs"]);
});

it("passes the same narrow containment instruction to ProgramDesign", async () => {
  const transport = new FakeTransport([]);
  const executor = createStructuredEngineeringStageExecutor({
    transport,
    config,
    slicePlanningConstraints: constraints,
  });
  await executor
    .execute({
      binding: {
        caseId: "case-1",
        workUnitId: "unit-1",
        runId: "run-1",
        checkpointRevision: 0,
        stage: EngineeringStage.PROGRAM_DESIGN,
        attempt: 1,
      },
      objective: "Only modify src/clamp.mjs",
      context,
      orderedArtifacts: [],
      processClass: "SMALL",
    })
    .catch(() => undefined);
  expect(transport.requests.length).toBeGreaterThan(0);
  const text = transport.requests[0]!.messages.flatMap((message) => message.content)
    .map((content) => (content.type === "text" ? content.text : ""))
    .join("\n");
  expect(text).toContain("Every test_paths entry must be contained by an allowed_paths entry");
  expect(text).toContain("src/clamp.mjs");
  expect(text).toContain("src/clamp.test.mjs");
  expect(text).toContain("Never broaden config or per-slice scope");
});
