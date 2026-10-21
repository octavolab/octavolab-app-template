import { MessagingError } from "./contracts.js";

/** Rendered message. Templates are code (reviewed, versioned); data values are escaped and never become headers raw. */
export type Rendered = { subject: string; text: string; html: string };
type Template = (data: Record<string, unknown>) => { subject: string; lines: string[] };

const TEMPLATES: Readonly<Record<string, Template>> = {
  order_created: (d) => ({ subject: `Order ${field(d.orderId)} created`, lines: [`Order ${field(d.orderId)} was created.`] }),
  order_paid: (d) => ({ subject: `Order ${field(d.orderId)} paid`, lines: [`Order ${field(d.orderId)} was paid.`] }),
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** One-line, bounded representation of a data value (no CR/LF, so it cannot inject headers or fake lines). */
function field(v: unknown): string {
  const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
  return s.replace(/[\r\n\t]+/g, " ").slice(0, 120) || "(unknown)";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderTemplate(name: string, data: Record<string, unknown>): Rendered {
  const t = Object.prototype.hasOwnProperty.call(TEMPLATES, name) ? TEMPLATES[name] : undefined;
  if (!t) throw new MessagingError(`unknown template ${field(name).slice(0, 40)}`, "unknown_template", false);
  const { subject, lines } = t(data);
  return {
    subject,
    text: lines.join("\n"),
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</body></html>`,
  };
}
