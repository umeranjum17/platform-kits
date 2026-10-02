import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { atprotoLoopbackClientMetadata } from "@atproto/oauth-client";
import { blueskyOAuth, WebCryptoKey } from "../src/bluesky-oauth.ts";
import type { BlueskyOAuthOptions } from "../src/bluesky.ts";
import { Social, SocialError, defineProvider, memoryQueue, type ProviderContext, type ProviderRecords,
  type SocialEvent } from "../src/index.ts";
import { memoryKeystore } from "../src/testing.ts";
import type { Json } from "../src/types.ts";
import { b64url, sha256 } from "../src/util.ts";

const DID = "did:plc:umerumerumerumerumerumer";
const HANDLE = "umer.test";
const REDIRECT = "http://127.0.0.1/callback";
const CLIENT_ID = `http://localhost?redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent("atproto transition:generic")}`;

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as { [k: string]: unknown };

/** Verify a compact ES256 JWS with Web Crypto against a public JWK; returns header and payload. */
async function verifyJws(jwt: string, jwk?: JsonWebKey) {
  const [h, p, s] = jwt.split(".") as [string, string, string];
  const header = decode(h);
  const { kty, crv, x, y } = (jwk ?? header.jwk) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(s, "base64url"),
    new TextEncoder().encode(`${h}.${p}`));
  return { ok, header, payload: decode(p) };
}

// ---- a loopback PDS + PLC directory + authorization server ----

const server = {
  origin: "",
  tokens: 0,
  valid: new Set<string>(),
  refreshes: new Set<string>(),
  revoked: [] as string[],
  par: new Map<string, URLSearchParams>(),
  codes: new Map<string, URLSearchParams>(),
  posts: [] as { auth: string; body: unknown }[],
  proofs: 0,
};
const http = createServer((req, res) => { void route(req, res).catch((error) => { res.writeHead(500).end(String(error)); }); });
const json = (res: ServerResponse, status: number, body: unknown, headers: { [k: string]: string } = {}): void => {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
};

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

