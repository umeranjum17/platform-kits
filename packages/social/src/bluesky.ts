import type { OAuthClientMetadataInput } from "@atproto/oauth-client";
import type { SocialProvider } from "./provider.ts";

export interface BlueskyOAuthOptions {
  /** The app's hosted client metadata (its `client_id` is the metadata URL), or a loopback development client. */
  clientMetadata: OAuthClientMetadataInput;
  /** Origin serving com.atproto.identity.resolveHandle, such as the account's PDS or an AppView. */
  handleResolver: string;
  /** PLC directory for did:plc lookups. Default https://plc.directory. */
  plcDirectoryUrl?: string;
  /** Development only: allow plain-HTTP authorization and resource servers. */
  allowHttp?: boolean;
}
export interface BlueskyOptions {
  /** Entryway for app-password sign-in when the connect input names none. Default https://bsky.social. */
  service?: string;
  /** Web app used for post links. Default https://bsky.app. */
  appView?: string;
  /** Enable AT Protocol OAuth sign-in. Without it only app passwords are accepted. */
  oauth?: BlueskyOAuthOptions;
}
export type BlueskyConnect =
  | { person: string; slot: string; identifier: string; appPassword: string; service?: string }
  | { person: string; slot: string; handle: string; oauth: true };

export function blueskyProvider(_options?: BlueskyOptions): SocialProvider { throw new Error("todo"); }
