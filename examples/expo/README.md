# Platform Expo example

Overlay, focused field, screen frames and statusbar, extracted from BYOKit's shared example. The AI demos remain
in BYOKit. Native identifiers are preserved for the first split; the Gradle project names follow the new npm scope.

```sh
npm ci
npm run typecheck
npm run bundle
```

Build the repository packages first. For Android JVM tests, prebuild with `CI=1 npx expo prebuild -p android --no-install`,
then use `./gradlew :platform-kits-overlay:testDebugUnitTest :platform-kits-statusbar:testDebugUnitTest` in `android/`.
Screen proof uses `EXPO_PUBLIC_SCREEN_DEMO=1 NODE_ENV=production` for the release build and `./e2e-screen-frame.sh`
on a disposable emulator. The script rejects physical devices. No account or sign-in is needed.
