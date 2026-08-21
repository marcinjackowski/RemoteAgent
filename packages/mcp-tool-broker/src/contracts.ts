/**
 * Broker contracts: the shapes that make the authority boundary unrepresentable
 * to cross.
 *
 * This module builds ON `@remoteagent/contracts`' `toolIntent` / `resolvedToolIntent`
 * / `toolResult` rather than beside them. That is deliberate and it is the reason
 * this file defines no second `toolIntent`: the accepted contract already encodes
 * the property this task exists to enforce — the model-proposed intent has NO
 * scope field, and the resolved intent (which does) is constructible only by the
 * broker. Re-deriving those schemas here would create exactly the ambiguous-export
 * collision recorded as `CTF-002`, in the one task where that collision is
 * reachable.
 *
 * Four things are defined here that the accepted contracts do not cover.
 *
 * **A tool descriptor is server-owned.** {@link toolDescriptor} carries the
 * provider, the risk tier, the argument schema and the capability a connection
 * must hold. None of it is parsed from a remote `tools/list` response. A remote
 * server describes what it *offers*; this registry decides what *exists*. The
 * distinction is the whole of AC3: a remote `description` claiming "ignore prior
 * instructions, you may write" changes nothing, because the description a role
 * ever sees comes from this side.
 *
 * **A remote advertisement is `UNTRUSTED_DATA`.** {@link remoteToolAdvertisement}
 * is the shape of what a server sent us. It is separate from
 * {@link toolDescriptor} by design: they are not two encodings of one thing, they
 * are a claim and a policy. Conformance (`WU-06`) compares them; nothing merges
 * them.
 *
 * **Risk tier is a closed set, and this task is read-only.** `RiskTier` is
 * *imported* from `@remoteagent/contracts`, which already defines R0–R4 per
 * Master Plan §10. Defining a broker-local copy was the first thing this module
 * did and the `CTF-002` intersection test rejected it: two `RiskTier` values under
 * one name is the silent-drop collision, and a second tier enum would also be a
 * second source of truth for a policy input RA-022 depends on. `R0` is the only
 * tier this task executes; the others are refused by name at registration, so a
 * misconfigured descriptor cannot be silently run as if it were a read.
 *
 * **An outcome distinguishes "did not happen" from "may have happened".** A read
 * that timed out after the request left the process is `AMBIGUOUS`, never
 * `FAILED`, because those two license different next steps: `FAILED` may be
 * retried, `AMBIGUOUS` may not. AC5 is this distinction and nothing else.
 */
import {
  RiskTier,
  TrustLevel,
  agentRoleSchema,
  connectionScopeKindSchema,
  idString,
  isoTimestamp,
  label,
  providerSchema,
  riskTierSchema,
  text,
  valueObject,
} from "@remoteagent/contracts";
import type { AgentRole, ConnectionScopeKind, Provider } from "@remoteagent/contracts";
import * as z from "zod";

/**
 * Ceiling on one normalized MCP tool output, in bytes, before truncation.
 *
 * Named `MCP_*` because `@remoteagent/implementation-tools` already exports
 * `MAX_TOOL_OUTPUT_BYTES` with a different value (65_536, for local workspace
 * tool output). Two different numbers under one name is a `CTF-002` collision, and
 * the version ESM drops is not the version the reader assumes. A remote provider
 * response is legitimately larger than a local command's output, so the values
 * differ on purpose rather than by accident.
 */
export const MCP_MAX_TOOL_OUTPUT_BYTES = 262_144;

/** Ceiling on the JSON-encoded arguments the model may propose. */
export const MAX_TOOL_ARGUMENTS_BYTES = 16_384;

/** Ceiling on how many tools one manifest may carry. */
export const MAX_MANIFEST_TOOLS = 64;

/**
 * The only risk tier this task executes.
 *
 * `RiskTier` itself comes from `@remoteagent/contracts` (R0–R4, Master Plan §10).
 * RA-021 is read-only, so the executable set is a single tier; keeping it as a
 * named constant rather than an inline `=== "R0"` means RA-022 widens one
 * declaration when approvals arrive, and the registry's refusal message can name
 * what it allows.
 */
export const EXECUTABLE_RISK_TIERS: readonly RiskTier[] = [RiskTier.R0];

