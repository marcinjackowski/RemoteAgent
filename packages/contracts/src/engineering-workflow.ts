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

export const engineeringWriteAuthorizationScopeV1 = z.strictObject({
  schema_version: z.literal(1),
  purpose: z.literal("ENGINEERING_WORKFLOW_WRITE"),
  case_id: idString,
  owner_id: idString,
  checkpoint_revision: z.int().nonnegative(),
  work_unit_id: idString,
  run_id: idString,
  process_class: engineeringProcessClass,
  authoritative_scope: z.strictObject({
    connection_ids: z.array(idString).max(64),
    repo_allowlist: z.array(idString).max(64),
    can_write_workspace: z.literal(true),
  }),
});

const engineeringWriteAuthorizationScopeV2Base = z.strictObject({
  schema_version: z.literal(2),
  purpose: z.literal("ENGINEERING_WORKFLOW_WRITE"),
  case_id: idString,
  owner_id: idString,
  checkpoint_revision: z.int().nonnegative(),
  work_unit_id: idString,
  run_id: idString,
  process_class: engineeringProcessClass,
  authoritative_scope: z.strictObject({
    connection_ids: z.array(idString).max(64),
    repo_allowlist: z.array(idString).max(64),
    can_write_workspace: z.literal(true),
  }),
  repository_id: idString,
  write_path_allowlist: z.array(relativeRepositoryPath).min(1).max(256),
  deployment_policy_digest: sha256Digest,
});

const engineeringWriteDeploymentPolicyV1Base = z.strictObject({
  schema_version: z.literal(1),
  purpose: z.literal("ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY"),
  repository_id: idString,
  write_path_allowlist: z.array(relativeRepositoryPath).min(1).max(256),
});

const engineeringExecutionConfigV2PolicyProjection = z.strictObject({
  schema_version: z.literal(2),
  workspace_root: z.string().trim().min(1),
  baseline_root: z.string().trim().min(1),
  artifact_root: z.string().trim().min(1),
  repository: z.strictObject({
    repository_id: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/u),
    source_path: z.string().trim().min(1),
    base_branch: z.string().trim().min(1),
    write_path_allowlist: z.array(relativeRepositoryPath).min(1).max(256),
  }),
  gates: z.array(z.unknown()),
  executable_allowlist: z.array(z.string().trim().min(1)),
});

const engineeringExecutionConfigV3PolicyProjection = z.strictObject({
  schema_version: z.literal(3),
  workspace_root: z.string().trim().min(1),
  baseline_root: z.string().trim().min(1),
  artifact_root: z.string().trim().min(1),
  repository: z.strictObject({
    repository_id: z
      .string()
      .trim()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/u),
    source_path: z.string().trim().min(1),
    base_branch: z.string().trim().min(1),
    write_path_allowlist: z.array(relativeRepositoryPath).min(1).max(256),
    test_path_allowlist: z.array(relativeRepositoryPath).min(1).max(256),
  }),
  gates: z.array(z.unknown()),
  executable_allowlist: z.array(z.string().trim().min(1)),
  generators: z.array(z.unknown()).optional(),
});

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isCanonicalList(values: readonly string[]): boolean {
  const canonical = uniqueSorted(values);
  return (
    canonical.length === values.length && canonical.every((value, index) => value === values[index])
  );
}

/** Server deployment's independent repository/path ceiling. */
export const engineeringWriteDeploymentPolicyV1 =
  engineeringWriteDeploymentPolicyV1Base.superRefine((policy, ctx) => {
    if (!isCanonicalList(policy.write_path_allowlist)) {
      ctx.addIssue({
        code: "custom",
        path: ["write_path_allowlist"],
        message: "must be unique and sorted",
      });
    }
  });

type ParsedEngineeringWriteDeploymentPolicyV1 = z.infer<typeof engineeringWriteDeploymentPolicyV1>;
export type EngineeringWriteDeploymentPolicyV1 = Readonly<
  Omit<ParsedEngineeringWriteDeploymentPolicyV1, "write_path_allowlist"> & {
    readonly write_path_allowlist: readonly string[];
  }
>;

/** Canonicalize the deployment ceiling before it is compared or digested. */
export function normalizeEngineeringWriteDeploymentPolicyV1(
  input: unknown,
): Readonly<EngineeringWriteDeploymentPolicyV1> {
  const parsed = engineeringWriteDeploymentPolicyV1Base.parse(input);
  const normalized = engineeringWriteDeploymentPolicyV1.parse({
    ...parsed,
    write_path_allowlist: uniqueSorted(parsed.write_path_allowlist),
  });
  return Object.freeze({
    ...normalized,
    write_path_allowlist: Object.freeze([...normalized.write_path_allowlist]),
  });
}

