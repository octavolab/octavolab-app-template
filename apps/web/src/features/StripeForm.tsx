import { useMemo, useState, type FormEvent } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { STRIPE_PUBLISHABLE_KEY } from "../lib/payments";
import { useI18n } from "../i18n";
import { Button, Icon, Notice } from "../components/ui";

// One Stripe instance per page load (Stripe's guidance); created lazily, the first time a real payment form mounts.
let stripePromise: Promise<Stripe | null> | null = null;
const getStripe = () => (stripePromise ??= loadStripe(STRIPE_PUBLISHABLE_KEY));

export default function StripeForm({ clientSecret, amountLabel, onDone }: { clientSecret: string; amountLabel: string; onDone: () => void }) {
  const { lang } = useI18n();
  const options = useMemo(() => ({ clientSecret, locale: lang, appearance: { theme: "stripe" as const, variables: { colorPrimary: "#4731bf", borderRadius: "12px" } } }), [clientSecret, lang]);
  return (
    <Elements stripe={getStripe()} options={options} key={lang}>
      <Inner amountLabel={amountLabel} onDone={onDone} />
    </Elements>
  );
}

function Inner({ amountLabel, onDone }: { amountLabel: string; onDone: () => void }) {
  const { t } = useI18n();
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true); setMessage(null);
    // Card data goes from Stripe's iframe straight to Stripe; this page never sees it. 3-D Secure may redirect back to My orders.
    const { error } = await stripe.confirmPayment({ elements, confirmParams: { return_url: `${window.location.origin}/#/orders` }, redirect: "if_required" });
    setBusy(false);
    if (error) setMessage(error.message ?? t("err_generic"));
    else setDone(true);
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="success">{t("paymentSubmitted")}</Notice>
        <Button size="lg" className="w-full" onClick={onDone}>{t("demoPaymentDone")}</Button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-5">
      <PaymentElement onLoadError={() => setMessage(t("stripeLoadError"))} />
      {message && <p role="alert" className="text-sm font-medium text-red-700 dark:text-red-300">{message}</p>}
      <Button type="submit" size="lg" className="w-full" busy={busy} disabled={!stripe || !elements}>
        <Icon name="lock" className="size-4" />{busy ? t("stripePaying") : t("stripePay", { amount: amountLabel })}
      </Button>
      <p className="flex items-start gap-2 text-xs text-ink-600 dark:text-ink-300"><Icon name="shield" className="mt-0.5 size-4 shrink-0" />{t("stripeSecure")}</p>
    </form>
  );
}
