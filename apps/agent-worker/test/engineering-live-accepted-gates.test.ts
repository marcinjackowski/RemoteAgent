import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { canonicalDigest, EngineeringStage } from "@remoteagent/contracts";
import type {
  EngineeringControlOperationCompletion,
  EngineeringControlOperationRow,
} from "@remoteagent/database";
import {
  VERIFICATION_GATE_SCHEMA_DIGEST,
  testEvidence,
  validateTrustedEvaluatorInputs,
  VerificationGateCatalog,
  VerificationGateClass,
  VerificationGateDefinition,
  VerificationGateOutcome,
  VerificationGateReceipt,
  VerificationGateTarget,
  verificationGateReceiptId,
} from "@remoteagent/test-evidence";
import { describe, expect, it } from "vitest";

import {
  projectAcceptedVerificationGates,
  type AcceptedGateScope,
} from "./engineering-live-accepted-gates.js";

const digest = (label: string): string => canonicalDigest({ fixture: label });
const contentDigest = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const scope: AcceptedGateScope = {
  caseId: "case-accepted-gates",
  workspaceId: "workspace-accepted-gates",
  runId: "run-accepted-gates",
  jobId: "job-accepted-gates",
};
const currentTreeDigest = digest("current-tree");
const baselineTreeDigest = digest("baseline-tree");

function reidentifyReceipt(
  receipt: ReturnType<typeof VerificationGateReceipt.parse>,
  patch: Partial<ReturnType<typeof VerificationGateReceipt.parse>>,
) {
  const { schema_version: _schema, receipt_id: _id, ...fields } = { ...receipt, ...patch };
  void _schema;
  void _id;
  return VerificationGateReceipt.parse({
    schema_version: 1,
    ...fields,
    receipt_id: verificationGateReceiptId(fields),
  });
}

async function fixture() {
  const executable = await realpath(process.execPath);
  const content = "import XCTest\nfinal class Probe: XCTestCase {}\n";
  const trustedInputs = {
    files: [
      {
        relative_path: "Tests/Probe.swift",
        content,
        content_digest: contentDigest(content),
      },
    ],
    required_executed_test_ids: ["Probe/Suite/testSafety()"],
  } as const;
  const definition = VerificationGateDefinition.parse({
    schema_version: 1,
    gate_id: "trusted-gate",
    gate_class: VerificationGateClass.TEST,
    executable,
    argv: ["-e", "process.exit(0)", "-only-testing:Probe/Suite/testSafety()"],
    relative_cwd: "Tests",
    required: true,
    baseline: true,
    test_first: true,
    timeout_ms: 10_000,
    environment_profile: "BUILD_TOOLCHAIN",
    network_profile: "PLATFORM_MANAGED",
    mutable_outputs: [],
    trusted_evaluator_inputs: trustedInputs,
  });
  const catalog = await VerificationGateCatalog.create({
    definitions: [definition],
    executable_allowlist: [executable],
  });
  const evaluatorDigest = validateTrustedEvaluatorInputs(
    definition.trusted_evaluator_inputs!,
  ).digest;

  const makeCompletion = (
    target: "BASELINE" | "CURRENT",
    completionId: string,
    outcome: "FAILED" | "PASSED",
  ): EngineeringControlOperationCompletion => {
    const treeDigest =
      target === VerificationGateTarget.CURRENT ? currentTreeDigest : baselineTreeDigest;
    const descriptor = {
      kind: "verification.gate.v1" as const,
      case_id: scope.caseId,
      workspace_id: scope.workspaceId,
      run_id: scope.runId,
      stage_attempt: 2,
      gate_id: definition.gate_id,
      target,
      tree_digest: treeDigest,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(definition.gate_id),
    };
    const operationId = `verification-gate-${canonicalDigest(descriptor).slice(7)}`;
    const evidence = testEvidence.parse({
      kind: "XCODE_TEST_RESULT_V1",
      tool: "xcresulttool",
      schema_version: "0.1.0",
      executed_test_ids: ["Probe/Suite/testSafety()"],
      executed_count: 1,
      failed_test_ids:
        outcome === VerificationGateOutcome.FAILED ? ["Probe/Suite/testSafety()"] : [],
      expected_suite_ids: ["Probe/Suite"],
      observed_suite_ids: ["Probe/Suite"],
      result_digest: digest(`result-${target}`),
    });
    const receiptFields = {
      case_id: scope.caseId,
      workspace_id: scope.workspaceId,
      run_id: scope.runId,
      operation_id: operationId,
      gate_id: definition.gate_id,
      target,
      tree_digest: treeDigest,
      config_digest: catalog.config_digest,
      command_digest: catalog.commandDigest(definition.gate_id),
      outcome,
      exit_code: outcome === "PASSED" ? 0 : 1,
      signal: null,
      duration_ms: 10,
      log_artifact: {
        artifact_id: `log-${target.toLowerCase()}`,
        scope: { case_id: scope.caseId, workspace_id: scope.workspaceId },
        relative_path: `logs/${target.toLowerCase()}.log`,
        digest: digest(`log-${target}`),
        byte_length: 0,
        complete: true,
        original_byte_length: 0,
      },
      log_digest: digest(`log-${target}`),
      test_evidence: evidence,
      trusted_evaluator_binding: {
        evaluator_inputs_digest: evaluatorDigest,
        evaluated_tree_digest: treeDigest,
      },
    } as const;
    const receipt = VerificationGateReceipt.parse({
      schema_version: 1,
      ...receiptFields,
      receipt_id: verificationGateReceiptId(receiptFields),
    });
    const operation: EngineeringControlOperationRow = {
      operation_id: operationId,
      intent_id: `intent-${target.toLowerCase()}`,
      idempotency_key: `idempotency-${target.toLowerCase()}`,
      job_id: scope.jobId!,
      case_id: scope.caseId,
      owner_id: "owner-accepted-gates",
      run_id: scope.runId,
      stage: EngineeringStage.GATE_EXECUTION,
      stage_attempt: 2,
      checkpoint_revision: 3,
      operation_kind: "engineering.verification.gate",
      effect_class: "COMMAND",
      integration_scope_digest: digest("scope"),
      input_digest: canonicalDigest(descriptor),
      config_digest: catalog.config_digest,
      schema_digest: VERIFICATION_GATE_SCHEMA_DIGEST,
      deadline_at: new Date(0),
      recorded_at: new Date(0),
    };
    return {
      operation,
      descriptor,
      started: true,
      completion_observed: true,
      completion: { completion_id: completionId, outcome: "SUCCEEDED", receipt },
    };
  };
  return {
    catalog,
    completions: [
      makeCompletion("BASELINE", "completion-baseline", "FAILED"),
      makeCompletion("CURRENT", "completion-current", "PASSED"),
    ],
  };
}

