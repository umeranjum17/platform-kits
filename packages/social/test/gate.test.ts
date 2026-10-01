import assert from "node:assert/strict";
import { test } from "node:test";
import { Social, SocialError, hackerNewsHandoff, productHuntHandoff, memoryQueue, xProvider, type SocialEvent,
  type SocialQueue } from "../src/index.ts";
import { fakeClock, fakeProvider, memoryKeystore } from "../src/testing.ts";

const MIN = 60_000;

async function setup(options: { queue?: SocialQueue; graceMs?: number } = {}) {
  const clock = fakeClock();
  const fake = fakeProvider();
  const store = memoryKeystore();
  const social = new Social({ store, providers: [fake.provider, hackerNewsHandoff(), productHuntHandoff()],
    now: clock.now, ...options });
  const account = await social.connect("fake", { person: "umer", slot: "takeone" });
  assert.ok(!("url" in account));
  return { clock, fake, store, social, account };
}

const refused = (code: string) => (error: unknown) => error instanceof SocialError && error.code === code;

test("an unapproved post is refused and nothing reaches the provider", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Hello from Umer", origin: "agent" });
  await assert.rejects(social.post(draft.id), refused("approval-required"));
  await assert.rejects(social.post("made-up"), refused("approval-required"));
  assert.equal(fake.sent.length, 0);
  assert.equal((await social.status(draft.id)).phase, "draft");
});

test("an approved post goes out once, and a reused approval is refused", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Hello from Umer", origin: "agent" });
  const approval = await social.approve(draft.id, { revision: draft.revision, by: "umer", at: "now" });
  assert.equal((await social.status(draft.id)).phase, "approved");
  const result = await social.post(approval.id);
  assert.ok("ok" in result && result.ok);
  assert.equal(result.url, "https://fake.invalid/post/1");
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].key, approval.id);
  await assert.rejects(social.post(approval.id), refused("approval-used"));
  await assert.rejects(social.retry(approval.id), refused("approval-used"));
  assert.equal(fake.sent.length, 1);
  assert.equal((await social.status(draft.id)).phase, "posted");
});

test("concurrent posts of one approval publish exactly once", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Once", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  const results = await Promise.allSettled([social.post(approval.id), social.post(approval.id), social.post(approval.id)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(fake.sent.length, 1);
});

test("an edited draft voids its approval, and approving the old revision is refused", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Version one", origin: "agent" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  const edited = await social.edit(draft.id, { text: "Version two" }, { revision: 1, origin: "person" });
  assert.equal(edited.revision, 2);
  await assert.rejects(social.post(approval.id), refused("approval-void"));
  await assert.rejects(social.approve(draft.id, { revision: 1, by: "umer", at: "now" }), refused("draft-stale"));
  await assert.rejects(social.edit(draft.id, { text: "x" }, { revision: 1, origin: "agent" }), refused("draft-stale"));
  assert.equal(fake.sent.length, 0);
  const again = await social.approve(draft.id, { revision: 2, by: "umer", at: "now" });
  assert.ok("ok" in (await social.post(again.id)));
  assert.equal(fake.sent[0].draft.text, "Version two");
});

test("a scheduled approval posts when due and a stale one fails closed instead of publishing", async () => {
  const { social, fake, account, clock } = await setup({ graceMs: 5 * MIN });
  const onTime = await social.draft({ account: account.id, text: "On time", origin: "person" });
  const late = await social.draft({ account: account.id, text: "Too late", origin: "person" });
  const at = clock.now() + 60 * MIN;
  const a1 = await social.approve(onTime.id, { revision: 1, by: "umer", at });
  const a2 = await social.approve(late.id, { revision: 1, by: "umer", at: at - 30 * MIN });
  await social.schedule(a1.id);
  await social.schedule(a2.id);
  await assert.rejects(social.post(a1.id), refused("not-due"));
  // The host was asleep: it wakes 2 minutes after a1's time and 32 minutes after a2's.
  clock.set(at + 2 * MIN);
  const touched = await social.runDue();
  assert.deepEqual(touched.map((p) => [p.id, p.phase, p.code]).sort(),
    [[a1.id, "posted", undefined], [a2.id, "failed", "stale-approval"]].sort());
  assert.deepEqual(fake.sent.map((s) => s.draft.text), ["On time"]);
  await assert.rejects(social.post(a2.id), refused("stale-approval"));
  assert.deepEqual(await social.runDue(), []);
  assert.equal(fake.sent.length, 1);
});

