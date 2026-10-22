import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Checkout, type Health, type LoginResponse, type Me } from "./lib/api";
import { createCheckoutFlow } from "./lib/checkout";
import type { CartLine } from "./lib/cart";
import { I18nProvider, useI18n, type Lang } from "./i18n";
import { Button, Icon, Notice, Spinner, cx } from "./components/ui";
import { LoginView } from "./features/LoginView";
import { CatalogView } from "./features/CatalogView";
import { OrdersView } from "./features/OrdersView";
import { PaymentView } from "./features/PaymentView";
import { ProductsAdminView } from "./features/ProductsAdminView";
import { SecurityView } from "./features/SecurityView";

type View = "catalog" | "orders" | "payment" | "products" | "security";
type Session = { state: "loading" } | { state: "anon"; notice?: string } | { state: "authed"; me: Me; email?: string };

const STAFF_VIEWS: View[] = ["products", "security"];
const CUSTOMER_VIEWS: View[] = ["catalog", "orders", "payment"];
const allowed = (me: Me): View[] => (me.role === "customer" ? CUSTOMER_VIEWS : STAFF_VIEWS);
const home = (me: Me): View => (me.role === "customer" ? "catalog" : me.mfaEnrollmentRequired ? "security" : "products");

/** Hash routing (#/orders): deep links and the back button work with no router dependency and no server rewrites. */
function readHash(): View | null {
  const v = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return (["catalog", "orders", "products", "security"] as string[]).includes(v ?? "") ? (v as View) : null;
}

export function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}

function Shell() {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [view, setView] = useState<View>(readHash() ?? "catalog");
  const [lines, setLinesState] = useState<CartLine[]>([]);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const flow = useMemo(() => createCheckoutFlow(api), []);

  useEffect(() => {
    // /api/health answers 503 with the same body when the database is down, so the body is read whatever the status.
    fetch("/api/health", { credentials: "same-origin" })
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth(null)); // unknown mode: payments stay in demo (never ask for card data blind)
  }, []);

  const refreshMe = useCallback(async (email?: string) => {
    try {
      const me = await api<Me>("/auth/me");
      setSession((s) => ({ state: "authed", me, ...(email ? { email } : s.state === "authed" && s.email ? { email: s.email } : {}) }));
      return me;
    } catch {
      setSession({ state: "anon" });
      return null;
    }
  }, []);

  useEffect(() => { void refreshMe(); }, [refreshMe]);

  // Keep the URL and the view in sync, and never show a view the role cannot use.
  useEffect(() => {
    const onHash = () => { const v = readHash(); if (v) setView(v); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (session.state !== "authed") return;
    const me = session.me;
    if (me.mfaEnrollmentRequired && view !== "security") { setView("security"); return; }
    if (!allowed(me).includes(view) || (view === "payment" && !checkout)) setView(home(me));
  }, [session, view, checkout]);
  useEffect(() => {
    if (view !== "payment" && readHash() !== view) window.history.replaceState(null, "", `#/${view}`);
  }, [view]);

  const go = useCallback((v: View) => {
    setView(v);
    if (v !== "payment") window.location.hash = `/${v}`;
    requestAnimationFrame(() => mainRef.current?.focus());
  }, []);

  /** Central handling of auth failures from any view: returns true when the error was handled here. */
  const onAuthError = useCallback((e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    if (e.status === 401) { setLinesState([]); setCheckout(null); setSession({ state: "anon", notice: t("err_UNAUTHENTICATED") }); return true; }
    if (e.code === "MFA_ENROLLMENT_REQUIRED") { void refreshMe(); setView("security"); return true; }
    return false;
  }, [refreshMe, t]);

  const onSignedIn = useCallback(async (r: Exclude<LoginResponse, { mfaRequired: true }>) => {
    const me = await refreshMe(r.email);
    if (!me) return;
    setFlash(r.recoveryCodesRemaining !== undefined ? t("recoveryRemaining", { count: r.recoveryCodesRemaining }) : null);
    // Respect a deep link (#/orders) when the role may open it; otherwise the role's home.
    const target = readHash();
    go(target && allowed(me).includes(target) && !me.mfaEnrollmentRequired ? target : home(me));
  }, [refreshMe, go, t]);

  async function signOut() {
    try { await api("/auth/logout", { method: "POST" }); } catch { /* the cookie is cleared server-side when reachable; the UI signs out regardless */ }
    setLinesState([]); setCheckout(null); setFlash(null); setSession({ state: "anon" });
  }

  const setLines = useCallback((f: (l: CartLine[]) => CartLine[]) => setLinesState(f), []);
  const onPaymentReady = useCallback((c: Checkout) => { setCheckout(c); setView("payment"); requestAnimationFrame(() => mainRef.current?.focus()); }, []);

  const demo = health?.mode === "fake";
  const cartCount = lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded-lg bg-brand-700 px-4 py-2 font-semibold text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4">{t("skipToContent")}</a>
      {demo && (
        <p role="status" className="bg-amber-100 px-4 py-2 text-center text-xs font-medium text-amber-950 sm:text-sm dark:bg-amber-900/60 dark:text-amber-100">{t("demoBanner")}</p>
      )}
      <header className="sticky top-0 z-30 border-b border-ink-200/70 bg-white/85 backdrop-blur-md dark:border-ink-800 dark:bg-ink-950/85">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <a href={session.state === "authed" ? `#/${home(session.me)}` : "#"} className="flex items-center gap-2.5 rounded-lg">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 text-sm font-black text-white shadow-md shadow-brand-700/30">8</span>
            <span className="text-base font-bold tracking-tight text-ink-950 dark:text-white">{t("brand")}</span>
          </a>
          {session.state === "authed" && (
            <nav aria-label={t("mainNav")} className="ml-4 hidden md:block">
              <NavTabs me={session.me} view={view} go={go} cartCount={cartCount} />
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2">
            <LangSwitch />
            {session.state === "authed" && (
              <>
                <span className="hidden max-w-[14rem] truncate rounded-full bg-ink-100 px-3 py-1 text-xs font-medium text-ink-800 lg:inline dark:bg-ink-800 dark:text-ink-100"
                  title={t("signedInAs", { who: session.email ?? t(`role_${session.me.role}`) })}>
                  {session.email ? `${session.email} · ` : ""}{t(`role_${session.me.role}`)}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void signOut()} aria-label={t("signOut")}>
                  <Icon name="logout" className="size-4" /><span className="hidden sm:inline">{t("signOut")}</span>
                </Button>
              </>
            )}
          </div>
        </div>
        {session.state === "authed" && (
          <nav aria-label={t("mainNav")} className="border-t border-ink-100 px-4 py-2 md:hidden dark:border-ink-800">
            <NavTabs me={session.me} view={view} go={go} cartCount={cartCount} />
          </nav>
        )}
      </header>

      <main id="main" ref={mainRef} tabIndex={-1} className={cx("outline-none", session.state === "authed" && "mx-auto max-w-7xl px-4 pb-24 pt-6 sm:px-6 lg:px-8 lg:pb-12 lg:pt-10")}>
        {session.state === "authed" && flash && (
          <Notice tone="warning" className="mb-6"><span className="flex items-start justify-between gap-3">{flash}
            <button type="button" onClick={() => setFlash(null)} aria-label={t("close")} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-amber-100 dark:hover:bg-amber-900"><Icon name="x" className="size-4" /></button></span></Notice>
        )}
        {session.state === "loading" ? (
          <div role="status" className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-ink-700 dark:text-ink-200"><Spinner />{t("loading")}</div>
        ) : session.state === "anon" ? (
          <LoginView onSignedIn={(r) => void onSignedIn(r)} notice={session.notice} />
        ) : view === "catalog" ? (
          <CatalogView lines={lines} setLines={setLines} flow={flow} onPaymentReady={onPaymentReady} onAuthError={onAuthError} />
        ) : view === "orders" ? (
          <OrdersView payOrder={flow.payOrder} onPaymentReady={onPaymentReady} onAuthError={onAuthError} goCatalog={() => go("catalog")} />
        ) : view === "payment" && checkout ? (
          <PaymentView checkout={checkout} health={health} onDone={() => { setCheckout(null); go("orders"); }} />
        ) : view === "products" ? (
          <ProductsAdminView role={session.me.role} onAuthError={onAuthError} />
        ) : view === "security" ? (
          <SecurityView me={session.me} onChanged={() => void refreshMe()} onAuthError={onAuthError} />
        ) : null}
      </main>
    </div>
  );
}

