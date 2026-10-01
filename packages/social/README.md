# @platform-kits/social

Connect your own social accounts, draft posts, approve them, and post now or on a schedule. Nothing reaches a
network without a person's approval of the exact post. Bluesky and Mastodon post through their APIs; Hacker News,
Product Hunt, X, Reddit, TikTok, LinkedIn, Threads, Instagram and YouTube produce a handoff ticket: the text, a
prefilled link, the approved media as `assets` and a checklist for a person to post by hand.

The main entry is portable: it uses only `fetch`, Web Crypto, `URL`, `TextEncoder` and `Intl.Segmenter`, so it runs
in Node, Electron, a browser or PWA, and React Native (with Web Crypto and `URL` polyfills; without `Intl.Segmenter`,
length checks count code points). `@platform-kits/social/node` adds a
file-backed queue and a scheduler loop. No account, key or subscription comes with the kit: each app brings its
own accounts and, for OAuth, its own client registration. Still `private: true`; not published yet. Posting is proven
end to end against a local Bluesky PDS and a local Mastodon; a proof on the live networks is still pending.

For now posting stays manual: a person approves and sends each post. The kit is not published to npm and is not
wired to post automatically anywhere; automated posting, including the scheduler loop below, is a later look.

```sh
npm install @platform-kits/social
```

```ts
import { Social, blueskyProvider, mastodonProvider, hackerNewsHandoff, xProvider, type Keystore } from '@platform-kits/social';
import { fileQueue, runScheduler } from '@platform-kits/social/node';

declare const store: Keystore; // the host's sealed store: web, native, or an OS-keyring-sealed desktop store
declare const appPassword: string; // from Bluesky settings → App passwords, entered by Umer

const queue = fileQueue({ stateDir: '/var/lib/crew/social' });
const social = new Social({
  store,
  queue,
  providers: [blueskyProvider(), mastodonProvider(), hackerNewsHandoff(), xProvider()],
});

const account = await social.connect('bluesky', {
  person: 'umer', slot: 'takeone', identifier: 'umer.bsky.social', appPassword,
});
if ('url' in account) throw new Error('app passwords connect without a browser step');

// An agent or a person drafts. Drafting never touches a network.
const draft = await social.draft({ account: account.id, text: 'TakeOne 2.0 is out: https://example.com', origin: 'agent' });
console.log(await social.check(draft.id)); // length, media and network rules

// The host calls approve() only from a person's action. The approval covers this exact revision and time.
const approval = await social.approve(draft.id, { revision: draft.revision, by: 'umer', at: Date.now() + 3_600_000 });
await social.schedule(approval.id);

// Posts due approvals; an approval found more than graceMs late fails as stale instead of publishing.
const controller = new AbortController();
void runScheduler(social, { intervalMs: 30_000, signal: controller.signal });
```

## The approve gate

- **No approval, no post.** `post(approvalId)` is the only path to a network. Provider handles are opaque: the
  publish function is held privately by the kit, so code holding a provider cannot post with it.
- **Bound to the exact payload.** An approval stores a SHA-256 digest of the account, network, text, title, link,
  media hashes, options and scheduled time. `post()` recomputes it; any edit voids the approval, and media bytes
  are re-hashed before sending.
- **Single use.** Posting consumes the approval before the network call. A second `post()` is refused with
  `approval-used`, including concurrent calls.
- **Stale approvals fail closed.** A "now" approval expires after `expiresMs` (default one hour). A scheduled one
  must go out within `graceMs` (default five minutes) of its time; later, `runDue()` marks it failed with
  `stale-approval`. Nothing is published late because a date passed.
- **Unknown outcomes are not re-sent blindly.** If the connection drops mid-send, or the process stops while a post
  is publishing, the post becomes `unknown`. `retry(approvalId)` re-sends with the same idempotency material: the
  same Bluesky record key, or the same Mastodon `Idempotency-Key` within its one-hour window. It re-sends only the
  approved payload; after an edit it is refused with `approval-void` and the post stays `unknown`.
