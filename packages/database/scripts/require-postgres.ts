/**
 * CI/gate preflight: fail closed when PostgreSQL is unreachable (RA-003).
 *
 * AUDIT-01 MEDIUM-03: the integration suites previously skipped (exit 0) with no
 * database, so a mandatory check could report green while verifying nothing.
 * This preflight probes the resolved connection and exits non-zero if the server
 * is not reachable, so the mandatory integration gate genuinely requires a real
 * PostgreSQL. It also sets RA_REQUIRE_POSTGRES for downstream tooling awareness.
 */
import { Database } from "../src/client.js";

async function main(): Promise<void> {
  const db = Database.fromEnv();
  try {
    await db.query("SELECT 1");
    process.stdout.write("postgres: reachable\n");
  } catch (error) {
    process.stderr.write(
      "postgres: NOT reachable — the RA-003 integration gate requires a real " +
        "PostgreSQL (start it with `pnpm --filter @remoteagent/database db:up`).\n" +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
