# First stable checkpoint — 2026-10-02

Release preparation: record **0.2.1**, statusbar **0.1.2**, overlay **0.3.1**, browser **0.1.1**.
Speak **0.1.0** and social **0.1.0** remain **private**, not npm releases.
Publication and exact release commit are verified separately in the release report; this document is not a publish-success assertion.

This is the first publication under `@platform-kits`. Most capabilities were carried over with preserved history, not implemented anew for this checkpoint. Patch versions roll the extraction's Unreleased notes through the existing release tooling without duplicating historical version headings. No third-party dependency upgrades are included.

## New

- An independent Apache-2.0 platform-kit repository with preserved package ancestry, unchanged native module identities and independent CI. Carried-over public capabilities: Android overlay bubble/panel, focused-field read/verified insertion, consent-gated screen frames and point markers; Android status-bar notification chips/actions; a Node recorder protocol client and bundled Linux X11 backend; isolated Chromium screenshots. [Foundation](https://github.com/umeranjum17/platform-kits/pull/1), [source cut and commit maps](../history/README.md).
- A desktop recorder example: choose a screen, explicitly Start, see a timer and Stop card, then a saved preview, file details and Share. [Recorder change](https://github.com/umeranjum17/platform-kits/pull/4).
- **Private source only:** social drafts, checks, exact-payload single-use approvals, a host-provided keystore, local queue, Bluesky/Mastodon adapters and assisted-manual X handoff. Each post remains a person-approved action. No social npm publication, automated posting or live-account qualification. [Social change](https://github.com/umeranjum17/platform-kits/pull/2).

## Fixed

- **FIX:** Recorder capture is now 30 fps constant rate into a lossless take in the screen's own colours, replacing 15 fps lossy intermediate capture. `make()` is the only lossy pass, keeping text sharper. The card reports capture promptly and shows Stopping immediately when Stop is pressed. [Recorder change](https://github.com/umeranjum17/platform-kits/pull/4).
- Carried-over fixes, not new checkpoint implementation: reliable focused-web-field resolution and same-field re-acquisition, password paths never exposed or written, cancellation and native teardown cleanup, TalkBack activation without duplicate taps, and Expo plugin/package exports. [Foundation](https://github.com/umeranjum17/platform-kits/pull/1).

## Improved

- Steadier recording on a busy machine. Lossless intermediate takes trade disk space for quality: about 5 MB/s for a busy 1080p screen while the take exists. [Recorder change](https://github.com/umeranjum17/platform-kits/pull/4).
- Carried-over isolation and verification: throwaway test homes, offline mocks/network guard, packed-install and README checks, Node 22/24 CI, real isolated Chromium/Xvfb recorder proofs, native bundles and Android tests. These are test environments, not store or personal-phone qualification. [Foundation](https://github.com/umeranjum17/platform-kits/pull/1).

## Existing visible evidence

- The recorder owner's accepted proof reports a 26.1-second, 1920×1080 H.264 output at 30/1 fps with 783 frames, captured on a private display with Chromium. This is desktop proof, not mobile/Wayland/store qualification; [the merged change describes the original session](https://github.com/umeranjum17/platform-kits/pull/4).
- [Archived isolated recorder still](../evidence/byokit-record-recorder.png): a private local demonstration display retained from the foundation. It is not a new capture of the desktop example and does not independently prove 30 fps.
- [Archived approved Mastodon post](../evidence/social-mastodon-local-approved-post.png): the visible account/server is localhost:3443. This is local-provider/browser proof only, not public-account authentication or a live external post.
- Android screen-frame/WebView/overlay proof comes from disposable CI emulators. No personal phone, app-store submission or live-provider test was performed for this release lane.

## Known issues and exclusions

- The guide ring/callout layout, edge placement and bubble contrast work is **excluded** while its checks are red. Its five-position tour captures are not checkpoint evidence. [Unmerged guide change](https://github.com/umeranjum17/platform-kits/pull/3).
- Speak stays private pending native proof and its release gate. Social stays private, with only offline/local-network proof; live provider authentication and posting remain unqualified. X uses manual handoff; the archived intent reaches a login wall, not a verified submitted post.
- Bundled recorder: Linux X11 only, host-installed ffmpeg/ffprobe required. No audio or input-event capture. Wayland, macOS, Windows and mobile require an explicit external protocol-v1 backend. Screen video contains everything visible on the chosen display; start must be explicit, takes stay local, and the host owns retention/deletion.
- Browser: Node-only with an explicitly selected installed Chromium/Chrome; no Firefox/WebKit or personal-profile attachment. Forced process termination can leave temporary profiles for host cleanup.
- Overlay's implemented native capabilities are Android-only. Statusbar promoted chips require Android 16; older Android and iOS report unsupported. Screen-frame capture requires fresh system consent per PNG; password-field protection is preserved.
- No consumer migration, old-release deprecation/unpublishing, new foreground/capture-node work, new platform/API feature, dependency modernization or new emulator run merely to repeat archived accepted proof.
- Local npm publication does not establish trusted-publisher/OIDC provenance. Final registry metadata, tarball integrity and every-file payload comparison are recorded separately; no trusted provenance claim is made without evidence.