/** Always derive the policy digest from the strict normalized deployment document. */
export function engineeringWriteDeploymentPolicyV1Digest(input: unknown): string {
  return canonicalDigest(normalizeEngineeringWriteDeploymentPolicyV1(input));
}

/**
 * Project the one authority-bearing subset of production execution config v2.
 *
 * Both deployment processes call this exact helper. The Discord process need not mount or
 * canonicalize the worker's repository/workspace directories, while the worker still performs
 * that full operational validation before executing. No caller-provided digest is accepted.
 */
export function engineeringWriteDeploymentPolicyFromExecutionConfigV2(
  input: unknown,
): Readonly<EngineeringWriteDeploymentPolicyV1> {
  const config = engineeringExecutionConfigV2PolicyProjection.parse(input);
  return normalizeEngineeringWriteDeploymentPolicyV1({
    schema_version: 1,
    purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
    repository_id: config.repository.repository_id,
    write_path_allowlist: config.repository.write_path_allowlist,
  });
}

/** V3 adds a code-owned test-root subset without changing the write authorization scope. */
export function engineeringWriteDeploymentPolicyFromExecutionConfigV3(
  input: unknown,
): Readonly<EngineeringWriteDeploymentPolicyV1> {
  const config = engineeringExecutionConfigV3PolicyProjection.parse(input);
  return normalizeEngineeringWriteDeploymentPolicyV1({
    schema_version: 1,
    purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
    repository_id: config.repository.repository_id,
    write_path_allowlist: config.repository.write_path_allowlist,
  });
}

/**
 * Exact engineering approval scope used by the dedicated proposal ingress.
 *
 * V1 remains unchanged for legacy durable grants. V2 adds the production repository and path
 * ceiling plus a digest of the server-owned deployment policy. The duplicated repository id is
 * intentional: it makes both the work-unit authority and the deployment ceiling explicit, and the
 * refinement requires them to be the same singleton.
 */
export const engineeringWriteAuthorizationScopeV2 =
  engineeringWriteAuthorizationScopeV2Base.superRefine((scope, ctx) => {
    if (
      scope.authoritative_scope.repo_allowlist.length !== 1 ||
      scope.authoritative_scope.repo_allowlist[0] !== scope.repository_id
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["repository_id"],
        message: "repository_id must equal the exact authoritative repo_allowlist singleton",
      });
    }
    const expectedDeploymentPolicyDigest = engineeringWriteDeploymentPolicyV1Digest({
      schema_version: 1,
      purpose: "ENGINEERING_WORKFLOW_WRITE_DEPLOYMENT_POLICY",
      repository_id: scope.repository_id,
      write_path_allowlist: scope.write_path_allowlist,
    });
    if (scope.deployment_policy_digest !== expectedDeploymentPolicyDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["deployment_policy_digest"],
        message: "must match the canonical server-owned repository/path deployment policy",
      });
    }
    for (const [path, values] of [
      [["authoritative_scope", "connection_ids"], scope.authoritative_scope.connection_ids],
      [["authoritative_scope", "repo_allowlist"], scope.authoritative_scope.repo_allowlist],
      [["write_path_allowlist"], scope.write_path_allowlist],
    ] as const) {
      if (!isCanonicalList(values)) {
        ctx.addIssue({ code: "custom", path: [...path], message: "must be unique and sorted" });
      }
    }
  });

type ParsedEngineeringWriteAuthorizationScopeV2 = z.infer<
  typeof engineeringWriteAuthorizationScopeV2
>;
export type EngineeringWriteAuthorizationScopeV2 = Readonly<
  Omit<
    ParsedEngineeringWriteAuthorizationScopeV2,
    "authoritative_scope" | "write_path_allowlist"
  > & {
    readonly authoritative_scope: Readonly<{
      readonly connection_ids: readonly string[];
      readonly repo_allowlist: readonly string[];
      readonly can_write_workspace: true;
    }>;
    readonly write_path_allowlist: readonly string[];
  }
>;

/** Canonicalize every set-like V2 field before deriving authority. */
export function normalizeEngineeringWriteAuthorizationScopeV2(
  input: unknown,
): Readonly<EngineeringWriteAuthorizationScopeV2> {
  const parsed = engineeringWriteAuthorizationScopeV2Base.parse(input);
  const normalized = engineeringWriteAuthorizationScopeV2.parse({
    ...parsed,
    authoritative_scope: {
      connection_ids: uniqueSorted(parsed.authoritative_scope.connection_ids),
      repo_allowlist: uniqueSorted(parsed.authoritative_scope.repo_allowlist),
      can_write_workspace: true as const,
    },
    write_path_allowlist: uniqueSorted(parsed.write_path_allowlist),
  });
  return Object.freeze({
    ...normalized,
    authoritative_scope: Object.freeze({
      ...normalized.authoritative_scope,
      connection_ids: Object.freeze([...normalized.authoritative_scope.connection_ids]),
      repo_allowlist: Object.freeze([...normalized.authoritative_scope.repo_allowlist]),
    }),
    write_path_allowlist: Object.freeze([...normalized.write_path_allowlist]),
  });
}

