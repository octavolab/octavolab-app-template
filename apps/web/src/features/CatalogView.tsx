import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Checkout, type Product } from "../lib/api";
import { addOne, setQty, summarize, MAX_QTY, type CartLine } from "../lib/cart";
import { formatMoney } from "../lib/money";
import { useI18n } from "../i18n";
import { Button, Card, EmptyState, ErrorAlert, Icon, PageHeader, SkeletonGrid, cx } from "../components/ui";

type Flow = { placeOrder: (lines: CartLine[], onStep?: (s: "order" | "payment") => void) => Promise<{ checkout: Checkout }> };

/** Deterministic accent per SKU so each product card is recognisable without any static imagery. */
function hue(sku: string): number {
  let h = 0;
  for (const ch of sku) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export function CatalogView({ lines, setLines, flow, onPaymentReady, onAuthError }: {
  lines: CartLine[]; setLines: (f: (l: CartLine[]) => CartLine[]) => void; flow: Flow;
  onPaymentReady: (c: Checkout) => void; onAuthError: (e: unknown) => boolean;
}) {
  const { t, locale } = useI18n();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [step, setStep] = useState<"idle" | "order" | "payment">("idle");
  const [checkoutError, setCheckoutError] = useState<unknown>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try {
      const res = await api<{ items: Product[] }>("/products", signal ? { signal } : {});
      setProducts(res.items.filter((p) => p.active));
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (!onAuthError(e)) setLoadError(e);
    }
  }, [onAuthError]);

  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);

  const summary = useMemo(() => summarize(lines, products ?? []), [lines, products]);
  const bySku = useMemo(() => new Map((products ?? []).map((p) => [p.sku, p] as const)), [products]);
  const canCheckout = summary.count > 0 && !summary.mixedCurrency && summary.unavailable.length === 0 && step === "idle";

  async function checkout() {
    setCheckoutError(null);
    try {
      const { checkout: c } = await flow.placeOrder(lines.filter((l) => bySku.has(l.sku)), setStep);
      setLines(() => []);
      onPaymentReady(c);
    } catch (e) {
      if (onAuthError(e)) return;
      setCheckoutError(e);
      if (e instanceof ApiError && e.code === "UNKNOWN_SKU") void load();
    } finally { setStep("idle"); }
  }

  // The floating "view cart" shortcut (phones and tablets) hides while the cart itself is on screen, so it never covers the checkout button.
  const [cartVisible, setCartVisible] = useState(false);
  const cartRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = cartRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setCartVisible(Boolean(e?.isIntersecting)), { rootMargin: "0px 0px -64px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const qtyOf = (sku: string) => lines.find((l) => l.sku === sku)?.qty ?? 0;

  return (
    <div>
      <PageHeader title={t("catalogTitle")} subtitle={t("catalogSubtitle")} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-label={t("catalogTitle")}>
          {loadError ? <ErrorAlert error={loadError} onRetry={() => void load()} />
            : products === null ? <SkeletonGrid label={t("loading")} />
            : products.length === 0 ? <EmptyState icon={<Icon name="box" className="size-7" />} title={t("catalogEmpty")} />
            : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label={t("catalogTitle")}>
                {products.map((p) => {
                  const q = qtyOf(p.sku);
                  const h = hue(p.sku);
                  return (
                    <li key={p.id}>
                      <Card as="article" aria-labelledby={`p-${p.id}`} className="group flex h-full flex-col overflow-hidden transition-shadow hover:shadow-lg">
                        <div aria-hidden="true" className="relative h-28 overflow-hidden" style={{ background: `linear-gradient(135deg, hsl(${h} 70% 92%), hsl(${(h + 40) % 360} 75% 82%))` }}>
                          <span className="absolute -bottom-4 right-3 text-7xl font-black tracking-tighter opacity-25 transition-transform group-hover:-translate-y-1" style={{ color: `hsl(${h} 60% 25%)` }}>{initials(p.name)}</span>
                          <Icon name="box" className="absolute left-4 top-4 size-7 text-ink-900/70" />
                        </div>
                        <div className="flex flex-1 flex-col gap-3 p-4">
                          <div>
                            <p className="font-mono text-xs text-ink-600 dark:text-ink-300">{p.sku}</p>
                            <h2 id={`p-${p.id}`} className="mt-0.5 text-base font-semibold text-ink-950 dark:text-white">{p.name}</h2>
                          </div>
                          <p className="tabular text-2xl font-bold tracking-tight text-ink-950 dark:text-white">{formatMoney(p.unitAmount, p.currency, locale)}</p>
                          <div className="mt-auto">
                            {q === 0 ? (
                              <Button className="w-full" onClick={() => setLines((l) => addOne(l, p.sku))}>
                                <Icon name="plus" className="size-4" />{t("addToCart")}<span className="sr-only">: {p.name}</span>
                              </Button>
                            ) : (
                              <QtyStepper name={p.name} qty={q} onChange={(n) => setLines((l) => setQty(l, p.sku, n))} />
                            )}
                          </div>
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
        </section>

        <Card as="aside" ref={cartRef} aria-labelledby="cart-title" className="h-fit p-5 lg:sticky lg:top-24">
          <div id="cart" className="flex items-center justify-between scroll-mt-28">
            <h2 id="cart-title" tabIndex={-1} className="flex items-center gap-2 text-lg font-bold text-ink-950 dark:text-white"><Icon name="cart" />{t("cartTitle")}</h2>
            {summary.count > 0 && <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-800 dark:bg-brand-900/60 dark:text-brand-100">{summary.count === 1 ? t("cartItemsOne") : t("cartItems", { count: summary.count })}</span>}
          </div>
          {lines.length === 0 ? (
            <p className="mt-6 rounded-xl bg-ink-50 p-4 text-sm text-ink-700 dark:bg-ink-800 dark:text-ink-200">{t("cartEmpty")}</p>
          ) : (
            <>
              <ul className="mt-4 divide-y divide-ink-100 dark:divide-ink-800" aria-label={t("cartTitle")}>
                {lines.map((l) => {
                  const p = bySku.get(l.sku);
                  const name = p?.name ?? l.sku;
                  return (
                    <li key={l.sku} className="flex flex-wrap items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-950 dark:text-white">{name}</p>
                        <p className={cx("tabular text-xs", p ? "text-ink-600 dark:text-ink-300" : "text-red-700 dark:text-red-300")}>
                          {p ? formatMoney(p.unitAmount * l.qty, p.currency, locale) : t("err_UNKNOWN_SKU")}
                        </p>
                      </div>
                      <QtyStepper compact name={name} qty={l.qty} onChange={(n) => setLines((ls) => setQty(ls, l.sku, n))} />
                      <button type="button" onClick={() => setLines((ls) => setQty(ls, l.sku, 0))} aria-label={t("remove", { name })}
                        className="grid size-9 place-items-center rounded-lg text-ink-500 hover:bg-red-50 hover:text-red-700 dark:text-ink-300 dark:hover:bg-red-950 dark:hover:text-red-300"><Icon name="x" className="size-4" /></button>
                    </li>
                  );
                })}
              </ul>
              <dl className="mt-4 space-y-1 border-t border-ink-100 pt-4 dark:border-ink-800">
                {summary.totals.map((tot) => (
                  <div key={tot.currency} className="flex items-baseline justify-between">
                    <dt className="text-sm text-ink-700 dark:text-ink-200">{t("total")}</dt>
                    <dd className="tabular text-xl font-bold text-ink-950 dark:text-white" data-testid="cart-total">{formatMoney(tot.amount, tot.currency, locale)}</dd>
                  </div>
                ))}
              </dl>
              {summary.mixedCurrency && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{t("mixedCurrency")}</p>}
              {Boolean(checkoutError) && <ErrorAlert className="mt-4" error={checkoutError} onRetry={canCheckout ? () => void checkout() : undefined} />}
              <Button size="lg" className="mt-4 w-full" busy={step !== "idle"} disabled={!canCheckout} onClick={() => void checkout()}>
                {step === "order" ? t("placingOrder") : step === "payment" ? t("startingPayment") : <><Icon name="lock" className="size-4" />{t("checkout")}</>}
              </Button>
              <p className="mt-3 text-xs text-ink-600 dark:text-ink-300">{t("orderPriceNote")}</p>
              <p aria-live="polite" className="sr-only">{step === "order" ? t("placingOrder") : step === "payment" ? t("startingPayment") : ""}</p>
            </>
          )}
        </Card>
      </div>

      {summary.count > 0 && !cartVisible && (
        <a href="#cart" onClick={(e) => { e.preventDefault(); document.getElementById("cart")?.scrollIntoView({ behavior: "smooth" }); document.getElementById("cart-title")?.focus(); }}
          className="fixed inset-x-4 bottom-4 z-20 flex h-12 items-center justify-center gap-2 rounded-2xl bg-ink-950 font-semibold text-white shadow-xl lg:hidden dark:bg-white dark:text-ink-950">
          <Icon name="cart" />{t("viewCart", { count: summary.count })}
        </a>
      )}
    </div>
  );
}

function QtyStepper({ name, qty, onChange, compact }: { name: string; qty: number; onChange: (n: number) => void; compact?: boolean }) {
  const { t } = useI18n();
  const btn = cx("grid place-items-center rounded-lg text-ink-800 hover:bg-ink-100 disabled:opacity-40 dark:text-ink-100 dark:hover:bg-ink-700", compact ? "size-8" : "size-10");
  return (
    <div className={cx("flex items-center justify-between rounded-xl bg-ink-50 p-1 ring-1 ring-inset ring-ink-200 dark:bg-ink-800 dark:ring-ink-700", compact ? "w-28" : "w-full")}>
      <button type="button" className={btn} onClick={() => onChange(qty - 1)} aria-label={t("decrease", { name })}><Icon name="minus" className="size-4" /></button>
      <input type="number" inputMode="numeric" min={0} max={MAX_QTY} value={qty} aria-label={t("qtyOf", { name })}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
        className="tabular w-12 bg-transparent text-center text-sm font-semibold text-ink-950 [appearance:textfield] dark:text-white [&::-webkit-inner-spin-button]:appearance-none" />
      <button type="button" className={btn} onClick={() => onChange(qty + 1)} disabled={qty >= MAX_QTY} aria-label={t("increase", { name })}><Icon name="plus" className="size-4" /></button>
    </div>
  );
}
