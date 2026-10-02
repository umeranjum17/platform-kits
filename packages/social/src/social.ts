import { SocialError } from "./errors.ts";
import { providerSpec, type AccountContext, type Connected, type ProviderContext, type ProviderRecords,
  type ProviderSpec, type SocialProvider } from "./provider.ts";
import type { Approval, ConnectFlow, Draft, DraftField, DraftInput, DraftOrigin, DraftPatch, Json, Keystore, MediaInput,
  MediaRef, PostResult, SocialAccount, SocialErrorCode, SocialEvent, SocialIssue, SocialPost, SocialQueue,
  SocialState, SocialStatus } from "./types.ts";
import { b64url, canonical, randomId, recordName, sha256, sha256Hex } from "./util.ts";

export interface SocialOptions {
  /** Host-supplied sealed store for tokens and app passwords. */
  store: Keystore;
  providers: SocialProvider[];
  /** Drafts, approvals, posts and media. Default: in memory, lost when the process ends. */
  queue?: SocialQueue;
  fetch?: typeof fetch;
  /** Clock in epoch milliseconds. */
  now?: () => number;
  /** How late a scheduled post may still go out. Default 5 minutes; later than that it fails as stale. */
  graceMs?: number;
}
export interface ConnectInput { person: string; slot: string; [key: string]: unknown }
export interface ApproveOptions {
  /** The draft revision the person reviewed. */
  revision: number;
  /** App-owned id of the person approving. */
  by: string;
  /** "now", or the epoch ms the post is approved for. */
  at: number | "now";
  /** How long a "now" approval stays usable. Default 1 hour. Scheduled approvals expire at `at + graceMs`. */
  expiresMs?: number;
  /** The approver attests a person wrote the network's human-only fields (Hacker News title and text). */
  humanWritten?: boolean;
}

const HOUR = 3_600_000;
// Failures where the network definitely did not publish. Anything else may have landed and becomes `unknown`.
const notPosted = new Set<SocialErrorCode>(["signed-out", "locked", "rate-limited", "rejected", "duplicate-content",
  "media-processing", "unsupported", "check-failed", "stale-approval"]);
const draftFields: DraftField[] = ["text", "title", "link", "media", "options"];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

type StoredAccount = SocialState["accounts"][number];
const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
// encodeURIComponent throws on lone surrogates, which handoff links and most servers reject.
const wellFormed = (text: string) => { try { encodeURIComponent(text); return true; } catch { return false; } };
const publicAccount = ({ records: _, ...account }: StoredAccount): SocialAccount => clone(account);

/** In-memory queue for tests and short-lived hosts. */
export function memoryQueue(): SocialQueue {
  let state: SocialState | null = null;
  const media = new Map<string, Uint8Array>();
  return {
    async load() { return state && clone(state); },
    async save(next) { state = clone(next); },
    async putMedia(hash, data) { media.set(hash, data.slice()); },
    async getMedia(hash) { return media.get(hash)?.slice() ?? null; },
  };
}

export class Social {
  readonly #store: Keystore;
  readonly #queue: SocialQueue;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #providers = new Map<string, ProviderSpec>();
  readonly #listeners = new Set<(event: SocialEvent) => void>();
  #state?: Promise<SocialState>;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(options: SocialOptions) {
    if (!options?.store || !Array.isArray(options.providers)) throw new TypeError("Social needs a store and providers");
    const graceMs = options.graceMs ?? 5 * 60_000;
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("graceMs must be a finite, non-negative number");
    for (const provider of options.providers) {
      const spec = providerSpec(provider);
      if (this.#providers.has(spec.network)) throw new TypeError(`two providers for ${spec.network}`);
      this.#providers.set(spec.network, spec);
    }
    this.#store = options.store;
    this.#queue = options.queue ?? memoryQueue();
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#graceMs = graceMs;
  }

