# overlay-manual-panel

The Android overlay's **manual panel open**: by default a bubble tap still auto-opens the app's registered `panel`;
with `manualPanel: true` in `StartOptions` a tap only emits `tap`, and the app opens the panel itself with
`overlay.openPanel(props)`. This is the opt-in seam that lets an app read the focused field **before** the panel's own
window takes the focus. The example opts in permanently: its `tap` handler reads the focused field and only then calls
`openPanel`, so the proof is the example bubble-panel journey on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own; it refuses a physical device.**

## Sub-features

- **Default auto-open unchanged** — with no `manualPanel` (absent/false), a bubble tap opens `PanelActivity` for the
  configured `panel`, exactly as before; the `panel` event still fires.
- **Opt-in manual open** — with `manualPanel: true`, a bubble tap emits `tap` and does **not** open the panel; the app
  calls `overlay.openPanel(props)` and only then does `PanelActivity` open (the `panel` event fires then).
- **Read before open** — the app's `tap` handler reads the focused field first and passes/keeps it for the panel, so
  the panel shows the field that was focused at the tap, in both a cold and a warm `PanelActivity`.
- **No panel configured** — a tap still only emits `tap` (unchanged); `openPanel` with no stored key rejects
  `Error('overlay: no panel')`.

## How to get to it (user POV)

On the example app: start the bubble, tap a text field and type, then tap the bubble. The panel shows the focused
app and the field's complete text, wrapped; tapping **Close** closes it; tapping the bubble again with no field focused
says so plainly, and with the accessibility service off it says the service is off.

## Driving it

Requires the default example release APK built first (no `EXPO_PUBLIC_SCREEN_DEMO`), then an adb/uiautomator
drive on a disposable emulator owned by the run:

```bash
# --- build the default example (release) ---
cd examples/expo
npm ci && npm run typecheck
CI=1 npx expo prebuild -p android --no-install
NODE_ENV=production ./gradlew assembleRelease        # default example; no EXPO_PUBLIC_SCREEN_DEMO

# --- drive on your own emulator (start it for the test with the standard disposable-emulator flags) ---
serial=emulator-5554   # your run's serial; every adb call names it
```

Drive: install the APK, allow the overlay permission, start the bubble, tap a text field and type, then tap the bubble.
With the example's `manualPanel: true` the tap emits `tap` without a native open, and the `tap` handler reads
`focusedField.read()` and then calls `openPanel`: `PanelActivity` opens for the configured panel (the `panel` event
fires then), showing the field that was focused at the tap, cold and warm; **Close** closes it. Default auto-open (no
`manualPanel`) is proven the same way with `manualPanel: true` temporarily removed from the example's `start`, so a
plain tap opens it.

Pass = the drive log shows tap-only plus explicit open with the example's `manualPanel`, read-before-open showing the
field, Close, and (with the temporary removal) auto-open by default on `<serial>`, with exit 0 and captures under
`$EVIDENCE_DIR/panel`.

## Gotchas

- **The example opts in permanently.** The example sets `manualPanel: true`, so a bubble tap alone no longer opens the
  panel; the panel opens only because the example's `tap` handler reads the field and then calls `openPanel`.
- **`manualPanel` only removes the native auto-launch**; it does not read anything itself. The app is responsible for
  reading the field and calling `openPanel`; forgetting the open leaves the tap as an event only.
- **The script refuses a physical device** (`emulator-*` serial only). Never point it at a real phone, and kill only
  your own emulator (`adb -s <serial> emu kill`), never `adb kill-server`.
