// A desktop screen recorder: a local page picks a screen, shows a recording card with Stop, then saves an MP4.
// Run from the repository root after `npm ci && npm run build`:
//   node examples/recorder/server.ts --browser /usr/bin/chromium
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, createReadStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Capture, CaptureError, errorWords, words } from '@platform-kits/record';

export type Screen = { id: string; name: string; width: number; height: number; thumb: string };
/** The screen an active recording is on, so a reloaded page or a second window shows the same card. */
type Active = { screen: string; width: number; height: number };
export type State =
  | { state: 'idle' }
  | ({ state: 'starting' } & Active)
  | ({ state: 'recording'; since: number } & Active)
  | ({ state: 'saving' } & Active)
  | { state: 'saved'; name: string; path: string; folder: string; bytes: number; seconds: number; width: number; height: number }
  | { state: 'error'; message: string };
export type RecorderOptions = {
  capture: Pick<Capture, 'record' | 'stop' | 'make'>;
  screens: () => Screen[];
  /** Where finished videos are saved, e.g. ~/Videos. */
  outDir: string;
  /** Private working takes; each is deleted once its video is saved. */
  takesDir: string;
  now?: () => Date;
};

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};

/** Every screen of this X display, with a small preview so the person can tell them apart. */
export function listScreens(display: string, xauthority?: string): Screen[] {
  const base = display.replace(/\.\d+$/, '');
  const screens: Screen[] = [];
  for (let n = 0; n < 4; n++) {
    const id = `${base}.${n}`;
    const r = spawnSync('/usr/bin/ffmpeg', ['-hide_banner', '-f', 'x11grab', '-i', id, '-frames:v', '1',
      '-vf', 'scale=640:-2', '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', '-'],
    { env: { PATH: '/usr/bin:/bin', ...(xauthority ? { XAUTHORITY: xauthority } : {}) }, maxBuffer: 16 << 20 });
    const size = /, (\d{2,5})x(\d{2,5})/.exec(r.stderr?.toString() ?? '');
    if (r.status !== 0 || !size) break;
    screens.push({ id, name: `Screen ${n + 1}`, width: Number(size[1]), height: Number(size[2]), thumb: `data:image/jpeg;base64,${r.stdout.toString('base64')}` });
  }
  return screens;
}

export function recorderServer(o: RecorderOptions): { server: Server; token: string } {
  const token = randomBytes(16).toString('hex');
  const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const clients = new Set<ServerResponse>();
  let state: State = { state: 'idle' };
  let known: Screen[] = [];
  let saved: string | undefined;
  const set = (next: State) => {
    state = next;
    for (const c of clients) c.write(`data: ${JSON.stringify(state)}\n\n`);
  };

  async function run(screen: Screen): Promise<void> {
    const on: Active = { screen: screen.name, width: screen.width, height: screen.height };
    let take: string | undefined;
    try {
      for await (const e of o.capture.record({ source: `x11:${screen.id}`, root: o.takesDir, maxSeconds: 3600 })) {
        if (e.event === 'recording') set({ state: 'recording', since: Date.now(), ...on });
        if (e.event !== 'done') continue;
        take = e.take;
        set({ state: 'saving', ...on });
        const made = await o.capture.make({ take, title: 'Screen recording', set: { crf: 18, preset: 'fast' } });
        mkdirSync(o.outDir, { recursive: true });
        const out = join(o.outDir, `Screen recording ${stamp(o.now?.() ?? new Date())}.mp4`);
        copyFileSync(made.out!, out, constants.COPYFILE_EXCL); // never replace a file the person already has
        saved = out;
        const folder = o.outDir.startsWith(homedir() + '/') ? `~${o.outDir.slice(homedir().length)}` : o.outDir;
        set({ state: 'saved', name: basename(out), path: out, folder, bytes: statSync(out).size, seconds: e.seconds, width: screen.width, height: screen.height });
      }
    } catch (error) {
      set({ state: 'error', message: error instanceof CaptureError ? errorWords(error) : words('capture.failed') });
    } finally {
      if (take) rmSync(take, { recursive: true, force: true });
    }
  }

  const send = (res: ServerResponse, code: number, body = '', type = 'text/plain; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  };
  const read = async (req: IncomingMessage) => {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1024) break; }
    return body;
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The token keeps other local pages out; the host check stops DNS rebinding.
    const { port } = server.address() as { port: number };
    const [, t, route = ''] = (req.url ?? '/').split('?')[0]!.split('/');
    if (req.headers.host !== `127.0.0.1:${port}` || t !== token) return send(res, 404, 'Not found');
    if (req.method === 'GET' && route === '') return send(res, 200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && route === 'screens') {
      known = o.screens();
      return send(res, 200, JSON.stringify(known), 'application/json');
    }
    if (req.method === 'GET' && route === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && route === 'start') {
      let id: unknown;
      try { id = (JSON.parse(await read(req)) as { screen?: unknown }).screen; } catch { /* no screen */ }
      const screen = known.find(s => s.id === id);
      if (!screen) return send(res, 400, 'Pick a screen first.');
      if (['starting', 'recording', 'saving'].includes(state.state)) return send(res, 409, words('capture.busy'));
      set({ state: 'starting', screen: screen.name, width: screen.width, height: screen.height });
      void run(screen);
      return send(res, 202);
    }
    if (req.method === 'POST' && route === 'stop') {
      // A slow answer is fine: the kit still ends the recording, and the state stream reports it.
      void o.capture.stop().catch(() => {});
      return send(res, 202);
    }
    if (req.method === 'GET' && route === 'video' && saved) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': statSync(saved).size, 'cache-control': 'no-store' });
      createReadStream(saved).pipe(res);
      return;
    }
    send(res, 404, 'Not found');
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(() => { if (res.headersSent) res.destroy(); else send(res, 500, words('capture.failed')); });
  });
  return { server, token };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const display = process.env.DISPLAY ?? '';
  if (!/^:\d{1,4}(\.\d{1,2})?$/.test(display)) {
    console.error('Start the recorder from a Linux desktop session that has an X display.');
    process.exit(1);
  }
  const xauthority = process.env.XAUTHORITY;
  const stateDir = join(homedir(), '.local/state/platform-kits-recorder');
  const capture = new Capture({ stateDir, display: xauthority ? { XAUTHORITY: xauthority } : {} });
  const { server, token } = recorderServer({
    capture, screens: () => listScreens(display, xauthority),
    outDir: flag('--out') ?? join(homedir(), 'Videos'), takesDir: join(stateDir, 'takes'),
  });
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${token}/`;
    console.log(`Recorder: ${url}`);
    const browser = flag('--browser');
    if (browser) spawn(browser, [`--app=${url}`], { stdio: 'ignore', detached: true }).unref();
  });
  const quit = () => { void capture.stop().finally(() => process.exit(0)); };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
}