  /** Subscribe to account, draft, approval and post changes. Returns its own unsubscribe. */
  onState(listener: (event: SocialEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  // ---- accounts ----

  /** Connect an account. Returns the account, or a flow whose `url` the host opens and whose `finish` takes the callback URL. */
  async connect(network: string, input: ConnectInput): Promise<SocialAccount | ConnectFlow> {
    const spec = this.#spec(network);
    if (!nonEmpty(input?.person) || !nonEmpty(input?.slot)) throw new TypeError("connect needs a person and a slot");
    const step = await this.#guard("connect-failed", () => spec.connect(input, this.#context(network)));
    if (!("url" in step)) return this.#commitAccount(spec, input, step);
    return {
      url: step.url,
      finish: async (callback) => this.#commitAccount(spec, input,
        await this.#guard("connect-failed", () => step.finish(new URL(String(callback))))),
      cancel: () => step.cancel(),
    };
  }

  async accounts(): Promise<SocialAccount[]> {
    return (await this.#load()).accounts.map(publicAccount);
  }

  /** Delete the account's sealed records now. `confirm` must repeat the account id. */
  async disconnect(accountId: string, options: { confirm: string }): Promise<void> {
    if (options?.confirm !== accountId) throw new SocialError("confirm-mismatch");
    const state = await this.#load();
    const stored = state.accounts.find((a) => a.id === accountId);
    if (!stored) throw new SocialError("not-found");
    const spec = this.#spec(stored.network);
    // Remote revocation is best effort; the local grant goes regardless.
    await spec.disconnect?.(this.#accountContext(spec, stored)).catch(() => undefined);
    for (const name of stored.records) await this.#keystore(async () => this.#store.delete(await this.#recordName(stored.id, name)));
    await this.#mutate((next, emit) => {
      next.accounts = next.accounts.filter((a) => a.id !== accountId);
      for (const approval of next.approvals) {
        if (approval.state === "open" && next.drafts.find((d) => d.id === approval.draft)?.account === accountId) {
          this.#voidApproval(next, approval, "cancelled", emit);
        }
      }
    });
  }

  // ---- drafts ----

  /** Create a draft. Nothing here touches a network. */
  async draft(input: DraftInput): Promise<Draft> {
    if (typeof input?.text !== "string" || (input.origin !== "agent" && input.origin !== "person")) {
      throw new TypeError("a draft needs text and an origin of agent or person");
    }
    const media = await this.#putMedia(input.media ?? []);
    return this.#mutate((state, emit) => {
      const account = state.accounts.find((a) => a.id === input.account);
      if (!account) throw new SocialError("not-found");
      const now = this.#now();
      const draft: Draft = {
        id: randomId(), revision: 1, account: account.id, network: account.network, text: input.text,
        title: input.title ?? "", link: input.link ?? "", media, options: clone(input.options ?? {}),
        origin: input.origin, personWritten: input.origin === "person" ? [...draftFields] : [],
        createdAt: now, updatedAt: now,
      };
      state.drafts.push(draft);
      emit({ type: "draft", draft });
      return clone(draft);
    });
  }

