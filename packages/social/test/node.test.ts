import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Social, SocialError, type SocialEvent } from "../src/index.ts";
import { fileQueue, runScheduler } from "../src/node.ts";
import { fakeClock, fakeProvider, memoryKeystore } from "../src/testing.ts";
import { sha256Hex } from "../src/util.ts";

const MIN = 60_000;
const SECRET = "fake-token";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "social-test-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(condition(), "condition never held");
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;
const refused = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;

function open(stateDir: string, store = memoryKeystore(), clock = fakeClock()) {
  const queue = fileQueue({ stateDir });
  const fake = fakeProvider();
  const social = new Social({ store, providers: [fake.provider], queue, now: clock.now });
  const events: SocialEvent[] = [];
  social.onState((e) => events.push(e));
  return { queue, fake, social, events, store, clock };
}

test("stateDir must be absolute", () => {
  assert.throws(() => fileQueue({ stateDir: "relative/dir" }), TypeError);
  assert.throws(() => fileQueue({} as { stateDir: string }), TypeError);
});

test("state round-trips through a new Social and queue, and no secret is ever written", () => withDir(async (dir) => {
  const first = open(dir);
  const { social, clock } = first;
  const account = await social.connect("fake", { person: "umer", slot: "takeone" });
  assert.ok(!("url" in account));
  const posted = await social.draft({ account: account.id, text: "Hello from Umer", media: [{ data: png, type: "image/png", alt: "logo" }], origin: "person" });
  const approval = await social.approve(posted.id, { revision: 1, by: "umer", at: "now" });
  const result = await social.post(approval.id);
  assert.ok("ok" in result && result.ok);
  assert.deepEqual(first.fake.sent[0].media[0].data, png);
  const later = await social.draft({ account: account.id, text: "Later, from Umer", origin: "agent" });
  await social.schedule((await social.approve(later.id, { revision: 1, by: "umer", at: clock.now() + 60 * MIN })).id);
  const pending = await social.draft({ account: account.id, text: "Pending", origin: "person" });
  await social.approve(pending.id, { revision: 1, by: "umer", at: "now" });

  const before = { drafts: await social.drafts(), posts: await social.posts(), accounts: await social.accounts(),
    status: await Promise.all([posted, later, pending].map((d) => social.status(d.id))) };
  await first.queue.close();

  const second = open(dir, first.store, clock);
  assert.deepEqual(await second.social.drafts(), before.drafts);
  assert.deepEqual(await second.social.posts(), before.posts);
  assert.deepEqual(await second.social.accounts(), before.accounts);
  assert.deepEqual(await Promise.all([posted, later, pending].map((d) => second.social.status(d.id))), before.status);
  assert.deepEqual(before.status.map((s) => s.phase), ["posted", "scheduled", "approved"]);
  // The reloaded approval still posts, with media read back from disk.
  const again = await second.social.post(before.status[2].approval!.id);
  assert.ok("ok" in again && again.ok);
  await assert.rejects(second.social.post(approval.id), refused("approval-used"));
  await second.queue.close();

  for (const path of await files(dir)) assert.ok(!(await readFile(path, "utf8")).includes(SECRET), path);
  const seen = JSON.stringify([before, first.events, second.events, await second.social.posts()]);
  assert.ok(!seen.includes(SECRET));
  assert.ok([...first.store.entries.values()].some((v) => v.includes(SECRET)), "the secret lives only in the Keystore");
}));

test("files are 0600, folders 0700, and writes leave no temp files", () => withDir(async (dir) => {
  const { social, queue } = open(dir);
  const account = await social.connect("fake", { person: "umer", slot: "takeone" });
  assert.ok(!("url" in account));
  await social.draft({ account: account.id, text: "Hi", media: [{ data: png, type: "image/png" }], origin: "person" });
  const root = join(dir, "social");
  assert.equal(await mode(root), 0o700);
  assert.equal(await mode(join(root, "media")), 0o700);
  assert.equal(await mode(join(root, "state.json")), 0o600);
  assert.equal(await mode(join(root, "lock")), 0o600);
  assert.equal(await mode(join(root, "media", await sha256Hex(png))), 0o600);
  assert.deepEqual((await files(root)).map((p) => p.slice(root.length + 1)).sort(),
    ["lock", "media/" + (await sha256Hex(png)), "state.json"]);
  await queue.close();
}));

test("media is content-addressed and bad hashes never reach a path", () => withDir(async (dir) => {
  const queue = fileQueue({ stateDir: dir });
  const hash = await sha256Hex(png);
  await queue.putMedia(hash, png);
  const path = join(dir, "social", "media", hash);
  const written = await stat(path);
  await queue.putMedia(hash, png);
  assert.equal((await stat(path)).mtimeMs, written.mtimeMs, "an existing file is not rewritten");
  assert.deepEqual(await queue.getMedia(hash), png);
  assert.equal(await queue.getMedia("0".repeat(64)), null);
  for (const bad of ["../state.json", hash.toUpperCase(), hash.slice(1), `${hash}/x`, ""]) {
    await assert.rejects(queue.putMedia(bad, png), TypeError);
    await assert.rejects(queue.getMedia(bad), TypeError);
  }
  await assert.rejects(queue.putMedia("a".repeat(64), png), TypeError);
  await queue.close();
}));

