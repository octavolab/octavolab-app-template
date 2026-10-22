import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// /api goes to the API on :3000 in `vite` (dev) AND `vite preview` (CI e2e), so the smoke test exercises the real API.
const api = { "/api": process.env.API_URL ?? "http://localhost:3000" };
// "hidden" source maps: generated for the Sentry upload in CI but not referenced from the bundles; infra/Dockerfile
// deletes them from the image so they are never served.
export default defineConfig({ plugins: [react(), tailwindcss()], build: { sourcemap: "hidden" }, server: { proxy: api }, preview: { proxy: api } });
