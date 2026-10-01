// AT Protocol OAuth (PAR + PKCE + DPoP) on @atproto/oauth-client, with Web Crypto keys and sealed provider records.
import { Key, OAuthClient, isExpectedSessionError, type InternalStateData, type Jwk, type JwtHeader, type JwtPayload,
  type Session, type SignedJwt } from "@atproto/oauth-client";
import type { BlueskyOAuthOptions } from "./bluesky.ts";
import { SocialError } from "./errors.ts";
import type { ProviderContext, ProviderRecords } from "./provider.ts";
import type { Json, SocialErrorCode } from "./types.ts";
import { b64url, randomId } from "./util.ts";

export interface BlueskyOAuth {
  authorize(handle: string): Promise<{ url: string; finish(callback: URL): Promise<{ did: string; handle: string; pds: string }>; cancel(): void }>;
  /** DPoP-bound fetch to the account's PDS; path like "/xrpc/com.atproto.repo.createRecord". Throws SocialError('signed-out') when the session is gone. */
  fetchHandler(did: string): Promise<(path: string, init?: RequestInit) => Promise<Response>>;
  revoke(did: string): Promise<void>;
}

const ES256 = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const utf8 = (text: string) => new TextEncoder().encode(text);

/** An ES256 (P-256) DPoP key signed with Web Crypto. Its private JWK is what the sealed stores keep. */
export class WebCryptoKey extends Key {
  #signer?: Promise<CryptoKey>;

  constructor(jwk: Jwk) {
    if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string" || jwk.alg !== "ES256") {
      throw new TypeError("WebCryptoKey needs a private ES256 P-256 JWK");
    }
    super(jwk);
  }

  static async generate(): Promise<WebCryptoKey> {
    const pair = await crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
    const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
    return new WebCryptoKey({ kty, crv, x, y, d, kid: randomId(), alg: "ES256" } as Jwk);
  }

  async createJwt(header: JwtHeader, payload: JwtPayload): Promise<SignedJwt> {
    const { kty, crv, x, y, d } = this.jwk as JsonWebKey;
    this.#signer ??= crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, ES256, false, ["sign"]);
    const input = `${b64url(utf8(JSON.stringify({ ...header, alg: "ES256" })))}.${b64url(utf8(JSON.stringify(payload)))}`;
    // Web Crypto ECDSA signatures are raw r||s, which is exactly the JWS encoding.
    const signature = new Uint8Array(await crypto.subtle.sign(ES256, await this.#signer, utf8(input)));
    return `${input}.${b64url(signature)}` as SignedJwt;
  }

  // The OAuth client only signs with DPoP keys; it never verifies with them.
  verifyJwt(): never { throw new TypeError("WebCryptoKey only signs"); }
}

/** A SimpleStore over sealed provider records; the DPoP key is kept as its private JWK. */
function sealedStore<V extends { dpopKey: Key }>(records: ProviderRecords) {
  return {
    async get(key: string): Promise<V | undefined> {
      const stored = (await records.get(key)) as { dpopKey: Jwk } | null;
      return stored ? ({ ...stored, dpopKey: new WebCryptoKey(stored.dpopKey) } as unknown as V) : undefined;
    },
    async set(key: string, value: V): Promise<void> {
      await records.set(key, JSON.parse(JSON.stringify({ ...value, dpopKey: value.dpopKey.privateJwk })) as Json);
    },
    async del(key: string): Promise<void> { await records.delete(key); },
  };
}

/** Library errors can carry server text; only a fixed code leaves this module. */
async function guard<T>(code: SocialErrorCode, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof SocialError) throw error;
    // A plain TypeError is also how fetch reports a dropped connection, so only the token errors mean signed out.
    throw new SocialError(isExpectedSessionError(error) && error.constructor !== TypeError ? "signed-out" : code);
  }
}

/** `grant` names one sign-in's session store, so accounts on the same DID never share or revoke each other's session. */
export function blueskyOAuth(options: BlueskyOAuthOptions, ctx: ProviderContext, grant: string): BlueskyOAuth {
  const sessions = ctx.shared(["oauth-session", grant]);
  const states = ctx.shared(["oauth-state"]);
  const stateStore = sealedStore<InternalStateData>(states);
  // appState -> state key, so a flow can cancel its own pending record.
  const pending = new Map<string, string>();
  const client = new OAuthClient({
    responseMode: "query",
    clientMetadata: options.clientMetadata,
    handleResolver: options.handleResolver,
    ...(options.plcDirectoryUrl ? { plcDirectoryUrl: options.plcDirectoryUrl } : {}),
    allowHttp: options.allowHttp === true,
    fetch: ctx.fetch,
    stateStore: { ...stateStore, set: (key, value) => { if (value.appState) pending.set(value.appState, key); return stateStore.set(key, value); } },
    sessionStore: sealedStore<Session>(sessions),
    // ponytail: no requestLock; the client falls back to its in-process per-name lock and keeps its cross-instance
    // refresh recovery, which a declared lock would switch off. Add a host-wide lock if several processes share a store.
    runtimeImplementation: {
      createKey: (algs) => {
        if (!algs.includes("ES256")) throw new TypeError("the authorization server does not accept ES256 DPoP keys");
        return WebCryptoKey.generate();
      },
      getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
      digest: async (data, { name }) => new Uint8Array(await crypto.subtle.digest(name.replace("sha", "SHA-"), data)),
    },
  });

  return {
    async authorize(handle) {
      if (typeof handle !== "string" || handle.trim() === "") throw new TypeError("authorize needs a handle");
      const appState = randomId();
      const url = await guard("connect-failed", () => client.authorize(handle.trim(), { state: appState }));
      const drop = () => {
        const key = pending.get(appState);
        pending.delete(appState);
        if (key) void states.delete(key).catch(() => undefined);
      };
      return {
        url: url.toString(),
        finish: (callback) => guard("connect-failed", async () => {
          const { session, state } = await client.callback(callback.searchParams);
          pending.delete(appState);
          if (state !== appState) {
            await client.revoke(session.did).catch(() => undefined);
            throw new SocialError("connect-failed");
          }
          const { aud } = await session.getTokenInfo(false);
          const { handle: resolved } = await client.identityResolver.resolve(session.did);
          return { did: session.did, handle: resolved === "handle.invalid" ? session.did : resolved, pds: new URL(aud).origin };
        }),
        cancel: drop,
      };
    },

    async fetchHandler(did) {
      const session = await guard("network", () => client.restore(did));
      return (path, init) => guard("network", () => session.fetchHandler(path, init));
    },

    async revoke(did) {
      await client.revoke(did).catch(() => undefined);
      await sessions.delete(did);
    },
  };
}
