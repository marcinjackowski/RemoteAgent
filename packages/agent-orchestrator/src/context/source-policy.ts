import {
  EngineeringStage,
  providerSchema,
  TrustLevel,
  type EngineeringStage as EngineeringStageValue,
} from "@remoteagent/contracts";

import type {
  EngineeringContextAuthority,
  EngineeringContextBinding,
  EngineeringContextSource,
  EngineeringContextSourceType,
  ContextSelectionClass,
  ContextFragmentKind,
} from "./types.js";

export class EngineeringContextPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CONTEXT_EXACT_SCOPE_VIOLATION"
      | "CONTEXT_SOURCE_TRUST_VIOLATION"
      | "CONTEXT_SOURCE_BINDING_VIOLATION"
      | "CONTEXT_SOURCE_LAYER_VIOLATION"
      | "CONTEXT_SOURCE_SELECTION_VIOLATION",
  ) {
    super(message);
    this.name = "EngineeringContextPolicyError";
  }
}

type IntegrationBinding = EngineeringContextBinding["integrationScope"][number];

const sourceTypes = (
  ...values: EngineeringContextSourceType[]
): readonly EngineeringContextSourceType[] => Object.freeze(values);

const baseSources = ["WORK_UNIT_OBJECTIVE", "CASE_CHECKPOINT", "MEMORY_UPDATE"] as const;

/** Memory-selection policy is separate from role/transition routing. */
export const engineeringContextSourcePolicy: Readonly<
  Record<EngineeringStageValue, readonly EngineeringContextSourceType[]>
> = Object.freeze({
  [EngineeringStage.DISCOVERY]: sourceTypes(
    ...baseSources,
    "CASE_MESSAGE",
    "ISSUE_CONTEXT",
    "REPOSITORY_KNOWLEDGE",
    "REPOSITORY_STATE",
    "TOOL_RECEIPT",
  ),
  [EngineeringStage.OUTCOME_DEFINITION]: sourceTypes(
    ...baseSources,
    "CASE_MESSAGE",
    "ISSUE_CONTEXT",
    "REPOSITORY_KNOWLEDGE",
    "REPOSITORY_STATE",
  ),
  [EngineeringStage.SYSTEM_DESIGN]: sourceTypes(
    ...baseSources,
    "CASE_MESSAGE",
    "ISSUE_CONTEXT",
    "OUTCOME_CONTRACT",
    "DESIGN_DECISION",
    "REPOSITORY_KNOWLEDGE",
    "REPOSITORY_STATE",
  ),
  [EngineeringStage.PROGRAM_DESIGN]: sourceTypes(
    ...baseSources,
    "ISSUE_CONTEXT",
    "OUTCOME_CONTRACT",
    "SYSTEM_DESIGN",
    "DESIGN_DECISION",
    "REPOSITORY_KNOWLEDGE",
    "REPOSITORY_STATE",
  ),
  [EngineeringStage.DESIGN_APPROVAL]: sourceTypes(
    ...baseSources,
    "OUTCOME_CONTRACT",
    "SYSTEM_DESIGN",
    "PROGRAM_DESIGN",
  ),
  [EngineeringStage.SLICE_PLANNING]: sourceTypes(
    ...baseSources,
    "ISSUE_CONTEXT",
    "OUTCOME_CONTRACT",
    "SYSTEM_DESIGN",
    "PROGRAM_DESIGN",
    "DESIGN_DECISION",
    "EVIDENCE_BUNDLE",
    "REVIEW_DECISION",
    "REPOSITORY_KNOWLEDGE",
    "REPOSITORY_STATE",
  ),
  [EngineeringStage.SLICE_IMPLEMENTATION]: sourceTypes(
    ...baseSources,
    "ISSUE_CONTEXT",
    "PROGRAM_DESIGN",
    "DESIGN_DECISION",
    "SLICE_CONTRACT",
    "REVIEW_DECISION",
    "REPOSITORY_KNOWLEDGE",
    "REPOSITORY_STATE",
  ),
  [EngineeringStage.GATE_EXECUTION]: sourceTypes(
    ...baseSources,
    "SLICE_CONTRACT",
    "REPOSITORY_STATE",
    "DIFF_EXCERPT",
    "LOG_EXCERPT",
    "TOOL_RECEIPT",
  ),
  [EngineeringStage.SLICE_REVIEW]: sourceTypes(
    ...baseSources,
    "SLICE_CONTRACT",
    "EVIDENCE_BUNDLE",
    "REPOSITORY_STATE",
    "DIFF_EXCERPT",
    "LOG_EXCERPT",
    "TOOL_RECEIPT",
  ),
  [EngineeringStage.MEMORY_PROJECTION]: sourceTypes(
    ...baseSources,
    "OUTCOME_CONTRACT",
    "SYSTEM_DESIGN",
    "PROGRAM_DESIGN",
    "DESIGN_DECISION",
    "SLICE_CONTRACT",
    "EVIDENCE_BUNDLE",
    "REVIEW_DECISION",
    "VERIFICATION_DECISION",
  ),
  [EngineeringStage.FINAL_VERIFICATION]: sourceTypes(
    ...baseSources,
    "OUTCOME_CONTRACT",
    "SYSTEM_DESIGN",
    "PROGRAM_DESIGN",
    "DESIGN_DECISION",
    "SLICE_CONTRACT",
    "EVIDENCE_BUNDLE",
    "REVIEW_DECISION",
    "VERIFICATION_DECISION",
    "REPOSITORY_STATE",
    "DIFF_EXCERPT",
    "LOG_EXCERPT",
  ),
});

