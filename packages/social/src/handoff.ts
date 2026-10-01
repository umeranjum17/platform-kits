import { defineProvider, type ProviderReview, type ProviderSpec, type SocialProvider } from "./provider.ts";
import type { Draft, HandoffTicket, SocialAccount, SocialIssue, SocialNetwork } from "./types.ts";
import { graphemes } from "./util.ts";

/** Connect input for a handoff network: no secret is stored; `handle` is the public username, if any. */
export interface HandoffConnect { person: string; slot: string; handle?: string }

interface Preset {
  network: SocialNetwork;
  review: ProviderReview;
  humanAuthored?: ("text" | "title")[];
  check?(draft: Draft): SocialIssue[];
  link(draft: Draft): string;
  blocks(draft: Draft): HandoffTicket["copyBlocks"];
  share?(draft: Draft): NonNullable<HandoffTicket["share"]>;
  checklist: HandoffTicket["checklist"];
  doNot: string[];
}

function handoff(preset: Preset): SocialProvider {
  return defineProvider({
    network: preset.network, publish: "handoff", review: preset.review, needs: [],
    humanAuthored: preset.humanAuthored ?? [],
    async connect(input) {
      const handle = (input as HandoffConnect).handle ?? "";
      if (typeof handle !== "string") throw new TypeError("handle must be a string");
      return { handle, origin: "", remoteId: handle, records: {} };
    },
    check: (draft) => preset.check?.(draft) ?? [],
    handoff: (draft: Draft, _account: SocialAccount): HandoffTicket => ({
      network: preset.network, deepLink: preset.link(draft),
      copyBlocks: preset.blocks(draft).filter((b) => b.text !== ""),
      ...(preset.share ? { share: preset.share(draft) } : {}),
      checklist: preset.checklist, doNot: preset.doNot,
    }),
  });
}

const text = (draft: Draft) => [{ label: "Text", text: draft.text }];
const tooLong = (field: "text" | "title", value: string, limit: number): SocialIssue[] =>
  graphemes(value) > limit ? [{ code: "too-long", severity: "error", field, limit }] : [];

const HN_GUIDELINES = "https://news.ycombinator.com/newsguidelines.html";
const HN_SHOW = "https://news.ycombinator.com/showhn.html";

/**
 * Hacker News has no write API and asks people not to automate posting. The ticket opens HN's own prefilled
 * submit form; the title and text must be written by a person.
 */
export function hackerNewsHandoff(): SocialProvider {
  return handoff({
    network: "hacker-news", review: "none", humanAuthored: ["title", "text"],
    check: (d) => [
      ...(d.title.trim() === "" ? [{ code: "title-required", severity: "error" as const, field: "title" as const }] : []),
      ...tooLong("title", d.title, 80),
      ...(d.link === "" && d.text.trim() === "" ? [{ code: "link-or-text", severity: "error" as const, field: "link" as const }] : []),
    ],
    link: (d) => d.link
      ? `https://news.ycombinator.com/submitlink?u=${encodeURIComponent(d.link)}&t=${encodeURIComponent(d.title)}`
      : "https://news.ycombinator.com/submit",
    blocks: (d) => [{ label: "Title", text: d.title }, { label: "URL", text: d.link }, ...text(d)],
    checklist: [
      { rule: "Write the title and any text yourself; HN asks for no generated text.", source: HN_GUIDELINES },
      { rule: "Show HN: something people can try now, without a sign-up, and you are around to answer comments.", source: HN_SHOW },
      { rule: "Use the page's own title; no all caps, exclamation marks or clickbait.", source: HN_GUIDELINES },
    ],
    doNot: ["Ask anyone to upvote or comment, anywhere.", "Delete and repost the same story.", "Post it with a script or bot."],
  });
}

const PH_LAUNCH = "https://www.producthunt.com/launch";

/**
 * Product Hunt's API cannot create a post, and company accounts cannot launch. The ticket opens the launch form
 * for the owner's personal account; the first comment (draft `text`) must be written by a person.
 * Options: `name`, `tagline` (60 characters), `description` (260 characters by default).
 */
export function productHuntHandoff(options: { descriptionLimit?: number } = {}): SocialProvider {
  const descriptionLimit = options.descriptionLimit ?? 260;
  const field = (d: Draft, key: string) => (typeof d.options[key] === "string" ? d.options[key] as string : "");
  return handoff({
    network: "product-hunt", review: "none", humanAuthored: ["text"],
    check: (d) => [
      ...(field(d, "name") === "" ? [{ code: "name-required", severity: "error" as const, field: "options" as const }] : []),
      ...(graphemes(field(d, "tagline")) > 60 ? [{ code: "tagline-too-long", severity: "error" as const, field: "options" as const, limit: 60 }] : []),
      ...(graphemes(field(d, "description")) > descriptionLimit
        ? [{ code: "description-too-long", severity: "error" as const, field: "options" as const, limit: descriptionLimit }] : []),
    ],
    link: () => "https://www.producthunt.com/posts/new",
    blocks: (d) => [
      { label: "Name", text: field(d, "name") }, { label: "Tagline", text: field(d, "tagline") },
      { label: "Description", text: field(d, "description") }, { label: "Link", text: d.link },
      { label: "First comment", text: d.text },
    ],
    checklist: [
      { rule: "Launch from your own personal, onboarded account; company accounts cannot post.", source: PH_LAUNCH },
      { rule: "Write the first comment yourself and ask for feedback, not upvotes.", source: PH_LAUNCH },
      { rule: "Name only, no description or emoji; tagline up to 60 characters.", source: PH_LAUNCH },
    ],
    doNot: ["Ask for upvotes or run a voting campaign.", "Use an LLM or extension for comments.", "Post from a brand account."],
  });
}

