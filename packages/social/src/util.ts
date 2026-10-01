// Portable helpers: Web Crypto, TextEncoder and nothing from Node.

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return Array.from(await sha256(data), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON with object keys sorted at every level, so equal payloads always hash equally. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function randomId(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Fixed-length Keystore name that never reveals a handle, email or instance. */
export async function recordName(parts: readonly string[]): Promise<string> {
  return `social.${b64url(await sha256(JSON.stringify(["v1", ...parts])))}`;
}

export const graphemes = (text: string): number => {
  let n = 0;
  for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) n++;
  return n;
};
