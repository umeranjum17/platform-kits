import { SocialError } from "./errors.ts";
import { defineProvider, type Connected, type MediaFile, type ProviderRecords, type SocialProvider } from "./provider.ts";
import type { Draft, DraftField, Json, SocialIssue } from "./types.ts";
import { b64url, graphemes, sha256 } from "./util.ts";

export interface MastodonOptions {
  /** Name shown on the instance's authorization page. */
  clientName?: string;
  website?: string;
}
export type MastodonConnect =
  | { person: string; slot: string; instance: string; redirectUri: string }
  | { person: string; slot: string; instance: string; accessToken: string };

// The instance keeps an Idempotency-Key for an hour. Past this a re-send could post twice, so a person checks instead.
const KEY_TTL_MS = 55 * 60_000;
const MEDIA_WAIT_MS = 60_000;
const VISIBILITY = ["public", "unlisted", "private", "direct"];
const URLS = /https?:\/\/\S+/g;

type Fields = { [key: string]: unknown };
type App = { clientId: string; clientSecret: string; scope: string };
const fields = (value: unknown): Fields => (value !== null && typeof value === "object" ? value as Fields : {});
const str = (value: unknown): value is string => typeof value === "string" && value !== "";
const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const json = async (res: Response): Promise<Fields> => fields(await res.json().catch(() => null));
const drain = async (res: Response | null) => { await res?.body?.cancel().catch(() => undefined); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (bytes: number) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
const parses = (value: string) => { try { return new URL(value); } catch { return null; } };

/** The link joins the text unless the text already has it, exactly as it is published. */
const statusText = (draft: Draft): string =>
  draft.link && !draft.text.includes(draft.link) ? [draft.text, draft.link].filter(Boolean).join("\n\n") : draft.text;

/**
 * fetch with the kit's error mapping; failed bodies are never read into an error. 413/422 map to `failure`,
 * a definite refusal; anything else unexpected is `network`, which keeps a post `unknown`.
 */
async function call(f: typeof fetch, url: string, init: RequestInit = {},
  failure: "rejected" | "media-processing" | "connect-failed" = "rejected"): Promise<Response> {
  let res: Response;
  try { res = await f(url, init); } catch { throw new SocialError("network"); }
  if (res.ok) return res;
  await drain(res);
  if (res.status === 429) {
    const until = Date.parse(res.headers.get("x-ratelimit-reset") ?? "");
    throw new SocialError("rate-limited", Number.isFinite(until) ? { until } : {});
  }
  if (failure === "connect-failed") throw new SocialError(failure);
  if (res.status === 401 || res.status === 403) throw new SocialError("signed-out");
  if (res.status === 413 || res.status === 422) throw new SocialError(failure);
  throw new SocialError("network");
}

function instanceOrigin(value: unknown): string {
  const url = typeof value === "string" ? parses(value) : null;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url?.hostname ?? "");
  if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new TypeError("instance must be an https origin");
  }
  return url.origin;
}

async function readApp(records: ProviderRecords): Promise<App | null> {
  const app = fields(await records.get("client"));
  return str(app.clientId) && str(app.clientSecret) && str(app.scope)
    ? { clientId: app.clientId, clientSecret: app.clientSecret, scope: app.scope } : null;
}

/** Verify the token, then read the instance's limits (defaults when the instance does not say). */
async function connected(f: typeof fetch, origin: string, accessToken: string, scope: string | null,
  redirectUri: string | null): Promise<Connected> {
  const me = await json(await call(f, `${origin}/api/v1/accounts/verify_credentials`, { headers: bearer(accessToken) },
    "connect-failed"));
  if (!str(me.id) || !str(me.username)) throw new SocialError("connect-failed");
  const info = await call(f, `${origin}/api/v2/instance`).then(json, () => ({} as Fields));
  const config = fields(info.configuration), statuses = fields(config.statuses), media = fields(config.media_attachments);
  const meta: { [key: string]: Json } = {
    accountId: me.id,
    maxCharacters: num(statuses.max_characters, 500),
    maxMedia: num(statuses.max_media_attachments, 4),
    charsPerUrl: num(statuses.characters_reserved_per_url, 23),
  };
  if (Array.isArray(media.supported_mime_types)) meta.mediaTypes = media.supported_mime_types.filter(str);
  if (num(media.image_size_limit, 0)) meta.imageLimit = num(media.image_size_limit, 0);
  if (num(media.video_size_limit, 0)) meta.videoLimit = num(media.video_size_limit, 0);
  const domain = str(info.domain) && /^[a-z0-9.-]+$/i.test(info.domain) ? info.domain : new URL(origin).host;
  return { handle: `@${me.username}@${domain}`, origin, remoteId: me.id, meta,
    records: { token: { accessToken, scope, redirectUri } } };
}

