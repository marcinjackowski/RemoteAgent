/**
 * `@remoteagent/database` — transactional PostgreSQL persistence (RA-003).
 *
 * PostgreSQL is the authoritative source of business state (Master Plan §3.2).
 * This package provides native SQL access via `pg` (no ORM; see ADR-0002), a
 * lightweight migration runner, and thin transactional repositories that map
 * low-level driver failures into typed domain errors.
 */
export const packageName = "database" as const;

export { Database } from "./client.js";
export type {
  Queryable,
  Transaction,
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "./client.js";
export { translatePgError } from "./client.js";
export { resolvePoolConfig } from "./config.js";

export {
  PersistenceError,
  UniqueViolationError,
  IntegrityViolationError,
  AppendOnlyViolationError,
  ScopeViolationError,
  ContractViolationError,
  CredentialRefreshConflictError,
  CredentialRefreshIdentityError,
  ProtectedTableError,
  CheckpointConflictError,
  NotFoundError,
  MigrationError,
} from "./errors.js";

export { loadMigrations, migrateUp, migrateDown, migrationStatus } from "./migrate.js";
export type { Migration, MigrateResult, MigrationStatus } from "./migrate.js";

export * from "./repositories/index.js";
export * from "./queue/index.js";
