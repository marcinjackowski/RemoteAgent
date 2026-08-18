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
      // Deliberately-broken guardrail fixtures are exercised only by their spec.
      "test/guardrails/fixtures/**",
    ],
  },
  ...tseslint.configs.recommended,
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
