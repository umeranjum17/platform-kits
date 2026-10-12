# overlay-keep-clear

The Android overlay bubble's **keep-clear** behavior: when the person asks the bubble to keep clear, its pill moves
off the text field it was covering; when no clear spot exists it stays at its saved spot and says so; when they turn
keep-clear off it returns to that saved spot. With the app's accessibility service attached, the bubble also keeps off
the focused text field by itself, with no boxes from the app, and returns when focus leaves. The proof is
`examples/expo/e2e-keep-clear.sh`, an account-free journey that measures real window boxes on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own; it refuses a physical device.**

## Sub-features

- **Keep clear from the field** — after `keepClear`, the bubble's `APPLICATION_OVERLAY` window and the focused field's
  bounds have **zero** overlap area, and the status reads `Keeping clear of …`.
- **No clear spot** — with `keepClearAll` and nowhere free, the bubble stays at its saved spot (same top coordinate)
  and the status reads `No clear spot: the bubble stays put.`
- **Restore** — `keepClearOff` returns the bubble to the saved spot it held before keep-clear.
- **Truthful fixture** — the script first drags the bubble so its pill *does* cover the field (`the pill does not
  cover the field` fails otherwise), so the "clear" result is not vacuous.
- **Focused field, no boxes** — after a force-stop the script turns on `DemoAccessibilityService`, starts the bubble
  at the same saved spot over the *unfocused* field (fixture: `focused="false"` and overlap > 0), taps `fieldInput`
  without the keepClear button, and requires `focused="true"` and **zero** overlap with the keyboard open. Home then
  takes focus away, and the bubble's top must return to the saved top.

## How to get to it (user POV)

On the example app: start the bubble, type into the field, drag the bubble over the field, tap **Say**, then tap
**Keep clear**. The pill lifts off the field. With no space it stays put and the status says so. Tapping **Keep clear
off** (or sending a message) returns it. With Umer's accessibility service on, tapping into the field alone moves the
bubble off it, and going Home brings it back.

## Driving it

Requires the default example release APK built first (no `EXPO_PUBLIC_SCREEN_DEMO`), then the script on a disposable
emulator owned by the run:

```bash
# --- build the default example (release) ---
cd examples/expo
npm ci && npm run typecheck && npm run bundle
CI=1 npx expo prebuild -p android --no-install
NODE_ENV=production ./gradlew assembleRelease        # default example; no EXPO_PUBLIC_SCREEN_DEMO

# --- run on your own emulator (start it for the test through the environment's memory gate, with the fleet emulator flags) ---
serial=emulator-5554   # your run's serial; every adb call names it
sh e2e-keep-clear.sh "$serial" "$EVIDENCE_DIR/keep-clear"
```

The script itself installs the APK, grants `SYSTEM_ALERT_WINDOW`, drives the UI with `uiautomator`, measures the
overlap of the field and the bubble window, turns the example's accessibility service on for the focused-field part,
and writes `keep-clear-1-before.png` … `keep-clear-4-cleared.png`, `focus-1-unfocused.png`, `focus-2-focused.png`
and `focus-3-left.png` plus `boxes.txt` and `windows.txt` into the capture directory.

Pass = the script prints `passed keepClear on <serial>` and `passed focused-field keep-clear on <serial>` and exits
0; `boxes.txt` shows `overlap=0` on the `keep-clear-2-after` and `focus-2-focused` lines, the same top coordinate on
the no-space and cleared lines, and the `focus-3-left` bubble top equal to its `saved` top.

## Gotchas

- **The script refuses a physical device** (`emulator-*` serial only). Never point it at a real phone.
- **`appops SYSTEM_ALERT_WINDOW` must be allowed** before the bubble window exists; the script sets it, but a stale
  install without it shows no `APPLICATION_OVERLAY` window and `bubble()` fails with "no bubble window".
- **Overlap is measured in physical pixels** from `dumpsys window` (`frame=`/`mFrame=`) and `uiautomator` bounds; a
  rotated or resized display changes the numbers but not the pass condition (zero overlap after keep-clear).
- **The focused-field part enables an accessibility service** on the emulator (the script clears it again at its
  start). A force-stop turns an app's service off, so the script enables it after the force-stop.
- **Kill only your emulator** (`adb -s <serial> emu kill`); never `adb kill-server` or touch another lane's device.
