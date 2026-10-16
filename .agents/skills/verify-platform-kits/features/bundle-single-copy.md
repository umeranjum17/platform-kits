# bundle-single-copy

The Expo example bundles exactly one copy of react, react-native and expo-modules-core — the app's own copies, as an
install from npm would give. A file:-linked kit's devDependency must never leak a second React Native or an older
expo-modules-core into the app's JavaScript bundle. The guard is `scripts/bundle-single-copy.ts`, run in CI against
sourcemaps exported from `examples/expo`.

## Sub-features

- **Single root per module** — for every `.map` in the export, all sources under `node_modules/<name>/` fingerprint
  byte-identical against the app's own copy (`examples/expo/node_modules/<name>/`, or nested under
  `examples/expo/node_modules/expo/node_modules/<name>/` when a kit devDep took the hoist slot, as expo-modules-core
  does on SDK 58).
- **Wrong-root detection** — a source whose content is not the app's copy (for example the repository-root
  react-native 0.87 pulled in by kit devDeps) prints its offending paths and fails the run with exit 1.

## How to get to it (user POV)

1. Build once: `npm ci && npm run build` (SKILL.md Launch); then `npm ci --no-audit --no-fund` in `examples/expo`.
2. From `examples/expo`: `npx expo export --platform android --platform ios --source-maps --output-dir <dir>`.
3. From the repo root: `node scripts/bundle-single-copy.ts <dir>` — exit 0 and one
   `["examples/expo/node_modules"]` root per module per map is the pass.

## Driving it

Set `EVIDENCE_DIR` (SKILL.md Evidence) and run the whole journey — export plus check — as one drive:

```bash
drive=(bash -c 'set -eu
cd examples/expo
npx expo export --platform android --platform ios --source-maps --output-dir "$EVIDENCE_DIR/dist-verify"
node ../../scripts/bundle-single-copy.ts "$EVIDENCE_DIR/dist-verify"
rm -rf "$EVIDENCE_DIR/dist-verify"')
```

Pass: exit 0, and each printed line ends `react|react-native|expo-modules-core ["examples/expo/node_modules"]`.
The check is regression-sensitive by construction: reverting `experiments.autolinkingModuleResolution` in
`examples/expo/app.json` makes it exit 1 with react-native listing two roots.

## Gotchas

- The export needs `--source-maps`; without sourcemaps there are no `.map` files and the check trivially passes.
- Metro emits server-relative source paths, so the app copy and the repository-root copy collapse to one printed
  path — discrimination is by `sourcesContent` fingerprint, not by path.
- Do not delete `examples/expo/node_modules/expo/node_modules/expo-modules-core` (the app's hoist-blocked copy) from
  the analysis; the check reads it to fingerprint the app's real version.
