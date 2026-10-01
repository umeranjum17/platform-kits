import { useRef, useState } from 'react';
import { Image, Pressable, StatusBar as Bars, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { overlay } from '@platform-kits/overlay';
import { screenFrame, type ScreenFrameResult } from '@platform-kits/overlay/screen-frame';

type Frame = Extract<ScreenFrameResult, { status: 'captured' }>;
/** The tour's targets: top, left edge, middle, right edge and bottom of the screen, in the order the ring visits them. */
const STEPS = [
  { id: 'tourTop', label: 'Search Umer’s notes', hint: 'Umer, start with search' },
  { id: 'tourLeft', label: 'Back', hint: 'Umer, go back here' },
  { id: 'tourMiddle', label: 'Umer’s next step', hint: 'Umer, tap here' },
  { id: 'tourRight', label: 'Share', hint: 'Umer, share from here' },
  { id: 'tourBottom', label: 'Done', hint: 'Umer, finish here' },
];

/** Account-free native proof: opt in at build time with EXPO_PUBLIC_SCREEN_DEMO=1. */
export function ScreenDemo() {
  const target = useRef<View>(null);
  // Text near the demo button that the label must keep clear of.
  const near = useRef<(View | null)[]>([]);
  const keep = (i: number) => (v: View | null) => { near.current[i] = v; };
  const [frame, setFrame] = useState<Frame | null>(null);
  const [message, setMessage] = useState('Take a picture, then show Umer where to tap.');
  const [point, setPoint] = useState('');
  const [taps, setTaps] = useState(0);
  const [tour, setTour] = useState(false);
  const capture = async () => {
    setFrame(null);
    setMessage('Waiting for your permission.');
    const result = await screenFrame.frame();
    if (result.status === 'captured') { setFrame(result); setMessage('Opening your picture.'); }
    else setMessage(result.status === 'cancelled' ? 'Picture cancelled.' : result.status === 'failed' ? 'Could not take a picture.' : result.status === 'busy' ? 'A picture is already being taken.' : 'This phone cannot take a screen picture.');
  };
  const start = async () => {
    const state = await overlay.start({ host: 'window', mood: 'bubble',
      notice: { channel: 'guide', title: 'Umer’s guide', text: 'Ready to point.', icon: 'byokit_notification' } });
    if (state === 'needs-permission') await overlay.openPermission();
    else setPoint(state === 'on' ? 'Guide ready.' : 'This phone cannot show a guide.');
  };
  const mark = (ms: number) => target.current && frame && pointAt(target.current, frame, 'Umer, tap here', ms, near.current).then((result) =>
    setPoint(result === 'shown' ? 'Follow the ring.' : result === 'display-changed' ? 'Take a new picture after turning the phone.' : 'Start the guide first.'));
  if (tour && frame) return <Tour frame={frame} onClose={() => { setTour(false); overlay.dismissPoint(); }} />;
  return <View style={s.screen}>
    <StatusBar style="dark" />
    <Text style={s.eyebrow}>BYOKIT · SCREEN GUIDE</Text>
    <Text style={s.title}>A little help for Umer</Text>
    <Text style={s.detail}>One picture with your permission. A ring to follow. You stay in control.</Text>
    <Pressable testID="screenCapture" style={s.button} onPress={capture}><Text style={s.buttonText}>Take one screen picture</Text></Pressable>
    <Text testID="screenResult" style={s.detail}>{message}</Text>
    {frame && <View style={s.picture}>
      <Image testID="screenImage" source={{ uri: frame.uri }} style={[s.thumb, { aspectRatio: frame.width / frame.height }]} resizeMode="contain"
        onLoad={() => setMessage(`Picture ready. ${frame.width} × ${frame.height} pixels.`)} onError={() => setMessage('Could not open the picture.')} />
      <Text style={[s.detail, s.pictureText]}>The picture you allowed. It stays on this phone; the guide only uses it to know where things are.</Text>
    </View>}
    <Pressable testID="screenGuide" style={s.secondary} onPress={start}><Text style={s.secondaryText}>Start the guide</Text></Pressable>
    <View style={s.targetArea}>
      <Text ref={keep(0)} style={s.caption}>A demo button beneath the marker</Text>
      <Text ref={keep(1)} testID="screenTaps" style={s.detail}>{taps ? `Umer tapped through ${taps} time${taps === 1 ? '' : 's'}.` : 'The ring will let your tap reach this button.'}</Text>
      <View ref={target} collapsable={false}>
        <Pressable testID="screenTarget" style={s.target} onPress={() => setTaps((n) => n + 1)}><Text style={s.targetText}>Umer’s next step</Text></Pressable>
      </View>
    </View>
    <View ref={keep(2)} collapsable={false} style={s.row}>
      <Pressable testID="screenPoint" disabled={!frame} style={s.smallButton} onPress={() => mark(15000)}><Text style={s.secondaryText}>Point here</Text></Pressable>
      <Pressable testID="screenPointShort" disabled={!frame} style={s.smallButton} onPress={() => mark(1000)}><Text style={s.secondaryText}>Brief ring</Text></Pressable>
      <Pressable testID="screenDismiss" style={s.smallButton} onPress={async () => { await overlay.dismissPoint(); setPoint('Ring dismissed.'); }}><Text style={s.secondaryText}>Dismiss</Text></Pressable>
    </View>
    <Text testID="screenPointResult" style={s.detail}>{point}</Text>
    <Pressable testID="screenTour" disabled={!frame || point === ''} style={[s.secondary, (!frame || point === '') && s.off]} onPress={() => setTour(true)}>
      <Text style={s.secondaryText}>Show Umer around</Text>
    </Pressable>
  </View>;
}

type Rect = { x: number; y: number; width: number; height: number };
const measure = (view: View) => new Promise<Rect>((done) => view.measureInWindow((x, y, width, height) => done({ x, y, width, height })));

/** Points at the view's full bounds, so the ring goes around it; the label stays clear of it and of the [avoid] views. */
async function pointAt(view: View, frame: Frame, label: string, ms: number, avoid: (View | null)[] = []) {
  const d = frame.space.density;
  const t = await measure(view);
  const boxes = await Promise.all(avoid.filter((v): v is View => !!v && v !== view).map(measure));
  return overlay.pointHere({
    x: (t.x + t.width / 2) * d, y: (t.y + t.height / 2) * d, width: t.width * d, height: t.height * d, label, space: frame.space, ms,
    avoid: boxes.map((b) => ({ left: b.x * d, top: b.y * d, width: b.width * d, height: b.height * d })),
  });
}

/** Five targets at the screen's top, edges, middle and bottom; each tap moves the ring to the next one. */
function Tour({ frame, onClose }: { frame: Frame; onClose: () => void }) {
  const refs = useRef<(View | null)[]>([]);
  // The step text and the buttons around the targets, which the label must keep clear of.
  const near = useRef<(View | null)[]>([]);
  const [step, setStep] = useState(-1);
  const go = (n: number) => {
    setStep(n);
    const view = refs.current[n];
    if (view) pointAt(view, frame, STEPS[n].hint, 60000, [...refs.current, ...near.current]);
    else overlay.dismissPoint();
  };
  const top = (Bars.currentHeight ?? 24) + 12;
  const target = (i: number, style: object) => <View key={STEPS[i].id} ref={(v) => { refs.current[i] = v; }} collapsable={false} style={[s.spot, style]}>
    <Pressable testID={STEPS[i].id} style={[s.tourButton, step === i && s.tourOn]} onPress={() => step === i && go(i + 1)}>
      <Text style={s.targetText}>{STEPS[i].label}</Text>
    </Pressable>
  </View>;
  return <View style={s.board}>
    <StatusBar style="dark" />
    {target(0, { top, left: 24, right: 24 })}
    {target(1, { top: '22%', left: 0 })}
    <View style={s.middle}>
      {target(2, { position: 'relative', alignSelf: 'center' })}
      {/* Right under the middle target: the label flips above rather than cover it. */}
      <Text ref={(v) => { near.current[0] = v; }} testID="tourStep" style={[s.detail, s.centre]}>{step < 0 ? 'Five places on one screen. The ring visits each in turn.' : step < STEPS.length ? `Step ${step + 1} of ${STEPS.length}. Follow the ring.` : 'All done. Umer found every step.'}</Text>
      <View ref={(v) => { near.current[1] = v; }} collapsable={false} style={s.row}>
        <Pressable testID="tourStart" style={s.smallButton} onPress={() => go(0)}><Text style={s.secondaryText}>{step < 0 ? 'Start the tour' : 'Start again'}</Text></Pressable>
        <Pressable testID="tourClose" style={s.smallButton} onPress={onClose}><Text style={s.secondaryText}>Back to the guide</Text></Pressable>
      </View>
    </View>
    {target(3, { top: '68%', right: 0 })}
    {target(4, { bottom: 56, left: 24, right: 24 })}
  </View>;
}
const s = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingTop: 64, paddingBottom: 32, backgroundColor: '#f4f6ef', gap: 14 },
  eyebrow: { color: '#00674e', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { fontSize: 30, fontWeight: '700', color: '#163a2d' },
  detail: { color: '#40564a', fontSize: 15, lineHeight: 21 },
  button: { padding: 16, borderRadius: 12, backgroundColor: '#00674e', alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondary: { padding: 12, borderRadius: 10, backgroundColor: '#e0e8d9', alignItems: 'center' },
  secondaryText: { color: '#163a2d', fontWeight: '600', fontSize: 14 },
  off: { opacity: 0.5 },
  picture: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  thumb: { height: 72, borderRadius: 6, borderWidth: 1, borderColor: '#c9d4c2' },
  pictureText: { flex: 1, fontSize: 13, lineHeight: 18 },
  targetArea: { marginVertical: 12, gap: 12, padding: 20, paddingBottom: 64, borderRadius: 16, backgroundColor: '#fff' },
  caption: { fontSize: 12, color: '#52695c' },
  target: { padding: 22, borderRadius: 12, backgroundColor: '#e0e8d9', alignItems: 'center' },
  targetText: { fontSize: 17, fontWeight: '700', color: '#163a2d' },
  row: { flexDirection: 'row', gap: 8, justifyContent: 'center' },
  smallButton: { padding: 12, borderRadius: 10, backgroundColor: '#e0e8d9' },
  board: { flex: 1, backgroundColor: '#f4f6ef' },
  middle: { position: 'absolute', top: '36%', left: 24, right: 24, gap: 16 },
  centre: { textAlign: 'center' },
  spot: { position: 'absolute' },
  tourButton: { paddingVertical: 18, paddingHorizontal: 22, borderRadius: 12, backgroundColor: '#e0e8d9', alignItems: 'center' },
  tourOn: { backgroundColor: '#cfe0c6' },
});
