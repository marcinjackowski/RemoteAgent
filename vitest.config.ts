import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/guardrails/fixtures/**"],
    passWithNoTests: true,
    // Guardrail specs spawn tsc/eslint child processes; give them room.
    testTimeout: 120_000,
    // `hookTimeout` defaults to 10s and was NOT raised alongside `testTimeout`, which
    // made the gate flaky in a way that looked like a product defect.
    //
    // Integration suites create and DROP a throwaway PostgreSQL database in
    // `beforeAll`/`afterAll`. Under a full-repo run — 158 files, many of them holding
    // their own database — a `DROP DATABASE` waits behind other workers' connections
    // and can exceed 10s. The failure then surfaces as `Hook timed out in 10000ms` on
    // a random suite, which reads like a hang rather than contention.
    //
    // Observed twice in a three-run RA-025 gate, on two different suites
    // (`connector-jira/reconciliation`, `test/golden-path`), and never solo. Matched to
    // `testTimeout` because setup and teardown are doing the same kind of work as the
    // tests: real database operations against a contended server.
    hookTimeout: 120_000,
    reporters: ["default"],
  },
});
