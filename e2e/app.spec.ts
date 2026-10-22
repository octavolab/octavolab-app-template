import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Full customer and staff flows against the real API with a seeded database (CI: INTEGRATIONS_MODE=fake), at every
 * width in playwright.config.ts (390, 768, 1024, 1440), with axe on each screen.
 *
 * Accounts come from the seed (packages/db/prisma/seed.ts). Passwords are never committed: CI passes them as env vars.
 *   Customer: E2E_CUSTOMER_EMAIL (default customer@example.com), E2E_CUSTOMER_PASSWORD (default SEED_CUSTOMER_PASSWORD)
 *   Staff:    E2E_STAFF_EMAIL (default admin@example.com),       E2E_STAFF_PASSWORD (default SEED_ADMIN_PASSWORD)
 * The staff test needs TOTP_ENC_KEY on the API (otherwise 2FA enrollment answers 503 MFA_NOT_CONFIGURED).
 * Login allows 5 attempts per minute per (email, IP): each project signs in once per role, so 4 projects stay under it.
 */
const customer = { email: process.env.E2E_CUSTOMER_EMAIL ?? "customer@example.com", password: process.env.E2E_CUSTOMER_PASSWORD ?? process.env.SEED_CUSTOMER_PASSWORD ?? "" };
const staff = { email: process.env.E2E_STAFF_EMAIL ?? "admin@example.com", password: process.env.E2E_STAFF_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? "" };

test.use({ locale: "en-US" });

async function expectAccessible(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${where}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow, `${where}: horizontal overflow`).toBe(false);
}

async function signIn(page: Page, who: { email: string; password: string }) {
  expect(who.password, `password for ${who.email} missing: set the E2E_* / SEED_* env vars (see the header of this file)`).not.toBe("");
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password", { exact: true }).fill(who.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("login screen: language switch, validation state and accessibility", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expectAccessible(page, "login");
  await page.getByRole("button", { name: "Español" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Iniciar sesión" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
});

test("wrong password shows a clear error", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill("nobody@example.com");
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/Email or password is incorrect|Too many attempts/);
});

test("customer: login, catalog, cart, checkout (demo payment), order in My orders", async ({ page }) => {
  await signIn(page, customer);

  // Catalog from GET /api/v1/products with prices formatted from minor units.
  await expect(page.getByRole("heading", { level: 1, name: "Catalog" })).toBeVisible();
  const addButtons = page.getByRole("button", { name: /^Add to cart\b/ }) // flex children are blockified, so the name is "Add to cart : <product>";
  await expect(addButtons.first()).toBeVisible();
  await expectAccessible(page, "catalog");

  await addButtons.first().click();
  const increase = page.getByRole("button", { name: /^Increase quantity of / }).first();
  await increase.click();
  const total = page.getByTestId("cart-total");
  await expect(total).toHaveText(/\d/);
  const totalText = (await total.textContent())!.trim();

  // POST /me/orders (Idempotency-Key) then POST /me/orders/:id/checkout; fake mode shows the labelled demo payment.
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/me/orders") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Place order and pay" }).click();
  const orderRes = await created;
  expect(orderRes.status()).toBe(201);
  expect(orderRes.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  const order = (await orderRes.json()) as { id: string; status: string };

  await expect(page.getByRole("heading", { level: 1, name: "Payment" })).toBeVisible();
  await expect(page.getByTestId("demo-payment")).toBeVisible();
  await expect(page.getByText("Demo, no real charge")).toBeVisible();
  await expect(page.getByTestId("payment-amount")).toHaveText(totalText);
  // N51: no card field is ever rendered in demo mode.
  await expect(page.locator('iframe[name^="__privateStripeFrame"]')).toHaveCount(0);
  await expectAccessible(page, "payment");

  await page.getByRole("button", { name: "Go to my orders" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "My orders" })).toBeVisible();
  const shortId = `#${order.id.slice(-8).toUpperCase()}`;
  const row = page.getByRole("article").filter({ has: page.getByTestId("order-id").filter({ hasText: shortId }) });
  await expect(row).toBeVisible();
  await expect(row.getByText("Awaiting payment")).toBeVisible();
  await expect(row.getByText(totalText)).toBeVisible();
  await row.getByRole("button", { name: "Show items" }).click();
  await expect(row.getByRole("button", { name: "Hide items" })).toHaveAttribute("aria-expanded", "true");
  await expectAccessible(page, "orders");

  // Session survives a reload (httpOnly cookie) and the hash route is restored.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "My orders" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});

test("staff: products list and 2FA enrollment shows the QR and the confirm step", async ({ page }) => {
  await signIn(page, staff);
  // Owners land on Products, or on Security when REQUIRE_OWNER_2FA forces enrollment first.
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveText(/^(Products|Two-step verification)$/);
  if ((await h1.textContent()) === "Products") {
    // GET /api/v1/products (staff also see inactive products); create/edit is the PUT /products/:sku upsert.
    await expect(page.getByRole("table")).toBeVisible();
    await expectAccessible(page, "products");
    await page.getByRole("button", { name: "New product" }).click();
    const dialog = page.getByRole("dialog", { name: "New product" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Enter a name.")).toBeVisible(); // client validation before any request
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }

  await page.getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Two-step verification" })).toBeVisible();
  // Only enrollment is opened (never activated), so the account stays password-only and the test can repeat.
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  await expect(page.getByRole("img", { name: /QR code to add .+ to your authenticator app/ })).toBeVisible();
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeDisabled();
  await expectAccessible(page, "2fa-enrollment");
});
