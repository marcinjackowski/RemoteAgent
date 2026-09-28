import { canonicalDigest, EngineeringStage } from "@remoteagent/contracts";
import type { EngineeringControlOperationCompletion } from "@remoteagent/database";
import {
  VERIFICATION_GATE_SCHEMA_DIGEST,
  VerificationGateDeriveAggregate,
  VerificationGateStatus,
  VerificationGateTarget,
  VerificationGateReceipt,
  verificationGateDescriptor,
  verificationGateOperationId,
  type VerificationGateAggregate,
  type VerificationGateCatalog,
} from "@remoteagent/test-evidence";

export type AcceptedGateScope = Readonly<{
  caseId: string;
  workspaceId: string;
  runId: string;
  jobId?: string;
}>;

export type AcceptedGateProjection = Readonly<{
  aggregate: VerificationGateAggregate;
  receipts: readonly VerificationGateReceipt[];
  operationBindings: readonly Readonly<{
    gate_id: string;
    target: "CURRENT" | "BASELINE";
    operation_id: string;
  }>[];
  completionIds: readonly string[];
  testFirstCompletionIds: readonly string[];
}>;

function expectedDescriptors(input: {
  catalog: VerificationGateCatalog;
  scope: AcceptedGateScope;
  stageAttempt: number;
  currentTreeDigest: string;
  baselineTreeDigest?: string;
}): readonly Readonly<{
  descriptor: Record<string, unknown>;
  operationId: string;
  gateId: string;
  target: "CURRENT" | "BASELINE";
}>[] {
  return input.catalog.definitions
    .filter((definition) => definition.required)
    .flatMap((definition) => {
      const targets: readonly ("CURRENT" | "BASELINE")[] = definition.baseline
        ? [VerificationGateTarget.BASELINE, VerificationGateTarget.CURRENT]
        : [VerificationGateTarget.CURRENT];
      return targets.map((target) => {
        if (target === VerificationGateTarget.BASELINE && input.baselineTreeDigest === undefined) {
          throw new Error("baseline tree digest is required for baseline gates");
        }
        const descriptor = verificationGateDescriptor.parse({
          kind: "verification.gate.v1",
          case_id: input.scope.caseId,
          workspace_id: input.scope.workspaceId,
          run_id: input.scope.runId,
          stage_attempt: input.stageAttempt,
          gate_id: definition.gate_id,
          target,
          tree_digest:
            target === VerificationGateTarget.CURRENT
              ? input.currentTreeDigest
              : input.baselineTreeDigest,
          config_digest: input.catalog.config_digest,
          command_digest: input.catalog.commandDigest(definition.gate_id),
        });
        return {
          descriptor,
          operationId: verificationGateOperationId(descriptor),
          gateId: definition.gate_id,
          target,
        };
      });
    });
}

export const deriveExpectedVerificationGateDescriptors = expectedDescriptors;

/**
 * Projects only the accepted, observed gate completions into the existing
 * aggregate derivation.  This function never chooses a receipt or operation
 * from history: every expected operation and completion ID must be present.
 */