/** Compatibility mapping into the existing packet renderer/selector. */
export const engineeringContextRenderKind: Readonly<
  Record<EngineeringContextSourceType, ContextFragmentKind>
> = Object.freeze({
  WORK_UNIT_OBJECTIVE: "task",
  CASE_MESSAGE: "thread_excerpt",
  ISSUE_CONTEXT: "entity",
  CASE_CHECKPOINT: "checkpoint",
  MEMORY_UPDATE: "plan",
  OUTCOME_CONTRACT: "plan",
  SYSTEM_DESIGN: "plan",
  PROGRAM_DESIGN: "plan",
  DESIGN_DECISION: "decision",
  SLICE_CONTRACT: "plan",
  EVIDENCE_BUNDLE: "plan",
  REVIEW_DECISION: "decision",
  VERIFICATION_DECISION: "decision",
  REPOSITORY_KNOWLEDGE: "plan",
  REPOSITORY_STATE: "repo_state",
  DIFF_EXCERPT: "repo_state",
  LOG_EXCERPT: "repo_state",
  TOOL_RECEIPT: "tool",
});

/** Three-layer memory ownership is determined by source type, never by content. */
export const engineeringContextLayerBySourceType: Readonly<
  Record<EngineeringContextSourceType, EngineeringContextSource["layer"]>
> = Object.freeze({
  WORK_UNIT_OBJECTIVE: "DURABLE_KNOWLEDGE",
  CASE_MESSAGE: "RAW_EVIDENCE",
  ISSUE_CONTEXT: "RAW_EVIDENCE",
  CASE_CHECKPOINT: "WORKING_PROJECTION",
  MEMORY_UPDATE: "WORKING_PROJECTION",
  OUTCOME_CONTRACT: "DURABLE_KNOWLEDGE",
  SYSTEM_DESIGN: "DURABLE_KNOWLEDGE",
  PROGRAM_DESIGN: "DURABLE_KNOWLEDGE",
  DESIGN_DECISION: "DURABLE_KNOWLEDGE",
  SLICE_CONTRACT: "DURABLE_KNOWLEDGE",
  EVIDENCE_BUNDLE: "RAW_EVIDENCE",
  REVIEW_DECISION: "DURABLE_KNOWLEDGE",
  VERIFICATION_DECISION: "DURABLE_KNOWLEDGE",
  REPOSITORY_KNOWLEDGE: "DURABLE_KNOWLEDGE",
  REPOSITORY_STATE: "RAW_EVIDENCE",
  DIFF_EXCERPT: "RAW_EVIDENCE",
  LOG_EXCERPT: "RAW_EVIDENCE",
  TOOL_RECEIPT: "RAW_EVIDENCE",
});

const selectionClasses = (...values: ContextSelectionClass[]): readonly ContextSelectionClass[] =>
  Object.freeze(values);

/** Selection class is server-owned metadata, never inferred from source content. */
export const engineeringContextSelectionClassesBySourceType: Readonly<
  Record<EngineeringContextSourceType, readonly ContextSelectionClass[]>
> = Object.freeze({
  WORK_UNIT_OBJECTIVE: selectionClasses("MANDATORY"),
  CASE_MESSAGE: selectionClasses("LATEST_OWNER", "LEXICAL_RELEVANCE", "RECENCY"),
  ISSUE_CONTEXT: selectionClasses("PRIORITY"),
  CASE_CHECKPOINT: selectionClasses("MANDATORY"),
  MEMORY_UPDATE: selectionClasses("PRIORITY"),
  OUTCOME_CONTRACT: selectionClasses("PRIORITY"),
  SYSTEM_DESIGN: selectionClasses("PRIORITY"),
  PROGRAM_DESIGN: selectionClasses("PRIORITY"),
  DESIGN_DECISION: selectionClasses("PRIORITY"),
  SLICE_CONTRACT: selectionClasses("PRIORITY"),
  EVIDENCE_BUNDLE: selectionClasses("PRIORITY"),
  REVIEW_DECISION: selectionClasses("PRIORITY"),
  VERIFICATION_DECISION: selectionClasses("PRIORITY"),
  REPOSITORY_KNOWLEDGE: selectionClasses("PRIORITY"),
  REPOSITORY_STATE: selectionClasses("PRIORITY"),
  DIFF_EXCERPT: selectionClasses("PRIORITY"),
  LOG_EXCERPT: selectionClasses("PRIORITY"),
  TOOL_RECEIPT: selectionClasses("PRIORITY"),
});

function bindingKey(binding: IntegrationBinding): string {
  return `${binding.provider}\u0000${binding.connectionId}`;
}

