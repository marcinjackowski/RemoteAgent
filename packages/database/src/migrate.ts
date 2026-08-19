/**
 * Lightweight, native-SQL migration runner (RA-003, ADR-0002).
 *
 * Migrations are hand-authored `NNN_name.up.sql` / `NNN_name.down.sql` pairs in
 * `packages/database/migrations/`. Each migration runs in its own transaction so
 * an interrupted migration leaves no partial state. Applied migrations are
 * recorded in `schema_migrations` with a checksum so a silently edited,
 * already-applied migration fails closed. A `pg_advisory_lock` serializes
 * concurrent runners.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Database, Queryable } from "./client.js";
import { MigrationError } from "./errors.js";

/** Advisory-lock key derived from a fixed string, unique to this migrator. */
const MIGRATION_ADVISORY_LOCK_KEY = 0x52_41_30_30_33n; // "RA003" bytes.

const MIGRATIONS_DIRNAME = "migrations";

export interface Migration {
  version: number;
  name: string;
  upSql: string;
  downSql: string;
  checksum: string;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function migrationsDir(): string {
  // dist/migrate.js and src/migrate.ts both resolve relative to the package
  // root's `migrations/` directory.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", MIGRATIONS_DIRNAME);
}

const FILE_PATTERN = /^(\d{3})_([a-z0-9_-]+)\.(up|down)\.sql$/;

/** Load and validate the on-disk migration set. */
export async function loadMigrations(dir: string = migrationsDir()): Promise<Migration[]> {
  const entries = await readdir(dir);
  const ups = new Map<number, { name: string; sql: string }>();
  const downs = new Map<number, { name: string; sql: string }>();

  for (const entry of entries) {
    const match = FILE_PATTERN.exec(entry);
    if (match === null) {
      if (entry.endsWith(".sql")) {
        throw new MigrationError(`Migration file does not match NNN_name.(up|down).sql: ${entry}`);
      }
      continue;
    }
    const version = Number.parseInt(match[1]!, 10);
    const name = match[2]!;
    const direction = match[3]!;
    const sql = await readFile(join(dir, entry), "utf8");
    const target = direction === "up" ? ups : downs;
    if (target.has(version)) {
      throw new MigrationError(`Duplicate ${direction} migration for version ${version}`);
    }
    target.set(version, { name, sql });
  }

  const migrations: Migration[] = [];
  for (const [version, up] of [...ups.entries()].sort((a, b) => a[0] - b[0])) {
    const down = downs.get(version);
    if (down === undefined) {
      throw new MigrationError(`Missing down migration for version ${version} (${up.name})`);
    }
    if (down.name !== up.name) {
      throw new MigrationError(
        `Up/down name mismatch for version ${version}: "${up.name}" vs "${down.name}"`,
      );
    }
    migrations.push({
      version,
      name: up.name,
      upSql: up.sql,
      downSql: down.sql,
      checksum: createHash("sha256").update(up.sql, "utf8").digest("hex"),
    });
  }

  // Any down without a matching up is an error.
  for (const version of downs.keys()) {
    if (!ups.has(version)) {
      throw new MigrationError(`Down migration for version ${version} has no matching up`);
    }
  }

  // Versions must form a contiguous 1..N sequence.
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `Non-contiguous migration versions: expected ${expected}, found ${migration.version}`,
      );
    }
  });

  return migrations;
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     integer     PRIMARY KEY,
    name        text        NOT NULL,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

async function ensureMigrationsTable(q: Queryable): Promise<void> {
  await q.query(CREATE_MIGRATIONS_TABLE);
}

async function readApplied(q: Queryable): Promise<AppliedRow[]> {
  const result = await q.query<AppliedRow>(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
  );
  return result.rows;
}

/**
 * Verify that every already-applied migration still matches its file checksum.
 * A mismatch means an accepted migration was edited in place — rejected
 * fail-closed (ADR-0002 checksum guard).
 */
function assertNoChecksumDrift(applied: readonly AppliedRow[], migrations: readonly Migration[]) {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (migration === undefined) {
      throw new MigrationError(
        `Applied migration ${row.version} (${row.name}) has no file on disk; ` +
          "evolve via a new migration instead of deleting an applied one",
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum drift for applied migration ${row.version} (${row.name}); ` +
          "an already-applied migration must not be edited in place",
      );
    }
  }
}

export interface MigrateResult {
  applied: number[];
  reverted: number[];
}

/** Apply all pending migrations. Returns the versions applied in this run. */
export async function migrateUp(db: Database, dir?: string): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  return db.withAdvisoryLock(MIGRATION_ADVISORY_LOCK_KEY, async () => {
    await ensureMigrationsTable(db);
    const applied = await readApplied(db);
    assertNoChecksumDrift(applied, migrations);
    const appliedVersions = new Set(applied.map((row) => row.version));

    const appliedNow: number[] = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      await db.withTransaction(async (tx) => {
        await tx.query(migration.upSql);
        await tx.query(
          "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
      });
      appliedNow.push(migration.version);
    }
    return { applied: appliedNow, reverted: [] };
  });
}

/**
 * Revert migrations down to (but not including) `targetVersion`. With no target,
 * reverts exactly the most recently applied migration. `targetVersion === 0`
 * reverts everything.
 */
export async function migrateDown(
  db: Database,
  options: { to?: number } = {},
  dir?: string,
): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  return db.withAdvisoryLock(MIGRATION_ADVISORY_LOCK_KEY, async () => {
    await ensureMigrationsTable(db);
    const applied = await readApplied(db);
    assertNoChecksumDrift(applied, migrations);

    const descending = [...applied].sort((a, b) => b.version - a.version);
    const target = options.to ?? (descending.length > 0 ? descending[0]!.version - 1 : 0);

    const reverted: number[] = [];
    for (const row of descending) {
      if (row.version <= target) {
        break;
      }
      const migration = byVersion.get(row.version);
      if (migration === undefined) {
        throw new MigrationError(
          `Cannot revert applied migration ${row.version}: file missing on disk`,
        );
      }
      await db.withTransaction(async (tx) => {
        await tx.query(migration.downSql);
        await tx.query("DELETE FROM schema_migrations WHERE version = $1", [migration.version]);
      });
      reverted.push(migration.version);
    }
    return { applied: [], reverted };
  });
}

export interface MigrationStatus {
  version: number;
  name: string;
  applied: boolean;
}

/** Report which migrations are applied vs pending. */
export async function migrationStatus(db: Database, dir?: string): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);
  await ensureMigrationsTable(db);
  const applied = await readApplied(db);
  const appliedVersions = new Set(applied.map((row) => row.version));
  return migrations.map((migration) => ({
    version: migration.version,
    name: migration.name,
    applied: appliedVersions.has(migration.version),
  }));
}
