# Internal cursor producer adapter

Status: **partial implementation, live support unqualified**. Desklink must retain
`cursor_positions_unavailable`. This directory is an Apache-2.0 internal reference;
it has no public package name, publication, service installation, or consumer IPC.

The adapter binds the public `ext-image-copy-capture-v1` pointer cursor session to
the source object already selected by a portal, and writes real `SPA_META_Cursor`
into that portal's dequeued PipeWire buffers. It opens no Wayland/PipeWire socket,
selects no ambient seat, and changes no permissions. The embedding portal owns
consent, output selection, pixel capture, permissions, buffer negotiation/queueing,
dispatch, and cleanup.

## Build and offline contract

Dependencies: C11 compiler, pkg-config, Wayland client headers/library,
wayland-scanner, wayland-protocols with both image capture protocols, and PipeWire
headers/library. Build artifacts remain under `build/`.

```sh
make -C internal/cursor-producer check
```

The single offline check uses labelled fixtures and verifies SPA layout, staged
hotspots, alpha visibility, source boundaries, id-zero suppression, queue retry,
re-entry, recycled undersized buffers, and preservation of frame-header PTS. It
does not connect a compositor or portal. Its output explicitly says live support
is unqualified. Serialize builds and checks with the task's heavy-job lock.

## Portal integration ownership

1. Probe the public capture globals and obtain a pointer from the selected private
   seat on the portal's existing connection. Create the main image capture session
   without `paint_cursors`. Pass its exact source object to `pk_cursor_create`.
   Supply the main capture's transformed buffer pixel dimensions. Recreate the
   adapter if the source geometry changes. Handle denied/pending permissions by
   refusing Metadata; an advertised global alone proves no access.
2. Reuse the portal's cursor-image capture loop on `pk_cursor_image_session`.
   Attach its session listener before dispatch. Negotiate SHM constraints, allocate
   actual Wayland buffers, and allow at most one pending frame. On `frame.ready`,
   call `pk_cursor_image_ready` with actual bytes, byte length, dimensions, stride,
   format, transform, and compositor monotonic presentation time. Destroy the
   completed frame before requesting another. Call `pk_cursor_stop` on stopped,
   revoked, malformed or failed capture and propagate refusal/end to the consumer.
   Destroy pending frame objects before destroying the adapter.
3. Add `pk_cursor_negotiate` alongside the stream's existing format, buffer, header,
   and transform parameters. Require actual cursor metadata allocation. In the
   portal's serialized delivery callback, fill cursor-free pixels from a genuine
   captured main frame, then call `pk_cursor_write`. Queue on success, and call
   `pk_cursor_queued` with the returned revision only after queueing succeeds.
   Negative errors must fail/end Metadata delivery, not silently queue a buffer
   that makes absent metadata look supported.
4. Dispatch cursor sessions independently of main-image damage. A portal may reuse
   the last genuinely captured main pixels when delivering a real changed cursor
   observation. Preserve that frame's presentation provenance. Never invent a
   new capture presentation time for unchanged pixels. A timer does not supply
   missing cursor observations. Serialize Wayland dispatch and writes with the
   PipeWire delivery thread; this adapter provides no cross-thread synchronization.
5. After stop/disconnect, disable delivery and destroy all caller-owned frames and
   buffers, then `pk_cursor_destroy`. Borrowed source/seat/manager/stream objects
   retain portal ownership. No helper launches or supervises services.

The runnable offline reference is `build/contract`; `build/libcursor-producer.a`
is the producer adapter. **A runnable portal embedding is still required.** No
existing portal has been patched or qualified by this implementation. The checked
permissive generic portal from the feasibility report has a Rust Wayland backend;
this C API is not assumed to interoperate with its proxies without a verified
adapter. Consumer changes belong to the Desklink owner and are outside this tree.

## Coordinates, image semantics, and time

Public protocol `position` is already the hotspot in selected-source transformed
buffer pixels. The adapter passes signed x/y through exactly. It never adds the
desktop origin or bitmap hotspot. Out-of-source hotspot coordinates produce an
explicit invisible marker; it retains the last observed position on leave.
Re-entry waits for the newly delivered position instead of replaying stale state.

Hotspot events stage bitmap offsets until cursor-image `ready`. Captured ARGB8888
is packed as SPA BGRA on little-endian hosts; XRGB8888 alpha is set opaque because
that channel is unused. Completely transparent captured ARGB is normalized to an
explicit valid-format SPA bitmap with image offset zero. Source leave also sends
this marker. A nonzero id always accompanies an actual changed observation.
Identical state emits id zero. Each changed sample includes a full bitmap or
invisible marker so rotating/reused PipeWire buffers cannot revive stale images.
Undersized or absent metadata fails closed, clearing recycled cursor ids whenever
there is space for the header. No pointer coordinates are emitted before a real
position and captured image are known.