function assertOpaqueId(value: string, label: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new EngineeringContextPolicyError(
      `${label} must be a non-empty bounded identifier`,
      "CONTEXT_SOURCE_BINDING_VIOLATION",
    );
  }
}

export function canonicalIntegrationScope(
  scope: readonly IntegrationBinding[],
): readonly IntegrationBinding[] {
  const seen = new Set<string>();
  const canonical = scope.map((binding) => {
    if (!providerSchema.safeParse(binding.provider).success) {
      throw new EngineeringContextPolicyError(
        "Integration scope contains an unknown provider",
        "CONTEXT_SOURCE_BINDING_VIOLATION",
      );
    }
    assertOpaqueId(binding.connectionId, "connectionId");
    const copy = Object.freeze({
      provider: binding.provider,
      connectionId: binding.connectionId,
    });
    const key = bindingKey(copy);
    if (seen.has(key)) {
      throw new EngineeringContextPolicyError(
        "Integration scope contains a duplicate binding",
        "CONTEXT_SOURCE_BINDING_VIOLATION",
      );
    }
    seen.add(key);
    return copy;
  });
  canonical.sort((left, right) => {
    const leftKey = bindingKey(left);
    const rightKey = bindingKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze(canonical);
}

function scopesMatch(
  expected: readonly IntegrationBinding[],
  actual: readonly IntegrationBinding[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (binding, index) =>
        binding.provider === actual[index]?.provider &&
        binding.connectionId === actual[index]?.connectionId,
    )
  );
}

function scopeViolation(): never {
  throw new EngineeringContextPolicyError(
    "Context source is outside the exact server-owned scope",
    "CONTEXT_EXACT_SCOPE_VIOLATION",
  );
}

const alwaysUntrustedSourceTypes = new Set<EngineeringContextSourceType>([
  "CASE_MESSAGE",
  "ISSUE_CONTEXT",
  "REPOSITORY_KNOWLEDGE",
  "REPOSITORY_STATE",
  "DIFF_EXCERPT",
  "LOG_EXCERPT",
  "TOOL_RECEIPT",
]);
const providerBoundSourceTypes = new Set<EngineeringContextSourceType>(["ISSUE_CONTEXT"]);

/** Validate source provenance without interpreting source content. */
export function assertEngineeringContextSourcePolicy(
  authority: EngineeringContextAuthority,
  source: EngineeringContextSource,
): void {
  assertOpaqueId(authority.caseId, "caseId");
  assertOpaqueId(authority.ownerId, "ownerId");
  assertOpaqueId(authority.runId, "runId");
  assertOpaqueId(source.binding.caseId, "source caseId");
  assertOpaqueId(source.binding.ownerId, "source ownerId");

  const expectedScope = canonicalIntegrationScope(authority.integrationScope);
  const sourceScope = canonicalIntegrationScope(source.binding.integrationScope);
  if (
    source.binding.caseId !== authority.caseId ||
    source.binding.ownerId !== authority.ownerId ||
    !scopesMatch(expectedScope, sourceScope)
  ) {
    scopeViolation();
  }

  if (source.layer !== engineeringContextLayerBySourceType[source.sourceType]) {
    throw new EngineeringContextPolicyError(
      "Context source layer does not match its server-owned source type",
      "CONTEXT_SOURCE_LAYER_VIOLATION",
    );
  }

  if (
    source.selection === undefined ||
    source.selection.observedAt !== source.observedAt ||
    !engineeringContextSelectionClassesBySourceType[source.sourceType].includes(
      source.selection.class,
    )
  ) {
    throw new EngineeringContextPolicyError(
      "Context source selection metadata is not allowed for its source type",
      "CONTEXT_SOURCE_SELECTION_VIOLATION",
    );
  }

  const mustBeUntrusted =
    source.origin !== "system" ||
    source.layer === "WORKING_PROJECTION" ||
    alwaysUntrustedSourceTypes.has(source.sourceType);
  if (mustBeUntrusted && source.trust !== TrustLevel.UNTRUSTED_DATA) {
    throw new EngineeringContextPolicyError(
      "External and model-derived context must remain UNTRUSTED_DATA",
      "CONTEXT_SOURCE_TRUST_VIOLATION",
    );
  }

  if (source.origin === "provider" || providerBoundSourceTypes.has(source.sourceType)) {
    if (source.connection === undefined) {
      throw new EngineeringContextPolicyError(
        "Provider-backed context requires an exact connection binding",
        "CONTEXT_SOURCE_BINDING_VIOLATION",
      );
    }
  }
  if (
    source.connection !== undefined &&
    !expectedScope.some(
      (binding) =>
        binding.provider === source.connection?.provider &&
        binding.connectionId === source.connection?.connectionId,
    )
  ) {
    scopeViolation();
  }
  if (source.sourceType === "TOOL_RECEIPT" && source.origin !== "system") {
    throw new EngineeringContextPolicyError(
      "Tool context must originate from deterministic system code",
      "CONTEXT_SOURCE_TRUST_VIOLATION",
    );
  }
}
