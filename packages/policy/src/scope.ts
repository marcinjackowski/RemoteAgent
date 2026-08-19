/** Server-side scope resolution. Model values may narrow, never widen. */
import type {
  ConnectionAlias,
  ConnectionHealth,
  ConnectionScopeEntry,
  ConnectionScopeKind,
  Provider,
} from "@remoteagent/contracts";

export class ScopeResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface AuthoritativeConnection {
  connectionId: string;
  ownerId: string;
  provider: Provider;
  alias: ConnectionAlias;
  capabilities: readonly string[];
  health: ConnectionHealth;
  scopes: readonly ConnectionScopeEntry[];
}

/**
 * A single provider resource the owner granted to ONE case on ONE connection.
 *
 * This is the authoritative, case-scoped resource allowlist (RA-005 remediation,
 * AUDIT-01 HIGH-01). It is always the intersection of case connection membership
 * and the connection's configured scopes — enforced durably by the composite
 * foreign keys on `case_connection_scopes` — so it can never widen either.
 */
export interface CaseResourceGrant {
  connectionId: string;
  kind: ConnectionScopeKind;
  value: string;
}

export interface AuthoritativeCaseScope {
  caseId: string;
  ownerId: string;
  connectionIds: readonly string[];
  /**
   * Per-case resource grants. These grants are the AUTHORITATIVE policy context
   * of the case: a connection is selectable only when the case holds at least
   * one grant on it, and the resolver returns ONLY these grants (intersected
   * with the connection's currently-configured scopes) — never the connection's
   * own broader scope list. A requested target is honoured only when it is a
   * member of THIS list for the selected connection.
   */
  resourceScopes: readonly CaseResourceGrant[];
}

export interface ResolvedConnectionScope extends AuthoritativeConnection {
  caseId: string;
  /**
   * The case-authorised scopes for the selected connection: the intersection of
   * the case's resource grants and the connection's currently-configured scopes.
   * This deliberately overrides the connection's broader `scopes` so no caller
   * ever receives a resource the owner did not grant to THIS case.
   */
  scopes: readonly ConnectionScopeEntry[];
  selectedTarget: ConnectionScopeEntry | null;
}

export function resolveConnectionScope(input: {
  caseScope: AuthoritativeCaseScope;
  connections: readonly AuthoritativeConnection[];
  provider: Provider;
  alias: ConnectionAlias;
  requiredCapability: string;
  requestedConnectionId?: unknown;
  requestedTarget?: { kind: ConnectionScopeKind; value: string };
}): ResolvedConnectionScope {
  const allowedIds = new Set(input.caseScope.connectionIds);

  // The case's resource grants are the authoritative policy context, but a raw
  // grant is not sufficient on its own: a stale grant whose resource is no longer
  // configured on the connection must NOT keep the connection selectable. We
  // therefore index, per connection, ONLY the grants that still intersect the
  // connection's currently-configured scopes. A connection whose intersection is
  // empty holds no live authoritative context and is never a candidate — even
  // with no requested target — so a stale grant cannot silently surface a
  // credential-bearing connection at the resolver boundary (AUDIT-03 MEDIUM-06).
  const configuredKeysByConnection = new Map<string, Set<string>>();
  for (const connection of input.connections) {
    if (!allowedIds.has(connection.connectionId)) continue;
    configuredKeysByConnection.set(
      connection.connectionId,
      new Set(connection.scopes.map((scope) => scopeKey(scope.kind, scope.value))),
    );
  }
  const grantsByConnection = new Map<string, ConnectionScopeEntry[]>();
  for (const grant of input.caseScope.resourceScopes) {
    if (!allowedIds.has(grant.connectionId)) continue;
    // Defence in depth: a grant that is no longer a configured connection scope
    // is stale and is dropped here, so it can neither widen the returned scopes
    // nor keep the connection selectable.
    const configuredKeys = configuredKeysByConnection.get(grant.connectionId);
    if (configuredKeys === undefined || !configuredKeys.has(scopeKey(grant.kind, grant.value))) {
      continue;
    }
    const list = grantsByConnection.get(grant.connectionId) ?? [];
    list.push({ kind: grant.kind, value: grant.value });
    grantsByConnection.set(grant.connectionId, list);
  }

  // A connection is a candidate only when it is a member of the case, matches the
  // requested provider/alias/capability AND the case holds a NON-EMPTY live
  // authoritative policy context (at least one grant that still intersects the
  // connection's configured scopes) on it. The alias can therefore never reach a
  // connection whose context the case did not authorise: a mixed-alias case with
  // a grant only on the private alias cannot select the SonderMind one, and a
  // stale grant with an empty intersection cannot select any connection.
  const candidates = input.connections.filter(
    (connection) =>
      connection.ownerId === input.caseScope.ownerId &&
      allowedIds.has(connection.connectionId) &&
      connection.provider === input.provider &&
      connection.alias === input.alias &&
      connection.capabilities.includes(input.requiredCapability) &&
      (grantsByConnection.get(connection.connectionId)?.length ?? 0) > 0,
  );
  if (candidates.length !== 1) {
    throw new ScopeResolutionError(
      candidates.length === 0
        ? "no connection satisfies the authoritative case scope"
        : "connection selection is ambiguous inside the authoritative case scope",
    );
  }
  const selected = candidates[0]!;

  if (
    input.requestedConnectionId !== undefined &&
    input.requestedConnectionId !== selected.connectionId
  ) {
    throw new ScopeResolutionError("requested connection is outside authoritative case scope");
  }

  // Case-authorised scopes are already the live intersection of the case grants
  // and the connection's currently-configured scopes (stale grants were dropped
  // above), so this is guaranteed non-empty for the selected connection.
  const authorizedScopes: ConnectionScopeEntry[] =
    grantsByConnection.get(selected.connectionId) ?? [];

  let selectedTarget: ConnectionScopeEntry | null = null;
  if (input.requestedTarget !== undefined) {
    const target = input.requestedTarget;
    const authorized = authorizedScopes.find(
      (scope) => scope.kind === target.kind && scope.value === target.value,
    );
    if (authorized === undefined) {
      throw new ScopeResolutionError(
        "requested provider resource is not allowlisted for this case",
      );
    }
    selectedTarget = { kind: target.kind, value: target.value };
  }

  // Return ONLY the case-filtered scopes, never the connection's broader list.
  return { ...selected, scopes: authorizedScopes, caseId: input.caseScope.caseId, selectedTarget };
}

function scopeKey(kind: ConnectionScopeKind, value: string): string {
  return `${kind}\u0000${value}`;
}