This bounded image adapter supports normal cursor-image transform only and sizes
up to 512×512. Other transforms, formats, malformed lengths or decreasing cursor
image presentation timestamps stop the adapter. Supporting main-output rotations
depends on the compositor honoring the specified position convention; it is not
established by these offline checks.

Hyprland 0.56.2's pinned implementation subtracts a logical source origin from a
logical pointer position without explicit pixel-scale/output-transform mapping in
that path. Therefore scaled/transformed Hyprland output is **not qualified** for
this pass-through adapter. No guessed scale multiplication or origin correction
is included. A supported geometry mapping must be derived and independently
qualified before such sources can be enabled.

`pk_cursor_provenance` separates system `CLOCK_MONOTONIC` observation nanoseconds,
cursor-image presentation nanoseconds, and state revision. It does not overwrite
`SPA_META_Header`. SPA cursor has no timestamp member. Desklink keeps its existing
engine-process shared cursor/frame observation clock in microseconds. Producer
times must remain separate or use a measured epoch mapping; they cannot be copied
directly into Desklink timestamps. Export provenance as raw JSON during live runs.

## Required qualification still outstanding

Reuse Desklink's `packages/desktop-host/test/portal-g2g-flow.mjs` cage seams, with a
private real Hyprland child on a private headless parent. No ambient sockets,
live seat/KMS/input devices, paired devices, host HOME, host permissions, or service
activation are allowed. Fresh runtime, task HOME, bus, PipeWire, portal and render
node only; namespace teardown must reap every task process. The existing Sway-only
refusal result does not qualify Hyprland. Keep the measured load gate at 8 and
acquire the home heavy lock before the Desklink lock. A busy lock defers the job.

Required before support or task completion:

- A portal-owned stream delivering real nonzero SPA samples, raw samples and frame
  provenance, with independent compositor-delivered `wl_pointer` truth.
- Origins, scales, rotations/flips, boundaries, bitmap-only changes, explicit
  hide/show, id zero, and source/seat identity exercised on actual selected sources.
- Real moving-pointer delivery at requested 60 Hz on a still surface, measured
  intervals/gaps and a comparable consumer monotonic observation clock.
- Cursor-free pixels plus Embedded positive control through the same real source.
- Five seconds of live changing frames with Umer's cursor redrawn only from
  delivered samples, distinct-frame hashes and original frame times retained.
- Isolation, all-process cleanup, required CI, and a review-ready committed result.

OUTPUT location for this task's untracked build/acquisition/qualification evidence
is `<worktree>/output/`. Raw consumer acceptance samples must additionally reach
the supervisor-routed Desklink evidence location after ownership is coordinated;
this worker has not written into another project's lab. No live clip or raw sample
artifact currently exists.

## Primary sources and licensing

- [Protocol XML, pinned](https://github.com/wayland-mirror/wayland-protocols/blob/819004adb3ab7e46f3fa3caef05b96e20434b244/staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml):
  position, staged hotspot, and monotonic presentation semantics. Generated code
  uses installed protocol XML and preserves its permissive copyright notice.
- [Hyprland 0.56.2 source](https://github.com/hyprwm/Hyprland/blob/efb50993780079460b0cbed1363e2166a2de1d9f/src/protocols/ImageCopyCapture.cpp):
  supported cursor session and the unqualified mapping risk; BSD-3-Clause.
- [SPA cursor/bitmap ABI](https://docs.pipewire.org/group__spa__buffer.html): MIT
  headers used via the installed development dependency; no producer code copied.
- Wayland client library: MIT; wayland-protocols XML: permissive notices retained
  by wayland-scanner. PipeWire libraries: MIT. This adapter's original code is
  covered by the repository Apache-2.0 license.
- [Arch Sway package](https://archlinux.org/packages/extra/x86_64/sway/),
  [Arch wlroots package](https://archlinux.org/packages/extra/x86_64/wlroots0.20/):
  official task-private parent candidates declare MIT. Package extraction must
  verify Arch signatures and retain package license files under the ignored
  task runtime prefix. No distribution/publication is authorized.

The preserved feasibility report and Desklink `producer-gap.md` remain the
source-pinned direction and acceptance authority.