/** Digest for the V2 scope only; the legacy V1 digest/parser is deliberately unchanged. */
export function engineeringWriteAuthorizationScopeV2Digest(input: unknown): string {
  return canonicalDigest(normalizeEngineeringWriteAuthorizationScopeV2(input));
}

/** Strict owner-visible proposal. Authority is carried only by its server-owned V2 scope. */
export const engineeringWriteProposalV1 = z
  .strictObject({
    schema_version: z.literal(1),
    proposal_id: idString,
    objective: text
      .min(1)
      .max(8_192)
      .refine((value) => value.trim().length > 0, "must not be blank"),
    authorization_scope: engineeringWriteAuthorizationScopeV2,
    action_digest: sha256Digest,
    expires_at: isoTimestamp,
  })
  .superRefine((proposal, ctx) => {
    if (
      proposal.action_digest !==
      engineeringWriteAuthorizationScopeV2Digest(proposal.authorization_scope)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["action_digest"],
        message: "action_digest must match the canonical V2 authorization scope",
      });
    }
  });

export type EngineeringWriteProposalV1 = Readonly<z.infer<typeof engineeringWriteProposalV1>>;

type ParsedEngineeringWriteAuthorizationScopeV1 = z.infer<
  typeof engineeringWriteAuthorizationScopeV1
>;
export type EngineeringWriteAuthorizationScopeV1 = Readonly<
  Omit<ParsedEngineeringWriteAuthorizationScopeV1, "authoritative_scope"> & {
    readonly authoritative_scope: Readonly<{
      readonly connection_ids: readonly string[];
      readonly repo_allowlist: readonly string[];
      readonly can_write_workspace: true;
    }>;
  }
>;

/** Canonical server-owned approval scope; caller ordering and duplicates add no authority. */
export function normalizeEngineeringWriteAuthorizationScope(
  input: unknown,
): Readonly<EngineeringWriteAuthorizationScopeV1> {
  const parsed = engineeringWriteAuthorizationScopeV1.parse(input);
  return Object.freeze({
    ...parsed,
    authoritative_scope: Object.freeze({
      connection_ids: Object.freeze(uniqueSorted(parsed.authoritative_scope.connection_ids)),
      repo_allowlist: Object.freeze(uniqueSorted(parsed.authoritative_scope.repo_allowlist)),
      can_write_workspace: true as const,
    }),
  });
}

/** Always recomputes the digest from the normalized strict scope. */
export function engineeringWriteAuthorizationScopeDigest(input: unknown): string {
  return canonicalDigest(normalizeEngineeringWriteAuthorizationScope(input));
}

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
  LOCAL_COMMIT: "LOCAL_COMMIT",
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
  EngineeringStage.LOCAL_COMMIT,
]);

export const engineeringRecoveryClassification = z.enum([
  "RETRY_MODEL",
  "RETRY_READ_ONLY",
  "REPAIR_ARTIFACT_COMPLETION",
  "REPAIR_COMPLETION",
  "REPAIR_OBSERVATION",
  "RECOVER_GATE_RECEIPTS",
  "OBSERVE_LOCAL_COMMIT",
  "CONTINUE_NEXT_STAGE",
  "AMBIGUOUS",
  "BLOCKED",
  "CANCELLED",
]);

/**
 * Server-owned decision envelope for one exact cross-fence recovery lease.
 * Context digests are mandatory whenever an operation exists, so a retry cannot
 * silently compile or render a different packet after a process restart.
 */
