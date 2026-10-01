# Changelog

## Unreleased

- Add the social kit: connect your own accounts, draft, check, approve, schedule and post. Nothing reaches a
  network without an approval bound to a SHA-256 digest of the exact payload; approvals are single-use, any edit
  voids them, and a late scheduled approval fails as stale instead of publishing.
- Add Bluesky (app password and AT Protocol OAuth) and Mastodon providers, Hacker News and Product Hunt handoff
  tickets, an X provider that hands off to the prefilled composer or Android share intent by default with an
  adapter seam for posting services, and typed handoff stubs for Reddit, TikTok, LinkedIn, Threads, Instagram and
  YouTube.
- Add `@platform-kits/social/node`: `fileQueue({ stateDir })`, which keeps drafts, approvals, posts and media in
  owner-only files under a single-writer lock, and `runScheduler()`, which posts due approvals on an interval.
- SECURITY: Tokens, app passwords and OAuth sessions live only in the host's sealed Keystore under hashed names;
  there is no plaintext fallback, and errors carry fixed messages without tokens or server bodies.
