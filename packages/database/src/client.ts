/**
 * Thin native PostgreSQL access (RA-003).
 *
 * This module exposes a small surface over `pg` that preserves native access
 * (raw parameterized SQL, transactions, `RETURNING`, `ON CONFLICT`, advisory
 * locks) without any ORM or query-builder layer (ADR-0002). Repositories run
 * inside a {@link Queryable} — either the pool directly (auto-commit) or a
 * transaction client — so the same repository code composes into larger
 * transactions.
 */
import pg from "pg";
import type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from "pg";

import { resolvePoolConfig } from "./config.js";
import {
  AppendOnlyViolationError,
  CheckpointConflictError,
  ImmutableGrantError,
  IntegrityViolationError,
  PersistenceError,
  ProtectedTableError,
  ScopeViolationError,
  UniqueViolationError,
} from "./errors.js";

/**
 * The minimal query surface repositories depend on. Both {@link Database} (a
 * pool) and a transaction handle satisfy it, so a repository method is agnostic
 * to whether it runs standalone or inside a transaction.
 */
export interface Queryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

/** Unique brand symbol; only this module can attach it to a handle. */
declare const transactionBrand: unique symbol;

/**
 * A {@link Queryable} that is *guaranteed* to be inside an open transaction.
 *
 * The brand is nominal and unforgeable outside this module, so an API that
 * requires atomicity can demand a {@link Transaction} in its signature. A plain
 * {@link Database} (the auto-commit pool) does NOT satisfy this type, which makes
 * "pass the pool as if it were a transaction" a compile-time error rather than a
 * silent partial-write hazard (AUDIT-01 HIGH-02). The only way to obtain one is
 * {@link Database.withTransaction}, which opens/commits/rolls back the boundary.
 */
export interface Transaction extends Queryable {
  readonly [transactionBrand]: true;
}

/** PostgreSQL error `code`s we translate into domain errors. */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";
const PG_NOT_NULL_VIOLATION = "23502";
/** Custom SQLSTATE raised by append-only guard triggers. */
const PG_APPEND_ONLY = "P0100";
/** Custom SQLSTATE raised by the integration-scope validation trigger. */
const PG_SCOPE_VIOLATION = "P0101";
/** Custom SQLSTATE raised by the case_connections tamper guard. */
const PG_PROTECTED_TABLE = "P0102";
/**
 * Custom SQLSTATE raised by the `approvals` immutability guards (migration 030):
 * the authorizing terms of a granted approval cannot change, a consumed grant
 * cannot be un-consumed, and an approval cannot be deleted.
 */
const PG_IMMUTABLE_GRANT = "P0103";

interface PgError {
  code?: string;
  constraint?: string;
  table?: string;
  message?: string;
}

function asPgError(error: unknown): PgError | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return error as PgError;
  }
  return undefined;
}

/**
 * Translate a raw driver error into a typed {@link PersistenceError}. Unknown
 * errors are rethrown unchanged so genuine bugs are never masked as domain
 * errors. Repositories call this in their catch blocks.
 */
export function translatePgError(error: unknown): PersistenceError | undefined {
  const pgError = asPgError(error);
  if (pgError?.code === undefined) {
    return undefined;
  }
  const message = pgError.message ?? "database error";
  switch (pgError.code) {
    case PG_UNIQUE_VIOLATION:
      return new UniqueViolationError(message, pgError.constraint);
    case PG_FOREIGN_KEY_VIOLATION:
    case PG_CHECK_VIOLATION:
    case PG_NOT_NULL_VIOLATION:
      return new IntegrityViolationError(message, pgError.constraint);
    case PG_APPEND_ONLY:
      return new AppendOnlyViolationError(message, pgError.table);
    case PG_SCOPE_VIOLATION:
      return new ScopeViolationError(message);
    case PG_PROTECTED_TABLE:
      return new ProtectedTableError(message);
    case PG_IMMUTABLE_GRANT:
      return new ImmutableGrantError(message);
    default:
      return undefined;
  }
}

/** Re-export so repositories can reference these without importing pg directly. */
export type { Pool, PoolClient, QueryResult, QueryResultRow };
export { CheckpointConflictError };

/**
 * Owns a `pg` connection pool and provides transaction orchestration. A single
 * {@link Database} instance is shared across repositories.
 */
export class Database implements Queryable {
  private readonly pool: Pool;
  /** Errors observed on IDLE pooled clients, newest last. Bounded. */
  private readonly idleErrors: Error[] = [];

  public constructor(config?: PoolConfig) {
    this.pool = new pg.Pool(config ?? resolvePoolConfig());
    // A `pg` Pool emits `error` for a failure on an IDLE client — a server
    // restart, an admin `pg_terminate_backend`, a dropped network path. With no
    // listener, Node treats that as an UNCAUGHT exception and takes the process
    // down, even though no query was in flight and the pool will simply open a
    // fresh connection on the next checkout.
    //
    // This surfaced as `CTF-007`: one uncaught `57P01` per full-repo run,
    // alongside every test passing. The test-harness fix addresses the specific
    // teardown race, but the missing listener is the general defect — in
    // production a routine database restart would kill a worker mid-shift.
    //
    // Errors are recorded rather than swallowed, so an operator can see that
    // connections were dropped instead of it becoming invisible.
    this.pool.on("error", (error: Error) => {
      if (this.idleErrors.length >= 32) this.idleErrors.shift();
      this.idleErrors.push(error);
    });
  }

  /**
   * Errors seen on idle pooled connections since construction.
   *
   * Exposed so a caller can assert on them (and so the handler above cannot be
   * mistaken for silently discarding failures). An in-flight query still rejects
   * normally; these are only the errors that arrive with nothing awaiting them.
   */
  public get observedIdleErrors(): readonly Error[] {
    return Object.freeze([...this.idleErrors]);
  }

  /** Build a {@link Database} from environment configuration plus overrides. */
  public static fromEnv(overrides: Partial<PoolConfig> = {}): Database {
    return new Database(resolvePoolConfig(overrides));
  }

  public async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values as unknown[] | undefined);
  }

  /**
   * Run `fn` inside a single transaction. The transaction commits when `fn`
   * resolves and rolls back if it throws, guaranteeing no partial state is left
   * behind (RA-003 required verification: transaction interruption leaves no
   * partial state). The provided {@link Transaction} MUST be used for all writes
   * inside the callback; its brand is what lets atomic-by-definition APIs (e.g.
   * {@link CheckpointRepository.append}) require a real transaction boundary.
   */
  public async withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    // The branded handle is the pooled client itself; the brand is a purely
    // compile-time marker (no runtime field is added).
    const tx = client as unknown as Transaction;
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors; surface the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Acquire a session-level advisory lock for the duration of `fn`. */
  public async withAdvisoryLock<T>(key: bigint, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [key.toString()]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [key.toString()]);
      }
    } finally {
      client.release();
    }
  }

  /** Close the pool. Call once at process shutdown / end of a test suite. */
  public async close(): Promise<void> {
    await this.pool.end();
  }
}
