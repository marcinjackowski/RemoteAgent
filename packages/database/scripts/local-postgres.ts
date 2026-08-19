/**
 * Convenience wrapper to manage the local PostgreSQL used for development and
 * integration tests (RA-003).
 *
 * It shells out to `docker compose` for the `postgres` service defined in the
 * repository-root `docker-compose.yml`. The published host port is 5433 (see
 * that file) and matches the package defaults in `config.ts`, so no `RA_PGPORT`
 * is needed for the default local flow.
 *
 *   pnpm --filter @remoteagent/database db:up      # start + wait for healthy
 *   pnpm --filter @remoteagent/database db:down     # stop and remove
 *   pnpm --filter @remoteagent/database db:smoke     # up -> health -> migrate up
 *
 * `db:up` blocks until the container reports healthy (via the Compose
 * healthcheck), so a subsequent `migrate` never races an unready server.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function compose(args: string[]): number {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

/** Poll `docker compose ps` until the postgres service is healthy or times out. */
function waitForHealthy(timeoutMs = 60_000, intervalMs = 1_000): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = spawnSync("docker", ["compose", "ps", "--format", "{{.Health}}", "postgres"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const health = (result.stdout ?? "").trim();
    if (health === "healthy") {
      return true;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `postgres did not become healthy within ${timeoutMs}ms (last: "${health}")\n`,
      );
      return false;
    }
    // Busy-wait with a short sleep via a blocking child; keeps the script sync.
    spawnSync(process.execPath, ["-e", `setTimeout(()=>{}, ${intervalMs})`]);
  }
}

/** Start the container and block until it is healthy. */
function up(): number {
  const started = compose(["up", "-d", "--wait", "postgres"]);
  if (started !== 0) {
    // `--wait` already blocks on health; fall back to an explicit poll for older
    // Compose versions that ignore it.
    if (!waitForHealthy()) {
      return 1;
    }
  }
  return 0;
}

const command = process.argv[2];
switch (command) {
  case "up":
    process.exit(up());
    break;
  case "down":
    process.exit(compose(["down"]));
    break;
  case "smoke": {
    if (up() !== 0) {
      process.exit(1);
    }
    // Run the migration CLI against the same (default 5433) server.
    const migrate = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "up"], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      stdio: "inherit",
    });
    process.exit(migrate.status ?? 1);
    break;
  }
  default:
    process.stderr.write("Usage: local-postgres <up|down|smoke>\n");
    process.exit(2);
}
