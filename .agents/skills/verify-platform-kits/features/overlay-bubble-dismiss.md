# overlay-bubble-dismiss

The Android overlay bubble's **drag to dismiss**: while the bubble is dragged, a `Drop here to turn it off` target
(window title `byokit-dismiss-target`) shows at the bottom centre above the gesture bar and turns red while the
bubble's centre is over it. Dropping the bubble there turns it off and the app hears `dismissed` once. Dropping it
anywhere else snaps it to the nearest edge. A dismiss never changes the saved spot, so the next `start()` brings the
bubble back where it was. The proof is `examples/expo/e2e-bubble-dismiss.sh`, which drags the bubble with
`input swipe` and `input motionevent` under `screenrecord` on a disposable emulator.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own; it refuses a physical device.**

## Sub-features

- **Target only while dragging** — no `byokit-dismiss-target` window before a drag or after a drop; mid-drag it is
  there, horizontally centred, in the lower half and above the gesture bar (`dumpsys window`).
- **Snap, not dismiss** — a drop mid-screen snaps the bubble to the left edge and it stays on (`left` is 0).
- **Highlight** — held over the target, it turns red (`bubble-dismiss-4-over-target.png`); let go back at its start,
  the bubble stays on at the same spot.
- **Dismiss on the target** — a swipe onto the target's centre: the example shows `Bubble dismissed.` (testID
  `bubbleDismissed`), no overlay window of the example is left, and the Start button returns.
- **Saved spot kept** — `start()` after the dismiss puts the bubble at exactly the frame it held before.
- **Recording** — the whole run is recorded to `bubble-dismiss.mp4` in the capture directory.

## How to get to it (user POV)

On the example app: tap **Start the bubble**, then drag the bubble. A dark **Drop here to turn it off** pill appears
at the bottom centre; drag the bubble onto it and it turns red. Let go to turn the bubble off, and the example says
`Bubble dismissed.` Tap **Start the bubble** and the bubble comes back at the spot it had before.

## Driving it

Requires the default example release APK built first (no `EXPO_PUBLIC_SCREEN_DEMO`), then the script on a disposable
emulator owned by the run (API 31+; CI uses 36):

```bash
# --- build the default example (release) ---
cd examples/expo
npm ci && npm run typecheck && npm run bundle
CI=1 npx expo prebuild -p android --no-install
(cd android && NODE_ENV=production ./gradlew assembleRelease)

# --- run on your own emulator (start it for the test with the standard disposable-emulator flags) ---
serial=emulator-5554   # your run's serial; every adb call names it
sh e2e-bubble-dismiss.sh "$serial" "$EVIDENCE_DIR/bubble-dismiss"
```

Pass = the script prints `passed bubble dismiss on <serial>` and exits 0, with `bubble-dismiss.mp4`, the
`bubble-dismiss-1-start` … `bubble-dismiss-6-restored` PNGs and the `windows-*.txt` dumps (`windows-mid-drag.txt` has
the `byokit-dismiss-target` window, `windows-after-dismiss.txt` no overlay window of the example) in the capture
directory. Open `bubble-dismiss-2-dragging.png` (dark target)
and `bubble-dismiss-4-over-target.png` (red target, the bubble showing through) to see the highlight.

## Gotchas

- **Not `input draganddrop`**: it holds the touch for the long-press timeout before moving, the bubble takes that as
  a long press, and the drag never starts. The script uses a slow `input swipe` (target located mid-drag), a held
  `input motionevent` drag for the highlight, and an `input swipe` onto the located target for the dismiss.
- **Grab the bubble on its inner side**: a touch that starts near the screen edge (the bubble's outer half, on gesture
  navigation) is taken by the system back gesture, which cancels the drag and closes the example. The script grabs a
  sixth of the bubble's width in from its inner side and offsets the drop so the bubble's centre lands on the target.
- **A busy emulator is slow to dump and capture**: `dumpsys window` and `screencap` can each take seconds, so the
  script takes both at once during a 10 s swipe and then checks the target is still there, which proves the
  screenshot is mid-drag.
- **The script refuses a physical device** (`emulator-*` serial only). Never point it at a real phone.
- **The script does not count `dismissed` events**: it checks the example's text, the windows and the saved spot.
  The once-only emit is the single `ACTION_UP` branch in `Bubble.kt`.
- **Kill only your emulator** (`adb -s <serial> emu kill`); never `adb kill-server` or touch another device.
