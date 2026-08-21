/**
 * The machine-checkable half of the threat model (RA-024-WU-01/WU-02, AC1).
 *
 * `docs/security/THREAT_MODEL.md` is the prose; this file is the registry the prose
 * is checked against. The split exists because a threat model that lives only in a
 * document drifts the moment a provider is added, and nothing fails — which is the
 * `CTF-010` pattern ("the document described a guarantee the code did not give")
 * applied to security documentation rather than to a comment.
 *
 * So `test/security/threat-model.test.ts` asserts that every `Provider` in
 * `@remoteagent/contracts` has an entry here, and that every entry here appears in
 * the document. Adding a sixth provider therefore breaks the build until its
 * boundary is described, and deleting a section from the document breaks it too.
 *
 * This module deliberately holds no logic and imports nothing from the rest of the
 * repository: it is a description of where data crosses a trust boundary, consumed
 * by tests and by the document generator. Keeping `@remoteagent/contracts` out of
 * this package's dependencies also keeps `observability` importable from anywhere,
 * which matters because `CTF-006` was caused in part by it NOT being importable
 * from `implementation-tools`.
 */

/** Which direction data crosses the boundary, from this system's point of view. */
export type BoundaryDirection =
  /** Data enters the system and must be treated as `UNTRUSTED_DATA`. */
  | "INBOUND"
  /** The system produces an effect the outside world can observe. */
  | "OUTBOUND"
  /** Both, over the same channel and the same credential. */
  | "BIDIRECTIONAL";

/**
 * What an attacker who fully controls the far side of the boundary can attempt.
 *
 * Named threat classes rather than free prose so the document and the tests agree on
 * a closed vocabulary, and so a boundary cannot be described as "reviewed" without
 * saying which of these it faces.
 */
export const ThreatClass = {
  /** Hostile text reaches the model and tries to redirect it. */
  PROMPT_INJECTION: "PROMPT_INJECTION",
  /** Secrets or private data leave through a channel that looks benign. */
  EXFILTRATION: "EXFILTRATION",
  /** One account's or repository's data becomes visible to another. */
  CROSS_TENANT_LEAK: "CROSS_TENANT_LEAK",
  /** A caller obtains an effect it was never granted. */
  PRIVILEGE_ESCALATION: "PRIVILEGE_ESCALATION",
  /** An external write happens twice, or its outcome cannot be established. */
  DUPLICATE_OR_AMBIGUOUS_EFFECT: "DUPLICATE_OR_AMBIGUOUS_EFFECT",
  /** The far side is flooded, or floods us. */
  RESOURCE_EXHAUSTION: "RESOURCE_EXHAUSTION",
  /** Evidence needed to reconstruct what happened is lost or forged. */
  EVIDENCE_LOSS: "EVIDENCE_LOSS",
  /** Spend grows without bound, with no failing test to notice. */
  COST_RUNAWAY: "COST_RUNAWAY",
} as const;

export type ThreatClass = (typeof ThreatClass)[keyof typeof ThreatClass];

/** One external boundary, its threats, and the control that is supposed to hold. */
export interface TrustBoundary {
  /** Stable id, also the anchor used in `THREAT_MODEL.md`. */
  readonly id: string;
  /** Human name, as the document's heading. */
  readonly name: string;
  /**
   * The `Provider` value from `@remoteagent/contracts`, when this boundary is a
   * provider connection. `null` for boundaries that are not providers (the
   * filesystem, the database, the model) — those still need describing, and giving
   * them a fake provider would corrupt the completeness check in both directions.
   */
  readonly provider: string | null;
  readonly direction: BoundaryDirection;
  /** What crosses. Prose, but bounded to one line. */
  readonly dataFlow: string;
  readonly threats: readonly ThreatClass[];
  /**
   * The deterministic control that contains those threats, named by the module that
   * implements it. A boundary with no control is not allowed: the registry test
   * rejects an empty list, because "reviewed and found fine" is the shape of
   * assurance this repository has repeatedly punished.
   */
  readonly controls: readonly string[];
}

/**
 * Every boundary at which data crosses into or out of this system.
 *
 * AC1 requires coverage of "every external boundary and data flow", so the list is
 * closed and tested for completeness against `Provider` rather than curated by
 * hand. Ordering follows the document.
 */
