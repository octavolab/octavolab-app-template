/**
 * The one definition of INTEGRATIONS_MODE, shared by the API env schema and the adapter factories so the API, the worker
 * and the integrations package can never disagree about the mode.
 *
 * - `fake`: in-process adapters, nothing leaves the process (local dev, CI, demos, staging today).
 * - `test`: real providers with TEST credentials (Stripe test mode, Resend test inbox).
 * - `live`: real money and real messages. Only with production keys loaded by Jaime (CLAUDE.md, N07).
 *
 * Input is trimmed and case-insensitive (`FAKE`, ` Test ` are accepted). `sandbox` is the previous name of `test` and is
 * still accepted as a deprecated alias so an existing environment keeps booting; it is reported as `test`.
 */
export const INTEGRATION_MODES = ["fake", "test", "live"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];
const ALIASES: Readonly<Record<string, IntegrationMode>> = { sandbox: "test" };

/** Canonical mode, or undefined when the value is not a mode (callers fail fast on undefined). */
export function normalizeIntegrationsMode(raw: string | undefined): IntegrationMode | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if ((INTEGRATION_MODES as readonly string[]).includes(v)) return v as IntegrationMode;
  return Object.prototype.hasOwnProperty.call(ALIASES, v) ? ALIASES[v] : undefined; // never "__proto__" & co.
}

/**
 * Mode from an environment: explicit value (normalized), else `fake` outside production. Throws (naming the variable,
 * never echoing an unknown value) when the value is invalid, or missing in production.
 */
export function integrationsModeFrom(env: Readonly<Record<string, string | undefined>>): IntegrationMode {
  const raw = env.INTEGRATIONS_MODE;
  if (raw === undefined || raw.trim() === "") {
    if (env.NODE_ENV === "production") throw new Error("INTEGRATIONS_MODE must be set explicitly in production (fake | test | live)");
    return "fake";
  }
  const mode = normalizeIntegrationsMode(raw);
  if (!mode) throw new Error("INTEGRATIONS_MODE must be one of fake | test | live (case-insensitive)");
  return mode;
}
