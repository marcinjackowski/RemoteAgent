/**
 * The server-owned tool registry, the per-role manifest, and scope injection.
 *
 * AC1 and AC2 are decided here, and the design of each is a reaction to how the
 * obvious version fails.
 *
 * **AC1 — the model cannot select a connection or repository.** The mechanism is
 * not "validate the model's `connection_id` against the allowlist". That design
 * puts the authoritative identifier in model output and relies on a check; the
 * check is one `if` away from being wrong, which is exactly how `POLICY_NOT_EXTENSIBLE`
 * happened in RA-012. Instead the resolved scope is built from the case's grants by
 * {@link resolveToolScope}, and an argument that so much as *names* scope is a hard
 * refusal (`SCOPE_IN_ARGUMENTS`) before any resolution runs. Three independent
 * layers, in order: the accepted `toolIntent` contract has no scope field at all;
 * a descriptor declaring a scope-named parameter is rejected at REGISTRATION, so
 * the per-tool allowlist schema cannot legitimize one; and the argument names are
 * checked at call time. The layering matters because the first two are structural
 * and the third is the one a test can drive.
 *
 * **AC2 — a role sees the minimal manifest.** Narrowing is per (role, step), not
 * per role or per case: a Planner reading a Jira issue in step "triage" has no
 * business seeing the GitLab tools it will need three steps later. The manifest is
 * *sealed* in the RA-011 sense — frozen and registered in a `WeakSet` by its only
 * producer — because a manifest that a caller can hand-build is not a narrowing,
 * it is a suggestion. The executor demands a sealed manifest, so widening requires
 * going through the registry, which consults the step policy.
 *
 * Why the step policy is an allowlist keyed by (role, step) rather than a denylist
 * or a role-only map: `CTF-010` finding 2 and finding 4. An unknown step yields an
 * EMPTY manifest, not the full set — fail closed when configuration is missing,
 * because "no policy for this step" is not a licence.
 */
import {
  ScopeResolutionError,
  resolveConnectionScope,
  type AuthoritativeCaseScope,
  type AuthoritativeConnection,
} from "@remoteagent/policy";
import {
  RiskTier,
  canonicalJsonStringify,
  type AgentRole,
  type ConnectionScopeEntry,
  type Provider,
  type ResolvedToolIntent,
  type ToolIntent,
} from "@remoteagent/contracts";
import { resolvedToolIntent } from "@remoteagent/contracts";
import * as z from "zod";

import {
  EXECUTABLE_RISK_TIERS,
  MAX_MANIFEST_TOOLS,
  MAX_TOOL_ARGUMENTS_BYTES,
  READ_SCOPE_KINDS,
  RefusalCode,
  ToolBrokerError,
  ToolBrokerRefusal,
  isForbiddenArgumentName,
  type ToolDescriptor,
  type ToolManifest,
  type ToolManifestEntry,
} from "./contracts.js";

/**
 * Which tools a (role, step) pair may see.
 *
 * Server-owned configuration. A missing entry means an empty manifest — never the
 * full registry (`CTF-010` finding 4: an absent declaration is not consent).
 */
export type ToolStepPolicy = Readonly<{
  role: AgentRole;
  step: string;
  /** Tool names visible in this step. Must all exist in the registry. */
  tools: readonly string[];
}>;

const sealedManifests = new WeakSet<object>();

/** Whether a manifest was produced by a registry rather than hand-built. */
export function isSealedManifest(manifest: ToolManifest): boolean {
  return sealedManifests.has(manifest as object);
}

/**
 * Reject a descriptor whose own schema would let scope arrive from the model.
 *
 * This is the layer that makes the forbidden-name list more than a runtime string
 * check: without it, a descriptor author could declare `connection_id` as a normal
 * parameter and the per-tool allowlist would admit it with no rule broken. The
 * failure would look like correct code — the exact shape of `CTF-010`.
 */
