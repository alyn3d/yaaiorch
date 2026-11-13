// ESLint for the whole repo. Run from orch-ui: `npm run lint` (it lints from the repo root with this config).
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/",
      "orch-ui/dist/",
      "orch-ui/src-tauri/",
      "release/",
      // Test data for the eval suite, not project code.
      "evals/fixtures/",
      "evals/hidden/",
      "evals/reference/",
      "evals/results/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // Event payloads and CLI replies are parsed JSON; they are typed where they are read.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["orch-ui/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    // The classic hook rules only: the React Compiler rules (purity, set-state-in-effect) assume the compiler.
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
);