export const engineeringRecoveryPlanV1 = z
  .strictObject({
    schema_version: z.literal(1),
    recovery_id: idString,
    root_recovery_id: idString,
    source_job_id: idString,
    source_fencing_token: z.int().positive(),
    recovery_job_id: idString,
    recovery_fencing_token: z.int().positive(),
    case_id: idString,
    owner_id: idString,
    work_unit_id: idString,
    run_id: idString,
    checkpoint_revision: z.int().nonnegative(),
    repository_id: idString,
    workflow_deadline_at: isoTimestamp,
    classification: engineeringRecoveryClassification,
    operation: z
      .strictObject({
        operation_id: idString,
        intent_id: idString,
        stage: engineeringStage,
        stage_attempt: z.int().positive(),
        effect_class: z.enum(["READ_ONLY", "MODEL_CALL", "COMMAND", "MUTATING_SIDE_EFFECT"]),
        input_digest: sha256Digest,
        config_digest: sha256Digest,
        schema_digest: sha256Digest,
        scope_digest: sha256Digest,
        deadline_at: isoTimestamp,
        context_manifest_digest: sha256Digest,
        context_snapshot_digest: sha256Digest,
        context_packet_digest: sha256Digest,
      })
      .nullable(),
    evidence_digest: sha256Digest,
    budget_reservation: z.strictObject({
      stage_attempts: z.int().nonnegative(),
      model_calls: z.int().nonnegative(),
      input_tokens: z.int().nonnegative(),
      output_tokens: z.int().nonnegative(),
    }),
  })
  .superRefine((value, context) => {
    const operation = value.operation;
    const requiresOperation = [
      "RETRY_MODEL",
      "RETRY_READ_ONLY",
      "REPAIR_ARTIFACT_COMPLETION",
      "REPAIR_COMPLETION",
      "REPAIR_OBSERVATION",
      "RECOVER_GATE_RECEIPTS",
      "OBSERVE_LOCAL_COMMIT",
    ].includes(value.classification);
    if (requiresOperation && operation === null) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: `${value.classification} requires an exact source operation`,
      });
      return;
    }
    if (value.classification === "RETRY_MODEL" && operation?.effect_class !== "MODEL_CALL") {
      context.addIssue({
        code: "custom",
        path: ["operation", "effect_class"],
        message: "RETRY_MODEL requires MODEL_CALL",
      });
    }
    if (value.classification === "RETRY_READ_ONLY" && operation?.effect_class !== "READ_ONLY") {
      context.addIssue({
        code: "custom",
        path: ["operation", "effect_class"],
        message: "RETRY_READ_ONLY requires READ_ONLY",
      });
    }
    if (value.classification === "RECOVER_GATE_RECEIPTS" && operation?.stage !== "GATE_EXECUTION") {
      context.addIssue({
        code: "custom",
        path: ["operation", "stage"],
        message: "RECOVER_GATE_RECEIPTS requires GATE_EXECUTION",
      });
    }
    if (
      value.classification === "OBSERVE_LOCAL_COMMIT" &&
      (operation?.stage !== "LOCAL_COMMIT" || operation.effect_class !== "MUTATING_SIDE_EFFECT")
    ) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: "OBSERVE_LOCAL_COMMIT requires a mutating LOCAL_COMMIT operation",
      });
    }
  });
export type EngineeringRecoveryPlanV1 = Readonly<z.infer<typeof engineeringRecoveryPlanV1>>;

export function engineeringRecoveryPlanV1Digest(input: unknown): string {
  return canonicalDigest(engineeringRecoveryPlanV1.parse(input));
}

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

const programDesignV1Shape = {
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
const engineeringProgramDesignV1 = versionedContract(programDesignV1Shape).superRefine(
  (design, ctx) => {
    if (new Set(design.slice_order).size !== design.slice_order.length)
      ctx.addIssue({
        code: "custom",
        path: ["slice_order"],
        message: "slice_order must contain unique slice identities",
      });
  },
);

const gateId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/);
export const engineeringGateId = gateId;
const noCommand = (value: string) =>
  !/^\s*(?:\$|sudo\b|(?:npm|pnpm|yarn|bun|git|make|xcodebuild|cargo|go)\b)/i.test(value);

function pathWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function addUniqueListIssue(values: readonly string[], path: string, ctx: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: "custom", path: [path], message: `${path} must contain unique values` });
  }
}

function validateSliceScope(
  value: Readonly<{
    allowed_paths: readonly string[];
    test_paths: readonly string[];
    gate_ids: readonly string[];
  }>,
  ctx: z.RefinementCtx,
): void {
  addUniqueListIssue(value.allowed_paths, "allowed_paths", ctx);
  addUniqueListIssue(value.test_paths, "test_paths", ctx);
  addUniqueListIssue(value.gate_ids, "gate_ids", ctx);
  for (const [index, testPath] of value.test_paths.entries()) {
    if (!value.allowed_paths.some((root) => pathWithinRoot(testPath, root))) {
      ctx.addIssue({
        code: "custom",
        path: ["test_paths", index],
        message: "test path must be contained by an allowed path",
      });
    }
  }
}

export const engineeringSliceBlueprint = valueObject({
  slice_id: idString,
  objective: nonEmptyText,
  observable_result: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.trim().length > 0, "must not be blank"),
  allowed_paths: z.array(relativeRepositoryPath).min(1).max(256),
  test_paths: z.array(relativeRepositoryPath).min(1).max(16),
  gate_ids: z.array(gateId).min(1).max(64),
  inspection_method: nonEmptyText.refine(noCommand, "must identify a method, not a raw command"),
  stop_condition: nonEmptyText.refine(noCommand, "must identify a condition, not a raw command"),
}).superRefine(validateSliceScope);

