import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { Social, SocialError, blueskyProvider, type SocialEvent } from "../src/index.ts";
import { facets, tid } from "../src/bluesky.ts";
import { providerSpec, type AccountContext, type Connected } from "../src/provider.ts";
import type { Draft, Json } from "../src/types.ts";
import { fakeClock, memoryKeystore } from "../src/testing.ts";

const DID = "did:plc:umer";
const HANDLE = "umer.bsky.social";
const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const refused = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;

interface Hit { server: "entryway" | "pds"; nsid: string; token: string }

/** A fake entryway and PDS on loopback, enough of com.atproto to sign in, rotate tokens and write posts. */
async function fakePds(t: TestContext) {
  const fake = {
    password: "app-pass-secret-umer",
    access: new Set<string>(),
    refresh: new Set<string>(),
    issued: [] as string[],
    records: new Map<string, { uri: string; value: Record<string, unknown> }>(),
    blobs: [] as { type: string; data: Uint8Array }[],
    hits: [] as Hit[],
    createRateLimit: 0,
    connectRateLimit: 0,
    drop: "" as "" | "before-create" | "after-create",
    onCreate: (_token: string) => {},
    entryway: "",
    pds: "",
    count: (nsid: string) => fake.hits.filter((h) => h.nsid === nsid).length,
    expireAccess() { fake.access.clear(); },
    expireRefresh() { fake.refresh.clear(); },
  };
  let n = 0;
  const issue = () => {
    n++;
    const accessJwt = `access-secret-${n}`;
    const refreshJwt = `refresh-secret-${n}`;
    fake.access.add(accessJwt);
    fake.refresh.add(refreshJwt);
    fake.issued.push(accessJwt, refreshJwt);
    return { accessJwt, refreshJwt, handle: HANDLE, did: DID,
      didDoc: { id: DID, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: fake.pds }] } };
  };
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };
  const handler = (server: Hit["server"]) => async (req: IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const nsid = url.pathname.replace("/xrpc/", "");
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    fake.hits.push({ server, nsid, token });
    const raw = await body(req);
    const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const authed = () => {
      if (fake.access.has(token)) return true;
      send(400, { error: "ExpiredToken", message: "Token has expired" });
      return false;
    };
    switch (nsid) {
      case "com.atproto.server.createSession": {
        if (fake.connectRateLimit) return send(429, { error: "RateLimitExceeded" }, { "ratelimit-reset": String(fake.connectRateLimit) });
        const input = JSON.parse(raw.toString()) as { identifier: string; password: string };
        if (input.identifier !== HANDLE || input.password !== fake.password) return send(401, { error: "AuthenticationRequired" });
        return send(200, issue());
      }
      case "com.atproto.server.refreshSession":
        if (!fake.refresh.delete(token)) return send(400, { error: "ExpiredToken" });
        return send(200, issue());
      case "com.atproto.server.deleteSession":
        fake.refresh.delete(token);
        return send(200, {});
      case "com.atproto.repo.uploadBlob": {
        if (!authed()) return;
        fake.blobs.push({ type: String(req.headers["content-type"]), data: new Uint8Array(raw) });
        return send(200, { blob: { $type: "blob", ref: { $link: `bafkblob${fake.blobs.length}` }, mimeType: req.headers["content-type"], size: raw.length } });
      }
      case "com.atproto.repo.createRecord": {
        if (!authed()) return;
        if (fake.createRateLimit) return send(429, { error: "RateLimitExceeded" }, { "ratelimit-reset": String(fake.createRateLimit) });
        if (fake.drop === "before-create") { fake.drop = ""; res.socket?.destroy(); return; }
        fake.onCreate(token);
        const input = JSON.parse(raw.toString()) as { repo: string; collection: string; rkey: string; record: Record<string, unknown> };
        if (fake.records.has(input.rkey)) return send(400, { error: "InvalidRequest", message: "Record already exists" });
        const uri = `at://${input.repo}/${input.collection}/${input.rkey}`;
        fake.records.set(input.rkey, { uri, value: input.record });
        if (fake.drop === "after-create") { fake.drop = ""; res.socket?.destroy(); return; }
        return send(200, { uri, cid: "bafyrecord" });
      }
      case "com.atproto.repo.getRecord": {
        if (!authed()) return;
        const record = fake.records.get(url.searchParams.get("rkey") ?? "");
        return record ? send(200, { ...record, cid: "bafyrecord" }) : send(400, { error: "RecordNotFound" });
      }
      default:
        return send(404, { error: "MethodNotImplemented" });
    }
  };
  const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  fake.entryway = await listen(createServer(handler("entryway")));
  fake.pds = await listen(createServer(handler("pds")));
  return fake;
}

