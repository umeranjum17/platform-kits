/** JSON-safe values stored in drafts, options and sealed records. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Networks with a provider or a typed handoff in this kit; custom providers may use any other name. */
export type KnownNetwork = "bluesky" | "mastodon" | "hacker-news" | "product-hunt" | "reddit" | "tiktok" | "x" |
  "linkedin" | "threads" | "instagram" | "youtube";
export type SocialNetwork = KnownNetwork | (string & {});

/**
 * Host-supplied sealed secret store. Structurally identical to the BYOKit secrets Keystore: web, native and
 * sealed desktop stores fit as they are. The kit never picks a backend and never falls back to plaintext.
 */
export interface Keystore {
  get(name: string): Promise<string | null>;
  set(name: string, secret: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export type AccountPhase = "ready" | "signed-out" | "locked";
export interface SocialAccount {
  id: string;
  network: SocialNetwork;
  /** App-owned person id, for example "umer". */
  person: string;
  /** App-owned slot that tells two accounts of one person apart, for example "takeone". */
  slot: string;
  /** Display handle such as `umer.bsky.social` or `@umer@example.social`. */
  handle: string;
  /** Server origin, such as the Bluesky PDS or Mastodon instance. Empty for handoff networks. */
  origin: string;
  phase: AccountPhase;
  /** Provider-published, non-secret facts such as instance limits. */
  meta: { [key: string]: Json };
}

export interface MediaInput {
  data: Uint8Array;
  /** MIME type, for example image/png. */
  type: string;
  alt?: string;
}
/** Media is bound to an approval by its SHA-256; the bytes stay in the queue, never in the Keystore. */
export interface MediaRef { sha256: string; type: string; alt: string; size: number }

export type DraftOrigin = "agent" | "person";
export type DraftField = "text" | "title" | "link" | "media" | "options";
export interface DraftInput {
  account: string;
  text: string;
  title?: string;
  link?: string;
  media?: MediaInput[];
  /** Provider-specific settings, for example Mastodon `visibility` or Bluesky `langs`. Part of the approved payload. */
  options?: { [key: string]: Json };
  origin: DraftOrigin;
}
export interface DraftPatch {
  text?: string;
  title?: string;
  link?: string;
  media?: MediaInput[];
  options?: { [key: string]: Json };
}
export interface Draft {
  id: string;
  revision: number;
  account: string;
  network: SocialNetwork;
  text: string;
  title: string;
  link: string;
  media: MediaRef[];
  options: { [key: string]: Json };
  origin: DraftOrigin;
  /** Fields whose current value a person wrote, by creating or editing the draft as a person. */
  personWritten: DraftField[];
  createdAt: number;
  updatedAt: number;
}

export type IssueSeverity = "error" | "warning";
export interface SocialIssue {
  /** Kebab-case code, for example `too-long` or `human-authored`. */
  code: string;
  severity: IssueSeverity;
  field?: DraftField;
  limit?: number;
}

export type ApprovalState = "open" | "used" | "void";
export interface Approval {
  id: string;
  draft: string;
  revision: number;
  /** SHA-256 of the canonical payload: account, network, text, title, link, media hashes, options and time. */
  digest: string;
  by: string;
  approvedAt: number;
  /** Epoch ms the post is approved for, or null for "now". */
  at: number | null;
  expiresAt: number;
  state: ApprovalState;
}

export type PostPhase = "scheduled" | "publishing" | "posted" | "handed-off" | "failed" | "cancelled" | "unknown";
export interface HandoffTicket {
  network: SocialNetwork;
  /** Page where a person posts by hand. */
  deepLink: string;
  copyBlocks: { label: string; text: string }[];
  /** Native share targets, where the network's app accepts one; the host fires it, the kit never does. */
  share?: { android?: AndroidShareIntent };
  checklist: { rule: string; source: string }[];
  doNot: string[];
}
/** An Android ACTION_SEND intent the host can start, for example with expo-intent-launcher. */
export interface AndroidShareIntent {
  action: "android.intent.action.SEND";
  type: string;
  /** Preferred app package; hosts fall back to the system chooser when it is not installed. */
  package?: string;
  extras: { [key: string]: string };
}
export interface SocialPost {
  /** Same id as the approval it consumes: one approval, at most one post. */
  id: string;
  draft: string;
  account: string;
  network: SocialNetwork;
  phase: PostPhase;
  at: number | null;
  url?: string;
  remoteId?: string;
  code?: SocialErrorCode;
  ticket?: HandoffTicket;
  /** Provider-owned idempotency material, written before the network call. */
  attempt?: { [key: string]: Json };
  startedAt?: number;
  updatedAt: number;
}

export type SocialPhase = "draft" | "approved" | PostPhase;
export interface SocialStatus {
  draft: Draft;
  phase: SocialPhase;
  approval?: Approval;
  post?: SocialPost;
}

export type PostResult =
  | { ok: true; post: SocialPost; url?: string; remoteId?: string }
  | { ok: false; post: SocialPost; code: SocialErrorCode }
  | { handoff: HandoffTicket; post: SocialPost };

export type SocialEvent =
  | { type: "account"; account: SocialAccount }
  | { type: "draft"; draft: Draft }
  | { type: "approval"; approval: Approval }
  | { type: "post"; post: SocialPost };

/** Persisted, secret-free kit state. Media bytes are kept beside it by content hash. */
export interface SocialState {
  v: 1;
  accounts: (SocialAccount & { records: string[] })[];
  drafts: Draft[];
  approvals: Approval[];
  posts: SocialPost[];
}
/** Where drafts, approvals, posts and media live. `memoryQueue()` here; `fileQueue()` in `/node`. */
export interface SocialQueue {
  load(): Promise<SocialState | null>;
  save(state: SocialState): Promise<void>;
  putMedia(sha256: string, data: Uint8Array): Promise<void>;
  getMedia(sha256: string): Promise<Uint8Array | null>;
}

export type SocialErrorCode =
  | "not-found" | "draft-stale" | "check-failed" | "human-authored" | "confirm-mismatch"
  | "approval-required" | "approval-used" | "approval-void" | "stale-approval" | "not-due"
  | "signed-out" | "locked" | "rate-limited" | "rejected" | "duplicate-content" | "media-processing"
  | "unsupported" | "network" | "store-failed" | "connect-failed";

export interface ConnectFlow {
  /** Authorization page the host opens. */
  url: string;
  finish(callback: string | URL): Promise<SocialAccount>;
  cancel(): void;
}