export const engineeringProgramDesign = z
  .strictObject({
    schema_version: z.literal(2),
    ...programDesignV1Shape,
    slice_blueprints: z.array(engineeringSliceBlueprint).min(1).max(32),
  })
  .superRefine((design, ctx) => {
    if (new Set(design.slice_order).size !== design.slice_order.length) {
      ctx.addIssue({
        code: "custom",
        path: ["slice_order"],
        message: "slice_order must contain unique slice identities",
      });
    }
    const blueprintOrder = design.slice_blueprints.map((blueprint) => blueprint.slice_id);
    if (new Set(blueprintOrder).size !== blueprintOrder.length) {
      ctx.addIssue({
        code: "custom",
        path: ["slice_blueprints"],
        message: "slice blueprints must contain unique slice identities",
      });
    }
    if (
      blueprintOrder.length !== design.slice_order.length ||
      blueprintOrder.some((sliceId, index) => sliceId !== design.slice_order[index])
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["slice_order"],
        message: "slice_order must exactly match ordered slice_blueprints",
      });
    }
  });

const sliceContractV1Shape = {
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
};
const engineeringSliceContractV1 = versionedContract(sliceContractV1Shape);

export const engineeringSliceContract = z
  .strictObject({
    schema_version: z.literal(2),
    ...sliceContractV1Shape,
    test_paths: z.array(relativeRepositoryPath).min(1).max(16),
  })
  .superRefine(validateSliceScope);

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

const engineeringCompilerDiagnostic = valueObject({
  path: relativeRepositoryPath,
  line: z.int().positive(),
  column: z.int().positive(),
  message: z.string().trim().min(1).max(2048),
  excerpt: z.string().trim().min(1).max(4096),
  digest: sha256Digest,
}).superRefine((diagnostic, ctx) => {
  const expected = canonicalDigest({
    path: diagnostic.path,
    line: diagnostic.line,
    column: diagnostic.column,
    message: diagnostic.message,
    excerpt: diagnostic.excerpt,
  });
  if (diagnostic.digest !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["digest"],
      message: "compiler diagnostic digest mismatch",
    });
  }
});

export type EngineeringCompilerDiagnostic = z.infer<typeof engineeringCompilerDiagnostic>;

const engineeringXcodeTestDiagnostic = valueObject({
  test_name: z.string().trim().min(1).max(1024),
  message: z.string().trim().min(1).max(4096),
  path: relativeRepositoryPath.nullable(),
  line: z.int().positive().nullable(),
  digest: sha256Digest,
}).superRefine((diagnostic, ctx) => {
  if ((diagnostic.path === null) !== (diagnostic.line === null)) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: "Xcode test diagnostic path and line must be present together",
    });
  }
  const expected = canonicalDigest({
    test_name: diagnostic.test_name,
    message: diagnostic.message,
    path: diagnostic.path,
    line: diagnostic.line,
  });
  if (diagnostic.digest !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["digest"],
      message: "Xcode test diagnostic digest mismatch",
    });
  }
});

export type EngineeringXcodeTestDiagnostic = z.infer<typeof engineeringXcodeTestDiagnostic>;

const engineeringGateFailureDiagnostic = valueObject({
  gate_id: idString,
  outcome: z.enum(["FAILED", "TIMED_OUT", "INFRASTRUCTURE"]),
  log_digest: sha256Digest.nullable(),
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  excerpt: z.string().trim().min(1).max(16_384),
  /** Present on newly-created compiler failures; absent only on legacy durable artifacts. */
  compiler_diagnostics: z.array(engineeringCompilerDiagnostic).max(32).optional(),
  /** Present on newly-created Xcode test failures; absent only on legacy durable artifacts. */
  test_diagnostics: z.array(engineeringXcodeTestDiagnostic).max(32).optional(),
});

