/**
 * Shared test bootstrap: applies local port defaults and exposes a
 * describe-or-skip helper based on real PostgreSQL availability (RA-003).
 *
 * Integration tests MUST use a real PostgreSQL (acceptance criterion 6). By
 * default, when no server is reachable the suite is skipped with a clear message
 * for local convenience. In the mandatory gate/CI, `RA_REQUIRE_POSTGRES=1` turns
 * a missing database into a HARD FAILURE instead of a silent skip
 * (AUDIT-01 MEDIUM-03), so a green run can never mean "verified nothing".
 */
import "./setup.js";

import { describe, it } from "vitest";

import { postgresAvailable } from "./harness.js";

let available: boolean | undefined;

/** Whether the mandatory gate requires a reachable PostgreSQL (fail-closed). */
export function postgresRequired(): boolean {
  const flag = process.env.RA_REQUIRE_POSTGRES;
  return flag !== undefined && flag !== "0" && flag.trim() !== "";
}

/** Resolve (once) whether a real PostgreSQL server is reachable. */
export async function ensurePostgres(): Promise<boolean> {
  if (available === undefined) {
    available = await postgresAvailable();
  }
  return available;
}

/**
 * Like `describe`, but:
 *   - runs the suite when PostgreSQL is reachable;
 *   - when it is NOT reachable and `RA_REQUIRE_POSTGRES` is set, emits a single
 *     failing test so the mandatory gate/CI fails closed (never a green skip);
 *   - otherwise skips with a clear message (local convenience).
 *
 * The availability check runs eagerly at module load via a top-level await in
 * the spec file, so suites are still defined synchronously for Vitest.
 */
export function describeIntegration(name: string, fn: () => void, isAvailable: boolean): void {
  if (isAvailable) {
    describe(name, fn);
    return;
  }
  if (postgresRequired()) {
    describe(name, () => {
      it("requires a reachable PostgreSQL (RA_REQUIRE_POSTGRES set)", () => {
        throw new Error(
          "RA-003 integration gate: PostgreSQL is not reachable but RA_REQUIRE_POSTGRES " +
            "is set. Start it with `pnpm --filter @remoteagent/database db:up`.",
        );
      });
    });
    return;
  }
  describe.skip(`${name} (skipped: no PostgreSQL reachable)`, fn);
}