async function setup(t: TestContext) {
  const fake = await fakePds(t);
  const clock = fakeClock();
  const store = memoryKeystore();
  const social = new Social({ store, providers: [blueskyProvider({ service: fake.entryway })], now: clock.now });
  const events: SocialEvent[] = [];
  social.onState((e) => events.push(e));
  const account = await social.connect("bluesky", { person: "umer", slot: "takeone", identifier: HANDLE, appPassword: fake.password });
  assert.ok(!("url" in account));
  const publish = async (input: { text: string; link?: string; options?: Record<string, string[]>; media?: { data: Uint8Array; type: string; alt?: string }[] }) => {
    const draft = await social.draft({ account: account.id, origin: "person", ...input });
    const approval = await social.approve(draft.id, { revision: draft.revision, by: "umer", at: "now" });
    return { approval, result: await social.post(approval.id) };
  };
  /** Tokens and the app password stay in the Keystore: never in state, events or errors. */
  const assertNoSecrets = async (...extra: unknown[]) => {
    const seen = JSON.stringify([await social.accounts(), await social.drafts(), await social.posts(), events,
      extra.map((e) => (e instanceof Error ? `${e.message} ${e.stack}` : e))]);
    for (const secret of [fake.password, ...fake.issued]) assert.ok(!seen.includes(secret), "a secret leaked");
  };
  return { fake, clock, store, social, events, account, publish, assertNoSecrets };
}

test("connect signs in on the entryway, posts to the PDS, and seals each secret apart under hashed names", async (t) => {
  const { fake, store, account, social, assertNoSecrets } = await setup(t);
  assert.equal(account.handle, HANDLE);
  assert.equal(account.origin, fake.pds);
  assert.equal(account.phase, "ready");
  assert.deepEqual(fake.hits.map((h) => `${h.server} ${h.nsid}`), ["entryway com.atproto.server.createSession"]);
  const names = [...store.entries.keys()];
  assert.equal(names.length, 2);
  for (const name of names) assert.match(name, /^social\.[A-Za-z0-9_-]{43}$/);
  const values = [...store.entries.values()].map((v) => JSON.parse(v) as Record<string, string>);
  const session = values.find((v) => "accessJwt" in v);
  const login = values.find((v) => "password" in v);
  assert.deepEqual(session, { accessJwt: "access-secret-1", refreshJwt: "refresh-secret-1", did: DID, pds: fake.pds });
  assert.deepEqual(login, { identifier: HANDLE, password: fake.password, service: fake.entryway });
  assert.ok(!("password" in (session ?? {})) && !("accessJwt" in (login ?? {})));
  assert.equal(JSON.stringify(await social.accounts()).includes(DID), false);
  await assertNoSecrets();
});

test("bad connect input is a TypeError; OAuth without options is unsupported; a wrong password is signed-out", async (t) => {
  const { fake, social } = await setup(t);
  const base = { person: "umer", slot: "other" };
  await assert.rejects(social.connect("bluesky", { ...base, identifier: HANDLE }), TypeError);
  await assert.rejects(social.connect("bluesky", { ...base, identifier: HANDLE, appPassword: "x", service: "http://example.com" }), TypeError);
  await assert.rejects(social.connect("bluesky", { ...base, handle: HANDLE, oauth: true }), refused("unsupported"));
  const wrong = await social.connect("bluesky", { ...base, identifier: HANDLE, appPassword: "wrong" }).catch((e: unknown) => e);
  assert.ok(refused("signed-out")(wrong));
  assert.ok(!String((wrong as Error).message).includes("wrong"));
  fake.connectRateLimit = 1_900_000_000;
  const limited = await social.connect("bluesky", { ...base, identifier: HANDLE, appPassword: fake.password }).catch((e: unknown) => e);
  assert.ok(refused("rate-limited")(limited));
  assert.equal((limited as SocialError).until, 1_900_000_000_000);
});

