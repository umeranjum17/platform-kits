import type { OAuthClientMetadataInput } from "@atproto/oauth-client";
import { blueskyOAuth } from "./bluesky-oauth.ts";
import { SocialError } from "./errors.ts";
import { defineProvider, type AccountContext, type ProviderContext, type SocialProvider } from "./provider.ts";
import type { Draft, Json, SocialIssue } from "./types.ts";
import { graphemes, sha256 } from "./util.ts";

export interface BlueskyOAuthOptions {
  /** The app's hosted client metadata (its `client_id` is the metadata URL), or a loopback development client. */
  clientMetadata: OAuthClientMetadataInput;
  /** Origin serving com.atproto.identity.resolveHandle, such as the account's PDS or an AppView. */
  handleResolver: string;
  /** PLC directory for did:plc lookups. Default https://plc.directory. */
  plcDirectoryUrl?: string;
  /** Development only: allow plain-HTTP authorization and resource servers. */
  allowHttp?: boolean;
}
export interface BlueskyOptions {
  /** Entryway for app-password sign-in when the connect input names none. Default https://bsky.social. */
  service?: string;
  /** Web app used for post links. Default https://bsky.app. */
  appView?: string;
  /** Enable AT Protocol OAuth sign-in. Without it only app passwords are accepted. */
  oauth?: BlueskyOAuthOptions;
}
export type BlueskyConnect =
  | { person: string; slot: string; identifier: string; appPassword: string; service?: string }
  | { person: string; slot: string; handle: string; oauth: true };

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
type Session = { accessJwt: string; refreshJwt: string; did: string; pds: string };
type AppPassword = { identifier: string; password: string; service: string };

const POST = "app.bsky.feed.post";
const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
const TID = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const LANG = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{1,8})*$/;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const DEAD_TOKEN = new Set(["ExpiredToken", "InvalidToken"]);
const AUTH_FAILED = new Set(["AuthenticationRequired", "AuthFactorTokenRequired", "AccountTakedown", ...DEAD_TOKEN]);
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;
const str = (value: unknown): value is string => typeof value === "string" && value !== "";
const json = { "content-type": "application/json" };

/** The origin of an https server, or of a loopback http one for development; null for anything else. */
function serverOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : null;
  } catch { return null; }
}

/** An AT Protocol TID: 53-bit microseconds, then a 10-bit clock id, in sortable base32. */
export function tid(micros: number, clockId: number): string {
  let value = (BigInt(Math.trunc(micros)) << 10n) | BigInt(clockId & 1023);
  let out = "";
  for (let i = 0; i < 13; i++, value >>= 5n) out = TID_CHARS[Number(value & 31n)] + out;
  return out;
}

/** The text that is published: the draft text, with the link appended unless the text already carries it. */
const postText = (d: Draft) => !d.link || d.text.includes(d.link) ? d.text : d.text ? `${d.text} ${d.link}` : d.link;

