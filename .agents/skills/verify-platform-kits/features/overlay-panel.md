# overlay-panel

The bubble's tap panel: tapping the example's bubble opens `BubblePanel` in its own translucent activity, which shows
the app and the complete text of the field that was in focus when the bubble was tapped, wrapped and untruncated, plus
a reachable Close. With no field in focus, or no accessibility service, the panel says so plainly instead of pretending
a read happened. The proof is `e2e-panel.sh` on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own.**

## Sub-features

- **Read in full** — a long synthetic value typed in the example's own field is handed to the panel by the bubble
  (whose window never takes the focus); the panel shows the exact same text, wrapped over several rows, with no
  ellipsis, and names the focused app.
- **Close stays reachable** — the panel keeps Close visible at a narrow 360 dp width and font scale 1.3, even with the
  value overflowing its scroll area.
- **Honest empty state** — with no field in focus the panel says so; with no accessibility service it says to turn the
  service on. It never shows a stale or invented reading.
- **Notice** — starting the bubble posts the foreground notice titled with the example's own name and its monochrome
  `byokit_notification` glyph, readable in light and dark mode.

## How to get to it (user POV)

Start the bubble, type in a text field (here the example's own), then tap the bubble: the panel opens from the bottom
showing the field it read. Close returns to the app.

## Driving it

From a prebuilt example on a disposable emulator owned by the run (start it with the fleet emulator flags, and build
the default example first — no `EXPO_PUBLIC_SCREEN_DEMO`):

```bash
cd examples/expo
CI=1 npx expo prebuild -p android --no-install
cd android && NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=x86_64
cd .. && ./e2e-panel.sh <emulator-serial> [capture-directory]
```

Pass = the script exits 0 and prints `passed panel read, wrap and Close on <serial> (light and dark)`. It enables only
the example's own accessibility service, waits for the app to report it attached, types a long value, retains the
field's **actual native value** from the UI dump, opens the real panel, asserts the panel's text equals that value with
no ellipsis and the app line names the example, then taps Close. It repeats in light and dark at 360 dp / font scale
1.3 and captures `panel-light.png`, `panel-dark.png`, `notice-light.png`, `notice-dark.png` under the capture directory.
Set `EVIDENCE_DIR` outside the repository and keep those stills there.

## Gotchas

- **The panel's own window takes the field's focus.** The panel cannot read the field itself once it opens; the bubble
  reads it while it still has focus and hands the reading to the panel at tap.
- **`pm clear` disables the accessibility service asynchronously.** Enable it after the clear and wait for the app's
  own "Read the focused field" to report `available: true`; `dumpsys accessibility` can briefly show a dead binding.
- **Set `ANDROID_SERIAL` / pass the serial.** Every `adb` call is `-s <serial>`; never run against another lane's
  emulator.
- The stills behind the panel show the example's own debug buttons; that is the existing demo screen, not the panel.
