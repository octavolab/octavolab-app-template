import { defineConfig, configDefaults } from "vitest/config";

// Root config so `npx vitest` from the repo root runs unit tests only.
// e2e/ belongs to Playwright (`pnpm e2e`); integration tests run with INTEGRATION=1 in CI.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**", "e2e/**", ...(process.env.INTEGRATION ? [] : ["**/test/integration/**"])],
  },
});