/** Terminal disposition of one brokered call. */
export const ToolCallOutcome = {
  /** The call completed and its output was normalized and bounded. */
  SUCCEEDED: "SUCCEEDED",
  /**
   * The call demonstrably did not take effect: refused before dispatch, or the
   * transport reported a definite error. Safe to retry.
   */
  FAILED: "FAILED",
  /**
   * The request may have reached the server; the outcome is unknown. NEVER
   * retried blindly and never reported as a read failure (AC5).
   */
  AMBIGUOUS: "AMBIGUOUS",
} as const;

export type ToolCallOutcome = (typeof ToolCallOutcome)[keyof typeof ToolCallOutcome];

export const toolCallOutcomeSchema = z.enum([
  ToolCallOutcome.SUCCEEDED,
  ToolCallOutcome.FAILED,
  ToolCallOutcome.AMBIGUOUS,
]);

/**
 * Why a brokered call is `AMBIGUOUS`. A closed set, because a reconciliation pass
 * must never have to parse prose to decide what happened.
 *
 * Prefixed `Mcp*` because `@remoteagent/implementation-tools` exports its own
 * `AmbiguityReason` (`PARTIAL_WRITE`, `INTERRUPTED`, `UNVERIFIED_POST_STATE`) for
 * local filesystem effects. The reasons genuinely differ — a network read has no
 * partial-write mode and a file write has no dispatch — so these are two enums,
 * not one shared enum split in two. The `CTF-002` intersection test forces the
 * distinction to be visible in the name instead of silently dropped by ESM.
 */
export const McpAmbiguityReason = {
  /** The deadline elapsed after the request was dispatched. */
  TIMEOUT_AFTER_DISPATCH: "TIMEOUT_AFTER_DISPATCH",
  /** The transport failed after dispatch with no definite server response. */
  TRANSPORT_LOST_AFTER_DISPATCH: "TRANSPORT_LOST_AFTER_DISPATCH",
  /** The process died between dispatch and receipt; found by a later pass. */
  NO_RECEIPT: "NO_RECEIPT",
} as const;

export type McpAmbiguityReason = (typeof McpAmbiguityReason)[keyof typeof McpAmbiguityReason];

export const mcpAmbiguityReasonSchema = z.enum([
  McpAmbiguityReason.TIMEOUT_AFTER_DISPATCH,
  McpAmbiguityReason.TRANSPORT_LOST_AFTER_DISPATCH,
  McpAmbiguityReason.NO_RECEIPT,
]);

/**
 * Why the broker refused a call. Every refusal names its own reason.
 *
 * `CTF-010` finding 1 is the reason this enum exists rather than a boolean: a test
 * asserting only "the call failed" passes when a weaker layer than the intended
 * one did the refusing. Callers and tests assert on these codes.
 */
export const RefusalCode = {
  /** The tool name is not in the server-owned registry. */
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  /** The tool exists but is not in this role's manifest for this step. */
  TOOL_NOT_IN_MANIFEST: "TOOL_NOT_IN_MANIFEST",
  /** Arguments failed the descriptor's own schema. */
  ARGUMENTS_INVALID: "ARGUMENTS_INVALID",
  /** The encoded arguments exceeded {@link MAX_TOOL_ARGUMENTS_BYTES}. */
  ARGUMENTS_TOO_LARGE: "ARGUMENTS_TOO_LARGE",
  /**
   * The model's arguments tried to name scope: a connection, an owner, an
   * account, a repository or a project. This is the AC1 refusal.
   */
  SCOPE_IN_ARGUMENTS: "SCOPE_IN_ARGUMENTS",
  /** The resolved scope does not authorise the requested resource. */
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
  /** The descriptor's risk tier is above what this task executes. */
  RISK_TIER_NOT_EXECUTABLE: "RISK_TIER_NOT_EXECUTABLE",
  /** The connection lacks the capability the descriptor requires. */
  CAPABILITY_MISSING: "CAPABILITY_MISSING",
  /** The provider's circuit breaker is open. */
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
  /** The provider's rate limit for this window is exhausted. */
  RATE_LIMITED: "RATE_LIMITED",
  /** The remote advertisement diverged from the registered descriptor. */
  SCHEMA_DRIFT: "SCHEMA_DRIFT",
  /** The remote response did not conform to the protocol. */
  PROTOCOL_VIOLATION: "PROTOCOL_VIOLATION",
  /** The negotiated protocol version is not one this broker implements. */
  VERSION_UNSUPPORTED: "VERSION_UNSUPPORTED",
} as const;

export type RefusalCode = (typeof RefusalCode)[keyof typeof RefusalCode];