test("a 'now' approval expires, and scheduled times must be in the future", async () => {
  const { social, fake, account, clock } = await setup();
  const draft = await social.draft({ account: account.id, text: "Later", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now", expiresMs: 10 * MIN });
  clock.advance(11 * MIN);
  await assert.rejects(social.post(approval.id), refused("stale-approval"));
  assert.equal((await social.status(draft.id)).post?.code, "stale-approval");
  await assert.rejects(social.approve(draft.id, { revision: 1, by: "umer", at: clock.now() - 1 }), RangeError);
  await assert.rejects(social.approve(draft.id, { revision: 1, by: "", at: "now" }), TypeError);
  assert.equal(fake.sent.length, 0);
});

test("editing a scheduled draft cancels the queued post", async () => {
  const { social, fake, account, clock } = await setup();
  const draft = await social.draft({ account: account.id, text: "Scheduled", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: clock.now() + 10 * MIN });
  await social.schedule(approval.id);
  await social.edit(draft.id, { text: "Changed" }, { revision: 1, origin: "agent" });
  clock.advance(10 * MIN);
  assert.deepEqual(await social.runDue(), []);
  assert.equal((await social.status(draft.id)).phase, "cancelled");
  await assert.rejects(social.post(approval.id), refused("approval-void"));
  assert.equal(fake.sent.length, 0);
});

test("a new approval replaces the draft's open one, and cancel voids it", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Twice", origin: "person" });
  const first = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  const second = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  await assert.rejects(social.post(first.id), refused("approval-void"));
  await social.cancel(second.id);
  await assert.rejects(social.post(second.id), refused("approval-void"));
  assert.equal(fake.sent.length, 0);
});

test("swapped media bytes void the approval", async () => {
  const media = new Map<string, Uint8Array>();
  const queue: SocialQueue = { ...memoryQueue(), async putMedia(h, d) { media.set(h, d); }, async getMedia(h) { return media.get(h) ?? null; } };
  const { social, fake, account } = await setup({ queue });
  const draft = await social.draft({ account: account.id, text: "Picture", origin: "person",
    media: [{ data: new Uint8Array([1, 2, 3]), type: "image/png", alt: "A square" }] });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  media.set(draft.media[0].sha256, new Uint8Array([9, 9, 9]));
  await assert.rejects(social.post(approval.id), refused("approval-void"));
  assert.equal(fake.sent.length, 0);
});

test("an unknown outcome is never re-sent blindly; retry reuses the same idempotency material", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Flaky", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  fake.throwRaw();
  const result = await social.post(approval.id);
  assert.deepEqual("ok" in result && !result.ok && [result.code, result.post.phase], ["network", "unknown"]);
  await assert.rejects(social.post(approval.id), refused("approval-used"));
  const retried = await social.retry(approval.id);
  assert.ok("ok" in retried && retried.ok);
  assert.deepEqual(fake.sent[0].attempt, { key: approval.id });
  assert.equal(fake.sent[0].retry, true);
});

