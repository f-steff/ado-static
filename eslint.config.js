// Flat ESLint config (ESLint 9).
//
// Rationale: keep linting intentionally small  -  TypeScript syntax via @typescript-eslint and
// a couple of pragmatic rules. A minimal config avoids churn while still catching unused
// variables and obvious mistakes.
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

module.exports = [
  // Build output and dependencies are never linted.
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2020,
      // Source is ESM (bundled by esbuild).
      sourceType: "module"
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // Allow intentionally unused args prefixed with "_" (e.g. catch parameters).
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // TypeScript handles globals; the base rule produces false positives.
      "no-undef": "off"
    }
  }
];
