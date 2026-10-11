# browser-launch

The built `@platform-kits/browser` launches an **explicitly named** Chromium or Chrome in a **private temporary
profile** and captures a PNG of a URL, an inline HTML string, or one element. It never downloads a browser, attaches
to a running one, or opens the owner's existing profile, service workers and downloads are disabled, and it inherits
no host environment. This is the kit an app uses to screenshot a page. The user-visible contract is the
`packages/browser/README.md` quickstart.

## Sub-features

- **Explicit discovery** — `findChromium(candidates)` returns the first executable in an explicit absolute-path list,
  or `undefined`; it never infers or downloads.
- **Private session** — `createBrowser({ executablePath, viewport, deviceScaleFactor, timeoutMs, allowUrl })`; each
  session owns one page and a private profile under a kit-owned HOME, with `HOME`/`XDG_CONFIG_HOME` cleared.
- **Open** — `open({ url })` (absolute HTTP(S) only, authorized by `allowUrl`), `open({ html })` (fresh blank
  document, so it cannot inherit the previous origin), `open({ file })` (one explicitly named local file).
- **Readiness** — `waitFor({ selector, state })`, `waitFor({ expression })`, `waitFor({ fonts: true })`; readiness
  belongs to the app.
- **Capture** — `screenshot()` (viewport PNG), `{ fullPage: true }`, `{ selector }` (one visible element); animations
  are disabled and `reducedMotion` defaults to `reduce`.
- **Truthful failure** — missing/ambiguous elements and timeouts reject with a `BrowserError` and a stable `code`,
  omitting raw browser errors, HTML, URLs and environment values.

## How to get to it (user POV)

A consumer calls the quickstart in `packages/browser/README.md`: `findChromium([...])`, `createBrowser({ executablePath })`,
`open(...)`, `waitFor(...)`, `writeFile('page.png', await session.screenshot(...))`, `close()` in a `finally`. The kit is
Node-only; there is no PWA, browser, React Native, Firefox or WebKit entry.

## Driving it

Two levels, both from the worktree root after Launch:

**1. The offline suite** (fake launcher; proves launch options, isolation, URL policy, validation and error
suppression). This is a browser job: run it through the memory gate holding the shared heavy-jobs lock.

```bash
# drive=(npm run test:browser)   # sh scripts/test.sh 'packages/browser/test/*.test.ts' packages/record/test/example-recorder.test.ts
```

**2. The real launch leg** — set `PLATFORM_KITS_CHROME` to a checkout-verified Chromium. This opts into the test that
really launches it, captures a `120×80` element PNG and asserts the private profile is removed:

```bash
PLATFORM_KITS_CHROME="$(node -e "const{createRequire}=require('module');const r=createRequire(process.cwd()+'/noop.js');console.log(r('playwright-core').chromium.executablePath())")" \
  npm run test:browser
```

Pass = the suite exits 0 with `fail 0`, and with `PLATFORM_KITS_CHROME` set the line
`real Chromium captures a local HTML element and removes its private profile` is **not** skipped (it prints ✔). A run
without the flag reports that line as `# SKIP` — the real browser leg is then unproved, which is a valid result to
report.

**Optional element capture** into `$EVIDENCE_DIR` (a scratch consumer, throwaway paths only):

```bash
: "${EVIDENCE_DIR:?set EVIDENCE_DIR outside the repo}"
node --input-type=module -e "
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/noop.js');
const { createBrowser, findChromium } = await import('@platform-kits/browser');
const exe = process.env.PLATFORM_KITS_CHROME ?? await findChromium(['/usr/bin/chromium', '/usr/bin/google-chrome']);
if (!exe) throw new Error('no Chromium: set PLATFORM_KITS_CHROME');
const session = await createBrowser({ executablePath: exe, viewport: { width: 480, height: 320 }, timeoutMs: 10_000 });
try {
  await session.open({ html: '<main id=proof style=\"width:120px;height:80px;background:green\">Platform kits</main>' });
  await session.waitFor({ selector: '#proof' });
  const png = await session.screenshot({ selector: '#proof' });
  await writeFile(process.env.EVIDENCE_DIR + '/browser-proof.png', png);
  console.log('png bytes', png.length, 'magic', Array.from(png.slice(0, 8)).join(','));
} finally { await session.close(); }
"
```

Pass = `browser-proof.png` exists, its first 8 bytes are `137,80,78,71,13,10,26,10` (PNG), and its IHDR width/height
are `120`/`80`. Evidence this recipe produced on the host: `npm run test:browser` with `PLATFORM_KITS_CHROME` printed
`tests 14 · pass 14 · fail 0 · skipped 0` including the real-Chromium line.

## Gotchas

- **The binary is explicit.** Never pass a bare command name (`chrome` is rejected) and never fall back to a download;
  qualifiy the installed browser first.
- **`allowUrl` is not a firewall.** It authorizes only the `open` target; redirects, subresources and in-page scripts
  still reach the network. The app owns content authorization.
- **Always `close()` in a `finally`.** A forced process kill can leave the kit's profile directory for the host's
  temp cleanup; `close()` normally removes it.
- **A skipped real leg is not a pass.** If `PLATFORM_KITS_CHROME` is unset, report the real-browser launch as
  unproved rather than counting the offline suite as its proof.