test("a post carries link and hashtag facets at UTF-8 byte offsets, langs, and a stable rkey url", async (t) => {
  const { fake, clock, account, publish, assertNoSecrets } = await setup(t);
  const text = "Héllo 🌍 see https://example.com/umer, #buildinpublic!";
  const { approval, result } = await publish({ text, link: "https://example.com/umer", options: { langs: ["en"] } });
  assert.ok("ok" in result && result.ok, JSON.stringify(result));
  const rkey = String(result.post.attempt?.rkey);
  assert.match(rkey, TID);
  assert.equal(result.remoteId, `at://${DID}/app.bsky.feed.post/${rkey}`);
  assert.equal(result.url, `https://bsky.app/profile/${account.handle}/post/${rkey}`);
  assert.equal(result.post.phase, "posted");
  assert.equal(result.post.id, approval.id);
  const create = fake.hits.find((h) => h.nsid === "com.atproto.repo.createRecord");
  assert.equal(create?.server, "pds");
  const record = fake.records.get(rkey)?.value as { text: string; createdAt: string; langs: string[];
    facets: { index: { byteStart: number; byteEnd: number }; features: Record<string, string>[] }[] };
  assert.equal(record.text, text, "a link already in the text is not appended again");
  assert.equal(record.createdAt, new Date(clock.now()).toISOString());
  assert.deepEqual(record.langs, ["en"]);
  const bytes = new TextEncoder().encode(text);
  const slice = (i: number) => new TextDecoder().decode(bytes.slice(record.facets[i]?.index.byteStart, record.facets[i]?.index.byteEnd));
  assert.deepEqual(record.facets[0], { index: { byteStart: 16, byteEnd: 40 },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/umer" }] });
  assert.equal(slice(0), "https://example.com/umer");
  assert.deepEqual(record.facets[1]?.features, [{ $type: "app.bsky.richtext.facet#tag", tag: "buildinpublic" }]);
  assert.equal(slice(1), "#buildinpublic");
  await assertNoSecrets();
});

test("facets skip numeric tags and URL fragments and count non-ASCII bytes", () => {
  assert.deepEqual(facets("no #1 here, https://a.example/#frag."), [{ index: { byteStart: 12, byteEnd: 35 },
    features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://a.example/#frag" }] }]);
  const tags = facets("ünï #café\n#two");
  assert.deepEqual(tags.map((f) => (f as { index: unknown }).index), [{ byteStart: 6, byteEnd: 12 }, { byteStart: 13, byteEnd: 17 }]);
});

test("images upload as blobs and embed with alt text; a missing link is appended", async (t) => {
  const { fake, publish } = await setup(t);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 9]);
  const { result } = await publish({ text: "Shots from Umer", link: "https://example.com",
    media: [{ data: png, type: "image/png", alt: "a chart" }, { data: jpeg, type: "image/jpeg" }] });
  assert.ok("ok" in result && result.ok);
  assert.deepEqual(fake.blobs, [{ type: "image/png", data: png }, { type: "image/jpeg", data: jpeg }]);
  const record = fake.records.get(String(result.post.attempt?.rkey))?.value as { text: string; embed: unknown };
  assert.equal(record.text, "Shots from Umer https://example.com");
  assert.deepEqual(record.embed, { $type: "app.bsky.embed.images", images: [
    { image: { $type: "blob", ref: { $link: "bafkblob1" }, mimeType: "image/png", size: png.length }, alt: "a chart" },
    { image: { $type: "blob", ref: { $link: "bafkblob2" }, mimeType: "image/jpeg", size: jpeg.length }, alt: "" },
  ] });
});

test("an expired access token refreshes once, and the rotated tokens are sealed before they are used", async (t) => {
  const { fake, store, social, account, assertNoSecrets } = await setup(t);
  fake.expireAccess();
  const sealedFirst: boolean[] = [];
  fake.onCreate = (token) => { sealedFirst.push([...store.entries.values()].some((v) => v.includes(token))); };
  const drafts = await Promise.all(["one", "two"].map((text) => social.draft({ account: account.id, text: `${text} from Umer`, origin: "person" })));
  const approvals = await Promise.all(drafts.map((d) => social.approve(d.id, { revision: d.revision, by: "umer", at: "now" })));
  const results = await Promise.all(approvals.map((a) => social.post(a.id)));
  for (const r of results) assert.ok("ok" in r && r.ok, JSON.stringify(r));
  assert.equal(fake.count("com.atproto.server.refreshSession"), 1, "concurrent posts share one refresh");
  assert.deepEqual(sealedFirst, [true, true]);
  assert.ok([...store.entries.values()].some((v) => v.includes("access-secret-2")));
  assert.ok(![...store.entries.values()].some((v) => v.includes("access-secret-1")));
  assert.equal(fake.records.size, 2);
  await assertNoSecrets();
});

test("a dead refresh token signs in again with the sealed app password", async (t) => {
  const { fake, store, publish, assertNoSecrets } = await setup(t);
  fake.expireAccess();
  fake.expireRefresh();
  const { result } = await publish({ text: "Still here, Umer" });
  assert.ok("ok" in result && result.ok);
  assert.equal(fake.count("com.atproto.server.createSession"), 2);
  assert.equal(fake.hits.filter((h) => h.nsid === "com.atproto.server.createSession").at(-1)?.server, "entryway");
  assert.ok([...store.entries.values()].some((v) => v.includes("access-secret-2")));
  await assertNoSecrets();
});

test("a revoked app password fails the post as signed-out and marks the account", async (t) => {
  const { fake, social, publish, assertNoSecrets } = await setup(t);
  fake.expireAccess();
  fake.expireRefresh();
  fake.password = "app-pass-secret-new";
  const { result } = await publish({ text: "Hello from Umer" });
  assert.ok("ok" in result && !result.ok);
  assert.equal(result.code, "signed-out");
  assert.equal(result.post.phase, "failed");
  assert.equal((await social.accounts())[0]?.phase, "signed-out");
  assert.equal(fake.records.size, 0);
  await assertNoSecrets();
});

test("a retry after an unknown outcome finds the landed post at the same rkey instead of posting twice", async (t) => {
  const { fake, social, publish } = await setup(t);
  fake.drop = "after-create";
  const { approval, result } = await publish({ text: "Once only, Umer" });
  assert.ok("ok" in result && !result.ok);
  assert.equal(result.post.phase, "unknown");
  const rkey = String(result.post.attempt?.rkey);
  const retried = await social.retry(approval.id);
  assert.ok("ok" in retried && retried.ok);
  assert.equal(retried.post.attempt?.rkey, rkey);
  assert.equal(retried.remoteId, `at://${DID}/app.bsky.feed.post/${rkey}`);
  assert.equal(fake.count("com.atproto.repo.createRecord"), 1);
  assert.equal(fake.records.size, 1);
});

test("a retry whose first attempt never landed creates the post at the reserved rkey", async (t) => {
  const { fake, social, publish } = await setup(t);
  fake.drop = "before-create";
  const { approval, result } = await publish({ text: "Second try, Umer" });
  assert.ok("ok" in result && result.post.phase === "unknown");
  const retried = await social.retry(approval.id);
  assert.ok("ok" in retried && retried.ok);
  assert.deepEqual([...fake.records.keys()], [result.post.attempt?.rkey]);
});

test("createRecord on a taken rkey returns this post as posted, and refuses when another record holds it", async (t) => {
  const fake = await fakePds(t);
  const spec = providerSpec(blueskyProvider({ service: fake.entryway }));
  const base = { fetch: globalThis.fetch, now: Date.now, shared: () => { throw new Error("unused"); } };
  const connected = await spec.connect({ identifier: HANDLE, appPassword: fake.password }, base) as Connected;
  const records = new Map<string, Json>(Object.entries(connected.records));
  const ctx: AccountContext = { ...base, setMeta: async () => {},
    account: { id: "bluesky:umer", network: "bluesky", person: "umer", slot: "takeone", handle: HANDLE, origin: fake.pds, phase: "ready", meta: {} },
    records: { get: async (n) => records.get(n) ?? null, set: async (n, v) => { records.set(n, v); }, delete: async (n) => records.delete(n) } };
  const startedAt = Date.UTC(2026, 9, 1, 9, 0, 0);
  const attempt = await spec.prepare?.("approval-umer", startedAt) ?? {};
  const rkey = String(attempt.rkey);
  const draft: Draft = { id: "d", revision: 1, account: ctx.account.id, network: "bluesky", text: "Already there, Umer", title: "",
    link: "", media: [], options: {}, origin: "person", personWritten: [], createdAt: startedAt, updatedAt: startedAt };
  const request = { draft, media: [], key: "approval-umer", attempt, startedAt, retry: false };
  const createdAt = new Date(startedAt).toISOString();
  fake.records.set(rkey, { uri: `at://${DID}/app.bsky.feed.post/${rkey}`, value: { text: draft.text, createdAt } });
  assert.deepEqual(await spec.send?.(request, ctx),
    { remoteId: `at://${DID}/app.bsky.feed.post/${rkey}`, url: `https://bsky.app/profile/${HANDLE}/post/${rkey}` });
  fake.records.set(rkey, { uri: "", value: { text: "Someone else", createdAt } });
  await assert.rejects(spec.send?.(request, ctx) ?? Promise.resolve(), refused("rejected"));
  assert.equal(fake.count("com.atproto.repo.createRecord"), 2);
});

test("429 fails the post as rate-limited and nothing is created", async (t) => {
  const { fake, publish } = await setup(t);
  fake.createRateLimit = 1_900_000_000;
  const { result } = await publish({ text: "Slow down, Umer" });
  assert.ok("ok" in result && !result.ok);
  assert.equal(result.code, "rate-limited");
  assert.equal(result.post.phase, "failed");
  assert.equal(fake.records.size, 0);
});

test("checks enforce graphemes, bytes, media and langs, and warn that titles are ignored", async (t) => {
  const { social, account } = await setup(t);
  const codes = async (input: { text: string; title?: string; options?: { [key: string]: Json };
    media?: { data: Uint8Array; type: string }[] }) => {
    const draft = await social.draft({ account: account.id, origin: "person", ...input });
    return (await social.check(draft.id)).map((i) => `${i.severity}:${i.code}`);
  };
  assert.deepEqual(await codes({ text: "é".repeat(300) }), []);
  assert.deepEqual(await codes({ text: "a".repeat(301) }), ["error:too-long"]);
  assert.deepEqual(await codes({ text: "👨‍👩‍👧‍👦".repeat(150) }), ["error:too-long"], "150 graphemes but 3750 bytes");
  assert.deepEqual(await codes({ text: "hi", title: "Umer" }), ["warning:title-ignored"]);
  assert.deepEqual(await codes({ text: "hi", media: Array.from({ length: 5 }, () => ({ data: png, type: "image/png" })) }), ["error:too-many-media"]);
  assert.deepEqual(await codes({ text: "hi", media: [{ data: png, type: "image/bmp" }] }), ["error:media-type"]);
  assert.deepEqual(await codes({ text: "hi", media: [{ data: new Uint8Array(2_000_001), type: "image/png" }] }), ["error:media-too-large"]);
  assert.deepEqual(await codes({ text: "hi", options: { langs: ["en", "pt-BR"] } }), []);
  assert.deepEqual(await codes({ text: "hi", options: { langs: ["en", "fr", "de", "es"] } }), ["error:bad-option"]);
  assert.deepEqual(await codes({ text: "hi", options: { langs: "en" } }), ["error:bad-option"]);
  assert.deepEqual(await codes({ text: "hi", options: { visibility: "public" } }), ["error:bad-option"]);
});

test("rkeys are valid TIDs, fixed per approval and start time, and sort by time", async () => {
  const spec = providerSpec(blueskyProvider());
  const at = Date.UTC(2026, 9, 1, 9, 0, 0);
  const a = await spec.prepare?.("approval-umer", at);
  assert.match(String(a?.rkey), TID);
  assert.deepEqual(await spec.prepare?.("approval-umer", at), a);
  assert.notEqual((await spec.prepare?.("approval-umer", at + 1))?.rkey, a?.rkey);
  assert.equal(tid(0, 0), "2222222222222");
  assert.equal(tid(2 ** 53 - 1, 1023), "bzzzzzzzzzzzz", "the top bit stays clear");
  assert.ok(tid(at * 1000, 1023) < tid((at + 1) * 1000, 0));
  const decoded = [...String(a?.rkey)].reduce((v, c) => (v << 5n) | BigInt("234567abcdefghijklmnopqrstuvwxyz".indexOf(c)), 0n);
  assert.equal(decoded >> 10n, BigInt(at * 1000));
});

test("disconnect ends the session on the PDS and wipes both sealed records", async (t) => {
  const { fake, store, social, account } = await setup(t);
  await social.disconnect(account.id, { confirm: account.id });
  const end = fake.hits.find((h) => h.nsid === "com.atproto.server.deleteSession");
  assert.deepEqual(end, { server: "pds", nsid: "com.atproto.server.deleteSession", token: "refresh-secret-1" });
  assert.equal(store.entries.size, 0);
  assert.deepEqual(await social.accounts(), []);
});
