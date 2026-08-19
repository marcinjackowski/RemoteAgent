/**
 * Integration-test harness backed by a REAL PostgreSQL server (RA-003).
 *
 * RA-003 acceptance criterion 6 forbids a SQL mock: integration tests run
 * against real PostgreSQL. This harness connects to a running server (from the
 * environment, or the local docker-compose defaults), creates a throwaway,
 * uniquely-named database, applies all migrations, and drops it on teardown so
 * suites are isolated and repeatable.
 *
 * If no server is reachable the harness throws a clear error; tests using it are
 * skipped by the caller (see `describeIntegration`).
 */
import { randomUUID } from "node:crypto";

import type { PoolConfig } from "pg";

import { Database } from "../src/client.js";
import { resolvePoolConfig } from "../src/config.js";
import { migrateUp } from "../src/migrate.js";

/** Probe whether a PostgreSQL server is reachable with the resolved config. */
export async function postgresAvailable(): Promise<boolean> {
  const admin = new Database(adminConfig());
  try {
    await admin.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await admin.close();
  }
}

/** Config for the maintenance/admin connection (CREATE/DROP DATABASE). */
function adminConfig(): PoolConfig {
  // Connect to a stable maintenance database ("postgres") so we can create and
  // drop per-test databases. When a connection string is provided we reuse it
  // as-is (the caller controls the target database).
  const base = resolvePoolConfig();
  if ("connectionString" in base && base.connectionString !== undefined) {
    return base;
  }
  return { ...base, database: "postgres" };
}

export interface TestDatabase {
  db: Database;
  name: string;
  drop: () => Promise<void>;
}

/**
 * Create an isolated, migrated test database and return a connected
 * {@link Database}. Call `drop()` (or use {@link withTestDatabase}) to tear it
 * down.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const created = await createEmptyDatabase();
  await migrateUp(created.db);
  return created;
}

/**
 * Create an isolated, EMPTY (unmigrated) test database. Used by the migration
 * lifecycle suite which drives up/down itself.
 */
export async function createEmptyDatabase(): Promise<TestDatabase> {
  const name = `ra_test_${randomUUID().replace(/-/g, "")}`;

  const admin = new Database(adminConfig());
  try {
    // Identifier is generated from a UUID, no user input; still, only [a-z0-9_].
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }

  const base = resolvePoolConfig();
  const db =
    "connectionString" in base && base.connectionString !== undefined
      ? new Database(withDatabaseInUrl(base.connectionString, name))
      : new Database({ ...base, database: name });

  const drop = async (): Promise<void> => {
    await db.close();
    const cleanup = new Database(adminConfig());
    try {
      // Terminate lingering connections, then drop.
      await cleanup.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
      await cleanup.query(`DROP DATABASE IF EXISTS ${name}`);
    } finally {
      await cleanup.close();
    }
  };

  return { db, name, drop };
}

/** Rewrite the database segment of a connection string. */
function withDatabaseInUrl(url: string, database: string): PoolConfig {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return { connectionString: parsed.toString() };
}

/** Run `fn` with a fresh migrated database, guaranteeing teardown. */
export async function withTestDatabase<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  const test = await createTestDatabase();
  try {
    return await fn(test.db);
  } finally {
    await test.drop();
  }
}
