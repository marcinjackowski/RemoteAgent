/**
 * Containment for an external managed tool boundary (RA-023-WU-05, AC3).
 *
 * WHY THIS EXISTS EVEN THOUGH WE ARE NOT ADOPTING AGENTCORE GATEWAY. ADR-0008 records
 * `DEFER` for every provider, so no Gateway is deployed. This module is still built,
 * because the property it enforces is not about AgentCore:
 *
 *   > A boundary outside this system may NARROW what an action is allowed to do. It may
 *   > never WIDEN it.
 *
 * Anything that ever sits between the orchestrator and a provider — a managed gateway, a
 * broker, someone else's MCP server — is a place where a scope or a risk tier arrives
 * from outside our trust boundary. Writing the containment now means a future adoption
 * starts with the guard already in place and already tested, rather than negotiating it
 * under deadline. It also means the rule is stated once instead of re-derived per
 * integration.
 *
 * WHAT "WIDEN" MEANS PRECISELY, because a vague version of this rule is unenforceable:
 *
 *  1. **Tier.** A remote descriptor may declare a HIGHER risk tier than our registry
 *     (conservative, harmless) but never a lower one. This is the same rule
 *     `evaluatePolicy` applies to annotations, restated at the boundary where the
 *     descriptor arrives rather than where the decision is made — two independent
 *     statements, because a single one is one edit away from being wrong.
 *  2. **Connections.** A gateway may offer FEWER connections than the case is scoped to.
 *     A connection the case was never granted is a refusal, not a discovery.
 *  3. **Owner.** A gateway may not introduce an owner at all. Owner scope is derived
 *     from the case in `packages/database` and is not a value any external surface may
 *     assert.
 *  4. **Policy decision.** A gateway may not supply `AUTO_ALLOW`, or any decision. Our
 *     engine decides; a remote assertion that something is pre-authorized is exactly
 *     the "model/vendor is not the authorization layer" rule (`AGENTS.md` §4).
 *  5. **Tools.** A gateway may not offer a tool absent from our server-owned registry,
 *     because an unregistered tool has no established blast radius (`CTF-010` finding 4:
 *     no declaration is not consent).
 *
 * FAIL-CLOSED ON EMPTY. A manifest that declares nothing yields NO capability, never
 * "everything". Two HIGH defects in RA-014 came from treating an absent declaration as
 * permission, and AWS's own guidance for Gateway interceptors says the same thing:
 * "Design interceptors to deny access by default when authorization cannot be
 * determined."
 */
import { RiskTier, type Provider } from "@remoteagent/contracts";

import { ACTION_REGISTRY, resolveRiskTier } from "./policy-engine.js";

/**
 * Ceiling on how many offers one manifest may contain.
 *
 * The WU-05 probe handed containment 20 000 offers and got 20 000 allowed entries back.
 * Nothing bounded it. A manifest is attacker-influenced input from outside the trust
 * boundary, so an unbounded one is a resource exhaustion vector against whatever consumes
 * the result — the model's prompt first of all, which is where RA-021 already caps
 * manifests at 64 tools for the same reason.
 *
 * Matches `MAX_MANIFEST_TOOLS` in `packages/mcp-tool-broker` deliberately: two different
 * ceilings for "how many tools may a model see" would be two different answers to one
 * question.
 */
export const MAX_BOUNDARY_OFFERS = 64;

/**
 * The provider each registered tool belongs to, derived from its canonical name.
 *
 * WHY THIS EXISTS. The probe found that a case scoped to `jira` alone was admitted
 * `gmail.draft.create`, `calendar.event.*` and `gitlab.*` — because containment only
 * checked a provider the boundary CLAIMED, and a boundary that claims nothing skipped the
 * check entirely. So the omission was the bypass: the safest-looking manifest was the one
 * that asserted least.
 *
 * The provider is now derived from the tool name instead, which is a server-owned fact
 * rather than an external claim. Prefix-based rather than a second hand-maintained table,
 * so a tool added to `ACTION_REGISTRY` cannot silently arrive with no provider — an
 * unrecognized prefix is a refusal, not a default.
 */
const TOOL_NAME_PROVIDER_PREFIXES: readonly (readonly [string, Provider])[] = [
  ["jira.", "jira"],
  ["gmail.", "gmail"],
  ["calendar.", "calendar"],
  ["gitlab.", "gitlab"],
  // `git.push.force` is a local Git operation applied to a GitLab remote; RA-014/RA-017
  // own that path, so it is scoped to `gitlab`.
  ["git.", "gitlab"],
];

