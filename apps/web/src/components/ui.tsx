import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { ApiError } from "../lib/api";
import { useI18n, type MessageKey } from "../i18n";
import en from "../i18n/en.json";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 shadow-sm disabled:bg-ink-300 disabled:text-ink-700 dark:bg-brand-500 dark:hover:bg-brand-400 dark:text-ink-950 dark:disabled:bg-ink-700 dark:disabled:text-ink-300",
  secondary: "bg-white text-ink-900 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 dark:bg-ink-800 dark:text-ink-50 dark:ring-ink-700 dark:hover:bg-ink-700",
  ghost: "text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800",
  danger: "text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950",
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; size?: "sm" | "md" | "lg" }>(
  function Button({ variant = "primary", busy, size = "md", className, children, disabled, ...rest }, ref) {
    const sizes = { sm: "h-9 px-3 text-sm", md: "h-11 px-4 text-sm", lg: "h-12 px-5 text-base" };
    return (
      <button ref={ref} type="button" {...rest} disabled={disabled || busy} aria-busy={busy || undefined}
        className={cx("inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed", sizes[size], variants[variant], className)}>
        {busy && <Spinner />}
        {children}
      </button>
    );
  });

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent", className)} />;
}

export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string | undefined; error?: string | undefined; trailing?: ReactNode }>(
  function Field({ label, hint, error, trailing, className, id, ...rest }, ref) {
    const auto = useId();
    const inputId = id ?? auto;
    const describedBy = [hint && `${inputId}-hint`, error && `${inputId}-error`].filter(Boolean).join(" ") || undefined;
    return (
      <div className={className}>
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-ink-800 dark:text-ink-100">{label}</label>
        <div className="relative">
          <input ref={ref} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest}
            className={cx("block h-11 w-full rounded-xl border bg-white px-3.5 text-base text-ink-900 placeholder:text-ink-400 sm:text-sm",
              "dark:bg-ink-900 dark:text-ink-50", error ? "border-red-600 dark:border-red-400" : "border-ink-200 dark:border-ink-700", trailing ? "pr-12" : "")} />
          {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
        </div>
        {hint && !error && <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-ink-600 dark:text-ink-300">{hint}</p>}
        {error && <p id={`${inputId}-error`} className="mt-1.5 text-xs font-medium text-red-700 dark:text-red-300">{error}</p>}
      </div>
    );
  });

type CardProps = { children: ReactNode; className?: string; as?: "section" | "article" | "div" | "aside"; "aria-labelledby"?: string; "aria-label"?: string };
export const Card = forwardRef<HTMLElement, CardProps>(function Card({ children, className, as: As = "section", ...rest }, ref) {
  // Polymorphic element: the ref targets whichever HTMLElement `as` renders.
  return <As ref={ref as never} {...rest} className={cx("rounded-2xl bg-white shadow-[var(--shadow-card)] ring-1 ring-ink-200/70 dark:bg-ink-900 dark:ring-ink-800", className)}>{children}</As>;
});

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink-950 sm:text-3xl dark:text-white">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Maps an API error to a translated, human message. Unknown codes fall back to a generic message plus the request id. */
export function useErrorMessage() {
  const { t } = useI18n();
  return (err: unknown): string => {
    if (!(err instanceof ApiError)) return t("err_generic");
    if (err.code === "RATE_LIMITED") return err.retryAfterSeconds ? t("err_RATE_LIMITED_SECONDS", { seconds: err.retryAfterSeconds }) : t("err_RATE_LIMITED");
    const key = `err_${err.code}` as MessageKey;
    if (key in DICT_PROBE) return t(key);
    if (err.status === 400 || err.status === 422) return t("err_VALIDATION");
    return t("err_generic");
  };
}
// Keys known to the dictionaries (en is the reference; es is checked to have the same keys by a unit test).
const DICT_PROBE: Record<string, string> = en;

export function ErrorAlert({ error, onRetry, className }: { error: unknown; onRetry?: (() => void) | undefined; className?: string }) {
  const { t } = useI18n();
  const message = useErrorMessage()(error);
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div role="alert" className={cx("flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between dark:border-red-900 dark:bg-red-950/60 dark:text-red-100", className)}>
      <div>
        <p className="font-medium">{message}</p>
        {requestId && <p className="mt-0.5 text-xs text-red-800 dark:text-red-200">{t("requestId", { id: requestId })}</p>}
      </div>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>{t("retry")}</Button>}
    </div>
  );
}

export function Notice({ children, tone = "info", className }: { children: ReactNode; tone?: "info" | "success" | "warning"; className?: string }) {
  const tones = {
    info: "border-brand-200 bg-brand-50 text-brand-900 dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-100",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100",
    warning: "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100",
  };
  return <div role="status" className={cx("rounded-xl border p-4 text-sm", tones[tone], className)}>{children}</div>;
}

export function EmptyState({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-ink-300 px-6 py-14 text-center dark:border-ink-700">
      <div className="grid size-14 place-items-center rounded-2xl bg-brand-50 text-brand-700 dark:bg-brand-900/50 dark:text-brand-200" aria-hidden="true">{icon}</div>
      <p className="max-w-sm text-sm text-ink-700 dark:text-ink-200">{title}</p>
      {action}
    </div>
  );
}

export function SkeletonGrid({ count = 6, label }: { count?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-44 animate-pulse rounded-2xl bg-ink-100 dark:bg-ink-800" />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** Minimal inline icons (stroke = currentColor), so no icon font or extra dependency is needed. */
export function Icon({ name, className = "size-5" }: { name: "cart" | "box" | "receipt" | "shield" | "tag" | "plus" | "minus" | "x" | "check" | "lock" | "eye" | "eyeOff" | "logout" | "globe" | "download" | "copy" | "spark"; className?: string }) {
  const paths: Record<typeof name, ReactNode> = {
    cart: <><path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 8H6" /><circle cx="10" cy="20" r="1.4" /><circle cx="17" cy="20" r="1.4" /></>,
    box: <><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="m3 8 9 5 9-5M12 13v8" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6" /></>,
    shield: <><path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    tag: <><path d="M3 12V4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="7.5" r="1.2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    minus: <path d="M5 12h14" />,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    eyeOff: <><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.1 6.2A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.3-1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
    logout: <><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" /></>,
    download: <><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
    spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className}>{paths[name]}</svg>;
}
