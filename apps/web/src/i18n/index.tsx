import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import es from "./es.json";
import en from "./en.json";

export type Lang = "es" | "en";
export type MessageKey = keyof typeof en;
export const dictionaries: Record<Lang, Record<MessageKey, string>> = { es, en };

/** Replaces {name} placeholders; unknown placeholders stay visible so a missing variable is caught in review. */
export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

type Ctx = { lang: Lang; locale: string; setLang: (l: Lang) => void; t: (key: MessageKey, vars?: Record<string, string | number>) => string };
const I18nContext = createContext<Ctx | null>(null);
const STORAGE_KEY = "ui.lang"; // a per-viewer display preference, never business data

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch { /* storage blocked (private mode): fall back to the browser language */ }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("en") ? "en" : "es";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* storage blocked: the choice lasts for this visit only */ }
  }, []);
  useEffect(() => { document.documentElement.lang = lang; document.title = `${dictionaries[lang].brand} · ${dictionaries[lang].brandTagline}`; }, [lang]);
  const value = useMemo<Ctx>(() => ({
    lang, setLang, locale: lang === "es" ? "es-CO" : "en-GB",
    t: (key, vars) => interpolate(dictionaries[lang][key] ?? key, vars),
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useI18n outside I18nProvider");
  return c;
}
