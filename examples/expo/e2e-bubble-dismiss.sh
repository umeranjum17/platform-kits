#!/bin/sh
# Account-free bubble dismiss proof on an emulator owned by this test run, recorded under screenrecord. A slow swipe
# that drops the bubble mid-screen shows the dismiss target only while it lasts and snaps the bubble to the left edge.
# A held drag over the target highlights it and, let go back where it started, leaves the bubble at its spot. A swipe
# onto the target then turns the bubble off: no overlay window of the example is left and it shows its bubbleDismissed
# text. A fresh start() brings the bubble back at its saved spot. The mp4 is saved in the capture directory.
# The drags are `input swipe` and `input motionevent`: `input draganddrop` holds the touch for the long-press timeout
# first, which the bubble takes as a long press, so that drag never starts.
# Build the default example first (no EXPO_PUBLIC_SCREEN_DEMO): NODE_ENV=production ./gradlew assembleRelease
set -eu
cd "$(dirname "$0")"
serial=${1:?usage: $0 <emulator-serial> [capture-directory]}
case "$serial" in emulator-*) ;; *) echo 'bubble dismiss proof requires an emulator' >&2; exit 1;; esac
captures=${2:-.bubble-dismiss-captures}
mkdir -p "$captures"
app=io.github.umeranjum17.byokit.example
target=byokit-dismiss-target # Bubble.DISMISS_TITLE
video=/sdcard/byokit-bubble-dismiss.mp4
a() { adb -s "$serial" "$@"; }
[ "$(a shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'device is not an emulator' >&2; exit 1; }
a install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null
a shell pm clear "$app" >/dev/null
a shell appops set "$app" SYSTEM_ALERT_WINDOW allow
a shell settings delete secure enabled_accessibility_services >/dev/null # the bubble runs without the service
a shell am start -n "$app/.MainActivity" >/dev/null
screen() { a shell uiautomator dump /sdcard/byokit-bubble-dismiss.xml >/dev/null 2>&1; a exec-out cat /sdcard/byokit-bubble-dismiss.xml; }
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
# An overlay window of the example: left top right bottom. "target" is the dismiss target, by its title; "bubble" is
# any other but the disc shadow. Android 11+ prints `frame=`, older `mFrame=`. Fails when there is none; windows-<name>.txt keeps the dump.
window() {
  a shell dumpsys window windows > "$captures/windows-$1.txt"
  python3 -c 'import sys,re
want,app,title=sys.argv[2:5]
for b in open(sys.argv[1]).read().split("Window #"):
 if "ty=APPLICATION_OVERLAY" in b and app in b and "byokit-bubble-shadow" not in b and (title in b)==(want=="target"):
  m=re.search(r"\b(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]",b)
  if m: print(*m.groups()); break
else: raise SystemExit("no "+want+" window (see windows-"+want+".txt)")' "$captures/windows-$1.txt" "$1" "$app" "$target"
}
absent() { if window "$1" >/dev/null 2>&1; then echo "the $1 window is on screen $2" >&2; exit 1; fi; }
# Where a drag takes hold of the bubble, then how far that point is from its centre: a sixth of its width in from its
# inner side. A touch near the screen edge starts the system back gesture, which takes the touch from the bubble.
grab() { w=$(window bubble); set -- $w; d=$(( ($3 - $1) / 6 ))
  if [ "$1" -le 0 ]; then gx=$(( $3 - d )); else gx=$(( $1 + d )); fi
  gy=$(( ($2 + $4) / 2 )); ox=$(( gx - ($1 + $3) / 2 )); }
shot() { a exec-out screencap -p > "$captures/$1.png"; }
set -- $(a shell wm size | tr -d '\r' | sed -n 's/.*: *\([0-9]*\)x\([0-9]*\).*/\1 \2/p' | tail -1)
W=$1; H=$2
a shell screenrecord --time-limit 120 "$video" >/dev/null 2>&1 &
rec=$!
sleep 2
expect 'Umer'
tap bubbleStart
expect 'Stop the bubble'
sleep 1
shot bubble-dismiss-1-start
absent target 'before any drag'

# A slow swipe to mid-screen: the target shows while it lasts, then the bubble snaps to the left edge and stays on.
grab
a shell input swipe "$gx" "$gy" $(( W / 4 )) $(( H / 2 )) 10000 &
swipe=$!
sleep 2
# The screenshot and the window dump at once, then the target again: still there, so the screenshot is mid-drag.
shot bubble-dismiss-2-dragging &
w=$(window target)
cp "$captures/windows-target.txt" "$captures/windows-mid-drag.txt"
wait $!
window target >/dev/null || { echo 'the drag ended before the mid-drag screenshot was taken' >&2; exit 1; }
set -- $w
tl=$1; tt=$2; tr=$3; tb=$4
echo "target=[$tl $tt $tr $tb] screen=${W}x$H"
[ $(( tl + tr )) -ge $(( W - 2 )) ] && [ $(( tl + tr )) -le $(( W + 2 )) ] || { echo 'the target is not centred' >&2; exit 1; }
[ "$tb" -lt "$H" ] && [ "$tt" -gt $(( H / 2 )) ] || { echo 'the target is not at the bottom, above the gesture bar' >&2; exit 1; }
wait "$swipe"
sleep 2
absent target 'after the drop'
w=$(window bubble)
set -- $w
[ "$1" = 0 ] || { echo "a drop off the target did not snap the bubble to the left edge (left $1)" >&2; exit 1; }
saved=$(window bubble)
shot bubble-dismiss-3-snapped

# Held with its centre over the target it highlights; let go back where it started, it stays on at the same spot.
grab; bx=$gx; by=$gy
tx=$(( (tl + tr) / 2 + ox )); ty=$(( (tt + tb) / 2 ))
a shell "input motionevent DOWN $bx $by; input motionevent MOVE $(( (bx + tx) / 2 )) $(( (by + ty) / 2 )); input motionevent MOVE $tx $ty"
sleep 1
shot bubble-dismiss-4-over-target
window target >/dev/null
a shell "input motionevent MOVE $(( (bx + tx) / 2 )) $(( (by + ty) / 2 )); input motionevent MOVE $bx $by; input motionevent UP $bx $by"
sleep 2
absent target 'after a drop off it'
[ "$(window bubble)" = "$saved" ] || { echo "a drop back at its spot moved the bubble to [$(window bubble)], not [$saved]" >&2; exit 1; }

# A swipe onto the target: the bubble goes off and the app hears dismissed.
grab
a shell input swipe "$gx" "$gy" "$tx" "$ty" 1500
expect 'Bubble dismissed.'
bounds bubbleDismissed >/dev/null # the text is the example's bubbleDismissed node, not the Chip's
sleep 1
shot bubble-dismiss-5-dismissed
absent bubble 'after the dismiss'
absent target 'after the dismiss'
cp "$captures/windows-bubble.txt" "$captures/windows-after-dismiss.txt"
expect 'Start the bubble'

# The saved spot is kept: a fresh start() brings the bubble back exactly where it was.
tap bubbleStart
expect 'Stop the bubble'
sleep 1
restored=$(window bubble)
[ "$restored" = "$saved" ] || { echo "the bubble came back at [$restored], not its saved spot [$saved]" >&2; exit 1; }
shot bubble-dismiss-6-restored
tap bubbleStop
a shell pkill -INT screenrecord >/dev/null 2>&1 || true
wait "$rec" || true
sleep 2
a pull "$video" "$captures/bubble-dismiss.mp4" >/dev/null
a shell rm -f "$video"
echo "saved: $captures/bubble-dismiss.mp4"
echo "passed bubble dismiss on $serial"
