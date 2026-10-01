# Extraction provenance

BYOKit source: `88eb2e2f666336d49f0ce18cf0e424d8491c09c9` (origin/main, 2026-10-01 UTC).
Browser source: `015954dead553ec9bcba6dea0f4327143fa5c8d8`, branch `fm/byk-browser`,
[open change](https://github.com/umeranjum17/byokit/pull/208). Its three path-limited patches were replayed with
`git format-patch` / `git am`, preserving author names, emails and dates, before filtering the combined history.
`browser-source-commits.txt` and `browser-replayed-commits.txt` record the series; `commit-map.txt` maps the
combined pre-filter history to the extracted history (all-zero destinations indicate pruned commits).

`git-filter-repo 2.47.0` ran only on a fresh disposable clone. It retained packages/overlay, statusbar, record,
speak and browser; historical packages/capture and packages/status; packages/test-support.ts; the two copied
accounts test helpers (renamed to test-support/isolation.ts and trace-fs.ts); the platform Expo App/ScreenDemo,
entry, config, assets, accessibility module and screen-proof script; capability/convention docs and recorder
proof image; root manifests/TypeScript/license files; build/declaration, offline-test, release, README and pack
scripts/tests; selected CI/release/dependency workflows. Shared files were then narrowed to platform kits.
No BYOKit tag was copied, no BYOKit history was rewritten, and no kit was removed from BYOKit.

At the cut [the release batch](https://github.com/umeranjum17/byokit/pull/217) was already merged, so overlay is
0.3.0 (not the earlier plan's 0.2.5). Statusbar 0.1.1, record 0.2.0 and speak 0.1.0 are unchanged; browser is 0.1.0.
Speak remains private. The [foreground-app draft](https://github.com/umeranjum17/byokit/pull/218) is left paused
and unmerged; its patch is not part of this extraction. Hosted MCP and all AI kits stay in BYOKit.

Consumer pins at planning remain unchanged: Crewhouse overlay 0.2.5/statusbar 0.1.1, muxr mobile statusbar 0.1.1.
No consumer was migrated and no old npm release was deprecated or unpublished. The speak, statusbar Expo 55 and recorder branches were compared by package trees against the cut: their
package content matches main despite their original commits not being ancestors after squash merges. The recorder
timeout branch has an older CI workflow and supplies no additional recorder package changes. Only browser's
approved unmerged series is ported; other open work remains on its existing BYOKit branches.

The new repository was initialized separately with Apache-2.0 and its initial commit is retained as a merge parent
so the extraction can be reviewed as a normal PR. Delivery is on fm/pk-move; only the configured merge authority
may update the destination's default branch. npm organization creation and trusted-publisher setup remain pending.
