/**
 * Same-origin API client: every call goes to /api (vite proxies it in dev and preview; the API serves the built web in
 * production), with the httpOnly session cookie. No token is ever readable by JavaScript.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const API_BASE = "/api/v1";

type Options = { method?: "GET" | "POST" | "PUT" | "PATCH"; body?: unknown; idempotencyKey?: string; signal?: AbortSignal };

export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path.startsWith("/api") ? path : `${API_BASE}${path}`, {
      method: opts.method ?? "GET",
      headers,
      credentials: "same-origin",
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "Network error");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const body = (data ?? {}) as { code?: string; message?: string; requestId?: string };
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, res.status === 429 ? "RATE_LIMITED" : (body.code ?? `HTTP_${res.status}`), body.message ?? res.statusText,
      body.requestId ?? res.headers.get("x-request-id") ?? undefined, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return data as T;
}

// ---- Shapes returned by the API (docs/openapi.json, apps/api/src/routes) ----
export type Role = "owner" | "admin" | "operations" | "customer";
type Mode = "fake" | "sandbox" | "live";
/** `mode` is INTEGRATIONS_MODE (the default); `modes` is what each integration actually runs (ADR 0005). */
export type Health = { ok: boolean; version: string; mode: Mode; modes?: { payments: Mode; messaging: Mode; carrier: Mode; storage: Mode }; deps?: Record<string, string> };
export type LoginResponse = { mfaRequired: true } | { id: string; email: string; role: Role; mfaEnrollmentRequired?: boolean; recoveryCodesRemaining?: number };
export type Me = { id: string; role: Role; tenantId: string | null; mfaEnabled: boolean; mfaEnrollmentRequired: boolean };
export type Product = { id: string; sku: string; name: string; unitAmount: number; currency: string; active: boolean; createdAt: string; updatedAt: string };
export type OrderStatus = "draft" | "confirmed" | "pending_payment" | "paid" | "shipped" | "delivered" | "closed" | "cancelled" | "refunded";
export type OrderItem = { id: string; sku: string; qty: number; unitAmount: number };
export type Order = { id: string; currency: string; totalAmount: number; status: OrderStatus; createdAt: string; updatedAt: string; items: OrderItem[] };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type Checkout = { orderId: string; status: "pending_payment"; paymentIntentId: string; amount: number; currency: string; clientSecret?: string };
export type Enrollment = { otpauthUri: string; secret: string; issuer: string; algorithm: string; digits: number; periodSeconds: number };