test("one owner at a time: a second queue is refused until the first closes", () => withDir(async (dir) => {
  const a = fileQueue({ stateDir: dir });
  const b = fileQueue({ stateDir: dir });
  assert.equal(await a.load(), null);
  await assert.rejects(b.load(), /another process owns this social state/);
  await assert.rejects(b.save({ v: 1, accounts: [], drafts: [], approvals: [], posts: [] }), /another process/);
  const social = new Social({ store: memoryKeystore(), providers: [fakeProvider().provider], queue: b });
  await assert.rejects(social.drafts(), refused("store-failed"));
  await a.close();
  await a.close();
  await assert.rejects(a.load(), /closed/);
  assert.equal(await b.load(), null, "a closed owner released the lock");
  assert.equal(await readFile(join(dir, "social", "lock"), "utf8"), String(process.pid));
  await b.close();
  await assert.rejects(stat(join(dir, "social", "lock")), { code: "ENOENT" });
}));

test("a lock left by a dead process is taken over; a live owner's is not", () => withDir(async (dir) => {
  const child = spawn(process.execPath, ["-e", "0"]);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const lock = join(dir, "social", "lock");
  await mkdir(join(dir, "social"), { mode: 0o700 });
  await writeFile(lock, String(child.pid), { mode: 0o600 });
  const taker = fileQueue({ stateDir: dir });
  assert.equal(await taker.load(), null);
  assert.equal(await readFile(lock, "utf8"), String(process.pid));
  await taker.close();

  await writeFile(lock, String(process.ppid), { mode: 0o600 });
  const blocked = fileQueue({ stateDir: dir });
  await assert.rejects(blocked.load(), /another process owns this social state/);
  await blocked.close();
  assert.equal(await readFile(lock, "utf8"), String(process.ppid), "a live owner's lock is left alone");
}));

test("a post cut off mid-flight loads as unknown, and broken state fails as store-failed", () => withDir(async (dir) => {
  const first = open(dir);
  const account = await first.social.connect("fake", { person: "umer", slot: "takeone" });
  assert.ok(!("url" in account));
  const draft = await first.social.draft({ account: account.id, text: "Crash", origin: "person" });
  const approval = await first.social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  await first.social.post(approval.id);
  await first.queue.close();
  const statePath = join(dir, "social", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.posts[0].phase = "publishing";
  await writeFile(statePath, JSON.stringify(state));

  const second = open(dir, first.store);
  const [post] = await second.social.posts();
  assert.equal(post.phase, "unknown");
  assert.equal(post.code, "network");
  await assert.rejects(second.social.post(approval.id), refused("approval-used"));
  await second.queue.close();

  await writeFile(statePath, "{not json");
  const third = open(dir, first.store);
  await assert.rejects(third.queue.load(), SyntaxError);
  await assert.rejects(third.social.drafts(), refused("store-failed"));
  await third.queue.close();
}));

test("runScheduler posts what is due and stops on abort", () => withDir(async (dir) => {
  const { social, fake, clock, queue } = open(dir);
  const account = await social.connect("fake", { person: "umer", slot: "takeone" });
  assert.ok(!("url" in account));
  const draft = await social.draft({ account: account.id, text: "Scheduled by Umer", origin: "person" });
  const at = clock.now() + 60 * MIN;
  await social.schedule((await social.approve(draft.id, { revision: 1, by: "umer", at })).id);
  const stop = new AbortController();
  const running = runScheduler(social, { intervalMs: 5, signal: stop.signal });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fake.sent.length, 0);
  clock.set(at + MIN);
  await waitFor(() => fake.sent.length === 1);
  stop.abort();
  await running;
  assert.equal((await social.status(draft.id)).phase, "posted");
  assert.equal(fake.sent.length, 1);
  await queue.close();
}));

test("runScheduler never overlaps runs, reports errors and keeps going", async () => {
  let active = 0;
  let calls = 0;
  let maxActive = 0;
  const errors: unknown[] = [];
  const social = {
    async runDue() {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (calls <= 2) throw new Error("disk hiccup");
      return [];
    },
  } as unknown as Social;
  const stop = new AbortController();
  const running = runScheduler(social, { intervalMs: 1, signal: stop.signal, onError: (e) => errors.push(e) });
  await waitFor(() => calls >= 4);
  stop.abort();
  await running;
  assert.equal(maxActive, 1);
  assert.equal(errors.length, 2);

  const before = calls;
  await runScheduler(social, { signal: AbortSignal.abort() });
  assert.equal(calls, before, "an aborted signal resolves without running");
  await assert.rejects(runScheduler(social, { intervalMs: 0 }), RangeError);
  await assert.rejects(runScheduler(social, { intervalMs: Infinity }), RangeError);
});
