# overlay-bubble-shadow

The Android overlay bubble's **disc shadow**: a soft crescent just below the disc, so it lifts off light pages. It is a
window of its own (title `byokit-bubble-shadow`) under the bubble's, sized to the disc plus 8dp, that never takes
touches: a tap just below the disc reaches the app. The bubble's own window stays the disc's size, so the touch target,
snap and `keepClear` match a bubble without a shadow. The proof is `examples/expo/e2e-bubble-shadow.sh`.

**Emulator-only. The phone proof is unproved until this runs on an emulator you own; it refuses a physical device.**

## Sub-features

- **Light pages** — over the example (white, in either night mode), the pixels 2, 3, 4, 5 and 6dp below the disc's
  bottom edge are each at least 10 luminance darker than the background 16dp below it.
- **Near-black pages** (background luminance below 30: the home screen and app drawer under night mode) — none of those
  pixels is lighter than the background, and the disc's light rim is at least 30 lighter than it. A shadow cannot get
  10 darker on a background at 15-19; the rim is what sets the disc apart there. The numbers are logged either way.
- **Taps pass through** — with the shadow over the example's field, a tap 3dp below the disc focuses the field
  (`focused` false, then true).
- **Moves with the disc** — the shadow window's top-left equals the disc's (`bubble=` and `shadow=` in the log).

## How to get to it (user POV)

On the example app: tap **Start the bubble**. A soft shadow shows under the disc on light pages. Drag the bubble over
the text field and tap just below the disc: the field takes the tap.

## Driving it

Requires the default example release APK built first (see [overlay-keep-clear](./overlay-keep-clear.md)), then:

```bash
serial=emulator-5554   # your run's serial; every adb call names it
drive=(sh examples/expo/e2e-bubble-shadow.sh "$serial" "$EVIDENCE_DIR/bubble-shadow")
```

Pass = the script prints `passed bubble shadow on <serial>` and exits 0. `luminance.txt` has one line per still
(`shadow-1-light-example`, `shadow-2-night-example`, `shadow-3-dark-home`, `shadow-4-dark-drawer`), each with its
measured values and rule and `PASS`, and a `strip tap` line with `before=false after=true`. Open the stills and look
at the disc's lower edge.

## Gotchas

- **Settings hides app overlays**, so a dark still over Settings has no bubble on it. The script uses the home screen
  and the app drawer instead.
- **Elevation does not show** in an overlay window, which is why the shadow is drawn (a radial gradient) and not an
  `elevation`.
- **A fresh emulator can show "System UI isn't responding"** over the app; tap **Wait** and run again.
- **Kill only your emulator** (`adb -s <serial> emu kill`).
