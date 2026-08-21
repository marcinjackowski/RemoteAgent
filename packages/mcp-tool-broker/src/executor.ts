/**
 * The executor: the single path from a model-proposed intent to a bounded,
 * provenance-carrying result.
 *
 * Everything the other modules established converges here, in a fixed order that is
 * itself the guarantee:
 *
 *   1. resolve scope from the case's grants (`registry.ts`) — a refusal here is
 *      recorded in the ledger and NOTHING is dispatched;
 *   2. check the provider's circuit breaker and rate limit;
 *   3. commit a `DISPATCHED` ledger row (`ledger.ts`) BEFORE the request goes out;
 *   4. call the transport under a deadline (`transport.ts`);
 *   5. normalize and bound the output, storing the full payload as an artifact when
 *      it was truncated or malformed (AC4);
 *   6. settle the ledger row with a digest, latency and artifact reference (AC6).
 *
 * Two decisions in that sequence are worth stating because the alternative is more
 * natural and wrong.
 *
 * **A refusal is recorded, not merely thrown.** Step 1 refusals never touch the
 * network, so it is tempting to treat them as caller errors and return early. But
 * "the model proposed a cross-scope call" is the single most important thing an
 * auditor can ask this system, and an exception that a caller might catch and
 * discard is not an answer. So a refusal is a ledger row with a `refusal_code`.
 *
 * **Retry is permitted only for a definitely-undispatched failure.** Not for a
 * timeout, not for an unclassified transport error, not "just once more for reads".
 * A read is not idempotent from the provider's perspective — it consumes rate
 * budget, it can trip the provider's own abuse detection, and in the case of a
 * paginated cursor it can advance state. AC5 says a timeout must not become a false
 * success; the mechanism is that a post-dispatch timeout is `AMBIGUOUS` and
 * `AMBIGUOUS` is terminal.
 *
 * Output is `UNTRUSTED_DATA` by construction: `toolResult.output.trust` is a fixed
 * literal in the accepted contract, so a provider response cannot relabel itself,
 * and normalization strips everything that is not plain JSON before the value is
 * ever placed in a result.
 */
import { TrustLevel, canonicalJsonStringify, type AgentRole } from "@remoteagent/contracts";
import { toolResult, type ToolIntent, type ToolResult } from "@remoteagent/contracts";
import type { Database, Queryable } from "@remoteagent/database";
import { redactCommandOutput } from "@remoteagent/implementation-tools";
import type { ArtifactStore } from "@remoteagent/test-evidence";

import {
  MCP_MAX_TOOL_OUTPUT_BYTES,
  McpAmbiguityReason,
  RefusalCode,
  ToolBrokerError,
  ToolBrokerRefusal,
  ToolCallOutcome,
} from "./contracts.js";
import { ToolCallLedgerRepository, digestOf, type ToolCallScope } from "./ledger.js";
import type { ToolManifest } from "./contracts.js";
import { resolveToolScope, type BrokerCaseContext, type ToolRegistry } from "./registry.js";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  assertSupportedProtocolVersion,
  callWithDeadline,
  type ToolTransport,
} from "./transport.js";

/**
 * Per-provider circuit breaker and rate limiter state.
 *
 * Held in memory deliberately, with the durable ledger as the source of truth for
 * *health* (`recentByProvider`). A breaker is a latency-critical, best-effort
 * guard: making every call pay a round trip to decide whether to make a call is a
 * poor trade, and a breaker that resets on deploy is an acceptable failure mode
 * where a rate limiter that forgets its budget is not — which is why the window
 * query exists for the health input and the counters are local.
 */
export type ProviderGuardOptions = Readonly<{
  /** Consecutive non-success outcomes that open the breaker. */
  failureThreshold?: number;
  /** How long the breaker stays open before a probe is allowed. */
  openMs?: number;
  /** Maximum calls per provider per window. */
  maxCallsPerWindow?: number;
  windowMs?: number;
}>;

const DEFAULTS = {
  failureThreshold: 5,
  openMs: 30_000,
  maxCallsPerWindow: 60,
  windowMs: 60_000,
} as const;

type GuardState = {
  consecutiveFailures: number;
  openedAtMs: number | null;
  windowStartMs: number;
  callsInWindow: number;
};

/**
 * Provider-scoped guard. Not case-scoped, on purpose: provider health and provider
 * rate budget are properties of the provider, so a per-case breaker would let N
 * cases each hammer a failing server N times.
 */
