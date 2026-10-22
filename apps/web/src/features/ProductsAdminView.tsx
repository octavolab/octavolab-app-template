import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Product, type Role } from "../lib/api";
import { currencyExponent, formatMoney, minorToMajorInput, parseMajorToMinor } from "../lib/money";
import { useI18n } from "../i18n";
import { Button, Card, EmptyState, ErrorAlert, Field, Icon, Notice, PageHeader, Spinner, cx } from "../components/ui";

// Currencies accepted by PUT /products/:sku (apps/api/src/routes/orders.ts `Currency`).
const CURRENCIES = ["GBP", "USD", "EUR", "COP", "MXN", "BRL"] as const;
const SKU_RE = /^[\w.-]{1,64}$/;

/**
 * Staff price list. GET /products (staff see inactive too) and PUT /products/:sku (owner, admin) are the only product
 * endpoints the API exposes: create and edit are both the idempotent upsert by SKU; there is no delete (deactivate instead).
 * Operations can read but not write, so the edit controls are hidden for that role.
 */
export function ProductsAdminView({ role, onAuthError }: { role: Role; onAuthError: (e: unknown) => boolean }) {
  const { t, locale } = useI18n();
  const canEdit = role === "owner" || role === "admin";
  const [items, setItems] = useState<Product[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null);
    try { setItems((await api<{ items: Product[] }>("/products", signal ? { signal } : {})).items); }
    catch (e) { if (e instanceof DOMException && e.name === "AbortError") return; if (!onAuthError(e)) setError(e); }
  }, [onAuthError]);
  useEffect(() => { const c = new AbortController(); void load(c.signal); return () => c.abort(); }, [load]);

  return (
    <div>
      <PageHeader title={t("productsTitle")} subtitle={t("productsSubtitle")}
        actions={canEdit && <Button onClick={() => { setSaved(null); setEditing("new"); }}><Icon name="plus" className="size-4" />{t("newProduct")}</Button>} />
      {!canEdit && <Notice className="mb-4">{t("productsReadOnly")}</Notice>}
      {saved && <Notice tone="success" className="mb-4">{t("productSaved", { sku: saved })}</Notice>}
      {error ? <ErrorAlert error={error} onRetry={() => void load()} />
        : items === null ? <div role="status" className="flex items-center gap-2 py-10 text-sm text-ink-700 dark:text-ink-200"><Spinner />{t("loading")}</div>
        : items.length === 0 ? <EmptyState icon={<Icon name="tag" className="size-7" />} title={t("productsEmpty")} />
        : (
          <Card className="overflow-hidden">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{t("productsTitle")}</caption>
              <thead className="sr-only bg-ink-50 text-xs uppercase tracking-wide text-ink-600 md:not-sr-only md:table-header-group dark:bg-ink-800 dark:text-ink-300">
                <tr><th scope="col" className="px-5 py-3">{t("sku")}</th><th scope="col" className="px-5 py-3">{t("name")}</th><th scope="col" className="px-5 py-3 text-right">{t("price")}</th><th scope="col" className="px-5 py-3">{t("active")}</th>{canEdit && <th scope="col" className="px-5 py-3 text-right">{t("actions")}</th>}</tr>
              </thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {items.map((p) => (
                  <tr key={p.id} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-4 py-3 md:table-row md:p-0">
                    <td className="font-mono text-xs text-ink-600 md:px-5 md:py-3 dark:text-ink-300">{p.sku}</td>
                    <td className="col-start-1 row-start-2 font-medium text-ink-950 md:px-5 md:py-3 dark:text-white">{p.name}</td>
                    <td className="tabular row-span-2 self-center text-right font-semibold text-ink-950 md:px-5 md:py-3 dark:text-white">{formatMoney(p.unitAmount, p.currency, locale)}</td>
                    <td className="md:px-5 md:py-3">
                      <span className={cx("inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset", p.active ? "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900" : "bg-ink-100 text-ink-700 ring-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:ring-ink-700")}>
                        {p.active ? t("active") : t("inactive")}
                      </span>
                    </td>
                    {canEdit && (
                      <td className="text-right md:px-5 md:py-3">
                        <Button size="sm" variant="secondary" onClick={() => { setSaved(null); setEditing(p); }} aria-label={t("editProduct", { sku: p.sku })}>{t("edit")}</Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      {editing && (
        <ProductDialog product={editing === "new" ? null : editing} onClose={() => setEditing(null)} onAuthError={onAuthError}
          onSaved={(p) => { setEditing(null); setSaved(p.sku); setItems((list) => { const rest = (list ?? []).filter((x) => x.sku !== p.sku); return [...rest, p].sort((a, b) => a.sku.localeCompare(b.sku)); }); }} />
      )}
    </div>
  );
}

function ProductDialog({ product, onClose, onSaved, onAuthError }: { product: Product | null; onClose: () => void; onSaved: (p: Product) => void; onAuthError: (e: unknown) => boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [sku, setSku] = useState(product?.sku ?? "");
  const [name, setName] = useState(product?.name ?? "");
  const [currency, setCurrency] = useState<string>(product?.currency ?? "GBP");
  const [price, setPrice] = useState(product ? minorToMajorInput(product.unitAmount, product.currency) : "");
  const [active, setActive] = useState(product?.active ?? true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal(); }, []);

  const amount = parseMajorToMinor(price, currency);
  const errs = {
    sku: SKU_RE.test(sku) ? undefined : t("invalidSku"),
    name: name.trim() ? undefined : t("invalidName"),
    price: amount ? undefined : t("invalidPrice", { digits: currencyExponent(currency) }),
  };
  const valid = !errs.sku && !errs.name && !errs.price;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!valid || !amount) return;
    setBusy(true); setError(null);
    try {
      const saved = await api<Product>(`/products/${encodeURIComponent(sku)}`, { method: "PUT", body: { name: name.trim(), unitAmount: amount, currency, active } });
      onSaved(saved);
    } catch (err) { if (!onAuthError(err)) setError(err); } finally { setBusy(false); }
  }

  const title = product ? t("editProduct", { sku: product.sku }) : t("newProduct");
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="product-dialog-title"
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl bg-white p-0 text-ink-900 shadow-2xl backdrop:bg-ink-950/60 dark:bg-ink-900 dark:text-ink-50">
      <form onSubmit={submit} noValidate className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 id="product-dialog-title" className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={() => ref.current?.close()} aria-label={t("close")} className="grid size-9 place-items-center rounded-lg text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"><Icon name="x" className="size-4" /></button>
        </div>
        {Boolean(error) && <ErrorAlert error={error} />}
        <Field label={t("sku")} value={sku} onChange={(e) => setSku(e.target.value.trim())} readOnly={Boolean(product)} hint={t("skuHint")} error={touched ? errs.sku : undefined} autoComplete="off" spellCheck={false} maxLength={64} />
        <Field label={t("name")} value={name} onChange={(e) => setName(e.target.value)} error={touched ? errs.name : undefined} maxLength={200} autoComplete="off" />
        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <Field label={t("price")} value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} hint={t("priceHint", { currency })} error={touched ? errs.price : undefined} autoComplete="off" />
          <div>
            <label htmlFor="product-currency" className="mb-1.5 block text-sm font-medium text-ink-800 dark:text-ink-100">{t("currency")}</label>
            <select id="product-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className="block h-11 w-full rounded-xl border border-ink-200 bg-white px-3 text-base text-ink-900 sm:text-sm dark:border-ink-700 dark:bg-ink-900 dark:text-ink-50">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <label className="flex items-center gap-3 rounded-xl bg-ink-50 p-3 text-sm dark:bg-ink-800">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="size-5 accent-brand-700" />
          <span><span className="font-medium">{t("active")}</span><span className="block text-xs text-ink-600 dark:text-ink-300">{t("activeHint")}</span></span>
        </label>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={() => ref.current?.close()}>{t("cancel")}</Button>
          <Button type="submit" busy={busy}>{busy ? t("saving") : t("save")}</Button>
        </div>
      </form>
    </dialog>
  );
}
