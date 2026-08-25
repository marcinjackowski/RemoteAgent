import * as z from "zod";

import { idString, isoTimestamp, text, valueObject, versionedContract } from "./common.js";
import { canonicalDigest } from "./canonical.js";
import { relativeRepositoryPath, sha256Digest } from "./repository-profile.js";
import { TrustLevel, trustLevelSchema } from "./trust.js";

const processClassValues = {
  SMALL: "SMALL",
  MEDIUM: "MEDIUM",
  LARGE_OR_HIGH_RISK: "LARGE_OR_HIGH_RISK",
} as const;
export type EngineeringProcessClass = (typeof processClassValues)[keyof typeof processClassValues];
export const engineeringProcessClass = z.enum([
  processClassValues.SMALL,
  processClassValues.MEDIUM,
  processClassValues.LARGE_OR_HIGH_RISK,
]);

export const EngineeringStage = {
  DISCOVERY: "DISCOVERY",
  OUTCOME_DEFINITION: "OUTCOME_DEFINITION",
  SYSTEM_DESIGN: "SYSTEM_DESIGN",
  PROGRAM_DESIGN: "PROGRAM_DESIGN",
  DESIGN_APPROVAL: "DESIGN_APPROVAL",
  SLICE_PLANNING: "SLICE_PLANNING",
  SLICE_IMPLEMENTATION: "SLICE_IMPLEMENTATION",
  GATE_EXECUTION: "GATE_EXECUTION",
  SLICE_REVIEW: "SLICE_REVIEW",
  MEMORY_PROJECTION: "MEMORY_PROJECTION",
  FINAL_VERIFICATION: "FINAL_VERIFICATION",
} as const;
export type EngineeringStage = (typeof EngineeringStage)[keyof typeof EngineeringStage];
export const engineeringStage = z.enum([
  EngineeringStage.DISCOVERY,
  EngineeringStage.OUTCOME_DEFINITION,
  EngineeringStage.SYSTEM_DESIGN,
  EngineeringStage.PROGRAM_DESIGN,
  EngineeringStage.DESIGN_APPROVAL,
  EngineeringStage.SLICE_PLANNING,
  EngineeringStage.SLICE_IMPLEMENTATION,
  EngineeringStage.GATE_EXECUTION,
  EngineeringStage.SLICE_REVIEW,
  EngineeringStage.MEMORY_PROJECTION,
  EngineeringStage.FINAL_VERIFICATION,
]);

const binding = { case_id: idString, run_id: idString, revision: z.int().nonnegative() };
const artifactBase = { ...binding };
const nonEmptyText = text.min(1).refine((value) => value.trim().length > 0, "must not be blank");
const digestList = z.array(sha256Digest).max(128);

export const engineeringOutcomeContract = versionedContract({
  artifact_kind: z.literal("OutcomeContract"),
  ...artifactBase,
  problem: nonEmptyText,
  outcome: nonEmptyText,
  non_goals: z.array(nonEmptyText).max(128),
  objective: nonEmptyText,
  success_criteria: z.array(nonEmptyText).min(1).max(128),
  constraints: z.array(nonEmptyText).max(128),
  process_class: engineeringProcessClass,
  source_digest: sha256Digest,
});

export const engineeringSystemDesign = versionedContract({
  artifact_kind: z.literal("SystemDesign"),
  ...artifactBase,
  boundaries: z.array(nonEmptyText).min(1).max(256),
  data: z.array(nonEmptyText).min(1).max(256),
  api: z.array(nonEmptyText).min(1).max(256),
  integrations: z.array(nonEmptyText).max(256),
  invariants: z.array(nonEmptyText).min(1).max(256),
  architecture: nonEmptyText,
  components: z.array(nonEmptyText).min(1).max(256),
  interfaces: z.array(nonEmptyText).min(1).max(256),
  data_flow: nonEmptyText,
  risks: z.array(nonEmptyText).max(128),
  source_digest: sha256Digest,
});

