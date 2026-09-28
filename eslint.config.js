// Complexity guardrails. `deno lint` covers everything else; ESLint is used
// only for the rules Deno does not implement.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "tests/integration/.generated/",
      "tests/integration/supabase/functions/_shared/",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      complexity: ["error", { max: 10 }],
      "max-depth": ["error", 3],
      "max-params": ["error", 4],
      "max-nested-callbacks": ["error", 3],
      "max-lines-per-function": [
        "error",
        { max: 60, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    // Tests and examples are narrative; only cyclomatic complexity applies.
    files: ["tests/**/*.ts", "examples/**/*.ts"],
    rules: {
      "max-lines-per-function": "off",
      "max-nested-callbacks": "off",
    },
  },
);
