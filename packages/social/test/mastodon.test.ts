import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Social, SocialError, mastodonProvider, type Json, type SocialAccount, type SocialEvent } from "../src/index.ts";
import { providerSpec } from "../src/provider.ts";
import { fakeClock, memoryKeystore } from "../src/testing.ts";

const OWNER_TOKEN = "owner-secret-token-umer";
const CLIENT_SECRET = "client-secret-umer-app";
const SECRETS = [OWNER_TOKEN, CLIENT_SECRET, "oauth-secret-token", "code-secret"];
const RESET = Date.UTC(2026, 9, 1, 9, 30, 0);
const MIN = 60_000;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]);

type Fields = { [key: string]: unknown };
type Mode = "ok" | "drop" | "lose" | "limit";

const read = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/** A loopback Mastodon with just enough of the API: apps, OAuth with PKCE, instance, media, statuses, revoke. */
async function fakeMastodon(options: { oauthMetadata?: boolean } = {}) {
  const hits: string[] = [];
  const apps: Fields[] = [];
  const codes = new Map<string, string | null>();
  const tokens = new Set([OWNER_TOKEN]);
  const statuses = new Map<string, Fields>();
  const byKey = new Map<string, string>();
  const keys: string[] = [];
  const media = new Map<string, { polls: number; description: string | null; type: string; size: number }>();
  const revoked: string[] = [];
  const pkce: boolean[] = [];
  let mode: Mode = "ok";
  let seq = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const body = await read(req);
    const route = `${req.method} ${url.pathname}`;
    hits.push(route);
    const reply = (status: number, value?: unknown, headers: Fields = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers as Record<string, string> });
      res.end(value === undefined ? "" : JSON.stringify(value));
    };
    const authed = tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const form = () => new URLSearchParams(body.toString());
    if (route === "GET /.well-known/oauth-authorization-server") {
      return options.oauthMetadata === false ? reply(404, { error: "Not found" })
        : reply(200, { code_challenge_methods_supported: ["S256"], scopes_supported: ["profile", "write:statuses", "write:media"] });
    }
    if (route === "POST /api/v1/apps") {
      const app = JSON.parse(body.toString()) as Fields;
      apps.push(app);
      return reply(200, { client_id: `client-${apps.length}`, client_secret: CLIENT_SECRET });
    }
    if (route === "POST /oauth/token") {
      const f = form(), code = f.get("code") ?? "";
      if (f.get("client_secret") !== CLIENT_SECRET || !codes.has(code) || f.get("redirect_uri") !== apps[0]?.redirect_uris) {
        return reply(400, { error: "invalid_grant" });
      }
      const challenge = codes.get(code);
      codes.delete(code);
      if (challenge) {
        const verifier = f.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== challenge) return reply(400, { error: "invalid_grant" });
        pkce.push(true);
      }
      const token = `oauth-secret-token-${++seq}`;
      tokens.add(token);
      return reply(200, { access_token: token, token_type: "Bearer", scope: "write:statuses write:media profile" });
    }
    if (route === "GET /api/v1/accounts/verify_credentials") {
      return authed ? reply(200, { id: "109", username: "umer", acct: "umer" }) : reply(401, { error: "The access token is invalid" });
    }
    if (route === "GET /api/v2/instance") {
      return reply(200, { domain: "social.example", configuration: {
        statuses: { max_characters: 100, max_media_attachments: 2, characters_reserved_per_url: 23 },
        media_attachments: { supported_mime_types: ["image/png", "image/jpeg"], image_size_limit: 1000, video_size_limit: 5000 },
      } });
    }
    if (route === "POST /oauth/revoke") {
      revoked.push(form().get("token") ?? "");
      return reply(200, {});
    }
    if (!authed) return reply(401, { error: "The access token is invalid" });
    if (route === "POST /api/v2/media") {
      const data = await new Response(body, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
      const file = data.get("file") as File;
      const id = `media-${++seq}`;
      media.set(id, { polls: 0, description: data.get("description") as string | null, type: file.type, size: file.size });
      return reply(202, { id, url: null });
    }
    const mediaId = /^GET \/api\/v1\/media\/(.+)$/.exec(route)?.[1];
    if (mediaId) {
      const m = media.get(mediaId);
      if (!m) return reply(404, {});
      return reply(++m.polls < 2 ? 206 : 200, { id: mediaId });
    }
    if (route === "POST /api/v1/statuses") {
      if (mode === "limit") return reply(429, { error: "Too many requests" }, { "x-ratelimit-reset": new Date(RESET).toISOString() });
      const key = String(req.headers["idempotency-key"] ?? "");
      keys.push(key);
      const known = byKey.get(key);
      if (known) return reply(200, statuses.get(known));
      const id = `status-${++seq}`;
      const status = { id, url: `http://social.example/@umer/${id}`, uri: `http://social.example/users/umer/statuses/${id}`,
        ...JSON.parse(body.toString()) as Fields };
      if (mode === "drop") return reply(200, status);
      statuses.set(id, status);
      byKey.set(key, id);
      if (mode === "lose") return res.destroy();
      return reply(200, status);
    }
    const statusId = /^GET \/api\/v1\/statuses\/(.+)$/.exec(route)?.[1];
    if (statusId) return statuses.has(statusId) ? reply(200, statuses.get(statusId)) : reply(404, { error: "Record not found" });
    reply(404, { error: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin, hits, apps, statuses, keys, media, revoked, pkce,
    setMode(next: Mode) { mode = next; },
    /** What the instance's authorize page does when Umer allows access. */
    authorize(authorizeUrl: string) {
      const code = `code-secret-${++seq}`;
      codes.set(code, new URL(authorizeUrl).searchParams.get("code_challenge"));
      return code;
    },
    count: (route: string) => hits.filter((h) => h === route).length,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function setup() {
  const clock = fakeClock();
  const events: SocialEvent[] = [];
  const social = new Social({ store: memoryKeystore(), providers: [mastodonProvider({ clientName: "Umer's poster" })], now: clock.now });
  social.onState((event) => events.push(event));
  return { social, clock, events };
}

async function connectOwner(social: Social, origin: string): Promise<SocialAccount> {
  const account = await social.connect("mastodon", { person: "umer", slot: "main", instance: origin, accessToken: OWNER_TOKEN });
  assert.ok(!("url" in account));
  return account;
}

/** No token, secret or OAuth code anywhere a host could display or persist it. */
async function assertClean(social: Social, events: SocialEvent[], errors: unknown[] = []) {
  const dump = JSON.stringify([await social.accounts(), await social.drafts(), await social.posts(), events,
    errors.map((e) => (e instanceof Error ? [e.message, e.stack, { ...e }] : e))]);
  for (const secret of SECRETS) assert.ok(!dump.includes(secret), "a secret leaked into state, events or errors");
}

const rejectsWith = async (promise: Promise<unknown>, check: (e: unknown) => boolean) => {
  let caught: unknown;
  await assert.rejects(promise.catch((e: unknown) => { caught = e; throw e; }), check);
  return caught;
};
const failedWith = (c: string) => (e: unknown) => e instanceof SocialError && e.code === c;

async function postNow(social: Social, account: SocialAccount, text: string, extra: { media?: { data: Uint8Array; type: string; alt?: string }[];
  options?: { [key: string]: string | boolean } } = {}) {
  const draft = await social.draft({ account: account.id, text, origin: "person", ...extra });
  const approval = await social.approve(draft.id, { revision: draft.revision, by: "umer", at: "now" });
  return { approval, result: await social.post(approval.id) };
}

test("token connect verifies the owner's token and records the instance's limits", async () => {
  const fake = await fakeMastodon();
  const { social, events } = setup();
  try {
    const account = await connectOwner(social, `${fake.origin}/some/path`);
    assert.equal(account.handle, "@umer@social.example");
    assert.equal(account.origin, fake.origin);
    assert.deepEqual(account.meta, { accountId: "109", maxCharacters: 100, maxMedia: 2, charsPerUrl: 23,
      mediaTypes: ["image/png", "image/jpeg"], imageLimit: 1000, videoLimit: 5000 });
    const bad = await rejectsWith(social.connect("mastodon", { person: "umer", slot: "b", instance: fake.origin, accessToken: "wrong" }),
      failedWith("connect-failed"));
    for (const instance of ["http://social.example", "ftp://127.0.0.1", "social.example", 42]) {
      await assert.rejects(social.connect("mastodon", { person: "umer", slot: "c", instance, accessToken: OWNER_TOKEN }), TypeError);
    }
    await assert.rejects(social.connect("mastodon", { person: "umer", slot: "c", instance: fake.origin }), TypeError);
    await assertClean(social, events, [bad]);
  } finally { await fake.close(); }
});

test("OAuth connect registers one app per instance and redirect, uses PKCE, and checks state", async () => {
  const fake = await fakeMastodon();
  const { social, events } = setup();
  const redirectUri = "http://127.0.0.1:9/callback";
  const errors: unknown[] = [];
  try {
    const accounts: SocialAccount[] = [];
    for (const slot of ["main", "second"]) {
      const flow = await social.connect("mastodon", { person: "umer", slot, instance: fake.origin, redirectUri });
      assert.ok("url" in flow);
      const params = new URL(flow.url).searchParams;
      assert.equal(new URL(flow.url).pathname, "/oauth/authorize");
      assert.equal(params.get("scope"), "write:statuses write:media profile");
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.equal(params.get("redirect_uri"), redirectUri);
      const code = fake.authorize(flow.url);
      accounts.push(await flow.finish(`${redirectUri}?code=${code}&state=${params.get("state")}`));
    }
    assert.equal(fake.count("POST /api/v1/apps"), 1);
    assert.deepEqual(fake.apps[0], { client_name: "Umer's poster", redirect_uris: redirectUri,
      scopes: "write:statuses write:media profile" });
    assert.deepEqual(fake.pkce, [true, true]);
    assert.equal(accounts[0].handle, "@umer@social.example");
    assert.notEqual(accounts[0].id, accounts[1].id);

    const flow = await social.connect("mastodon", { person: "umer", slot: "third", instance: fake.origin, redirectUri });
    assert.ok("url" in flow);
    const state = new URL(flow.url).searchParams.get("state");
    const code = fake.authorize(flow.url);
    errors.push(await rejectsWith(flow.finish(`${redirectUri}?code=${code}&state=forged`), failedWith("connect-failed")));
    errors.push(await rejectsWith(flow.finish(`${redirectUri}?error=access_denied&state=${state}`), failedWith("connect-failed")));
    assert.equal(fake.count("POST /oauth/token"), 2, "a forged or refused callback never reaches the token endpoint");
    await flow.finish(`${redirectUri}?code=${code}&state=${state}`);
    errors.push(await rejectsWith(flow.finish(`${redirectUri}?code=${code}&state=${state}`), failedWith("connect-failed")));

    // The OAuth account posts with its own token, then disconnect revokes it with the cached app.
    const { result } = await postNow(social, accounts[0], "Hello from Umer's OAuth account");
    assert.ok("ok" in result && result.ok);
    await social.disconnect(accounts[0].id, { confirm: accounts[0].id });
    assert.deepEqual(fake.revoked, ["oauth-secret-token-2"]);
    await assertClean(social, events, errors);
  } finally { await fake.close(); }
});

test("an instance without OAuth metadata gets read:accounts and no PKCE", async () => {
  const fake = await fakeMastodon({ oauthMetadata: false });
  const { social } = setup();
  try {
    const redirectUri = "https://umer.example/callback";
    const flow = await social.connect("mastodon", { person: "umer", slot: "main", instance: fake.origin, redirectUri });
    assert.ok("url" in flow);
    const params = new URL(flow.url).searchParams;
    assert.equal(params.get("scope"), "write:statuses write:media read:accounts");
    assert.equal(params.get("code_challenge"), null);
    const account = await flow.finish(`${redirectUri}?code=${fake.authorize(flow.url)}&state=${params.get("state")}`);
    assert.equal(account.handle, "@umer@social.example");
    assert.deepEqual(fake.pkce, []);
  } finally { await fake.close(); }
});

test("a post with an image waits for processing, sends its options, and uses the approval id as Idempotency-Key", async () => {
  const fake = await fakeMastodon();
  const { social, events } = setup();
  try {
    const account = await connectOwner(social, fake.origin);
    const { approval, result } = await postNow(social, account, "Umer's desk today", {
      media: [{ data: PNG, type: "image/png", alt: "A tidy desk" }],
      options: { visibility: "unlisted", language: "en", spoilerText: "desk", sensitive: true },
    });
    assert.ok("ok" in result && result.ok, JSON.stringify(result));
    const [mediaId] = [...fake.media.keys()];
    assert.deepEqual(fake.media.get(mediaId), { polls: 2, description: "A tidy desk", type: "image/png", size: PNG.length });
    assert.deepEqual(fake.keys, [approval.id]);
    const [status] = [...fake.statuses.values()];
    assert.deepEqual({ ...status, id: undefined, url: undefined, uri: undefined }, { id: undefined, url: undefined, uri: undefined,
      status: "Umer's desk today", media_ids: [mediaId], visibility: "unlisted", language: "en", spoiler_text: "desk", sensitive: true });
    assert.equal(result.remoteId, status.id);
    assert.equal(result.url, status.url);
    assert.equal(result.post.phase, "posted");
    assert.equal(fake.count(`GET /api/v1/statuses/${String(status.id)}`), 1, "the post was read back");
    await assertClean(social, events);
  } finally { await fake.close(); }
});

test("a status the instance silently dropped fails as rejected", async () => {
  const fake = await fakeMastodon();
  const { social, events } = setup();
  try {
    const account = await connectOwner(social, fake.origin);
    fake.setMode("drop");
    const { result } = await postNow(social, account, "Hello @someone@elsewhere.example");
    assert.ok("ok" in result && !result.ok);
    assert.equal(result.code, "rejected");
    assert.equal(result.post.phase, "failed");
    await assertClean(social, events);
  } finally { await fake.close(); }
});

test("retry after an unknown outcome re-sends with the same Idempotency-Key and does not duplicate", async () => {
  const fake = await fakeMastodon();
  const { social, events, clock } = setup();
  try {
    const account = await connectOwner(social, fake.origin);
    fake.setMode("lose");
    const { approval, result } = await postNow(social, account, "Lost on the way back");
    assert.ok("ok" in result && !result.ok);
    assert.equal(result.post.phase, "unknown");
    fake.setMode("ok");
    clock.advance(30 * MIN);
    const again = await social.retry(approval.id);
    assert.ok("ok" in again && again.ok);
    assert.deepEqual(fake.keys, [approval.id, approval.id]);
    assert.equal(fake.statuses.size, 1);
    assert.equal(again.remoteId, [...fake.statuses.keys()][0]);
    await assertClean(social, events);
  } finally { await fake.close(); }
});

test("retry after 55 minutes does not send, so an expired key cannot double post", async () => {
  const fake = await fakeMastodon();
  const { social, events, clock } = setup();
  try {
    const account = await connectOwner(social, fake.origin);
    fake.setMode("lose");
    const { approval } = await postNow(social, account, "Lost on the way back");
    fake.setMode("ok");
    clock.advance(56 * MIN);
    const before = fake.hits.length;
    const again = await social.retry(approval.id);
    assert.ok("ok" in again && !again.ok);
    assert.equal(again.code, "network");
    assert.equal(again.post.phase, "unknown");
    assert.equal(fake.hits.length, before, "nothing reached the instance");
    await assertClean(social, events);
  } finally { await fake.close(); }
});

test("429 fails the post as rate-limited, with the reset time", async () => {
  const fake = await fakeMastodon();
  const { social, events } = setup();
  try {
    const account = await connectOwner(social, fake.origin);
    fake.setMode("limit");
    const { result } = await postNow(social, account, "Too fast");
    assert.ok("ok" in result && !result.ok);
    assert.equal(result.code, "rate-limited");
    assert.equal(result.post.phase, "failed");

    const spec = providerSpec(mastodonProvider());
    const draft = (await social.drafts())[0];
    const error = await rejectsWith(spec.send!({ draft, media: [], key: "k1", attempt: {}, startedAt: 0, retry: false }, {
      fetch, now: Date.now, account, setMeta: async () => undefined,
      shared: () => { throw new Error("unused"); },
      records: { get: async () => ({ accessToken: OWNER_TOKEN, scope: null, redirectUri: null }), set: async () => undefined,
        delete: async () => true },
    }), failedWith("rate-limited"));
    assert.equal((error as SocialError).until, RESET);
    await assertClean(social, events, [error]);
  } finally { await fake.close(); }
});

test("check() applies the instance's limits and Mastodon's link counting", async () => {
  const fake = await fakeMastodon();
  const { social } = setup();
  try {
    const account = await connectOwner(social, fake.origin);
    const codes = async (input: Parameters<Social["draft"]>[0]) =>
      (await social.check((await social.draft(input)).id)).map((i) => `${i.severity}:${i.code}${i.limit ? `:${i.limit}` : ""}`);
    // 70 letters + space + one long link counted as 23 = 94 of 100.
    const text = `${"a".repeat(70)} https://umer.example/${"x".repeat(200)}`;
    assert.deepEqual(await codes({ account: account.id, text, origin: "person" }), []);
    assert.deepEqual(await codes({ account: account.id, text, link: "https://umer.example/launch", origin: "person" }),
      ["error:too-long:100"]);
    assert.deepEqual(await codes({ account: account.id, text, link: "https://umer.example/x", origin: "person",
      options: { spoilerText: "x".repeat(10) } }), ["error:too-long:100"]);
    assert.deepEqual(await codes({ account: account.id, text: "Hi", title: "Ignored", origin: "agent",
      media: [{ data: PNG, type: "image/gif" }, { data: new Uint8Array(1001), type: "image/png" }, { data: PNG, type: "image/png" }],
      options: { visibility: "friends" } }),
    ["error:bad-option", "error:too-many-media:2", "error:media-type", "error:media-too-large:1000", "warning:title-ignored",
      "warning:ai-disclosure"]);
    const bad: { [key: string]: Json }[] = [{ language: "eng" }, { sensitive: "yes" }, { spoilerText: 1 }, { langs: ["en"] },
      { hasOwnProperty: "visibility" }];
    for (const options of bad) {
      assert.deepEqual(await codes({ account: account.id, text: "Hi", origin: "person", options }), ["error:bad-option"]);
    }
  } finally { await fake.close(); }
});