const programDesignShape = {
  artifact_kind: z.literal("ProgramDesign"),
  ...artifactBase,
  call_flow: z.array(nonEmptyText).min(1).max(256),
  file_tree_delta: z.array(nonEmptyText).min(1).max(512),
  key_types_and_signatures: z.array(nonEmptyText).min(1).max(512),
  uncertainty_review: z.array(nonEmptyText).min(1).max(256),
  expected_tests: z.array(nonEmptyText).min(1).max(256),
  slice_order: z.array(idString).min(1).max(256),
  source_digest: sha256Digest,
};
export const engineeringProgramDesign = versionedContract(programDesignShape);

const gateId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
export const engineeringGateId = gateId;
const noCommand = (value: string) =>
  !/^\s*(?:\$|sudo\b|(?:npm|pnpm|yarn|bun|git|make|xcodebuild|cargo|go)\b)/i.test(value);

export const engineeringSliceContract = versionedContract({
  artifact_kind: z.literal("SliceContract"),
  ...artifactBase,
  slice_id: idString,
  objective: nonEmptyText,
  observable_result: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.trim().length > 0, "must not be blank"),
  allowed_paths: z.array(relativeRepositoryPath).min(1).max(256),
  gate_ids: z.array(gateId).min(1).max(64),
  inspection_method: nonEmptyText.refine(noCommand, "must identify a method, not a raw command"),
  stop_condition: nonEmptyText.refine(noCommand, "must identify a condition, not a raw command"),
});

export const engineeringContextManifest = versionedContract({
  artifact_kind: z.literal("ContextManifest"),
  ...artifactBase,
  authority: z.literal("SERVER_OWNED"),
  sources: z
    .array(
      valueObject({
        source_id: idString,
        kind: z.enum(["RAW_EVIDENCE", "DURABLE_KNOWLEDGE", "WORKING_PROJECTION"]),
        ref: idString,
        revision: z.int().nonnegative(),
        observed_at: isoTimestamp,
        digest: sha256Digest,
        trust: trustLevelSchema,
        freshness: nonEmptyText,
        inclusion_reason: nonEmptyText,
        byte_budget: z.int().positive(),
        full_artifact_ref: idString,
      }),
    )
    .min(1)
    .max(256)
    .superRefine((sources, ctx) => {
      const ids = sources.map((source) => source.source_id);
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: "source_id values must be unique" });
      for (const [index, source] of sources.entries()) {
        if (source.kind === "WORKING_PROJECTION" && source.trust !== TrustLevel.UNTRUSTED_DATA)
          ctx.addIssue({
            code: "custom",
            path: [index, "trust"],
            message: "working projections are model-derived and must remain untrusted",
          });
      }
    }),
  total_byte_budget: z.int().positive(),
}).superRefine((manifest, ctx) => {
  if (
    manifest.sources.reduce((sum, source) => sum + source.byte_budget, 0) >
    manifest.total_byte_budget
  )
    ctx.addIssue({ code: "custom", message: "source byte budgets exceed total" });
});

const evidenceItem = valueObject({
  kind: idString,
  digest: sha256Digest,
  summary: nonEmptyText,
  trust: trustLevelSchema,
});
export const engineeringEvidenceBundle = versionedContract({
  artifact_kind: z.literal("EvidenceBundle"),
  ...artifactBase,
  authority: z.literal("SERVER_OWNED"),
  tree_digest: sha256Digest,
  config_digests: digestList.min(1),
  command_receipts: z.array(idString).min(1).max(256),
  diff_digest: sha256Digest,
  review_findings: z.array(nonEmptyText).max(256),
  decisions: z.array(idString).max(256),
  items: z.array(evidenceItem).min(1).max(512),
  context_digest: sha256Digest,
  test_first_evidence: z
    .array(
      valueObject({
        gate_id: engineeringGateId,
        baseline_tree_digest: sha256Digest,
        current_tree_digest: sha256Digest,
        baseline_outcome: z.enum(["FAILED", "INCONCLUSIVE"]),
        current_outcome: z.literal("PASSED"),
        receipt_ids: z.array(idString).min(2).max(64),
      }),
    )
    .max(256),
});

export const engineeringPhase = versionedContract({
  artifact_kind: z.literal("EngineeringPhase"),
  ...artifactBase,
  stage: engineeringStage,
  process_class: engineeringProcessClass,
  checkpoint_revision: z.int().nonnegative(),
  stage_attempt: z.int().positive(),
  active_slice_id: idString.nullable(),
  context_manifest_digest: sha256Digest,
  artifact_digests: digestList,
});
export type EngineeringPhase = z.infer<typeof engineeringPhase>;

