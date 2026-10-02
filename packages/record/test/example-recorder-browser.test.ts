// The desktop recorder page (examples/recorder/index.html) in real Chromium, against its server and the fake recorder.
// Browser CI sets PLATFORM_KITS_CHROME; ordinary runs skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { scratchDir } from '../../test-support.ts';
import { Capture } from '../src/index.ts';
import { fakeRecorder } from '../src/testing/index.ts';
import { recorderServer } from '../../../examples/recorder/server.ts';

const chrome = process.env.PLATFORM_KITS_CHROME;

async function recorderPage(run: (page: Page, url: string, starts: () => number) => Promise<void>) {
  const dir = scratchDir('example-page');
  const fake = fakeRecorder({ dir: join(dir, 'fake'), script: { seconds: 60 } });
  const capture = new Capture({ bin: fake.bin, stateDir: join(dir, 'state') });
  const { server, token } = recorderServer({
    capture: { record: o => capture.record(o), stop: () => capture.stop(), make: o => capture.make({ ...o, set: undefined }) },
    screens: () => [{ id: ':5.0', name: 'Screen 1', width: 1920, height: 1080, thumb: 'data:,' }],
    outDir: join(dir, 'Videos'), takesDir: join(dir, 'takes'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${token}/`;
  const browser = await chromium.launch({ executablePath: chrome });
  try {
    const page = await browser.newPage();
    let starts = 0;
    page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/start')) starts++; });
    await page.goto(url);
    await page.getByRole('radio', { name: /Screen 1/ }).click();
    await run(page, url, () => starts);
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.getByRole('heading', { name: 'Recording saved' }).waitFor();
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
}

async function recordingCard(page: Page) {
  await page.waitForFunction(() => !document.getElementById('failed')!.hidden || document.getElementById('recState')!.textContent === 'Recording');
  assert.ok(await page.locator('#failed').isHidden(), 'no "Nothing was saved"');
  assert.equal(await page.locator('#recState').textContent(), 'Recording');
  assert.ok(await page.locator('#stop').isVisible(), 'Stop stays visible');
  assert.ok(await page.locator('#stop').isEnabled(), 'Stop is usable');
}

test('recorder page: repeated Start presses during the countdown send one start and keep the recording card', { skip: !chrome, timeout: 30_000 }, async () => {
  await recorderPage(async (page, _url, starts) => {
    const start = page.getByRole('button', { name: 'Start recording' });
    const box = (await start.boundingBox())!;
    await start.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press(' ');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForResponse(r => r.url().endsWith('/start'));
    await page.waitForTimeout(500); // room for a second start, had one been sent
    assert.equal(starts(), 1);
    await recordingCard(page);
  });
});

test('recorder page: a start refused because another window started recording during the countdown shows that recording', { skip: !chrome, timeout: 30_000 }, async () => {
  await recorderPage(async (page, url, starts) => {
    await page.getByRole('button', { name: 'Start recording' }).click();
    assert.equal((await fetch(url + 'start', { method: 'POST', body: '{"screen":":5.0"}' })).status, 202);
    const refused = await page.waitForResponse(r => r.url().endsWith('/start'));
    assert.equal(refused.status(), 409);
    await recordingCard(page);
    assert.equal(starts(), 1);
  });
});