function assertDescriptorArgumentsAreScopeFree(descriptor: ToolDescriptor): void {
  const shape = extractObjectShape(descriptor.arguments_schema);
  if (shape === null) {
    throw new ToolBrokerError(
      `tool ${descriptor.name}: arguments_schema must be a strict object schema`,
    );
  }
  for (const key of Object.keys(shape)) {
    if (isForbiddenArgumentName(key)) {
      throw new ToolBrokerError(
        `tool ${descriptor.name}: argument "${key}" names authoritative scope, ` +
          "which the broker injects and the model may never supply",
      );
    }
  }
}

/**
 * Pull the shape out of a strict object schema, or null if it is not one.
 *
 * A non-strict object is refused rather than tolerated: `z.object` and
 * `z.looseObject` pass unknown keys through (`catchall` of `unknown`), so an
 * argument the broker never validated would reach the provider. `z.strictObject`
 * sets `catchall` to `never`, which is what makes an unknown key an error instead
 * of a passenger.
 */
function extractObjectShape(schema: z.ZodType): Record<string, unknown> | null {
  const def = (
    schema as {
      def?: {
        type?: string;
        shape?: Record<string, unknown>;
        catchall?: { def?: { type?: string } };
      };
    }
  ).def;
  if (def?.type !== "object" || def.shape === undefined) return null;
  if (def.catchall?.def?.type !== "never") return null;
  return def.shape;
}

/**
 * The server-owned tool registry.
 *
 * Registration is the policy gate: a descriptor that is above the executable risk
 * tier, is bound to a non-read scope kind, or declares a scope-naming argument is
 * refused HERE, at configuration time, rather than at call time. A configuration
 * error should be impossible to deploy, not merely caught on the first call.
 */
export class ToolRegistry {
  readonly #descriptors = new Map<string, ToolDescriptor>();
  readonly #stepPolicies = new Map<string, readonly string[]>();

  public constructor(
    descriptors: readonly ToolDescriptor[],
    stepPolicies: readonly ToolStepPolicy[] = [],
  ) {
    for (const descriptor of descriptors) this.#register(descriptor);
    for (const policy of stepPolicies) this.#registerPolicy(policy);
  }

