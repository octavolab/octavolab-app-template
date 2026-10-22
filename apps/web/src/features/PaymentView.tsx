import { lazy, Suspense } from "react";
import type { Checkout, Health } from "../lib/api";
import { paymentMode } from "../lib/payments";
import { formatMoney } from "../lib/money";
import { useI18n } from "../i18n";
import { Button, Card, Icon, Spinner } from "../components/ui";

// Stripe's SDK is loaded only when a real payment form is needed (keeps the demo and staff bundles small).
const StripeForm = lazy(() => import("./StripeForm"));

export function shortId(id: string): string {
  return id.slice(-8).toUpperCase();
}

export function PaymentView({ checkout, health, onDone }: { checkout: Checkout; health: Health | null; onDone: () => void }) {
  const { t, locale } = useI18n();
  const mode = paymentMode(checkout, health);
  const amount = formatMoney(checkout.amount, checkout.currency, locale);
  return (
    <div className="mx-auto max-w-xl">
      <Card className="overflow-hidden">
        <div className="bg-ink-950 px-6 py-6 text-white dark:bg-ink-800">
          <p className="text-sm text-ink-200">{t("paymentOrder", { id: shortId(checkout.orderId) })}</p>
          <h1 className="mt-1 text-2xl font-bold">{t("paymentTitle")}</h1>
          <div className="mt-4 flex items-baseline justify-between gap-3">
            <span className="text-sm text-ink-200">{t("paymentAmount")}</span>
            <span className="tabular text-3xl font-bold" data-testid="payment-amount">{amount}</span>
          </div>
        </div>
        <div className="p-6">
          {mode === "demo" ? (
            <section aria-labelledby="demo-title" data-testid="demo-payment">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-wide text-amber-950 dark:bg-amber-900/60 dark:text-amber-100">
                <Icon name="spark" className="size-3.5" />{t("demoPaymentBadge")}
              </span>
              <h2 id="demo-title" className="mt-4 text-lg font-semibold text-ink-950 dark:text-white">{t("demoPaymentTitle")}</h2>
              <p className="mt-2 text-sm text-ink-700 dark:text-ink-200">{t("demoPaymentBody")}</p>
              <Button size="lg" className="mt-6 w-full" onClick={onDone}><Icon name="receipt" className="size-4" />{t("demoPaymentDone")}</Button>
            </section>
          ) : (
            <Suspense fallback={<p role="status" className="flex items-center gap-2 text-sm text-ink-700 dark:text-ink-200"><Spinner />{t("stripeLoading")}</p>}>
              <StripeForm clientSecret={checkout.clientSecret!} amountLabel={amount} onDone={onDone} />
            </Suspense>
          )}
        </div>
      </Card>
    </div>
  );
}
