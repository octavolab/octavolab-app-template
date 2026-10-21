export * from "./contracts.js";
import type { PaymentGateway, CarrierRates, MessagingProvider } from "./contracts.js";
import { FakePayments, FakeCarrier, FakeMessaging } from "./fake.js";
import { StripeGateway } from "./stripe.js";

const mode = process.env.INTEGRATIONS_MODE ?? "fake";
export function getPayments(): PaymentGateway {
  if (mode === "fake") return new FakePayments();
  if (process.env.PAYMENTS_PROVIDER === "stripe") return new StripeGateway(mode === "live");
  throw new Error(`no payment adapter for provider=${process.env.PAYMENTS_PROVIDER} in mode=${mode}`);
}
export function getCarrier(): CarrierRates { if (mode === "fake") return new FakeCarrier(); throw new Error(`no carrier adapter in mode=${mode}`); }
export function getMessaging(): MessagingProvider { if (mode === "fake") return new FakeMessaging(); throw new Error(`no messaging adapter in mode=${mode}`); }
