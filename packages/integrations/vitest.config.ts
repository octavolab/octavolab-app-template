import { defineConfig } from "vitest/config";
// Coverage gate for the adapters (lines >= 90 % required by the integration checklist; measured values in CHANGELOG).
// oes.sandbox.test.ts is opt-in (OES_SANDBOX_TEST=1) and skips itself in CI.
export default defineConfig({ test: { exclude: ["node_modules/**", "dist/**"], coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"], exclude: ["src/**/*.test.ts"], thresholds: { lines: 90, functions: 90, branches: 85 } } } });