  #register(descriptor: ToolDescriptor): void {
    if (this.#descriptors.has(descriptor.name)) {
      throw new ToolBrokerError(`tool ${descriptor.name} is registered twice`);
    }
    if (!EXECUTABLE_RISK_TIERS.includes(descriptor.risk_tier)) {
      // RA-021 is read-only. A write-tier tool in this registry would be a tool
      // the broker could dispatch with no approval path, so it is refused at
      // registration rather than at call time.
      throw new ToolBrokerError(
        `tool ${descriptor.name}: risk tier ${descriptor.risk_tier} is not executable ` +
          `by this broker (executable: ${EXECUTABLE_RISK_TIERS.join(", ")})`,
      );
    }
    if (!READ_SCOPE_KINDS.includes(descriptor.scope.scope_kind)) {
      throw new ToolBrokerError(
        `tool ${descriptor.name}: scope kind ${descriptor.scope.scope_kind} is not a ` +
          "provider read resource",
      );
    }
    if (!Number.isInteger(descriptor.version) || descriptor.version <= 0) {
      throw new ToolBrokerError(`tool ${descriptor.name}: version must be a positive integer`);
    }
    if (descriptor.allowed_roles.length === 0) {
      throw new ToolBrokerError(`tool ${descriptor.name}: no role may use it`);
    }
    assertDescriptorArgumentsAreScopeFree(descriptor);
    this.#descriptors.set(descriptor.name, descriptor);
  }

  #registerPolicy(policy: ToolStepPolicy): void {
    for (const name of policy.tools) {
      const descriptor = this.#descriptors.get(name);
      if (descriptor === undefined) {
        throw new ToolBrokerError(
          `step policy ${policy.role}/${policy.step} names unknown tool ${name}`,
        );
      }
      if (!descriptor.allowed_roles.includes(policy.role)) {
        // A step policy may narrow what a role sees; it may never widen it past
        // the descriptor's own role list.
        throw new ToolBrokerError(
          `step policy ${policy.role}/${policy.step} grants ${name}, which does not ` +
            `allow role ${policy.role}`,
        );
      }
    }
    const key = policyKey(policy.role, policy.step);
    if (this.#stepPolicies.has(key)) {
      throw new ToolBrokerError(`step policy ${policy.role}/${policy.step} is registered twice`);
    }
    this.#stepPolicies.set(key, [...policy.tools]);
  }

  /** Look up a descriptor, or refuse with `UNKNOWN_TOOL`. */
  public describe(toolName: string): ToolDescriptor {
    const descriptor = this.#descriptors.get(toolName);
    if (descriptor === undefined) {
      throw new ToolBrokerRefusal(RefusalCode.UNKNOWN_TOOL, `unknown tool ${toolName}`);
    }
    return descriptor;
  }

  /** Registered tool names. Server-side introspection only; not model-facing. */
  public names(): readonly string[] {
    return [...this.#descriptors.keys()];
  }

  /**
   * Mint the sealed, minimal manifest one role may see for one step (AC2).
   *
   * An unknown (role, step) yields an empty manifest. That is the fail-closed
   * choice and it is deliberate: the alternative — falling back to everything the
   * role is allowed — turns a configuration omission into a silent widening.
   */
  public manifestFor(input: { caseId: string; role: AgentRole; step: string }): ToolManifest {
    const allowed = this.#stepPolicies.get(policyKey(input.role, input.step)) ?? [];
    const tools: ToolManifestEntry[] = [];
    for (const name of allowed) {
      const descriptor = this.#descriptors.get(name);
      if (descriptor === undefined) continue;
      tools.push(
        Object.freeze({
          name: descriptor.name,
          provider: descriptor.provider,
          risk_tier: descriptor.risk_tier,
          // Server-authored. A remote `description` never reaches this field, so
          // an injected instruction cannot ride into a prompt (AC3).
          description: descriptor.description,
          version: descriptor.version,
        }),
      );
    }
    if (tools.length > MAX_MANIFEST_TOOLS) {
      throw new ToolBrokerError(
        `manifest for ${input.role}/${input.step} exceeds ${String(MAX_MANIFEST_TOOLS)} tools`,
      );
    }
    const manifest: ToolManifest = Object.freeze({
      case_id: input.caseId,
      role: input.role,
      step: input.step,
      tools: Object.freeze(tools),
    });
    sealedManifests.add(manifest as object);
    return manifest;
  }
}

function policyKey(role: AgentRole, step: string): string {
  return `${role} ${step}`;
}

/**
 * Refuse a scope-naming key ANYWHERE in the proposed arguments, at any depth.
 *
 * A top-level-only check was the first version of this, and an adversarial probe
 * defeated it: a descriptor that legitimately accepts a nested record (a filter map,
 * say) forwarded a nested `connection_id` verbatim to the provider. Authoritative
 * scope was still correct - the resolver never reads model arguments, and the probe
 * confirmed the injected target stayed the case's own grant - so this was not
 * privilege escalation. It was a subtler problem: a provider-side filter named
 * `connection_id` may narrow, widen or redirect the read on the far side, and the
 * broker would have no idea it had happened. The channel should not exist, so it is
 * closed at every depth rather than only where it was convenient to look.
 *
 * Depth is bounded so a deeply nested proposal cannot exhaust the stack; the size
 * bound already ran, so 16 levels is far beyond anything a real tool accepts.
 *
 * The offending VALUE is never echoed - it is `UNTRUSTED_DATA` and this message
 * reaches logs. The KEY is echoed, which is safe: it matched a server-owned list, so
 * it carries no attacker-chosen content.
 */
function assertNoScopeNamedKey(value: unknown, depth = 0, path = ""): void {
  if (depth > 16 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoScopeNamedKey(item, depth + 1, path + "[" + String(index) + "]");
    });
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const here = path === "" ? key : path + "." + key;
    if (isForbiddenArgumentName(key)) {
      throw new ToolBrokerRefusal(
        RefusalCode.SCOPE_IN_ARGUMENTS,
        'argument "' + here + '" names authoritative scope; the broker injects it',
      );
    }
    assertNoScopeNamedKey(nested, depth + 1, here);
  }
}

