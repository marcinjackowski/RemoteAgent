import type { Provider, TrustLevel } from "@remoteagent/contracts";

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

export type ContextOrigin = "system" | "provider" | "model";

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

export interface ContextFragment {
  kind: ContextFragmentKind;
  content: string;
  provenance: ContextProvenance;
  trust: TrustLevel;
  /** Required for entity, thread_excerpt and receipt. Never accepted for tool. */
  scope?: {
    caseId: string;
    ownerId: string;
    provider: Provider;
    connectionId: string;
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
