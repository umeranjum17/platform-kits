# Platform capability kits

Extracted from BYOKit's capability spec at `88eb2e2f666336d49f0ce18cf0e424d8491c09c9` (Apache-2.0).
The section numbers below stay stable so package test references still identify their contracts.
Sections 5–7 and 12 define record, the recorder protocol, overlay and statusbar. Their existing public APIs and
native class/module identifiers are preserved. Browser and speak are documented in their package READMEs.

Library code accepts app-owned inputs; spawned processes use an explicit environment. Tests use a decoy HOME,
loopback fakes and the egress guard. `test-support/isolation.ts` and `trace-fs.ts` are test-only copies of BYOKit's
accounts helpers; no production package depends on an AI kit. Common rules: [kit conventions](kit-conventions.md).

## 5. `@platform-kits/record`

### 5.1 Files

```
packages/record/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  schema/recorder-protocol-1.json         # BK-C1, JSON Schema 2020-12 of section 6
  src/index.ts  src/constants.ts  src/types.ts  src/errors.ts
  src/capture.ts                          # Capture client (BK-C2)
  src/protocol.ts                         # wire parsers for section 6 (BK-C1)
  src/supervise.ts                        # env, argv, spawn, caps (BK-C2)
  src/words.json  src/words.ts
  src/testing/index.ts  src/testing/fake-recorder.ts  src/testing/contract.ts   # BK-C1
  test/*.test.ts
```

`package.json`: `exports` `.` → `dist/index.js`, `./testing` → `dist/testing/index.js`; `files` `dist`, `schema`,
`README.md`, `LICENSE`, `CHANGELOG.md`; no dependencies.

### 5.2 Public types (`src/types.ts`)

```ts
export type SourceKind = 'screen' | 'x11' | 'android';
export type Source = 'screen' | `x11:${string}` | `android:${string}`;   // grammar in 6.4
export type EventsMode = 'own' | 'none';
export type DisplayVar = 'WAYLAND_DISPLAY' | 'XDG_RUNTIME_DIR' | 'DBUS_SESSION_BUS_ADDRESS' | 'HYPRLAND_INSTANCE_SIGNATURE' | 'XAUTHORITY';
export type CaptureOptions = {
  bin?: string;                                  // absolute external recorder; omitted: bundled Linux X11
  stateDir: string;                              // app-owned; the kit writes only under join(stateDir, 'capture')
  display?: Partial<Record<DisplayVar, string>>; // the session a `screen` or `x11:` recording needs (5.4)
  timeoutMs?: number;                            // make() timeout, default 600_000, clamped 1 s–30 min
};
export type RecorderHello = {
  protocol: number;
  recorder: { name: string; version: string };
  sources: SourceKind[];
  android: boolean;                              // = sources.includes('android')
  events: EventsMode[];                          // always includes 'none'
  planner: { available: boolean; needsKey: boolean };
};
export type RecordOptions = {
  source: Source;
  root: string;                                  // absolute; takes are created as direct children
  events?: EventsMode;                           // default 'none'
  maxSeconds: number;                            // integer 1–3600, a hard stop in the recorder
  signal?: AbortSignal;                          // abort → `capture stop` (5.4)
};
export type RecordEvent =
  | { event: 'consent-pending' }
  | { event: 'recording'; take: string }
  | { event: 'done'; take: string; seconds: number; warnings: string[] };
export type Caption = { t: number; text: string; d?: number };   // seconds from the take's start; d = duration
export type MakeOptions = {
  take: string;                                  // absolute take dir from a `recording`/`done` event
  planOnly?: boolean;                            // estimate only: no model call, no video
  title?: string;
  captions?: Caption[];
  set?: Record<string, string | number | boolean>;   // recorder-defined render settings (6.6)
  signal?: AbortSignal;                          // abort kills the make process and rejects signal.reason (5.3)
} & ({ plannerKey: string; maxTokens: number } | { plannerKey?: undefined; maxTokens?: undefined });
export type MakeResult = {
  out: string | null;                            // absolute .mp4 inside the take; null with planOnly
  seconds: number;
  beats: number;
  planner: { plannedTokens: number; inputTokens: number; usd: number; failed: boolean };
  warnings: string[];
};
export type CaptureErrorCode =
  | 'missing' | 'needs-update' | 'unsupported' | 'invalid'
  | 'consent-cancelled' | 'consent-timeout' | 'stopped' | 'already-recording'
  | 'preflight-refused' | 'take-input' | 'render-failed'
  | 'timeout' | 'too-much-output' | 'protocol' | 'failed';
```

`src/errors.ts`:

```ts
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  readonly why?: 'recorder' | 'app';             // needs-update only: which side is older
  readonly hint?: string;                        // the recorder's hint, for logs, never shown as words
  readonly detail?: Record<string, unknown>;     // preflight-refused: { planned, cap }; failed: { recorderCode, stderrTail }
  constructor(code: CaptureErrorCode, message: string, o?: { why?: 'recorder' | 'app'; hint?: string; detail?: Record<string, unknown> });
}
```

### 5.3 `Capture` (`src/capture.ts`, exported from `.`, BK-C2)

```ts
export class Capture {
  constructor(o: CaptureOptions);                // validates only; spawns nothing
  hello(): Promise<RecorderHello>;
  record(o: RecordOptions): AsyncIterableIterator<RecordEvent>;
  stop(): Promise<'stopping' | 'not-recording'>;
  make(o: MakeOptions): Promise<MakeResult>;
}
```

- **Constructor.** It throws `CaptureError('invalid')` when `stateDir` is not absolute, and `CaptureError('missing')`
  when an explicit `bin` is not absolute. Omitted `bin` selects the bundled entry. It never touches the disk.
- **`hello()`.** It runs `capture hello` and caches the answer on the first success. It checks the protocol range
  before any other field, so an out-of-range recorder gets `needs-update` even when the rest has changed. It rejects:
  - `missing` when the bin does not exist, is not a regular file or is not executable (checked before the spawn;
    ENOENT or EACCES at spawn also gives `missing`);
  - `needs-update` with `why: 'recorder'` when `protocol < PROTOCOL_FLOOR`, or `why: 'app'` when
    `protocol > PROTOCOL`;
  - `protocol` when the answer fails the 6.3 shape.
- **`record()`.** It calls `hello()` first. It rejects, on the first `next()`:
  - `unsupported` when the source kind is not in `hello.sources`, or `events: 'own'` is not in `hello.events`;
  - `invalid` for a bad source grammar, a relative `root`, or a `maxSeconds` that is not an integer from 1 to 3600;
  - `already-recording` when this `Capture` already has a recording running. The recorder enforces the same lock
    across processes.

  After that, it yields each known event in order. After `done` is yielded, the next `next()` resolves
  `{ done: true }` only after the process has exited, and a non-zero exit after `done` is ignored. If the process is
  still alive when the guard fires, it is killed and that `next()` rejects `timeout`. Unknown `event` values and unknown fields are dropped. The iterator
  ends after `done`. A recorder error line rejects the pending `next()` with the mapped code (6.7).

  If the process exits with code 0 without `done`, the error is `protocol`. Any other exit without an error line is
  `failed`, with `detail.stderrTail`: the last 2 KB of stderr.

  **Ending early.** An abort `signal` or the consumer's `return()` (breaking out of `for await`) runs `stop()`.
  - The process group is sent SIGTERM if it has not exited 10 s after `stop()`, and SIGKILL 5 s after that.
  - `return()` resolves `{ done: true, value: undefined }` only after the process has exited, so a `record()` started
    after it never sees `already-recording`. Stop buttons use `stop()` or `signal`, not `return()` while a `next()`
    is pending.
  - An abort after `recording` still yields `done` and then ends.
  - An abort before `recording` rejects `stopped`.

  **Wall-clock guard.** The kit ends a recording itself through `streamRecorder`'s guard
  (`guardMs = recordGuardMs(maxSeconds)`): SIGTERM to the process group, then SIGKILL 5 s later, with no
  `capture stop`. A guarded exit rejects `timeout`, and any `done` read after the guard fired is dropped, not yielded.
- **`stop()`.** It runs `capture stop --state-dir <recorderStateDir>` and returns `'stopping'`. It returns
  `'not-recording'` when the recorder answers that code.
- **`make()`.** It calls `hello()` first. It rejects:
  - `unsupported` when a `plannerKey` is passed and `hello.planner.available` is false;
  - `invalid` for a relative `take`, a NUL in any string, a `maxTokens` that is not a positive integer, a `set` key
    not matching `/^[a-z][a-z0-9_.-]{0,63}$/`, or a caption with a negative `t`.

  It writes the captions to `join(stateDir, 'capture', 'tmp', randomUUID() + '.json')` (mode 0600) and deletes the
  file when make settles. An abort of `signal` kills the process group (SIGTERM, SIGKILL 5 s later) and rejects with
  `signal.reason` (an `AbortError`, the fetch convention), not a `CaptureError`: the app asked for the stop, so there
  is no sentence to show. It maps the snake_case planner fields to `MakeResult`.

