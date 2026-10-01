# Platform kits

Generic, non-AI platform capabilities split from [BYOKit](https://github.com/umeranjum17/byokit).
BYOKit remains the home for AI accounts, decisions and runtime integrations. This public repository is Apache-2.0.

| Package | Version at the cut | Capability |
|---|---|---|
| [@platform-kits/overlay](packages/overlay) | 0.3.0 | Android bubble, panel, focused field, screen frames and point markers |
| [@platform-kits/statusbar](packages/statusbar) | 0.1.1 | Android status-bar chip with actions and a lock-screen copy |
| [@platform-kits/record](packages/record) | 0.2.0 | Screen recording and video through recorder protocol v1 |
| [@platform-kits/speak](packages/speak) | 0.1.0, private | Platform text-to-speech |
| [@platform-kits/browser](packages/browser) | 0.1.0 | Isolated Chromium screenshots of URLs or local HTML |

The split retains the package APIs and native module identities. New package names use the `@platform-kits` npm
scope; speak stays `private: true`. Existing `@byokit/*` releases stay available. Consumer migration, deprecation
and removal from BYOKit are separate work.

```sh
npm ci
npm run build
npm run check
npm test
npm run check:readme
npm run smoke:pack
```

Tests use a throwaway HOME, fake backends and an outbound-network guard. Real browser and recorder CI use an
explicit Chromium binary and a private Xvfb display. Native tests use disposable emulators, never a person's phone.
The [Expo example](examples/expo) demonstrates overlay and statusbar, and the [desktop recorder](examples/recorder)
demonstrates record. AI demos remain in BYOKit.

See [contributing](CONTRIBUTING.md), the [capability contracts](docs/capability-kits.md), and
[extraction provenance](docs/history/README.md). Release tooling publishes only from merged main with passing CI.
