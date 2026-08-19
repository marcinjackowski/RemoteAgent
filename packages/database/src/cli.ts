/**
 * Migration CLI (RA-003).
 *
 * Usage:
 *   pnpm --filter @remoteagent/database migrate up
 *   pnpm --filter @remoteagent/database migrate down [--to <version>]
 *   pnpm --filter @remoteagent/database migrate status
 *
 * Connection configuration comes from the environment (see `config.ts`).
 */
import { Database } from "./client.js";
import { migrateDown, migrateUp, migrationStatus } from "./migrate.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const db = Database.fromEnv();
  try {
    switch (command) {
      case "up": {
        const result = await migrateUp(db);
        if (result.applied.length === 0) {
          process.stdout.write("migrate up: nothing to apply (already current)\n");
        } else {
          process.stdout.write(`migrate up: applied ${result.applied.join(", ")}\n`);
        }
        break;
      }
      case "down": {
        const toIndex = rest.indexOf("--to");
        const to = toIndex >= 0 ? Number.parseInt(rest[toIndex + 1] ?? "", 10) : undefined;
        const result = await migrateDown(db, to === undefined ? {} : { to });
        if (result.reverted.length === 0) {
          process.stdout.write("migrate down: nothing to revert\n");
        } else {
          process.stdout.write(`migrate down: reverted ${result.reverted.join(", ")}\n`);
        }
        break;
      }
      case "status": {
        const status = await migrationStatus(db);
        for (const item of status) {
          const mark = item.applied ? "[x]" : "[ ]";
          process.stdout.write(`${mark} ${String(item.version).padStart(3, "0")} ${item.name}\n`);
        }
        break;
      }
      default:
        process.stderr.write(
          `Unknown command: ${command ?? "(none)"}\nUsage: migrate <up|down|status> [--to <version>]\n`,
        );
        process.exitCode = 2;
        break;
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
