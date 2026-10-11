# platform-kits verification map

The maintained source for verifying the user-facing behavior of the built platform-kits packages and their examples.
Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Worktree root of a platform-kits checkout on the branch under test.
- `npm run build` exited 0 (see SKILL.md Launch; deps via `npm ci` in a fresh worktree).
- Doctor (SKILL.md) prints a `packages/*/dist` entry and, for the desktop journey, finds `Xvfb`, `ffmpeg` and `ffprobe`.
- A throwaway `HOME`/`XDG_CONFIG_HOME`/`TMPDIR` for every run, and `EVIDENCE_DIR` set to an absolute path **outside**
  the repository.
- Native (Android overlay) drives use a **disposable emulator owned by the run**, never a physical device.

## Driving conventions

- Start every recipe from the baseline; treat every command in a feature file as literal.
- Set the Bash `drive` array the recipe gives, then use SKILL.md Evidence's capture block to record the invoked
  command and its real exit code.
- A drive that cannot show its output (or whose evidence file is missing after cleanup) is not a proof.
- A user-visible change is proved from the running product, in every width/theme it touches; for the recorder and
  overlay features that means the real screen, captured under `$EVIDENCE_DIR`.
- Report an unreachable surface (emulator, browser, phone) as unavailable with the attempted entry and the unmet
  precondition; never as verified through a different path.

## Available on this host

- [recorder-desktop](./recorder-desktop.md) — the real desktop screen recorder (`examples/recorder`): a private Xvfb
  display, the example server, Playwright picks the "Screen 1" radio, records, stops, and a real H.264 MP4 lands in
  the throwaway `$HOME/Videos`.
- [browser-launch](./browser-launch.md) — the built `@platform-kits/browser` launches an explicitly named Chromium in
  a private profile and captures a PNG; `npm run test:browser` covers it, and `PLATFORM_KITS_CHROME` opts into the
  real-Chromium launch leg.

## Emulator-only (phone proof unproved until run on an emulator)

- [overlay-keep-clear](./overlay-keep-clear.md) — the overlay bubble's pill is kept clear of the focused field, and
  returns to its saved spot. **Emulator-only**; the phone proof is unproved until
  `examples/expo/e2e-keep-clear.sh <emulator-serial>` runs on a disposable emulator.
- [overlay-screen-frame](./overlay-screen-frame.md) — the screen-frame capture consent, point marker and tour.
  **Emulator-only**; the phone proof is unproved until `examples/expo/e2e-screen-frame.sh <emulator-serial>` runs on a
  disposable emulator.
- [overlay-focused-field](./overlay-focused-field.md) — the focused WebView field's read, capture, insert and
  `focusedNode`. **Emulator-only**; unproved until `:a11y-demo:connectedDebugAndroidTest` runs on a disposable emulator.

## Not provable on this host (declare honestly, do not fake)

- **Physical Android phone / iOS**: the overlay, statusbar and speak kits run only inside a native app; no emulator or
  device means no proof. Never use the owner's personal phone.
- **Real screen-share consent dialogs**: X11 has none; the desktop recorder starts only when its page's Start button
  is pressed.
- **Live providers/accounts**: `social` and any account surface need credentials and egress; out of scope for this
  skill's offline proofs.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph of user-visible behavior, then exactly four H2 sections
in order: `Sub-features`, `How to get to it (user POV)`, `Driving it`, `Gotchas`.

## Features

- [recorder-desktop](./recorder-desktop.md) — pick a screen, record, stop, get a saved 30 fps H.264 MP4; the
  recording card stays visible with a live timer and a usable Stop.
- [browser-launch](./browser-launch.md) — open a URL, inline HTML or a named file in the explicit Chromium with a
  private profile, and capture a PNG (viewport, full page, or one element).
- [overlay-keep-clear](./overlay-keep-clear.md) — the pill moves off the field it covers, and with no clear spot the
  bubble stays at its saved spot (emulator-only).
- [overlay-screen-frame](./overlay-screen-frame.md) — screen capture asks for consent every time, the point marker
  moves and dismisses, and the five-step tour visits every edge (emulator-only).
- [overlay-focused-field](./overlay-focused-field.md) — the focused WebView field is read, captured, inserted into
  and returned by `focusedNode`, following focus between fields; passwords and no focus give nothing (emulator-only).
