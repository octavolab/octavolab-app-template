import type { Checkout, Health } from "./api";

/** Publishable keys are public by design (pk_...); only this one is read from the build environment. */
export const STRIPE_PUBLISHABLE_KEY: string = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) ?? "";

/**
 * Real card collection happens only with a real provider client secret AND a publishable key, outside fake mode.
 * Otherwise the UI shows a clearly labelled demo state and never asks for card data (rule N51).
 * The payments mode is `modes.payments` (per-integration, ADR 0005): staging runs INTEGRATIONS_MODE=fake with
 * PAYMENTS_MODE=sandbox. `mode` (the global default) is only a fallback for an API without `modes`.
 */
export function paymentMode(checkout: Pick<Checkout, "clientSecret">, health: Pick<Health, "mode" | "modes"> | null, publishableKey = STRIPE_PUBLISHABLE_KEY): "stripe" | "demo" {
  if (!health || (health.modes?.payments ?? health.mode) === "fake") return "demo";
  if (!publishableKey.startsWith("pk_")) return "demo";
  if (!checkout.clientSecret || !/^pi_[A-Za-z0-9]+_secret_/.test(checkout.clientSecret)) return "demo";
  return "stripe";
}
