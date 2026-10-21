import { useEffect, useState } from "react";
import es from "./i18n/es.json";

type Health = { ok: boolean; version: string; mode: string };
const t = es;

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth({ ok: false, version: "?", mode: "?" })); }, []);
  const demo = health?.mode === "fake";
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      {demo && <p role="status" className="mb-4 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-200">{t.demoBanner}</p>}
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
        <span className="text-sm text-gray-500">v{health?.version ?? "..."}</span>
      </header>
      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <article className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <h2 className="text-sm font-medium text-gray-500">{t.health}</h2>
          <p className="mt-1 text-lg font-semibold">{health ? (health.ok ? t.ok : t.down) : "..."}</p>
        </article>
      </section>
    </main>
  );
}