- **Checks run twice.** `approve()` refuses a draft with an error-level issue, and the send runs the checks again,
  so a post that no longer fits the account (say, a lower instance limit) fails as `check-failed`.
- **Human-written fields.** Hacker News titles and text and the Product Hunt first comment must be written by a
  person. An agent-written value blocks approval until a person edits it or the approver passes `humanWritten: true`.
- There is deliberately no auto-approve option. The kit cannot prove a person called `approve()`; the host must call
  it only from a person's action.

| Call | What it does |
| --- | --- |
| `connect(network, input)` | Signs in and stores sealed records; returns the account or a `{ url, finish, cancel }` flow |
| `accounts()` / `disconnect(id, { confirm: id })` | Lists accounts; deletes an account's sealed records |
| `draft(input)` / `edit(id, patch, { revision, origin })` | Creates or edits a draft; a stale revision is `draft-stale` |
| `check(id)` | Issues with `code`, `severity` and `field`, such as `too-long`, `malformed-text` or a `near-duplicate` warning when another account has the same text |
| `approve(id, { revision, by, at, expiresMs?, humanWritten? })` | The gate; replaces the draft's previous open approval |
| `schedule(approvalId)` / `runDue()` / `cancel(approvalId)` | Queue, post due approvals, cancel |
| `post(approvalId)` / `retry(approvalId)` | Post now; retry an `unknown` outcome |
| `markPosted(approvalId, { url })` | Records a handoff that a person posted |
| `status(draftId)` / `posts()` / `drafts()` / `onState(listener)` | Status, lists and events; `onState` returns its own unsubscribe |

`post()` resolves `{ ok: true, post, url, remoteId }`, `{ ok: false, post, code }` or `{ handoff, post }`. Refusals
before anything is sent reject with `SocialError`, whose `code` is stable and whose message is safe to show.

## Networks

| Network | Factory | Sign-in | Notes |
| --- | --- | --- | --- |
| Bluesky | `blueskyProvider()` | App password, or AT Protocol OAuth with `{ oauth }` | Links and hashtags become facets; up to 4 images |
| Mastodon | `mastodonProvider()` | Per-instance OAuth with PKCE, or an owner-generated token | Instance limits read at connect; posts read back to catch silent drops |
| Hacker News | `hackerNewsHandoff()` | Public username only | Prefilled submit link; title and text must be human-written |
| Product Hunt | `productHuntHandoff()` | None | Launch fields with length checks; launch from a personal account |
| X | `xProvider()` | None by default | Prefilled composer link and an Android share intent; counts length as X does (a link is 23); pass `{ adapter }` to post through a service |
| Reddit, TikTok, LinkedIn, Threads, Instagram, YouTube | `redditHandoff()` … | None | Handoff tickets until their API phases |

Bluesky OAuth needs the app's own hosted client metadata (`clientMetadata`, whose `client_id` is its URL) and a
handle resolver origin. Its DPoP key and session are kept in the Keystore. App passwords are the simpler path for an
owner's own accounts; Bluesky recommends them over OAuth for headless posting.

## Storage

The `Keystore` (`get`, `set`, `delete`) is supplied by the host and has the same shape as BYOKit's secrets stores.
The kit writes tokens, app passwords and OAuth sessions only there, under fixed-length `social.<hash>` names that
never contain a handle or instance. Mastodon app registrations are one record per instance. A Keystore error with
`code: 'keyring-locked'` surfaces as `locked`. Drafts, approvals, posts and media live in the queue, never in the
Keystore: `memoryQueue()` by default, or `fileQueue({ stateDir })`, which writes `state.json` and content-addressed
media atomically with owner-only permissions under `<stateDir>/social` and holds a single-writer lock.

Tests use `@platform-kits/social/testing`: `memoryKeystore()`, `fakeClock()` and `fakeProvider()`.
