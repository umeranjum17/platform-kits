# recorder-desktop

The desktop screen recorder built on `@platform-kits/record`. A person picks a screen, presses **Start recording**, a
small recording card with a live timer and a **Stop** button stays in the corner while they work, and when they press
Stop the take becomes a 30 fps H.264 MP4 saved to their `~/Videos`. The same page is `examples/recorder/index.html`,
served by `examples/recorder/server.ts` behind a per-run token.

## Sub-features

- **Screen list** — `GET /screens` probes up to four X screens with `ffmpeg -f x11grab` and returns each with a size
  and a JPEG thumbnail; the page shows them as a radio group labelled `Screen 1`, `Screen 2`, … and enables Start once
  one is chosen.
- **Recording card** — the `starting` → `recording` → `saving` states drive a card with `Recording` / `Stopping` /
  `Saving`, a live `m:ss` timer, and a Stop button that is only enabled once recording is real.
- **Saved view** — after Stop the server muxes the take (`capture make`) to `~/Videos/Screen recording <stamp>.mp4`,
  deletes the working take, and the page shows **Recording saved**, the file name, its duration · size · 30 fps, and a
  playable preview with Share.
- **Truthful failure** — a refused start shows the running recording instead of "Nothing was saved", and a recorder
  error shows the kit's worded message, not a raw stack.

## How to get to it (user POV)

1. Build once: `npm ci && npm run build` (SKILL.md Launch).
2. On a Linux X11 session, from the repo root: `node examples/recorder/server.ts --browser /usr/bin/chromium`.
3. The terminal prints `Recorder: http://127.0.0.1:<port>/<token>/`; the app window opens on that URL.
4. Pick `Screen 1` → **Start recording** → wait → **Stop** → the saved view appears and `~/Videos` has the MP4.

## Driving it

The journey is run on the host with a **private Xvfb display** and a **throwaway HOME**, exactly as
`packages/record/test/example-recorder-browser.test.ts:33` drives the page (radio `Screen 1`, `#start`, then `#stop`).
One self-contained Bash script starts its own Xvfb and server, drives the real page with Playwright, checks the MP4
with `ffprobe`, and cleans up only what it started:

