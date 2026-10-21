import tseslint from "@typescript-eslint/eslint-plugin";
import parser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
export default [
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.config.*", "**/coverage/**", "playwright-report/**", "test-results/**"] },
  { files: ["**/*.ts", "**/*.tsx"], languageOptions: { parser, parserOptions: { project: false } },
    plugins: { "@typescript-eslint": tseslint },
    rules: { "@typescript-eslint/no-explicit-any": "error", "no-empty": ["error", { allowEmptyCatch: false }], "no-console": ["warn", { allow: ["warn", "error"] }] } },
  prettier,
];