/** Reddit: API access needs approval and a contract for business use, so posting is by hand. */
export function redditHandoff(): SocialProvider {
  return handoff({
    network: "reddit", review: "vetted",
    check: (d) => tooLong("title", d.title, 300),
    link: (d) => typeof d.options.subreddit === "string" && /^[A-Za-z0-9_]{2,21}$/.test(d.options.subreddit)
      ? `https://www.reddit.com/r/${d.options.subreddit}/submit` : "https://www.reddit.com/submit",
    blocks: (d) => [{ label: "Title", text: d.title }, { label: "URL", text: d.link }, ...text(d)],
    checklist: [{ rule: "Read the subreddit's rules first; they win.", source: "https://support.reddithelp.com/hc/en-us/articles/205926439" },
      { rule: "Keep self-promotion to a small share of your activity.", source: "https://support.reddithelp.com/hc/en-us/articles/360043504051" }],
    doNot: ["Post the same text to several subreddits.", "Ask for votes."],
  });
}

/** TikTok: internal upload tools are not accepted for API access, so the owner posts from the TikTok app. */
export function tiktokHandoff(): SocialProvider {
  return handoff({
    network: "tiktok", review: "audit", link: () => "https://www.tiktok.com/upload", blocks: text,
    checklist: [{ rule: "Turn on the promotional-content disclosure when the video promotes your own product.", source: "https://www.tiktok.com/legal/page/global/bc-policy/en" }],
    doNot: ["Upload through unofficial automation."],
  });
}

/** Text the X composer is prefilled with: the draft text, then its link. */
const xText = (d: Draft) => (d.link ? `${d.text} ${d.link}` : d.text);

/**
 * A later way to post to X on the person's behalf, such as a third-party aggregator. It plugs in behind the same
 * approve gate: the kit still calls `send` only from `Social.post(approval)`. No adapter ships with the kit.
 */
export type XAdapter = Pick<ProviderSpec, "connect" | "send"> & Partial<Pick<ProviderSpec, "prepare" | "disconnect">> & {
  review?: ProviderReview;
};

/**
 * X. The default is assisted-manual: after approval the ticket opens X's prefilled composer (web intent) or, on
 * Android, a share intent to the X app; the post stays handed-off until the person confirms with `markPosted`.
 * Pass an `adapter` to post through a service instead.
 */
export function xProvider(options: { adapter?: XAdapter } = {}): SocialProvider {
  const check = (d: Draft): SocialIssue[] => tooLong("text", xText(d), 280);
  if (options.adapter) {
    const { review = "none", ...adapter } = options.adapter;
    return defineProvider({ network: "x", publish: "api", review, needs: [], humanAuthored: [], check, ...adapter });
  }
  return handoff({
    network: "x", review: "none", check,
    link: (d) => `https://x.com/intent/post?text=${encodeURIComponent(xText(d))}`,
    share: (d) => ({ android: { action: "android.intent.action.SEND", type: "text/plain", package: "com.twitter.android",
      extras: { "android.intent.extra.TEXT": xText(d) } } }),
    blocks: (d) => [{ label: "Post", text: xText(d) }], checklist: [],
    doNot: ["Post the same text from several accounts.", "Post it with a script or bot."],
  });
}

/** LinkedIn: the personal-profile API comes later and Company Pages need vetting, so this hands off to the web. */
export function linkedinHandoff(): SocialProvider {
  return handoff({
    network: "linkedin", review: "vetted", check: (d) => tooLong("text", d.text, 3000),
    link: (d) => d.link ? `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(d.link)}` : "https://www.linkedin.com/feed/",
    blocks: (d) => [...text(d), { label: "URL", text: d.link }],
    checklist: [{ rule: "Post to a Company Page from the Page's admin view.", source: "https://www.linkedin.com/help/linkedin/answer/a564245" }],
    doNot: ["Use automation to post."],
  });
}

/** Threads: API posting is a later phase; this opens Threads' own web intent. */
export function threadsHandoff(): SocialProvider {
  return handoff({
    network: "threads", review: "owner-roles", check: (d) => tooLong("text", d.text, 500),
    link: (d) => `https://www.threads.com/intent/post?text=${encodeURIComponent(d.text)}${d.link ? `&url=${encodeURIComponent(d.link)}` : ""}`,
    blocks: text, checklist: [], doNot: [],
  });
}

/** Instagram: API posting is a later phase; the owner posts from the app. */
export function instagramHandoff(): SocialProvider {
  return handoff({
    network: "instagram", review: "owner-roles", check: (d) => tooLong("text", d.text, 2200),
    link: () => "https://www.instagram.com/", blocks: text, checklist: [], doNot: [],
  });
}

/** YouTube: uploads stay private until an API audit, so the owner uploads in YouTube Studio. */
export function youtubeHandoff(): SocialProvider {
  return handoff({
    network: "youtube", review: "audit", check: (d) => tooLong("title", d.title, 100),
    link: () => "https://studio.youtube.com/", blocks: (d) => [{ label: "Title", text: d.title }, { label: "Description", text: d.text }],
    checklist: [{ rule: "Set the synthetic-media disclosure when AI made realistic content.", source: "https://support.google.com/youtube/answer/14328491" }],
    doNot: [],
  });
}