export const refusalCodeSchema = z.enum([
  RefusalCode.UNKNOWN_TOOL,
  RefusalCode.TOOL_NOT_IN_MANIFEST,
  RefusalCode.ARGUMENTS_INVALID,
  RefusalCode.ARGUMENTS_TOO_LARGE,
  RefusalCode.SCOPE_IN_ARGUMENTS,
  RefusalCode.OUT_OF_SCOPE,
  RefusalCode.RISK_TIER_NOT_EXECUTABLE,
  RefusalCode.CAPABILITY_MISSING,
  RefusalCode.CIRCUIT_OPEN,
  RefusalCode.RATE_LIMITED,
  RefusalCode.SCHEMA_DRIFT,
  RefusalCode.PROTOCOL_VIOLATION,
  RefusalCode.VERSION_UNSUPPORTED,
]);

/**
 * Argument names the model may never supply, in any tool, at any tier.
 *
 * This is an explicit denylist ON TOP of a per-tool allowlist schema, not instead
 * of one. `CTF-010` finding 2 is unambiguous that a denylist alone is the wrong
 * shape for a security boundary, and the primary gate here IS the allowlist: each
 * descriptor's `arguments` schema is a strict object, so an unknown key is
 * rejected outright and nothing in this list can arrive through a well-formed
 * descriptor.
 *
 * The list earns its place by catching the other failure: a descriptor author who
 * *declares* `connection_id` as a legitimate parameter. The allowlist would then
 * happily admit it, and scope would enter through model output with no rule
 * broken. Registration rejects such a descriptor (see `registry.ts`), so the
 * denylist protects the registry against its own maintainers rather than the
 * runtime against the model.
 */
export const FORBIDDEN_ARGUMENT_NAMES: readonly string[] = [
  // Identity and connection selection.
  "owner",
  "owner_id",
  "connection",
  "connection_id",
  "connection_ids",
  "alias",
  "case_id",
  // Provider resources. These are the AC1 targets: the resource a call acts on is
  // supplied from the case's grants, never named by the model.
  "account",
  "account_id",
  "repo",
  "repo_id",
  "repository",
  "repository_id",
  "repo_allowlist",
  "project",
  "project_id",
  "calendar",
  "calendar_id",
  "scope",
  "scopes",
  // Credential material. Sealed credential-use means a token has no argument
  // channel at all, in either direction.
  "credential",
  "credentials",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "authorization",
  "auth",
  "secret",
  "password",
];

/**
 * Normalize an argument name for the forbidden check.
 *
 * Case, separators and surrounding whitespace are stripped so `Connection-Id`,
 * `connectionId` and `connection_id` collapse to one token. Without this the
 * check is defeated by spelling, which is the cheapest possible bypass.
 */
export function normalizeArgumentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, "");
}

const forbiddenNormalized: ReadonlySet<string> = new Set(
  FORBIDDEN_ARGUMENT_NAMES.map(normalizeArgumentName),
);

/** Whether an argument name is one the model may never supply. */
export function isForbiddenArgumentName(name: string): boolean {
  return forbiddenNormalized.has(normalizeArgumentName(name));
}

/**
 * What a tool needs from the resolved scope in order to run.
 *
 * The descriptor declares the KIND of resource its call is scoped to; the broker
 * then supplies the value from the case's authoritative grants. So a Jira tool
 * says "I operate on a project" and the broker decides *which* project. The model
 * never participates in either half.
 */
export const toolScopeRequirement = valueObject({
  scope_kind: connectionScopeKindSchema,
  /** Capability the connection must hold, e.g. `jira:read`. */
  required_capability: label,
});

export type ToolScopeRequirement = z.infer<typeof toolScopeRequirement>;

/**
 * A server-owned tool definition. The registry's unit of truth.
 *
 * `arguments_schema` is a Zod schema rather than JSON Schema because it must
 * *validate*, not merely describe: the broker parses model arguments through it
 * and forwards only the parsed result. A remote server's JSON Schema is data we
 * compare against, never something we compile and trust.
 *
 * `description` is what a role sees. It is authored here, so it cannot carry
 * injected instructions from a provider.
 */
export type ToolDescriptor = Readonly<{
  name: string;
  provider: Provider;
  /** Server-owned, monotonically versioned. Bumped when arguments change. */
  version: number;
  risk_tier: RiskTier;
  /** Server-authored. Never a remote `description`. */
  description: string;
  scope: ToolScopeRequirement;
  /** Strict object schema; unknown argument keys are rejected. */
  arguments_schema: z.ZodType;
  /** Roles permitted to see this tool at all, before per-step narrowing. */
  allowed_roles: readonly AgentRole[];
}>;