  /** Edit a draft at the revision the editor saw. Any edit voids the draft's approval. */
  async edit(draftId: string, patch: DraftPatch, options: { revision: number; origin: DraftOrigin }): Promise<Draft> {
    if (options?.origin !== "agent" && options?.origin !== "person") throw new TypeError("an edit needs an origin");
    const media = patch.media ? await this.#putMedia(patch.media) : undefined;
    return this.#mutate((state, emit) => {
      const draft = state.drafts.find((d) => d.id === draftId);
      if (!draft) throw new SocialError("not-found");
      if (draft.revision !== options.revision) throw new SocialError("draft-stale");
      const changed: DraftField[] = [];
      if (patch.text !== undefined) { draft.text = patch.text; changed.push("text"); }
      if (patch.title !== undefined) { draft.title = patch.title; changed.push("title"); }
      if (patch.link !== undefined) { draft.link = patch.link; changed.push("link"); }
      if (media) { draft.media = media; changed.push("media"); }
      if (patch.options !== undefined) { draft.options = clone(patch.options); changed.push("options"); }
      draft.personWritten = options.origin === "person"
        ? [...new Set([...draft.personWritten, ...changed])]
        : draft.personWritten.filter((f) => !changed.includes(f));
      draft.revision++;
      draft.updatedAt = this.#now();
      for (const approval of state.approvals) {
        if (approval.draft === draftId && approval.state === "open") this.#voidApproval(state, approval, "approval-void", emit);
      }
      emit({ type: "draft", draft });
      return clone(draft);
    });
  }

  async drafts(): Promise<Draft[]> {
    return clone((await this.#load()).drafts);
  }

  /** Length, media, human-authored and network rules for the draft as it stands. */
  async check(draftId: string): Promise<SocialIssue[]> {
    const state = await this.#load();
    const draft = state.drafts.find((d) => d.id === draftId);
    const account = draft && state.accounts.find((a) => a.id === draft.account);
    if (!draft || !account) throw new SocialError("not-found");
    return this.#issues(draft, account, state);
  }

  // ---- the gate ----

  /**
   * Approve the exact draft revision. Call it only from a person's action: the kit cannot tell who called it,
   * and there is deliberately no auto-approve. A new approval replaces the draft's previous open one.
   */
  async approve(draftId: string, options: ApproveOptions): Promise<Approval> {
    if (!nonEmpty(options?.by)) throw new TypeError("an approval needs the approving person's id");
    if (options.at !== "now" && !Number.isFinite(options.at)) throw new TypeError("at must be 'now' or epoch milliseconds");
    if (options.expiresMs !== undefined && !(Number.isFinite(options.expiresMs) && options.expiresMs > 0)) {
      throw new RangeError("expiresMs must be positive");
    }
    const state = await this.#load();
    const draft = state.drafts.find((d) => d.id === draftId);
    const account = draft && state.accounts.find((a) => a.id === draft.account);
    if (!draft || !account) throw new SocialError("not-found");
    if (draft.revision !== options.revision) throw new SocialError("draft-stale");
    const now = this.#now();
    if (options.at !== "now" && options.at <= now) throw new RangeError("a scheduled approval must be in the future");
    const issues = this.#issues(draft, account, state);
    if (issues.some((i) => i.severity === "error")) throw new SocialError("check-failed", { issues });
    const spec = this.#spec(account.network);
    const unattested = spec.humanAuthored.some((f) => nonEmpty(draft[f]) && !draft.personWritten.includes(f));
    if (unattested && options.humanWritten !== true) throw new SocialError("human-authored");
    const at = options.at === "now" ? null : options.at;
    const digest = await payloadDigest(draft, account, at);
    return this.#mutate((next, emit) => {
      const current = next.drafts.find((d) => d.id === draftId);
      if (!current || current.revision !== options.revision) throw new SocialError("draft-stale");
      for (const old of next.approvals) {
        if (old.draft === draftId && old.state === "open") this.#voidApproval(next, old, "cancelled", emit);
      }
      const approval: Approval = {
        id: randomId(), draft: draftId, revision: draft.revision, digest, by: options.by, approvedAt: now, at,
        expiresAt: at === null ? now + (options.expiresMs ?? HOUR) : at + this.#graceMs, state: "open",
      };
      next.approvals.push(approval);
      emit({ type: "approval", approval });
      return clone(approval);
    });
  }

  /** Queue an approval for its time. `runDue()` posts it then, or fails it as stale if the queue runs too late. */
  async schedule(approvalId: string): Promise<SocialPost> {
    return this.#mutate((state, emit) => {
      const approval = state.approvals.find((a) => a.id === approvalId);
      if (!approval) throw new SocialError("approval-required");
      const existing = state.posts.find((p) => p.id === approvalId);
      if (existing?.phase === "scheduled") return clone(existing);
      if (existing || approval.state === "used") throw new SocialError("approval-used");
      if (approval.state === "void") throw new SocialError("approval-void");
      if (approval.at === null) throw new TypeError("approvals for now are posted with post()");
      const draft = state.drafts.find((d) => d.id === approval.draft) as Draft;
      const post: SocialPost = { id: approval.id, draft: draft.id, account: draft.account, network: draft.network,
        phase: "scheduled", at: approval.at, updatedAt: this.#now() };
      state.posts.push(post);
      emit({ type: "post", post });
      return clone(post);
    });
  }

  /** The only path to a network. Consumes the approval once; any edit, reuse or lateness is refused. */
  async post(approvalId: string): Promise<PostResult> {
    return this.#send(approvalId, false);
  }

  /** Re-send a post whose outcome is unknown, with the same idempotency material, so it cannot post twice. */
  async retry(approvalId: string): Promise<PostResult> {
    return this.#send(approvalId, true);
  }

  /** Post every scheduled approval that is due. Late ones fail as `stale-approval`; nothing is published late. */
  async runDue(): Promise<SocialPost[]> {
    const now = this.#now();
    const due = (await this.#load()).posts.filter((p) => p.phase === "scheduled" && p.at !== null && p.at <= now);
    const touched: SocialPost[] = [];
    for (const { id } of due) {
      try { touched.push((await this.#send(id, false)).post); } catch (error) {
        if (!(error instanceof SocialError)) throw error;
        const post = (await this.#load()).posts.find((p) => p.id === id);
        if (post) touched.push(clone(post));
      }
    }
    return touched;
  }

  /** Cancel a scheduled or unused approval. */
  async cancel(approvalId: string): Promise<void> {
    await this.#mutate((state, emit) => {
      const approval = state.approvals.find((a) => a.id === approvalId);
      if (!approval) throw new SocialError("not-found");
      const post = state.posts.find((p) => p.id === approvalId);
      if (approval.state === "used" || (post && post.phase !== "scheduled" && post.phase !== "cancelled")) {
        throw new SocialError("approval-used");
      }
      this.#voidApproval(state, approval, "cancelled", emit);
    });
  }

  /** A person posted a handoff ticket by hand; record where it went. */
  async markPosted(approvalId: string, result: { url: string }): Promise<SocialPost> {
    if (!nonEmpty(result?.url)) throw new TypeError("markPosted needs the post URL");
    return this.#mutate((state, emit) => {
      const post = state.posts.find((p) => p.id === approvalId);
      if (!post) throw new SocialError("not-found");
      if (post.phase !== "handed-off") throw new SocialError("approval-used");
      Object.assign(post, { phase: "posted", url: result.url, updatedAt: this.#now() });
      emit({ type: "post", post });
      return clone(post);
    });
  }

  async status(draftId: string): Promise<SocialStatus> {
    const state = await this.#load();
    const draft = state.drafts.find((d) => d.id === draftId);
    if (!draft) throw new SocialError("not-found");
    const approval = state.approvals.filter((a) => a.draft === draftId).at(-1);
    const post = approval && state.posts.find((p) => p.id === approval.id);
    const phase = post?.phase ?? (approval?.state === "open" ? "approved" : "draft");
    return clone({ draft, phase, ...(approval ? { approval } : {}), ...(post ? { post } : {}) });
  }

  async posts(): Promise<SocialPost[]> {
    return clone((await this.#load()).posts);
  }

  // ---- internals ----

  async #send(approvalId: string, retry: boolean): Promise<PostResult> {
    const gate = await this.#exclusive(async () => {
      const state = await this.#load();
      const approval = state.approvals.find((a) => a.id === approvalId);
      if (!approval) throw new SocialError("approval-required");
      const existing = state.posts.find((p) => p.id === approvalId);
      if (retry) {
        if (existing?.phase !== "unknown") throw new SocialError("approval-used");
      } else {
        if (existing && existing.phase !== "scheduled") {
          throw new SocialError(existing.phase === "cancelled" ? "approval-void"
            : existing.code === "stale-approval" || existing.code === "check-failed" ? existing.code : "approval-used");
        }
        if (approval.state === "used") throw new SocialError("approval-used");
        if (approval.state === "void") throw new SocialError("approval-void");
      }
      const draft = state.drafts.find((d) => d.id === approval.draft);
      const account = draft && state.accounts.find((a) => a.id === draft.account);
      const now = this.#now();
      const refuse = async (code: SocialErrorCode): Promise<never> => {
        await this.#apply((next, emit) => {
          const a = next.approvals.find((x) => x.id === approvalId) as Approval;
          this.#voidApproval(next, a, code, emit);
        });
        throw new SocialError(code);
      };
      const approved = !!draft && !!account && draft.revision === approval.revision &&
        (await payloadDigest(draft, account, approval.at)) === approval.digest;
      // A retry re-sends exactly what was approved: an edit after the first attempt leaves the post unknown.
      if (retry && !approved) throw new SocialError("approval-void");
      if (!retry) {
        if (approval.at !== null && now < approval.at) throw new SocialError("not-due");
        if (now > approval.expiresAt) return refuse("stale-approval");
        if (!approved) return refuse("approval-void");
      }
      if (!draft || !account) throw new SocialError("not-found");
      // Fresh checks at send time: instance limits may have changed since approval.
      if (!retry && this.#issues(draft, account, state).some((i) => i.severity === "error")) return refuse("check-failed");
      // A locked keyring may be open again by now, so only a signed-out account is refused before trying.
      if (account.phase === "signed-out") throw new SocialError("signed-out");
      const media = [];
      for (const ref of draft.media) {
        const data = await this.#queue.getMedia(ref.sha256).catch(() => null);
        if (!data || (await sha256Hex(data)) !== ref.sha256) return refuse("approval-void");
        media.push({ ...ref, data });
      }
      const spec = this.#spec(account.network);
      const startedAt = retry ? (existing?.startedAt ?? now) : now;
      const attempt = retry ? (existing?.attempt ?? {}) : (await spec.prepare?.(approvalId, now)) ?? {};
      const post = await this.#apply((next, emit) => {
        const a = next.approvals.find((x) => x.id === approvalId) as Approval;
        a.state = "used";
        const p: SocialPost = { id: approvalId, draft: draft.id, account: account.id, network: account.network,
          phase: "publishing", at: approval.at, attempt, startedAt, updatedAt: now };
        next.posts = [...next.posts.filter((x) => x.id !== approvalId), p];
        emit({ type: "approval", approval: a });
        emit({ type: "post", post: p });
        return clone(p);
      });
      return { spec, draft: clone(draft), account, media, post };
    });

    const { spec, draft, account, media, post } = gate;
    let update: Partial<SocialPost>;
    let result: PostResult;
    const handoff = spec.publish === "handoff" && !!spec.handoff;
    try {
      if (handoff) {
        const ticket = (spec.handoff as NonNullable<ProviderSpec["handoff"]>)(draft, publicAccount(account));
        update = { phase: "handed-off", ticket };
        result = { handoff: ticket, post: { ...post, ...update } };
      } else {
        if (!spec.send) throw new SocialError("unsupported");
        const sent = await spec.send({ draft, media, key: approvalId, attempt: post.attempt ?? {},
          startedAt: post.startedAt ?? this.#now(), retry }, this.#accountContext(spec, account));
        update = { phase: "posted", remoteId: sent.remoteId, ...(sent.url ? { url: sent.url } : {}) };
        result = { ok: true, post: { ...post, ...update }, remoteId: sent.remoteId, ...(sent.url ? { url: sent.url } : {}) };
        if (account.phase === "locked") await this.#setAccountPhase(account.id, "ready");
      }
    } catch (error) {
      // Building a handoff ticket sends nothing, so its failures are never unknown.
      const code: SocialErrorCode = error instanceof SocialError ? error.code : handoff ? "rejected" : "network";
      update = { phase: notPosted.has(code) ? "failed" : "unknown", code };
      const until = error instanceof SocialError ? error.until : undefined;
      result = { ok: false, post: { ...post, ...update }, code, ...(until !== undefined ? { until } : {}) };
      if (code === "signed-out" || code === "locked") await this.#setAccountPhase(account.id, code);
    }
    const final = await this.#mutate((state, emit) => {
      const p = state.posts.find((x) => x.id === approvalId) as SocialPost;
      Object.assign(p, update, { updatedAt: this.#now() });
      emit({ type: "post", post: p });
      return clone(p);
    }, true);
    result.post = final;
    return result;
  }

  #issues(draft: Draft, account: StoredAccount, state: SocialState): SocialIssue[] {
    const issues: SocialIssue[] = [];
    if (draft.text.trim() === "" && draft.media.length === 0 && draft.title.trim() === "") {
      issues.push({ code: "empty", severity: "error", field: "text" });
    }
    for (const field of ["text", "title", "link"] as const) {
      if (!wellFormed(draft[field])) issues.push({ code: "malformed-text", severity: "error", field });
    }
    // Networks such as X suspend accounts that post the same text; warn when another account has it drafted.
    const text = normalize(draft.text);
    if (text !== "" && state.drafts.some((d) => d.network === draft.network && d.account !== draft.account && normalize(d.text) === text)) {
      issues.push({ code: "near-duplicate", severity: "warning", field: "text" });
    }
    const spec = this.#spec(account.network);
    for (const field of spec.humanAuthored) {
      if (nonEmpty(draft[field]) && !draft.personWritten.includes(field)) {
        issues.push({ code: "human-authored", severity: "warning", field });
      }
    }
    return [...issues, ...spec.check(clone(draft), publicAccount(account))];
  }

  #voidApproval(state: SocialState, approval: Approval, code: SocialErrorCode | "cancelled", emit: (e: SocialEvent) => void): void {
    approval.state = "void";
    emit({ type: "approval", approval });
    const post = state.posts.find((p) => p.id === approval.id);
    const fails = code === "stale-approval" || code === "check-failed";
    if (post && (post.phase === "scheduled" || fails)) {
      Object.assign(post, fails ? { phase: "failed", code } : { phase: "cancelled" },
        code === "approval-void" ? { code } : {}, { updatedAt: this.#now() });
      emit({ type: "post", post });
    } else if (!post && fails) {
      const draft = state.drafts.find((d) => d.id === approval.draft) as Draft;
      const failed: SocialPost = { id: approval.id, draft: draft.id, account: draft.account, network: draft.network,
        phase: "failed", at: approval.at, code, updatedAt: this.#now() };
      state.posts.push(failed);
      emit({ type: "post", post: failed });
    }
  }

  async #commitAccount(spec: ProviderSpec, input: ConnectInput, connected: Connected): Promise<SocialAccount> {
    const id = `${spec.network}:${b64url(await sha256(JSON.stringify([spec.network, connected.origin, input.person, input.slot]))).slice(0, 22)}`;
    const previous = (await this.#load()).accounts.find((a) => a.id === id);
    // Reconnecting replaces the account's grant: revoke the old one (best effort) before its records are overwritten.
    if (previous) await spec.disconnect?.(this.#accountContext(spec, previous)).catch(() => undefined);
    const names = Object.keys(connected.records);
    for (const name of names) {
      const value = JSON.stringify(connected.records[name]);
      await this.#keystore(async () => this.#store.set(await this.#recordName(id, name), value));
    }
    for (const name of previous?.records ?? []) {
      if (!names.includes(name)) await this.#keystore(async () => this.#store.delete(await this.#recordName(id, name)));
    }
    return this.#mutate((state, emit) => {
      const account: StoredAccount = { id, network: spec.network, person: input.person, slot: input.slot,
        handle: connected.handle, origin: connected.origin, phase: "ready", meta: clone(connected.meta ?? {}), records: names };
      state.accounts = [...state.accounts.filter((a) => a.id !== id), account];
      emit({ type: "account", account: publicAccount(account) });
      return publicAccount(account);
    });
  }

  async #setAccountPhase(accountId: string, phase: SocialAccount["phase"]): Promise<void> {
    await this.#mutate((state, emit) => {
      const account = state.accounts.find((a) => a.id === accountId);
      if (!account || account.phase === phase) return;
      account.phase = phase;
      emit({ type: "account", account: publicAccount(account) });
    }, true).catch(() => undefined);
  }

  #context(network: string): ProviderContext {
    return {
      fetch: this.#fetch,
      now: () => this.#now(),
      shared: (parts) => this.#records(["shared", network, ...parts]),
    };
  }

  #accountContext(spec: ProviderSpec, account: StoredAccount): AccountContext {
    const base = this.#records(["account", account.id]);
    return {
      ...this.#context(spec.network),
      account: publicAccount(account),
      records: {
        get: base.get,
        delete: base.delete,
        set: async (name, value) => {
          await base.set(name, value);
          if (!account.records.includes(name)) {
            await this.#mutate((state) => {
              const stored = state.accounts.find((a) => a.id === account.id);
              if (stored && !stored.records.includes(name)) stored.records.push(name);
            }, true);
          }
        },
      },
      setMeta: async (meta) => {
        await this.#mutate((state, emit) => {
          const stored = state.accounts.find((a) => a.id === account.id);
          if (!stored) return;
          stored.meta = { ...stored.meta, ...clone(meta) };
          emit({ type: "account", account: publicAccount(stored) });
        }, true);
      },
    };
  }

  #recordName(accountId: string, name: string): Promise<string> {
    return recordName(["account", accountId, name]);
  }

  #records(prefix: string[]): ProviderRecords {
    return {
      get: async (name) => {
        const raw = await this.#keystore(async () => this.#store.get(await recordName([...prefix, name])));
        if (raw === null) return null;
        try { return JSON.parse(raw) as Json; } catch { throw new SocialError("store-failed"); }
      },
      set: async (name, value) => {
        const text = JSON.stringify(value);
        await this.#keystore(async () => this.#store.set(await recordName([...prefix, name]), text));
      },
      delete: async (name) => this.#keystore(async () => this.#store.delete(await recordName([...prefix, name]))),
    };
  }

  async #keystore<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof SocialError) throw error;
      throw new SocialError((error as { code?: unknown })?.code === "keyring-locked" ? "locked" : "store-failed");
    }
  }

  async #guard<T>(code: SocialErrorCode, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof SocialError || error instanceof TypeError || error instanceof RangeError) throw error;
      throw new SocialError(code);
    }
  }

  async #putMedia(inputs: MediaInput[]): Promise<MediaRef[]> {
    const refs: MediaRef[] = [];
    for (const media of inputs) {
      if (!(media?.data instanceof Uint8Array) || !nonEmpty(media.type)) throw new TypeError("media needs bytes and a type");
      const hash = await sha256Hex(media.data);
      await this.#queue.putMedia(hash, media.data).catch(() => { throw new SocialError("store-failed"); });
      refs.push({ sha256: hash, type: media.type, alt: media.alt ?? "", size: media.data.byteLength });
    }
    return refs;
  }

  #spec(network: string): ProviderSpec {
    const spec = this.#providers.get(network);
    if (!spec) throw new SocialError("unsupported");
    return spec;
  }

  #load(): Promise<SocialState> {
    this.#state ??= this.#queue.load().then((loaded) => {
      const state: SocialState = loaded ?? { v: 1, accounts: [], drafts: [], approvals: [], posts: [] };
      // A post still "publishing" at load time was cut off mid-flight: its outcome is unknown, never re-sent blindly.
      for (const post of state.posts) if (post.phase === "publishing") Object.assign(post, { phase: "unknown", code: "network" });
      return state;
    }, () => {
      this.#state = undefined;
      throw new SocialError("store-failed");
    });
    return this.#state;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(operation, operation);
    this.#lock = run.catch(() => undefined);
    return run;
  }

  /** Apply a change under the lock. */
  #mutate<T>(change: (state: SocialState, emit: (event: SocialEvent) => void) => T, keep = false): Promise<T> {
    return this.#exclusive(() => this.#apply(change, keep));
  }

  /**
   * Apply a change to a copy, persist it, then adopt it. Callers must hold the lock. `keep` adopts the change even
   * if saving fails, for facts already true on the network (a post went out); the save error still surfaces.
   */
  async #apply<T>(change: (state: SocialState, emit: (event: SocialEvent) => void) => T, keep = false): Promise<T> {
    const next = clone(await this.#load());
    const events: SocialEvent[] = [];
    const result = change(next, (event) => events.push(event));
    let saved = true;
    try { await this.#queue.save(next); } catch { saved = false; }
    if (saved || keep) this.#state = Promise.resolve(next);
    if (!saved) throw new SocialError("store-failed");
    for (const event of events) {
      for (const listener of this.#listeners) {
        try { listener(clone(event)); } catch { /* a listener's failure never undoes a saved change */ }
      }
    }
    return result;
  }
}

/** SHA-256 over exactly what will be published, so any change voids the approval. */
async function payloadDigest(draft: Draft, account: SocialAccount, at: number | null): Promise<string> {
  return sha256Hex(canonical({
    v: 1, network: draft.network, account: account.id, handle: account.handle, origin: account.origin,
    text: draft.text, title: draft.title, link: draft.link,
    media: draft.media.map(({ sha256, type, alt }) => ({ sha256, type, alt })), options: draft.options, at,
  }));
}
