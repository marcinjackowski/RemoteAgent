/**
 * Vitest setup for the database package integration tests (RA-003).
 *
 * Defaults the local PostgreSQL port to the docker-compose published port
 * (5433) unless the environment already selects a target. Never overrides an
 * explicit RA_DATABASE_URL / RA_PGPORT / PGPORT.
 */
if (
  process.env.RA_DATABASE_URL === undefined &&
  process.env.DATABASE_URL === undefined &&
  process.env.RA_PGPORT === undefined &&
  process.env.PGPORT === undefined
) {
  process.env.RA_PGPORT = "5433";
}
