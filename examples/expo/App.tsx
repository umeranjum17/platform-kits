// Generic platform demo: overlay, focused field, screen frames and status-bar chip.
import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, PixelRatio, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { overlay, stateWords, type OverlayState } from '@platform-kits/overlay';
import { focusedField } from '@platform-kits/overlay/focused-field';
import { StatusBar } from 'expo-status-bar';
import { stateWords as chipWords, status as chip } from '@platform-kits/statusbar';
import { ScreenDemo } from './ScreenDemo.tsx';
function Button({ id, label, onPress }: { id: string; label: string; onPress: () => void }) {
  return <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={s.button}><Text style={s.buttonText}>{label}</Text></Pressable>;
}
/**
 * The bubble over other apps (Android): Start/Stop, and a tap opens the panel registered in index.ts. The tap log, and
 * the focused field once the example's accessibility service (modules/a11y-demo) is on: a long press on the bubble
 * reads it in any app.
 */
function Bubble() {
  const [state, setState] = useState<OverlayState>('off');
  const [taps, setTaps] = useState('');
  const [typed, setTyped] = useState('');
  const [field, setField] = useState('');
  const input = useRef<TextInput>(null);
  const [clear, setClear] = useState('');
  useEffect(() => {
    overlay.state().then(setState);
    const offState = overlay.on('state', (e) => setState(e.state));
    const offTap = overlay.on('tap', () => { overlay.logTap({ app: 'io.github.umeranjum17.byokit.example', action: 'tap' }); });
    // A long press reads the field in focus, in any app: the bubble's window never takes the focus.
    const offLong = overlay.on('longPress', async () => {
      const read = await focusedField.read();
      setField(`available: ${await focusedField.available()}, read: ${JSON.stringify(read)}`);
      overlay.say(read ? `Read: ${read.text}` : 'No text field in focus.');
    });
    const offClear = overlay.on('keepClear', (e) => setClear(e.clear ? 'The bubble is clear of the field.' : 'No clear spot: the bubble stays put.'));
    return () => { offState(); offTap(); offLong(); offClear(); };
  }, []);
  const start = async () => {
    const s = await overlay.start({
      host: 'window', mood: 'bubble', panel: 'bubblePanel',
      notice: { channel: 'bubble', title: 'byokit example', text: 'The bubble is on.', icon: 'byokit_notification' },
    });
    if (s === 'needs-permission') await overlay.openPermission();
  };
  // The field's box in full-display pixels (the window is edge to edge), then a pill that would otherwise cover it.
  const keepFieldClear = () => input.current?.measureInWindow((x, y, width, height) => {
    const d = PixelRatio.get();
    const box = { left: x * d, top: y * d, width: width * d, height: height * d };
    overlay.keepClear([box]);
    overlay.say('Inserted. Send it yourself.', undefined, 60000);
    setClear(`Keeping clear of ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}.`);
  });
  return (
    <View style={s.sheet}>
      <Text testID="bubble" style={s.words}>{stateWords(state)}</Text>
      {state === 'on' ? <Button id="bubbleStop" label="Stop the bubble" onPress={() => overlay.stop()} />
        : <Button id="bubbleStart" label="Start the bubble" onPress={start} />}
      <Button id="taps" label="Show the taps" onPress={async () => setTaps(JSON.stringify(await overlay.taps()))} />
      {!!taps && <Text testID="tapLog" style={s.small}>{taps}</Text>}
      <Button id="fieldRead" label="Read the focused field" onPress={async () => {
        setField(`available: ${await focusedField.available()}, read: ${JSON.stringify(await focusedField.read())}`);
      }} />
      {!!field && <Text testID="field" style={s.small}>{field}</Text>}
      <TextInput ref={input} testID="fieldInput" value={typed} onChangeText={setTyped} placeholder="Type here, then read it (above)" style={s.input} />
      <Button id="sayPill" label="Show the pill" onPress={() => overlay.say('Inserted. Send it yourself.', undefined, 60000)} />
      <Button id="keepClear" label="Keep the field clear" onPress={keepFieldClear} />
      <Button id="keepClearOff" label="Stop keeping it clear" onPress={() => { overlay.keepClear([]); setClear('Back at its own spot.'); }} />
      {!!clear && <Text testID="clear" style={s.small}>{clear}</Text>}
    </View>
  );
}

/** The panel a bubble tap opens, in its own translucent activity. */
export function BubblePanel() {
  return (
    <View style={s.panel}>
      <View testID="panel" style={s.sheet}>
        <Text style={s.words}>Opened from the bubble.</Text>
        <Button id="panelClose" label="Close" onPress={() => overlay.closePanel()} />
      </View>
    </View>
  );
}

/** One ongoing job as a status-bar chip (@platform-kits/statusbar): show with three actions, clear, and what came back. */
function Chip() {
  const [said, setSaid] = useState('');
  const [n, setN] = useState(1);
  useEffect(() => {
    const offs = [chip.on('action', (e) => setSaid(`Action: ${e.id}`)), chip.on('dismissed', () => setSaid('Dismissed.'))];
    return () => offs.forEach((off) => off());
  }, []);
  const show = async (busy: number) => {
    if (Platform.OS === 'android') await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
    chip.show({
      title: `Scribe and ${busy} more are working`, text: '2 need you', chip: `${busy} busy`, publicText: `${busy} working · 2 need you`,
      icon: 'byokit_notification', promote: true, timeoutMs: 15 * 60_000,
      actions: [{ id: 'needs', label: 'See what needs you' }, { id: 'ask', label: 'Ask Chief' }, { id: 'open', label: 'Open' }],
    });
    setN(busy + 1);
    setSaid(chipWords(await chip.state()));
  };
  return (
    <View style={s.sheet}>
      <Button id="chip-show" label="Show the chip" onPress={() => show(n)} />
      <Button id="chip-clear" label="Clear the chip" onPress={() => { chip.clear(); setN(1); setSaid('Cleared.'); }} />
      {!!said && <Text testID="chip-said" style={s.small}>{said}</Text>}
    </View>
  );
}

export default function App() {
  return process.env.EXPO_PUBLIC_SCREEN_DEMO === '1' ? <ScreenDemo /> :
    <SafeAreaView style={{ flex: 1 }}><StatusBar style="dark" /><ScrollView contentContainerStyle={s.screen}>
      <Text style={s.title}>Platform kits on {Platform.OS}</Text><Bubble /><Chip />
    </ScrollView></SafeAreaView>;
}
const s = StyleSheet.create({
  screen: { backgroundColor: '#fff', padding: 24, paddingTop: 64, gap: 12 },
  input: { fontSize: 17, borderWidth: 1, borderColor: '#bbb', borderRadius: 8, padding: 10, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600' },
  words: { fontSize: 18 },
  small: { fontSize: 14, color: '#555' },
  code: { fontSize: 32, fontWeight: '700', letterSpacing: 2 },
  sheet: { gap: 12, padding: 16, borderRadius: 12, backgroundColor: '#f2f2f2' },
  panel: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  button: { backgroundColor: '#111', borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 17 },
});
