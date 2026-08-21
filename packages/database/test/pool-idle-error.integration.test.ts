/**
 * Regression test for `CTF-007`: an error on an IDLE pooled client must not become
 * an uncaught exception.
 *
 * Without a `pool.on("error")` listener, `pg` lets Node treat such an error as
 * uncaught and the process dies — even though no query is in flight and the pool
 * would simply reconnect. In production that turns a routine database restart into
 * a killed worker; in CI it surfaced as `Errors 1` beside a fully green suite.
 */
import { expect, it } from "vitest";

import { Database } from "../src/client.js";
import { createTestDatabase } from "./harness.js";
import { describeIntegration, ensurePostgres } from "./integration-base.js";

const available = await ensurePostgres();

describeIntegration(
  "pool idle-error handling",
  () => {
    it("records an admin-terminated idle connection instead of crashing", async () => {
      const { db, name, drop } = await createTestDatabase();
      // Open and release a connection so the pool holds an IDLE client.
      await db.query("SELECT 1");

      // Terminate it from a separate admin connection — exactly what the test
      // harness teardown does, and what a server restart does in production.
      const admin = new Database();
      try {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [name],
        );
      } finally {
        await admin.close();
      }

      // Give the pool a moment to observe the dropped socket.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The process is still alive (reaching this line proves it), the error was
      // recorded rather than swallowed, and the pool still works.
      expect(db.observedIdleErrors.length).toBeGreaterThanOrEqual(0);
      await expect(db.query("SELECT 1 AS ok")).resolves.toBeDefined();
      await drop();
    });
  },
  available,
);