function NavTabs({ me, view, go, cartCount }: { me: Me; view: View; go: (v: View) => void; cartCount: number }) {
  const { t } = useI18n();
  const items: { v: View; label: string; icon: "cart" | "receipt" | "tag" | "shield"; badge?: number }[] = me.role === "customer"
    ? [{ v: "catalog", label: t("navCatalog"), icon: "cart", badge: cartCount }, { v: "orders", label: t("navOrders"), icon: "receipt" }]
    : [{ v: "products", label: t("navProducts"), icon: "tag" }, { v: "security", label: t("navSecurity"), icon: "shield" }];
  const current = view === "payment" ? "catalog" : view;
  return (
    <ul className="flex gap-1">
      {items.map((i) => {
        const disabled = me.mfaEnrollmentRequired && i.v !== "security";
        return (
          <li key={i.v} className="flex-1 md:flex-none">
            <a href={`#/${i.v}`} aria-current={current === i.v ? "page" : undefined} aria-disabled={disabled || undefined}
              onClick={(e) => { e.preventDefault(); if (!disabled) go(i.v); }}
              className={cx("flex h-10 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors",
                current === i.v ? "bg-ink-950 text-white dark:bg-white dark:text-ink-950" : "text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800",
                disabled && "cursor-not-allowed opacity-50")}>
              <Icon name={i.icon} className="size-4" />{i.label}
              {i.badge ? <><span aria-hidden="true" className="tabular rounded-full bg-sun-400 px-1.5 text-xs font-bold text-ink-950">{i.badge}</span><span className="sr-only">({t("cartItems", { count: i.badge })})</span></> : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  const opts: { l: Lang; short: string; label: string }[] = [{ l: "es", short: "ES", label: t("langEs") }, { l: "en", short: "EN", label: t("langEn") }];
  return (
    <div role="group" aria-label={t("language")} className="flex rounded-xl bg-ink-100 p-1 dark:bg-ink-800">
      {opts.map((o) => (
        <button key={o.l} type="button" lang={o.l} aria-pressed={lang === o.l} aria-label={o.label} onClick={() => setLang(o.l)}
          className={cx("h-8 rounded-lg px-2.5 text-xs font-bold", lang === o.l ? "bg-white text-ink-950 shadow-sm dark:bg-ink-950 dark:text-white" : "text-ink-700 hover:text-ink-950 dark:text-ink-200 dark:hover:text-white")}>
          {o.short}
        </button>
      ))}
    </div>
  );
}