async function upload(f: typeof fetch, origin: string, auth: { authorization: string }, media: MediaFile): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([media.data as Uint8Array<ArrayBuffer>], { type: media.type }), "media");
  if (media.alt) form.append("description", media.alt);
  const res = await call(f, `${origin}/api/v2/media`, { method: "POST", headers: auth, body: form }, "media-processing");
  const { id } = await json(res);
  if (!str(id)) throw new SocialError("media-processing");
  // 202: still processing. Poll until 200 (206 while pending), bounded; the status is not sent yet, so a timeout is safe.
  let ready = res.status === 200;
  for (let wait = 250, waited = 0; !ready; waited += wait, wait = Math.min(wait * 2, 4_000)) {
    if (waited >= MEDIA_WAIT_MS) throw new SocialError("media-processing");
    await sleep(wait);
    const poll = await call(f, `${origin}/api/v1/media/${encodeURIComponent(id)}`, { headers: auth }, "media-processing");
    await drain(poll);
    ready = poll.status === 200;
  }
  return id;
}

const optionValid = new Map<string, (value: Json) => boolean>([
  ["visibility", (v) => typeof v === "string" && VISIBILITY.includes(v)],
  ["language", (v) => typeof v === "string" && /^[a-z]{2}$/.test(v)],
  ["spoilerText", (v) => typeof v === "string"],
  ["sensitive", (v) => typeof v === "boolean"],
]);

/**
 * Mastodon, on any instance. Connect with an owner-generated access token, or OAuth (authorization code, PKCE S256
 * where the instance supports it). The app registration is cached once per instance and redirect URI.
 * Options: `visibility` (public|unlisted|private|direct), `language` (ISO 639-1), `spoilerText`, `sensitive`.
 */
