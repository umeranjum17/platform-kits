import type { SocialProvider } from "./provider.ts";

export interface MastodonOptions {
  /** Name shown on the instance's authorization page. */
  clientName?: string;
  website?: string;
}
export type MastodonConnect =
  | { person: string; slot: string; instance: string; redirectUri: string }
  | { person: string; slot: string; instance: string; accessToken: string };

export function mastodonProvider(_options?: MastodonOptions): SocialProvider { throw new Error("todo"); }