/** RFC 9449 checks a real server makes: signature, htm, htu, nonce, and ath when a token is presented. */
async function dpop(req: IncomingMessage, path: string, token?: string): Promise<string | null> {
  const proof = req.headers.dpop;
  if (typeof proof !== "string") return null;
  const { ok, header, payload } = await verifyJws(proof);
  if (!ok || header.typ !== "dpop+jwt" || header.alg !== "ES256" || payload.htm !== req.method
    || payload.htu !== server.origin + path) return null;
  if (token && payload.ath !== b64url(await sha256(token))) return null;
  server.proofs++;
  return typeof payload.nonce === "string" ? payload.nonce : "";
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", server.origin);
  const o = server.origin;
  switch (`${req.method} ${decodeURIComponent(url.pathname)}`) {
    case "GET /xrpc/com.atproto.identity.resolveHandle":
      return url.searchParams.get("handle") === HANDLE ? json(res, 200, { did: DID }) : json(res, 400, { error: "InvalidRequest" });
    case `GET /${DID}`:
      return json(res, 200, { "@context": ["https://www.w3.org/ns/did/v1"], id: DID, alsoKnownAs: [`at://${HANDLE}`],
        service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: o }] });
    case "GET /.well-known/oauth-protected-resource":
      return json(res, 200, { resource: o, authorization_servers: [o] });
    case "GET /.well-known/oauth-authorization-server":
      return json(res, 200, {
        issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`,
        pushed_authorization_request_endpoint: `${o}/oauth/par`, revocation_endpoint: `${o}/oauth/revoke`,
        require_pushed_authorization_requests: true, response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"], token_endpoint_auth_signing_alg_values_supported: ["ES256"],
        scopes_supported: ["atproto", "transition:generic"], dpop_signing_alg_values_supported: ["ES256"],
        authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true,
        response_modes_supported: ["query", "fragment"],
      });
    case "POST /oauth/par": {
      const nonce = await dpop(req, "/oauth/par");
      if (nonce === null) return json(res, 400, { error: "invalid_dpop_proof" });
      if (nonce !== "n1") return json(res, 400, { error: "use_dpop_nonce" }, { "DPoP-Nonce": "n1" });
      const form = await readForm(req);
      if (form.get("client_id") !== CLIENT_ID || form.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
      const requestUri = `urn:ietf:params:oauth:request_uri:req-${server.par.size + 1}`;
      server.par.set(requestUri, form);
      return json(res, 201, { request_uri: requestUri, expires_in: 60 });
    }
    case "GET /oauth/authorize": {
      // Stands in for the person signing in and approving: redirect straight back with a code.
      const form = server.par.get(url.searchParams.get("request_uri") ?? "");
      if (!form || url.searchParams.get("client_id") !== CLIENT_ID) return json(res, 400, { error: "invalid_request" });
      const code = `code-${server.codes.size + 1}`;
      server.codes.set(code, form);
      const back = new URL(form.get("redirect_uri") as string);
      back.search = new URLSearchParams({ state: form.get("state") as string, iss: o, code }).toString();
      return void res.writeHead(302, { location: back.toString() }).end();
    }
    case "POST /oauth/token": {
      if ((await dpop(req, "/oauth/token")) === null) return json(res, 400, { error: "invalid_dpop_proof" });
      const form = await readForm(req);
      if (form.get("grant_type") === "refresh_token") {
        if (!server.refreshes.has(form.get("refresh_token") ?? "")) return json(res, 400, { error: "invalid_grant" });
      } else {
        const request = server.codes.get(form.get("code") ?? "");
        server.codes.delete(form.get("code") ?? "");
        const challenge = request && b64url(await sha256(form.get("code_verifier") ?? ""));
        if (!request || challenge !== request.get("code_challenge")) return json(res, 400, { error: "invalid_grant" });
      }
      const n = ++server.tokens;
      server.valid.add(`at-secret-${n}`);
      server.refreshes.add(`rt-secret-${n}`);
      return json(res, 200, { access_token: `at-secret-${n}`, refresh_token: `rt-secret-${n}`, token_type: "DPoP",
        scope: "atproto transition:generic", sub: DID, expires_in: 3600 });
    }
    case "POST /oauth/revoke": {
      const token = (await readForm(req)).get("token") ?? "";
      server.revoked.push(token);
      server.valid.delete(token);
      return json(res, 200, {});
    }
    case "POST /xrpc/com.atproto.repo.createRecord": {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("DPoP ") ? auth.slice(5) : "";
      if (!server.valid.has(token) || (await dpop(req, "/xrpc/com.atproto.repo.createRecord", token)) === null) {
        return json(res, 401, { error: "InvalidToken" }, { "WWW-Authenticate": 'DPoP error="invalid_token"' });
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      server.posts.push({ auth, body: JSON.parse(body) });
      return json(res, 200, { uri: `at://${DID}/app.bsky.feed.post/3k${server.posts.length}`, cid: "bafy" });
    }
  }
  json(res, 404, { error: "NotFound" });
}

const realFetch = globalThis.fetch;
let options: BlueskyOAuthOptions;
before(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  server.origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  options = { clientMetadata: atprotoLoopbackClientMetadata(CLIENT_ID), handleResolver: server.origin,
    plcDirectoryUrl: server.origin, allowHttp: true };
  // Everything must go through ctx.fetch: the global one fails loudly.
  globalThis.fetch = () => { throw new Error("global fetch used"); };
});
after(() => {
  globalThis.fetch = realFetch;
  http.close();
});

/** A ProviderContext whose shared records live in one Map, like the kit's sealed Keystore records. */
function fakeContext() {
  const sealed = new Map<string, string>();
  const shared = (parts: readonly string[]): ProviderRecords => {
    const key = (name: string) => JSON.stringify([...parts, name]);
    return {
      async get(name) { const raw = sealed.get(key(name)); return raw === undefined ? null : JSON.parse(raw) as Json; },
      async set(name, value) { sealed.set(key(name), JSON.stringify(value)); },
      async delete(name) { return sealed.delete(key(name)); },
    };
  };
  const ctx: ProviderContext = { fetch: (input, init) => realFetch(input, init), now: Date.now, shared };
  return { ctx, sealed };
}

/** Follow the authorization URL the way a browser would, returning the redirect back to the app. */
async function signIn(url: string): Promise<URL> {
  const response = await realFetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location") as string);
}

const createRecord = (text: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ repo: DID, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text } }) });

