// Fixture-local ESLint config used only by the guardrails spec. It reproduces
// the repo dependency-boundary policy on a tiny app-imports-app violation so the
// spec can assert the rule fires. Run explicitly with `--no-config-lookup`.
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { boundaries },
  settings: {
    "boundaries/elements": [{ type: "app", pattern: "**/apps/*" }],
  },
  rules: {
    // No allow policies: any app -> app import is a violation.
    "boundaries/dependencies": ["error", { default: "disallow", policies: [] }],
  },
});
