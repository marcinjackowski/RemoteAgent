/**
 * Sealed credential-use, and the narrow fallback adapter.
 *
 * **The credential has no resting place.** {@link SealedCredentialBroker.use} hands
 * the value to a callback and returns the callback's result; there is no getter, no
 * property and no field on any object this module exposes. The reason is specific
 * rather than stylistic: a token stored as a property is reachable by
 * `JSON.stringify`, by a structured logger walking an object, by an error
 * serializer, and by anything that spreads the object into a log record. RA-017
 * used this shape for GitLab (`CredentialBroker` in
 * `packages/connector-gitlab/src/merge-request.ts`) and RA-021 follows it, so the
 * two boundaries do not disagree about what "sealed" means.
 *
 * **The model never participates.** A credential arrives at the transport from the
 * vault, keyed by a connection the *broker* resolved. No tool argument names it, no
 * tool result carries it, and the forbidden-argument gate rejects `token`,
 * `authorization` and friends in both spellings — so there is no channel by which a
 * model could supply, request or observe one.
 *
 * **A fallback adapter is explicit, never implicit.** Master Plan §9 requires that a
 * Preview/Beta remote MCP always have a narrow first-party adapter behind it. The
 * temptation is to fail over automatically when the remote misbehaves; that is
 * wrong here, because the failure modes this task is about — schema drift, prompt
 * injection, an ambiguous timeout — are exactly the ones where silently switching
 * implementations hides the signal. {@link resolveToolTransport} therefore selects
 * by explicit server-owned configuration and reports which one it chose, so an
 * operator reading the ledger can tell a remote-MCP read from a first-party read.
 */
import type { ToolTransport } from "./transport.js";

/**
 * Supplies a credential for exactly one operation.
 *
 * `use` hands the value to a callback rather than returning it. `redactionLiterals`
 * exists so callers can scrub output without ever holding the secret themselves;
 * an implementation may legitimately return `[]` when it cannot enumerate them.
 */
export interface SealedCredentialBroker {
  use<T>(scope: { connectionId: string }, fn: (secret: string) => Promise<T>): Promise<T>;
  /** Literals for redaction only. May be empty. */
  redactionLiterals(): readonly string[];
}

/**
 * An in-memory broker over credentials the server already resolved.
 *
 * The map is a `#private` field and there is no accessor: the only way to reach a
 * value is `use`, inside a callback, for a connection the caller can already name. A
 * missing connection throws rather than yielding an empty string — a blank
 * credential would produce a puzzling provider 401 instead of a clear local failure.
 *
 * `#private` is doing real work here, and it is the whole mechanism. A probe on this
 * Node version confirms that a `#private` field is omitted by `JSON.stringify`,
 * by string coercion AND by `util.inspect` even with `showHidden: true` — so
 * defensive `toJSON`/`toString` overrides were removed after a mutation probe showed
 * that deleting them broke no test. They were untestable code justifying itself with
 * a claim about `inspect` that the probe disproved (`CTF-010`: a comment is not
 * evidence). The serialization tests remain, since they pin the property that
 * actually holds; a future refactor to a normal field would fail them.
 */
export class InMemorySealedCredentialBroker implements SealedCredentialBroker {
  readonly #secrets: Map<string, string>;

  public constructor(secrets: Readonly<Record<string, string>>) {
    this.#secrets = new Map(Object.entries(secrets));
  }

  public async use<T>(
    scope: { connectionId: string },
    fn: (secret: string) => Promise<T>,
  ): Promise<T> {
    const secret = this.#secrets.get(scope.connectionId);
    if (secret === undefined) {
      throw new Error(`no credential is available for connection ${scope.connectionId}`);
    }
    return fn(secret);
  }

  public redactionLiterals(): readonly string[] {
    return [...this.#secrets.values()];
  }
}

/** Which implementation served a call. Recorded so provenance is legible. */
export const TransportKind = {
  /** A remote MCP server (official Jira/Google/GitLab MCP, AgentCore target). */
  REMOTE_MCP: "REMOTE_MCP",
  /** A narrow first-party adapter over the provider's own REST API. */
  FALLBACK_ADAPTER: "FALLBACK_ADAPTER",
} as const;

export type TransportKind = (typeof TransportKind)[keyof typeof TransportKind];

export type TransportSelection = Readonly<{
  kind: TransportKind;
  transport: ToolTransport;
}>;

/**
 * Server-owned choice between a remote MCP target and the first-party fallback.
 *
 * Explicit, per provider, and NOT automatic. An automatic failover would mask
 * precisely the conditions this task exists to detect: a server that drifts from its
 * advertised schema, injects instructions into a description, or times out
 * ambiguously would silently be replaced by a working adapter, and the operator
 * would see healthy reads instead of a misbehaving provider.
 *
 * Both branches go through the SAME broker: the manifest, the scope injection, the
 * ledger and the output bounds do not vary by transport. That is what makes the two
 * equivalent from a policy standpoint, and it is why the fallback is a transport
 * rather than a separate code path around the gate.
 */
export function resolveToolTransport(input: {
  provider: string;
  /** Server config: providers whose remote MCP target is approved for use. */
  remoteApproved: readonly string[];
  remote: ToolTransport | null;
  fallback: ToolTransport;
}): TransportSelection {
  if (input.remoteApproved.includes(input.provider) && input.remote !== null) {
    return { kind: TransportKind.REMOTE_MCP, transport: input.remote };
  }
  // Fail-closed direction: an unapproved or absent remote yields the narrow
  // first-party adapter, never an unvetted remote server.
  return { kind: TransportKind.FALLBACK_ADAPTER, transport: input.fallback };
}