test("WebCryptoKey signs an ES256 JWS that verifies against its public JWK, also after JSON storage", async () => {
  const key = await WebCryptoKey.generate();
  assert.equal(key.alg, "ES256");
  assert.deepEqual(key.algorithms, ["ES256"]);
  const jwk = key.privateJwk as JsonWebKey & { kid: string };
  assert.ok(jwk.d && jwk.kid);
  const restored = new WebCryptoKey(JSON.parse(JSON.stringify(jwk)));
  for (const signer of [key, restored]) {
    const jwt = await signer.createJwt({ typ: "dpop+jwt", jwk: key.bareJwk, kid: jwk.kid } as never, { htm: "POST", iat: 1 } as never);
    const { ok, header, payload } = await verifyJws(jwt, key.publicJwk as JsonWebKey);
    assert.ok(ok);
    assert.equal(header.alg, "ES256");
    assert.equal(header.kid, jwk.kid);
    assert.deepEqual(header.jwk, { ...key.bareJwk });
    assert.equal((header.jwk as { d?: string }).d, undefined);
    assert.deepEqual(payload, { htm: "POST", iat: 1 });
  }
  assert.throws(() => new WebCryptoKey({ kty: "EC", crv: "P-256", x: "a", y: "b", alg: "ES256" } as never), TypeError);
  assert.throws(() => key.verifyJwt(), TypeError);
});

test("authorize, finish, fetchHandler and revoke run the PAR + PKCE + DPoP flow on loopback", async () => {
  const { ctx, sealed } = fakeContext();
  const oauth = blueskyOAuth(options, ctx, "g1");
  const flow = await oauth.authorize(HANDLE);
  const url = new URL(flow.url);
  assert.equal(url.origin + url.pathname, `${server.origin}/oauth/authorize`);
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.match(url.searchParams.get("request_uri") ?? "", /^urn:ietf:params:oauth:request_uri:/);
  const pending = [...sealed.entries()].filter(([k]) => k.startsWith('["oauth-state"'));
  assert.equal(pending.length, 1);
  assert.match(pending[0]![1], /"d":/, "the DPoP private key is kept only in the sealed state record");

  const result = await flow.finish(await signIn(flow.url));
  assert.deepEqual(result, { did: DID, handle: HANDLE, pds: server.origin });
  assert.equal([...sealed.keys()].filter((k) => k.startsWith('["oauth-state"')).length, 0, "state is consumed");
  const stored = sealed.get(JSON.stringify(["oauth-session", "g1", DID])) ?? "";
  assert.match(stored, /at-secret-\d/);
  assert.match(stored, /"dpopKey":\{[^}]*"d":/);

  const fetchPds = await oauth.fetchHandler(DID);
  const response = await fetchPds("/xrpc/com.atproto.repo.createRecord", createRecord("Hello from Umer"));
  assert.equal(response.status, 200);
  assert.match(server.posts.at(-1)!.auth, /^DPoP at-secret-\d+$/);

  // A fresh instance over the same sealed records restores the session (keys rebuilt from JWK).
  const again = await blueskyOAuth(options, ctx, "g1").fetchHandler(DID);
  assert.equal((await again("/xrpc/com.atproto.repo.createRecord", createRecord("again"))).status, 200);

  const token = /at-secret-\d+/.exec(stored)![0];
  await oauth.revoke(DID);
  assert.ok(server.revoked.includes(token));
  assert.equal(sealed.get(JSON.stringify(["oauth-session", "g1", DID])), undefined);
  await assert.rejects(oauth.fetchHandler(DID), (e) => e instanceof SocialError && e.code === "signed-out");
  await assert.rejects(blueskyOAuth(options, ctx, "g1").fetchHandler(DID), (e) => e instanceof SocialError && e.code === "signed-out");
});

test("cancel drops the pending state record; a bad callback fails without server text", async () => {
  const { ctx, sealed } = fakeContext();
  const oauth = blueskyOAuth(options, ctx, "g1");
  const flow = await oauth.authorize(HANDLE);
  assert.equal(sealed.size, 1);
  flow.cancel();
  await new Promise((r) => setImmediate(r));
  assert.equal(sealed.size, 0);
  await assert.rejects(flow.finish(new URL(`${REDIRECT}?state=nope&code=x`)),
    (e) => e instanceof SocialError && e.code === "connect-failed" && !e.message.includes("nope"));
  await assert.rejects(oauth.authorize(" "), TypeError);
  await assert.rejects(oauth.authorize("nobody.test"), (e) => e instanceof SocialError && e.code === "connect-failed");
});

