import { defineConfig } from "vitest/config";
// Ratchet: raise these only in PRs that add tests (Módulo C 7.1 target: 80/80/70; 100 % in money and state logic).
export default defineConfig({ resolve: { conditions: ["development"] }, test: { coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"], exclude: ["src/server.ts"], thresholds: { lines: 25, functions: 20, branches: 50, "src/lib/money.ts": { lines: 100 } } } } });
