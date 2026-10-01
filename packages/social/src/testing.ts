// Offline helpers for tests and demos. Never use memoryKeystore in a shipped app: it keeps secrets in plain memory.
import { defineProvider, type SendRequest, type Sent, type SocialProvider } from "./provider.ts";
import { SocialError } from "./errors.ts";
import type { Keystore, SocialErrorCode, SocialIssue } from "./types.ts";

export { memoryQueue } from "./social.ts";

/** A Keystore over a Map. Tests only. */
export function memoryKeystore(entries: Map<string, string> = new Map()): Keystore & { entries: Map<string, string> } {
  return {
    entries,
    async get(name) { return entries.get(name) ?? null; },
    async set(name, secret) { entries.set(name, secret); },
    async delete(name) { return entries.delete(name); },
  };
}

/** A manual clock in epoch milliseconds. */
export function fakeClock(start = Date.UTC(2026, 9, 1, 9, 0, 0)): { now(): number; advance(ms: number): void; set(ms: number): void } {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; }, set: (ms) => { now = ms; } };
}

/**
 * An API provider that records what it would have published. `fail` makes the next send throw that code;
 * `throwRaw` makes it throw a plain error, like a dropped connection.
 */
export function fakeProvider(options: { network?: string; maxLength?: number } = {}) {
  const sent: SendRequest[] = [];
  let next: { code?: SocialErrorCode; raw?: boolean } | undefined;
  const provider: SocialProvider = defineProvider({
    network: options.network ?? "fake", publish: "api", review: "none", needs: [], humanAuthored: [],
    async connect(input) {
      const handle = String((input as { handle?: unknown }).handle ?? "umer");
      return { handle, origin: "https://fake.invalid", remoteId: handle, records: { grant: { token: "fake-token" } } };
    },
    check(draft): SocialIssue[] {
      const limit = options.maxLength ?? 300;
      return draft.text.length > limit ? [{ code: "too-long", severity: "error", field: "text", limit }] : [];
    },
    async prepare(key) { return { key }; },
    async send(request): Promise<Sent> {
      const failure = next;
      next = undefined;
      if (failure?.raw) throw new Error("socket hang up");
      if (failure?.code) throw new SocialError(failure.code);
      sent.push(request);
      return { remoteId: `fake-${sent.length}`, url: `https://fake.invalid/post/${sent.length}` };
    },
  });
  return {
    provider, sent,
    fail(code: SocialErrorCode) { next = { code }; },
    throwRaw() { next = { raw: true }; },
  };
}
