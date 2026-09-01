/**
 * Row hashing.
 *
 * The hash deliberately excludes `dateLastModified`. A meaningful number of
 * OneRoster providers stamp that field on every row every night; hashing it
 * would mean every row looks changed and the delta degenerates into a full
 * rewrite. Hashing the meaningful fields instead means the diff is correct
 * whatever the provider does with its timestamps.
 */
const IGNORED = new Set(["dateLastModified", "status"]);

/** Stable stringify: key order must not affect the hash. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !IGNORED.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

export async function rowHash(row: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(row)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function payloadHash(hashes: string[]): Promise<string> {
  const joined = [...hashes].sort().join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export { stable as stableStringify };