/** The server-owned provider for a tool, or null when its name declares none. */
export function resolveToolProvider(toolName: string): Provider | null {
  for (const [prefix, provider] of TOOL_NAME_PROVIDER_PREFIXES) {
    if (toolName.startsWith(prefix)) return provider;
  }
  return null;
}

/** Why an external boundary's offer was refused. Specific codes, never a boolean. */
export const BoundaryRefusalCode = {
  /** The boundary offered a tool that is not in our server-owned registry. */
  UNREGISTERED_TOOL: "UNREGISTERED_TOOL",
  /** The boundary claimed a lower risk tier than our registry assigns. */
  TIER_DOWNGRADE: "TIER_DOWNGRADE",
  /** The boundary offered a connection outside the case's authoritative scope. */
  CONNECTION_NOT_IN_CASE_SCOPE: "CONNECTION_NOT_IN_CASE_SCOPE",
  /** The boundary asserted an owner. Owner scope is ours to derive, never to receive. */
  OWNER_ASSERTED_EXTERNALLY: "OWNER_ASSERTED_EXTERNALLY",
  /** The boundary asserted a policy decision. Only our engine decides. */
  POLICY_DECISION_ASSERTED_EXTERNALLY: "POLICY_DECISION_ASSERTED_EXTERNALLY",
  /** The boundary offered a provider the case is not scoped to. */
  PROVIDER_NOT_IN_CASE_SCOPE: "PROVIDER_NOT_IN_CASE_SCOPE",
  /** The manifest exceeded {@link MAX_BOUNDARY_OFFERS}. */
  MANIFEST_TOO_LARGE: "MANIFEST_TOO_LARGE",
  /** The same tool was offered more than once; only the first is considered. */
  DUPLICATE_OFFER: "DUPLICATE_OFFER",
  /** The tool's canonical name declares no provider, so its scope cannot be established. */
  TOOL_PROVIDER_UNKNOWN: "TOOL_PROVIDER_UNKNOWN",
} as const;

export type BoundaryRefusalCode = (typeof BoundaryRefusalCode)[keyof typeof BoundaryRefusalCode];

/**
 * One tool as an external boundary describes it.
 *
 * Every optional field is a thing a boundary might try to assert. They are typed as
 * `unknown` rather than as their "correct" types on purpose: the values arrive from
 * outside our trust boundary, so typing them as valid would be a claim this code cannot
 * make, and a cast would launder untrusted input into a trusted shape.
 */
export interface ExternalToolOffer {
  /** Canonical tool name, as the boundary reports it. */
  toolName: string;
  /** A tier the boundary claims. Accepted only to be compared and possibly refused. */
  claimedRiskTier?: unknown;
  /** A connection the boundary claims to route to. */
  claimedConnectionId?: unknown;
  /** An owner the boundary claims. Any value here is a refusal. */
  claimedOwnerId?: unknown;
  /** A policy decision the boundary claims. Any value here is a refusal. */
  claimedPolicyDecision?: unknown;
  /** A provider the boundary claims. */
  claimedProvider?: unknown;
}

/** The authoritative local scope an offer is contained against. */
export interface LocalScope {
  caseId: string;
  /** Derived from the case by `packages/database`; never from an external surface. */
  ownerId: string;
  /** Connection ids the case is actually granted (RA-005 authoritative scope). */
  caseConnectionIds: readonly string[];
  /** Providers the case is scoped to. */
  caseProviders: readonly Provider[];
}

/** An offer that survived containment, reduced to what it is actually allowed to be. */
export interface ContainedTool {
  toolName: string;
  /** OUR tier from the registry — never the claimed one, even when they agree. */
  riskTier: RiskTier;
  connectionId: string;
  /** OUR owner, derived locally. */
  ownerId: string;
}

export interface BoundaryRefusal {
  toolName: string;
  code: BoundaryRefusalCode;
  reason: string;
}

export interface ContainmentResult {
  /** Tools the boundary may offer, narrowed to locally-authorized terms. */
  allowed: readonly ContainedTool[];
  /** Every refusal, with its specific reason, for the audit log. */
  refused: readonly BoundaryRefusal[];
}

/**
 * Contain an external boundary's tool manifest against local authority.
 *
 * Returns the intersection, never a union. There is deliberately no option, flag or
 * configuration by which a caller can make this function accept a wider result — a
 * "trusted boundary" mode would be the whole guarantee undone by one boolean.
 */