describe("accepted verification gate projection", () => {
  it("derives a canonical PASSED aggregate while retaining test-first IDs", async () => {
    const input = await fixture();
    const result = projectAcceptedVerificationGates({
      ...input,
      scope,
      stageAttempt: 2,
      currentTreeDigest,
      baselineTreeDigest,
      acceptedCompletionIds: ["completion-baseline", "completion-current"],
    });
    expect(result.aggregate.status).toBe("PASSED");
    expect(result.completionIds).toEqual(["completion-baseline", "completion-current"]);
    expect(result.testFirstCompletionIds).toEqual(["completion-baseline", "completion-current"]);
  });

  it.each([
    [
      "missing completion",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.slice(0, 1),
      }),
      "exactly match",
    ],
    [
      "duplicate completion ID",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) => ({
          ...item,
          completion:
            item.completion === null
              ? null
              : { ...item.completion, completion_id: "completion-current" },
        })),
      }),
      "completion ID set",
    ],
    [
      "unobserved",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) => ({ ...item, completion_observed: false })),
      }),
      "started and observed",
    ],
    [
      "not started",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) => ({ ...item, started: false })),
      }),
      "started and observed",
    ],
    [
      "missing durable completion",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) => ({ ...item, completion: null })),
      }),
      "not SUCCEEDED",
    ],
    [
      "failed command completion",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) => ({
          ...item,
          completion:
            item.completion === null ? null : { ...item.completion, outcome: "FAILED" as const },
        })),
      }),
      "not SUCCEEDED",
    ],
    [
      "tampered descriptor",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) =>
          item.descriptor.target !== VerificationGateTarget.BASELINE
            ? item
            : { ...item, descriptor: { ...item.descriptor, run_id: "foreign-run" } },
        ),
      }),
      "descriptor binding",
    ],
    [
      "foreign operation metadata",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: input.completions.map((item) => ({
          ...item,
          operation: { ...item.operation, case_id: "foreign-case" },
        })),
      }),
      "metadata binding",
    ],
    [
      "foreign history row",
      (input: Awaited<ReturnType<typeof fixture>>) => ({
        ...input,
        completions: [...input.completions, input.completions[0]!],
      }),
      "exactly match",
    ],
  ] as const)("rejects %s", async (_label, mutate, message) => {
    const input = await fixture();
    expect(() =>
      projectAcceptedVerificationGates({
        ...mutate(input),
        scope,
        stageAttempt: 2,
        currentTreeDigest,
        baselineTreeDigest,
        acceptedCompletionIds: ["completion-baseline", "completion-current"],
      }),
    ).toThrow(message);
  });

  it("rejects an accepted completion set that omits an expected ID", async () => {
    const input = await fixture();
    expect(() =>
      projectAcceptedVerificationGates({
        ...input,
        scope,
        stageAttempt: 2,
        currentTreeDigest,
        baselineTreeDigest,
        acceptedCompletionIds: ["completion-current"],
      }),
    ).toThrow(/completion IDs must exactly match/u);
  });

  it("rejects trusted evidence with a missing required executed ID", async () => {
    const input = await fixture();
    const current = input.completions[1]!;
    const receipt = VerificationGateReceipt.parse(current.completion!.receipt);
    const evidence = testEvidence.parse({
      ...receipt.test_evidence!,
      executed_test_ids: ["Probe/Suite/other()"],
      executed_count: 1,
    });
    const tampered = reidentifyReceipt(receipt, { test_evidence: evidence });
    expect(() =>
      projectAcceptedVerificationGates({
        ...input,
        completions: [
          input.completions[0]!,
          { ...current, completion: { ...current.completion!, receipt: tampered } },
        ],
        scope,
        stageAttempt: 2,
        currentTreeDigest,
        baselineTreeDigest,
        acceptedCompletionIds: ["completion-baseline", "completion-current"],
      }),
    ).toThrow("trusted evaluator required test is missing");
  });

  it("rejects trusted evidence with a foreign evaluator input digest", async () => {
    const input = await fixture();
    const current = input.completions[1]!;
    const receipt = VerificationGateReceipt.parse(current.completion!.receipt);
    const tampered = reidentifyReceipt(receipt, {
      trusted_evaluator_binding: {
        ...receipt.trusted_evaluator_binding!,
        evaluator_inputs_digest: digest("foreign-evaluator-inputs"),
      },
    });
    expect(() =>
      projectAcceptedVerificationGates({
        ...input,
        completions: [
          input.completions[0]!,
          { ...current, completion: { ...current.completion!, receipt: tampered } },
        ],
        scope,
        stageAttempt: 2,
        currentTreeDigest,
        baselineTreeDigest,
        acceptedCompletionIds: ["completion-baseline", "completion-current"],
      }),
    ).toThrow("trusted evaluator binding mismatch");
  });

  it("rejects an aggregate whose current receipt fails", async () => {
    const input = await fixture();
    const current = input.completions[1]!;
    const receipt = VerificationGateReceipt.parse(current.completion!.receipt);
    const failedEvidence = testEvidence.parse({
      ...receipt.test_evidence!,
      failed_test_ids: ["Probe/Suite/testSafety()"],
    });
    const failedFields = {
      case_id: receipt.case_id,
      workspace_id: receipt.workspace_id,
      run_id: receipt.run_id,
      operation_id: receipt.operation_id,
      gate_id: receipt.gate_id,
      target: receipt.target,
      tree_digest: receipt.tree_digest,
      config_digest: receipt.config_digest,
      command_digest: receipt.command_digest,
      outcome: "FAILED" as const,
      exit_code: 1,
      signal: receipt.signal,
      duration_ms: receipt.duration_ms,
      log_artifact: receipt.log_artifact,
      log_digest: receipt.log_digest,
      test_evidence: failedEvidence,
      trusted_evaluator_binding: receipt.trusted_evaluator_binding,
    };
    const failed = VerificationGateReceipt.parse({
      ...receipt,
      outcome: "FAILED",
      exit_code: 1,
      test_evidence: failedEvidence,
      receipt_id: verificationGateReceiptId({
        ...failedFields,
      }),
    });
    const changed = {
      ...current,
      completion: { ...current.completion!, receipt: failed },
    };
    expect(() =>
      projectAcceptedVerificationGates({
        ...input,
        completions: [input.completions[0]!, changed],
        scope,
        stageAttempt: 2,
        currentTreeDigest,
        baselineTreeDigest,
        acceptedCompletionIds: ["completion-baseline", "completion-current"],
      }),
    ).toThrow("accepted gate aggregate is not PASSED");
  });

  it("rejects a baseline receipt bound to the current tree", async () => {
    const input = await fixture();
    const baseline = input.completions[0]!;
    const receipt = VerificationGateReceipt.parse(baseline.completion!.receipt);
    const fields = {
      case_id: receipt.case_id,
      workspace_id: receipt.workspace_id,
      run_id: receipt.run_id,
      operation_id: receipt.operation_id,
      gate_id: receipt.gate_id,
      target: receipt.target,
      tree_digest: currentTreeDigest,
      config_digest: receipt.config_digest,
      command_digest: receipt.command_digest,
      outcome: receipt.outcome,
      exit_code: receipt.exit_code,
      signal: receipt.signal,
      duration_ms: receipt.duration_ms,
      log_artifact: receipt.log_artifact,
      log_digest: receipt.log_digest,
      test_evidence: receipt.test_evidence,
      trusted_evaluator_binding: {
        ...receipt.trusted_evaluator_binding!,
        evaluated_tree_digest: currentTreeDigest,
      },
    };
    const tampered = VerificationGateReceipt.parse({
      schema_version: 1,
      ...fields,
      receipt_id: verificationGateReceiptId(fields),
    });
    expect(() =>
      projectAcceptedVerificationGates({
        ...input,
        completions: [
          { ...baseline, completion: { ...baseline.completion!, receipt: tampered } },
          input.completions[1]!,
        ],
        scope,
        stageAttempt: 2,
        currentTreeDigest,
        baselineTreeDigest,
        acceptedCompletionIds: ["completion-baseline", "completion-current"],
      }),
    ).toThrow("receipt is bound to a foreign tree");
  });
});