export const TRUST_BOUNDARIES: readonly TrustBoundary[] = Object.freeze([
  {
    id: "jira",
    name: "Jira Cloud",
    provider: "jira",
    direction: "BIDIRECTIONAL",
    dataFlow: "issue fields, comments and webhook deliveries in; comments and transitions out",
    threats: [
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.EXFILTRATION,
      ThreatClass.DUPLICATE_OR_AMBIGUOUS_EFFECT,
      ThreatClass.CROSS_TENANT_LEAK,
    ],
    controls: [
      "packages/contracts/src/trust.ts (UNTRUSTED_DATA marker on every field)",
      "packages/policy/src/policy-engine.ts (R3 requires an exact owner approval)",
      "packages/policy/src/action-executor.ts (receipt or AMBIGUOUS, never a blind retry)",
      "packages/connector-jira/src/webhook/verify.ts (signature and replay checks)",
      "packages/policy/src/scope.ts (case-scoped connection allowlist)",
    ],
  },
  {
    id: "gitlab",
    name: "GitLab",
    provider: "gitlab",
    direction: "BIDIRECTIONAL",
    dataFlow: "repository contents, MR and pipeline state in; branches, draft MRs and comments out",
    threats: [
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.EXFILTRATION,
      ThreatClass.PRIVILEGE_ESCALATION,
      ThreatClass.DUPLICATE_OR_AMBIGUOUS_EFFECT,
    ],
    controls: [
      "packages/connector-gitlab/src/contracts.ts (GitLabProjectAllowlist, closed)",
      "packages/observability/src/secret-patterns.ts (glpat-/URL-userinfo redaction)",
      "packages/policy/src/policy-engine.ts (merge and force-push are R4, always approved)",
      "packages/git-lifecycle/src/lifecycle.ts (push receives the token as an argument, never in a URL)",
    ],
  },
  {
    id: "gmail",
    name: "Gmail — two independent accounts",
    provider: "gmail",
    direction: "BIDIRECTIONAL",
    dataFlow: "threads and messages in; drafts out. Two accounts, never joined",
    threats: [
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.CROSS_TENANT_LEAK,
      ThreatClass.EXFILTRATION,
    ],
    controls: [
      "packages/policy/src/scope.ts (one connection per account; scope is per case)",
      "packages/policy/src/connection-guard.ts (a blocked connection produces no effect)",
      "packages/policy/src/policy-engine.ts (draft creation is R2; sending is not registered at all)",
    ],
  },
  {
    id: "calendar",
    name: "Google Calendar — two independent accounts",
    provider: "calendar",
    direction: "BIDIRECTIONAL",
    dataFlow: "events and watch notifications in; event create/update/respond out",
    threats: [
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.CROSS_TENANT_LEAK,
      ThreatClass.DUPLICATE_OR_AMBIGUOUS_EFFECT,
    ],
    controls: [
      "packages/policy/src/scope.ts (per-account connection, case-scoped)",
      "packages/policy/src/policy-engine.ts (event writes are R3; delete is R4)",
      "packages/connector-calendar/src/sync.ts (watch renewal and reconciliation)",
    ],
  },
  {
    id: "discord",
    name: "Discord — the owner's control channel",
    provider: "discord",
    direction: "BIDIRECTIONAL",
    dataFlow: "owner commands and decision answers in; status and questions out",
    threats: [
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.PRIVILEGE_ESCALATION,
      ThreatClass.EXFILTRATION,
    ],
    controls: [
      "packages/discord/src/authorization.ts (owner identity checked server-side)",
      "packages/discord/src/sanitize.ts (mention and marker neutralisation)",
      "packages/discord/src/custom-id.ts (interaction ids are server-minted, not parsed as authority)",
      "packages/observability/src/secret-patterns.ts (status messages are redacted)",
    ],
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock — the model",
    provider: null,
    direction: "BIDIRECTIONAL",
    dataFlow: "prompt and tool results out; completions and tool intents in",
    threats: [
      ThreatClass.PRIVILEGE_ESCALATION,
      ThreatClass.EXFILTRATION,
      ThreatClass.COST_RUNAWAY,
      ThreatClass.RESOURCE_EXHAUSTION,
    ],
    controls: [
      "packages/policy/src/policy-engine.ts (the model states no tier, no scope, no decision)",
      "packages/agent-orchestrator/src/context/compaction.ts (context is redacted before it is sent)",
      "packages/bedrock-runtime/src/retry.ts (bounded attempts, classified failures)",
      "packages/observability/src/metrics.ts (token and cost counters with an anomaly alert)",
    ],
  },
  {
    id: "mcp",
    name: "MCP tool servers",
    provider: null,
    direction: "BIDIRECTIONAL",
    dataFlow: "tool descriptors and results in; tool calls out",
    threats: [
      ThreatClass.PRIVILEGE_ESCALATION,
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.EXFILTRATION,
    ],
    controls: [
      "packages/policy/src/policy-engine.ts (an annotation claiming a lower tier is REFUSED, not ignored)",
      "packages/policy/src/external-boundary.ts (an outside boundary may narrow, never widen)",
      "packages/mcp-tool-broker/src/registry.ts (server-owned registry; an unknown tool is R4)",
    ],
  },
  {
    id: "workspace",
    name: "Workspace filesystem",
    provider: null,
    direction: "BIDIRECTIONAL",
    dataFlow: "repository contents and command output in; file writes and commands out",
    threats: [
      ThreatClass.PROMPT_INJECTION,
      ThreatClass.EXFILTRATION,
      ThreatClass.CROSS_TENANT_LEAK,
      ThreatClass.RESOURCE_EXHAUSTION,
    ],
    controls: [
      "packages/workspace-runner/src/network-policy.ts (commands run network-DENY by default)",
      "packages/workspace-runner/src/fencing.ts (one writer per case workspace)",
      "packages/workspace-runner/src/path-policy.ts (every path verified against the root)",
      "packages/implementation-tools/src/toolset.ts (isProtectedPath hides instruction files)",
      "packages/repository-planner/src/discovery-policy.ts (credential and VCS paths refused)",
      "packages/implementation-tools/src/command.ts (output redacted before it is model-visible)",
    ],
  },
  {
    id: "postgres",
    name: "PostgreSQL — the system of record",
    provider: null,
    direction: "BIDIRECTIONAL",
    dataFlow: "every case, checkpoint, job, approval, action and receipt",
    threats: [
      ThreatClass.EVIDENCE_LOSS,
      ThreatClass.CROSS_TENANT_LEAK,
      ThreatClass.DUPLICATE_OR_AMBIGUOUS_EFFECT,
    ],
    controls: [
      "packages/database/migrations/009_audit_log.up.sql (append-only trigger)",
      "packages/database/src/repositories/approval.ts (approval fenced on an append-only revision)",
      "packages/database/src/queue/job-store.ts (leases, DLQ)",
      "packages/database/src/queue/outbox.ts (at-least-once delivery with dedupe)",
      "packages/database/src/repositories/case.ts (every read is scoped by case_id)",
    ],
  },
  {
    id: "artifacts",
    name: "Artifact and evidence store",
    provider: null,
    direction: "OUTBOUND",
    dataFlow: "test logs, diffs and review evidence written for the owner to read",
    threats: [ThreatClass.EXFILTRATION, ThreatClass.EVIDENCE_LOSS],
    controls: [
      "packages/test-evidence/src/artifact-store.ts (artifact root is server-owned, per case)",
      "packages/observability/src/secret-patterns.ts (evidence is redacted on write)",
      "packages/implementation-tools/src/command.ts (known roots substituted before patterns)",
    ],
  },
  {
    id: "secrets",
    name: "Secret storage — AWS Secrets Manager",
    provider: null,
    direction: "INBOUND",
    dataFlow: "credential material in, for one connection at a time",
    threats: [
      ThreatClass.EXFILTRATION,
      ThreatClass.PRIVILEGE_ESCALATION,
      ThreatClass.DUPLICATE_OR_AMBIGUOUS_EFFECT,
    ],
    controls: [
      "packages/policy/src/credential-vault.ts (a credential is used, never returned to a caller)",
      "packages/policy/src/credential-refresh.ts (leased refresh; an ambiguous write is not retried)",
      "packages/observability/src/redaction.ts (sensitive keys masked by name, not only by value)",
    ],
  },
]);

/** Look up one boundary by id, or `undefined`. */
export function findTrustBoundary(id: string): TrustBoundary | undefined {
  return TRUST_BOUNDARIES.find((boundary) => boundary.id === id);
}

/** Every boundary that represents a provider connection, in registry order. */
export function providerBoundaries(): readonly TrustBoundary[] {
  return TRUST_BOUNDARIES.filter((boundary) => boundary.provider !== null);
}
