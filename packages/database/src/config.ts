/**
 * Connection configuration for the persistence layer (RA-003).
 *
 * Configuration comes exclusively from the environment; nothing here is
 * committed. A single `RA_DATABASE_URL` connection string is preferred; discrete
 * `PG*`/`RA_PG*` variables are supported as a fallback for local development.
 * The credentials in `docker-compose.yml` are non-secret local defaults (see
 * ADR-0002); real environments inject credentials out of band.
 */
import type { PoolConfig } from "pg";

/**
 * Local-only, non-secret defaults matching `docker-compose.yml` from RA-001.
 *
 * The published host port is 5433 (Compose maps 5433→5432 to avoid colliding
 * with a locally-installed PostgreSQL on 5432). Keeping this default aligned with
 * Compose means `db:up` followed by `migrate` targets the same server with no
 * hidden `RA_PGPORT` step (AUDIT-01 MEDIUM-04).
 */
const LOCAL_DEFAULTS = {
  host: "127.0.0.1",
  port: 5433,
  user: "remoteagent",
  password: "remoteagent-local-dev",
  database: "remoteagent",
} as const;

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve a `pg` pool configuration from the environment.
 *
 * Precedence:
 *   1. `RA_DATABASE_URL` (or `DATABASE_URL`) connection string, if present;
 *   2. discrete `RA_PG*` variables, then `PG*` variables;
 *   3. local, non-secret defaults for developer convenience.
 *
 * `overrides` (e.g. a per-test database name) win over everything so integration
 * tests can point at an isolated database on the same server.
 */
export function resolvePoolConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  const url = readEnv("RA_DATABASE_URL") ?? readEnv("DATABASE_URL");
  if (url !== undefined) {
    return { connectionString: url, ...overrides };
  }

  const host = readEnv("RA_PGHOST") ?? readEnv("PGHOST") ?? LOCAL_DEFAULTS.host;
  const portRaw = readEnv("RA_PGPORT") ?? readEnv("PGPORT");
  const port = portRaw === undefined ? LOCAL_DEFAULTS.port : Number.parseInt(portRaw, 10);
  const user = readEnv("RA_PGUSER") ?? readEnv("PGUSER") ?? LOCAL_DEFAULTS.user;
  const password = readEnv("RA_PGPASSWORD") ?? readEnv("PGPASSWORD") ?? LOCAL_DEFAULTS.password;
  const database = readEnv("RA_PGDATABASE") ?? readEnv("PGDATABASE") ?? LOCAL_DEFAULTS.database;

  return {
    host,
    port: Number.isNaN(port) ? LOCAL_DEFAULTS.port : port,
    user,
    password,
    database,
    ...overrides,
  };
}
