# Desktop screen recorder example

A small recorder app built on [`@platform-kits/record`](../../packages/record). You choose a screen and start. A
recording card with a live timer and a Stop button stays in the bottom-right corner while you work. When you stop, the
video is saved to `~/Videos`, and the saved view offers Share.

![Recording card over a real browser session](../../docs/evidence/recorder-indicator.png)

Linux with an X11 session, Node 22.18+, and `/usr/bin/ffmpeg` with x11grab and libx264. From the repository root:

```sh
npm ci && npm run build
node examples/recorder/server.ts --browser /usr/bin/chromium   # or open the printed address in any browser
```

- The page runs in its own app window and resizes itself for each step. Set your window manager to keep it above
  other windows (often called "Always on top") so the recording card stays visible.
- Recording only starts when you press Start recording. It captures video only, with no sound and no keystrokes, and nothing leaves this computer.
- Saved videos are 30 fps H.264 MP4 files at the screen's full size. The working take is deleted once the video is saved.
- Share opens the system share sheet where the browser has one. Desktop Linux browsers have none, so Share offers "Save a
  copy…" and "Copy file location" instead. You can also drag the video preview into another app.
- The page is served on `127.0.0.1` behind a random address that is printed at start, so other local pages can't
  drive it.

The [evidence README](../../docs/evidence/README.md) has a real 1080p run: a person records themselves working in a
browser.
