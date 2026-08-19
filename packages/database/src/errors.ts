/**
 * Domain-level errors for the persistence layer (RA-003).
 *
 * Repositories translate low-level PostgreSQL failures (unique violations,
 * foreign-key violations, trigger-raised exceptions) into these typed, stable
 * errors so callers never depend on driver-specific `code` strings. Every error
 * carries enough context to be actionable in logs and recovery without leaking
 * raw payloads or secrets.
 */

/** Base class for every persistence error raised by this package. */
export class PersistenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A unique constraint was violated. Used, for example, when an optimistic
 * checkpoint insert races another writer at the same revision.
 */
export class UniqueViolationError extends PersistenceError {
  public readonly constraint: string | undefined;

  public constructor(message: string, constraint?: string) {
    super(message);
    this.constraint = constraint;
  }
}

/**
 * A referential-integrity constraint (foreign key or the composite
 * owner/connection guard) was violated. This is how a write that tries to link
 * an entity/case to another owner's connection fails closed.
 */
export class IntegrityViolationError extends PersistenceError {
  public readonly constraint: string | undefined;

  public constructor(message: string, constraint?: string) {
    super(message);
    this.constraint = constraint;
  }
}

/**
 * An append-only table rejected an UPDATE or DELETE. Ledger and audit rows are
 * insert-only; any attempt to mutate them is a programming error surfaced here.
 */
export class AppendOnlyViolationError extends PersistenceError {
  public readonly table: string | undefined;

  public constructor(message: string, table?: string) {
    super(message);
    this.table = table;
  }
}

/**
 * A case's `integration_scope` referenced a connection that is unknown, belongs
 * to another owner, or whose provider is not part of the scope's providers[].
 * This is the JSONB-array counterpart to {@link IntegrityViolationError}: the
 * composite foreign keys guard scalar edges, while this guards the scope blob.
 * Raised by the `ra_validate_case_integration_scope` constraint trigger
 * (SQLSTATE `P0101`) so a plain write can never widen or cross owner scope.
 */
export class ScopeViolationError extends PersistenceError {}

/**
 * A write violated the runtime contract shape before it reached the database
 * (e.g. an `integration_scope` that fails the versioned Zod contract). Raised in
 * the repository write path so malformed UNTRUSTED_DATA is rejected
 * deterministically without relying on TypeScript types.
 */
export class ContractViolationError extends PersistenceError {}

/** A completion id/run was reused with different immutable semantics. */
export class RunCompletionConflictError extends PersistenceError {
  public readonly runId: string;
  public readonly completionId: string;

  public constructor(runId: string, completionId: string) {
    super(`run completion conflict for run ${runId} or completion ${completionId}`);
    this.runId = runId;
    this.completionId = completionId;
  }
}

/** A prepared completion cannot be applied to the current authoritative state. */
export class RunCompletionStateError extends PersistenceError {
  public constructor(message: string) {
    super(message);
  }
}

/** A decision already has an answer with different immutable semantics. */
export class DecisionAnswerConflictError extends PersistenceError {
  public readonly decisionId: string;

  public constructor(decisionId: string) {
    super(`decision answer conflict for ${decisionId}`);
    this.decisionId = decisionId;
  }
}

/** A concurrent credential refresh already advanced the expected revision. */
export class CredentialRefreshConflictError extends PersistenceError {
  public readonly connectionId: string;
  public readonly expectedRevision: bigint;

  public constructor(connectionId: string, expectedRevision: bigint) {
    super(
      `Credential refresh for connection ${connectionId} lost revision ${expectedRevision.toString()}`,
    );
    this.connectionId = connectionId;
    this.expectedRevision = expectedRevision;
  }
}

/**
 * A credential-refresh `operation_id` was reused for a DIFFERENT immutable
 * identity (connection, owner, provider or expected revision). The intent is
 * bound to its identity at creation, so a colliding or replayed idempotency key
 * is rejected fail-closed BEFORE any vault probe or metadata publish, preventing
 * a credential reference from being crossed between connections/owners/aliases
 * (RA-005, AUDIT-02 HIGH-04).
 */
export class CredentialRefreshIdentityError extends PersistenceError {
  public readonly operationId: string;
  public readonly field: string;

  public constructor(operationId: string, field: string) {
    super(`refresh operation ${operationId} is bound to a different ${field}`);
    this.operationId = operationId;
    this.field = field;
  }
}

/**
 * A protected, sync-maintained table (currently `case_connections`) rejected a
 * direct DML. That membership table is the authoritative per-case connection
 * allowlist and may only be mutated by the case integration_scope sync trigger;
 * a direct INSERT/UPDATE/DELETE is denied at the database level (SQLSTATE
 * `P0102`) so the allowlist cannot be desynchronized from the JSON scope.
 */
export class ProtectedTableError extends PersistenceError {}

/**
 * An optimistic-concurrency (compare-and-set) update lost the race: the current
 * revision no longer matched the expected one. The loser must reload and retry
 * from the new revision rather than overwrite the winner.
 */
export class CheckpointConflictError extends PersistenceError {
  public readonly caseId: string;
  public readonly expectedRevision: number;
  public readonly actualRevision: number | null;

  public constructor(caseId: string, expectedRevision: number, actualRevision: number | null) {
    super(
      `Checkpoint CAS for case ${caseId} expected revision ${expectedRevision} ` +
        `but the current revision is ${actualRevision === null ? "unknown" : actualRevision}`,
    );
    this.caseId = caseId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** A requested row did not exist. */
export class NotFoundError extends PersistenceError {
  public readonly entity: string;
  public readonly id: string;

  public constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.entity = entity;
    this.id = id;
  }
}

/** Raised when the migration runner detects an unsafe or inconsistent state. */
export class MigrationError extends PersistenceError {}
