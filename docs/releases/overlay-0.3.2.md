# Overlay 0.3.2 — guide clarity and app-named protected boxes

Prepared patch after public **0.3.1**; publication and exact qualified merge are verified separately. Install the patch when registry verification is complete:

```sh
npm install @platform-kits/overlay@0.3.2
```

The original [first-checkpoint notes](checkpoint-2026-10-02.md) and immutable 0.3.1 publication receipts remain unchanged: that baseline excluded the then-unmerged guide. This patch includes the subsequently green, merged [guide fixes](https://github.com/umeranjum17/platform-kits/pull/3) and [protected-box placement](https://github.com/umeranjum17/platform-kits/pull/14). No changes or publications are planned for record 0.2.1, statusbar 0.1.2, browser 0.1.1, private speak 0.1.0 or private social 0.1.0. Third-party dependency pins are unchanged; the linked Expo example lock follows overlay 0.3.2.

## New

- `overlay.keepClear(rects: ClearRect[])` lets the host protect up to 64 app-named boxes. `ClearRect` contains `left`, `top`, `width`, `height` in **full-display physical pixels**, origin top-left, not dp or coordinates from a resized screenshot. The JavaScript boundary checks finite edges and non-negative sizes before native calls. Kotlin: `ServiceBubble.keepClear(List<ClearRect>)`, with `io.github.umeranjum17.byokit.overlay.ClearRect(left: Int, top: Int, width: Int, height: Int)`. [Protected-box change](https://github.com/umeranjum17/platform-kits/pull/14).
- The example offers Show the pill / Keep the field clear / Stop keeping it clear actions. These are host-integration examples, not proof of adoption by a consumer app. [Protected-box change](https://github.com/umeranjum17/platform-kits/pull/14).

## Fixed

- **FIX:** The guide ring surrounds the whole target instead of covering its label; `pointHere` accepts optional target `width`/`height`. Its callout sits below or flips above, keeps clear of system bars/cutouts/edges, and supports optional `avoid` boxes for nearby controls/text. Ring and callout contrast remains readable on light/dark pages. [Guide fixes](https://github.com/umeranjum17/platform-kits/pull/3).
- **FIX:** A dark disc and light rim keep a light bubble mood image visible on a light page. The example uses dark status-bar icons and explains its small local screen-preview thumbnail instead of presenting a confusing full-screen preview. [Guide fixes](https://github.com/umeranjum17/platform-kits/pull/3).
- **FIX:** With app-named boxes, the whole measured bubble-and-pill row can move to the nearest clear vertical position on its own edge, below the status bar and above the keyboard. The saved spot is not rewritten. No available position leaves the row at its saved spot and emits `{ type: 'keepClear', clear: false }`; `clear: true` reports recovery. [Protected-box change](https://github.com/umeranjum17/platform-kits/pull/14).

## Improved

- Placement follows pill size (including a taller pill), keyboard movement and display geometry. `keepClear([])` releases the protected boxes; `stop()`, foreground-app change, host loss and display-size change drop stale boxes. The saved spot is preserved. Panel hide/show retains applicable boxes. [Protected-box change](https://github.com/umeranjum17/platform-kits/pull/14).
- Existing accepted guide tours cover top/left/middle/right/bottom placements on disposable Android 15/16 emulators. Native placement/unit checks and source CI are distinct from consumer adoption or personal-phone acceptance. [Guide fixes](https://github.com/umeranjum17/platform-kits/pull/3).

## Existing visible proof and known issues

- API 36 example before/after screenshots and measured bounds show the declared field's overlap falling from **63,070 px² to 0**. The after image also shows the pill overlapping an **unnamed Read-the-focused-field button**: callers must protect **every** field/control they want kept clear. There is no automatic focused-field scan or universal geometry guarantee.
- With a whole-screen protected box, the row stays at its saved spot, still overlapping the field by 63,070 px², and the example truthfully says No clear spot. Hosts must move, hide or rehome the confirmation when `clear: false` rather than assuming success.
- Captures were made from clean source `3bf7d5d`; product placement content is unchanged at accepted source `331a79f0e09a2af983f3750b7125c6fa9bec9029` (the final change is a driver assertion). The final cleared/reset device step **failed and was not rerun**. Return to saved spot is qualified by Robolectric tests **only**, not a completed device reset journey. Original failed attempts and the nested capture failure remain retained; a successful wrapper exit does not erase them. [Protected-box evidence and limits](https://github.com/umeranjum17/platform-kits/pull/14).
- Full source evidence review: supervisor `data/pk-overlay-avoid-rects/output-review-20261002.md`; captures `evidence/capture-3/keep-clear-{1-before,2-after,3-no-space}.png`, measured `boxes.txt`, original run logs/window dumps retained. No new emulator, native proof or capture was performed for this release lane.
- Android native APIs only; absent native module remains unsupported/no-op as documented. Fresh consent per screen-frame PNG and password protections remain unchanged. Overlay permission/service integration still belongs to the host.
- Consumer four-case geometry acceptance, close-X lifecycle, personal phone/store acceptance and live authentication remain **unqualified and separately owned**. Publishing an SDK does not prove those journeys.
- No new feature implementation in the release lane, automatic field scanning, lifecycle repair, private-package publication, consumer migration or trusted-provenance claim.
