# overlay-foreground-app

The Android **foreground app package** for an app's own accessibility service: `overlay.foregroundApp()` returns the
active app's package from the attached service, excluding host overlays, and `overlay.on('foregroundApp', ...)`
fires on app switch; it returns null when the service is off or the app is unknown. The proof is
`ForegroundAppTest`, an instrumented test in the `a11y-demo` module on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own.**

## Sub-features

- **Unknown root** — a null active-window root, a root with no package, and a blank package each read null; a
  synthetic root carrying text still exposes only its package.
- **Package, overlay exclusion, detach** — the fixture activity's package resolves with no focused editor;
  a host `TYPE_ACCESSIBILITY_OVERLAY` window on top does not replace it (a separate fixture package underneath
  does); detach clears the getter source and reattach supplies a fresh one.

## How to get to it (user POV)

An app's own accessibility service (the test's `WebFieldService`, attached with `ByokitAccessibility.attach`)
reports which app the person is using, so the app can select per-app suggestions without a focused text field. Only
the package name reaches JS: no screen text, no view children, no new permission.

## Driving it

From a prebuilt example on a disposable emulator owned by the run (start it through the environment's memory gate, with the fleet emulator flags):

```bash
cd examples/expo
CI=1 npx expo prebuild -p android --no-install
serial=emulator-5554   # your run's serial
cd android && ./gradlew :app:installDebug -PreactNativeArchitectures=x86_64
ANDROID_SERIAL="$serial" ./gradlew :a11y-demo:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64
```

Pass = gradle exits 0 with the fixture activity package reported and null after the service detaches. The XML
report is under `modules/a11y-demo/android/build/outputs/androidTest-results/`.

## Gotchas

- **Set `ANDROID_SERIAL`.** `connectedDebugAndroidTest` runs on every attached device otherwise, including another
  lane's emulator.
- **Install the example app first.** The overlay-exclusion leg starts `ForegroundFixtureActivity` in the example
  app's package (`io.github.umeranjum17.byokit.example`), which only exists on-device after `:app:installDebug`.
- **The test enables its own accessibility service** and restores the previous `enabled_accessibility_services`.
