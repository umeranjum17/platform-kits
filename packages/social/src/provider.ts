import type { Draft, HandoffTicket, Json, SocialAccount, SocialIssue, SocialNetwork } from "./types.ts";

export type ProviderReview = "none" | "owner-roles" | "audit" | "vetted";
export type ProviderNeed = "secret-broker" | "media-url" | "relay-in-browser";

/** Sealed JSON records. Names are hashed by the kit before they reach the Keystore. */
export interface ProviderRecords {
  get(name: string): Promise<Json | null>;
  set(name: string, value: Json): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export interface ProviderContext {
  fetch: typeof fetch;
  now(): number;
  /** Records shared by every account of this provider, keyed by the provider, for example per instance. */
  shared(parts: readonly string[]): ProviderRecords;
}
export interface AccountContext extends ProviderContext {
  account: SocialAccount;
  /** This account's own records; disconnect deletes all of them. */
  records: ProviderRecords;
  /** Persist new non-secret account facts, such as refreshed instance limits. */
  setMeta(meta: { [key: string]: Json }): Promise<void>;
}

/** What a provider learned when an account connected. The kit stores `records` sealed and the rest in its index. */
export interface Connected {
  handle: string;
  origin: string;
  /** Stable account identity at the origin, for example a DID or a Mastodon account id. */
  remoteId: string;
  meta?: { [key: string]: Json };
  records: { [name: string]: Json };
}
export type ConnectStep = Connected | { url: string; finish(callback: URL): Promise<Connected>; cancel(): void };

export interface MediaFile { sha256: string; type: string; alt: string; data: Uint8Array }
export interface SendRequest {
  draft: Draft;
  media: MediaFile[];
  /** The approval id; networks with idempotency keys use it. */
  key: string;
  /** Provider-owned idempotency material, persisted before the first network call and passed again on retry. */
  attempt: { [key: string]: Json };
  startedAt: number;
  retry: boolean;
}
export interface Sent { url?: string; remoteId: string }

export interface ProviderSpec {
  network: SocialNetwork;
  publish: "api" | "handoff";
  review: ProviderReview;
  needs: readonly ProviderNeed[];
  /** Draft fields that must be written by a person; an agent-written value blocks approval until a person attests. */
  humanAuthored: readonly ("text" | "title")[];
  connect(input: unknown, ctx: ProviderContext): Promise<ConnectStep>;
  check(draft: Draft, account: SocialAccount): SocialIssue[];
  /** Called once per post, before `send`, to create the idempotency material that `send` reuses on retry. */
  prepare?(key: string, startedAt: number): Promise<{ [key: string]: Json }>;
  send?(request: SendRequest, ctx: AccountContext): Promise<Sent>;
  handoff?(draft: Draft, account: SocialAccount): HandoffTicket;
  disconnect?(ctx: AccountContext): Promise<void>;
}

/**
 * An opaque provider handle. The publish function lives only in the kit's private table,
 * so host code holding a provider cannot post with it: the only path is `Social.post(approval)`.
 */
export interface SocialProvider {
  readonly network: SocialNetwork;
  readonly publish: "api" | "handoff";
  readonly review: ProviderReview;
  readonly needs: readonly ProviderNeed[];
  readonly humanAuthored: readonly ("text" | "title")[];
}

const specs = new WeakMap<SocialProvider, ProviderSpec>();

/** Wrap a provider implementation for `new Social({ providers })`. */
export function defineProvider(spec: ProviderSpec): SocialProvider {
  const handle: SocialProvider = Object.freeze({
    network: spec.network, publish: spec.publish, review: spec.review,
    needs: Object.freeze([...spec.needs]), humanAuthored: Object.freeze([...spec.humanAuthored]),
  });
  specs.set(handle, spec);
  return handle;
}

export function providerSpec(provider: SocialProvider): ProviderSpec {
  const spec = specs.get(provider);
  if (!spec) throw new TypeError("providers must come from a provider factory or defineProvider()");
  return spec;
}
