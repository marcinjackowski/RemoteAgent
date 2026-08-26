import {
  assertEngineeringProcessClassAllowed,
  canonicalDigest,
  engineeringMinimumProcessClass,
  engineeringProcessClass,
  type ContractName,
  type EngineeringProcessClass,
  type EngineeringStage,
} from "@remoteagent/contracts";

import { engineeringProcessGraphs, type EngineeringProcessGraph } from "./registry.js";

const PROCESS_CLASS_RANK: Readonly<Record<EngineeringProcessClass, number>> = Object.freeze({
  SMALL: 0,
  MEDIUM: 1,
  LARGE_OR_HIGH_RISK: 2,
});

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;

export class EngineeringWorkflowPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EngineeringWorkflowPolicyError";
  }
}

export type EngineeringOwnerEscalation = Readonly<{
  authority: "OWNER_DECISION";
  decisionId: string;
  checkpointRevision: number;
  processClass: EngineeringProcessClass;
}>;

export type EngineeringWorkflowPlan = Readonly<{
  minimumProcessClass: EngineeringProcessClass;
  processClass: EngineeringProcessClass;
  ownerDecisionId: string | null;
  graph: EngineeringProcessGraph;
  stages: readonly import("@remoteagent/contracts").EngineeringStage[];
}>;

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new EngineeringWorkflowPolicyError(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new EngineeringWorkflowPolicyError(`${label} contains unknown or missing fields`);
  return record;
}

function safeRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new EngineeringWorkflowPolicyError(`${label} must be a non-negative safe integer`);
  return value as number;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new EngineeringWorkflowPolicyError(`${label} must be a bounded identifier`);
  return value;
}

function parseOwnerEscalation(
  value: unknown,
  checkpointRevision: number,
  selected: EngineeringProcessClass,
): EngineeringOwnerEscalation {
  const record = exactObject(
    value,
    ["authority", "decisionId", "checkpointRevision", "processClass"],
    "owner escalation",
  );
  if (record.authority !== "OWNER_DECISION")
    throw new EngineeringWorkflowPolicyError("owner escalation authority is not server-owned");
  const revision = safeRevision(record.checkpointRevision, "owner escalation checkpointRevision");
  if (revision !== checkpointRevision)
    throw new EngineeringWorkflowPolicyError("owner escalation checkpoint revision mismatch");
  const processClass = engineeringProcessClass.parse(record.processClass);
  if (PROCESS_CLASS_RANK[processClass] < PROCESS_CLASS_RANK[selected])
    throw new EngineeringWorkflowPolicyError("owner escalation cannot downgrade process class");
  return Object.freeze({
    authority: "OWNER_DECISION",
    decisionId: identifier(record.decisionId, "owner escalation decisionId"),
    checkpointRevision: revision,
    processClass,
  });
}

/** Builds immutable runtime policy from server-owned facts; neither model text nor artifacts vote. */
export function planEngineeringWorkflow(input: {
  readonly riskFacts: unknown;
  readonly proposedProcessClass?: unknown;
  readonly checkpointRevision: number;
  readonly ownerEscalation?: unknown;
}): EngineeringWorkflowPlan {
  const checkpointRevision = safeRevision(input.checkpointRevision, "checkpointRevision");
  const minimumProcessClass = engineeringMinimumProcessClass(input.riskFacts);
  let processClass = assertEngineeringProcessClassAllowed(
    input.proposedProcessClass ?? minimumProcessClass,
    input.riskFacts,
  );
  let ownerDecisionId: string | null = null;
  if (input.ownerEscalation !== undefined) {
    const escalation = parseOwnerEscalation(
      input.ownerEscalation,
      checkpointRevision,
      processClass,
    );
    processClass = escalation.processClass;
    ownerDecisionId = escalation.decisionId;
  }
  const graph = engineeringProcessGraphs[processClass];
  return Object.freeze({
    minimumProcessClass,
    processClass,
    ownerDecisionId,
    graph,
    stages: Object.freeze([
      ...graph.design_stages,
      ...graph.slice_loop_stages,
      ...graph.completion_stages,
    ]),
  });
}

export type EngineeringApprovalReason =
  | "MISSING_ARTIFACT"
  | "ARTIFACT_REVISION_MISMATCH"
  | "ARTIFACT_DIGEST_INVALID"
  | "UNRESOLVED_FINDINGS"
  | "GATES_NOT_PASSED"
  | "EVIDENCE_NOT_VERIFIED"
  | "AUTHORIZATION_MISSING"
  | "AUTHORIZATION_REVISION_MISMATCH";

export type EngineeringApprovalDisposition =
  | Readonly<{ disposition: "APPROVED"; authorizationId: string }>
  | Readonly<{ disposition: "BLOCKED"; reasons: readonly EngineeringApprovalReason[] }>;