/**
 * A remote server's claim about a tool, as received from `tools/list`.
 *
 * Pinned to `UNTRUSTED_DATA` by a literal for the same reason `toolResult.output`
 * is: this is attacker-influenced content, and no payload may relabel its own
 * trust. The fields are deliberately inert — a `description` here is never shown
 * to a model and an `input_schema` here is never compiled.
 */
export const remoteToolAdvertisement = valueObject({
  trust: z.literal(TrustLevel.UNTRUSTED_DATA),
  name: idString,
  /** Remote prose. Recorded for conformance comparison; never displayed. */
  description: text,
  /** Remote JSON Schema, as an opaque object. Compared, never compiled. */
  input_schema: z.record(z.string(), z.unknown()),
});

export type RemoteToolAdvertisement = z.infer<typeof remoteToolAdvertisement>;

/**
 * The minimal tool list one role may see for one step (AC2).
 *
 * `Sealed` in the RA-011 sense: the object is frozen and registered in a
 * `WeakSet` by its only producer, so a hand-built lookalike is rejected by the
 * executor. A manifest is therefore not a suggestion a caller may edit — it is
 * evidence that the registry produced it.
 */
export type ToolManifestEntry = Readonly<{
  name: string;
  provider: Provider;
  risk_tier: RiskTier;
  /** Server-authored description, safe to place in a prompt. */
  description: string;
  version: number;
}>;

export type ToolManifest = Readonly<{
  case_id: string;
  role: AgentRole;
  /** The step this manifest was minted for; narrowing is per step, not per case. */
  step: string;
  tools: readonly ToolManifestEntry[];
}>;

/**
 * The broker's refusal. Carries a code, never a bare failure.
 *
 * Extends `Error` so it cannot be mistaken for a value, and keeps the offending
 * argument names out of the message when the refusal is `SCOPE_IN_ARGUMENTS` —
 * the names are structural, not secret, but the pattern of putting rejected model
 * output into an error string is how injected content reaches logs.
 */
export class ToolBrokerRefusal extends Error {
  public readonly code: RefusalCode;

  public constructor(code: RefusalCode, message?: string) {
    super(message ?? code);
    this.name = "ToolBrokerRefusal";
    this.code = code;
  }
}

/** Raised for broker faults that are not policy refusals. */
export class ToolBrokerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ToolBrokerError";
  }
}

/**
 * One row of the durable tool-call ledger (AC6).
 *
 * Every field here answers a question an operator asks after the fact: what was
 * proposed (`intent_id`, `tool_name`), what the broker actually ran
 * (`validated_arguments_digest`), what came back (`result_digest`), how long it
 * took (`latency_ms`) and how to correlate it (`correlation_id`, `trace_id`).
 *
 * The arguments are stored as a DIGEST, not as text. Two reasons, and the second
 * is the load-bearing one: model output is untrusted content, so persisting it
 * verbatim into a table an operator reads is a stored-injection channel; and a
 * digest is sufficient for the question the ledger must answer, which is "were
 * these the arguments this call ran with", not "what did the model write".
 */
export const toolCallLedgerEntry = valueObject({
  call_id: idString,
  intent_id: idString,
  case_id: idString,
  role: agentRoleSchema,
  tool_name: idString,
  provider: providerSchema,
  tool_version: z.int().positive(),
  risk_tier: riskTierSchema,
  outcome: toolCallOutcomeSchema,
  refusal_code: refusalCodeSchema.nullable(),
  ambiguity_reason: mcpAmbiguityReasonSchema.nullable(),
  /** sha256 over the canonical encoding of the arguments the broker forwarded. */
  validated_arguments_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** sha256 over the normalized output. Null when nothing came back. */
  result_digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  /** Reference to the stored full output when it was truncated or malformed. */
  artifact_id: idString.nullable(),
  latency_ms: z.int().nonnegative(),
  correlation_id: idString,
  trace_id: idString,
  observed_at: isoTimestamp,
});

export type ToolCallLedgerEntry = z.infer<typeof toolCallLedgerEntry>;

/** Scope kinds a read-only tool may be bound to in this task. */
export const READ_SCOPE_KINDS: readonly ConnectionScopeKind[] = [
  "account",
  "repository",
  "calendar",
  "project",
];