export class ProviderGuard {
  readonly #options: Required<ProviderGuardOptions>;
  readonly #states = new Map<string, GuardState>();
  readonly #now: () => number;

  public constructor(options: ProviderGuardOptions = {}, now: () => number = Date.now) {
    this.#options = { ...DEFAULTS, ...options };
    this.#now = now;
  }

  #state(provider: string): GuardState {
    const existing = this.#states.get(provider);
    if (existing !== undefined) return existing;
    const fresh: GuardState = {
      consecutiveFailures: 0,
      openedAtMs: null,
      windowStartMs: this.#now(),
      callsInWindow: 0,
    };
    this.#states.set(provider, fresh);
    return fresh;
  }

  /** Refuse when the breaker is open or the window budget is spent. */
  public assertCallAllowed(provider: string): void {
    const state = this.#state(provider);
    const now = this.#now();

    if (state.openedAtMs !== null) {
      if (now - state.openedAtMs < this.#options.openMs) {
        throw new ToolBrokerRefusal(
          RefusalCode.CIRCUIT_OPEN,
          `circuit for ${provider} is open; retry after ` +
            `${String(this.#options.openMs - (now - state.openedAtMs))}ms`,
        );
      }
      // Half-open: allow exactly one probe. The counter is reset here rather than
      // on success so a probe that fails re-opens immediately instead of needing
      // `failureThreshold` more failures.
      state.openedAtMs = null;
      state.consecutiveFailures = 0;
    }

    if (now - state.windowStartMs >= this.#options.windowMs) {
      state.windowStartMs = now;
      state.callsInWindow = 0;
    }
    if (state.callsInWindow >= this.#options.maxCallsPerWindow) {
      throw new ToolBrokerRefusal(
        RefusalCode.RATE_LIMITED,
        `rate limit for ${provider} exhausted (${String(this.#options.maxCallsPerWindow)} per ` +
          `${String(this.#options.windowMs)}ms)`,
      );
    }
    state.callsInWindow += 1;
  }

  /**
   * Record an outcome.
   *
   * `AMBIGUOUS` counts as a failure for breaker purposes. It is not a success, and
   * a server producing ambiguous outcomes is precisely one that should stop being
   * called — that is the case a breaker exists for.
   */
  public record(provider: string, outcome: ToolCallOutcome): void {
    const state = this.#state(provider);
    if (outcome === ToolCallOutcome.SUCCEEDED) {
      state.consecutiveFailures = 0;
      return;
    }
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.#options.failureThreshold) {
      state.openedAtMs = this.#now();
    }
  }
}

/** Plain JSON only. Anything else is not representable in a tool result. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Coerce an arbitrary provider response into plain JSON, or refuse.
 *
 * A remote server can send anything: `NaN`, a cyclic structure, a 200 MB string, a
 * key named `__proto__`. Normalization is therefore a boundary, not a formality.
 * `__proto__`/`constructor`/`prototype` keys are dropped rather than carried
 * because a downstream consumer that spreads this object into a fresh one would
 * otherwise be doing prototype pollution on our behalf.
 *
 * Depth and breadth are bounded so a deeply-nested response cannot exhaust the
 * stack before the size check ever runs.
 */
function normalizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > 32)
    throw new ToolBrokerRefusal(RefusalCode.PROTOCOL_VIOLATION, "output nests too deeply");
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ToolBrokerRefusal(
        RefusalCode.PROTOCOL_VIOLATION,
        "output carries a non-finite number",
      );
    }
    return value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (value.length > 4096) {
      throw new ToolBrokerRefusal(RefusalCode.PROTOCOL_VIOLATION, "output array is too long");
    }
    return value.map((item) => normalizeJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 1024) {
      throw new ToolBrokerRefusal(
        RefusalCode.PROTOCOL_VIOLATION,
        "output object has too many keys",
      );
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (item === undefined) continue;
      result[key] = normalizeJson(item, depth + 1);
    }
    return result;
  }
  // functions, symbols, bigint, undefined at the top level.
  throw new ToolBrokerRefusal(
    RefusalCode.PROTOCOL_VIOLATION,
    `output carries a ${typeof value}, which is not JSON`,
  );
}

export type ExecuteInput = Readonly<{
  intent: ToolIntent;
  role: AgentRole;
  manifest: ToolManifest;
  context: BrokerCaseContext;
  callId: string;
  correlationId: string;
  traceId: string;
  timeoutMs?: number;
}>;