### 5.4 Supervision (`src/supervise.ts`, BK-C2)

```ts
export type Spawned = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean };
export function recorderEnv(o: { stateDir: string; source?: Source; display?: CaptureOptions['display'] }): Record<string, string>;
export type RecorderCall =
  | { verb: 'hello' }
  | { verb: 'stop' }
  | { verb: 'record'; o: RecordOptions }
  | { verb: 'make'; o: MakeOptions; captionsFile?: string };
export function recorderArgv(stateDir: string, call: RecorderCall): string[];   // starts ['capture', verb, …]
export function runRecorder(bin: string, env: Record<string, string>, args: string[], o: { timeoutMs: number; key?: string; signal?: AbortSignal }): Promise<Spawned>;
export function streamRecorder(bin: string, env: Record<string, string>, args: string[], o: { guardMs: number }):
  { lines: AsyncIterable<string>; exited: Promise<Spawned & { guarded: boolean }>; kill(signal: NodeJS.Signals): void };
export function recordGuardMs(maxSeconds: number): number;   // (maxSeconds + CONSENT_WINDOW_S + 30) * 1000
// guardMs: past it the stream stops itself (SIGTERM, SIGKILL 5 s later) and `exited` reports guarded: true
```

- **Layout.** The kit owns `join(stateDir, 'capture')` with mode 0700. Inside it:
  - `home/` is the recorder's `HOME`;
  - `recorder/` is the recorder's `--state-dir`;
  - `tmp/` holds caption files.

  It creates these with `mkdirSync({ recursive: true, mode: 0o700 })` on first use. It writes nothing else.
- **Env from nothing (D-G).** Every spawn gets exactly these variables, with `home = join(stateDir, 'capture', 'home')`:
  - `HOME = home`
  - `XDG_CONFIG_HOME = home/.config`
  - `XDG_STATE_HOME = home/.local/state`
  - `XDG_CACHE_HOME = home/.cache`
  - `XDG_DATA_HOME = home/.local/share`
  - `PATH = /usr/bin:/bin`
  - `LANG = C.UTF-8`

  Then, for `record` only:
  - `screen`: each of `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and
    `HYPRLAND_INSTANCE_SIGNATURE` that is present in `display`.
  - `x11:<d>`: `DISPLAY = <d>`, plus `XAUTHORITY` when present in `display`. The Wayland variables never pass,
    so recording a helper's own X desktop cannot reach the person's session.
  - `android:<serial>`: nothing more.

  `hello`, `stop` and `make` never get display variables.
- **argv.** It is always an array, and the kit never uses a shell. Every element is a string without NUL (rejected
  `invalid`). `bin` must be absolute (`missing` otherwise). The PATH is never searched.
- **Timeouts.** `hello` and `stop` take 10 s. `make` takes `timeoutMs`. On timeout the process gets SIGTERM, then
  SIGKILL 5 s later, and the call rejects `timeout`.
- **Caps.** For `hello`, `stop` and `make`, stdout and stderr are capped at 8 MB each. Past the cap, the process is
  killed and the call rejects `too-much-output`. For `record`, stdout is capped at 8 MB in total and a single stdout
  line over 64 KB is `protocol`; stderr keeps a rolling 2 KB tail with no total cap, because a recording can log for an
  hour.
- **Process groups.** `runRecorder` and `streamRecorder` spawn with `detached: true`, and every SIGTERM and SIGKILL
  (timeout, cap, guard, stop fallback, make abort) goes to the process group (`process.kill(-pid, sig)`), as
  `packages/herdr/src/supervise.ts` does.
- **Planner key.** With `key`, stdio is `['ignore', 'pipe', 'pipe', 'pipe']`. The kit writes the key to fd 3, closes
  it, and passes `--planner-key-fd 3 --max-tokens <n>`. Without a key it passes `--no-planner`. The key never
  appears in argv, env, a file or any error message.

### 5.5 Fake recorder and contract (`./testing`, BK-C1)

```ts
export type RecorderErrorWire = { code: string; message: string; hint?: string; [k: string]: unknown };
export type FakeRecorderScript = {
  hello?: Partial<RecorderHello>;               // merged over the default hello (below)
  consent?: 'yes' | 'no' | 'timeout';           // screen only, default 'yes'; 'timeout' answers at once, no 120 s wait
  seconds?: number;                             // take length before `done` unless stopped, default 1, capped by --max-seconds
  makeError?: RecorderErrorWire;                // make answers this envelope
  plannedTokens?: number;                       // default 1000
  corrupt?: 'hello' | 'record' | 'make';        // print `not json` instead of the answer
  flood?: 'stdout' | 'stderr';                  // make writes 9 MB to that stream, then hangs
  hang?: 'hello' | 'stop' | 'make';             // never answer
};
export type FakeInvocation = { argv: string[]; env: Record<string, string>; key?: string; captions?: unknown };
export type FakeRecorder = {
  bin: string;                                  // absolute path of the shim (0700)
  script(s: FakeRecorderScript): void;          // replaces the script for later runs
  invocations(): FakeInvocation[];              // every run so far, in order
};
export function fakeRecorder(o: { dir: string; script?: FakeRecorderScript }): FakeRecorder;