/** Link and hashtag facets, indexed by UTF-8 byte offsets as the lexicon requires. */
export function facets(text: string): Json[] {
  const at = (index: number) => byteLength(text.slice(0, index));
  const out: Json[] = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const uri = m[0].replace(/[.,;:!?'")\]]+$/, "");
    out.push({ index: { byteStart: at(m.index), byteEnd: at(m.index + uri.length) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }] });
  }
  for (const m of text.matchAll(/(^|\s)#(\S+)/gu)) {
    const tag = (m[2] ?? "").replace(/\p{P}+$/u, "");
    if (!tag || /^\d+$/.test(tag) || graphemes(tag) > 64) continue;
    const start = m.index + (m[1] ?? "").length;
    out.push({ index: { byteStart: at(start), byteEnd: at(start + 1 + tag.length) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }
  return out;
}

const errorName = async (res: Response): Promise<string> => {
  const body = await res.clone().json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : "";
};

const rateLimited = (res: Response) => {
  const reset = Number(res.headers.get("ratelimit-reset"));
  return new SocialError("rate-limited", reset > 0 ? { until: reset * 1000 } : {});
};

/** Map a failed PDS response. Only refusals the PDS answered before writing become not-posted codes. */
async function failure(res: Response, nsid: string): Promise<Error> {
  const error = await errorName(res);
  if (res.status === 429) return rateLimited(res);
  if (res.status === 401 || AUTH_FAILED.has(error)) return new SocialError("signed-out");
  if (res.status === 413 || error === "BlobTooLarge") return new SocialError("media-processing");
  if (res.status === 400 && (error === "InvalidRequest" || error === "InvalidRecord")) return new SocialError("rejected");
  return new Error(`bluesky ${nsid} failed with status ${res.status}`);
}

/** POST to a session endpoint. Fetch failures lose their cause, which may name the server. */
async function xrpc(ctx: ProviderContext, origin: string, nsid: string, body?: Json, token?: string): Promise<Response> {
  const headers: Record<string, string> = body === undefined ? {} : { ...json };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    return await ctx.fetch(`${origin}/xrpc/${nsid}`,
      { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw new Error(`bluesky ${nsid} could not be reached`); }
}

function parseSession(body: unknown, pds: string): Session & { handle: string } {
  const b = body as { accessJwt?: unknown; refreshJwt?: unknown; did?: unknown; handle?: unknown; didDoc?: { service?: unknown } } | null;
  if (!str(b?.accessJwt) || !str(b.refreshJwt) || !str(b.did) || !b.did.startsWith("did:")) {
    throw new Error("bluesky returned a malformed session");
  }
  const services = Array.isArray(b.didDoc?.service) ? b.didDoc.service as { id?: unknown; serviceEndpoint?: unknown }[] : [];
  const entry = services.find((s) => typeof s?.id === "string" && s.id.endsWith("#atproto_pds"));
  const endpoint = entry ? serverOrigin(entry.serviceEndpoint) : pds;
  if (!endpoint) throw new Error("bluesky PDS endpoint is not https");
  return { accessJwt: b.accessJwt, refreshJwt: b.refreshJwt, did: b.did, pds: endpoint, handle: str(b.handle) ? b.handle : b.did };
}

async function createSession(ctx: ProviderContext, login: AppPassword): Promise<Session & { handle: string }> {
  const res = await xrpc(ctx, login.service, "com.atproto.server.createSession",
    { identifier: login.identifier, password: login.password });
  if (res.ok) return parseSession(await res.json(), login.service);
  if (res.status === 429) throw rateLimited(res);
  if (res.status === 401 || AUTH_FAILED.has(await errorName(res))) throw new SocialError("signed-out");
  throw new SocialError("connect-failed");
}

const asSession = (v: Json | null): Session | null => {
  const s = v as Partial<Session> | null;
  return s && str(s.accessJwt) && str(s.refreshJwt) && str(s.did) && str(s.pds) ? s as Session : null;
};

/**
 * Bluesky posts through the account's own PDS, signed in with an app password or, when `oauth` is set, AT Protocol
 * OAuth. Each post's record key is a TID fixed before the first attempt, so a retry finds the post instead of
 * creating a second one. Options: `langs`, up to three language tags.
 */
export function blueskyProvider(options: BlueskyOptions = {}): SocialProvider {
  const entryway = options.service ?? "https://bsky.social";
  const appView = (options.appView ?? "https://bsky.app").replace(/\/+$/, "");
  const refreshing = new Map<string, Promise<Session>>();

  /** Rotate a dead access token: refresh, or sign in again with the app password. Persisted before use. */
  async function renew(ctx: AccountContext, stale: Session): Promise<Session> {
    const current = asSession(await ctx.records.get("session"));
    if (current && current.accessJwt !== stale.accessJwt) return current;
    const res = await xrpc(ctx, stale.pds, "com.atproto.server.refreshSession", undefined, stale.refreshJwt);
    let next: Session;
    if (res.ok) {
      next = parseSession(await res.json(), stale.pds);
    } else if (res.status === 429) {
      throw rateLimited(res);
    } else if (res.status === 401 || DEAD_TOKEN.has(await errorName(res))) {
      const login = await ctx.records.get("app-password") as AppPassword | null;
      if (!str(login?.identifier) || !str(login.password) || !str(login.service)) throw new SocialError("signed-out");
      next = await createSession(ctx, login);
    } else {
      throw new Error(`bluesky refreshSession failed with status ${res.status}`);
    }
    // A handle can move to another identity; never post as anyone but the connected DID.
    if (next.did !== stale.did) throw new SocialError("signed-out");
    const session: Session = { accessJwt: next.accessJwt, refreshJwt: next.refreshJwt, did: next.did, pds: next.pds };
    await ctx.records.set("session", session);
    return session;
  }

  function refresh(ctx: AccountContext, stale: Session): Promise<Session> {
    const id = ctx.account.id;
    let pending = refreshing.get(id);
    if (!pending) {
      pending = renew(ctx, stale).finally(() => refreshing.delete(id));
      refreshing.set(id, pending);
    }
    return pending;
  }

  /** A fetch against the account's PDS, plus the repo DID. */
  async function pds(ctx: AccountContext): Promise<{ call: Fetcher; did: string }> {
    const session = asSession(await ctx.records.get("session"));
    if (session) {
      let current = session;
      const go = async (path: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${current.accessJwt}`);
        try { return await ctx.fetch(`${current.pds}${path}`, { ...init, headers }); } catch {
          throw new Error("bluesky PDS could not be reached");
        }
      };
      const call: Fetcher = async (path, init = {}) => {
        const res = await go(path, init);
        if ((res.status !== 400 && res.status !== 401) || !DEAD_TOKEN.has(await errorName(res))) return res;
        current = await refresh(ctx, current);
        return go(path, init);
      };
      return { call, did: session.did };
    }
    const account = await ctx.records.get("account") as { auth?: unknown; did?: unknown } | null;
    if (account?.auth !== "oauth" || !str(account.did)) throw new SocialError("signed-out");
    if (!options.oauth) throw new SocialError("unsupported");
    return { call: await blueskyOAuth(options.oauth, ctx).fetchHandler(account.did), did: account.did };
  }

  return defineProvider({
    network: "bluesky", publish: "api", review: "none", needs: [], humanAuthored: [],

    async connect(input, ctx) {
      const i = (input ?? {}) as { identifier?: unknown; appPassword?: unknown; service?: unknown; handle?: unknown; oauth?: unknown };
      if (i.oauth === true) {
        if (!options.oauth) throw new SocialError("unsupported");
        if (!str(i.handle)) throw new TypeError("Bluesky OAuth sign-in needs a handle");
        const flow = await blueskyOAuth(options.oauth, ctx).authorize(i.handle);
        return {
          url: flow.url,
          cancel: () => flow.cancel(),
          finish: async (callback) => {
            const { did, handle, pds } = await flow.finish(callback);
            return { handle, origin: pds, remoteId: did, records: { account: { auth: "oauth", did } } };
          },
        };
      }
      const service = serverOrigin(i.service ?? entryway);
      if (!str(i.identifier) || !str(i.appPassword) || !service) {
        throw new TypeError("Bluesky needs an identifier, an app password and an https service");
      }
      const login: AppPassword = { identifier: i.identifier, password: i.appPassword, service };
      const { handle, ...session } = await createSession(ctx, login);
      return { handle, origin: session.pds, remoteId: session.did, records: { session, "app-password": login } };
    },

    check(draft): SocialIssue[] {
      const issues: SocialIssue[] = [];
      const error = (code: string, field: SocialIssue["field"], limit?: number) =>
        issues.push({ code, severity: "error", field, ...(limit === undefined ? {} : { limit }) });
      const text = postText(draft);
      if (graphemes(text) > 300 || byteLength(text) > 3000) error("too-long", "text", 300);
      if (text.trim() === "" && draft.media.length === 0) error("empty", "text");
      if (draft.link && !/^https?:\/\/\S+$/.test(draft.link)) error("bad-link", "link");
      if (draft.media.length > 4) error("too-many-media", "media", 4);
      for (const m of draft.media) {
        if (!IMAGE_TYPES.has(m.type)) error("media-type", "media");
        if (m.size > 2_000_000) error("media-too-large", "media", 2_000_000);
      }
      for (const [key, value] of Object.entries(draft.options)) {
        const ok = key === "langs" && Array.isArray(value) && value.length <= 3
          && value.every((l) => typeof l === "string" && LANG.test(l));
        if (!ok) error("bad-option", "options");
      }
      if (draft.title) issues.push({ code: "title-ignored", severity: "warning", field: "title" });
      return issues;
    },

    async prepare(key, startedAt) {
      const [a = 0, b = 0] = await sha256(key);
      return { rkey: tid(startedAt * 1000, (a << 8) | b) };
    },

    async send(request, ctx) {
      const { rkey } = request.attempt;
      if (typeof rkey !== "string" || !TID.test(rkey)) throw new TypeError("a Bluesky send needs the rkey from prepare");
      const { call, did } = await pds(ctx);
      const { draft } = request;
      const text = postText(draft);
      const createdAt = new Date(request.startedAt).toISOString();
      const sent = { remoteId: `at://${did}/${POST}/${rkey}`, url: `${appView}/profile/${ctx.account.handle}/post/${rkey}` };

      /** Whether this post already sits at its rkey. A different record there means ours never landed. */
      const landed = async (): Promise<boolean> => {
        const res = await call(`/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: did, collection: POST, rkey })}`);
        if (res.ok) {
          const { value } = await res.json() as { value?: { text?: unknown; createdAt?: unknown } };
          if (value?.text === text && value.createdAt === createdAt) return true;
          throw new SocialError("rejected");
        }
        if (res.status === 400 && (await errorName(res)) === "RecordNotFound") return false;
        throw await failure(res, "getRecord");
      };
      if (request.retry && await landed()) return sent;

      const images: Json[] = [];
      for (const media of request.media) {
        const res = await call("/xrpc/com.atproto.repo.uploadBlob",
          { method: "POST", headers: { "content-type": media.type }, body: media.data as Uint8Array<ArrayBuffer> });
        if (!res.ok) throw await failure(res, "uploadBlob");
        const { blob } = await res.json() as { blob?: Json };
        if (!blob || typeof blob !== "object") throw new Error("bluesky uploadBlob returned no blob");
        images.push({ image: blob, alt: media.alt });
      }
      const tags = facets(text);
      const langs = draft.options.langs;
      const record: Json = {
        $type: POST, text, createdAt,
        ...(Array.isArray(langs) && langs.length ? { langs } : {}),
        ...(tags.length ? { facets: tags } : {}),
        ...(images.length ? { embed: { $type: "app.bsky.embed.images", images } } : {}),
      };
      const res = await call("/xrpc/com.atproto.repo.createRecord",
        { method: "POST", headers: json, body: JSON.stringify({ repo: did, collection: POST, rkey, record }) });
      if (res.ok) return sent;
      // An earlier attempt may already have created this rkey.
      if (res.status === 400 && await landed()) return sent;
      throw await failure(res, "createRecord");
    },

    async disconnect(ctx) {
      const session = asSession(await ctx.records.get("session"));
      if (session) {
        await xrpc(ctx, session.pds, "com.atproto.server.deleteSession", undefined, session.refreshJwt);
        return;
      }
      const account = await ctx.records.get("account") as { auth?: unknown; did?: unknown } | null;
      if (options.oauth && account?.auth === "oauth" && str(account.did)) await blueskyOAuth(options.oauth, ctx).revoke(account.did);
    },
  });
}
