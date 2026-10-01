import type { SocialErrorCode, SocialIssue } from "./types.ts";

const messages: Record<SocialErrorCode, string> = {
  "not-found": "That draft, approval or account does not exist.",
  "draft-stale": "The draft changed since you last saw it. Review the latest version.",
  "check-failed": "The draft has problems to fix before it can be approved.",
  "human-authored": "A person needs to write or confirm this text before it can be approved.",
  "confirm-mismatch": "Confirm by passing the same account id.",
  "approval-required": "Nothing is posted without an approval.",
  "approval-used": "This approval was already used. Approve the post again.",
  "approval-void": "The draft changed after it was approved. Approve it again.",
  "stale-approval": "This approval has expired, so nothing was posted. Approve it again.",
  "not-due": "This post is approved for a later time.",
  "signed-out": "Sign in to this account again.",
  "locked": "Unlock the device's secret store to use this account.",
  "rate-limited": "The network asked to slow down. Try again later.",
  "rejected": "The network refused the post.",
  "duplicate-content": "The network refused a duplicate post.",
  "media-processing": "The network could not process the media.",
  "unsupported": "This network does not support that.",
  "network": "The network could not be reached. The post may or may not have gone out.",
  "store-failed": "The kit could not save its state.",
  "connect-failed": "The account could not be connected.",
};

/** Safe to display: messages are fixed per code and never carry tokens, passwords or server bodies. */
export class SocialError extends Error {
  readonly code: SocialErrorCode;
  /** Epoch ms after which a rate-limited call may be retried, when the network said so. */
  readonly until?: number;
  readonly issues?: readonly SocialIssue[];
  constructor(code: SocialErrorCode, detail: { until?: number; issues?: SocialIssue[] } = {}) {
    super(messages[code]);
    this.name = "SocialError";
    this.code = code;
    if (detail.until !== undefined) this.until = detail.until;
    if (detail.issues) this.issues = detail.issues;
  }
}
