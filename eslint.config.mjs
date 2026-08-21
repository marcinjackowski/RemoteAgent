// @ts-check
import boundaries from "eslint-plugin-boundaries";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * Shared dependency-boundary policy for the monorepo.
 *
 * - apps are leaf composition roots and must never import another app;
 * - packages are shared libraries and must never import an app;
 * - infra may only depend on packages.
 *
 * Real product logic arrives in later tasks; today the rule guards the skeleton.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/.pnpm-store/**",
      // Deliberately-broken guardrail fixtures are exercised only by their spec.
      "test/guardrails/fixtures/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    /**
     * A leading underscore marks a binding that is deliberately unused.
     *
     * `CTF-008` found the gate and the convention disagreeing: the repo writes
     * `_config` / `_type` / `_unused` in ~20 places, but the default
     * `after-used` setting only reports a *trailing* unused argument — so
     * `(_type, listener)` passed while `(request, _config)` failed. That is the
     * "declared but not enforced" shape ADR-0007 exists to remove, so the
     * convention is stated here once instead of being half-checked.
     *
     * Deliberately narrow: only `args` and `caughtErrors`. An unused *variable*
     * or import stays an error whatever it is named — those are dead code, not
     * an interface shape the author is obliged to keep.
     */
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "infra/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "app", pattern: "apps/*" },
        { type: "package", pattern: "packages/*" },
        { type: "infra", pattern: "infra/*" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            { from: ["app"], allow: ["package"] },
            { from: ["package"], allow: ["package"] },
            { from: ["infra"], allow: ["package"] },
          ],
        },
      ],
    },
  },
  prettier,
);