test("end to end through Social: connect, draft, approve, post with DPoP; secrets never leave the Keystore", async () => {
  const provider = defineProvider({
    network: "bluesky", publish: "api", review: "none", needs: [], humanAuthored: [],
    async connect(input, ctx) {
      const grant = crypto.randomUUID();
      const flow = await blueskyOAuth(options, ctx, grant).authorize((input as { handle: string }).handle);
      return { url: flow.url, cancel: flow.cancel, finish: async (callback) => {
        const r = await flow.finish(callback);
        return { handle: r.handle, origin: r.pds, remoteId: r.did, meta: { did: r.did, grant }, records: {} };
      } };
    },
    check: () => [],
    async send(request, ctx) {
      const pds = await blueskyOAuth(options, ctx, String(ctx.account.meta.grant)).fetchHandler(String(ctx.account.meta.did));
      const response = await pds("/xrpc/com.atproto.repo.createRecord", createRecord(request.draft.text));
      if (response.status === 401) throw new SocialError("signed-out");
      if (!response.ok) throw new SocialError("rejected");
      return { remoteId: ((await response.json()) as { uri: string }).uri };
    },
    async disconnect(ctx) { await blueskyOAuth(options, ctx, String(ctx.account.meta.grant)).revoke(String(ctx.account.meta.did)); },
  });
  const store = memoryKeystore();
  const queue = memoryQueue();
  const social = new Social({ store, queue, providers: [provider], fetch: (input, init) => realFetch(input, init) });
  const events: SocialEvent[] = [];
  social.onState((e) => events.push(e));

  const flow = await social.connect("bluesky", { person: "umer", slot: "main", handle: HANDLE });
  assert.ok("url" in flow);
  const account = await flow.finish(await signIn(flow.url));
  assert.equal(account.handle, HANDLE);
  assert.equal(account.origin, server.origin);

  const draft = await social.draft({ account: account.id, text: "Hello from Umer", origin: "person" });
  const approval = await social.approve(draft.id, { revision: draft.revision, by: "umer", at: "now" });
  const before = server.posts.length;
  const result = await social.post(approval.id);
  assert.ok("ok" in result && result.ok, JSON.stringify(result));
  assert.equal(server.posts.length, before + 1);
  assert.equal((server.posts.at(-1)!.body as { record: { text: string } }).record.text, "Hello from Umer");

  // The server kills every token: the client tries a refresh, it is refused, the session is deleted.
  server.valid.clear();
  server.refreshes.clear();
  const draft2 = await social.draft({ account: account.id, text: "Second from Umer", origin: "person" });
  const approval2 = await social.approve(draft2.id, { revision: draft2.revision, by: "umer", at: "now" });
  const failed = await social.post(approval2.id);
  assert.ok("ok" in failed && !failed.ok && failed.code === "signed-out");
  assert.equal(failed.post.phase, "failed");
  assert.equal((await social.accounts())[0]!.phase, "signed-out");
  const sealedValues = [...store.entries.values()].join("\n");
  assert.ok(!/at-secret|rt-secret/.test(sealedValues), "the refused session is gone from the Keystore");

  // Reconnect, then disconnect revokes remotely and deletes the sealed session.
  const flow2 = await social.connect("bluesky", { person: "umer", slot: "main", handle: HANDLE });
  assert.ok("url" in flow2);
  await flow2.finish(await signIn(flow2.url));
  assert.match([...store.entries.values()].join("\n"), /at-secret-\d+/, "tokens live only in the host Keystore");
  const leakCheck = JSON.stringify([await social.accounts(), await social.drafts(), await social.posts(), events, failed,
    await queue.load()]);
  assert.ok(!/at-secret|rt-secret|"d":"/.test(leakCheck), "no token or key in Social state, events or the queue");
  const live = /at-secret-\d+/.exec([...store.entries.values()].join("\n"))![0];
  await social.disconnect(account.id, { confirm: account.id });
  assert.ok(server.revoked.includes(live));
  assert.ok(!/at-secret|rt-secret/.test([...store.entries.values()].join("\n")));
});
