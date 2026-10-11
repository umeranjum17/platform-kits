#!/bin/sh
# Account-free proof of the bubble panel reading the focused field. Use only an emulator owned by this test run.
# Types a long synthetic value in the example's own field, opens the real bubble panel and checks the focused app and
# the complete native value show, wrapped and untruncated, then closes it. Runs at a narrow phone width and font
# scale 1.3 in light and dark mode, capturing the panel and the bubble notice stills. Fails on a missing read, a
# shortened value or any ellipsis. Build the default example first (no EXPO_PUBLIC_SCREEN_DEMO):
# NODE_ENV=production ./gradlew assembleRelease in android/.
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

# The long synthetic value typed through the keyboard: several wrapped rows at a narrow width, so a single-line clamp
# would ellipsize it. The exact native result is read back from the field and is the panel's expected text.
typed='Please%smove%sthe%steam%sto%sthe%stall%sshed%sbefore%sFriday,%snot%safter%sthen,%sthanks'

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
expect() {
  for _ in $(seq 20); do
    if screen | grep -Fq "$1"; then echo "ok: $1"; return; fi
    sleep 1
  done
  echo "missing: $1" >&2
  # Diagnostic failures must not replace the original failed assertion.
  a shell dumpsys window windows > "$captures/timeout-windows.txt" 2>&1 || true
  a logcat -d -t 300 > "$captures/timeout-logcat.txt" 2>&1 || true
  a exec-out screencap -p > "$captures/timeout-screen.png" || true
  cp "$captures/ui.xml" "$captures/timeout-ui.xml" 2>/dev/null || true
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
 if "ty=APPLICATION_OVERLAY" in b and sys.argv[2] in b:
  m=re.search(r"\b(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]",b)
  if m: print(*m.groups()); break
else: raise SystemExit("no bubble window (see windows.txt)")' "$captures/windows.txt" "$app"
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
# The panel shows the focused app and the whole native value: exact text, the app named, and no ellipsis anywhere.
check_panel() {
  dump
  got=$(attr panelText text)
  [ "$got" = "$retained" ] || { echo "panel text not the native value (got ${#got} chars: $got)" >&2; exit 1; }
  echo "$got" | python3 -c 'import sys; t=sys.stdin.read(); sys.exit(1 if ("…" in t or "..." in t) else 0)'
  appline=$(attr panelApp text)
  case "$appline" in *"$expected_app"*) ;; *) echo "panel app line missing $expected_app: $appline" >&2; exit 1;; esac
  [ -n "$(attr panelClose bounds)" ] || { echo 'panel has no Close' >&2; exit 1; }
  echo "ok: panel app=[$appline] text=${#got} chars, no ellipsis"
}
journey() {
  mode=$1
  a shell cmd uimode night "$([ "$mode" = dark ] && echo yes || echo no)" >/dev/null
  a shell pm clear "$app" >/dev/null
  a shell appops set "$app" SYSTEM_ALERT_WINDOW allow
  sleep 2
  a logcat -c
  a shell am start -n "$app/.MainActivity" >/dev/null
  expect 'Umer'
  enable_a11y
  tap bubbleStart
  expect 'Stop the bubble'
  # The app's own "Read the focused field" reports whether its accessibility service is attached; wait for that,
  # because the panel reads the same flag and would show nothing until it is on.
  attached=''
  for _ in $(seq 40); do
    tap fieldRead
    sleep 2
    if screen | grep -Fq 'available: true'; then attached=yes; break; fi
  done
  [ "$attached" = yes ] || {
    echo 'the example never reported its accessibility service attached' >&2
    a shell dumpsys accessibility > "$captures/a11y-dumpsys.txt" 2>&1 || true
    exit 1
  }
  echo 'ok: example accessibility service attached'
  tap fieldInput
  a shell input text "$typed"
  a shell input keyevent KEYCODE_BACK # keyboard closed, the field keeps focus
  sleep 1
  dump
  retained=$(attr fieldInput text)
  [ -n "$retained" ] || { echo "the field kept no native value" >&2; exit 1; }
  [ "${#retained}" -ge 40 ] || { echo "the native value is too short to prove wrapping (got: $retained)" >&2; exit 1; }
  echo "native field value retained: ${#retained} chars"
  tap_bubble
  expect 'In focus:'
  check_panel
  sleep 1
  a exec-out screencap -p > "$captures/panel-$mode.png"
  tap panelClose
  for _ in $(seq 20); do screen | grep -Fq 'panelText' || { echo "ok: panel closed"; return 0; }; sleep 1; done
  echo 'the panel stayed open after Close' >&2; exit 1
}
# The bubble notice still: expand the shade while the bubble is on, shoot, collapse.
notice_shot() {
  mode=$1
  a shell cmd statusbar expand-notifications >/dev/null
  sleep 2
  a exec-out screencap -p > "$captures/notice-$mode.png"
  a shell cmd statusbar collapse >/dev/null
  sleep 1
}
expected_app=Umer
for mode in light dark; do
  printf '=== %s mode, narrow 360 dp, font scale 1.3 ===\n' "$mode"
  journey "$mode"
  notice_shot "$mode"
done

# Back to the emulator's own display, font scale and theme.
a shell wm size reset >/dev/null
a shell wm density reset >/dev/null
a shell settings put system font_scale 1.0 >/dev/null
a shell cmd uimode night no >/dev/null
echo "passed panel read, wrap and Close on $serial (light and dark)"
