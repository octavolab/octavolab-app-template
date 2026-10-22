import type { OrderStatus } from "../lib/api";
import { useI18n } from "../i18n";
import { cx } from "./ui";

// Text colours meet WCAG AA (4.5:1) on their tinted backgrounds in both themes.
const tone: Record<OrderStatus, string> = {
  draft: "bg-ink-100 text-ink-700 ring-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:ring-ink-700",
  confirmed: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-900",
  pending_payment: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900",
  paid: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900",
  shipped: "bg-brand-50 text-brand-800 ring-brand-200 dark:bg-brand-900/60 dark:text-brand-100 dark:ring-brand-800",
  delivered: "bg-teal-50 text-teal-800 ring-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-900",
  closed: "bg-ink-100 text-ink-700 ring-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:ring-ink-700",
  cancelled: "bg-red-50 text-red-800 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900",
  refunded: "bg-fuchsia-50 text-fuchsia-800 ring-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:ring-fuchsia-900",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useI18n();
  return (
    <span data-status={status} className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", tone[status] ?? tone.draft)}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {t(`status_${status}`)}
    </span>
  );
}