export function containExternalManifest(
  offers: readonly ExternalToolOffer[],
  scope: LocalScope,
): ContainmentResult {
  const allowed: ContainedTool[] = [];
  const refused: BoundaryRefusal[] = [];

  const refuse = (toolName: string, code: BoundaryRefusalCode, reason: string): void => {
    refused.push({ toolName, code, reason });
  };

  // A manifest larger than the ceiling is refused WHOLESALE rather than truncated.
  // Truncating would silently pick 64 of 20 000 tools by arrival order, which is a policy
  // decision made by whoever controls the ordering — i.e. the boundary. Refusing the whole
  // manifest keeps the decision ours and is visible in the audit log.
  if (offers.length > MAX_BOUNDARY_OFFERS) {
    return {
      allowed: [],
      refused: [
        {
          toolName: "*",
          code: BoundaryRefusalCode.MANIFEST_TOO_LARGE,
          reason: `boundary offered ${offers.length} tools, above the ceiling of ${MAX_BOUNDARY_OFFERS}`,
        },
      ],
    };
  }

  const seen = new Set<string>();

  for (const offer of offers) {
    // 0. One capability per tool. The probe showed three identical offers yielded three
    //    allowed entries — harmless in itself, but it means the boundary controls how many
    //    times a tool appears in the model's manifest, and a duplicate is at best noise in
    //    an audit log that is supposed to say what was authorized.
    if (seen.has(offer.toolName)) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.DUPLICATE_OFFER,
        `tool ${offer.toolName} was offered more than once; only the first offer is considered`,
      );
      continue;
    }
    seen.add(offer.toolName);

    // 1. Owner and policy decision are refused on PRESENCE, not on value. There is no
    //    correct value a boundary could send: owner scope is derived from the case, and
    //    the policy decision is computed by our engine. Comparing them instead of
    //    refusing them would imply an external assertion could ever be authoritative.
    if (offer.claimedOwnerId !== undefined) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.OWNER_ASSERTED_EXTERNALLY,
        `boundary asserted owner ${String(offer.claimedOwnerId)}; owner scope is derived from the case and is never received from outside`,
      );
      continue;
    }
    if (offer.claimedPolicyDecision !== undefined) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.POLICY_DECISION_ASSERTED_EXTERNALLY,
        `boundary asserted policy decision ${String(offer.claimedPolicyDecision)}; only the local policy engine decides`,
      );
      continue;
    }

    // 2. The tool must exist in OUR registry. An unregistered tool has no established
    //    blast radius, so "the gateway offered it" is not a reason to expose it.
    const localTier = resolveRiskTier(offer.toolName);
    if (localTier === null) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.UNREGISTERED_TOOL,
        `tool ${offer.toolName} is not in the server-owned action registry`,
      );
      continue;
    }

    // 3. A claimed tier may be equal or HIGHER, never lower. Higher is conservative and
    //    cannot grant anything; lower is an escalation attempt.
    if (offer.claimedRiskTier !== undefined) {
      const claimed = offer.claimedRiskTier;
      if (isRiskTier(claimed) && tierRank(claimed) < tierRank(localTier)) {
        refuse(
          offer.toolName,
          BoundaryRefusalCode.TIER_DOWNGRADE,
          `boundary claimed ${claimed} for ${offer.toolName} but the registry assigns ${localTier}`,
        );
        continue;
      }
    }

    // 4. Provider, DERIVED from the tool name rather than taken from the offer.
    //
    //    The first version only validated a provider the boundary CLAIMED, so an offer that
    //    claimed nothing skipped the check — and the probe used exactly that to get
    //    `gmail.draft.create` and `calendar.event.*` admitted to a case scoped to `jira`
    //    alone. The omission WAS the bypass, which is the `CTF-010` finding-4 shape one
    //    level up: absent declaration read as permission.
    //
    //    Checked before the connection so the reported reason is the broader fact when both
    //    are wrong.
    const toolProvider = resolveToolProvider(offer.toolName);
    if (toolProvider === null) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.TOOL_PROVIDER_UNKNOWN,
        `tool ${offer.toolName} declares no provider in its canonical name, so its scope cannot be established`,
      );
      continue;
    }
    if (!scope.caseProviders.includes(toolProvider)) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE,
        `tool ${offer.toolName} belongs to provider ${toolProvider}, which case ${scope.caseId} is not scoped to`,
      );
      continue;
    }
    // A CLAIMED provider that contradicts the derived one is still a refusal: the boundary
    // and the tool name disagreeing means something upstream is wrong.
    if (offer.claimedProvider !== undefined && offer.claimedProvider !== toolProvider) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.PROVIDER_NOT_IN_CASE_SCOPE,
        `boundary claimed provider ${String(offer.claimedProvider)} for ${offer.toolName}, but its canonical name declares ${toolProvider}`,
      );
      continue;
    }

    // 5. The connection must be in the case's authoritative scope. A boundary offering
    //    a connection we never granted is the clearest form of widening.
    //
    //    A MISSING connection is also a refusal, not a default: choosing one for the
    //    boundary would be this function inventing authority. Fail closed on absence is
    //    the `CTF-010` finding-4 rule.
    const connectionId = offer.claimedConnectionId;
    if (typeof connectionId !== "string" || !scope.caseConnectionIds.includes(connectionId)) {
      refuse(
        offer.toolName,
        BoundaryRefusalCode.CONNECTION_NOT_IN_CASE_SCOPE,
        `boundary offered connection ${String(connectionId)}, which is not in the authoritative scope of case ${scope.caseId}`,
      );
      continue;
    }

    // Survived. Rebuilt from LOCAL values only — the offer contributed nothing but the
    // tool name and the connection choice, and both were verified against local
    // authority. Notably the tier is `localTier`, not the claimed one, even when the two
    // agree: passing the claimed value through would make a future divergence invisible.
    allowed.push({
      toolName: offer.toolName,
      riskTier: localTier,
      connectionId,
      ownerId: scope.ownerId,
    });
  }

  return { allowed, refused };
}