export function mastodonProvider(options: MastodonOptions = {}): SocialProvider {
  return defineProvider({
    network: "mastodon", publish: "api", review: "none", needs: [], humanAuthored: [],

    async connect(input, ctx) {
      const { instance, accessToken, redirectUri } = fields(input);
      const origin = instanceOrigin(instance);
      if (accessToken !== undefined) {
        if (!str(accessToken)) throw new TypeError("accessToken must be a non-empty string");
        return connected(ctx.fetch, origin, accessToken, null, null);
      }
      if (!str(redirectUri) || !parses(redirectUri)) throw new TypeError("connect needs an accessToken or a redirectUri URL");

      const metadata = await ctx.fetch(`${origin}/.well-known/oauth-authorization-server`)
        .then((res): Promise<unknown> => (res.ok ? res.json() : drain(res).then(() => null))).catch(() => null);
      const methods = fields(metadata).code_challenge_methods_supported;
      const pkce = Array.isArray(methods) && methods.includes("S256");
      const scopes = fields(metadata).scopes_supported;
      const records = ctx.shared(["app", origin, redirectUri]);
      let app = await readApp(records);
      if (!app) {
        // Registration is throttled per IP, so one app serves every account on this instance and redirect.
        const scope = `write:statuses write:media read:statuses ${Array.isArray(scopes) && scopes.includes("profile") ? "profile" : "read:accounts"}`;
        const made = await json(await call(ctx.fetch, `${origin}/api/v1/apps`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: options.clientName ?? "Social kit", redirect_uris: redirectUri, scopes: scope,
            ...(options.website ? { website: options.website } : {}) }),
        }, "connect-failed"));
        if (!str(made.client_id) || !str(made.client_secret)) throw new SocialError("connect-failed");
        app = { clientId: made.client_id, clientSecret: made.client_secret, scope };
        await records.set("client", app);
      }
      const { clientId, clientSecret, scope } = app;

      const state = random(16), verifier = random(32);
      const url = new URL("/oauth/authorize", origin);
      url.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope, state,
        ...(pkce ? { code_challenge: b64url(await sha256(verifier)), code_challenge_method: "S256" } : {}) }).toString();
      let open = true;
      return {
        url: url.href,
        cancel: () => { open = false; },
        async finish(callback) {
          const params = callback.searchParams, code = params.get("code");
          if (!open || params.has("error") || params.get("state") !== state || !str(code)) throw new SocialError("connect-failed");
          open = false;
          const token = await json(await call(ctx.fetch, `${origin}/oauth/token`, {
            method: "POST",
            body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret,
              redirect_uri: redirectUri, code, ...(pkce ? { code_verifier: verifier } : {}) }),
          }, "connect-failed"));
          if (!str(token.access_token)) throw new SocialError("connect-failed");
          return connected(ctx.fetch, origin, token.access_token, str(token.scope) ? token.scope : scope, redirectUri);
        },
      };
    },

    check(draft, account) {
      const meta = account.meta, opts = draft.options, issues: SocialIssue[] = [];
      const error = (code: string, field: DraftField, limit?: number) =>
        issues.push({ code, severity: "error", field, ...(limit === undefined ? {} : { limit }) });
      if (Object.entries(opts).some(([key, value]) => optionValid.get(key)?.(value) !== true)) {
        error("bad-option", "options");
      }
      // Mastodon counts every link as a fixed length and the content warning toward the limit.
      const text = statusText(draft), limit = num(meta.maxCharacters, 500);
      const length = graphemes(text.replace(URLS, "")) + (text.match(URLS)?.length ?? 0) * num(meta.charsPerUrl, 23)
        + graphemes(typeof opts.spoilerText === "string" ? opts.spoilerText : "");
      if (length > limit) error("too-long", "text", limit);
      const maxMedia = num(meta.maxMedia, 4);
      if (draft.media.length > maxMedia) error("too-many-media", "media", maxMedia);
      const types = Array.isArray(meta.mediaTypes) ? meta.mediaTypes : null;
      if (types && draft.media.some((m) => !types.includes(m.type))) error("media-type", "media");
      for (const m of draft.media) {
        const cap = num(m.type.startsWith("image/") ? meta.imageLimit : meta.videoLimit, Infinity);
        if (m.size > cap) { error("media-too-large", "media", cap); break; }
      }
      if (draft.title.trim()) issues.push({ code: "title-ignored", severity: "warning", field: "title" });
      // Many instances require disclosing generative-AI use.
      if (draft.origin === "agent") issues.push({ code: "ai-disclosure", severity: "warning", field: "text" });
      return issues;
    },

    async send(request, ctx) {
      if (request.retry && ctx.now() - request.startedAt > KEY_TTL_MS) throw new SocialError("network");
      const token = fields(await ctx.records.get("token"));
      if (!str(token.accessToken)) throw new SocialError("signed-out");
      const origin = ctx.account.origin, auth = bearer(token.accessToken), { draft } = request, o = draft.options;
      const mediaIds: string[] = [];
      for (const media of request.media) mediaIds.push(await upload(ctx.fetch, origin, auth, media));
      const status = await json(await call(ctx.fetch, `${origin}/api/v1/statuses`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "idempotency-key": request.key },
        body: JSON.stringify({ status: statusText(draft), media_ids: mediaIds, visibility: o.visibility, language: o.language,
          spoiler_text: o.spoilerText, sensitive: o.sensitive }),
      }));
      if (!str(status.id)) throw new SocialError("network");
      // Antispam can answer with a status it never kept; only a read-back shows it exists. Other read failures say nothing.
      const kept = await ctx.fetch(`${origin}/api/v1/statuses/${encodeURIComponent(status.id)}`, { headers: auth })
        .catch(() => null);
      await drain(kept);
      if (kept?.status === 404) throw new SocialError("rejected");
      const url = str(status.url) ? status.url : str(status.uri) ? status.uri : undefined;
      return { remoteId: status.id, ...(url ? { url } : {}) };
    },

    async disconnect(ctx) {
      const token = fields(await ctx.records.get("token"));
      if (!str(token.accessToken) || !str(token.redirectUri)) return;
      const app = await readApp(ctx.shared(["app", ctx.account.origin, token.redirectUri]));
      if (!app) return;
      await drain(await call(ctx.fetch, `${ctx.account.origin}/oauth/revoke`, {
        method: "POST",
        body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, token: token.accessToken }),
      }));
    },
  });
}
