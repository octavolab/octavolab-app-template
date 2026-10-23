import argon2 from "argon2";

/**
 * One-off creation of the first owner of a fresh environment (replaces the BOOTSTRAP_OWNER_* environment variables,
 * which left the password in the Lightsail deployment history forever).
 *
 *   pnpm create-owner --email owner@example.com                       # local, prompts twice (hidden input)
 *   printf '%s\n' "$PW" | node apps/api/dist/cli/create-owner.js --email owner@example.com   # stdin, e.g. one-shot container
 *
 * - The password is read ONLY from an interactive prompt (echo off) or from stdin. Never from arguments or environment
 *   variables: those end up in shell history, `ps`, CI logs and deployment history. `--password` is rejected.
 * - Needs only DATABASE_URL. Creates the demo tenant and its demo price list if missing (upsert, never updated).
 * - Never modifies an existing user: if the email exists, nothing is written and the exit code is 3.
 * - Exit codes: 0 created, 2 usage or validation error, 3 user already exists (nothing changed), 1 unexpected error.
 * - Logs one line, without the password or its hash.
 */
type Db = {
  tenant: { upsert(a: unknown): Promise<{ id: string }> };
  product: { upsert(a: unknown): Promise<unknown> };
  user: { findUnique(a: unknown): Promise<unknown>; create(a: unknown): Promise<unknown> };
};

export const DEMO_PRODUCTS = [
  { sku: "DEMO-BOX-S", name: "Small box", unitAmount: 1500 },
  { sku: "DEMO-BOX-L", name: "Large box", unitAmount: 3900 },
] as const;

export const MIN_PASSWORD_LENGTH = 12;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class UsageError extends Error {}

/** `--email <address>` (or `--email=<address>`); anything else, and any attempt to pass a password, is a usage error. */
export function parseArgs(argv: readonly string[]): { email: string } {
  let email: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (/^--?(p|pw|pass|password)(=|$)/i.test(a)) throw new UsageError("the password is never accepted as an argument; it is read from the prompt or stdin");
    if (a === "--email") { email = argv[++i]; continue; }
    if (a.startsWith("--email=")) { email = a.slice("--email=".length); continue; }
    throw new UsageError(`unknown argument ${a.startsWith("-") ? a.split("=")[0] : "(positional)"}`);
  }
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !EMAIL.test(normalized)) throw new UsageError("--email <address> is required and must be an email address");
  return { email: normalized };
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `the password must have at least ${MIN_PASSWORD_LENGTH} characters`;
  if (new Set(password).size < 5) return "the password has too few distinct characters";
  return null;
}

export type Prompt = { input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }; output: NodeJS.WritableStream };

/** First line of a non-interactive stdin (trailing CR/LF removed). */
export async function readStdinLine(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of input) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    if (Buffer.concat(chunks).includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
}

/**
 * Reads one line from a TTY without echoing it. Ctrl-C aborts. Input that arrives after the Enter key (a paste of both
 * answers, a fast typist) is put back on the stream for the next prompt instead of being lost.
 */
export function readHidden(p: Prompt, question: string): Promise<string> {
  const input = p.input as Prompt["input"] & { pause(): unknown; resume(): unknown; unshift?(chunk: Buffer): void };
  return new Promise((resolve, reject) => {
    p.output.write(question);
    input.setRawMode?.(true);
    let value = "";
    const done = (rest: string, err?: Error) => {
      input.removeListener("data", onData);
      input.pause();
      if (rest) input.unshift?.(Buffer.from(rest, "utf8"));
      input.setRawMode?.(false);
      p.output.write("\n");
      if (err) reject(err); else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const chars = [...chunk.toString("utf8")];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i]!;
        const rest = () => chars.slice(i + 1).join("").replace(/^\n/, ""); // CR LF counts as one Enter
        if (ch === "\u0003") return done("", new UsageError("aborted"));
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(rest());
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
    input.resume();
  });
}

/** Interactive: prompt twice, hidden, and require a match. Piped: first stdin line. */
export async function readPassword(p: Prompt): Promise<string> {
  if (!p.input.isTTY) return readStdinLine(p.input);
  const first = await readHidden(p, "Owner password (hidden): ");
  const second = await readHidden(p, "Repeat password: ");
  if (first !== second) throw new UsageError("the passwords do not match");
  return first;
}

export async function createOwner(db: Db, input: { email: string; password: string }): Promise<"created" | "exists"> {
  const problem = passwordProblem(input.password);
  if (problem) throw new UsageError(problem);
  const tenant = await db.tenant.upsert({ where: { id: "demo" }, update: {}, create: { id: "demo", name: "Demo tenant" } });
  for (const p of DEMO_PRODUCTS) {
    await db.product.upsert({ where: { tenantId_sku: { tenantId: tenant.id, sku: p.sku } }, update: {}, create: { ...p, currency: "GBP", tenantId: tenant.id } });
  }
  // Never modify an existing user (its password, role and 2FA stay exactly as they are).
  if (await db.user.findUnique({ where: { email: input.email } })) return "exists";
  await db.user.create({ data: { email: input.email, passwordHash: await argon2.hash(input.password), role: "owner", tenantId: tenant.id } });
  return "created";
}

export async function main(argv: readonly string[], p: Prompt, connect: () => Promise<{ db: Db; close: () => Promise<void> }>): Promise<number> {
  let email: string;
  try {
    ({ email } = parseArgs(argv));
  } catch (e) {
    p.output.write(`create-owner: ${(e as Error).message}\nusage: create-owner --email <address>   (password from the prompt or stdin)\n`);
    return 2;
  }
  let password: string;
  try {
    password = await readPassword(p);
    const problem = passwordProblem(password);
    if (problem) throw new UsageError(problem);
  } catch (e) {
    p.output.write(`create-owner: ${(e as Error).message}\n`);
    return 2;
  }
  const { db, close } = await connect();
  try {
    const result = await createOwner(db, { email, password });
    if (result === "exists") {
      p.output.write(`create-owner: ${email} already exists; nothing was changed\n`);
      return 3;
    }
    p.output.write(`create-owner: owner ${email} created; sign in and enroll 2FA (required for owners)\n`);
    return 0;
  } finally {
    await close();
  }
}

/* c8 ignore start -- process wiring, exercised by running the CLI (docs/runbook.md) */
if (/create-owner\.(js|ts)$/.test(process.argv[1] ?? "")) {
  const connect = async () => {
    const { prisma } = await import("@octavolab/db");
    return { db: prisma as unknown as Db, close: () => prisma.$disconnect() };
  };
  main(process.argv.slice(2), { input: process.stdin, output: process.stderr }, connect)
    .then((code) => process.exit(code))
    .catch((e: unknown) => { process.stderr.write(`create-owner: unexpected error: ${e instanceof Error ? e.name : "error"}\n`); process.exit(1); });
}
/* c8 ignore stop */