export const engineeringMemoryUpdate = versionedContract({
  artifact_kind: z.literal("MemoryUpdate"),
  ...artifactBase,
  source_watermark: sha256Digest,
  evidence_digests: digestList.min(1),
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  authority: z.literal("MODEL_PROJECTION"),
  completed_requirements: z.array(idString).max(512),
  open_issues: z.array(nonEmptyText).max(512),
}).superRefine((update, ctx) => {
  if (update.completed_requirements.length === 0 && update.open_issues.length === 0)
    ctx.addIssue({ code: "custom", message: "memory update must contain projected state" });
});

const decisionBase = {
  artifact_kind: z.literal("DesignDecision"),
  ...artifactBase,
  decision_id: idString,
  rationale: nonEmptyText,
};
export const engineeringDesignDecision = versionedContract({
  ...decisionBase,
  decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]),
  artifact_digest: sha256Digest,
  findings: z.array(nonEmptyText).max(256),
  required_changes: z.array(nonEmptyText).max(256),
}).superRefine((v, ctx) => {
  if (v.decision === "APPROVE" && (v.findings.length || v.required_changes.length))
    ctx.addIssue({
      code: "custom",
      message: "APPROVE cannot contain findings or required changes",
    });
  if (v.decision === "REQUEST_CHANGES" && (!v.findings.length || !v.required_changes.length))
    ctx.addIssue({
      code: "custom",
      message: "REQUEST_CHANGES requires findings and required changes",
    });
  if (v.decision === "REJECT" && !v.findings.length)
    ctx.addIssue({ code: "custom", message: "REJECT requires findings" });
});
export const engineeringReviewDecision = versionedContract({
  artifact_kind: z.literal("ReviewDecision"),
  ...artifactBase,
  decision_id: idString,
  rationale: nonEmptyText,
  decision: z.enum(["PASS", "CHANGES_REQUIRED", "BLOCKED"]),
  findings: z.array(nonEmptyText).max(256),
  reviewed_digest: sha256Digest,
}).superRefine((v, ctx) => {
  if (v.decision === "PASS" && v.findings.length)
    ctx.addIssue({ code: "custom", message: "PASS cannot contain findings" });
  if (v.decision === "CHANGES_REQUIRED" && !v.findings.length)
    ctx.addIssue({ code: "custom", message: "CHANGES_REQUIRED requires findings" });
  if (v.decision === "BLOCKED" && !v.findings.length)
    ctx.addIssue({ code: "custom", message: "BLOCKED requires findings" });
});
export const engineeringVerificationDecision = versionedContract({
  artifact_kind: z.literal("VerificationDecision"),
  ...artifactBase,
  decision_id: idString,
  rationale: nonEmptyText,
  decision: z.enum(["VERIFIED", "FAILED", "INCONCLUSIVE"]),
  criterion_outcomes: z
    .array(
      valueObject({
        criterion_id: idString,
        status: z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]),
        evidence_digest: sha256Digest,
      }),
    )
    .min(1),
  evidence_digest: sha256Digest,
}).superRefine((v, ctx) => {
  if (
    v.decision === "VERIFIED" &&
    v.criterion_outcomes.some((outcome) => outcome.status !== "PASSED")
  )
    ctx.addIssue({ code: "custom", message: "VERIFIED requires every criterion to be PASSED" });
  if (
    v.decision === "FAILED" &&
    !v.criterion_outcomes.some((outcome) => outcome.status === "FAILED")
  )
    ctx.addIssue({ code: "custom", message: "FAILED requires a failed criterion" });
  if (
    v.decision === "INCONCLUSIVE" &&
    (v.criterion_outcomes.some((outcome) => outcome.status === "FAILED") ||
      !v.criterion_outcomes.some((outcome) => outcome.status === "INCONCLUSIVE"))
  )
    ctx.addIssue({
      code: "custom",
      message: "INCONCLUSIVE requires an inconclusive criterion and no failed criterion",
    });
});
export const engineeringTerminalReason = versionedContract({
  artifact_kind: z.literal("TerminalReason"),
  ...artifactBase,
  reason: z.enum([
    "COMPLETED",
    "CANCELLED",
    "BLOCKED",
    "FAILED",
    "AMBIGUOUS",
    "NEEDS_CLARIFICATION",
    "EXHAUSTED",
    "BASELINE_FAILED",
  ]),
  detail: nonEmptyText,
});

