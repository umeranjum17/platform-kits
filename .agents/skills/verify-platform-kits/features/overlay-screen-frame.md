# overlay-screen-frame

The Android **screen-frame** and **point-marker** behaviors: screen capture asks for consent every time (a denial
resolves and starts no capture service), a saved screen reads back as a PNG, and a point marker rings a real target,
receives the person's tap through to the app beneath, dismisses on request, auto-dismisses on timeout, and walks a
five-step tour. The proof is `examples/expo/e2e-screen-frame.sh`, an account-free journey on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own; it refuses a physical device.**

## Sub-features

- **Consent, every request** — `screenCapture` opens the system dialog; **Cancel** resolves to `Picture cancelled.`
  and `no_capture` confirms no `ScreenFrameService` is left running; a fresh consent reaches `Picture ready.` and
  writes one readable PNG; a later capture still re-asks.
- **Point marker** — `screenPoint` rings a target, the underlying button receives the tap (`Umer tapped through 1
  time.`), and the marker is drawn as the `byokit-point-marker` window.
- **Dismiss and timeout** — `screenDismiss` clears it (`Ring dismissed.`); `screenPointShort` auto-dismisses after its
  timeout.
- **The tour** — `screenTour` puts targets at the top, left, middle, right and bottom; each tap advances (`Step n of
  5`) and the finish reads `All done. Umer found every step.`

## How to get to it (user POV)

On the example app: tap **Show a screen guide** (`Guide ready.`), tap **Capture the screen**, choose Allow or Cancel
in the system dialog, then tap **Point at something** to ring a button and tap through it. **Take the tour** visits the
five edges; each tap moves the ring.

## Driving it

Requires the screen-demo release APK, then the script on a disposable emulator owned by the run:

```bash
# --- build the screen-demo example (release) ---
cd examples/expo
npm ci && npm run typecheck && npm run bundle
CI=1 npx expo prebuild -p android --no-install
EXPO_PUBLIC_SCREEN_DEMO=1 NODE_ENV=production ./gradlew assembleRelease

# --- run on your own emulator ---
serial=emulator-5554   # your run's serial; every adb call names it
sh e2e-screen-frame.sh "$serial" "$EVIDENCE_DIR/screen-frame"
```

The script installs the APK, enables the app's accessibility service, drives the UI with `uiautomator`, and writes
`byokit-screen-consent.png`, `byokit-screen-marker.png`, `byokit-screen-tour-1-top.png` … `-5-bottom.png`, plus
`taps.txt`; on a failed `expect` it also dumps `timeout-ui.xml`, `timeout-windows.txt`, `timeout-logcat.txt` and
`timeout-screen.png`.

Pass = the script prints `passed screen-frame and point marker on <serial>` and exits 0, the consent and marker PNGs
are in the capture directory, and no `ScreenFrameService` runs after a cancelled capture or a finished tour.

## Gotchas

- **The script refuses a physical device** (`emulator-*` serial only). Never point it at a real phone.
- **The accessibility service must be enabled** by the run (`settings put secure enabled_accessibility_services …`);
  without it the screen guide shows no capture and `expect 'A little help for Umer'` times out.
- **The marker is a window, not a screenshot.** `expect_marker` checks `dumpsys window` for `byokit-point-marker`;
  taps use physical-pixel centres from `uiautomator` bounds.
- **Consent is per-request by design.** A successful capture never exempts the next one; the final leg re-requests and
  cancels to prove it.
- **Kill only your emulator** (`adb -s <serial> emu kill`); never `adb kill-server` or touch another lane's device.
