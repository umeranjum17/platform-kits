// The desktop recorder example (examples/recorder) driven through its own HTTP surface with the fake recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Capture, type MakeOptions } from '../src/index.ts';
import { fakeRecorder } from '../src/testing/index.ts';
import { recorderServer, type State } from '../../../examples/recorder/server.ts';

test('recorder example: token and host gate, picks a known screen, records, stops, saves and removes the take', async () => {
  const dir = scratchDir('example');
  const fake = fakeRecorder({ dir: join(dir, 'fake'), script: { seconds: 60 } });
  const outDir = join(dir, 'Videos'), takesDir = join(dir, 'takes');
  const capture = new Capture({ bin: fake.bin, stateDir: join(dir, 'state') });
  const renders: MakeOptions[] = [];
  const { server, token } = recorderServer({
    // Render settings are recorder-defined: the fake knows none of the bundled recorder's, so they are checked here.
    capture: { record: o => capture.record(o), stop: () => capture.stop(), make: o => { renders.push(o); return capture.make({ ...o, set: undefined }); } },
    screens: () => [{ id: ':5.0', name: 'Screen 1', width: 1920, height: 1080, thumb: 'data:,' }],
    outDir, takesDir, now: () => new Date(2026, 9, 1, 9, 5, 7),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${base}/${token}/`;
  try {
    assert.equal((await fetch(`${base}/wrong/`)).status, 404);
    const rebound = get(url, { headers: { host: 'rebound.example' } });
    const [answer] = await once(rebound, 'response') as [{ statusCode: number; resume(): void }];
    answer.resume();
    assert.equal(answer.statusCode, 404);
    assert.match(await (await fetch(url)).text(), /Start recording/);
    assert.equal((await fetch(url + 'start', { method: 'POST', body: '{"screen":":5.0"}' })).status, 400, 'screens not listed yet');
    assert.equal(((await (await fetch(url + 'screens')).json()) as unknown[]).length, 1);
    assert.equal((await fetch(url + 'start', { method: 'POST', body: '{"screen":":9.0"}' })).status, 400);
    assert.equal((await fetch(url + 'start', { method: 'POST', body: 'not json' })).status, 400);

    const events = (await fetch(url + 'events')).body!.getReader();
    let buffer = '';
    const queue: State[] = [];
    const next = async (want: State['state']): Promise<State> => {
      for (;;) {
        const s = queue.shift();
        if (s?.state === want) return s;
        assert.notEqual(s?.state, 'error', JSON.stringify(s));
        if (s) continue;
        const { value, done } = await events.read();
        assert.ok(!done, `stream ended before ${want}`);
        const messages = (buffer + new TextDecoder().decode(value)).split('\n\n');
        buffer = messages.pop()!;
        queue.push(...messages.map(m => JSON.parse(m.slice('data: '.length)) as State));
      }
    };
    await next('idle');
    assert.equal((await fetch(url + 'start', { method: 'POST', body: '{"screen":":5.0"}' })).status, 202);
    assert.equal((await fetch(url + 'start', { method: 'POST', body: '{"screen":":5.0"}' })).status, 409);
    const recording = await next('recording');
    assert.equal(recording.state === 'recording' && recording.screen, 'Screen 1');
    assert.equal((await fetch(url + 'stop', { method: 'POST' })).status, 202);
    const saved = await next('saved');
    assert.ok(saved.state === 'saved');
    assert.equal(saved.name, 'Screen recording 2026-10-01 at 09.05.07.mp4');
    assert.equal(readFileSync(join(outDir, saved.name), 'utf8'), 'fake');
    assert.deepEqual(readdirSync(takesDir), [], 'the working take is removed once saved');
    assert.equal(await (await fetch(url + 'video')).text(), 'fake');
    assert.deepEqual(renders.map(r => r.set), [{ crf: 18, preset: 'fast' }]);
    assert.deepEqual(fake.invocations().find(i => i.argv[1] === 'record')?.argv.slice(2, 4), ['--source', 'x11::5.0']);
    await events.cancel();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
