// Node-only entry: a durable file queue and a scheduler loop. Secrets never reach these files; the core keeps them
// sealed in the host Keystore.
import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Social } from "./social.ts";
import type { SocialQueue, SocialState } from "./types.ts";

const OWNED = "another process owns this social state";
// Lock holders in this process, by real path: a lock file only names the pid, and two queues can share one.
const held = new Set<string>();

const errno = (error: unknown) => (error as { code?: unknown })?.code;
const readPid = async (path: string) => Number(await readFile(path, "utf8").catch(() => ""));
const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return errno(error) !== "ESRCH"; }
};

/** A 0600 sibling temp file holding `data`, flushed to disk. */
async function writeTemp(path: string, data: string | Uint8Array): Promise<string> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, "wx", 0o600);
  try { await file.writeFile(data); await file.sync(); } catch (error) {
    await file.close();
    await rm(tmp, { force: true });
    throw error;
  }
  await file.close();
  return tmp;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = await writeTemp(path, data);
  try { await rename(tmp, path); } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  // Make the rename itself durable: a lost "publishing" record would let a post go out twice. Not supported on Windows.
  const parent = await open(dirname(path), "r").catch(() => null);
  await parent?.sync().catch(() => undefined);
  await parent?.close();
}

/** Drafts, approvals, posts and media under `<stateDir>/social`, owned by one process at a time. */
export function fileQueue(options: { stateDir: string }): SocialQueue & { close(): Promise<void> } {
  if (typeof options?.stateDir !== "string" || !isAbsolute(options.stateDir)) {
    throw new TypeError("stateDir must be an absolute path");
  }
  const dir = join(options.stateDir, "social");
  const lockFile = join(dir, "lock");
  const statePath = join(dir, "state.json");
  let locking: Promise<string> | undefined;
  let closed = false;

  async function acquire(): Promise<string> {
    await mkdir(join(dir, "media"), { recursive: true, mode: 0o700 });
    const key = await realpath(dir);
    if (held.has(key)) throw new Error(OWNED);
    held.add(key);
    try {
      for (;;) {
        // link() creates the lock exclusively with its pid already inside, so nobody ever reads a half-written lock.
        const tmp = await writeTemp(lockFile, String(process.pid));
        try { await link(tmp, lockFile); return key; } catch (error) {
          if (errno(error) !== "EEXIST") throw error;
        } finally { await rm(tmp, { force: true }); }
        if (alive(await readPid(lockFile))) throw new Error(OWNED);
        // Stale: move it aside, then make sure what moved was still the dead owner's and not a racer's fresh lock.
        const aside = `${lockFile}.${randomUUID()}.stale`;
        try { await rename(lockFile, aside); } catch (error) {
          if (errno(error) === "ENOENT") continue;
          throw error;
        }
        const owner = await readPid(aside);
        if (alive(owner)) await link(aside, lockFile).catch(() => undefined);
        await rm(aside, { force: true });
        if (alive(owner)) throw new Error(OWNED);
      }
    } catch (error) {
      held.delete(key);
      throw error;
    }
  }

  async function ready(): Promise<void> {
    if (closed) throw new Error("this social queue is closed");
    await (locking ??= acquire().catch((error: unknown) => { locking = undefined; throw error; }));
  }

  function mediaPath(hash: string): string {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new TypeError("media hash must be 64 lowercase hex");
    return join(dir, "media", hash);
  }

  return {
    async load() {
      await ready();
      let text: string;
      try { text = await readFile(statePath, "utf8"); } catch (error) {
        if (errno(error) === "ENOENT") return null;
        throw error;
      }
      const state = JSON.parse(text) as SocialState;
      if (state?.v !== 1) throw new Error("unknown social state version");
      return state;
    },
    async save(state) {
      await ready();
      await writeAtomic(statePath, JSON.stringify(state));
    },
    async putMedia(hash, data) {
      const path = mediaPath(hash);
      if (createHash("sha256").update(data).digest("hex") !== hash) throw new TypeError("media bytes do not match their hash");
      await ready();
      if (await access(path).then(() => true, () => false)) return;
      await writeAtomic(path, data);
    },
    async getMedia(hash) {
      const path = mediaPath(hash);
      await ready();
      try { return new Uint8Array(await readFile(path)); } catch (error) {
        if (errno(error) === "ENOENT") return null;
        throw error;
      }
    },
    async close() {
      closed = true;
      const key = await locking?.catch(() => undefined);
      locking = undefined;
      if (!key || !held.has(key)) return;
      if ((await readPid(lockFile)) === process.pid) await rm(lockFile, { force: true });
      held.delete(key);
    },
  };
}

/**
 * Call `social.runDue()` now and then every `intervalMs`, one run at a time, until `signal` aborts. A run in flight
 * finishes before the promise resolves, so the host can close the queue afterwards.
 */
export async function runScheduler(social: Social,
  options: { intervalMs?: number; signal?: AbortSignal; onError?: (error: unknown) => void } = {}): Promise<void> {
  const { intervalMs = 30_000, signal, onError = () => undefined } = options;
  if (!(Number.isFinite(intervalMs) && intervalMs > 0)) throw new RangeError("intervalMs must be a positive, finite number");
  while (!signal?.aborted) {
    try { await social.runDue(); } catch (error) {
      try { onError(error); } catch { /* the loop outlives a failing handler */ }
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}
