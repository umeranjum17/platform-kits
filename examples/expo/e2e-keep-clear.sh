#!/bin/sh
# Account-free keepClear proof on an emulator owned by this test run: the bubble's pill over the example's text field,
# then kept clear of it, then back at its saved spot. Logs the measured boxes and fails on any overlap after keepClear.
# Build the default example first (no EXPO_PUBLIC_SCREEN_DEMO): NODE_ENV=production ./gradlew assembleRelease
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial> [capture-directory]}
case "$serial" in emulator-*) ;; *) echo 'keepClear proof requires an emulator' >&2; exit 1;; esac
captures=${2:-.keep-clear-captures}
mkdir -p "$captures"
app=io.github.umeranjum17.byokit.example
a() { adb -s "$serial" "$@"; }
[ "$(a shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'device is not an emulator' >&2; exit 1; }
a install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null
a shell pm clear "$app" >/dev/null
a shell appops set "$app" SYSTEM_ALERT_WINDOW allow
a shell am start -n "$app/.MainActivity" >/dev/null
screen() { a shell uiautomator dump /sdcard/byokit-keep-clear.xml >/dev/null 2>&1; a exec-out cat /sdcard/byokit-keep-clear.xml; }
expect() {
  for _ in $(seq 20); do
    if screen | grep -Fq "$1"; then echo "ok: $1"; return; fi
    sleep 1
  done
  echo "missing: $1" >&2; exit 1
}
# A node's bounds by resource-id: left top right bottom, in physical display pixels.
bounds() {
  screen | python3 -c 'import sys,xml.etree.ElementTree as E,re
for n in E.fromstring(sys.stdin.read()).iter("node"):
 if n.get("resource-id")==sys.argv[1]: print(*re.findall(r"\d+",n.get("bounds"))); break
else: raise SystemExit("missing: "+sys.argv[1])' "$1"
}
tap() { set -- $(bounds "$1"); a shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 )); }
# The bubble's overlay window (bubble plus pill): left top right bottom. Android 11+ prints `frame=`, older `mFrame=`.
bubble() {
  a shell dumpsys window windows > "$captures/windows.txt"
  python3 -c 'import sys,re
for b in open(sys.argv[1]).read().split("Window #"):
 if "ty=APPLICATION_OVERLAY" in b and sys.argv[2] in b:
  m=re.search(r"\b(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]",b)
  if m: print(*m.groups()); break
else: raise SystemExit("no bubble window (see windows.txt)")' "$captures/windows.txt" "$app"
}
# Prints the overlap area of two boxes (left top right bottom each).
overlap() { python3 -c 'import sys;a=list(map(int,sys.argv[1:5]));b=list(map(int,sys.argv[5:9]));print(max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1])))' "$@"; }
shot() { sleep 1; a exec-out screencap -p > "$captures/$1.png"; f=$(bounds fieldInput); w=$(bubble); echo "$1 field=[$f] bubble=[$w] overlap=$(overlap $f $w)" | tee -a "$captures/boxes.txt"; }
: > "$captures/boxes.txt"
expect 'Platform kits on android'
tap bubbleStart
expect 'Stop the bubble'
tap fieldInput
a shell input text 'Will%syou%sarrive%sat%sfive?'
a shell input keyevent KEYCODE_BACK # keyboard closed, as after an insert from the panel
# Drag the bubble so its saved spot sits on the field (the person's own choice of spot).
set -- $(bubble); bx=$(( ($1 + $3) / 2 )); by=$(( ($2 + $4) / 2 ))
set -- $(bounds fieldInput); fy=$(( ($2 + $4) / 2 ))
a shell input swipe "$bx" "$by" "$bx" "$fy" 800
sleep 1
tap sayPill
shot keep-clear-1-before
[ "$(overlap $(bounds fieldInput) $(bubble))" -gt 0 ] || { echo 'fixture: the pill does not cover the field' >&2; exit 1; }
saved=$(bubble)
tap keepClear
expect 'Keeping clear of'
shot keep-clear-2-after
[ "$(overlap $(bounds fieldInput) $(bubble))" = 0 ] || { echo 'keepClear left the bubble or pill on the field' >&2; exit 1; }
# No clear spot anywhere: it stays at its saved spot (still over the field) and says so.
tap keepClearAll
expect 'No clear spot: the bubble stays put.'
shot keep-clear-3-no-space
set -- $saved; top=$2; set -- $(bubble)
[ "$2" = "$top" ] || { echo "with no clear spot the bubble moved ($top, now $2)" >&2; exit 1; }
tap keepClearOff
expect 'Back at its own spot.'
shot keep-clear-4-cleared
set -- $saved; top=$2; set -- $(bubble)
[ "$2" = "$top" ] || { echo "the bubble did not return to its saved spot ($top, now $2)" >&2; exit 1; }
tap bubbleStop
echo "passed keepClear on $serial"