export type EngineeringOutcomeContract = z.infer<typeof engineeringOutcomeContract>;
export type EngineeringSystemDesign = z.infer<typeof engineeringSystemDesign>;
export type EngineeringProgramDesign = z.infer<typeof engineeringProgramDesign>;
export type EngineeringSliceContract = z.infer<typeof engineeringSliceContract>;
export type EngineeringContextManifest = z.infer<typeof engineeringContextManifest>;
export type EngineeringEvidenceBundle = z.infer<typeof engineeringEvidenceBundle>;
export type EngineeringMemoryUpdate = z.infer<typeof engineeringMemoryUpdate>;
export type EngineeringDesignDecision = z.infer<typeof engineeringDesignDecision>;
export type EngineeringReviewDecision = z.infer<typeof engineeringReviewDecision>;
export type EngineeringVerificationDecision = z.infer<typeof engineeringVerificationDecision>;
export type EngineeringTerminalReason = z.infer<typeof engineeringTerminalReason>;

export const engineeringArtifact = z.discriminatedUnion("artifact_kind", [
  engineeringOutcomeContract,
  engineeringPhase,
  engineeringSystemDesign,
  engineeringProgramDesign,
  engineeringSliceContract,
  engineeringContextManifest,
  engineeringEvidenceBundle,
  engineeringMemoryUpdate,
  engineeringDesignDecision,
  engineeringReviewDecision,
  engineeringVerificationDecision,
  engineeringTerminalReason,
]);
export type EngineeringArtifact = z.infer<typeof engineeringArtifact>;
export const engineeringArtifactSchema = engineeringArtifact;
export function engineeringArtifactDigest(input: unknown): string {
  return canonicalDigest(engineeringArtifact.parse(input));
}

const processRiskFactsShape = {
  security_or_policy: z.boolean(),
  migration: z.boolean(),
  irreversible_side_effect: z.boolean(),
  broad_public_contract_change: z.boolean(),
  multi_module: z.boolean(),
  new_architecture: z.boolean(),
  deterministic_oracle: z.boolean(),
  user_data: z.boolean(),
  concurrency: z.boolean(),
  external_side_effect: z.boolean(),
};
export const engineeringProcessRiskFacts = valueObject({
  authority: z.literal("SERVER_OWNED"),
  ...processRiskFactsShape,
});
export type EngineeringProcessRiskFacts = z.infer<typeof engineeringProcessRiskFacts>;

export function engineeringMinimumProcessClass(input: unknown): EngineeringProcessClass {
  const facts = engineeringProcessRiskFacts.parse(input);
  if (
    facts.security_or_policy ||
    facts.migration ||
    facts.irreversible_side_effect ||
    facts.broad_public_contract_change ||
    facts.user_data ||
    facts.concurrency ||
    facts.external_side_effect
  )
    return processClassValues.LARGE_OR_HIGH_RISK;
  if (facts.multi_module || facts.new_architecture || !facts.deterministic_oracle)
    return processClassValues.MEDIUM;
  return processClassValues.SMALL;
}
export class EngineeringProcessDowngradeError extends Error {
  public readonly proposed: EngineeringProcessClass;
  public readonly required: EngineeringProcessClass;
  public constructor(proposed: EngineeringProcessClass, required: EngineeringProcessClass) {
    super(`Process class ${proposed} is below deterministic minimum ${required}`);
    this.name = "EngineeringProcessDowngradeError";
    this.proposed = proposed;
    this.required = required;
  }
}
export function assertEngineeringProcessClassAllowed(
  proposedInput: unknown,
  factsInput: unknown,
): EngineeringProcessClass {
  const proposed = engineeringProcessClass.parse(proposedInput);
  const required = engineeringMinimumProcessClass(factsInput);
  const rank = { SMALL: 0, MEDIUM: 1, LARGE_OR_HIGH_RISK: 2 } as const;
  if (rank[proposed] < rank[required])
    throw new EngineeringProcessDowngradeError(proposed, required);
  return proposed;
}
