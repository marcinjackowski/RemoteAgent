/**
 * Real-PostgreSQL harness for RA-006 dispatcher integration tests.
 *
 * Mirrors the database package harness: creates a throwaway, migrated database
 * per suite so tests are isolated and repeatable, and fails closed (not a green
 * skip) when `RA_REQUIRE_POSTGRES` is set but no server is reachable. Uses only
 * the public `@remoteagent/database` API (Database + migrateUp), so the Discord
 * package never reaches into the database package's private test helpers.
 */
import { randomUUID } from "node:crypto";

import { Database, migrateUp, resolvePoolConfig } from "@remoteagent/database";
import { describe, it } from "vitest";

if (
  process.env.RA_DATABASE_URL === undefined &&
  process.env.DATABASE_URL === undefined &&
  process.env.RA_PGPORT === undefined &&
  process.env.PGPORT === undefined
) {
  process.env.RA_PGPORT = "5433";
}

function adminConfig(): ReturnType<typeof resolvePoolConfig> {
  const base = resolvePoolConfig();
  if ("connectionString" in base && base.connectionString !== undefined) {
    return base;
  }
  return { ...base, database: "postgres" };
}

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

export function postgresRequired(): boolean {
  const flag = process.env.RA_REQUIRE_POSTGRES;
  return flag !== undefined && flag !== "0" && flag.trim() !== "";
}

export interface TestDatabase {
  db: Database;
  drop: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ra_discord_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new Database(adminConfig());
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.close();
  }

  const base = resolvePoolConfig();
  const db =
    "connectionString" in base && base.connectionString !== undefined
      ? new Database(withDatabaseInUrl(base.connectionString, name))
      : new Database({ ...base, database: name });
  await migrateUp(db);

  const drop = async (): Promise<void> => {
    await db.close();
    const cleanup = new Database(adminConfig());
    try {
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
  return { db, drop };
}

function withDatabaseInUrl(url: string, database: string): { connectionString: string } {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return { connectionString: parsed.toString() };
}

export function describeIntegration(name: string, fn: () => void, isAvailable: boolean): void {
  if (isAvailable) {
    describe(name, fn);
    return;
  }
  if (postgresRequired()) {
    describe(name, () => {
      it("requires a reachable PostgreSQL (RA_REQUIRE_POSTGRES set)", () => {
        throw new Error(
          "RA-006 integration gate: PostgreSQL is not reachable but RA_REQUIRE_POSTGRES is set.",
        );
      });
    });
    return;
  }
  describe.skip(`${name} (skipped: no PostgreSQL reachable)`, fn);
}
