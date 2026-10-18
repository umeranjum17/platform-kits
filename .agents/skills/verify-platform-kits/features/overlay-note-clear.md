# overlay-note-clear

The Android overlay's transient `say()` note stays clear of the app-named keep-clear rectangles and the focused text field after an insert. It prefers below, above, then a side with room, and clamps the whole note row to the usable screen. The real consumer flow is `examples/expo/e2e-assist.sh`; inspect its final `field.png` alongside the captured field value and overlay window.

**Emulator-only.** Run on a disposable emulator with no audio; never use a physical device.

## Sub-features

- **Insert feedback avoids the field** — after `Put it in the field`, the app field equals the shown draft and the transient note is visible without covering the inserted field text.
- **Placement fallback** — `BubbleTest.noteMovesBesideAFullHeightFieldWhenThereIsNoVerticalSpace` exercises the side placement and checks zero overlap and screen bounds.
- **Real-flow screenshot** — `field.png` is captured after the example app's real panel insert journey; inspect it before reporting.

## How to get to it (user POV)

Start the example bubble and accessibility service, enter text, open the bubble panel, choose **Help me write**, then **Put it in the field**. The note appears after the example verifies the inserted field value. Nothing is sent.

## Driving it

Build the default example release APK, then run on a disposable emulator using the standard flags from `verify-platform-kits/SKILL.md`:

```bash
cd examples/expo/android
NODE_ENV=production ./gradlew assembleRelease
cd ..
sh e2e-assist.sh <emulator-serial> "$EVIDENCE_DIR/assist"
```

The script installs the example, uses only its own accessibility service, captures `assist/field.png` after insertion and confirms the native field equals the draft. Keep the full command output in the evidence folder. Also run the focused native regression:

```bash
cd examples/expo/android
./gradlew :platform-kits-overlay:testDebugUnitTest --tests io.github.umeranjum17.byokit.overlay.BubbleTest
```

Pass = both commands exit 0, the assist log says `passed assist draft, length check and insert`, and the inspected final screenshot shows the inserted field text unobscured by the note.

## Gotchas

- The script stops before any send action; do not tap or add one.
- The test emulator must be silent (`-no-audio`); no phone volume changes.
- Do not mistake a successful field insert for a placement pass: inspect `field.png` and verify the field text remains readable.
- The kit can avoid only the boxes it receives plus the focused field bounds; it cannot infer unrelated controls in the host app.
