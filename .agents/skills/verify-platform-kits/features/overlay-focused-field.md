# overlay-focused-field

The Android **focused field** for an app's own accessibility service: `FocusedFields.read`, `capture`, `insert` and
`focusedNode` resolve the exactly focused editable field in a real WebView (Chromium virtual nodes), follow DOM focus
from one field to the next, never touch an unfocused decoy, and give nothing for a password field or with no focus.
The proof is `WebFocusedFieldTest`, an instrumented test in the `a11y-demo` module on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own.**

## Sub-features

- **Read, capture, insert, 10/10** — a textarea and an input each get focus ten times; `read` returns that field's
  seed, and `insert` through `capture` lands in it on the first call.
- **focusedNode** — returns the same field's node 10/10: its text is the seed, it is not the previous field (A -> B
  returns B), its `getBoundsInScreen` matches the DOM rect (snapped out to whole CSS pixels) within 1 px, and after
  the insert it reads the inserted text.
- **No focus, password** — `read`, `capture` and `focusedNode` are null with no focus and on the password field; an
  insert into the password root fails without the clipboard, and the decoy keeps `leave me alone`.

## How to get to it (user POV)

An app's own accessibility service (the test's `WebFieldService`, attached with `ByokitAccessibility.attach`) reads
the field the person is typing in, inside a WebView page (`WebFieldActivity`, debug-only, no network).

## Driving it

From a prebuilt example on a disposable emulator owned by the run (start it with the fleet emulator flags):

```bash
cd examples/expo
npm ci
CI=1 npx expo prebuild -p android --no-install
serial=emulator-5554   # your run's serial
cd android && ANDROID_SERIAL="$serial" ./gradlew :a11y-demo:connectedDebugAndroidTest -PreactNativeArchitectures=x86_64
```

Pass = gradle exits 0 and the test's logcat (`adb -s "$serial" logcat -d -s System.out`) prints `WebView focused
fields: textarea 10/10, input 10/10 (focusedNode matched, A->B, bounds); password hidden; decoy untouched`. The XML
report is under `modules/a11y-demo/android/build/outputs/androidTest-results/`.

## Gotchas

- **Set `ANDROID_SERIAL`.** `connectedDebugAndroidTest` runs on every attached device otherwise, including another
  lane's emulator.
- **The test enables its own accessibility service** and restores the previous `enabled_accessibility_services`.
- **Chromium publishes DOM focus late**; the test waits on the raw framework tree before each kit call, so a kit call
  that needs a retry still fails.