test("a retry after an edit is refused: only the approved payload is ever re-sent", async () => {
  const { social, fake, account, clock } = await setup();
  const draft = await social.draft({ account: account.id, text: "Approved text", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  fake.throwRaw();
  await social.post(approval.id);
  await social.edit(draft.id, { text: "Never approved" }, { revision: 1, origin: "agent" });
  clock.advance(5 * MIN);
  await assert.rejects(social.retry(approval.id), refused("approval-void"));
  assert.equal(fake.sent.length, 0);
  assert.equal((await social.posts())[0].phase, "unknown");
});

test("a definite refusal fails without retry, and signed-out marks the account", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Refused", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  fake.fail("signed-out");
  const result = await social.post(approval.id);
  assert.deepEqual("ok" in result && !result.ok && [result.code, result.post.phase], ["signed-out", "failed"]);
  assert.equal((await social.accounts())[0].phase, "signed-out");
  const second = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  await assert.rejects(social.post(second.id), refused("signed-out"));
  assert.equal(fake.sent.length, 0);
});

test("a locked keyring fails the send, and the account is ready again once a send gets through", async () => {
  const { social, fake, account } = await setup();
  const draft = await social.draft({ account: account.id, text: "Locked", origin: "person" });
  fake.fail("locked");
  await social.post((await social.approve(draft.id, { revision: 1, by: "umer", at: "now" })).id);
  assert.equal((await social.accounts())[0].phase, "locked");
  const result = await social.post((await social.approve(draft.id, { revision: 1, by: "umer", at: "now" })).id);
  assert.ok("ok" in result && result.ok);
  assert.equal((await social.accounts())[0].phase, "ready");
});

test("malformed text is refused at approval; the same text on two accounts is a warning", async () => {
  const { social, account } = await setup();
  const other = await social.connect("fake", { person: "umer", slot: "crewhouse", handle: "umer2" });
  assert.ok(!("url" in other));
  const broken = await social.draft({ account: account.id, text: "cut mid emoji \uD83D", origin: "person" });
  assert.deepEqual((await social.check(broken.id)).map((i) => i.code), ["malformed-text"]);
  await assert.rejects(social.approve(broken.id, { revision: 1, by: "umer", at: "now" }), refused("check-failed"));
  await social.draft({ account: account.id, text: "Ship it  today", origin: "person" });
  const copy = await social.draft({ account: other.id, text: "ship it today", origin: "person" });
  assert.deepEqual(await social.check(copy.id), [{ code: "near-duplicate", severity: "warning", field: "text" }]);
});

test("reconnecting an account revokes the grant it replaces", async () => {
  const { social, fake } = await setup();
  await social.connect("fake", { person: "umer", slot: "takeone", handle: "umer-new" });
  assert.deepEqual(fake.revoked, ["umer"]);
  assert.deepEqual((await social.accounts()).map((a) => a.handle), ["umer-new"]);
});

test("a crash mid-publish leaves the post unknown after reload", async () => {
  const queue = memoryQueue();
  let crash = true;
  const crashing: SocialQueue = { ...queue, async save(state) {
    await queue.save(state);
    if (crash && state.posts.some((p) => p.phase === "publishing")) throw new Error("power cut");
  } };
  const { social, account, store } = await setup({ queue: crashing });
  const draft = await social.draft({ account: account.id, text: "Cut off", origin: "person" });
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now" });
  await assert.rejects(social.post(approval.id), refused("store-failed"));
  crash = false;
  const fake = fakeProvider();
  const reopened = new Social({ store, providers: [fake.provider], queue });
  const post = (await reopened.posts()).find((p) => p.id === approval.id);
  assert.equal(post?.phase, "unknown");
  await assert.rejects(reopened.post(approval.id), refused("approval-used"));
  assert.equal(fake.sent.length, 0);
});

test("checks block approval and human-authored HN fields need a person", async () => {
  const { social } = await setup();
  const hn = await social.connect("hacker-news", { person: "umer", slot: "personal", handle: "umer" });
  assert.ok(!("url" in hn));
  const empty = await social.draft({ account: hn.id, text: "", origin: "agent" });
  await assert.rejects(social.approve(empty.id, { revision: 1, by: "umer", at: "now" }),
    (e: unknown) => refused("check-failed")(e) && (e as SocialError).issues!.some((i) => i.code === "title-required"));
  const draft = await social.draft({ account: hn.id, text: "", title: "Show HN: Crewhouse, a crew for your repos",
    link: "https://example.com/crewhouse", origin: "agent" });
  assert.ok((await social.check(draft.id)).some((i) => i.code === "human-authored" && i.field === "title"));
  await assert.rejects(social.approve(draft.id, { revision: 1, by: "umer", at: "now" }), refused("human-authored"));
  const approval = await social.approve(draft.id, { revision: 1, by: "umer", at: "now", humanWritten: true });
  const result = await social.post(approval.id);
  assert.ok("handoff" in result);
  assert.equal(result.handoff.deepLink, "https://news.ycombinator.com/submitlink?u=https%3A%2F%2Fexample.com%2Fcrewhouse&t=Show%20HN%3A%20Crewhouse%2C%20a%20crew%20for%20your%20repos");
  assert.equal(result.post.phase, "handed-off");
  const posted = await social.markPosted(approval.id, { url: "https://news.ycombinator.com/item?id=1" });
  assert.equal(posted.phase, "posted");
});

test("Product Hunt tickets carry the launch fields and limits", async () => {
  const { social } = await setup();
  const ph = await social.connect("product-hunt", { person: "umer", slot: "personal" });
  assert.ok(!("url" in ph));
  const draft = await social.draft({ account: ph.id, text: "I built Crewhouse to run a crew on my repos. What would you change?",
    link: "https://example.com", options: { name: "Crewhouse", tagline: "x".repeat(61) }, origin: "person" });
  assert.ok((await social.check(draft.id)).some((i) => i.code === "tagline-too-long"));
  const fixed = await social.edit(draft.id, { options: { name: "Crewhouse", tagline: "A crew for your repos" } }, { revision: 1, origin: "person" });
  const result = await social.post((await social.approve(draft.id, { revision: fixed.revision, by: "umer", at: "now" })).id);
  assert.ok("handoff" in result);
  assert.equal(result.handoff.deepLink, "https://www.producthunt.com/posts/new");
  assert.deepEqual(result.handoff.copyBlocks.map((b) => b.label), ["Name", "Tagline", "Link", "First comment"]);
});

test("secrets stay in the Keystore under hashed names; state, events and errors never carry them", async () => {
  const { social, store, account } = await setup();
  const events: SocialEvent[] = [];
  const off = social.onState((e) => events.push(e));
  const draft = await social.draft({ account: account.id, text: "Hi", origin: "person" });
  off();
  await social.draft({ account: account.id, text: "Unheard", origin: "person" });
  assert.deepEqual(events.map((e) => e.type), ["draft"]);
  assert.equal(draft.network, "fake");
  for (const name of store.entries.keys()) assert.match(name, /^social\.[A-Za-z0-9_-]{43}$/);
  assert.ok([...store.entries.values()].some((v) => v.includes("fake-token")));
  const visible = JSON.stringify([await social.accounts(), await social.drafts(), await social.posts(), events]);
  assert.doesNotMatch(visible, /fake-token/);
});

test("a locked Keystore surfaces as locked; disconnect needs a typed confirm and wipes records", async () => {
  const clock = fakeClock();
  const fake = fakeProvider();
  const store = memoryKeystore();
  const locked = { ...store, async set() { throw Object.assign(new Error("dbus"), { code: "keyring-locked" }); } };
  await assert.rejects(new Social({ store: locked, providers: [fake.provider], now: clock.now })
    .connect("fake", { person: "umer", slot: "a" }), refused("locked"));
  const social = new Social({ store, providers: [fake.provider], now: clock.now });
  const account = await social.connect("fake", { person: "umer", slot: "a" });
  assert.ok(!("url" in account));
  await assert.rejects(social.disconnect(account.id, { confirm: "nope" }), refused("confirm-mismatch"));
  await social.disconnect(account.id, { confirm: account.id });
  assert.equal(store.entries.size, 0);
  assert.deepEqual(await social.accounts(), []);
});

test("providers are opaque: the publish function is not reachable from the handle", () => {
  const { provider } = fakeProvider();
  assert.deepEqual(Object.keys(provider).sort(), ["humanAuthored", "needs", "network", "publish", "review"]);
  assert.ok(Object.isFrozen(provider));
  assert.throws(() => new Social({ store: memoryKeystore(), providers: [{ ...provider }] }), TypeError);
});

test("X hands off to the prefilled composer and Android share intent by default", async () => {
  const social = new Social({ store: memoryKeystore(), providers: [xProvider()] });
  const x = await social.connect("x", { person: "umer", slot: "muxr", handle: "umer" });
  assert.ok(!("url" in x));
  const draft = await social.draft({ account: x.id, text: "muxr 1.0 is out", link: "https://example.com/muxr", origin: "person" });
  const result = await social.post((await social.approve(draft.id, { revision: 1, by: "umer", at: "now" })).id);
  assert.ok("handoff" in result);
  assert.equal(result.handoff.deepLink, "https://x.com/intent/post?text=muxr%201.0%20is%20out%20https%3A%2F%2Fexample.com%2Fmuxr");
  assert.deepEqual(result.handoff.share?.android, { action: "android.intent.action.SEND", type: "text/plain",
    package: "com.twitter.android", extras: { "android.intent.extra.TEXT": "muxr 1.0 is out https://example.com/muxr" } });
  assert.equal(result.post.phase, "handed-off");
});

test("X counts a link as 23 and wide characters as 2, and handoff tickets carry the approved media", async () => {
  const social = new Social({ store: memoryKeystore(), providers: [xProvider()] });
  const x = await social.connect("x", { person: "umer", slot: "muxr" });
  assert.ok(!("url" in x));
  const long = await social.draft({ account: x.id, text: "a".repeat(240), link: `https://example.com/${"p".repeat(60)}`, origin: "person" });
  assert.deepEqual(await social.check(long.id), []);
  const wide = await social.draft({ account: x.id, text: "字".repeat(141), origin: "person" });
  assert.deepEqual((await social.check(wide.id)).map((i) => i.code), ["too-long"]);
  const png = new Uint8Array([137, 80, 78, 71]);
  const pic = await social.draft({ account: x.id, text: "pic", media: [{ data: png, type: "image/png", alt: "Umer" }], origin: "person" });
  const result = await social.post((await social.approve(pic.id, { revision: 1, by: "umer", at: "now" })).id);
  assert.ok("handoff" in result);
  assert.deepEqual(result.handoff.assets, pic.media);
});

test("an X adapter posts only through the approve gate", async () => {
  const sent: string[] = [];
  const provider = xProvider({ adapter: {
    async connect() { return { handle: "umer", origin: "https://aggregator.invalid", remoteId: "1", records: { key: "k" } }; },
    async send(request) { sent.push(request.draft.text); return { remoteId: "x-1" }; },
  } });
  assert.equal(provider.publish, "api");
  const social = new Social({ store: memoryKeystore(), providers: [provider] });
  const x = await social.connect("x", { person: "umer", slot: "muxr" });
  assert.ok(!("url" in x));
  const draft = await social.draft({ account: x.id, text: "Via adapter", origin: "person" });
  await assert.rejects(social.post(draft.id), refused("approval-required"));
  assert.ok("ok" in (await social.post((await social.approve(draft.id, { revision: 1, by: "umer", at: "now" })).id)));
  assert.deepEqual(sent, ["Via adapter"]);
});