```bash
set -eu
: "${REPO:?set REPO to the platform-kits worktree root}"
: "${EVIDENCE_DIR:?set EVIDENCE_DIR to an absolute path outside the repo}"
CACHE_BASE="${FM_SCRATCH_DIR:-$HOME/.cache/fm-scratch}"; mkdir -p "$CACHE_BASE"
SCRATCH=$(mktemp -d "$CACHE_BASE/pk-recorder.XXXXXX") || exit 1   # scratch on disk, never /tmp (RAM)
export TMPDIR="$SCRATCH/tmp"; mkdir -p "$TMPDIR"   # the driver browser's temp profile stays in-scratch
HOME_DIR="$SCRATCH/home"; mkdir -p "$HOME_DIR" "$EVIDENCE_DIR"
chrome=${PLATFORM_KITS_CHROME:-$(node -e "const{createRequire}=require('module');const r=createRequire('$REPO/noop.js');console.log(r('playwright-core').chromium.executablePath())")}
for d in 77 78 79 80 81; do [ -e "/tmp/.X${d}-lock" ] || { disp=$d; break; }; done   # a display this run owns
: "${disp:?no free X display}"

cat > "$SCRATCH/drive-recorder.mjs" <<'JS'
// Playwright drives the recorder page the way example-recorder-browser.test.ts:33 does.
// Usage: node drive-recorder.mjs <recorder-url> <evidence-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const repo = process.env.PLATFORM_KITS_REPO;
if (!repo) { console.error('set PLATFORM_KITS_REPO to the platform-kits checkout'); process.exit(2); }
const require = createRequire(join(repo, 'noop.js'));
const { chromium } = require('playwright-core');

const [, , url, evidenceDir] = process.argv;
if (!url || !evidenceDir) { console.error('usage: drive-recorder.mjs <url> <evidence-dir>'); process.exit(2); }
mkdirSync(evidenceDir, { recursive: true });
const transcript = [];
const note = (s) => { console.log(s); transcript.push(s); };

const browser = await chromium.launch({ headless: false });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  await page.getByRole('radio', { name: /Screen 1/ }).click();
  note('picked radio: Screen 1');

  await page.getByRole('button', { name: 'Start recording' }).click();
  await page.waitForFunction(() =>
    document.getElementById('recState')?.textContent === 'Recording', null, { timeout: 20_000 });
  note('state: Recording');
  note('stop visible: ' + await page.locator('#stop').isVisible() + ', enabled: ' + await page.locator('#stop').isEnabled());
  note('recording card text: ' + (await page.locator('#rec').innerText()).replace(/\n+/g, ' | '));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(evidenceDir, 'recorder-recording-card.png') });
  note('screenshot: recorder-recording-card.png');

  await page.waitForTimeout(5000);                       // record for about five seconds
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('heading', { name: 'Recording saved' }).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(evidenceDir, 'recorder-saved-view.png') });
  note('screenshot: recorder-saved-view.png');
  note('saved name: ' + await page.locator('#fileName').textContent());
  note('saved meta: ' + await page.locator('#fileMeta').textContent());
  note('saved view text: ' + (await page.locator('#saved').innerText()).replace(/\n+/g, ' | '));
} finally {
  writeFileSync(join(evidenceDir, 'recorder-drive-transcript.txt'), transcript.join('\n') + '\n');
  await browser.close();
}
JS

Xvfb ":$disp" -screen 0 1920x1080x24 -ac -nolisten tcp > "$SCRATCH/xvfb.log" 2>&1 &
xvfb_pid=$!
for _ in $(seq 20); do [ -S "/tmp/.X11-unix/X$disp" ] && break; sleep 0.5; done
[ -S "/tmp/.X11-unix/X$disp" ] || { echo "Xvfb :$disp did not start" >&2; cat "$SCRATCH/xvfb.log" >&2; exit 1; }

url=''; server_pid=''
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  if [ -n "$url" ]; then for p in $(pgrep -f "app=$url" 2>/dev/null); do kill "$p" 2>/dev/null || true; done; fi
  kill "$xvfb_pid" 2>/dev/null || true
  rm -rf -- "$SCRATCH"
}
trap cleanup EXIT

cd "$REPO"
HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DISPLAY=":$disp" \
  node examples/recorder/server.ts --browser "$chrome" > "$SCRATCH/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 20); do url=$(sed -n 's/^Recorder: //p' "$SCRATCH/server.log"); [ -n "$url" ] && break; sleep 0.5; done
[ -n "$url" ] || { echo 'server did not print a URL' >&2; cat "$SCRATCH/server.log" >&2; exit 1; }
echo "recorder url: $url"

DISPLAY=":$disp" PLATFORM_KITS_REPO="$REPO" node "$SCRATCH/drive-recorder.mjs" "$url" "$EVIDENCE_DIR"

echo "--- saved MP4 in the throwaway HOME ---"
ls -l "$HOME_DIR/Videos"
for f in "$HOME_DIR/Videos/"*.mp4; do
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,avg_frame_rate,width,height \
    -show_entries format=duration -of default=noprint_wrappers=1 "$f"
done
```

Pass = the script exits 0, `ffprobe` shows `codec_name=h264`, `avg_frame_rate=30/1` (or more) and `duration` ≥ 4 on the
new MP4, and `recorder-recording-card.png`, `recorder-saved-view.png` and `recorder-drive-transcript.txt` are under
`$EVIDENCE_DIR`. Evidence this recipe produced on the host: those three files, with the `ffprobe` line
`codec_name=h264 · avg_frame_rate=30/1 · 1920x1080 · duration=6.03`, and the transcript's card text
`Recording | 0:00 | Screen 1 · 1920 × 1080 | Stop` and saved-view text
`Recording saved | Saved to ~/Videos | … | 0:06 · 1920 × 1080 · 30 fps`.

## Gotchas

- **One Xvfb per display.** `:99` is often already taken by another lane on this host; the script picks the first free
  display and its `trap` kills only its own Xvfb. Never `pkill Xvfb`.
- **The URL carries a token.** The server serves the page only at the printed `/<token>/` address and rejects other
  hosts; drive the printed URL, not `127.0.0.1:<port>/`.
- **Throwaway HOME decides the save folder.** The recorder writes `$HOME/Videos`; point `HOME` at the scratch tree so
  no real `~/Videos` is touched, and never start the server from the owner's session.
- **`--browser` spawns a detached app window; the `trap` kills it by its `app=<url>` argument.** Playwright's own
  browser is closed by the driver; its kit-owned profile lives under `HOME_DIR`, and with `TMPDIR` pointed at the
  scratch tree the driver browser's temporary profile is removed with it (no `/tmp` litter).
- **ffmpeg needs `x11grab` and libx264.** If the Doctor step cannot find them, this journey is unavailable — declare
  it rather than substituting a fake.