export function evaluateEngineeringApproval(input: {
  readonly checkpointRevision: number;
  readonly requiredArtifactNames: readonly ContractName[];
  readonly artifacts: readonly Readonly<{
    name: ContractName;
    revision: number;
    digest: string;
  }>[];
  readonly unresolvedFindingIds: readonly string[];
  readonly gatesPassed: boolean;
  readonly evidenceVerified: boolean;
  /** Informational only. It can never grant authority. */
  readonly modelDisposition?: "APPROVE" | "REJECT" | "REQUEST_CHANGES";
  readonly authorization?: Readonly<{
    authority: "OWNER_DECISION" | "POLICY_GRANT";
    authorizationId: string;
    checkpointRevision: number;
  }>;
}): EngineeringApprovalDisposition {
  const revision = safeRevision(input.checkpointRevision, "checkpointRevision");
  const reasons = new Set<EngineeringApprovalReason>();
  for (const required of new Set(input.requiredArtifactNames)) {
    const artifact = input.artifacts.find((candidate) => candidate.name === required);
    if (!artifact) {
      reasons.add("MISSING_ARTIFACT");
      continue;
    }
    if (artifact.revision !== revision) reasons.add("ARTIFACT_REVISION_MISMATCH");
    if (!SHA256.test(artifact.digest)) reasons.add("ARTIFACT_DIGEST_INVALID");
  }
  if (input.unresolvedFindingIds.length > 0) reasons.add("UNRESOLVED_FINDINGS");
  if (!input.gatesPassed) reasons.add("GATES_NOT_PASSED");
  if (!input.evidenceVerified) reasons.add("EVIDENCE_NOT_VERIFIED");
  if (input.authorization === undefined) {
    reasons.add("AUTHORIZATION_MISSING");
  } else {
    const authorization = exactObject(
      input.authorization,
      ["authority", "authorizationId", "checkpointRevision"],
      "authorization",
    );
    if (authorization.authority !== "OWNER_DECISION" && authorization.authority !== "POLICY_GRANT")
      throw new EngineeringWorkflowPolicyError("authorization authority is not server-owned");
    identifier(authorization.authorizationId, "authorizationId");
    if (
      safeRevision(authorization.checkpointRevision, "authorization checkpointRevision") !==
      revision
    )
      reasons.add("AUTHORIZATION_REVISION_MISMATCH");
  }
  if (reasons.size > 0)
    return Object.freeze({ disposition: "BLOCKED", reasons: Object.freeze([...reasons].sort()) });
  return Object.freeze({
    disposition: "APPROVED",
    authorizationId: input.authorization!.authorizationId,
  });
}

export type EngineeringStructuralState = Readonly<{
  treeDigest: string;
  designRevisions: Readonly<Record<string, number>>;
  sliceRevision: number;
  failedGateIds: readonly string[];
  unresolvedFindingIds: readonly string[];
  /** Deliberately excluded from the fingerprint. */
  narrative?: string;
}>;

/** Only durable structural facts influence progress identity. */
export function engineeringStructuralFingerprint(state: EngineeringStructuralState): string {
  if (!SHA256.test(state.treeDigest))
    throw new EngineeringWorkflowPolicyError("treeDigest must be sha256");
  const designRevisions = Object.fromEntries(
    Object.entries(state.designRevisions)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, revision]) => [
        identifier(name, "design revision name"),
        safeRevision(revision, name),
      ]),
  );
  return canonicalDigest({
    tree_digest: state.treeDigest,
    design_revisions: designRevisions,
    slice_revision: safeRevision(state.sliceRevision, "sliceRevision"),
    failed_gate_ids: [
      ...new Set(state.failedGateIds.map((id) => identifier(id, "gate ID"))),
    ].sort(),
    unresolved_finding_ids: [
      ...new Set(state.unresolvedFindingIds.map((id) => identifier(id, "finding ID"))),
    ].sort(),
  });
}

export type EngineeringProgressDisposition =
  | "CONTINUE"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "STAGE_LIMIT_EXHAUSTED"
  | "CALL_LIMIT_EXHAUSTED"
  | "NO_PROGRESS"
  | "OSCILLATION";

