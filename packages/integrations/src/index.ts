export * from "./contracts.js";
import type { PaymentGateway, CarrierRates, MessagingProvider } from "./contracts.js";
import { FakePayments, FakeCarrier, FakeMessaging } from "./fake.js";
import { StripeGateway } from "./stripe.js";

const mode = process.env.INTEGRATIONS_MODE ?? "fake";
export function getPayments(): PaymentGateway {
  if (mode === "fake") return new FakePayments();
  if (process.env.PAYMENTS_PROVIDER === "stripe") return new StripeGateway(mode === "live");
  return new FakePayments();
}
export function getCarrier(): CarrierRates { return new FakeCarrier(); }
export function getMessaging(): MessagingProvider { return new FakeMessaging(); }
