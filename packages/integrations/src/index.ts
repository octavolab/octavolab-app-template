export * from "./contracts.js";
import type { PaymentGateway, CarrierRates, MessagingProvider } from "./contracts.js";
import { FakePayments, FakeCarrier, FakeMessaging } from "./fake.js";
import { StripeGateway } from "./stripe.js";
import { ResendMessaging } from "./resend.js";
export { ResendMessaging, RESEND_SANDBOX_RECIPIENT, mapError as mapResendError } from "./resend.js";
export { renderTemplate, TEMPLATE_NAMES } from "./templates.js";

// Production must choose a mode explicitly (the API env schema enforces it too); only dev and test default to fake.
if (process.env.NODE_ENV === "production" && !process.env.INTEGRATIONS_MODE) throw new Error("INTEGRATIONS_MODE must be set explicitly in production");
const mode = process.env.INTEGRATIONS_MODE ?? "fake";
export function getPayments(): PaymentGateway {
  if (mode === "fake") return new FakePayments();
  if (process.env.PAYMENTS_PROVIDER === "stripe") return new StripeGateway(mode === "live");
  throw new Error(`no payment adapter for provider=${process.env.PAYMENTS_PROVIDER} in mode=${mode}`);
}
export function getCarrier(): CarrierRates { if (mode === "fake") return new FakeCarrier(); throw new Error(`no carrier adapter in mode=${mode}`); }
/** Fake by default; Resend when MESSAGING_PROVIDER=resend in sandbox (test inbox only) or live mode. */
export function getMessaging(): MessagingProvider {
  if (mode === "fake") return new FakeMessaging();
  if (process.env.MESSAGING_PROVIDER === "resend") return new ResendMessaging({ sandbox: mode !== "live" });
  throw new Error(`no messaging adapter for provider=${process.env.MESSAGING_PROVIDER ?? "fake"} in mode=${mode}`);
}