export type CaptureContractBench = { capture: Capture; source: Source; root: string; fake?: FakeRecorder };
export type CaptureContractTestFn = (name: string, fn: (t: { skip(message?: string): void }) => void | Promise<void>) => void | Promise<void>;
export type CaptureContractOptions = { test?: CaptureContractTestFn };
export function captureContract(make: () => Promise<CaptureContractBench>, options?: CaptureContractOptions | CaptureContractTestFn): void;
```

**Fake behaviour.**
- **The shim.** `bin` is a Node script at `<dir>/recorder`. Its shebang pins `process.execPath`, as herdr's
  `writeBinShim` does. It reads `<dir>/script.json` on every run, and appends one JSON line per run to
  `<dir>/invocations.jsonl`. That line holds argv, env, the key read from `--planner-key-fd`, and the parsed captions
  file.
- **Default hello.** `{ protocol: 1, recorder: { name: 'fake-recorder', version: '0.0.0' }, sources: ['screen',
  'x11'], android: false, events: ['own', 'none'], planner: { available: true, needsKey: true } }`.
- **`record`.** It takes `<state-dir>/recording.pid` as its lock. A live pid already there gives `already-recording`.
  - For `screen` it prints `consent-pending`, then follows `consent`. `no` and `timeout` exit 1 with
    `consent-cancelled` or `consent-timeout`, having created nothing under `--root`.
  - It creates `<root>/take-<n>/` with `take.json` (`{"fake":true,"source":…,"events":…}`) and prints `recording`.
  - After `seconds` (capped by `--max-seconds`), or on SIGTERM, SIGINT or `stop`, it prints `done` and exits 0.
  - A SIGTERM before `recording` gives `capture-stopped` with nothing created.
- **`stop`.** It signals the pid in the lock and prints `{"stopping":true}`. With no live pid it prints
  `not-recording`.
- **`make`.** It checks that `<take>/take.json` exists, otherwise `take-input`.
  - `--plan-only`: `out: null`, `planned_tokens: plannedTokens`, `input_tokens: 0`, `usd: 0`.
  - `--max-tokens` below `plannedTokens`: `preflight-refused` with `planned` and `cap`.
  - Otherwise it writes `<take>/out/<basename>.mp4` (the bytes `fake`). It writes the title and captions into
    `take.json`, and prints the result with `seconds` taken from the take. Tokens are 0 with `--no-planner` and
    `plannedTokens` with a key.
  - An unknown `--set` key other than `speed` gives `invalid-arguments` with exit 2.

**`captureContract` cases.** All of them hold on a real recorder; *fake* ones skip without `fake`:
1. `hello` passes the 6.3 shape, has `protocol` from `PROTOCOL_FLOOR` to `PROTOCOL`, and includes `'none'` in
   `events`.
2. `record({ source, root, maxSeconds: 2 })` yields `recording` then `done`. The take is a direct child directory of
   `root`, `done.take` equals `recording.take`, and `seconds` is at most 3.
3. Aborting the signal after `recording` still yields `done` within 15 s, and the take exists.
4. A second `record` while one runs rejects `already-recording`.
5. `stop()` with nothing recording resolves `'not-recording'`.
6. `make({ take, planOnly: true })` gives `out: null` and `planner.failed: false`, and no file appears under
   `take/out`.
7. `make({ take })` gives `out` as an existing `.mp4` file inside the take, with `planner.inputTokens` 0 and
   `planner.usd` 0.
8. `make({ take, title: 'T', captions: [{ t: 0, text: 'Hi' }] })` succeeds without recording again (no new take
   under `root`).
9. `make({ take: join(root, 'nope') })` rejects `take-input`.
10. *fake*: `consent: 'no'` rejects `consent-cancelled`, and `root` has no new entries.
11. *fake*: a hello with `protocol: 0` gives `needs-update`/`recorder`, and `protocol: 2` gives `needs-update`/`app`.
12. *fake*: a key reaches the recorder on fd 3 only. The invocation's `key` equals it, and neither argv nor env
    contains it.
13. *fake*: the env is exactly 5.4's for each verb and source, `display` variables included.
14. *fake*: `corrupt`, `flood` and `hang` give `protocol`, `too-much-output` and `timeout` respectively.
15. *fake*: `maxTokens` below the planned amount rejects `preflight-refused` with `detail.planned` and `detail.cap`.

### 5.6 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `capture.missing` | This computer needs the recorder installed first. |
| `capture.needsUpdate.recorder` | The recorder on this computer needs an update. |
| `capture.needsUpdate.app` | This app needs an update to work with the recorder on this computer. |
| `capture.unsupported` | The recorder on this computer can't record that yet. |
| `capture.consentPending` | Say yes in the window that just opened to start recording. |
| `capture.recording` | Recording. |
| `capture.done` | Recording finished. |
| `capture.consentCancelled` | You said no to the recording. Nothing was kept. |
| `capture.consentTimeout` | Nobody said yes in time, so nothing was recorded. |
| `capture.stopped` | Stopped before anything was recorded. |
| `capture.busy` | Another recording is already running. Stop it first. |
| `capture.making` | Making the video… |
| `capture.made` | The video is ready. |
| `capture.overLimit` | Planning this video would go over its limit, so nothing was spent. |
| `capture.takeMissing` | That recording can't be opened. Record it again. |
| `capture.renderFailed` | The video couldn't be made from this recording. Try again. |
| `capture.timeout` | The recorder took too long to answer. Try again. |
| `capture.failed` | The recorder stopped with a problem. Try again. |

- `eventWords(e: RecordEvent)`:
  - `consent-pending` → `capture.consentPending`
  - `recording` → `capture.recording`
  - `done` → `capture.done`
- `errorWords(e: CaptureError)`:
  - `missing` → `capture.missing`
  - `needs-update` → `capture.needsUpdate.<why>` (`recorder` when `why` is absent)
  - `unsupported` → `capture.unsupported`
  - `consent-cancelled` → `capture.consentCancelled`
  - `consent-timeout` → `capture.consentTimeout`
  - `stopped` → `capture.stopped`
  - `already-recording` → `capture.busy`
  - `preflight-refused` → `capture.overLimit`
  - `take-input` → `capture.takeMissing`
  - `render-failed` → `capture.renderFailed`
  - `timeout` → `capture.timeout`
  - `invalid`, `too-much-output`, `protocol` and `failed` → `capture.failed`
- `capture.making` and `capture.made` are for the app to show around `make()`.
- The words never name a recorder, a device path or a key.

### 5.7 What runs where

`npm test` runs fake recorders/media tools. Linux CI also runs the bundled recorder on an isolated Xvfb.
External recorders run on the owner's machine or in a lab via `captureContract` (BK-C3). External recorders may be private; the bundled backend needs no download helper. `scripts/pin-watch.mjs`
watches nothing for record: external compatibility is pinned by protocol, and the bundled backend ships with the kit.

### 5.8 Bundled recorder (G8, 2026-09-30)

`CaptureOptions.bin` is optional: omitted selects the bundled recorder, launched with `process.execPath`
(no PATH lookup for Node). Explicit bins retain the unchanged protocol and supervision. The bundled recorder
supports Linux `x11:` video only, `events: none`, and no planner. `screen` (Wayland portal), Android,
macOS, Windows, browsers and React Native are unsupported by this backend. X11 has no system consent dialog:
the host must present an explicit Start action before iterating `record()`. Construction and hello open no display.
The bundled recorder uses `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`; it reads only the scrubbed process environment
provided by Capture (for XAUTHORITY). It never starts another application's CLI or contacts the network.
Takes contain local video, duration metadata and requested caption/title edits. `make()` embeds timed subtitles
and title metadata, with optional `crf` (0–51) and `preset` settings; unknown settings fail closed. Stop uses a
state-scoped marker, with no cross-process PID signalling. Failed/pre-start recordings and active state are cleaned
up; completed takes are retained until the host deletes their returned directory. Linux CI runs a real smoke
against its own Xvfb; ordinary tests fake media binaries. External recorders retain their owner-machine proof.



## 6. Recorder protocol v1

This is the open protocol a recorder implements to be driven by `@platform-kits/record`. "MUST" and "SHOULD" are binding
for conformance. BK-C1 turns 6.3–6.7 into `packages/record/schema/recorder-protocol-1.json`.

### 6.1 Invocation and output

- **Argv.** The kit runs `<bin> capture <verb> [arguments]` with an argv array and no shell. Flags take their value as
  the next argv entry (`--root /x`). An unknown verb or flag is `invalid-arguments` with exit 2. The `capture`
  sub-command is the whole protocol surface, so a recorder's other commands stay its own.
- **stdout** carries only protocol JSON: one object per line, UTF-8, each ending in `\n`. `hello`, `stop` and `make`
  print exactly one line. `record` prints event lines.
- **stderr** is free-form logging. The kit keeps only a 2 KB tail, for its own error detail, and never shows it to a
  person.
- **Exit codes.** 0 is success. 1 is failure, with the error envelope (6.7) as the last stdout line. 2 is
  `invalid-arguments`, also with the envelope.
- **Env.** The recorder MUST work with only the variables 5.4 lists. It MUST keep its own files under `HOME`/`XDG_*`,
  `--state-dir` and the takes under `--root`, and nowhere else.
- **Speed.** `hello` and `stop` MUST answer within 5 s.
- **Processes.** The recorder MUST keep its helper processes in its own process group: no `setsid`, no daemonizing.
  The kit's SIGKILL fallback reaches the whole group.
- **Logs.** stderr from `hello`, `stop` and `make` MUST stay under 8 MB; `record` may log without a total limit.

### 6.2 Versioning

`hello.protocol` is an integer, and it is `1` for this document. Additive changes keep `1`: new optional fields, new
event names and new error codes. The kit ignores unknown fields and events, and maps unknown error codes to `failed`.
Any other change is protocol `2`. The kit accepts protocols from `PROTOCOL_FLOOR` (1) to `PROTOCOL` (1); anything else
is `needs-update` (5.3).

### 6.3 `capture hello`

```json
{"protocol":1,"recorder":{"name":"example-recorder","version":"2.3.0"},"sources":["screen","x11"],"android":false,"events":["own","none"],"planner":{"available":true,"needsKey":true}}
```

| Field | Rule |
|---|---|
| `protocol` | integer ≥ 0 (the kit applies the accepted range, 5.3) |
| `recorder.name` | `/^[a-z0-9][a-z0-9._-]{0,63}$/` |
| `recorder.version` | non-empty string, at most 64 characters |
| `sources` | non-empty, unique, each one of `screen`, `x11`, `android` |
| `android` | boolean, MUST equal `sources` including `android` |
| `events` | non-empty, unique, each `own` or `none`, MUST include `none` |
| `planner.available` | boolean: whether `make` can plan with a key |
| `planner.needsKey` | boolean: whether planning needs `--planner-key-fd` |

Exit 0. `hello` MUST NOT open a display, an input device or the network.

### 6.4 `capture record`

```
<bin> capture record --source <source> --root <dir> --state-dir <dir> --events own|none --max-seconds <n>
```

The kit always passes every flag. Source grammar:
- `screen`: the person's own screen through the OS's own screen-sharing consent.
- `x11:<display>`: `<display>` matches `/^:\d{1,4}(\.\d{1,2})?$/`.
- `android:<serial>`: `<serial>` matches `/^[A-Za-z0-9._:-]{1,64}$/`. The recording uses the person's already-running
  adb server over loopback, and so that server's existing device authorization. The recorder MUST NOT start an adb
  server, and MUST NOT generate, copy or read any adb key. With no reachable server or an unauthorized serial it gives
  `unsupported-source` before printing `recording`.

stdout events:

```json
{"event":"consent-pending"}
{"event":"recording","take":"/abs/root/take-7"}
{"event":"done","take":"/abs/root/take-7","seconds":12.4,"warnings":[]}
```

A recorder MUST:
1. Refuse a source kind missing from its `hello.sources` with `unsupported-source`, and an events mode missing from
   `hello.events` with `invalid-arguments`.
2. Allow one recording per `--state-dir`. A second one gets `already-recording`.
3. For `screen`: print `consent-pending` and ask through the OS's own consent. It never bypasses consent and never
   retries on its own. A refusal gives `consent-cancelled`. No answer within 120 s gives `consent-timeout`.
   `x11:` and `android:` MAY skip consent.
4. Leave nothing under `--root` or in `--state-dir` after `consent-cancelled`, `consent-timeout` or `capture-stopped`
   (a stop before `recording`).
5. Print `recording` once frames flow. Its `take` is an absolute directory the recorder created as a direct child of
   `--root`.
6. With `--events none`, open no input device and no compositor input channel. With `--events own`, record input
   only as classes (pointer move, button, wheel, key pressed), never the characters typed.
7. Stop on `--max-seconds` (a hard stop), SIGTERM, SIGINT, or `capture stop` for the same `--state-dir`. It then prints
   `done`, with `seconds` at most `--max-seconds + 1` and `warnings` as plain strings, and exits 0.
8. Never write a planner key into a take.

A recorder SHOULD keep no window titles and no copies of planner request bodies in a take.

### 6.5 `capture stop`

```
<bin> capture stop --state-dir <dir>
```

The recorder prints `{"stopping":true}` and exits 0 when a recording under that state dir was told to stop. It
returns at once, and the `record` process prints `done`. With nothing recording it gives `not-recording` (exit 1).

### 6.6 `capture make`

```
<bin> capture make <take> [--plan-only] (--no-planner | --planner-key-fd <n> --max-tokens <n>)
                          [--title <text>] [--captions <file>] [--set <key>=<value>]...
