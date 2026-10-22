import { useCallback, useEffect, useState } from "react";
import { api, type Checkout, type Order, type Page } from "../lib/api";
import { formatMoney } from "../lib/money";
import { useI18n } from "../i18n";
import { Button, Card, EmptyState, ErrorAlert, Icon, PageHeader, Spinner } from "../components/ui";
import { StatusBadge } from "../components/StatusBadge";
import { shortId } from "./PaymentView";

const PAGE_SIZE = 10;

export function OrdersView({ payOrder, onPaymentReady, onAuthError, goCatalog }: {
  payOrder: (orderId: string) => Promise<Checkout>; onPaymentReady: (c: Checkout) => void; onAuthError: (e: unknown) => boolean; goCatalog: () => void;
}) {
  const { t, locale } = useI18n();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState<string | null>(null);
  const [payError, setPayError] = useState<unknown>(null);

  const fetchPage = useCallback(async (after: string | null, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (after) qs.set("cursor", after);
    return api<Page<Order>>(`/me/orders?${qs}`, signal ? { signal } : {});
  }, []);

  const loadFirst = useCallback(async (signal?: AbortSignal) => {
    setError(null); setOrders(null);
    try {
      const page = await fetchPage(null, signal);
      setOrders(page.items); setCursor(page.nextCursor);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      if (!onAuthError(e)) setError(e);
    }
  }, [fetchPage, onAuthError]);

  useEffect(() => { const c = new AbortController(); void loadFirst(c.signal); return () => c.abort(); }, [loadFirst]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true); setError(null);
    try {
      const page = await fetchPage(cursor);
      setOrders((o) => [...(o ?? []), ...page.items.filter((n) => !(o ?? []).some((x) => x.id === n.id))]);
      setCursor(page.nextCursor);
    } catch (e) { if (!onAuthError(e)) setError(e); } finally { setLoadingMore(false); }
  }

  async function resume(id: string) {
    setPaying(id); setPayError(null);
    try { onPaymentReady(await payOrder(id)); } catch (e) { if (!onAuthError(e)) setPayError(e); } finally { setPaying(null); }
  }

  const fmtDate = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  return (
    <div>
      <PageHeader title={t("ordersTitle")} subtitle={t("ordersSubtitle")} />
      {Boolean(payError) && <ErrorAlert className="mb-4" error={payError} />}
      {error && !orders ? <ErrorAlert error={error} onRetry={() => void loadFirst()} />
        : orders === null ? <div role="status" className="flex items-center gap-2 py-10 text-sm text-ink-700 dark:text-ink-200"><Spinner />{t("loading")}</div>
        : orders.length === 0 ? <EmptyState icon={<Icon name="receipt" className="size-7" />} title={t("ordersEmpty")} action={<Button onClick={goCatalog}>{t("goToCatalog")}</Button>} />
        : (
          <>
            <div className="hidden grid-cols-[1.2fr_1.4fr_0.8fr_1fr_1.2fr_auto] gap-4 px-5 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-600 md:grid dark:text-ink-300" aria-hidden="true">
              <span>{t("orderNumber")}</span><span>{t("orderDate")}</span><span>{t("orderItems")}</span><span className="text-right">{t("orderTotal")}</span><span>{t("orderStatus")}</span><span className="w-28" />
            </div>
            <ul className="space-y-3" aria-label={t("ordersTitle")}>
              {orders.map((o) => {
                const isOpen = open.has(o.id);
                const units = o.items.reduce((s, i) => s + i.qty, 0);
                const payable = o.status === "draft" || o.status === "confirmed" || o.status === "pending_payment";
                return (
                  <li key={o.id}>
                    <Card as="article" aria-label={t("orderDetails", { id: shortId(o.id) })} className="p-4 md:px-5" >
                      <div className="grid grid-cols-2 items-center gap-x-4 gap-y-2 md:grid-cols-[1.2fr_1.4fr_0.8fr_1fr_1.2fr_auto]">
                        <p className="font-mono text-sm font-semibold text-ink-950 dark:text-white" data-testid="order-id">#{shortId(o.id)}</p>
                        <p className="text-right text-sm text-ink-700 md:text-left dark:text-ink-200"><time dateTime={o.createdAt}>{fmtDate(o.createdAt)}</time></p>
                        <p className="text-sm text-ink-700 dark:text-ink-200">{units === 1 ? t("cartItemsOne") : t("cartItems", { count: units })}</p>
                        <p className="tabular text-right text-base font-bold text-ink-950 dark:text-white">{formatMoney(o.totalAmount, o.currency, locale)}</p>
                        <div><StatusBadge status={o.status} /></div>
                        <div className="col-span-2 flex justify-end gap-2 md:col-span-1">
                          {payable && <Button size="sm" busy={paying === o.id} onClick={() => void resume(o.id)}>{t("resumePayment")}</Button>}
                          <Button size="sm" variant="ghost" aria-expanded={isOpen} aria-controls={`items-${o.id}`}
                            onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}>
                            {isOpen ? t("hideItems") : t("showItems")}
                          </Button>
                        </div>
                      </div>
                      <ul id={`items-${o.id}`} hidden={!isOpen} className="mt-3 divide-y divide-ink-100 rounded-xl bg-ink-50 px-4 text-sm dark:divide-ink-800 dark:bg-ink-800/60">
                        {o.items.map((i) => (
                          <li key={i.id} className="flex justify-between gap-3 py-2">
                            <span className="font-mono text-ink-800 dark:text-ink-100">{t("lineItem", { qty: i.qty, sku: i.sku })}</span>
                            <span className="tabular text-ink-800 dark:text-ink-100">{formatMoney(i.unitAmount * i.qty, o.currency, locale)}</span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  </li>
                );
              })}
            </ul>
            {Boolean(error) && <ErrorAlert className="mt-4" error={error} onRetry={() => void loadMore()} />}
            {cursor && (
              <div className="mt-6 flex justify-center">
                <Button variant="secondary" busy={loadingMore} onClick={() => void loadMore()}>{t("loadMore")}</Button>
              </div>
            )}
          </>
        )}
    </div>
  );
}
