import { expect, it } from "vitest";
import {
  canonicalDigest,
  engineeringContextManifest,
  engineeringVerificationDecision,
  EngineeringStage,
  TrustLevel,
} from "@remoteagent/contracts";
import { createRuntimeConfig, FakeTransport } from "@remoteagent/model-runtime";
import { createStructuredEngineeringStageExecutor } from "../src/engineering-workflow.js";
import type { CompiledRoleContext } from "../src/context.js";

const digest = (x: string) => `sha256:${x.repeat(64)}`;
const context = {
  packet: "verification context",
  packetBytes: 20,
  estimatedInputTokens: 5,
  cacheState: "NOT_OBSERVED" as const,
  snapshotDigest: canonicalDigest("final-verification"),
  compiled: {
    stage: EngineeringStage.FINAL_VERIFICATION,
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
          freshness: "pinned",
          inclusion_reason: "verification",
          byte_budget: 32,
          full_artifact_ref: "source-1",
        },
      ],
      total_byte_budget: 32,
    }),
  },
} as unknown as CompiledRoleContext;
const config = createRuntimeConfig({
  model: { provider: "test", model_id: "model" },
  timeoutMs: 1_000,
  toolLimits: { maxIterations: 1, maxCalls: 1 },
});
const inconclusive = engineeringVerificationDecision.parse({
  schema_version: 1,
  artifact_kind: "VerificationDecision",
  case_id: "case-1",
  run_id: "run-1",
  revision: 0,
  decision_id: "verification-1",
  rationale: "evidence is inconclusive",
  decision: "INCONCLUSIVE",
  criterion_outcomes: [
    { criterion_id: "criterion-1", status: "INCONCLUSIVE", evidence_digest: digest("b") },
  ],
  evidence_digest: digest("c"),
});

it("gives final verification truthful pre-commit semantics and preserves INCONCLUSIVE", async () => {
  const transport = new FakeTransport([
    { model: config.model, content: [{ type: "json", value: inconclusive }] },
  ]);
  const executor = createStructuredEngineeringStageExecutor({ transport, config });
  const result = await executor.execute({
    binding: {
      caseId: "case-1",
      workUnitId: "unit-1",
      runId: "run-1",
      checkpointRevision: 0,
      stage: EngineeringStage.FINAL_VERIFICATION,
      attempt: 1,
    },
    objective: "verify product criteria",
    context,
    orderedArtifacts: [],
    processClass: "SMALL",
  });
  expect(result).toMatchObject({ kind: "ARTIFACT", artifact: inconclusive });
  const requestText = transport.requests[0]!.messages.flatMap((m) => m.content)
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n");
  expect(requestText).toContain("pre-commit product verification stage");
  expect(requestText).toContain("LOCAL_COMMIT occurs only afterward");
  expect(requestText).toContain("absence of test_first_evidence is not by itself a failure");
});
