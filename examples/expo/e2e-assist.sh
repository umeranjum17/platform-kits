#!/bin/sh
# Account-free proof of social assist mode: from the bubble panel "Help me write" drafts from the focused field with
# its X length check, and "Put it in the field" inserts the draft into the example's own field. The kit sends
# nothing: this script never taps send, and fails when any tap names one. Use only an emulator owned by this test
# run. Build the default example first (no EXPO_PUBLIC_SCREEN_DEMO):
# NODE_ENV=production ./gradlew assembleRelease in android/.
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial> [capture-directory]}
case "$serial" in emulator-*) ;; *) echo 'assist proof requires an emulator' >&2; exit 1;; esac
captures=${2:-.assist-captures}
mkdir -p "$captures"
app=io.github.umeranjum17.byokit.example
a() { adb -s "$serial" "$@"; }
[ "$(a shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'device is not an emulator' >&2; exit 1; }
a install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null

typed='ship%sit%sfriday'

screen() { a shell uiautomator dump /sdcard/byokit-assist-ui.xml >/dev/null 2>&1; a exec-out cat /sdcard/byokit-assist-ui.xml; }
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
echo "native field value retained: $retained"
tap_bubble
expect 'Help me write'
tap 'Help me write'
expect 'Polished:'
# The shown draft is the demo drafter over the frozen reading, with its X length check.
dump
draft=$(attr assistDraft text)
[ "$draft" = "Polished: $retained" ] || { echo "draft is not the demo drafter over the field (got: $draft)" >&2; exit 1; }
length=$(attr assistLength text)
case "$length" in *"Fits X"*) ;; *) echo "length check missing the X fit line (got: $length)" >&2; exit 1;; esac
echo "ok: draft=[$draft] length=[$length]"
a exec-out screencap -p > "$captures/panel-assist.png"
# Record the insert segment: the draft on screen, the tap, the panel closing, and the pill saying it landed.
a shell screenrecord --time-limit 60 /sdcard/byokit-assist.mp4 >/dev/null 2>&1 &
rec=$!
tap 'Put it in the field'
# "Put it in the field" closes the panel; the app inserts once focus is back on the field. Wait for the close, then
# poll the field itself: it must read exactly the shown draft.
closed=''
for _ in $(seq 20); do screen | grep -Fq 'assistDraft' || { closed=yes; echo "ok: panel closed"; break; }; sleep 1; done
[ "$closed" = yes ] || { echo 'the panel stayed open after Put it in the field' >&2; exit 1; }
landed=''
for _ in $(seq 30); do
  dump
  if [ "$(attr fieldInput text)" = "$draft" ]; then landed=yes; echo "ok: field text equals the shown draft"; break; fi
  sleep 2
done
[ "$landed" = yes ] || { echo "field text never became the shown draft (want: $draft)" >&2; exit 1; }
a exec-out screencap -p > "$captures/field.png"
# Stop the recording with SIGINT so it finalizes; killing this side's adb client instead would truncate the mp4.
a shell kill -INT "$(a shell pidof screenrecord | tr -d '\r')" >/dev/null 2>&1 || true
for _ in $(seq 20); do a shell pidof screenrecord >/dev/null 2>&1 || break; sleep 1; done
wait "$rec" 2>/dev/null || true
sleep 1
a pull /sdcard/byokit-assist.mp4 "$captures/assist.mp4" >/dev/null
# The mp4 must play: fail when its header never finalized.
ffprobe -v error -show_entries format=duration "$captures/assist.mp4" >/dev/null \
  || { echo 'assist.mp4 is not a playable recording' >&2; exit 1; }
echo "ok: assist.mp4 plays"
# The run stops before any send: nothing tapped names one, and the kit made no post or approve call (the example
# imports only xLength from @platform-kits/social; grep the worktree to confirm).
if grep -qi 'send' "$captures/taps.txt" 2>/dev/null; then echo 'a tap named send; the run must stop before any send' >&2; exit 1; fi
echo "passed assist draft, length check and insert on $serial"