/** Stateless, deterministic limits; the runtime owns and persists the supplied history. */
export function evaluateEngineeringProgress(input: {
  readonly fingerprints: readonly string[];
  readonly stageCalls: number;
  readonly maxStageCalls: number;
  readonly modelCalls: number;
  readonly maxModelCalls: number;
  readonly consecutiveRepeatLimit: number;
  readonly oscillationLimit: number;
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly cancelled: boolean;
}): EngineeringProgressDisposition {
  for (const [label, value] of Object.entries({
    stageCalls: input.stageCalls,
    maxStageCalls: input.maxStageCalls,
    modelCalls: input.modelCalls,
    maxModelCalls: input.maxModelCalls,
    consecutiveRepeatLimit: input.consecutiveRepeatLimit,
    oscillationLimit: input.oscillationLimit,
    nowMs: input.nowMs,
    deadlineMs: input.deadlineMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new EngineeringWorkflowPolicyError(`${label} must be a non-negative safe integer`);
  }
  if (
    input.maxStageCalls === 0 ||
    input.maxModelCalls === 0 ||
    input.consecutiveRepeatLimit === 0 ||
    input.oscillationLimit === 0
  )
    throw new EngineeringWorkflowPolicyError("progress limits must be positive");
  if (input.cancelled) return "CANCELLED";
  if (input.nowMs >= input.deadlineMs) return "DEADLINE_EXCEEDED";
  if (input.stageCalls >= input.maxStageCalls) return "STAGE_LIMIT_EXHAUSTED";
  if (input.modelCalls >= input.maxModelCalls) return "CALL_LIMIT_EXHAUSTED";

  const history = input.fingerprints;
  if (history.length >= input.consecutiveRepeatLimit + 1) {
    const tail = history.slice(-(input.consecutiveRepeatLimit + 1));
    if (tail.every((fingerprint) => fingerprint === tail[0])) return "NO_PROGRESS";
  }
  let oscillations = 0;
  for (let index = 2; index < history.length; index += 1) {
    if (history[index] === history[index - 2] && history[index] !== history[index - 1])
      oscillations += 1;
  }
  if (oscillations >= input.oscillationLimit) return "OSCILLATION";
  return "CONTINUE";
}

export type EngineeringStageBinding = Readonly<{
  caseId: string;
  workUnitId: string;
  runId: string;
  checkpointRevision: number;
  stage: EngineeringStage;
  attempt: number;
}>;

export type EngineeringStageEvidence = Readonly<{
  structuralState: EngineeringStructuralState;
  slice: EngineeringSliceLoopState;
  approval?: Parameters<typeof evaluateEngineeringApproval>[0];
}>;

export type EngineeringSliceDirective =
  "CONTINUE" | "NEXT_SLICE" | "CORRECT_SLICE" | "COMPLETE" | "STOP";

/** Server-derived projection of ordered durable artifacts; model text never selects a transition. */
export type EngineeringSliceLoopState = Readonly<{
  activeSliceId: string | null;
  expectedSliceId: string | null;
  completedSliceIds: readonly string[];
  directive: EngineeringSliceDirective;
}>;

export type EngineeringRecoveredStage =
  | Readonly<{ status: "NOT_STARTED" }>
  | Readonly<{ status: "RECOVERED"; evidence: EngineeringStageEvidence }>
  | Readonly<{ status: "AMBIGUOUS"; detail: string }>;

export type EngineeringStageCallResult =
  | Readonly<{ status: "COMPLETED"; evidence: EngineeringStageEvidence; modelCalls: number }>
  | Readonly<{ status: "WAITING_FOR_USER"; completion: unknown; modelCalls: number }>
  | Readonly<{ status: "TERMINAL"; completion: unknown; modelCalls: number }>;

export type EngineeringRuntimeStopCode =
  | "COMPLETED"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "STAGE_LIMIT_EXHAUSTED"
  | "CALL_LIMIT_EXHAUSTED"
  | "NO_PROGRESS"
  | "OSCILLATION"
  | "APPROVAL_BLOCKED"
  | "SLICE_BLOCKED";

export type EngineeringRuntimeSession = Readonly<{
  plan: EngineeringWorkflowPlan;
  fingerprints: readonly string[];
  stageCalls: number;
  maxStageCalls: number;
  modelCalls: number;
  maxModelCalls: number;
  consecutiveRepeatLimit: number;
  oscillationLimit: number;
  deadlineMs: number;
  cancelled: boolean;
}>;

/**
 * A single-stage durable port. It cannot choose transitions or run a workflow; SupervisorRuntime
 * owns the graph. `invokeAndRecord` must return only after its receipt/artifact is durable.
 */
export interface EngineeringRuntimePort {
  readonly open: (input: {
    readonly unit: import("../supervisor/runtime.js").RuntimeUnit;
    readonly run: import("../supervisor/runtime.js").RuntimeRun;
  }) => Promise<EngineeringRuntimeSession>;
  readonly recoverStage: (binding: EngineeringStageBinding) => Promise<EngineeringRecoveredStage>;
  readonly prepareContext: (binding: EngineeringStageBinding) => Promise<unknown>;
  readonly commitStarted: (binding: EngineeringStageBinding) => Promise<void>;
  readonly invokeAndRecord: (input: {
    readonly binding: EngineeringStageBinding;
    readonly context: unknown;
    readonly definition: import("./registry.js").EngineeringStageDefinition;
  }) => Promise<EngineeringStageCallResult>;
  readonly completion: (input: {
    readonly unit: import("../supervisor/runtime.js").RuntimeUnit;
    readonly run: import("../supervisor/runtime.js").RuntimeRun;
    readonly code: EngineeringRuntimeStopCode;
    readonly detail: string;
  }) => Promise<unknown>;
}