/** What the broker knows, deterministically, about the case it is serving. */
export type BrokerCaseContext = Readonly<{
  caseScope: AuthoritativeCaseScope;
  connections: readonly AuthoritativeConnection[];
}>;

export type ResolvedScopeResult = Readonly<{
  intent: ResolvedToolIntent;
  /** The single provider resource this call acts on. Server-selected. */
  target: ConnectionScopeEntry;
  connectionId: string;
  descriptor: ToolDescriptor;
}>;

/**
 * Turn a model-proposed intent into a broker-resolved one (AC1).
 *
 * The order of operations is the guarantee, so it is worth stating plainly:
 *
 *   1. the tool must exist in the server-owned registry;
 *   2. the tool must be in THIS role's sealed manifest for THIS step;
 *   3. the encoded arguments must be within bounds;
 *   4. no argument may NAME scope — refused before anything is resolved;
 *   5. arguments are parsed through the descriptor's strict schema, and only the
 *      PARSED value is carried forward;
 *   6. scope is resolved from the case's authoritative grants, with the model
 *      contributing nothing to the resolution.
 *
 * Step 4 precedes step 5 because a strict schema would reject a scope-named key as
 * merely "unknown", which is a weaker and less legible refusal than the one AC1
 * asks for — and `CTF-010` finding 1 is that a test asserting the weaker outcome
 * cannot tell the two apart.
 */