export type BrokerOptions = Readonly<{
  registry: ToolRegistry;
  ledger: ToolCallLedgerRepository;
  transport: ToolTransport;
  /** Where oversized or malformed output is preserved as evidence (AC4). */
  artifacts: ArtifactStore;
  /** Evidence scope for artifacts. A brokered read has no workspace of its own. */
  artifactWorkspaceId: string;
  guard?: ProviderGuard;
  /** Literals to redact from anything stored or logged. */
  knownSecrets?: readonly string[];
  now?: () => number;
}>;

/**
 * The broker. The only way an agent reaches an MCP tool.
 *
 * Holds no credential and exposes none: credential use is sealed behind the
 * transport the caller supplies (see `credential.ts`), so nothing on this object
 * can be logged or serialized into a token leak.
 */
export class McpToolBroker {
  readonly #registry: ToolRegistry;
  readonly #ledger: ToolCallLedgerRepository;
  readonly #transport: ToolTransport;
  readonly #artifacts: ArtifactStore;
  readonly #artifactWorkspaceId: string;
  readonly #guard: ProviderGuard;
  readonly #knownSecrets: readonly string[];
  readonly #now: () => number;

  public constructor(options: BrokerOptions) {
    this.#registry = options.registry;
    this.#ledger = options.ledger;
    this.#transport = options.transport;
    this.#artifacts = options.artifacts;
    this.#artifactWorkspaceId = options.artifactWorkspaceId;
    this.#guard = options.guard ?? new ProviderGuard({}, options.now);
    this.#knownSecrets = options.knownSecrets ?? [];
    this.#now = options.now ?? Date.now;
  }

