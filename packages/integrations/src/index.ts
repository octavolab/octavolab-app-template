export * from "./contracts.js";
import type { PaymentGateway, CarrierRates, MessagingProvider, StorageProvider } from "./contracts.js";
import { FakePayments, FakeCarrier, FakeMessaging } from "./fake.js";
import { StripeGateway } from "./stripe.js";
import { ResendMessaging } from "./resend.js";
import { OesCarrier } from "./oes.js";
import { FakeStorage, S3Storage } from "./storage.js";
import { assertIntegrationEnv, messagingAllowList, messagingFrom, resolveModes, resolveMode, MODE_VARS, INTEGRATIONS, type ResolvedModes } from "./config.js";
export { ResendMessaging, RESEND_SANDBOX_RECIPIENT, mapError as mapResendError } from "./resend.js";
export { StripeGateway, mapStripeError } from "./stripe.js";
export { OesCarrier, mapOesError, OES_MAX_TIMEOUT_MS } from "./oes.js";
export { FakeStorage, S3Storage, tenantKey, assertTenantKey, presignTenantUpload, UPLOAD_TYPES, MAX_PRESIGN_SECONDS, DEFAULT_MAX_UPLOAD_BYTES } from "./storage.js";
export { CircuitBreaker, retryWithJitter, backoffDelay } from "./resilience.js";
export {
  validateIntegrationEnv, assertIntegrationEnv, resolveModes, resolveMode, messagingFrom, messagingAllowList, stripeKeyMatchesMode,
  INTEGRATIONS, INTEGRATION_MODES, MODE_VARS, PROVIDERS, STAGING_MESSAGING_FROM, DEFAULT_S3_REGION,
  type IntegrationMode, type IntegrationName, type ResolvedModes, type ConfigIssue, type EnvSource,
} from "./config.js";
export { renderTemplate, TEMPLATE_NAMES } from "./templates.js";

// Production must resolve every integration's mode explicitly (the API env schema enforces it too, with all other rules);
// only dev and test default to fake. Failing here, at import, keeps a misconfigured worker from ever starting.
if (process.env.NODE_ENV === "production") {
  for (const name of INTEGRATIONS) {
    if (!resolveMode(process.env, name)) throw new Error(`${MODE_VARS[name]} (or INTEGRATIONS_MODE) must be set explicitly in production`);
  }
}

/** Current modes (read from the environment at call time). */
export function integrationModes(): ResolvedModes {
  return resolveModes(process.env);
}

// Adapters with state worth keeping (circuit breaker, S3 connection pool) are cached per configuration.
const cache = new Map<string, unknown>();
function cached<T>(key: string, build: () => T): T {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key) as T;
}
const envKey = (...vars: string[]) => vars.map((v) => process.env[v] ?? "").join("\u0000");

/** Fake in fake mode; Stripe in sandbox (test key) or live (live key + ALLOW_LIVE). */
export function getPayments(): PaymentGateway {
  assertIntegrationEnv(process.env);
  const mode = integrationModes().payments;
  if (mode === "fake") return new FakePayments();
  return new StripeGateway({ mode });
}

/** Fake in fake mode; OES in sandbox or live. Cached so the circuit breaker sees every call of the process. */
export function getCarrier(): CarrierRates {
  assertIntegrationEnv(process.env);
  const mode = integrationModes().carrier;
  if (mode === "fake") return new FakeCarrier();
  return cached(`oes\u0000${mode}\u0000${envKey("OES_API_URL", "OES_API_KEY", "OES_QUOTE_PATH")}`, () => new OesCarrier());
}

/** Fake in fake mode; Resend in sandbox (test inbox + MESSAGING_ALLOW_LIST) or live. */
export function getMessaging(): MessagingProvider {
  assertIntegrationEnv(process.env);
  const mode = integrationModes().messaging;
  if (mode === "fake") return new FakeMessaging();
  return new ResendMessaging({ sandbox: mode !== "live", from: messagingFrom(process.env), allowList: messagingAllowList(process.env) });
}

const fakeStorage = new FakeStorage();
/** In-memory in fake mode (one store per process); the private Lightsail bucket (S3 API) in sandbox or live. */
export function getStorage(): StorageProvider {
  assertIntegrationEnv(process.env);
  const mode = integrationModes().storage;
  if (mode === "fake") return fakeStorage;
  return cached(`s3\u0000${envKey("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_REGION")}`, () => new S3Storage());
}
