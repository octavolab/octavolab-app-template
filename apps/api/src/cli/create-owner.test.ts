import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import argon2 from "argon2";
import { createOwner, parseArgs, passwordProblem, readPassword, readStdinLine, main, UsageError, DEMO_PRODUCTS, type Prompt } from "./create-owner.js";

function fakeDb(existing: string[] = []) {
  const users = new Map<string, { email: string; passwordHash: string; role: string; tenantId: string }>();
  for (const e of existing) users.set(e, { email: e, passwordHash: "keep-me", role: "customer", tenantId: "demo" });
  const products: unknown[] = [];
  const db = {
    tenant: { upsert: async () => ({ id: "demo" }) },
    product: { upsert: async (a: unknown) => { products.push(a); return a; } },
    user: {
      findUnique: async (a: unknown) => users.get((a as { where: { email: string } }).where.email) ?? null,
      create: async (a: unknown) => { const d = (a as { data: { email: string; passwordHash: string; role: string; tenantId: string } }).data; users.set(d.email, d); return d; },
    },
  };
  return { db, users, products };
}

/** A prompt whose stdin is a pipe (non-TTY) or a fake TTY, and whose output is captured. */
function prompt(lines: string[], tty = false) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown; raw: boolean[] };
  input.raw = [];
  if (tty) { input.isTTY = true; input.setRawMode = (on: boolean) => { input.raw.push(on); return input; }; }
  const output = new PassThrough();
  let out = "";
  output.on("data", (c) => { out += String(c); });
  const p: Prompt = { input, output };
  const feed = () => { for (const l of lines) input.write(`${l}\r`); };
  return { p, input, out: () => out, feed, pipe: () => { input.end(lines.join("\n") + "\n"); } };
}

const PW = "a-long-password-123";

describe("create-owner: arguments", () => {
  it("takes --email only and normalizes it", () => {
    expect(parseArgs(["--email", " Owner@Example.com "])).toEqual({ email: "owner@example.com" });
    expect(parseArgs(["--email=owner@example.com"])).toEqual({ email: "owner@example.com" });
  });
  it("never accepts a password as an argument, and never echoes unknown arguments", () => {
    for (const a of [["--password", PW], [`--password=${PW}`], ["-p", PW], ["--pw", PW], [`--pass=${PW}`]]) {
      expect(() => parseArgs(["--email", "o@e.co", ...a])).toThrow(/never accepted as an argument/);
    }
    const positional = (() => { try { parseArgs(["--email", "o@e.co", PW]); } catch (e) { return (e as Error).message; } return ""; })();
    expect(positional).toBe("unknown argument (positional)");
    const flag = (() => { try { parseArgs([`--secret=${PW}`]); } catch (e) { return (e as Error).message; } return ""; })();
    expect(flag).toBe("unknown argument --secret");
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(["--email", "not-an-email"])).toThrow(/must be an email/);
    expect(() => parseArgs(["--email"])).toThrow(/required/);
  });
  it("password rules: at least 12 characters and not trivially repetitive", () => {
    expect(passwordProblem("short")).toMatch(/12 characters/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa")).toMatch(/distinct/);
    expect(passwordProblem(PW)).toBeNull();
  });
});

describe("create-owner: reading the password", () => {
  it("from a pipe: the first line, without the newline", async () => {
    const t = prompt([PW, "ignored"]);
    t.pipe();
    expect(await readPassword(t.p)).toBe(PW);
    const crlf = new PassThrough(); crlf.end(`${PW}\r\nnext`);
    expect(await readStdinLine(crlf)).toBe(PW);
  });
  it("from a TTY: hidden (raw mode, nothing echoed), asked twice, must match; backspace and Ctrl-C handled", async () => {
    const ok = prompt([PW + "x\u007f", PW], true);
    const pending = readPassword(ok.p);
    setImmediate(ok.feed);
    expect(await pending).toBe(PW);
    expect(ok.input.raw).toEqual([true, false, true, false]);
    expect(ok.out()).not.toContain(PW);
    expect(ok.out()).toContain("Owner password (hidden): ");

    const mismatch = prompt([PW, PW + "!"], true);
    const p2 = readPassword(mismatch.p);
    setImmediate(mismatch.feed);
    await expect(p2).rejects.toThrow("the passwords do not match");

    const abort = prompt(["\u0003"], true);
    const p3 = readPassword(abort.p);
    setImmediate(abort.feed);
    await expect(p3).rejects.toThrow("aborted");
  });
});

describe("create-owner: database effects", () => {
  it("creates the owner with an argon2 hash, the demo tenant and price list", async () => {
    const f = fakeDb();
    expect(await createOwner(f.db, { email: "owner@example.com", password: PW })).toBe("created");
    const u = f.users.get("owner@example.com")!;
    expect([u.role, u.tenantId]).toEqual(["owner", "demo"]);
    expect(u.passwordHash).not.toContain(PW);
    expect(await argon2.verify(u.passwordHash, PW)).toBe(true);
    expect(f.products.length).toBe(DEMO_PRODUCTS.length);
  });
  it("never modifies an existing user (no password, role or tenant overwrite)", async () => {
    const f = fakeDb(["owner@example.com"]);
    expect(await createOwner(f.db, { email: "owner@example.com", password: "another-long-pass" })).toBe("exists");
    expect(f.users.get("owner@example.com")).toEqual({ email: "owner@example.com", passwordHash: "keep-me", role: "customer", tenantId: "demo" });
  });
  it("refuses a weak password before touching the database", async () => {
    const f = fakeDb();
    await expect(createOwner(f.db, { email: "owner@example.com", password: "short" })).rejects.toThrow(/12 characters/);
    expect(f.users.size + f.products.length).toBe(0);
  });
});

describe("create-owner: main (exit codes, output never contains the password)", () => {
  const run = async (argv: string[], stdinLines: string[], existing: string[] = []) => {
    const f = fakeDb(existing);
    let closed = false;
    const t = prompt(stdinLines);
    t.pipe();
    const code = await main(argv, t.p, async () => ({ db: f.db, close: async () => { closed = true; } }));
    return { code, out: t.out(), f, closed };
  };
  it("0 created, 3 exists (nothing changed), 2 usage or weak password; the connection is always closed", async () => {
    const created = await run(["--email", "owner@example.com"], [PW]);
    expect([created.code, created.closed, created.f.users.has("owner@example.com")]).toEqual([0, true, true]);
    expect(created.out).toContain("owner owner@example.com created");
    const exists = await run(["--email", "owner@example.com"], [PW], ["owner@example.com"]);
    expect([exists.code, exists.f.users.get("owner@example.com")!.passwordHash]).toEqual([3, "keep-me"]);
    expect((await run(["--password", PW], [PW])).code).toBe(2);
    const weak = await run(["--email", "owner@example.com"], ["short"]);
    expect([weak.code, weak.f.users.size]).toEqual([2, 0]);
    for (const r of [created, exists, weak]) expect(r.out).not.toContain(PW);
  });
});
