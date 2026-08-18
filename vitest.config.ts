import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/guardrails/fixtures/**"],
    passWithNoTests: true,
    // Guardrail specs spawn tsc/eslint child processes; give them room.
    testTimeout: 120_000,
    reporters: ["default"],
  },
});
