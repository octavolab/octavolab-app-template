/**
 * Money arrives from the API as an integer in the currency's minor unit plus an ISO 4217 code (CLAUDE.md: never floats).
 * The exponent follows ISO 4217 as payment providers apply it (Stripe treats COP, MXN, BRL as two-decimal currencies),
 * so the UI never disagrees with the amount that is charged.
 */
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

export function currencyExponent(currency: string): number {
  const c = currency.toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Formats minor units with Intl, e.g. (1500, "GBP", "en") -> "£15.00". Throws on non-integer input: that is a bug upstream. */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError("amount must be an integer in minor units");
  const exp = currencyExponent(currency);
  // Division by a power of ten yields the closest double; Intl then rounds to exactly `exp` digits, so no drift is visible.
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: exp, maximumFractionDigits: exp })
    .format(amountMinor / 10 ** exp);
}

/**
 * Parses a price typed by staff in major units ("15", "15.5", "15,50") into minor units without floating point.
 * Returns null when the text is not a valid positive amount for the currency.
 */
export function parseMajorToMinor(input: string, currency: string): number | null {
  const exp = currencyExponent(currency);
  const s = input.trim().replace(/\s/g, "");
  const m = /^(\d{1,12})(?:[.,](\d+))?$/.exec(s);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > exp) return null;
  const minor = Number(whole) * 10 ** exp + Number(frac.padEnd(exp, "0") || "0");
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Major-unit string for an edit field, e.g. (1500, "GBP") -> "15.00". */
export function minorToMajorInput(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency);
  if (exp === 0) return String(amountMinor);
  const s = String(Math.abs(amountMinor)).padStart(exp + 1, "0");
  return `${amountMinor < 0 ? "-" : ""}${s.slice(0, -exp)}.${s.slice(-exp)}`;
}
