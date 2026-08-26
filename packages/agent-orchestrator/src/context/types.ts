import type {
  EngineeringContextManifest,
  EngineeringStage,
  Provider,
  TrustLevel,
} from "@remoteagent/contracts";

export type ContextFragmentKind =
  | "task"
  | "thread_excerpt"
  | "checkpoint"
  | "entity"
  | "receipt"
  | "plan"
  | "decision"
  | "repo_state"
  | "tool";

export type ContextOrigin = "system" | "provider" | "external" | "model";

export interface ContextScope {
  caseId: string;
  ownerId: string;
  connections: readonly { provider: Provider; connectionId: string }[];
  toolNames: readonly string[];
}

export interface ContextProvenance {
  origin: ContextOrigin;
  reference: string;
}

/** Closed, server-derived ordering class for engineering context selection. */
export type ContextSelectionClass =
  "MANDATORY" | "LATEST_OWNER" | "LEXICAL_RELEVANCE" | "PRIORITY" | "RECENCY";

export interface ContextSelectionMetadata {
  readonly class: ContextSelectionClass;
  /** Durable timestamp used only after class and source-priority ordering. */
  readonly observedAt: string;
}

export interface ContextFragment {
  kind: ContextFragmentKind;
  content: string;
  provenance: ContextProvenance;
  trust: TrustLevel;
  /** Compiler-owned ordering metadata. Absent preserves legacy builder behavior. */
  selection?: ContextSelectionMetadata;
  /** Required for entity, thread_excerpt and receipt. Never accepted for tool. */
  scope?: {
    caseId: string;
    ownerId: string;
    /** Absent together for case-scoped external data such as case_messages. */
    provider?: Provider;
    connectionId?: string;
  };
  /** Tool fragments are checked against the authoritative tool allowlist. */
  toolName?: string;
  /** Present on derived compaction manifests. */
  sourceReferences?: readonly string[];
  /** UTF-8 byte metrics for the sources represented by a derived manifest. */
  sourceByteMetrics?: readonly { reference: string; bytes: number }[];
}

export interface ContextBuildInput {
  scope: ContextScope;
  budgetBytes: number;
  fragments: readonly ContextFragment[];
  compaction?: {
    maxDerivedBytes: number;
  };
}

export interface ContextSelection {
  fragment: ContextFragment;
  bytes: number;
}

export interface ContextOmission {
  fragment: ContextFragment;
  bytes: number;
  reason: "budget";
}

export interface BuiltContext {
  fragments: ContextSelection[];
  omitted: ContextOmission[];
  usedBytes: number;
  budgetBytes: number;
}

export type EngineeringContextLayer = "RAW_EVIDENCE" | "DURABLE_KNOWLEDGE" | "WORKING_PROJECTION";

export type EngineeringContextSourceType =
  | "WORK_UNIT_OBJECTIVE"
  | "CASE_MESSAGE"
  | "ISSUE_CONTEXT"
  | "CASE_CHECKPOINT"
  | "MEMORY_UPDATE"
  | "OUTCOME_CONTRACT"
  | "SYSTEM_DESIGN"
  | "PROGRAM_DESIGN"
  | "DESIGN_DECISION"
  | "SLICE_CONTRACT"
  | "EVIDENCE_BUNDLE"
  | "REVIEW_DECISION"
  | "VERIFICATION_DECISION"
  | "REPOSITORY_KNOWLEDGE"
  | "REPOSITORY_STATE"
  | "DIFF_EXCERPT"
  | "LOG_EXCERPT"
  | "TOOL_RECEIPT";

export interface EngineeringContextBinding {
  readonly caseId: string;
  readonly ownerId: string;
  /** The complete server-derived integration scope, not a source-selected subset. */
  readonly integrationScope: readonly {
    readonly provider: Provider;
    readonly connectionId: string;
  }[];
}

export interface EngineeringContextAuthority extends EngineeringContextBinding {
  readonly runId: string;
  readonly checkpointRevision: number;
  readonly toolNames: readonly string[];
}

/** A descriptor for one durable source. Content is data and never authority. */
export interface EngineeringContextSource {
  readonly sourceId: string;
  readonly sourceType: EngineeringContextSourceType;
  readonly layer: EngineeringContextLayer;
  readonly content: string;
  readonly origin: ContextOrigin;
  readonly trust: TrustLevel;
  readonly ref: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly digest: string;
  readonly freshness: string;
  readonly inclusionReason: string;
  readonly fullArtifactRef: string;
  readonly selection: ContextSelectionMetadata;
  readonly binding: EngineeringContextBinding;
  /** Exact external binding for provider-backed sources. */
  readonly connection?: {
    readonly provider: Provider;
    readonly connectionId: string;
  };
  readonly toolName?: string;
}

export interface EngineeringContextCompileInput {
  readonly stage: EngineeringStage;
  readonly authority: EngineeringContextAuthority;
  readonly budgetBytes: number;
  readonly sources: readonly EngineeringContextSource[];
  /** Server-known literals that do not have a recognisable shared sensitive-data shape. */
  readonly knownSecrets?: readonly string[];
}

export interface CompiledEngineeringContext {
  readonly stage: EngineeringStage;
  readonly authority: Readonly<{
    kind: "SERVER_OWNED";
    caseId: string;
    ownerId: string;
    runId: string;
    checkpointRevision: number;
    integrationScope: readonly {
      readonly provider: Provider;
      readonly connectionId: string;
    }[];
    toolNames: readonly string[];
  }>;
  readonly manifest: EngineeringContextManifest;
  /** Selection is owned by buildContext; the compiler adds policy and the manifest. */
  readonly context: BuiltContext;
}