/** Durable, bounded feedback for a retryable required-gate assertion failure. */
export const engineeringGateFailureV1 = versionedContract({
  artifact_kind: z.literal("GateFailure"),
  ...artifactBase,
  authority: z.literal("SERVER_OWNED"),
  slice_id: idString,
  attempt: z.int().positive(),
  tree_digest: sha256Digest,
  diff_digest: sha256Digest,
  context_digest: sha256Digest,
  config_digest: sha256Digest,
  blocking_gate_ids: z.array(idString).min(1).max(128),
  receipt_ids: z.array(idString).min(1).max(256),
  decision_ids: z.array(idString).max(256),
  diagnostics: z.array(engineeringGateFailureDiagnostic).min(1).max(8),
}).superRefine((failure, ctx) => {
  for (const [field, values] of [
    ["blocking_gate_ids", failure.blocking_gate_ids],
    ["receipt_ids", failure.receipt_ids],
    ["decision_ids", failure.decision_ids],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must be unique` });
    }
  }
  if (
    new Set(failure.diagnostics.map((item) => item.gate_id)).size !== failure.diagnostics.length
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["diagnostics"],
      message: "gate diagnostics must be unique",
    });
  }
  for (const diagnostic of failure.diagnostics) {
    if (!failure.blocking_gate_ids.includes(diagnostic.gate_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "diagnostic gate must be blocking",
      });
    }
  }
});

/**
 * Historical GateFailure parser.  Keep this named export as the v1 parser so
 * durable revisions can continue to be read without being reinterpreted.
 */
export const engineeringGateFailureClass = z.enum([
  "ASSERTION_FAILED",
  "COMPILE_FAILED",
  "TEST_DISCOVERY_FAILED",
  "INFRASTRUCTURE",
  "UNKNOWN",
]);
export type EngineeringGateFailureClass = z.infer<typeof engineeringGateFailureClass>;

export const engineeringGateFailureObservation = z
  .strictObject({
    criterion_id: idString,
    gate_id: idString,
    failure_class: engineeringGateFailureClass,
    evidence_ref: idString,
    related_target_ids: z.array(idString).min(1).max(256).readonly(),
  })
  .readonly();

export type EngineeringGateFailureObservation = Readonly<
  Omit<z.infer<typeof engineeringGateFailureObservation>, "related_target_ids"> & {
    readonly related_target_ids: readonly string[];
  }
>;

const engineeringGateFailureV2Base = z.strictObject({
  schema_version: z.literal(2),
  artifact_kind: z.literal("GateFailure"),
  ...artifactBase,
  authority: z.literal("SERVER_OWNED"),
  slice_id: idString,
  attempt: z.int().positive(),
  tree_digest: sha256Digest,
  diff_digest: sha256Digest,
  context_digest: sha256Digest,
  config_digest: sha256Digest,
  mapping_digest: sha256Digest,
  blocking_gate_ids: z.array(idString).min(1).max(128),
  receipt_ids: z.array(idString).min(1).max(256),
  decision_ids: z.array(idString).max(256),
  diagnostics: z.array(engineeringGateFailureDiagnostic).min(1).max(8),
  observations: z.array(engineeringGateFailureObservation).min(1).max(512).readonly(),
});

/** Strict, receipt-backed typed failure emitted for new durable revisions. */
export const engineeringGateFailureV2 = engineeringGateFailureV2Base
  .superRefine((failure, ctx) => {
    for (const [field, values] of [
      ["blocking_gate_ids", failure.blocking_gate_ids],
      ["receipt_ids", failure.receipt_ids],
      ["decision_ids", failure.decision_ids],
    ] as const) {
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", path: [field], message: `${field} must be unique` });
      }
    }
    if (
      new Set(failure.diagnostics.map((item) => item.gate_id)).size !== failure.diagnostics.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "gate diagnostics must be unique",
      });
    }
    for (const diagnostic of failure.diagnostics) {
      if (!failure.blocking_gate_ids.includes(diagnostic.gate_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["diagnostics"],
          message: "diagnostic gate must be blocking",
        });
      }
    }
    const observationIdentities = new Set<string>();
    const coveredBlockingGates = new Set<string>();
    for (const [index, observation] of failure.observations.entries()) {
      const identity = `${observation.criterion_id}\u0000${observation.gate_id}\u0000${observation.evidence_ref}`;
      if (observationIdentities.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", index],
          message: "observation identity must be unique",
        });
      }
      observationIdentities.add(identity);
      if (!failure.receipt_ids.includes(observation.evidence_ref)) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", index, "evidence_ref"],
          message: "evidence_ref must reference a receipt",
        });
      }
      if (!failure.blocking_gate_ids.includes(observation.gate_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", index, "gate_id"],
          message: "observation gate must be blocking",
        });
      } else {
        coveredBlockingGates.add(observation.gate_id);
      }
      if (new Set(observation.related_target_ids).size !== observation.related_target_ids.length) {
        ctx.addIssue({
          code: "custom",
          path: ["observations", index, "related_target_ids"],
          message: "related_target_ids must be unique",
        });
      }
    }
    for (const gateId of failure.blocking_gate_ids) {
      if (!coveredBlockingGates.has(gateId)) {
        ctx.addIssue({
          code: "custom",
          path: ["observations"],
          message: `blocking gate ${gateId} has no observation`,
        });
      }
    }
  })
  .readonly();

export type EngineeringGateFailureV1 = z.infer<typeof engineeringGateFailureV1>;
export type EngineeringGateFailureV2 = z.output<typeof engineeringGateFailureV2>;

/** Public compatibility union; discriminator is the exact schema_version field. */
export const engineeringGateFailure = z.discriminatedUnion("schema_version", [
  engineeringGateFailureV1,
  engineeringGateFailureV2,
]);
export const engineeringGateFailureUnion = engineeringGateFailure;
export type EngineeringGateFailureUnion = z.infer<typeof engineeringGateFailure>;

const baselineWorkspaceReference = valueObject({
  baseline_id: z.string().regex(/^slice-baseline-[0-9a-f]{64}$/u),
  tree_digest: sha256Digest,
});

/**
 * The only durable handoff from a model-driven implementation attempt.
 *
 * Host paths, patch bytes and the model-authored report are deliberately absent.
 * Every field is reconstructed and observed by server code after the model has
 * returned and before a later gate/review/commit stage may consume it.
 */
export const engineeringSliceImplementationReceipt = versionedContract({
  artifact_kind: z.literal("SliceImplementationReceipt"),
  ...artifactBase,
  authority: z.literal("SERVER_OWNED"),
  receipt_id: idString,
  work_unit_id: idString,
  slice_id: idString,
  attempt: z.int().positive(),
  workspace_id: idString,
  repository_id: idString,
  base_sha: z.string().regex(/^[0-9a-f]{40}$/u),
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)
    .refine(
      (value) =>
        !value.includes("..") &&
        !value.includes("//") &&
        !value.endsWith("/") &&
        !value.endsWith(".lock"),
      "must be a canonical bounded branch name",
    ),
  baseline: baselineWorkspaceReference,
  tree_digest: sha256Digest,
  diff_digest: sha256Digest,
  raw_patch_digest: sha256Digest,
  changed_paths: z.array(relativeRepositoryPath).max(512),
  cumulative_paths: z.array(relativeRepositoryPath).max(512),
  files_changed: z.int().nonnegative(),
  insertions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  tool_receipt_digests: digestList.min(1),
}).superRefine((receipt, ctx) => {
  const uniqueSorted = (values: readonly string[]) =>
    new Set(values).size === values.length &&
    values.every((value, index) => index === 0 || values[index - 1]! < value);
  if (!uniqueSorted(receipt.changed_paths))
    ctx.addIssue({ code: "custom", path: ["changed_paths"], message: "must be unique and sorted" });
  if (!uniqueSorted(receipt.cumulative_paths))
    ctx.addIssue({
      code: "custom",
      path: ["cumulative_paths"],
      message: "must be unique and sorted",
    });
  // `changed_paths` is the exact delta from the per-attempt baseline while
  // `cumulative_paths` is the current Git diff from HEAD. A correction may
  // restore a path changed by the preceding attempt, so the former is not
  // necessarily a subset of the latter.
  if (receipt.files_changed !== receipt.cumulative_paths.length)
    ctx.addIssue({
      code: "custom",
      path: ["files_changed"],
      message: "must equal the cumulative observed Git diff file count",
    });
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
  /** Server-validated exact files required to resolve blocking review findings. */
  required_mutation_paths: z.array(relativeRepositoryPath).max(256).default([]),
  reviewed_digest: sha256Digest,
}).superRefine((v, ctx) => {
  if (
    new Set(v.required_mutation_paths).size !== v.required_mutation_paths.length ||
    v.required_mutation_paths.some(
      (path, index) => index > 0 && v.required_mutation_paths[index - 1]! >= path,
    )
  ) {
    ctx.addIssue({
      code: "custom",
      message: "required mutation paths must be sorted and unique",
      path: ["required_mutation_paths"],
    });
  }
  if (v.decision === "PASS" && v.findings.length)
    ctx.addIssue({ code: "custom", message: "PASS cannot contain findings" });
  if (v.decision === "CHANGES_REQUIRED" && !v.findings.length)
    ctx.addIssue({ code: "custom", message: "CHANGES_REQUIRED requires findings" });
  if (v.decision === "PASS" && v.required_mutation_paths.length)
    ctx.addIssue({ code: "custom", message: "PASS cannot contain required mutation paths" });
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
export const engineeringLocalCommitReceipt = versionedContract({
  artifact_kind: z.literal("LocalCommitReceipt"),
  ...artifactBase,
  authority: z.literal("SERVER_OWNED"),
  receipt_id: idString,
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .refine(
      (value) =>
        !value.includes("..") &&
        !value.includes("//") &&
        !value.endsWith("/") &&
        !value.endsWith(".lock"),
      "must be a canonical bounded branch name",
    ),
  commit_sha: z.string().regex(/^[0-9a-f]{40}$/),
  parent_sha: z.string().regex(/^[0-9a-f]{40}$/),
  tree_digest: sha256Digest,
  diff_digest: sha256Digest,
  evidence_digest: sha256Digest,
  review_digest: sha256Digest,
  verification_decision_digest: sha256Digest,
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
export type EngineeringSliceBlueprint = z.infer<typeof engineeringSliceBlueprint>;
export type EngineeringSliceContract = z.infer<typeof engineeringSliceContract>;
export type EngineeringContextManifest = z.infer<typeof engineeringContextManifest>;
export type EngineeringEvidenceBundle = z.infer<typeof engineeringEvidenceBundle>;
export type EngineeringGateFailure = z.infer<typeof engineeringGateFailure>;
export type EngineeringSliceImplementationReceipt = z.infer<
  typeof engineeringSliceImplementationReceipt
>;
export type EngineeringMemoryUpdate = z.infer<typeof engineeringMemoryUpdate>;
export type EngineeringDesignDecision = z.infer<typeof engineeringDesignDecision>;
export type EngineeringReviewDecision = z.infer<typeof engineeringReviewDecision>;
export type EngineeringVerificationDecision = z.infer<typeof engineeringVerificationDecision>;
export type EngineeringLocalCommitReceipt = z.infer<typeof engineeringLocalCommitReceipt>;
export type EngineeringTerminalReason = z.infer<typeof engineeringTerminalReason>;

/**
 * Durable artifacts retain the two superseded v1 design/slice revisions for recovery only.
 * New model boundaries and schema publication use the strict v2 exports above.
 */
export const engineeringArtifact = z.union([
  engineeringOutcomeContract,
  engineeringPhase,
  engineeringSystemDesign,
  engineeringProgramDesignV1,
  engineeringProgramDesign,
  engineeringSliceContractV1,
  engineeringSliceContract,
  engineeringContextManifest,
  engineeringSliceImplementationReceipt,
  engineeringEvidenceBundle,
  engineeringGateFailure,
  engineeringMemoryUpdate,
  engineeringDesignDecision,
  engineeringReviewDecision,
  engineeringVerificationDecision,
  engineeringLocalCommitReceipt,
  engineeringTerminalReason,
]);
export type EngineeringArtifact = z.infer<typeof engineeringArtifact>;
export type EngineeringArtifactKind = EngineeringArtifact["artifact_kind"];
export const engineeringArtifactSchema = engineeringArtifact;
export function engineeringArtifactDigest(input: unknown): string {
  return canonicalDigest(engineeringArtifact.parse(input));
}

const artifactKinds = <T extends readonly EngineeringArtifactKind[]>(...values: T): Readonly<T> =>
  Object.freeze(values);

/** Closed, code-owned authority for which durable artifact kinds each stage may emit. */
export const engineeringArtifactKindsByStage = Object.freeze({
  [EngineeringStage.DISCOVERY]: artifactKinds("ContextManifest"),
  [EngineeringStage.OUTCOME_DEFINITION]: artifactKinds("OutcomeContract"),
  [EngineeringStage.SYSTEM_DESIGN]: artifactKinds("SystemDesign"),
  [EngineeringStage.PROGRAM_DESIGN]: artifactKinds("ProgramDesign"),
  [EngineeringStage.DESIGN_APPROVAL]: artifactKinds("DesignDecision"),
  [EngineeringStage.SLICE_PLANNING]: artifactKinds("SliceContract"),
  [EngineeringStage.SLICE_IMPLEMENTATION]: artifactKinds(
    "SliceImplementationReceipt",
    "TerminalReason",
  ),
  [EngineeringStage.GATE_EXECUTION]: artifactKinds(
    "EvidenceBundle",
    "GateFailure",
    "TerminalReason",
  ),
  [EngineeringStage.SLICE_REVIEW]: artifactKinds("ReviewDecision", "TerminalReason"),
  [EngineeringStage.MEMORY_PROJECTION]: artifactKinds("MemoryUpdate"),
  [EngineeringStage.FINAL_VERIFICATION]: artifactKinds("VerificationDecision"),
  [EngineeringStage.LOCAL_COMMIT]: artifactKinds("LocalCommitReceipt", "TerminalReason"),
}) satisfies Readonly<Record<EngineeringStage, readonly EngineeringArtifactKind[]>>;

export function isEngineeringArtifactKindAllowedForStage(
  stage: EngineeringStage,
  artifactKind: EngineeringArtifactKind,
): boolean {
  return (engineeringArtifactKindsByStage[stage] as readonly EngineeringArtifactKind[]).includes(
    artifactKind,
  );
}

/** Canonicalize the server-owned repository write cap before digesting or enforcing it. */
export function normalizeEngineeringWritePathAllowlist(input: unknown): readonly string[] {
  const parsed = z.array(relativeRepositoryPath).min(1).max(256).parse(input);
  return Object.freeze([...new Set(parsed)].sort());
}

/** Segment-aware containment: `src/x` is under `src`, while `src2/x` is not. */
export function assertEngineeringPathsWithinWriteAllowlist(
  pathsInput: unknown,
  allowlistInput: unknown,
): readonly string[] {
  const paths = z.array(relativeRepositoryPath).max(512).parse(pathsInput);
  const allowlist = normalizeEngineeringWritePathAllowlist(allowlistInput);
  for (const path of paths) {
    if (!allowlist.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) {
      throw new Error(`repository path is outside the server-owned write allowlist: ${path}`);
    }
  }
  return Object.freeze([...paths]);
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