export function projectAcceptedVerificationGates(input: {
  catalog: VerificationGateCatalog;
  scope: AcceptedGateScope;
  stageAttempt: number;
  currentTreeDigest: string;
  baselineTreeDigest?: string;
  acceptedCompletionIds: readonly string[];
  completions: readonly EngineeringControlOperationCompletion[];
}): AcceptedGateProjection {
  if (!Number.isSafeInteger(input.stageAttempt) || input.stageAttempt <= 0) {
    throw new Error("accepted gate stage attempt must be a positive safe integer");
  }
  const expected = expectedDescriptors(input);
  const expectedByOperation = new Map(expected.map((entry) => [entry.operationId, entry]));
  const acceptedIds = new Set(input.acceptedCompletionIds);
  if (acceptedIds.size !== input.acceptedCompletionIds.length) {
    throw new Error("accepted gate completion IDs must be unique");
  }
  if (acceptedIds.size !== expected.length) {
    throw new Error("accepted gate completion IDs must exactly match expected operations");
  }
  if (input.completions.length !== expected.length) {
    throw new Error("accepted gate completions must exactly match catalog gate/targets");
  }

  const seenOperations = new Set<string>();
  const seenCompletionIds = new Set<string>();
  const receipts: VerificationGateReceipt[] = [];
  const completionByTarget = new Map<string, string>();
  for (const recovered of input.completions) {
    const operationId = recovered.operation.operation_id;
    const expectedEntry = expectedByOperation.get(operationId);
    if (expectedEntry === undefined || seenOperations.has(operationId)) {
      throw new Error("accepted gate completion set contains an unexpected or duplicate operation");
    }
    seenOperations.add(operationId);
    const descriptor = verificationGateDescriptor.parse(recovered.descriptor);
    if (
      canonicalDigest(descriptor) !== canonicalDigest(expectedEntry.descriptor) ||
      canonicalDigest(descriptor) !== recovered.operation.input_digest
    ) {
      throw new Error("accepted gate descriptor binding mismatch");
    }
    const operation = recovered.operation;
    if (
      operation.case_id !== input.scope.caseId ||
      operation.run_id !== input.scope.runId ||
      (input.scope.jobId !== undefined && operation.job_id !== input.scope.jobId) ||
      operation.stage !== EngineeringStage.GATE_EXECUTION ||
      operation.stage_attempt !== input.stageAttempt ||
      operation.operation_kind !== "engineering.verification.gate" ||
      operation.effect_class !== "COMMAND" ||
      operation.config_digest !== input.catalog.config_digest ||
      operation.schema_digest !== VERIFICATION_GATE_SCHEMA_DIGEST
    ) {
      throw new Error("accepted gate operation metadata binding mismatch");
    }
    if (!recovered.started || !recovered.completion_observed) {
      throw new Error("accepted gate completion was not started and observed");
    }
    const completion = recovered.completion;
    if (completion === null || completion.outcome !== "SUCCEEDED") {
      throw new Error("accepted gate completion is not SUCCEEDED");
    }
    if (
      !acceptedIds.has(completion.completion_id) ||
      seenCompletionIds.has(completion.completion_id)
    ) {
      throw new Error("accepted gate completion ID set does not match observed completions");
    }
    seenCompletionIds.add(completion.completion_id);
    const receipt = VerificationGateReceipt.parse(completion.receipt);
    if (receipt.gate_id !== expectedEntry.gateId || receipt.target !== expectedEntry.target) {
      throw new Error("accepted gate receipt target does not match its operation");
    }
    receipts.push(receipt);
    completionByTarget.set(
      `${expectedEntry.gateId}:${expectedEntry.target}`,
      completion.completion_id,
    );
  }
  if (
    seenOperations.size !== expected.length ||
    seenCompletionIds.size !== acceptedIds.size ||
    [...acceptedIds].some((id) => !seenCompletionIds.has(id))
  ) {
    throw new Error("accepted gate completion IDs must exactly match expected operations");
  }

  const operationBindings = expected.map((entry) => ({
    gate_id: entry.gateId,
    target: entry.target,
    operation_id: entry.operationId,
  }));
  const aggregate = VerificationGateDeriveAggregate({
    catalog: input.catalog,
    receipts,
    case_id: input.scope.caseId,
    workspace_id: input.scope.workspaceId,
    run_id: input.scope.runId,
    current_tree_digest: input.currentTreeDigest,
    ...(input.baselineTreeDigest === undefined
      ? {}
      : { baseline_tree_digest: input.baselineTreeDigest }),
    operation_bindings: operationBindings,
  });
  if (aggregate.status !== VerificationGateStatus.PASSED) {
    throw new Error("accepted gate aggregate is not PASSED");
  }
  const testFirstCompletionIds = expected
    .filter((entry) => input.catalog.get(entry.gateId)?.test_first)
    .map((entry) => completionByTarget.get(`${entry.gateId}:${entry.target}`)!);
  return {
    aggregate,
    receipts,
    operationBindings,
    completionIds: [...input.acceptedCompletionIds].sort(),
    testFirstCompletionIds: testFirstCompletionIds.sort(),
  };
}
