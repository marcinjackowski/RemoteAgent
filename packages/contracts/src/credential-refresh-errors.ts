/**
 * Credential-refresh failure classes, defined ONCE (RA-023-WU-00, `CTF-001`).
 *
 * WHY THESE LIVE IN `contracts`. `packages/database` and `packages/policy` each
 * declared their own `CredentialRefreshConflictError` and
 * `CredentialRefreshIdentityError` with the same names and the same meaning but
 * different base classes, so `instanceof` between them returned `false`. Code
 * catching the error imported from one package would silently NOT catch the one
 * thrown by the other: the `catch` block simply does not run and the error escapes as
 * unhandled. That is `CTF-001`, open since `2026-08-20`.
 *
 * WHY NOT THE REGISTRY'S FIRST OPTION. `CTF-001` recommends "`packages/policy` stops
 * defining its own classes and imports them from `@remoteagent/database`". That is not
 * possible and the reason is measured, not assumed: `packages/database` devDepends on
 * `@remoteagent/policy` for its own tests, so a manifest edge policy -> database makes
 * turbo's build graph cyclic and `build` refuses to run. RA-022-WU-01 tried both
 * directions and recorded the failure.
 *
 * WHY NOT THE SECOND OPTION EITHER. The registry's fallback is "distinct, unambiguous
 * names (`CredentialPublishConflictError`) IF the semantics are actually different".
 * They are not. Both conflict errors mean "an optimistic-concurrency race for this
 * credential was lost"; both identity errors mean "this refresh operation id is bound
 * to a different immutable identity". Giving one meaning two names would make the
 * duplication permanent and harder to see.
 *
 * SO: one definition, in the package both already depend on. `contracts` is the right
 * host rather than a new package — it already carries six cross-cutting error classes
 * (`CanonicalJsonError`, `PolicyTransitionError`, `InvalidTransitionError`,
 * `StaleDecisionAnswerError`, `DecisionMismatchError`, `UnknownDecisionOptionError`)
 * for exactly this reason, and both `database` and `policy` depend on it already, so
 * no new graph edge is introduced at all.
 *
 * A NOTE ON THE BASE CLASS. `database`'s versions extended `PersistenceError`. That is
 * deliberately NOT reproduced here: a refresh conflict is a domain outcome of a
 * concurrent refresh, not a persistence fault, and nothing in the repository catches
 * these two through `PersistenceError` (checked, not assumed — there is no
 * `instanceof PersistenceError` anywhere). Keeping the persistence hierarchy out of
 * `contracts` also avoids `contracts` growing a dependency-shaped concept it has no
 * business knowing about.
 */

/**
 * A concurrent credential refresh already advanced the expected revision, so this
 * refresh lost the optimistic-concurrency race.
 *
 * The loser must NOT retry blindly: the winner's credential is the live one, and the
 * loser's vault object is uniquely keyed and unpublished, so it is safe to revoke but
 * never safe to publish over the winner (RA-005 AUDIT-02).
 *
 * `connectionId` and `expectedRevision` are optional because the two throw sites know
 * different amounts: the persistence layer has both, while the refresh coordinator
 * raises it from a terminal `ABORTED` intent where the revision is no longer the
 * meaningful fact. Making them required would have forced one site to invent values —
 * which is how a diagnostic field becomes a lie.
 */
export class CredentialRefreshConflictError extends Error {
  public readonly connectionId: string | undefined;
  public readonly expectedRevision: bigint | undefined;

  public constructor(details?: { connectionId?: string; expectedRevision?: bigint }) {
    super(
      details?.connectionId !== undefined && details.expectedRevision !== undefined
        ? `Credential refresh for connection ${details.connectionId} lost revision ${details.expectedRevision.toString()}`
        : "credential refresh lost an optimistic-concurrency race",
    );
    // `new.target.name`, not a literal. The literal was the first version and the WU-00
    // probe caught what it costs: a subclass reported the PARENT's name, so a future
    // narrower error would be indistinguishable from its base in every log line and
    // every `name`-based branch. `new.target` names the class actually constructed.
    //
    // The old `packages/policy` classes used `new.target.name` and the old
    // `packages/database` ones inherited it from `PersistenceError`, so preserving it
    // also keeps both prior behaviours rather than silently choosing one.
    this.name = new.target.name;
    this.connectionId = details?.connectionId;
    this.expectedRevision = details?.expectedRevision;
  }
}

/**
 * A refresh request reused an `operationId` that already belongs to a DIFFERENT
 * immutable identity (connection, owner, provider or expected revision).
 *
 * The intent's identity is fixed at creation, so a colliding or replayed idempotency
 * key must fail closed BEFORE any vault probe or metadata publish — otherwise a
 * credential reference can be crossed between connections, owners or aliases
 * (RA-005 AUDIT-02 HIGH-04).
 *
 * `operationId` is optional for the same reason as above: the persistence layer knows
 * it, the coordinator's `assertSameIntentIdentity` is called with the identity fields
 * rather than the id.
 */
export class CredentialRefreshIdentityError extends Error {
  public readonly field: string;
  public readonly operationId: string | undefined;

  public constructor(field: string, operationId?: string) {
    super(
      operationId === undefined
        ? `refresh operation id is bound to a different ${field}`
        : `refresh operation ${operationId} is bound to a different ${field}`,
    );
    // See the note on the conflict error above: `new.target.name` so a subclass reports
    // its own name rather than this one.
    this.name = new.target.name;
    this.field = field;
    this.operationId = operationId;
  }
}

/**
 * Durable status of one credential-refresh intent.
 *
 * Also duplicated across `database` and `policy` (surfaced by the RA-022 type-level
 * export probe, which is the only mechanism that sees a type-only collision — a type
 * has no runtime value, so `Object.keys` cannot find it and ESM drops the ambiguous
 * name from a combined barrel without a compile error).
 *
 * The two copies were identical, so this is the single source. `AMBIGUOUS` is here for
 * the reason it is everywhere in this repository: a side effect without a confirmed
 * receipt is never reported as success.
 */
export type RefreshIntentStatus =
  "PENDING" | "ACQUIRING" | "VAULT_WRITTEN" | "PUBLISHED" | "ABORTED" | "AMBIGUOUS";
