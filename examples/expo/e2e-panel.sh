#!/bin/sh
# Account-free proof of the bubble panel reading the focused field. Use only an emulator owned by this test run.
# Edits a long synthetic value in the example's own field and taps the bubble immediately (no sleep, no cache), then
# checks the panel shows the field's exact native value, the app named, wrapped and untruncated, overflowing so it
# scrolls to the end, with a reachable Close. Also checks the no-focus and service-off states. Runs at a narrow phone
# width and font scale 1.3 in light and dark mode, capturing the panel and notice stills. Every wait is on an observed
# condition, never a fixed delay. Fails on a missing read, a shortened value, an ellipsis, or a stale value.
# Build the default example first (no EXPO_PUBLIC_SCREEN_DEMO): NODE_ENV=production ./gradlew assembleRelease in android/.
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial> [capture-directory]}
case "$serial" in emulator-*) ;; *) echo 'panel proof requires an emulator' >&2; exit 1;; esac
captures=${2:-.panel-captures}
mkdir -p "$captures"
app=io.github.umeranjum17.byokit.example
a() { adb -s "$serial" "$@"; }
[ "$(a shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'device is not an emulator' >&2; exit 1; }
a install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null

# The long synthetic value typed through the keyboard: dozens of wrapped rows at a narrow width, so the panel must
# scroll to its end. It is typed one unit per `input text` call (a single call truncates around 365 chars), with a
# leading `%s` between units. The keyboard can drop or repeat a unit, so `expected` is the field's own native value
# once it settles (see settle_field), not a value computed here.
base='Please%smove%sthe%steam%sto%sthe%stall%sshed%sbefore%sFriday,%snot%safter%sthen,%sthanks'
units=12
expected=''

# Narrow phone width (360 dp) and font scale 1.3 for every run; the panel must keep Close reachable there.
a shell wm size 720x1600 >/dev/null
a shell wm density 320 >/dev/null
a shell settings put system font_scale 1.3 >/dev/null

screen() { a shell uiautomator dump /sdcard/byokit-panel-ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/byokit-panel-ui.xml; }
dump() { screen > "$captures/ui.xml"; }
# A node's attribute by resource-id (or text); empty when the node is absent.
attr() {
  python3 -c 'import sys,xml.etree.ElementTree as E
key,field=sys.argv[1],sys.argv[2]
for n in E.fromstring(open(sys.argv[3]).read()).iter("node"):
 if n.get("resource-id")==key or n.get("text")==key: print(n.get(field) or ""); break
else: raise SystemExit("missing: "+key)' "$1" "$2" "$captures/ui.xml"
}
# Diagnostic failures must not replace the original failed assertion.
diag() {
  a shell dumpsys window windows > "$captures/timeout-windows.txt" 2>&1 || true
  a logcat -d -t 300 > "$captures/timeout-logcat.txt" 2>&1 || true
  a exec-out screencap -p > "$captures/timeout-screen.png" 2>/dev/null || true
  cp "$captures/ui.xml" "$captures/timeout-ui.xml" 2>/dev/null || true
}
# Wait until the shown screen contains a string (observed readiness, never a fixed delay).
expect() {
  for _ in $(seq 30); do
    if screen | grep -Fq "$1"; then echo "ok: $1"; return; fi
    sleep 1
  done
  echo "missing: $1" >&2
  diag
  exit 1
}
# Wait until the shown screen no longer contains a string.
expect_gone() {
  for _ in $(seq 30); do
    if ! screen | grep -Fq "$1"; then echo "ok: gone $1"; return; fi
    sleep 1
  done
  echo "still present: $1" >&2
  diag
  exit 1
}
# Match resource-id or text; emit its centre in physical display pixels.
xy() {
  screen | python3 -c 'import sys,xml.etree.ElementTree as E,re
key=sys.argv[1]
for n in E.fromstring(sys.stdin.read()).iter("node"):
 if n.get("resource-id")==key or n.get("text")==key:
  x,y,r,b=map(int,re.findall(r"\d+",n.get("bounds")))
  print((x+r)//2,(y+b)//2); break
else: raise SystemExit("missing target: "+key)' "$1"
}
tap() {
  location=$(xy "$1")
  printf 'tap target=%s physical-pixels=%s\n' "$1" "$location" | tee -a "$captures/taps.txt" >&2
  # shellcheck disable=SC2086 # xy emits the two numeric arguments intentionally.
  a shell input tap $location
}
# The bubble's overlay window (left top right bottom) from dumpsys; Android 11+ prints `frame=`, older `mFrame=`.
bubble() {
  a shell dumpsys window windows > "$captures/windows.txt"
  python3 -c 'import sys,re
for b in open(sys.argv[1]).read().split("Window #"):
 if "ty=APPLICATION_OVERLAY" in b and sys.argv[2] in b and "byokit-bubble-shadow" not in b:
  m=re.search(r"\b(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]",b)
  if m: print(*m.groups()); break
else: raise SystemExit("no bubble window (see windows.txt)")' "$captures/windows.txt" "$app"
}
# Wait until the bubble overlay window is up again (it hides while a panel is open).
wait_bubble() {
  for _ in $(seq 20); do
    if bubble >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'the bubble window never came back' >&2
  diag
  exit 1
}
tap_bubble() {
  set -- $(bubble)
  printf 'tap bubble physical-pixels=%s %s\n' "$(( ($1 + $3) / 2 ))" "$(( ($2 + $4) / 2 ))" | tee -a "$captures/taps.txt" >&2
  a shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
# Enable only the example's own accessibility service. `pm clear` disables it, so it is set again; readiness is what
# the app's own report below proves, not this write.
enable_a11y() {
  comp="$app/$app.a11y.DemoAccessibilityService"
  a shell settings put secure enabled_accessibility_services "$comp"
  a shell settings put secure accessibility_enabled 1
}
disable_a11y() {
  a shell settings delete secure enabled_accessibility_services
  a shell settings put secure accessibility_enabled 0
}
# Wait until the app's own "Read the focused field" reports its service attached: the panel reads the same flag and
# would show nothing until it is on. This is the readiness signal, not `dumpsys accessibility`, which can lag.
wait_a11y() {
  for _ in $(seq 40); do
    tap fieldRead
    if screen | grep -Fq 'available: true'; then echo 'ok: accessibility service attached'; return; fi
    sleep 1
  done
  echo 'the example never reported its accessibility service attached' >&2
  a shell dumpsys accessibility > "$captures/a11y-dumpsys.txt" 2>&1 || true
  exit 1
}
# The panel shows the focused app and the whole native value: exact text, the app named, and no ellipsis anywhere.
check_panel() {
  dump
  got=$(attr panelText text)
  [ "$got" = "$expected" ] || { echo "panel text differs (got ${#got} chars, wanted ${#expected})" >&2; exit 1; }
  echo "$got" | python3 -c 'import sys; t=sys.stdin.read(); sys.exit(1 if ("…" in t or "..." in t) else 0)'
  appline=$(attr panelApp text)
  case "$appline" in *"$expected_app"*) ;; *) echo "panel app line missing $expected_app: $appline" >&2; exit 1;; esac
  [ -n "$(attr panelClose bounds)" ] || { echo 'panel has no Close' >&2; exit 1; }
  echo "ok: panel app=[$appline] text=${#got} chars, no ellipsis"
}
# The screen as a checksum: uiautomator clips a scrolled node's bounds, so the pixels show whether the text moved.
screen_hash() {
  a exec-out screencap -p | md5sum | cut -d' ' -f1
}
# The screen once it stops changing (a fling animates for a moment after each swipe).
settled_hash() {
  prev=''
  for _ in $(seq 10); do
    cur=$(screen_hash)
    if [ "$cur" = "$prev" ]; then echo "$cur"; return; fi
    prev=$cur
    sleep 0.5
  done
  echo "the panel never stopped moving" >&2
  diag
  exit 1
}
# The value overflows the panel's card, so the text scrolls. Swiping must move the screen, and the end is reached when
# one more swipe leaves it unchanged; the whole value and Close must still be there.
check_overflow() {
  dump
  [ "$(attr panelScroll scrollable)" = true ] || { echo 'panel text does not overflow its card' >&2; exit 1; }
  set -- $(attr panelScroll bounds | python3 -c 'import sys,re
x1,y1,x2,y2=map(int,re.findall(r"\d+",sys.stdin.read())); cx=(x1+x2)//2; print(cx,y2-10,cx,y1+10)')
  top=$(settled_hash)
  a shell input swipe "$1" "$2" "$3" "$4" 300 >/dev/null
  prev=$(settled_hash)
  [ "$prev" != "$top" ] || { echo 'the panel text does not scroll' >&2; diag; exit 1; }
  n=0
  while :; do
    a shell input swipe "$1" "$2" "$3" "$4" 300 >/dev/null
    cur=$(settled_hash)
    [ "$cur" != "$prev" ] || break
    prev=$cur
    n=$((n + 1))
    [ "$n" -lt 12 ] || { echo 'the end of the value never scrolled into the panel' >&2; diag; exit 1; }
  done
  dump
  [ "$(attr panelText text)" = "$expected" ] || { echo 'panel text changed while scrolling' >&2; exit 1; }
  [ -n "$(attr panelClose bounds)" ] || { echo 'Close was lost after scrolling' >&2; exit 1; }
  echo "ok: value scrolls to its end (screen stops moving after $((n + 1)) swipes), whole value and Close intact"
}
# Wait until the field's value has stopped changing and is long enough to wrap; that value becomes `expected`.
settle_field() {
  prev=''
  for _ in $(seq 30); do
    dump
    v=$(attr fieldInput text)
    if [ "${#v}" -ge 40 ] && [ "$v" = "$prev" ]; then expected=$v; echo "ok: field settled at ${#v} chars"; return; fi
    prev=$v
    sleep 1
  done
  echo 'the field value never settled to a long value' >&2
  diag
  exit 1
}
journey() {
  mode=$1
  a shell cmd uimode night "$([ "$mode" = dark ] && echo yes || echo no)" >/dev/null
  a shell cmd statusbar collapse >/dev/null # a shade left open by an earlier run would cover the app
  a shell pm clear "$app" >/dev/null
  a shell appops set "$app" SYSTEM_ALERT_WINDOW allow
  a logcat -c
  a shell am start -n "$app/.MainActivity" >/dev/null
  expect 'Umer'
  enable_a11y
  tap bubbleStart
  expect 'Stop the bubble'
  wait_a11y
  wait_bubble
  # No field focused yet: the panel says so plainly, not a stale read.
  tap_bubble
  expect 'No text field is in focus.'
  tap panelClose
  expect_gone 'No text field is in focus.'
  wait_bubble
  # Edit, then tap immediately: the panel must show the field's exact value read at the tap, not a warm cache.
  tap fieldInput
  i=0
  while [ "$i" -lt "$units" ]; do
    if [ "$i" -eq 0 ]; then a shell input text "$base"; else a shell input text "%s$base"; fi
    i=$((i + 1))
  done
  a shell input keyevent KEYCODE_BACK # keyboard closed, the field keeps focus
  settle_field # the edit is observed in the field itself
  tap_bubble
  expect 'In focus:'
  check_panel
  check_overflow
  a exec-out screencap -p > "$captures/panel-$mode.png"
  tap panelClose
  expect_gone 'In focus:'
  # The field still holds the value; the panel showed exactly it.
  dump
  got=$(attr fieldInput text)
  [ "$got" = "$expected" ] || { echo "the field value drifted from the panel's: ${#got} vs ${#expected}" >&2; exit 1; }
  echo "ok: panel matched the field's exact native value (${#expected} chars)"
}
# The bubble notice still: expand the shade while the bubble is on, wait for the notice, shoot, collapse.
notice_shot() {
  mode=$1
  a shell cmd statusbar expand-notifications >/dev/null
  # The shade shows the bubble's notice collapsed, so its body text is not asserted here; the still is the evidence.
  settled_hash >/dev/null
  a exec-out screencap -p > "$captures/notice-$mode.png"
  a shell cmd statusbar collapse >/dev/null
  # The shade's text can stay in the window dump after it closes, so wait for the screen to stop moving instead.
  settled_hash >/dev/null
}
# With the accessibility service off the panel says so, instead of an invented read.
service_off() {
  disable_a11y
  for _ in $(seq 20); do
    tap fieldRead
    if screen | grep -Fq 'available: false'; then break; fi
    sleep 1
  done
  tap_bubble
  expect 'read fields yet.'
  a exec-out screencap -p > "$captures/panel-service-off.png"
  tap panelClose
  expect_gone 'read fields yet.'
}
expected_app=Umer
for mode in light dark; do
  printf '=== %s mode, narrow 360 dp, font scale 1.3 ===\n' "$mode"
  journey "$mode"
  notice_shot "$mode"
done
printf '=== accessibility service off ===\n'
service_off

# Back to the emulator's own display, font scale and theme.
a shell wm size reset >/dev/null
a shell wm density reset >/dev/null
a shell settings put system font_scale 1.0 >/dev/null
a shell cmd uimode night no >/dev/null
echo "passed panel read, wrap, overflow, Close, no-focus and service-off on $serial (light and dark)"