/**
 * Assert that a containment result did not widen anything, as a startup/CI check.
 *
 * A second, independent statement of the same rule — the pattern RA-022 used for
 * `assertR4NeverAutoAllowed`, and for the same reason: this guarantee has no recovery if
 * it fails silently, so it gets two mechanisms rather than one.
 *
 * @throws {Error} if any allowed tool falls outside local authority.
 */
export function assertNoWidening(result: ContainmentResult, scope: LocalScope): void {
  for (const tool of result.allowed) {
    if (tool.ownerId !== scope.ownerId) {
      throw new Error(
        `AC3 violation: contained tool ${tool.toolName} carries owner ${tool.ownerId}, not the case's ${scope.ownerId}`,
      );
    }
    if (!scope.caseConnectionIds.includes(tool.connectionId)) {
      throw new Error(
        `AC3 violation: contained tool ${tool.toolName} carries connection ${tool.connectionId}, outside case ${scope.caseId}`,
      );
    }
    const localTier = resolveRiskTier(tool.toolName);
    if (localTier === null) {
      throw new Error(
        `AC3 violation: contained tool ${tool.toolName} is not in the server-owned registry`,
      );
    }
    if (tool.riskTier !== localTier) {
      throw new Error(
        `AC3 violation: contained tool ${tool.toolName} carries tier ${tool.riskTier}, but the registry assigns ${localTier}`,
      );
    }
  }
}

/**
 * Assert that every tool in the registry resolves to a provider, as a startup/CI check.
 *
 * Without this, the prefix table and the registry can drift silently in the direction that
 * LOOKS safe: a tool added with an unrecognized prefix is refused at the boundary, so
 * nothing breaks loudly — it just quietly becomes unreachable through any external
 * boundary, and the reason would be hard to find. Failing at startup turns a silent
 * capability loss into an obvious one.
 *
 * @throws {Error} if any registered tool's name declares no provider.
 */
export function assertEveryToolHasProvider(
  registry: Readonly<Record<string, RiskTier>> = ACTION_REGISTRY,
): void {
  const orphans = Object.keys(registry).filter((name) => resolveToolProvider(name) === null);
  if (orphans.length > 0) {
    throw new Error(
      `these registered tools declare no provider in their canonical name, so an external ` +
        `boundary can never offer them: ${orphans.join(", ")}`,
    );
  }
}

/** Ordering over tiers, so "lower" has a precise meaning. */
function tierRank(tier: RiskTier): number {
  switch (tier) {
    case RiskTier.R0:
      return 0;
    case RiskTier.R1:
      return 1;
    case RiskTier.R2:
      return 2;
    case RiskTier.R3:
      return 3;
    case RiskTier.R4:
      return 4;
  }
}

/** Narrow an untrusted value to a known tier without trusting its declared type. */
function isRiskTier(value: unknown): value is RiskTier {
  return (
    value === RiskTier.R0 ||
    value === RiskTier.R1 ||
    value === RiskTier.R2 ||
    value === RiskTier.R3 ||
    value === RiskTier.R4
  );
}
