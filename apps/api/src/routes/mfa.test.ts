import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import argon2 from "argon2";
import { db } from "../test-support/prisma-stand-in.js";
import { base32Decode, hotp, timeStep } from "../lib/totp.js";

// Environment must be set before the app (and its env schema) is imported.
const TOTP_KEY = Buffer.alloc(32, 3).toString("base64");
Object.assign(process.env, {
  NODE_ENV: "test", DATABASE_URL: "postgresql://x:y@localhost:5432/z", SESSION_SECRET: "s".repeat(40), APP_URL: "http://localhost:5173", OPS_EMAIL: "ops@test.invalid", RATE_LIMIT_MAX: "1000",
  INTEGRATIONS_MODE: "fake", TOTP_ENC_KEY: TOTP_KEY, TOTP_ISSUER: "OctavoLab Test",
});
delete process.env.REDIS_URL;

vi.mock("@octavolab/db", async () => (await import("../test-support/prisma-stand-in.js")).dbModule);

// Freeze the clock in the middle of a 30-second step so TOTP steps are deterministic (only Date is faked; timers run).
const NOW = 1_790_000_025_000;
const STEP = timeStep(NOW);
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => { vi.useRealTimers(); });

type App = Awaited<ReturnType<typeof import("../app.js")["buildApp"]>>;
let app: App;
let env: typeof import("../config/env.js")["env"];
const PW = "staff-password-1";
let ipSeq = 0;
const nextIp = () => `10.8.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const cookies = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers["set-cookie"];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
  return Object.fromEntries(list.map((c) => { const [kv] = c.split(";"); const i = kv!.indexOf("="); return [kv!.slice(0, i), kv!.slice(i + 1)]; }));
};
const password = (email: string, pw = PW, ip = nextIp()) => app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": ip }, payload: { email, password: pw } });
const second = (mfa: string | undefined, body: object, ip = nextIp()) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login/mfa", headers: { "x-forwarded-for": ip, ...(mfa ? { cookie: `mfa=${mfa}` } : {}) }, payload: body });
const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, sid: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: `sid=${sid}`, "x-forwarded-for": nextIp() }, ...(payload ? { payload } : {}) });
const sidOf = async (email: string) => cookies(await password(email)).sid!;
const codeAt = (secretB32: string, step: number) => hotp(base32Decode(secretB32), step);

/** Enrolls and activates 2FA for a signed-in user with the code of `step`; returns the secret, recovery codes and new sid. */
async function enable(sid: string, step = STEP - 1) {
  const enrolled = await call("POST", "/api/v1/auth/2fa/enroll", sid);
  expect(enrolled.statusCode).toBe(200);
  const { secret } = enrolled.json();
  const act = await call("POST", "/api/v1/auth/2fa/activate", sid, { code: codeAt(secret, step) });
  expect(act.statusCode).toBe(200);
  return { secret: secret as string, recoveryCodes: act.json().recoveryCodes as string[], sid: cookies(act).sid! };
}

beforeAll(async () => {
  const hash = await argon2.hash(PW);
  const u = (id: string, email: string, role: string, tenantId: string | null) => ({ id, email, role, tenantId, sessionVersion: 0, passwordHash: hash, totpSecret: null, totpEnabledAt: null, totpLastStep: null });
  db.users.push(
    u("m-owner", "owner@m.co", "owner", "tM"), u("m-admin", "admin@m.co", "admin", "tM"), u("m-ops", "ops@m.co", "operations", "tM"),
    u("m-cust", "cust@m.co", "customer", "tM"), u("m-other", "other@n.co", "admin", "tN"), u("m-plain", "plain@m.co", "admin", "tM"),
  );
  app = await (await import("../app.js")).buildApp();
  ({ env } = await import("../config/env.js"));
});

describe("2FA enrollment and activation", () => {
  let admin: { secret: string; recoveryCodes: string[]; sid: string };

  it("customers cannot enroll (staff and owner only)", async () => {
    const r = await call("POST", "/api/v1/auth/2fa/enroll", await sidOf("cust@m.co"));
    expect([r.statusCode, r.json().code]).toEqual([403, "FORBIDDEN"]);
  });

  it("enroll returns the otpauth URI and secret once (no-store) and stores only AES-GCM ciphertext", async () => {
    const sid = await sidOf("admin@m.co");
    const r = await call("POST", "/api/v1/auth/2fa/enroll", sid);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const body = r.json();
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\/OctavoLab%20Test:admin%40m\.co\?secret=[A-Z2-7]{32}&issuer=OctavoLab\+Test&algorithm=SHA1&digits=6&period=30$/);
    expect(base32Decode(body.secret).length).toBe(20);
    const row = db.users.find((x) => x.id === "m-admin");
    expect(row.totpSecret).toMatch(/^v1\./);
    expect(row.totpSecret).not.toContain(body.secret);
    expect(row.totpEnabledAt).toBeNull();
    expect(db.audit.some((a) => a.action === "mfa_enroll_started" && a.entityId === "m-admin")).toBe(true);
    // Not enabled yet: password-only login still works and nothing asks for a code.
    expect((await password("admin@m.co")).json().mfaRequired).toBeUndefined();
  });

  it("activation needs a valid code, issues 10 hashed recovery codes and revokes the user's other sessions", async () => {
    const other = await sidOf("admin@m.co");
    const sid = await sidOf("admin@m.co");
    const { secret } = (await call("POST", "/api/v1/auth/2fa/enroll", sid)).json(); // restart replaces the pending secret
    const wrong = await call("POST", "/api/v1/auth/2fa/activate", sid, { code: codeAt(secret, STEP + 5) });
    expect([wrong.statusCode, wrong.json().code]).toEqual([422, "MFA_INVALID_CODE"]);
    expect(db.audit.some((a) => a.action === "mfa_failed" && a.entityId === "m-admin" && a.after.stage === "activate")).toBe(true);

    const ok = await call("POST", "/api/v1/auth/2fa/activate", sid, { code: codeAt(secret, STEP - 1) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const codes: string[] = ok.json().recoveryCodes;
    expect(codes.length).toBe(10);
    const stored = db.recoveryCodes.filter((c) => c.userId === "m-admin");
    expect(stored.length).toBe(10);
    expect(stored.every((c) => /^[0-9a-f]{64}$/.test(c.codeHash) && !codes.some((p) => c.codeHash.includes(p.replace("-", ""))))).toBe(true);
    expect(db.audit.some((a) => a.action === "mfa_enabled" && a.entityId === "m-admin")).toBe(true);

    expect((await call("GET", "/api/v1/auth/me", other)).statusCode).toBe(401); // other device: revoked
    expect((await call("GET", "/api/v1/auth/me", sid)).statusCode).toBe(401); // the old cookie of this device too
    const me = await call("GET", "/api/v1/auth/me", cookies(ok).sid!); // the re-issued cookie works
    expect(me.json()).toMatchObject({ id: "m-admin", mfaEnabled: true, mfaEnrollmentRequired: false });
    expect((await call("POST", "/api/v1/auth/2fa/enroll", cookies(ok).sid!)).statusCode).toBe(409); // already enabled
    admin = { secret, recoveryCodes: codes, sid: cookies(ok).sid! };
  });

  it("does not reveal 2FA before the password is correct", async () => {
    const wrong = await password("admin@m.co", "wrong-password-9");
    const plainWrong = await password("plain@m.co", "wrong-password-9");
    expect([wrong.statusCode, wrong.json()]).toEqual([plainWrong.statusCode, { ...plainWrong.json(), requestId: wrong.json().requestId }]);
    expect(cookies(wrong).mfa).toBeUndefined();
  });

  it("a correct password returns mfaRequired with only the short-lived mfa cookie, never a session", async () => {
    const r = await password("admin@m.co");
    expect([r.statusCode, r.json()]).toEqual([200, { mfaRequired: true }]);
    const c = cookies(r);
    expect(c.mfa).toBeTruthy();
    expect(c.sid ?? "").toBe(""); // cleared, not set
    const raw = ([] as string[]).concat(r.headers["set-cookie"] as string[]).find((x) => x.startsWith("mfa="))!;
    expect(raw).toMatch(/Path=\/api\/v1\/auth/); expect(raw).toMatch(/HttpOnly/); expect(raw).toMatch(/SameSite=Strict/); expect(raw).toMatch(/Max-Age=300/);
    expect((await call("GET", "/api/v1/auth/me", c.mfa!)).statusCode).toBe(401); // the mfa token is not a session
    expect(db.audit.some((a) => a.action === "login_mfa_challenge" && a.entityId === "m-admin")).toBe(true);
  });

  it("second step: wrong code 401 and audited; right code signs in; the same code cannot be replayed", async () => {
    const mfa = cookies(await password("admin@m.co")).mfa;
    expect((await second(undefined, { code: "123456" })).json().code).toBe("MFA_CHALLENGE_INVALID");
    const bad = await second(mfa, { code: codeAt(admin.secret, STEP + 4) });
    expect([bad.statusCode, bad.json().code]).toEqual([401, "MFA_INVALID_CODE"]);
    expect(db.audit.some((a) => a.action === "mfa_failed" && a.entityId === "m-admin" && a.after.stage === "login")).toBe(true);
    expect((await second(mfa, { code: "12345" })).statusCode).toBe(400);
    expect((await second(mfa, { code: "123456", recoveryCode: "ABCDE-FGHJK" })).statusCode).toBe(400);

    const ok = await second(mfa, { code: codeAt(admin.secret, STEP) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: "m-admin", role: "admin" });
    expect(cookies(ok).sid).toBeTruthy();
    expect((await call("GET", "/api/v1/auth/me", cookies(ok).sid!)).statusCode).toBe(200);
    expect(db.audit.some((a) => a.action === "login" && a.entityId === "m-admin" && a.after.method === "password+totp")).toBe(true);

    const again = cookies(await password("admin@m.co")).mfa;
    expect((await second(again, { code: codeAt(admin.secret, STEP) })).json().code).toBe("MFA_INVALID_CODE"); // replay
    expect((await second(again, { code: codeAt(admin.secret, STEP - 1) })).json().code).toBe("MFA_INVALID_CODE"); // older step
  });

  it("a recovery code signs in once, in any case or spacing, and reports how many remain", async () => {
    const code = admin.recoveryCodes[0]!;
    const ok = await second(cookies(await password("admin@m.co")).mfa, { recoveryCode: ` ${code.toLowerCase()} ` });
    expect([ok.statusCode, ok.json().recoveryCodesRemaining]).toEqual([200, 9]);
    expect(db.audit.some((a) => a.action === "login" && a.entityId === "m-admin" && a.after.method === "password+recovery_code")).toBe(true);
    const reuse = await second(cookies(await password("admin@m.co")).mfa, { recoveryCode: code });
    expect(reuse.json().code).toBe("MFA_INVALID_CODE");
  });

  it("an mfa cookie stops working when the user's sessions are revoked in between", async () => {
    const mfa = cookies(await password("admin@m.co")).mfa;
    db.users.find((x) => x.id === "m-admin").sessionVersion += 1; // e.g. a role change or logout elsewhere
    expect((await second(mfa, { code: codeAt(admin.secret, STEP + 1) })).json().code).toBe("MFA_CHALLENGE_INVALID");
  });

  it("rate-limits second-factor attempts per user (429 even for a correct code once over the limit)", async () => {
    const mfa = cookies(await password("admin@m.co")).mfa;
    const ip = "10.99.0.1";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await second(mfa, { code: "000000" }, ip)).statusCode);
    expect(codes.every((c) => c === 401)).toBe(true);
    const blocked = await second(mfa, { code: codeAt(admin.secret, STEP + 1) }, ip);
    expect([blocked.statusCode, blocked.json().code]).toEqual([429, "RATE_LIMITED"]);
  });

  it("regenerating recovery codes needs a TOTP code and invalidates the old codes", async () => {
    const fresh = await second(cookies(await password("admin@m.co")).mfa, { code: codeAt(admin.secret, STEP + 1) }, "10.98.0.1");
    expect(fresh.statusCode).toBe(200);
    const sid = cookies(fresh).sid!;
    expect((await call("POST", "/api/v1/auth/2fa/recovery-codes", sid, { code: "000000" })).statusCode).toBe(422);
    // STEP + 1 was just used: wait one step (the clock is frozen, so move it) and use the next code.
    vi.setSystemTime(NOW + 30_000);
    const r = await call("POST", "/api/v1/auth/2fa/recovery-codes", sid, { code: codeAt(admin.secret, STEP + 2) });
    vi.setSystemTime(NOW);
    expect(r.statusCode).toBe(200);
    expect(r.json().recoveryCodes.length).toBe(10);
    expect(db.recoveryCodes.filter((c) => c.userId === "m-admin").length).toBe(10);
    const old = await second(cookies(await password("admin@m.co")).mfa, { recoveryCode: admin.recoveryCodes[1]! }, "10.97.0.1");
    expect(old.json().code).toBe("MFA_INVALID_CODE");
    const neu = await second(cookies(await password("admin@m.co")).mfa, { recoveryCode: r.json().recoveryCodes[0] }, "10.97.0.2");
    expect(neu.statusCode).toBe(200);
    admin.sid = cookies(neu).sid!;
    expect(db.audit.some((a) => a.action === "mfa_recovery_codes_regenerated" && a.entityId === "m-admin")).toBe(true);
  });

  it("disable needs the password and a second factor, then login is password-only again", async () => {
    const sid = admin.sid;
    const bad = await call("POST", "/api/v1/auth/2fa/disable", sid, { password: "wrong-password-9", code: codeAt(admin.secret, STEP + 3) });
    expect([bad.statusCode, bad.json().code]).toEqual([422, "MFA_INVALID_CODE"]);
    expect((await call("POST", "/api/v1/auth/2fa/disable", sid, { password: PW })).statusCode).toBe(400);
    vi.setSystemTime(NOW + 60_000);
    const ok = await call("POST", "/api/v1/auth/2fa/disable", sid, { password: PW, code: codeAt(admin.secret, STEP + 3) });
    vi.setSystemTime(NOW);
    expect(ok.statusCode).toBe(200);
    const row = db.users.find((x) => x.id === "m-admin");
    expect([row.totpSecret, row.totpEnabledAt, row.totpLastStep]).toEqual([null, null, null]);
    expect(db.recoveryCodes.filter((c) => c.userId === "m-admin").length).toBe(0);
    expect(db.audit.some((a) => a.action === "mfa_disabled" && a.entityId === "m-admin")).toBe(true);
    expect((await call("GET", "/api/v1/auth/me", sid)).statusCode).toBe(401); // sessions revoked
    expect((await call("GET", "/api/v1/auth/me", cookies(ok).sid!)).json().mfaEnabled).toBe(false);
    expect(cookies(await password("admin@m.co")).sid).toBeTruthy();
  });
});

let ownerSecret = "";

describe("REQUIRE_OWNER_2FA", () => {
  afterAll(() => { env.REQUIRE_OWNER_2FA = false; });

  it("an owner without 2FA can only enroll; after activation everything works and 2FA cannot be disabled", async () => {
    env.REQUIRE_OWNER_2FA = true;
    const login = await password("owner@m.co");
    expect(login.json()).toMatchObject({ role: "owner", mfaEnrollmentRequired: true });
    const sid = cookies(login).sid!;
    const blocked = await call("PUT", "/api/v1/products/SKU1", sid, { name: "x", unitAmount: 100, currency: "GBP" });
    expect([blocked.statusCode, blocked.json().code]).toEqual([403, "MFA_ENROLLMENT_REQUIRED"]);
    expect((await call("PATCH", "/api/v1/users/m-ops/role", sid, { role: "admin" })).json().code).toBe("MFA_ENROLLMENT_REQUIRED");
    expect((await call("GET", "/api/v1/auth/me", sid)).json()).toMatchObject({ mfaEnabled: false, mfaEnrollmentRequired: true });

    const owner = await enable(sid);
    ownerSecret = owner.secret;
    expect((await call("PUT", "/api/v1/products/SKU1", owner.sid, { name: "x", unitAmount: 100, currency: "GBP" })).statusCode).toBe(200);
    const off = await call("POST", "/api/v1/auth/2fa/disable", owner.sid, { password: PW, code: codeAt(owner.secret, STEP) });
    expect([off.statusCode, off.json().code]).toEqual([409, "MFA_REQUIRED"]);
    // Operations staff are not forced by this option; admins are (they change prices and roles).
    expect((await call("GET", "/api/v1/products", await sidOf("ops@m.co"))).statusCode).toBe(200);
    const adminLogin = await password("plain@m.co");
    expect(adminLogin.json()).toMatchObject({ role: "admin", mfaEnrollmentRequired: true });
    const adminBlocked = await call("PUT", "/api/v1/products/SKU1", cookies(adminLogin).sid!, { name: "x", unitAmount: 100, currency: "GBP" });
    expect([adminBlocked.statusCode, adminBlocked.json().code]).toEqual([403, "MFA_ENROLLMENT_REQUIRED"]);
  });

  it("the owner resets another user's 2FA in the same tenant only, never their own, and it is audited", async () => {
    const opsSid = await sidOf("ops@m.co");
    await enable(opsSid);
    expect(db.users.find((x) => x.id === "m-ops").totpEnabledAt).not.toBeNull();
    // Owner signs in with a code (STEP - 1 was used to activate; the refused disable checked nothing, so STEP is unused).
    const signed = await second(cookies(await password("owner@m.co")).mfa, { code: codeAt(ownerSecret, STEP) }, "10.96.0.1");
    expect(signed.statusCode).toBe(200);
    const sid = cookies(signed).sid!;
    expect((await call("POST", "/api/v1/users/m-owner/2fa/reset", sid)).json().code).toBe("SELF_MFA_RESET");
    expect((await call("POST", "/api/v1/users/m-other/2fa/reset", sid)).statusCode).toBe(404);
    expect((await call("POST", "/api/v1/users/m-ops/2fa/reset", await sidOf("plain@m.co"))).statusCode).toBe(403); // admin: not allowed
    const r = await call("POST", "/api/v1/users/m-ops/2fa/reset", sid);
    expect([r.statusCode, r.json()]).toEqual([200, { id: "m-ops", mfaEnabled: false }]);
    expect(db.audit.some((a) => a.action === "mfa_reset" && a.entityId === "m-ops" && a.actor === "user:m-owner")).toBe(true);
    expect((await call("GET", "/api/v1/auth/me", opsSid)).statusCode).toBe(401);
  });

  it("never resets another owner's 2FA from the API, and demoting a 2FA user to customer clears their TOTP and recovery codes", async () => {
    const { usersRepo } = await import("../repositories/users.repository.js");
    const { resetForUser } = await import("../services/mfa.service.js");
    const owner2 = { ...db.users.find((x) => x.id === "m-owner"), id: "m-owner2", email: "owner2@m.co" };
    db.users.push(owner2);
    await expect(resetForUser("m-owner2", { tenantId: "tM", actorId: "m-owner", ip: "1.1.1.1", requestId: "r" } as never)).rejects.toMatchObject({ code: "OWNER_MFA_RESET" });
    const ops = db.users.find((x) => x.id === "m-ops");
    ops.totpSecret = "enc"; ops.totpEnabledAt = new Date();
    db.recoveryCodes = [...(db.recoveryCodes ?? []), { userId: "m-ops", codeHash: "h" }];
    const { prisma } = await import("@octavolab/db");
    await prisma.$transaction((tx) => usersRepo.changeRole(tx as never, "m-ops", "tM", "customer"));
    expect([ops.role, ops.totpSecret, ops.totpEnabledAt]).toEqual(["customer", null, null]);
  });
});

describe("2FA configuration and logs", () => {
  it("fails closed without TOTP_ENC_KEY: enrollment and 2FA logins answer 503, never password-only", async () => {
    const key = env.TOTP_ENC_KEY;
    env.TOTP_ENC_KEY = undefined;
    try {
      const r = await call("POST", "/api/v1/auth/2fa/enroll", await sidOf("plain@m.co"));
      expect([r.statusCode, r.json().code]).toEqual([503, "MFA_NOT_CONFIGURED"]);
      const owner = await password("owner@m.co");
      expect(owner.statusCode).toBe(503);
      expect(cookies(owner).sid ?? "").toBe("");
    } finally {
      env.TOTP_ENC_KEY = key;
    }
  });

  it("never logs codes, recovery codes or secrets", async () => {
    const lines: string[] = [];
    const logged = await (await import("../app.js")).buildApp({ logStream: { write: (l: string) => lines.push(l) } });
    const ip = "10.95.0.1";
    const login = await logged.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "x-forwarded-for": ip }, payload: { email: "owner@m.co", password: PW } });
    await logged.inject({ method: "POST", url: "/api/v1/auth/login/mfa", headers: { "x-forwarded-for": ip, cookie: `mfa=${cookies(login).mfa}` }, payload: { code: "987654" } });
    await logged.inject({ method: "POST", url: "/api/v1/auth/login/mfa", headers: { "x-forwarded-for": ip, cookie: `mfa=${cookies(login).mfa}` }, payload: { recoveryCode: "ZZZZZ-YYYYY" } });
    await logged.close();
    const all = lines.join("\n");
    expect(all).toContain("mfa_failed");
    for (const s of ["987654", "ZZZZZ", ownerSecret, PW]) expect(all).not.toContain(s);
  });
});