```

```json
{"out":"/abs/root/take-7/out/take-7.mp4","seconds":12.4,"beats":6,"planner":{"planned_tokens":0,"input_tokens":0,"usd":0,"failed":false},"warnings":[]}
```

A recorder MUST:
1. With `--plan-only`, make no model or network call and write no video. `out` is `null`, and `planned_tokens` is the
   estimate.
2. With `--no-planner`, make zero model calls, so `input_tokens` and `usd` are `0`.
3. With `--planner-key-fd <n>`, read the key from fd `n` to EOF and trim one trailing newline. It never reads a key
   from env, argv or its own files, and never writes the key anywhere, logs included.
4. Treat `--max-tokens` as a hard cap. When the estimate is above it, give `preflight-refused` (with `planned` and
   `cap`) before any call.
5. Treat `--title` and `--captions` as edits to the take. The captions file is a JSON array of `{ "t": seconds,
   "text": string, "d"?: seconds }`. Making again with only these changes MUST NOT record again.
6. Treat `--set` keys as its own render settings. An unknown key is `invalid-arguments`.
7. Put `out` inside the take directory.
8. Give `take-input` for a missing or unreadable take and `render-failed` when the video cannot be made. `failed:
   true` means the planner failed and the video was made without it.

### 6.7 Error envelope and codes

```json
{"error":{"code":"preflight-refused","message":"planned 48000 tokens, cap 40000","hint":"raise --max-tokens","planned":48000,"cap":40000}}
```

`message` and `hint` are for logs; the kit never shows them to a person. Extra fields sit inside `error`.

| Code | Verb | Meaning | Kit code |
|---|---|---|---|
| `invalid-arguments` | any | unknown verb, flag or value (exit 2) | `protocol` |
| `unsupported-source` | record | source kind not offered | `unsupported` |
| `consent-cancelled` | record | the person said no | `consent-cancelled` |
| `consent-timeout` | record | no answer in 120 s | `consent-timeout` |
| `capture-stopped` | record | stopped before `recording` | `stopped` |
| `already-recording` | record | a recording already runs for this state dir | `already-recording` |
| `not-recording` | stop | nothing to stop | (resolves `'not-recording'`) |
| `preflight-refused` | make | estimate above `--max-tokens`; has `planned`, `cap` | `preflight-refused` |
| `take-input` | make | take missing or unreadable | `take-input` |
| `render-failed` | make | the video could not be made | `render-failed` |
| `internal` and any other | any | anything else | `failed` (`detail.recorderCode`) |

### 6.8 Conformance

A recorder conforms when `captureContract` passes against it on a real machine (BK-C3). The recorder's own home
records that run in its own docs, outside BYOKit. A recorder that changes protocol behaviour re-runs it.


## 7. `@platform-kits/overlay`

### 7.1 Why Kotlin returns here

The frozen `android/` mirror (AGENTS.md) exists because React Native apps use the TypeScript kits. That reasoning does
not cover a bubble. No JavaScript or React Native API can draw a window over other apps
(`TYPE_APPLICATION_OVERLAY`), run a foreground service, or host a view from an accessibility service. So the overlay
is an Expo module with Kotlin inside `packages/overlay/android/`, built with `expo-module-gradle-plugin`. The mirror
stays frozen: this Kotlin serves only the Expo module, and nothing from the mirror is reused or extended.

### 7.2 Files (BK-O1 creates the layout)

```
packages/overlay/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE
  expo-module.config.json                 # { "platforms": ["android"], "android": { "modules": [
                                          #   "io.github.umeranjum17.byokit.overlay.OverlayModule",
                                          #   "io.github.umeranjum17.byokit.overlay.FocusedFieldModule"] } }
  app.plugin.js                           # config plugin (7.6)
  android/build.gradle
  android/src/main/AndroidManifest.xml    # the permissions, OverlayService and PanelActivity (7.6); Gradle merges it
  android/src/main/res/values/styles.xml  # Theme.ByokitOverlay.Panel: translucent, no action bar
  android/src/main/java/io/github/umeranjum17/byokit/overlay/*.kt   # 7.5
  android/src/test/java/io/github/umeranjum17/byokit/overlay/*Test.kt
  src/index.ts  src/types.ts  src/rules.ts  src/overlay.ts  src/words.json  src/words.ts
  src/rn.ts                               # the only file calling requireOptionalNativeModule('ByokitOverlay')
  src/focused-field.ts  src/focused-field.rn.ts
  test/*.test.ts
```

`package.json`:
- `exports`: `.` → `{ "react-native": dist/rn.js, "default": dist/index.js }` and `./focused-field` →
  `{ "react-native": dist/focused-field.rn.js, "default": dist/focused-field.js }`, each with its `types`.
- `files`: `dist`, `android` (without `build/`), `expo-module.config.json`, `app.plugin.js`, `README.md`,
  `LICENSE`, `CHANGELOG.md`.
- `peerDependencies`: `expo-modules-core` (`>=3.0.0`) and `expo` (`>=57.0.0`), both marked optional in
  `peerDependenciesMeta`.
- `devDependencies`: `expo-modules-core`, pinned exactly to the version `examples/expo` resolves, so the root
  `npm ci` installs it and `tsc -b` can type `rn.ts` and `focused-field.rn.ts`.

Android `minSdk` is 26 and `compileSdk` follows Expo SDK 57. The config plugin raises the app's minSdk to 26 (7.6).

### 7.3 Public types (`src/types.ts`) and entries

```ts
export type OverlayState = 'on' | 'off' | 'stuck' | 'needs-permission' | 'unsupported';
export type HostKind = 'window' | 'accessibility';
export type Edge = 'left' | 'right';
export type AppRules = { paused: boolean; on: string[]; off: string[]; defaults: string[] };   // Android package names
export type ForegroundNotice = { channel: string; title: string; text: string; icon: string }; // icon: app drawable name
export type StartOptions = {
  host: HostKind;
  mood: string;                        // resting drawable name, /^[a-z][a-z0-9_]{0,63}$/, app-supplied
  notice?: ForegroundNotice;           // required for host 'window' (the foreground service's notification)
  rules?: AppRules;                    // host 'accessibility' only (needs the foreground app); 'window' + rules rejects
  panel?: string;                      // registered React component opened on tap; absent: tap only emits
  hideWhilePanelOpen?: boolean;        // default true
  spots?: 'global' | 'per-app';        // remembered rest spot; 'per-app' needs host 'accessibility'; default 'global'
  label?: string;                      // TalkBack label for the bubble; absent: none
};
export type OverlayEvent =
  | { type: 'tap' }
  | { type: 'longPress' }
  | { type: 'moved'; edge: Edge; y: number }        // y: 0–1 of the usable height
  | { type: 'state'; state: OverlayState }
  | { type: 'panel'; open: boolean }
  | { type: 'keepClear'; clear: boolean };          // false: no clear spot left, so the bubble stays at its own spot
export type OverlayEventType = OverlayEvent['type'];
// State transitions (native side, reported by state() and the `state` event):
// - 'off' before the first start() and after stop().
// - start() with host 'window' and no SYSTEM_ALERT_WINDOW grant, or host 'accessibility' before
//   ByokitAccessibility.attach, resolves 'needs-permission' and shows nothing.
// - A successful start() resolves 'on'.
// - While on, 'stuck' when the bubble's view goes away without stop(): OverlayService destroyed or killed ('window'),
//   or ByokitAccessibility.detach ('accessibility'). start() again is the way back to 'on'.
// - 'unsupported' only from createOverlay(null) (no native module: iOS, web, Node).
export type TapEntry = { app: string; at: number; action: string };   // no text field, by design (D-O)
export type ClearRect = { left: number; top: number; width: number; height: number };   // full-display physical pixels
export interface Overlay {
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;     // window: the "display over other apps" screen; accessibility: accessibility settings
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  say(text: string, mood?: string, ms?: number, o?: { announce?: boolean }): void;   // pill next to the bubble; ms default 2500; still under reduced motion; announce reads the pill for TalkBack
  setMood(mood: string): void;
  setLabel(label: string | null): void;   // TalkBack label for the bubble; null clears it
  setRules(rules: AppRules): void;
  keepClear(rects: ClearRect[]): void;   // up to 64; the bubble and pill move up or down off them; [] clears; the saved spot stays
  openPanel(props?: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  on<T extends OverlayEventType>(type: T, fn: (e: Extract<OverlayEvent, { type: T }>) => void): () => void;   // listener set
  logTap(entry: { app: string; action: string }): Promise<void>;
  taps(o?: { since?: number }): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
}
export interface NativeOverlay {                         // what the Kotlin module exposes (7.5); internal seam
  state(): Promise<OverlayState>;
  openPermission(): Promise<void>;
  start(o: StartOptions): Promise<OverlayState>;
  stop(): Promise<void>;
  say(text: string, mood: string | null, ms: number, announce: boolean): void;
  setMood(mood: string): void;
  setLabel(label: string | null): void;
  setRules(rules: AppRules): void;
  keepClear(rects: ClearRect[]): void;
  openPanel(props: Record<string, string>): Promise<void>;
  closePanel(): Promise<void>;
  logTap(app: string, action: string): Promise<void>;
  taps(since: number): Promise<TapEntry[]>;
  clearTaps(): Promise<void>;
  addListener(event: 'overlay', fn: (e: OverlayEvent) => void): { remove(): void };
}
```

`src/rules.ts` (pure):

```ts
export function shownFor(rules: AppRules, app: string | null): boolean;
// paused → false; app null → false; off has app → false; on has app → true; else defaults has app
export function setApp(rules: AppRules, app: string, shown: boolean): AppRules;   // moves app into on/off, out of the other
export function resetApp(rules: AppRules, app: string): AppRules;                 // removes app from on and off
```

`src/overlay.ts` (pure):

```ts
export function createOverlay(native: NativeOverlay | null): Overlay;
```

With `null`, every method resolves `'unsupported'` or does nothing, and `taps()` resolves `[]`. With a module,
`createOverlay` validates the arguments and calls it:
- `start` rejects `window` without `notice`, `window` with `rules`, `per-app` spots with `window`, and a `mood` that
  fails the pattern. These throw `Error('overlay: <what>')` before any native call.
- One native listener feeds a JS listener `Set` per event type. `on()` returns its own remover, and a throwing
  listener does not stop the others.

Entries:
- `src/index.ts` (`.` default) exports the types, `shownFor`, `setApp`, `resetApp`, `createOverlay`, `words` and
  `stateWords`, plus `overlay = createOverlay(null)`.
- `src/rn.ts` (`react-native`) exports the same names, but with `overlay =
  createOverlay(requireOptionalNativeModule('ByokitOverlay'))`. That call returns null on iOS, where the module is
  not built.

### 7.4 `./focused-field`

```ts
export type FocusedText = { app: string; text: string; selection: { start: number; end: number } | null };
export type InsertResult = 'inserted' | 'landedWithoutNewlines' | 'copied' | 'failed' | 'cancelled';
export type InsertOptions = {
  signal?: AbortSignal;            // cancellation settles once with cancelled
  replace?: 'selection' | 'all';   // default 'selection'
  attempts?: number;               // SET_TEXT tries; default 2 (a panel on top needs ~13 x 150 ms in Chrome)
  retryMs?: number;                // pause between tries; default 150
  acceptNewlineLoss?: boolean;     // default false; true resolves 'landedWithoutNewlines' when only newlines were lost
};
export interface FocusedField {
  available(): Promise<boolean>;       // the app's accessibility service has attached the kit
  read(): Promise<FocusedText | null>; // only on this call; null when no editable field has focus
  insert(text: string, o?: InsertOptions): Promise<InsertResult>;
}
export const focusedField: FocusedField;
```

- The default entry: `available()` resolves false, `read()` resolves null and `insert()` resolves `'failed'`.
- The React Native entry calls `requireOptionalNativeModule('ByokitFocusedField')` and passes the options through as
  a record (`{ replace, attempts, retryMs, acceptNewlineLoss }`, defaults 2 tries of 150 ms).
- `insert` sets the text, reads it back to verify, and retries up to `attempts` times, pausing `retryMs` between
  tries: while the panel's window is on top Chrome refuses SET_TEXT, so ~13 x 150 ms lands it. If the text still does
  not match, a contenteditable that dropped only the newlines resolves `'landedWithoutNewlines'` when
  `acceptNewlineLoss` is set; otherwise the text goes on the clipboard (`'copied'`).
- The field is resolved with `findFocus(FOCUS_INPUT)`, falling back to `FOCUS_ACCESSIBILITY`, including virtual
  WebView nodes. An input-focused container may contain the accessibility-focused field. No focus means no field;
  never guess the first editable child. A password node anywhere on the focused path (including ancestors and
  focused descendants) prevents reads, writes and clipboard fallback. The same search, read and insert are callable
  from Kotlin (`FocusedFields`, 7.5), so the app's
  service can read at tap time and insert into the captured node with no JS running.

### Screen frames and point markers

`@platform-kits/overlay/screen-frame` exports `screenFrame`, `createScreenFrame`, `ScreenFrame`,
`NativeScreenFrame`, `ScreenFrameResult` and `ScreenSpace`. The default entry is native-free;
React Native binds `ByokitScreenFrame` on Android and returns typed `unsupported` on iOS.

```ts
export type ScreenSpace = {
  width: number; height: number; density: number; densityDpi: number;
  rotation: 0 | 1 | 2 | 3; displayId: number;
  origin: 'top-left'; unit: 'physical-pixels';
};
export type ScreenFrameResult =
  | { status: 'captured'; uri: string; mimeType: 'image/png'; width: number; height: number; space: ScreenSpace }
  | { status: 'cancelled' | 'busy' | 'unsupported' }
  | { status: 'failed'; reason: 'timeout' | 'display-changed' | 'capture-failed' };
export interface ScreenFrame {
  frame(): Promise<ScreenFrameResult>;
  clear(): Promise<void>;
}
export type NativeScreenFrame = ScreenFrame;
export function createScreenFrame(native: NativeScreenFrame | null): ScreenFrame;
export type PointAvoid = { left: number; top: number; width: number; height: number };
export type PointHereOptions = { x: number; y: number; width?: number; height?: number; label: string; avoid?: PointAvoid[]; space?: ScreenSpace; ms?: number };
export type PointHereResult = 'shown' | 'needs-permission' | 'not-running' | 'display-changed' | 'unsupported';
```

Both overlay entries export the point types. `Overlay` adds `pointHere(o: PointHereOptions):
Promise<PointHereResult>` and `dismissPoint(): Promise<void>`. `NativeOverlay` receives the same options
with `ms` required; JS supplies 2500 by default. It validates finite, nonnegative coordinates and sizes, a
nonblank label, at most 64 `avoid` boxes with finite edges and nonnegative sizes, and a duration of 1–60000 ms
before passing all fields through.

Every frame asks for fresh MediaProjection consent for the entire default display, including system bars.
Only one request runs at once. Its PNG lives in app cache; the next request deletes previous kit frames,
and `clear()` deletes them explicitly (rejecting during capture). A projection foreground service stops
on success, denial, failure, timeout or teardown. Rotation or display geometry changes fail capture rather
than returning an incompatible coordinate space. Nothing uploads the image.

The marker uses full-display physical pixels from the image. Passing `space` rejects stale display metrics;
React Native layout coordinates must first be multiplied by the display density. It requires a running
window or accessibility overlay host. `x`/`y` is the target's centre and `width`/`height` its size; the ring
goes around the target outside its edges (a 48 dp circle when no size is given), and the label callout sits
below it, or above when there is no room below, inside the display minus system bars and cutout
(`PointLayout.plan`). With `avoid` boxes it takes the first spot clear of them: below, above, then either nudged
sideways in 8 dp steps with the target's centre still under its arrow; otherwise the spot covering the least. Ring and callout occupy a separate nonfocusable, nontouchable window, announce the label
to accessibility clients, and dismiss on timeout, explicit dismissal, replacement, display changes or host
teardown. Application overlay opacity stays within Android's tap-through limit.

### 7.5 Kotlin parts (package `io.github.umeranjum17.byokit.overlay`, one job each)

```kotlin
data class Size(val w: Int, val h: Int)
data class Spot(val edge: Edge, val y: Float)                            // y in 0..1
enum class Edge { LEFT, RIGHT }
sealed class OverlayEvent { object Tap; object LongPress; data class Moved(val spot: Spot); data class State(val state: String); data class Panel(val open: Boolean); data class KeepClear(val clear: Boolean) }   // each extends OverlayEvent
class Listeners<T> { fun add(fn: (T) -> Unit): () -> Unit; fun emit(e: T) }   // a set: add returns its own remover; one throwing listener never stops the rest
interface SpotStore { fun get(key: String): Spot?; fun put(key: String, spot: Spot) }
object Placement {                                                       // pure, JVM-tested
  const val DRAG_SLOP_DP = 8
  fun isDrag(dxPx: Float, dyPx: Float, density: Float): Boolean          // hypot > DRAG_SLOP_DP * density
  fun snap(xPx: Int, yPx: Int, screen: Size, bubble: Size, insetTopPx: Int, imeTopPx: Int?): Spot   // nearest edge, clamped
  fun toPixels(spot: Spot, screen: Size, bubble: Size, insetTopPx: Int, imeTopPx: Int?): Pair<Int, Int>   // rests above the keyboard
  fun keepClear(x: Int, restY: Int, row: Size, screen: Size, insetTopPx: Int, imeTopPx: Int?, rects: List<ClearRect>): Int?   // nearest clear top for bubble+pill, null when none
}
data class ClearRect(val left: Int, val top: Int, val width: Int, val height: Int)   // screen pixels, as getBoundsInScreen
interface OverlayHost { fun add(view: View, x: Int, y: Int); fun move(x: Int, y: Int); fun remove(); val attached: Boolean }
class WindowOverlayHost(context: Context) : OverlayHost                  // TYPE_APPLICATION_OVERLAY, FLAG_NOT_FOCUSABLE; needs SYSTEM_ALERT_WINDOW
class AccessibilityOverlayHost(service: AccessibilityService) : OverlayHost   // TYPE_ACCESSIBILITY_OVERLAY, FLAG_NOT_FOCUSABLE
class OverlayService : Service()                                         // foreground, type specialUse; owns a WindowOverlayHost
interface BubbleControl { var spotKey: String; var imeTopPx: Int?; val events: Listeners<OverlayEvent>; fun show(mood: String); fun hide(); fun say(text: String, mood: String?, ms: Long, announce: Boolean = false); fun setMood(mood: String); fun setLabel(label: String?); fun keepClear(rects: List<ClearRect>) {} }   // what drives the bubble's view; a fake in JVM tests
class Bubble(host: OverlayHost, spots: SpotStore, moods: (String) -> Drawable?, reducedMotion: () -> Boolean) : BubbleControl {
  fun show(mood: String); fun hide(); fun say(text: String, mood: String?, ms: Long, announce: Boolean = false); fun setMood(mood: String); fun setLabel(label: String?)
  val events: Listeners<OverlayEvent>                                    // listener set, never a single slot
}
data class Rules(val paused: Boolean = false, val on: List<String> = emptyList(), val off: List<String> = emptyList(), val defaults: List<String> = emptyList()) { fun shows(app: String?): Boolean }   // the 7.3 decision in Kotlin; the app layers its own allowances on top
class ServiceBubble(moods: (String) -> Drawable?, spots: SpotStore, reducedMotion: () -> Boolean = { false }, ...) {   // the bubble from Kotlin alone: start(config) once, it shows on attach and restores after every rebind
  constructor(host: OverlayHost, moods: (String) -> Drawable?, spots: SpotStore, reducedMotion: () -> Boolean = { false })   // over a window the app's own foreground service owns
  data class Config(val mood: String, val label: String? = null, val rules: Rules = Rules(), val perAppSpots: Boolean = false, val hideWhilePanelOpen: Boolean = true)
  val events: Listeners<OverlayEvent>
  fun start(config: Config); fun stop()
  fun say(text: String, mood: String? = null, ms: Long = 2500, announce: Boolean = false)
  fun setMood(mood: String); fun setLabel(label: String?); fun setRules(rules: Rules)
  fun keepClear(rects: List<ClearRect>)                                  // kept until [] or stop(); dropped on an app, display or host change
  companion object { fun drawables(context: Context): (String) -> Drawable?; fun reducedMotion(context: Context): () -> Boolean }   // moods by drawable name; the system's animator scale
}
interface ForegroundApp { val current: String?; fun onChange(fn: (String?) -> Unit): () -> Unit }
interface KeyboardInset { val imeTopPx: Int?; fun onChange(fn: (Int?) -> Unit): () -> Unit }
object ByokitAccessibility { fun attach(service: AccessibilityService); fun detach(service: AccessibilityService) }   // called from the app's own service
class PanelActivity : ReactActivity()                                    // translucent, renders the app-registered component
class TapLog(context: Context) { fun add(app: String, action: String, at: Long); fun since(at: Long): List<TapEntry>; fun clear(); fun prune(now: Long) }  // 30 days
class OverlayModule : Module()                                           // Expo module 'ByokitOverlay', maps NativeOverlay (7.3)
data class InsertOpts(val attempts: Int = Insert.DEFAULT_ATTEMPTS, val retryMs: Long = Insert.RETRY_MS, val acceptNewlineLoss: Boolean = false)
interface FieldNode { val identity: FieldIdentity?; fun reacquire(): FieldNode?; fun recycle(); val editable: Boolean; val password: Boolean; fun shown(): String?; fun set(text: String): Boolean; fun selection(): Pair<Int, Int>?; fun findFocus(input: Boolean): FieldNode?; fun parent(): FieldNode?; val childCount: Int; fun child(i: Int): FieldNode?
  companion object { fun of(node: AccessibilityNodeInfo, service: AccessibilityService? = null): FieldNode } }   // the field, or a focused descendant; `of` wraps a node the app's service captured; faked in JVM tests
data class FieldIdentity(val viewId: String, val bounds: List<Int>, val app: String)   // all three match, or it is not the same field
object FocusedFields {                                                   // the Kotlin entry for the app's own service
  fun find(node: FieldNode): FieldNode?                                  // input focus, else accessibility focus; no field on a password path or without focus
  fun capture(service: AccessibilityService): FieldNode?                 // the focused field now, kept for a later insert; the caller recycles it
  fun read(service: AccessibilityService): FocusedFieldText?
  fun insert(node: FieldNode, text: String, replace: String = "selection", opts: InsertOpts = InsertOpts(), pause: (Long) -> Unit = Thread::sleep, copy: (String) -> Boolean = { false }, cancellation: InsertCancellation = InsertCancellation(), service: AccessibilityService? = null): String
  fun insert(node: AccessibilityNodeInfo, text: String, replace: String = "selection", opts: InsertOpts = InsertOpts(), pause: (Long) -> Unit = Thread::sleep, copy: (String) -> Boolean = { false }, service: AccessibilityService? = ByokitAccessibility.service, cancellation: InsertCancellation = InsertCancellation()): String   // finds the field at or under node; "failed" when none
  fun clipboard(context: Context): (String) -> Boolean                  // the copy fallback
}
class InsertCancellation { fun cancel() }                               // one operation, idempotent cancellation
class FocusedFieldModule : Module()                                      // Expo module 'ByokitFocusedField' (BK-O3)
```

- The app's own `AccessibilityService` calls `ByokitAccessibility.attach(this)` in `onServiceConnected`. That supplies
  `AccessibilityOverlayHost`, `ForegroundApp`, `KeyboardInset` and `FocusedField`. The kit declares no accessibility
  service of its own.
- A service that must show the bubble with no JS running (after a reboot or process death, before any React context
  exists) keeps a `ServiceBubble` and calls `start(config)` in `onServiceConnected` with the persisted rules: the
  bubble shows on attach and restores after every rebind, until `stop()`. `Rules.shows(app)` is the same per-app
  decision as `shownFor`, for the service to decide in Kotlin; the app layers its own allowances on top, and persists
  the rules itself so they work before JS runs again.
- **The app-owned-service API.** Everything an app's own service hands the kit, or gets back, is public Kotlin, with
  the kit's internals (`NodeWrap`, the same-field search) behind it:
  - *Attach:* `ByokitAccessibility.attach(this)` / `detach(this)`, which supplies `host`, `foreground` and `keyboard`.
  - *Focused field:* `FocusedFields.capture(service)` at tap time, or `FieldNode.of(node)` over the
    `AccessibilityNodeInfo` the service captured itself with `findFocus(FOCUS_INPUT)` (falling back to
    `FOCUS_ACCESSIBILITY`): only an exactly focused field is taken, never the first editable descendant;
    `capture`/`read` search every interactive window root and the active root, refresh and require two agreeing
    snapshots with at most three 75 ms settling pauses. Native containers resolve virtual children by their exact
    focus flags. The app's service retrieves window content, reports view ids and subscribes to window/content,
    view focus, text and selection changes. `FocusedFields.insert` takes either. Before the first write and on
    retries, it refreshes and re-acquires the field across window roots only when view id, bounds and package
    all match (or framework node identity for virtual fields without ids), never a different field; the
    captured node stays the caller's to recycle. `FocusedFields.clipboard(context)` is the `copy` fallback. Insert
    blocks for up to `attempts x retryMs`, so the service calls it off the main thread. Each insert accepts an optional
    `InsertCancellation` (JS: `AbortSignal`); cancellation is checked before field reads, writes and copy fallback,
    and returns `cancelled` exactly once. Service detach and native module teardown cancel pending inserts.
    Services detach in both `onUnbind` and `onDestroy`. Bubble touch and accessibility ACTION_CLICK share one Tap handler.
  - *Bubble:* `ServiceBubble` on the attached service's host, or `ServiceBubble(WindowOverlayHost(this), ...)` from the
    app's own foreground service; `drawables(context)`, `PrefsSpotStore(context)` and `reducedMotion(context)` supply
    it. The fixed-host bubble knows no foreground app or keyboard: like the JS `window` host it takes no rules and
    shows everywhere. It hides while the panel is on top (`hideWhilePanelOpen`, also when `start` finds it open),
    shows again over another app the person switches to meanwhile, and re-reads the foreground app when it closes.
  - *Panel:* `events` delivers `Tap` and `LongPress`; the service opens the panel with
    `PanelActivity.launch(context, key, props)` and closes it with `PanelActivity.current?.finish()`.
  - *Placement, tap log, rules:* `Placement`, `SpotStore.key`, `TapLog(context)` and `Rules` are the same pure parts
    the module uses.
- The bubble carries a TalkBack label (`label` in `StartOptions`, `setLabel`, `ServiceBubble.Config.label`), and
  `say` takes `announce` to read the pill aloud.
- Moods are drawable names the app ships. With reduced motion (the system animator scale is 0), the bubble snaps
  instead of gliding, and a mood change is a still frame.
- `panel` is an `AppRegistry.registerComponent` key the app registers in its JS entry. `start()` stores it in the
  module. A tap, or `openPanel(props)`, launches `PanelActivity` with `FLAG_ACTIVITY_NEW_TASK` and the extras
  `byokit.panel` (the key) and `byokit.props` (a Bundle of strings). `getMainComponentName()` returns the key, and the
  React activity delegate passes the props as the component's initial props. `openPanel` without a stored key rejects
  `Error('overlay: no panel')`.
- The bubble hides while the panel is open (`hideWhilePanelOpen`). `closePanel()` finishes the activity. Both emit the
  `panel` event. The panel is where the app makes any network call.

### 7.6 Library manifest and config plugin

The library's `android/src/main/AndroidManifest.xml` declares the static entries below, and Gradle merges them into the
app. `app.plugin.js` adds nothing to the manifest.

- **Permissions:** `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE` and `POST_NOTIFICATIONS`.
- **The service.** `<service android:name="io.github.umeranjum17.byokit.overlay.OverlayService"
  android:foregroundServiceType="specialUse" android:exported="false">` with
  `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="floating assistant bubble"/>`.
- **The panel activity.** `<activity android:name="io.github.umeranjum17.byokit.overlay.PanelActivity"
  android:theme="@style/Theme.ByokitOverlay.Panel" android:excludeFromRecents="true"
  android:taskAffinity="" android:exported="false"/>`.
- **Config plugin** (`app.plugin.js`), with options `{ moods?: Record<string, string> }` mapping a drawable name to an
  app asset path:
  - it copies each asset into `res/drawable-nodpi/<name>.png`;
  - it sets `android.minSdkVersion` in `gradle.properties` to 26 when it is lower, and leaves a higher value alone.

### 7.7 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `overlay.on` | The bubble is on. |
| `overlay.off` | The bubble is off. |
| `overlay.stuck` | The bubble stopped. Turn it off and on again. |
| `overlay.needsPermission` | Allow this app to show over other apps to see the bubble. |
| `overlay.restricted` | If that switch is greyed out, open this app's info, tap the menu, and allow restricted settings first. |
| `overlay.unsupported` | This device can't show a bubble over other apps. |
| `field.copied` | Couldn't type it in, so it's copied. Paste it where you want it. |
| `field.failed` | Couldn't type it in. Try again. |

`stateWords(s: OverlayState)` maps each state to its `overlay.*` sentence. `needs-permission` gives
`overlay.needsPermission`, and the app shows `overlay.restricted` as a second line on Android 13+ sideloaded installs.


## 12. `@platform-kits/statusbar`

One ongoing job the person started, shown where Android 16 shows a Live Update: a chip in the status bar, the top of
the notification shade and the lock screen. The kit takes plain text from the app and never builds a sentence of its
own except its state words (12.7). Product meaning (what counts as a job, when to promote, the counts) stays in the
app (D-A).

### 12.1 Platform facts builders must not re-derive

- A Live Update is a promoted ongoing notification. `NotificationCompat` in androidx.core 1.17.0 (already an `api`
  dependency of `expo-modules-core` 57) sets the promotion request on every API level. `setShortCriticalText`,
  `canPostPromotedNotifications()` and `Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS` are API 36; the
  `POST_PROMOTED_NOTIFICATIONS` permission and the public `setRequestPromotedOngoing` are API 36.1.
- Promotion needs all of: the request, `ongoing`, a content title, a standard/BigText/Call/Progress style, no custom
  views, not colorized, not a group summary, and a channel above `IMPORTANCE_MIN`. OEMs may add criteria.
- The chip always shows the small icon. Text of 7 characters or fewer shows whole.
- `POST_PROMOTED_NOTIFICATIONS` is manifest-only (no runtime prompt), on top of the runtime `POST_NOTIFICATIONS`. The
  person can switch promotion off per app; `canPostPromotedNotifications()` reports it.
- Google's use rules: ongoing, user-initiated, time-sensitive activity with a start and an end; never alerts, chat,
  ads or quick access to app features; and never repost one the person dismissed (detect it with the delete intent).
- A notification shows at most 3 actions. `setAuthenticationRequired(true)` makes the OS unlock first.
- `VISIBILITY_PRIVATE` with a public version shows only the public copy on a secure lock screen and during screen
  sharing. What the chip shows on a secure lock screen is unverified, so the chip text must be counts-only too.
- AOSP drops updates beyond 5 per second per package.

### 12.2 Files (BK-S1)

```
packages/statusbar/
  package.json  tsconfig.json  README.md  CHANGELOG.md  LICENSE  .gitignore
  expo-module.config.json                 # { "platforms": ["android"], "android": { "modules": [
                                          #   "io.github.umeranjum17.byokit.status.StatusModule"] } }
  app.plugin.js                           # config plugin (12.6)
  android/build.gradle                    # minSdk 24; androidx.core 1.17.0
  android/src/main/AndroidManifest.xml    # POST_NOTIFICATIONS and the dismissal receiver (12.6)
  android/src/main/java/io/github/umeranjum17/byokit/status/{StatusRules,StatusNotice,StatusModule}.kt   # 12.5
  android/src/test/java/io/github/umeranjum17/byokit/status/StatusRulesTest.kt
  src/index.ts  src/types.ts  src/status.ts  src/words.json  src/words.ts
  src/rn.ts                               # the only file calling requireOptionalNativeModule('ByokitStatus')
  test/{status,portable,words,exports}.test.ts
```

`package.json` follows 7.2: the same `files`, optional peers and exact `expo-modules-core` dev pin; `exports` has
only `.` → `{ "react-native": dist/rn.js, "default": dist/index.js }`.

### 12.3 Public types (`src/types.ts`) and entries

```ts
export type StatusState = 'on' | 'off' | 'needs-permission' | 'unsupported';
export type StatusAction = { id: string; label: string };   // id /^[a-z][a-z0-9_]{0,31}$/, label non-empty
export type ShowOptions = {
  title: string;          // private, non-empty: promotion needs a content title
  text: string;           // private
  chip: string;           // status-bar chip, at most 7 characters (code points); counts and fixed words only
  publicText: string;     // lock screen and screen share; counts and fixed words only
  promote: boolean;       // ask for the chip; false posts a plain ongoing notification
  actions?: StatusAction[];   // at most 3, unique ids; each needs the phone unlocked
  timeoutMs: number;      // integer ≥ 1000: the notification clears itself this long after the last post
  icon?: string;          // small icon, an app drawable name /^[a-z][a-z0-9_]{0,63}$/; default the app's icon
};
export type StatusEvent = { type: 'action'; id: string } | { type: 'dismissed' };
export type StatusEventType = StatusEvent['type'];
export interface Status {
  show(o: ShowOptions): void;          // throws Error('status: <what>') on bad options, before any native call
  clear(): void;                       // the job ended: cancels the notification and forgets a dismissal
  on<T extends StatusEventType>(type: T, fn: (e: Extract<StatusEvent, { type: T }>) => void): () => void;   // listener set
  state(): Promise<StatusState>;
  openSettings(): Promise<void>;       // the promotion setting, else the app's notification settings
}
export interface NativeStatus {        // what the Kotlin module exposes (12.5); internal seam
  show(o: ShowOptions & { channel: string }): void;   // channel: the channel's visible name, from words
  clear(): void;
  state(): Promise<StatusState>;
  openSettings(): Promise<void>;
  addListener(event: 'status', fn: (e: StatusEvent) => void): { remove(): void };
}
```

States:
- `unsupported`: no native module (iOS, web, Node), or Android below API 36. `show()` posts nothing there.
- `needs-permission`: notifications are off for the app (no `POST_NOTIFICATIONS` grant) or its channel is blocked.
- `off`: the person switched promotion off for the app, or set the kit's channel to Minimum. `show()` still posts, as
  a plain ongoing notification.
- `on`: a `promote: true` post can show as a chip.

`src/status.ts` (pure): `createStatus(native: NativeStatus | null): Status`. It checks `show()`'s options on every
platform, so a bad call fails in development on iOS too; with `null` everything else does nothing and `state()`
resolves `unsupported`. One native listener feeds a JS listener `Set` per event type, as in overlay (7.3).

Entries: `src/index.ts` exports the types, `createStatus`, `words`, `stateWords` and `status = createStatus(null)`;
`src/rn.ts` exports the same names with `status = createStatus(requireOptionalNativeModule('ByokitStatus'))`.

Events:
- `action`: the person tapped an action. Actions open the app (an activity intent, so Android 12's trampoline rule
  holds) with the id and a per-tap nonce as extras; the module reads it when the activity starts or gets a new
  intent, and holds it until JS listens. Each nonce is emitted once, even when Android replays the intent after process
  death or from Recents. A tap on the notification itself opens the app and emits nothing.
- `dismissed`: the person swiped the notification away. From then on `show()` posts nothing until the app calls
  `clear()` (the job ended); the next `show()` after that posts again. The dismissal survives the process.

### 12.4 Keeping the chip truthful

- `timeoutMs` is re-armed on every post. A dead app therefore clears its chip within `timeoutMs`.
- The app calls `show()` from its own refresh. Posts are deduped by the visible content (every `ShowOptions` field
  except `timeoutMs`) and throttled to one per 1.5 s with a trailing post of the latest options.
- An unchanged `show()` is dropped while the notification is still posted, except once half of `timeoutMs` has passed
  since the last post: then it posts again to re-arm the timeout. So an app that keeps calling `show()` keeps its chip,
  and one that stops loses it. A notification that went without a delete intent (force-stop, reboot, a blocked channel)
  is posted again by the next `show()`.
- A delete that arrives within 1 s of the timeout counts as the timeout, not as the person's dismissal.
- Times are on the boot clock (`elapsedRealtime`), so a wall-clock change moves nothing; a record from an earlier boot
  is forgotten. Nothing is recorded for a post that `needs-permission` stopped.

### 12.5 Kotlin parts (package `io.github.umeranjum17.byokit.status`, one job each)

```kotlin
data class Post(val title: String, val text: String, val chip: String, val publicText: String, val promote: Boolean,
                val actions: List<Pair<String, String>>, val timeoutMs: Long, val icon: String?)
data class Last(val signature: String, val at: Long, val timeoutMs: Long)
object StatusRules {                                                     // pure, JVM-tested
  const val CHIP_MAX = 7; const val ACTIONS_MAX = 3; const val THROTTLE_MS = 1500L; const val TIMEOUT_SLACK_MS = 1000L
  fun chipFits(chip: String): Boolean                                    // ≤ CHIP_MAX code points
  fun check(p: Post): String?                                            // the 12.3 rules; null when fine, else what is wrong
  fun promotable(p: Post, channelImportance: Int): Boolean               // promote, a title, the chip fits, channel above MIN
  fun channelPromotable(importance: Int): Boolean                        // above MIN; state() uses it
  fun signature(p: Post): String                                         // every visible field; not timeoutMs
  sealed class Decision { object Show; object Drop; data class Later(val ms: Long) }
  fun decide(sig: String, now: Long, last: Last?, dismissed: Boolean): Decision   // dismissed → Drop; dedupe/refresh; throttle
  fun userDismissed(now: Long, last: Last?): Boolean                     // false when the delete is the timeout
}
class StatusNotice(context: Context) {                                   // NotificationCompat, one notification
  fun show(p: Post, channelName: String); fun clear(); fun deleted()     // deleted(): from the delete intent
}
class StatusDismissReceiver : BroadcastReceiver()                        // the delete intent's target; not exported
class StatusModule : Module()                                            // Expo module 'ByokitStatus', maps NativeStatus
```

`StatusNotice` posts one notification (fixed tag and id) on its own channel `byokit.status`, `IMPORTANCE_LOW` (never
MIN, which blocks promotion), with no sound or badge. Each post sets:
- `setOngoing(true)`, `setOnlyAlertOnce(true)`, `setRequestPromotedOngoing(promote)` and `setShortCriticalText(chip)`;
- `VISIBILITY_PRIVATE` with a public version whose title is `publicText` (no text, no actions);
- `setTimeoutAfter(timeoutMs)`;
- `setDeleteIntent` to `StatusDismissReceiver`;
- the content intent and each action as an activity `PendingIntent` to the app's launch intent, each action with
  `setAuthenticationRequired(true)`.

The last post (`Last`) and the dismissal live in the app's `byokit.status` shared preferences, so the receiver works
in a fresh process. The module emits `dismissed` when it is alive; a later `show()` obeys the dismissal either way.

### 12.6 Library manifest and config plugin

- The library manifest declares `POST_NOTIFICATIONS` and `<receiver android:name=
  "io.github.umeranjum17.byokit.status.StatusDismissReceiver" android:exported="false"/>`.
- `app.plugin.js` adds `android.permission.POST_PROMOTED_NOTIFICATIONS` to the app manifest. It takes no options.
- There is no foreground service and no runtime prompt: the app asks for `POST_NOTIFICATIONS` itself (for example with
  `PermissionsAndroid`), shows `stateWords('needs-permission')`, and calls `openSettings()`.

### 12.7 Words (`src/words.json`)

| Key | Sentence |
|---|---|
| `status.on` | Work in progress shows at the top of the screen. |
| `status.off` | Work in progress shows only in the notification list. Turn it on in this app's notification settings. |
| `status.needsPermission` | Allow notifications for this app to see work in progress. |
| `status.unsupported` | This device can't show work in progress at the top of the screen. |
| `status.channel` | Work in progress |

`stateWords(s: StatusState)` maps each state to its `status.*` sentence; `status.channel` names the channel in the
system settings. The words test uses the D-P jargon expression.

### 12.8 Work package

**BK-S1 — the kit, JVM tests, CI and the emulator proof** · Sol · deps: BK-O1
- **Files:** everything in 12.2; root build list, `scripts/fix-words-dts.cjs` and `tsconfig.json`'s `rn.ts`
  exclusion gain `packages/statusbar`; `scripts/release.ts`' canonical order gains `statusbar` after `overlay`;
  `examples/expo` gets the dependency, the plugin and a small screen (show with three actions, clear, state);
  `.github/workflows/ci.yml` job `statusbar-android` (the `overlay-android` shape, running
  `:byokit-statusbar:testDebugUnitTest`); README table rows and the isolation sentence (D-D).
- **Acceptance:**
  - `StatusRulesTest` covers eligibility, the 7-character chip (code points), `check`, the signature (not
    `timeoutMs`), dedupe, the half-timeout refresh, the 1.5 s throttle, a dismissal dropping every post, and the
    timeout-versus-dismissal split. It runs in `statusbar-android`.
  - `status.test.ts` (fake `NativeStatus`) covers `show` validation before any native call, the channel name from
    words, listener sets, and `createStatus(null)` unsupported everywhere; `portable`, `words` and `exports` as in
    overlay.
  - An API 36.1 emulator run on `examples/expo`, recorded in the PR: the chip is visible, the lock screen shows the
    public copy, the expanded notification shows 3 actions, and after a swipe the next `show()` posts nothing.
  - The package stays `private: true` until that proof is recorded; publishing is a later release.