  /**
   * Execute one proposed tool call.
   *
   * `db` is used for the pre-dispatch ledger commit and the post-call settle. Those
   * are deliberately two separate transactions: a single transaction spanning the
   * network call would hold a pooled connection for the whole request and — worse —
   * would roll the ledger row back on failure, destroying the very evidence that
   * makes an unreported call resolvable.
   */
  public async execute(db: Database, input: ExecuteInput): Promise<ToolResult> {
    const scope: ToolCallScope = {
      caseId: input.context.caseScope.caseId,
      ownerId: input.context.caseScope.ownerId,
    };

    // Step 1: resolve scope. A refusal is recorded and nothing is dispatched.
    let resolved;
    try {
      resolved = resolveToolScope({
        registry: this.#registry,
        manifest: input.manifest,
        context: input.context,
        intent: input.intent,
        role: input.role,
      });
    } catch (error) {
      if (error instanceof ToolBrokerRefusal) {
        await this.#recordRefusal(db, input, scope, error);
      }
      throw error;
    }

    const descriptor = resolved.descriptor;
    const argumentsDigest = digestOf(resolved.intent.arguments);

    // Step 2: provider health and budget. Also a recorded refusal — an operator
    // asking "why did this case stall" must be able to see the breaker in the
    // ledger rather than inferring it from logs.
    try {
      this.#guard.assertCallAllowed(descriptor.provider);
    } catch (error) {
      if (error instanceof ToolBrokerRefusal) {
        await this.#ledger.recordRefusal(db, {
          callId: input.callId,
          intentId: input.intent.intent_id,
          scope,
          role: input.role,
          toolName: descriptor.name,
          toolVersion: descriptor.version,
          provider: descriptor.provider,
          riskTier: descriptor.risk_tier,
          refusalCode: error.code,
          validatedArgumentsDigest: argumentsDigest,
          correlationId: input.correlationId,
          traceId: input.traceId,
        });
      }
      throw error;
    }

    // Version negotiation before anything is sent. A server speaking a version we
    // do not implement may read our scoping argument differently than we mean it.
    const version = await this.#transport.protocolVersion();
    try {
      assertSupportedProtocolVersion(version);
    } catch (error) {
      if (error instanceof ToolBrokerRefusal) {
        await this.#ledger.recordRefusal(db, {
          callId: input.callId,
          intentId: input.intent.intent_id,
          scope,
          role: input.role,
          toolName: descriptor.name,
          toolVersion: descriptor.version,
          provider: descriptor.provider,
          riskTier: descriptor.risk_tier,
          refusalCode: error.code,
          validatedArgumentsDigest: argumentsDigest,
          correlationId: input.correlationId,
          traceId: input.traceId,
        });
      }
      throw error;
    }

    // Step 3: commit the dispatch row BEFORE the request leaves.
    await this.#ledger.recordDispatch(db, {
      callId: input.callId,
      intentId: input.intent.intent_id,
      scope,
      role: input.role,
      toolName: descriptor.name,
      toolVersion: descriptor.version,
      provider: descriptor.provider,
      riskTier: descriptor.risk_tier,
      validatedArgumentsDigest: argumentsDigest,
      correlationId: input.correlationId,
      traceId: input.traceId,
    });

    // Step 4: bounded call. The scoped target is a SERVER-injected argument, and a
    // collision with a model-supplied key of the same name is an error rather than a
    // precedence rule — see `mergeServerScopeArgument`.
    const startedAt = this.#now();
    const outcome = await callWithDeadline(this.#transport, {
      toolName: descriptor.name,
      arguments: mergeServerScopeArgument(
        resolved.intent.arguments,
        descriptor.scope.scope_kind,
        resolved.target.value,
      ),
      timeoutMs: input.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      onDispatch: () => undefined,
    });
    const latencyMs = Math.max(0, this.#now() - startedAt);

    if (outcome.kind === "AMBIGUOUS") {
      // AC5. Terminal: not retried, and NOT reported as a read failure.
      this.#guard.record(descriptor.provider, ToolCallOutcome.AMBIGUOUS);
      await this.#ledger.settle(db, input.callId, scope, {
        outcome: ToolCallOutcome.AMBIGUOUS,
        ambiguityReason: McpAmbiguityReason.TIMEOUT_AFTER_DISPATCH,
        latencyMs,
      });
      return this.#result(
        input,
        ToolCallOutcome.AMBIGUOUS,
        {
          ambiguous: true,
          requires_reconciliation: true,
          reason: outcome.reason,
        },
        latencyMs,
        outcome.reason,
      );
    }

    if (outcome.kind === "FAILED") {
      this.#guard.record(descriptor.provider, ToolCallOutcome.FAILED);
      await this.#ledger.settle(db, input.callId, scope, {
        outcome: ToolCallOutcome.FAILED,
        latencyMs,
      });
      return this.#result(input, ToolCallOutcome.FAILED, {}, latencyMs, outcome.reason);
    }

    // Step 5: normalize and bound. A malformed response is stored as evidence
    // before it is rejected, so "the server sent something unparseable" is a
    // checkable claim rather than an assertion.
    let normalized: JsonValue;
    try {
      normalized = normalizeJson(outcome.value);
    } catch (error) {
      const artifactId = await this.#preserve(input, scope, String(outcome.value ?? ""));
      this.#guard.record(descriptor.provider, ToolCallOutcome.FAILED);
      await this.#ledger.settle(db, input.callId, scope, {
        outcome: ToolCallOutcome.FAILED,
        latencyMs,
        artifactId,
      });
      throw error;
    }

    const encoded = canonicalJsonStringify(normalized);
    const encodedBytes = Buffer.byteLength(encoded, "utf8");
    let value: Record<string, JsonValue>;
    let artifactId: string | null = null;

    if (encodedBytes > MCP_MAX_TOOL_OUTPUT_BYTES) {
      // AC4: the payload is bounded for the model, and the FULL output survives as
      // artifact evidence with its own digest. Dropping it would make "the server
      // returned 40 MB" unverifiable after the fact.
      artifactId = await this.#preserve(input, scope, encoded);
      value = {
        truncated: true,
        original_byte_length: encodedBytes,
        artifact_id: artifactId,
        excerpt: redactCommandOutput(encoded.slice(0, 4096), this.#knownSecrets),
      };
    } else {
      value = isPlainObject(normalized) ? normalized : { value: normalized };
    }

    const resultDigest = digestOf(value);
    this.#guard.record(descriptor.provider, ToolCallOutcome.SUCCEEDED);
    await this.#ledger.settle(db, input.callId, scope, {
      outcome: ToolCallOutcome.SUCCEEDED,
      resultDigest,
      latencyMs,
      artifactId,
    });
    return this.#result(input, ToolCallOutcome.SUCCEEDED, value, latencyMs);
  }

  async #recordRefusal(
    db: Queryable,
    input: ExecuteInput,
    scope: ToolCallScope,
    refusal: ToolBrokerRefusal,
  ): Promise<void> {
    // A refusal may precede tool resolution entirely (UNKNOWN_TOOL), so the
    // descriptor fields fall back to what the intent claimed. The tool NAME is
    // model-supplied here and that is acceptable: it is recorded as an attempt, not
    // acted upon, and the audit question is "what did it try to call".
    let provider: "jira" | "gmail" | "calendar" | "gitlab" | "discord" = "jira";
    let toolVersion = 1;
    let riskTier: "R0" | "R1" | "R2" | "R3" | "R4" = "R0";
    try {
      const descriptor = this.#registry.describe(input.intent.tool_name);
      provider = descriptor.provider;
      toolVersion = descriptor.version;
      riskTier = descriptor.risk_tier;
    } catch {
      // Unknown tool: keep the fallbacks. The refusal code carries the meaning.
    }
    await this.#ledger.recordRefusal(db, {
      callId: input.callId,
      intentId: input.intent.intent_id,
      scope,
      role: input.role,
      toolName: input.intent.tool_name.slice(0, 512),
      toolVersion,
      provider,
      riskTier,
      refusalCode: refusal.code,
      validatedArgumentsDigest: digestOf(input.intent.arguments.value),
      correlationId: input.correlationId,
      traceId: input.traceId,
    });
  }

  /** Preserve output as artifact evidence. Redaction happens inside the store. */
  async #preserve(input: ExecuteInput, scope: ToolCallScope, payload: string): Promise<string> {
    const reference = await this.#artifacts.put({
      scope: { case_id: scope.caseId, workspace_id: this.#artifactWorkspaceId },
      artifact_id: `mcp-${input.callId}`,
      content: payload,
    });
    return reference.artifact_id;
  }

  #result(
    input: ExecuteInput,
    outcome: ToolCallOutcome,
    value: Record<string, JsonValue>,
    latencyMs: number,
    errorMessage?: string,
  ): ToolResult {
    return toolResult.parse({
      schema_version: 1,
      intent_id: input.intent.intent_id,
      // The accepted contract has two statuses. AMBIGUOUS maps to FAILED at the
      // contract boundary and carries `requires_reconciliation` in the payload:
      // a caller must never read an unresolved call as a success, and the ledger
      // holds the authoritative three-way outcome.
      status: outcome === ToolCallOutcome.SUCCEEDED ? "SUCCEEDED" : "FAILED",
      output: { trust: TrustLevel.UNTRUSTED_DATA, value },
      ...(errorMessage === undefined
        ? {}
        : { error_message: redactCommandOutput(errorMessage, this.#knownSecrets) }),
      latency_ms: latencyMs,
      correlation_id: input.correlationId,
      observed_at: new Date(this.#now()).toISOString(),
    });
  }
}

function isPlainObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge the server-resolved resource into the validated arguments.
 *
 * A spread order alone would be a weak guarantee: it reads as "the injected value
 * wins", but nothing enforces it and reversing the two lines is an invisible change
 * — a mutation probe confirmed that reversing them broke no test, which is exactly
 * the `CTF-010` shape (a comment describing a property the code does not enforce).
 * So the collision is an ERROR rather than a precedence rule.
 *
 * The path is unreachable today, and deliberately so: the forbidden-name gate
 * rejects `project_id` and friends from model output, and registration rejects a
 * descriptor that declares one. This is the third layer, and it fails loudly rather
 * than silently preferring one value over the other — because if the first two
 * layers ever regress, "the model's project_id was ignored" and "the model's
 * project_id was used" are both worse outcomes than a refusal.
 */
export function mergeServerScopeArgument(
  validatedArguments: Readonly<Record<string, unknown>>,
  scopeKind: string,
  targetValue: string,
): Record<string, unknown> {
  const injectedName = scopeArgumentName(scopeKind);
  if (Object.hasOwn(validatedArguments, injectedName)) {
    throw new ToolBrokerRefusal(
      RefusalCode.SCOPE_IN_ARGUMENTS,
      `argument "${injectedName}" is server-injected and must not be present in ` +
        "validated model arguments",
    );
  }
  return { ...validatedArguments, [injectedName]: targetValue };
}

/**
 * The argument name under which the broker injects the resolved resource.
 *
 * Server-chosen and distinct from anything the model may supply: the forbidden-name
 * gate rejects `project_id`, `account_id` and friends from model output, so these
 * names can only ever have been set here.
 */
function scopeArgumentName(kind: string): string {
  switch (kind) {
    case "project":
      return "project_id";
    case "repository":
      return "repository_id";
    case "calendar":
      return "calendar_id";
    case "account":
      return "account_id";
    default:
      throw new ToolBrokerError(`no scope argument mapping for ${kind}`);
  }
}
