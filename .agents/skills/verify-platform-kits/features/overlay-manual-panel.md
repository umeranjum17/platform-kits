# overlay-manual-panel

The Android overlay's **manual panel open**: by default a bubble tap still auto-opens the app's registered `panel`;
with `manualPanel: true` in `StartOptions` a tap only emits `tap`, and the app opens the panel itself with
`overlay.openPanel(props)`. This is the opt-in seam that lets an app read the focused field **before** the panel's own
window takes the focus. The proof is the example bubble-panel journey driven with a transient proof-only handler (the
example sets `manualPanel` and reads at the tap) on a disposable emulator; that handler is reverted afterwards.

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

# --- drive on your own emulator (start it for the test with the fleet emulator flags) ---
serial=emulator-5554   # your run's serial; every adb call names it
```

Drive: install the APK, allow the overlay permission, start the bubble, tap it. Default (no `manualPanel`):
`PanelActivity` opens for the configured panel and the `panel` event fires. Then, with a transient proof-only
`manualPanel: true` plus a `tap` → `focusedField.read()` → `openPanel` handler (reverted afterwards; the lasting
example wiring is owned by the bubble-panel example task): the tap emits `tap` without opening, and the explicit
`openPanel` opens it, cold and warm; **Close** closes it in both modes.

Pass = the drive log shows auto-open by default, tap-only plus explicit open with `manualPanel`, and Close in both
modes on `<serial>`, with exit 0 and captures under `$EVIDENCE_DIR/panel`.

## Gotchas

- **The lasting example wiring lives elsewhere.** The example setting `manualPanel: true` and calling `openPanel`
  from its `tap` handler is owned by the example bubble-panel task; the proof here uses a transient proof-only handler
  that is reverted afterwards, so the kit branch stays producer-only.
- **`manualPanel` only removes the native auto-launch**; it does not read anything itself. The app is responsible for
  reading the field and calling `openPanel`; forgetting the open leaves the tap as an event only.
- **The script refuses a physical device** (`emulator-*` serial only). Never point it at a real phone, and kill only
  your own emulator (`adb -s <serial> emu kill`), never `adb kill-server`.
