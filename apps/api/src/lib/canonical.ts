import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, arrays kept in order, undefined members dropped (as JSON.stringify does). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Fingerprint of an idempotent request: the operation name and its validated input. */
export function requestHash(operation: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ op: operation, input })).digest("hex");
}
