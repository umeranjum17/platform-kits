#!/bin/sh
# Account-free bubble shadow proof on an emulator owned by this test run: stills over light and dark screens, the
# luminance under the disc's bottom edge, and a tap just below the disc reaching the app. Light background (>=30): pixels 2-6dp below the disc are each >=10 darker than the
# background 16dp below. Near-black (<30): none of them lighter than that background, and the rim's difference is shown.
# Needs ImageMagick's `magick`. Build the default example first: NODE_ENV=production ./gradlew assembleRelease
set -eu
cd "$(dirname "$0")"
s=${1:?usage: $0 <emulator-serial> [capture-directory]}
case "$s" in emulator-*) ;; *) echo 'bubble shadow proof requires an emulator' >&2; exit 1;; esac
out=${2:-.bubble-shadow-captures}; mkdir -p "$out"
app=io.github.umeranjum17.byokit.example
a() { adb -s "$s" "$@"; }
[ "$(a shell getprop ro.kernel.qemu | tr -d '\r')" = 1 ] || { echo 'device is not an emulator' >&2; exit 1; }
dump() { a shell uiautomator dump /sdcard/u.xml >/dev/null 2>&1; a exec-out cat /sdcard/u.xml; }
attr() { dump | python3 -c 'import sys,re,xml.etree.ElementTree as E
for n in E.fromstring(sys.stdin.read()).iter("node"):
 if n.get("resource-id")==sys.argv[1]: print(n.get(sys.argv[2])); break
else: raise SystemExit("missing "+sys.argv[1])' "$1" "$2"; }
tapid() { for _ in $(seq 20); do dump | grep -q "\"$1\"" && break; sleep 1; done; set -- $(attr "$1" bounds | grep -oE '[0-9]+'); a shell input tap $(( ($1+$3)/2 )) $(( ($2+$4)/2 )); }
# The bubble's window, or with "shadow" the disc shadow's (Bubble.SHADOW_TITLE): left top right bottom.
frame() { a shell dumpsys window windows | python3 -c 'import sys,re
for b in sys.stdin.read().split("Window #"):
 if "ty=APPLICATION_OVERLAY" in b and sys.argv[1] in b and ("byokit-bubble-shadow" in b)==(sys.argv[2]=="shadow"):
  m=re.search(r"\b(?:mFrame|frame)=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]",b)
  if m: print(*m.groups()); break
else: raise SystemExit("no "+sys.argv[2]+" window")' "$app" "${1:-bubble}"; }
dens=$(a shell wm density | tr -d '\r' | awk '{v=$NF} END{print v}')
dp() { python3 -c "print(round($1*$dens/160))"; }
lum() { magick "$1" -crop 1x1+$2+$3 -colorspace gray -format '%[fx:int(255*u+0.5)]' info:; }
# Waits until the bubble window stops moving (no drag or glide in flight), then captures and measures.
measure() {
  name=$1; prev=; for _ in $(seq 10); do f=$(frame); [ "$f" = "$prev" ] && break; prev=$f; sleep 1; done
  sleep 1; a exec-out screencap -p > "$out/$name.png"
  set -- $(frame); l=$1; t=$2; r=$3; b=$4; cx=$(( (l+r)/2 ))
  ref=$(lum "$out/$name.png" $cx $((b + $(dp 16))))
  rim=$(lum "$out/$name.png" $cx $((b - 2)))
  line="$name bubble=[$l $t $r $b] shadow=[$(frame shadow)] density=$dens x=$cx bg@16dp=$ref rim=$rim rim-bg=$((rim - ref))"
  worst=999
  for k in 2 3 4 5 6; do v=$(lum "$out/$name.png" $cx $((b + $(dp $k)))); d=$((ref - v)); line="$line ${k}dp=$v(-$d)"; [ $d -lt $worst ] && worst=$d; done
  if [ "$ref" -ge 30 ]; then rule='light: each >=10 darker'; [ $worst -ge 10 ] && res=PASS || res=FAIL
  else rule='near-black: none lighter, rim visible'; [ $worst -ge 0 ] && [ $((rim - ref)) -ge 30 ] && res=PASS || res=FAIL; fi
  echo "$line min_darker=$worst [$rule] $res" | tee -a "$out/luminance.txt"
}
: > "$out/luminance.txt"
a install -r android/app/build/outputs/apk/release/app-release.apk >/dev/null
a shell pm clear "$app" >/dev/null
a shell appops set "$app" SYSTEM_ALERT_WINDOW allow
a shell settings delete secure enabled_accessibility_services >/dev/null # the bubble runs without the service
a shell cmd uimode night no
a shell am start -n "$app/.MainActivity" >/dev/null; sleep 4
tapid bubbleStart; sleep 2
measure shadow-1-light-example
a shell cmd uimode night yes; sleep 3
measure shadow-2-night-example
# The example draws white in either mode, so also measure over dark screens: the home screen and the app drawer.
a shell input keyevent KEYCODE_HOME; sleep 4
measure shadow-3-dark-home
a shell input swipe 540 1900 540 600 300; sleep 3
measure shadow-4-dark-drawer
a shell input keyevent KEYCODE_HOME; sleep 2
a shell cmd uimode night no
# A tap just below the disc reaches the app: drag the bubble so 3dp under it lies on the field, tap there.
a shell am start -n "$app/.MainActivity" >/dev/null; sleep 3
set -- $(attr fieldInput bounds | grep -oE '[0-9]+'); ft=$2; fr=$3
set -- $(frame); cx=$(( $1 + ($3-$1)/3 )); cy=$(( ($2+$4)/2 )); h=$(( $4-$2 ))
a shell input swipe $cx $cy $cx $(( ft + 30 - h + h/2 )) 1500; sleep 3
set -- $(frame); tx=$(( $1 + 20 )); ty=$(( $4 + $(dp 3) ))
[ $tx -lt $fr ] && [ $ty -gt $ft ] || { echo "fixture: the strip is not over the field" >&2; exit 1; }
a exec-out screencap -p > "$out/shadow-5-strip-on-field.png"
before=$(attr fieldInput focused)
a shell input tap $tx $ty; sleep 2
after=$(attr fieldInput focused)
echo "strip tap at ($tx,$ty) bubble=[$*] shadow=[$(frame shadow)] field focused before=$before after=$after" | tee -a "$out/luminance.txt"
[ "$before" = false ] && [ "$after" = true ] || { echo 'the tap below the disc did not reach the field'; exit 1; }
a shell input keyevent KEYCODE_BACK; sleep 1
tapid bubbleStop
grep -q FAIL "$out/luminance.txt" && { echo 'shadow check failed'; exit 1; }
echo "passed bubble shadow on $s"