export function resolveToolScope(input: {
  registry: ToolRegistry;
  manifest: ToolManifest;
  context: BrokerCaseContext;
  intent: ToolIntent;
  role: AgentRole;
}): ResolvedScopeResult {
  if (!isSealedManifest(input.manifest)) {
    // A hand-built manifest is not evidence of narrowing. Refusing it is what
    // keeps AC2 from being bypassable by constructing an object literal.
    throw new ToolBrokerError("manifest was not produced by the registry");
  }
  if (input.manifest.role !== input.role) {
    throw new ToolBrokerError("manifest role does not match the calling role");
  }
  if (input.manifest.case_id !== input.context.caseScope.caseId) {
    throw new ToolBrokerError("manifest case does not match the resolved case scope");
  }

  const descriptor = input.registry.describe(input.intent.tool_name);

  if (!input.manifest.tools.some((entry) => entry.name === descriptor.name)) {
    throw new ToolBrokerRefusal(
      RefusalCode.TOOL_NOT_IN_MANIFEST,
      `tool ${descriptor.name} is not visible to ${input.role} in step ${input.manifest.step}`,
    );
  }
  if (!descriptor.allowed_roles.includes(input.role)) {
    throw new ToolBrokerRefusal(
      RefusalCode.TOOL_NOT_IN_MANIFEST,
      `tool ${descriptor.name} does not allow role ${input.role}`,
    );
  }

  const proposed = input.intent.arguments.value;
  const encodedLength = Buffer.byteLength(canonicalJsonStringify(proposed), "utf8");
  if (encodedLength > MAX_TOOL_ARGUMENTS_BYTES) {
    throw new ToolBrokerRefusal(
      RefusalCode.ARGUMENTS_TOO_LARGE,
      `arguments exceed ${String(MAX_TOOL_ARGUMENTS_BYTES)} bytes`,
    );
  }

  // AC1, layer three. Checked BEFORE schema parsing so the refusal names the real
  // problem — scope in model output — rather than reporting a generic unknown key.
  assertNoScopeNamedKey(proposed);

  const parsed = descriptor.arguments_schema.safeParse(proposed);
  if (!parsed.success) {
    throw new ToolBrokerRefusal(
      RefusalCode.ARGUMENTS_INVALID,
      `arguments do not satisfy the schema for ${descriptor.name}`,
    );
  }

  // Scope resolution. Note what is NOT passed: `requestedConnectionId` and
  // `requestedTarget` are absent, so the resolver has nothing model-derived to
  // consider. It selects the single connection the case authorises for this
  // provider and capability, and returns only the case-filtered grants.
  let resolved;
  try {
    resolved = resolveConnectionScope({
      caseScope: input.context.caseScope,
      connections: input.context.connections,
      provider: descriptor.provider,
      alias: aliasForProvider(input.context, descriptor.provider),
      requiredCapability: descriptor.scope.required_capability,
    });
  } catch (error) {
    if (error instanceof ScopeResolutionError) {
      throw new ToolBrokerRefusal(RefusalCode.OUT_OF_SCOPE, error.message);
    }
    throw error;
  }

  const candidates = resolved.scopes.filter((scope) => scope.kind === descriptor.scope.scope_kind);
  if (candidates.length === 0) {
    throw new ToolBrokerRefusal(
      RefusalCode.OUT_OF_SCOPE,
      `case holds no ${descriptor.scope.scope_kind} grant for ${descriptor.provider}`,
    );
  }
  if (candidates.length > 1) {
    // Ambiguity is refused, never guessed. Picking the first would make the
    // effective target depend on grant ordering — a silent, data-dependent choice
    // of which mailbox or project a read hits. RA-020's audit closed the same
    // shape for calendar channels.
    throw new ToolBrokerRefusal(
      RefusalCode.OUT_OF_SCOPE,
      `case holds ${String(candidates.length)} ${descriptor.scope.scope_kind} grants for ` +
        `${descriptor.provider}; the target is ambiguous and is not guessed`,
    );
  }
  const target = candidates[0]!;

  const intent = resolvedToolIntent.parse({
    schema_version: 1,
    intent_id: input.intent.intent_id,
    case_id: input.context.caseScope.caseId,
    tool_name: descriptor.name,
    // The PARSED arguments, not the proposal. Unknown keys were rejected by the
    // strict schema, so nothing unvalidated is forwarded.
    arguments: parsed.data as Record<string, unknown>,
    scope: {
      owner_id: input.context.caseScope.ownerId,
      connection_ids: [resolved.connectionId],
      repo_allowlist: resolved.scopes
        .filter((scope) => scope.kind === "repository")
        .map((scope) => scope.value),
    },
  });

  return Object.freeze({
    intent,
    target: Object.freeze({ ...target }),
    connectionId: resolved.connectionId,
    descriptor,
  });
}

/**
 * The alias to resolve against for a provider.
 *
 * A case is scoped to one alias per provider by its grants, and the alias is
 * trusted configuration rather than model input (the RA-019/RA-020 rule). Deriving
 * it from the case's own connections keeps it that way; accepting it as a
 * parameter here would reopen the channel AC1 closes.
 */
function aliasForProvider(context: BrokerCaseContext, provider: Provider) {
  const allowed = new Set(context.caseScope.connectionIds);
  const granted = new Set(context.caseScope.resourceScopes.map((grant) => grant.connectionId));
  const aliases = new Set(
    context.connections
      .filter(
        (connection) =>
          connection.provider === provider &&
          connection.ownerId === context.caseScope.ownerId &&
          allowed.has(connection.connectionId) &&
          granted.has(connection.connectionId),
      )
      .map((connection) => connection.alias),
  );
  if (aliases.size !== 1) {
    // Zero: the case has no granted connection for this provider. More than one:
    // the case spans both aliases for one provider, so choosing between them
    // would be exactly the cross-account mixing RA-019 and RA-020 forbid.
    throw new ToolBrokerRefusal(
      RefusalCode.OUT_OF_SCOPE,
      aliases.size === 0
        ? `case holds no granted ${provider} connection`
        : `case spans ${String(aliases.size)} ${provider} aliases; refusing to choose`,
    );
  }
  return [...aliases][0]!;
}

/** Re-exported for callers that build descriptors. Kept here to avoid a cycle. */
export const READ_ONLY_RISK_TIER = RiskTier.R0;
