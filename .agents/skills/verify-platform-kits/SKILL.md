---
name: verify-platform-kits
description: Drive the built @platform-kits packages the way a consuming app does — build the monorepo, doctor the built artifacts, run the desktop screen recorder, the browser launcher, and the native overlay proofs on an emulator, and capture evidence. Use for any proof of platform-kits behavior on this host, before claiming a feature works.
---

# Verify platform-kits

platform-kits is a TypeScript monorepo of generic platform kits (`@platform-kits/record`, `browser`, `overlay`,
`statusbar`, `speak`, `social`). The examples are the real product: `examples/recorder` is a desktop screen recorder,
`examples/expo` is the Android overlay/statusbar/screen-frame app, and each package README is the consumer contract.
"Driving the app" means running one of those examples against the `packages/*/dist` build and observing real output.
`overlay`, `statusbar` and `speak` have no host runtime; their entries report `unsupported` off-device, so their real
proof is on an emulator (see the feature map).

## Launch (build)

Launch = build the monorepo once, then run each drive as a short-lived process.

```sh
npm ci --no-audit --no-fund   # only in a fresh worktree; deps are not inherited
npm run build                 # tsc -b every package, then fix-words-dts.cjs
```

Ready when `npm run build` exits 0 and `packages/record/dist/index.js` and `packages/browser/dist/index.js` exist.
Builds and full test suites are heavy: run them one at a time through the environment's memory gate, holding any
shared heavy-jobs lock it provides. A one-package `tsc` plus a single test file is light and needs no lock.

## Doctor

One read-only check that the built packages are worth driving, run from the worktree root:

```sh
node --input-type=module -e "
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/');
const record = await import('@platform-kits/record');
const browser = await import('@platform-kits/browser');
if (!record.Capture || typeof browser.createBrowser !== 'function') throw new Error('built entry incomplete');
console.log('doctor ok:', require.resolve('@platform-kits/record'));
"
command -v Xvfb ffmpeg ffprobe   # the desktop recorder's host tools
```

It prints the resolved built entry — that path must be inside `packages/*/dist`, never a registry copy. If it fails,
rebuild before driving. The `Xvfb`/`ffmpeg`/`ffprobe` lines are the host tools the desktop-recorder journey needs
(ffmpeg with `x11grab` and libx264): when any is missing, that one journey is unavailable — say so — while the
built-SDK and browser drives still run.

## Drive

Start from the worktree root. Every drive:

- uses a **throwaway HOME** (`HOME`, `XDG_CONFIG_HOME`, `TMPDIR` under an exclusive scratch directory) so the
  recorder saves to that scratch `$HOME/Videos` and nothing touches the owner's home, logins or installed apps;
- drives the **built** packages (`packages/*/dist`), never `packages/*/src` paths;
- starts only what it needs (a private Xvfb display, the example server, one Playwright browser) and records the
  exact command and its real output;
- closes what it started and removes only its own scratch.

Exact recipes: `features/README.md` is the index; one file per feature. The desktop recorder's full end-to-end
recipe (Xvfb + server + Playwright drive + `ffprobe`) is in `features/recorder-desktop.md`. The literal commands the
feature map drives today:

- `node examples/recorder/server.ts --browser <chromium>` — desktop recorder, under a private Xvfb + throwaway HOME.
- `npm run test:browser` — the browser kit suite; set `PLATFORM_KITS_CHROME` to a real Chromium to exercise its launch.
- `examples/expo/e2e-keep-clear.sh <emulator-serial>` — overlay keep-clear, **emulator-only**.
- `examples/expo/e2e-screen-frame.sh <emulator-serial>` — overlay screen-frame, **emulator-only**.

## Evidence

Every proof writes into an exclusive run directory named by the caller. Set `EVIDENCE_DIR` to an absolute path
**outside the repository** (e.g. the task's data folder); evidence is private, never committed and never attached to
a public PR. Then run the feature's drive inside this capture block, which records the invoked command, stdout,
stderr and the real exit code:

```bash
: "${EVIDENCE_DIR:?set EVIDENCE_DIR to an absolute path outside the repo}"
mkdir -p "$EVIDENCE_DIR" || exit 1
feature=<feature-slug>
if (
  printf 'FEATURE=%s\nCOMMAND=' "$feature"
  printf '%q ' "${drive[@]}"
  printf '\n'
  "${drive[@]}"
) > "$EVIDENCE_DIR/$feature.txt" 2>&1; then drive_status=0; else drive_status=$?; fi
cat "$EVIDENCE_DIR/$feature.txt"
printf 'Evidence: %s/%s.txt\n' "$EVIDENCE_DIR" "$feature"
test "$drive_status" -eq 0
```

Each feature file sets the Bash `drive` array before this block. A proof is the real action and its output: the
saved MP4 and its `ffprobe` line for the recorder, the captured PNG dimensions for the browser, the measured boxes
for the overlay. A summary, a compile, or a missing evidence file is not a proof.

Screenshots and recordings are proof media: keep them under `$EVIDENCE_DIR` (outside the repo), never under the
worktree (`.lab/` included). Look at every shot before reporting: nothing overlaps or covers other content, no text
is cut, no raw path or internal id shows.

## Cleanup

```bash
# Kill ONLY the processes this run started, by the pids it captured; never a broad pkill.
test -f "$EVIDENCE_DIR"/*.txt && echo "evidence survived"
```

The desktop recipe's `trap cleanup EXIT` kills only its own Xvfb, server and app browser. Never `pkill Xvfb` or
`pkill chrome`: other lanes on this host run their own displays and browsers, and a shared `Xvfb :99` may already be
in use — pick a display whose `/tmp/.X<n>-lock` does not exist. Confirm the evidence files still exist after cleanup;
a cleanup that eats the proof fails the run.

## Isolation and safety (always enforced)

- Tests run isolated: a throwaway `HOME`, `XDG_CONFIG_HOME` and `TMPDIR`; the recorder's output and take stay in
  that scratch tree.
- Never read, print, copy or mount the owner's installed tools, browser profiles, logins or credentials. The browser
  kit launches only the explicit Chromium binary passed to it, in a private profile with no inherited environment.
- Never name a recorder product, and never commit proof media. Fakes and fixtures only; no account, sign-in or spend.
- Only task-owned processes are killed. A drive that cannot clean up its own display/server/browser is a failure.

## Feature map

Read [features/README.md](features/README.md) for the index and preconditions. The host-provable features today are
`recorder-desktop` and `browser-launch`; `overlay-keep-clear` and `overlay-screen-frame` are **emulator-only** and
their phone proof is **unproved** until run on a disposable emulator.
