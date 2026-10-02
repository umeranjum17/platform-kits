# Contributing to platform-kits

Node 22.18 or later. In every fresh checkout run `npm ci` before build, check or tests.

```sh
npm ci
npm run build
npm run check
npm test
npm run check:readme
npm run smoke:pack
```

Sources are TypeScript run directly by Node with type stripping: `.ts` relative imports, no enums, namespaces or
parameter properties. Keep browser and React Native entries free of runtime Node imports. Platform-specific
entry points and native identities are documented in each package README.

Isolation comes first: tests never read or write the owner's installed applications, logins or tools. The offline
runner uses a throwaway HOME and blocks every non-loopback connection. Record drives only the explicitly passed
protocol-v1 recorder or its bundled Linux recorder. Browser launches only the explicit Chromium binary in a private
profile. Overlay, statusbar and speak run their own native code inside the app. Minimal copied account-isolation
helpers live in `test-support/` as test support, with no production dependency on BYOKit.

For socket tests, export `TMPDIR=$(mktemp -d /tmp/bk-XXXX)` and remove only that directory afterwards.
Real recorder CI runs `sh scripts/test.sh packages/record/test/real/smoke.test.ts` with ffmpeg and Xvfb installed.
Browser CI installs Chromium and passes `PLATFORM_KITS_CHROME` to `npm run test:browser` and the recorder page test
(`packages/record/test/example-recorder-browser.test.ts`). Ordinary tests need no
browser binary, account, network or model.

The Expo example has only platform demos: `npm ci`, `npm run typecheck`, `npm run bundle` in `examples/expo`.
CI prebuilds Android, runs native JVM tests and runs overlay/WebView/screen-frame proofs on its own emulator.
Autolinking names are `:platform-kits-overlay` and `:platform-kits-statusbar`; Kotlin/Expo module identifiers stay
unchanged. Never use the owner's personal test phone. Speak stays private until its native proof and release gate.

One concern per PR. Changes to shipped package source or dependencies need an Unreleased changelog bullet; preserve
SECURITY and FIX markers. CI checks release lint, built README examples, packed installs and the Node 22/24 matrix.
By contributing you agree to Apache-2.0. Do not name recorder products in code, docs or release notes.

Versions are independent 0.x semver. Internal scope dependencies are exact pins and release tooling cascades them.
`npm run release -- prepare record=patch` prepares a reviewed branch; `npm run release -- publish` gates and publishes
only from merged main. First-publication order is record → statusbar → overlay → browser. Speak is held by its
private flag. Configure npm trusted publishers for `umeranjum17/platform-kits`, workflow `release.yml`, after the
organization and packages exist. The workflow uses OIDC provenance without a stored token. No publishing is part of
the extraction PR; do not dispatch it until npm setup and release authorization are complete.
