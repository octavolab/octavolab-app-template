import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// /api goes to the API on :3000 in `vite` (dev) AND `vite preview` (CI e2e), so the smoke test exercises the real API.
const api = { "/api": process.env.API_URL ?? "http://localhost:3000" };
export default defineConfig({ plugins: [react(), tailwindcss()], server: { proxy: api }, preview: { proxy: api } });
